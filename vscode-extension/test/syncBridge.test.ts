// Testa a orquestração de SyncBridge (sincronização inicial, dedupe por
// cache de conteúdo, promoção arquivo -> pasta quando um script ganha o
// primeiro filho, remoção, rename/move por uuid, e disco -> Studio) usando
// NodeDiskIO apontado para um diretório temporário real (node:fs) e um
// Transport fake que simula o plugin Studio. Sem VS Code, sem WebSocket — só
// a camada de lógica, como pedido na tarefa.
//
// Protocolo v2 (M2): identidade por uuid, não por path. O FakeTransport
// abaixo simula o plugin: listScripts/readSource por uuid, writeSource com
// os dois modos (atualizar: {uuid, source}; criar: {path, source,
// className} -> aloca um uuid novo e retorna no writeAck).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncBridge, type Transport } from "../src/sync/SyncBridge.js";
import { NodeDiskIO } from "../src/sync/NodeDiskIO.js";
import type { DiskIO } from "../src/sync/DiskIO.js";
import type { Logger } from "../src/util/logger.js";
import type { MountPoint } from "../src/mapping/projectMapping.js";

class CountingDiskIO implements DiskIO {
  writeCount = 0;
  renameCount = 0;
  constructor(private readonly inner: DiskIO) {}
  readFile(relPath: string) {
    return this.inner.readFile(relPath);
  }
  async writeFile(relPath: string, content: string) {
    this.writeCount += 1;
    return this.inner.writeFile(relPath, content);
  }
  deleteFile(relPath: string) {
    return this.inner.deleteFile(relPath);
  }
  removeEmptyDirsUpward(relDir: string) {
    return this.inner.removeEmptyDirsUpward(relDir);
  }
  async renameFile(oldRelPath: string, newRelPath: string) {
    this.renameCount += 1;
    return this.inner.renameFile(oldRelPath, newRelPath);
  }
  listFiles(relDir: string) {
    return this.inner.listFiles(relDir);
  }
}

class CapturingLogger implements Logger {
  lines: string[] = [];
  info(message: string): void {
    this.lines.push(`INFO ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`WARN ${message}`);
  }
  error(message: string): void {
    this.lines.push(`ERROR ${message}`);
  }
}

class FakeTransport implements Transport {
  readonly sent: Record<string, unknown>[] = [];
  readonly scripts: Array<{ uuid: string; path: string; className: string }> = [];
  readonly sources = new Map<string, string>(); // uuid -> source
  private nextUuid = 1;

  async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(message);
    switch (message.kind) {
      case "listScripts":
        return { scripts: this.scripts };
      case "readSource": {
        const uuid = message.uuid as string;
        return { ok: true, source: this.sources.get(uuid) ?? "" };
      }
      case "writeSource": {
        if (typeof message.uuid === "string") {
          // modo atualizar
          this.sources.set(message.uuid, message.source as string);
          return { ok: true, uuid: message.uuid, api: "UpdateSourceAsync" };
        }
        // modo criar
        const uuid = `uuid-${this.nextUuid++}`;
        this.sources.set(uuid, message.source as string);
        this.scripts.push({ uuid, path: message.path as string, className: message.className as string });
        return { ok: true, uuid, api: "UpdateSourceAsync" };
      }
      default:
        return { ok: false, error: `unhandled kind ${String(message.kind)}` };
    }
  }
}

const MOUNT_POINTS: MountPoint[] = [{ dataModelPath: "ServerScriptService/Server", diskPath: "src/server" }];

let tmpDir: string;
let diskIO: CountingDiskIO;
let logger: CapturingLogger;
let bridge: SyncBridge;

function readTmp(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split("/")), "utf8");
}

function existsTmp(relPath: string): boolean {
  return fs.existsSync(path.join(tmpDir, ...relPath.split("/")));
}

/** Escreve direto no disco (bypassando a ponte) — simula um processo externo editando/criando um arquivo. */
function writeTmp(relPath: string, content: string): void {
  const absolute = path.join(tmpDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-bridge-"));
  diskIO = new CountingDiskIO(new NodeDiskIO(tmpDir));
  logger = new CapturingLogger();
  bridge = new SyncBridge(MOUNT_POINTS, diskIO, logger);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInitialSync", () => {
  test("listScripts + readSource materializam os arquivos no formato Rojo, endereçados por uuid", async () => {
    const transport = new FakeTransport();
    transport.scripts.push({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" });
    transport.sources.set("uuid-main", "print('oi')");

    await bridge.runInitialSync(transport);

    expect(existsTmp("src/server/Main.server.luau")).toBe(true);
    expect(readTmp("src/server/Main.server.luau")).toBe("print('oi')");
  });

  test("path fora de qualquer ponto de montagem é ignorado com log informativo, não erro", async () => {
    const transport = new FakeTransport();
    transport.scripts.push({ uuid: "uuid-foo", path: "Workspace/Foo", className: "Script" });
    transport.sources.set("uuid-foo", "print('fora do mount')");

    await bridge.runInitialSync(transport);

    expect(logger.lines.some((l) => l.startsWith("ERROR"))).toBe(false);
    expect(logger.lines.some((l) => l.includes("Workspace/Foo") && l.includes("ignorado"))).toBe(true);
  });
});

describe("dedupe por cache de conteúdo", () => {
  test("sourceChanged com o mesmo conteúdo não escreve em disco de novo", async () => {
    const transport = new FakeTransport();
    // Conteúdo já disponível quando o próprio scriptAdded pedir readSource
    // (M2: scriptAdded busca o conteúdo proativamente) — assim a primeira
    // materialização já sai com o conteúdo final, sem escrita intermediária.
    transport.sources.set("uuid-main", "print(1)");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    expect(diskIO.writeCount).toBe(1);

    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print(1)",
      origin: "studio",
      via: "signal",
    });
    expect(diskIO.writeCount).toBe(1); // conteúdo idêntico -> sem segunda escrita

    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print(1)",
      origin: "studio",
      via: "poll",
    });
    expect(diskIO.writeCount).toBe(1); // conteúdo idêntico -> sem segunda escrita
  });
});

describe("materialização inicial reaproveita .lua pré-existente (2026-07-16)", () => {
  test("uuid novo com .lua já existente em disco reaproveita o .lua, sem criar .luau duplicado", async () => {
    // Simula wally install puro (fora do SyncTeam) já tendo gravado o .lua
    // ANTES da extensão conhecer esse uuid (extensão gravada por
    // computeLayout para um Script é sempre "*.server.<ext>").
    writeTmp("src/server/Main.server.lua", "-- conteúdo antigo do wally install");

    const transport = new FakeTransport();
    transport.scripts.push({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" });
    transport.sources.set("uuid-main", "print('novo conteúdo do Studio')");

    await bridge.runInitialSync(transport);

    expect(existsTmp("src/server/Main.server.luau")).toBe(false);
    expect(existsTmp("src/server/Main.server.lua")).toBe(true);
    expect(readTmp("src/server/Main.server.lua")).toBe("print('novo conteúdo do Studio')");
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBe("src/server/Main.server.lua");
  });

  test("uuid novo sem nada em disco continua materializando .luau normalmente (sem regressão)", async () => {
    const transport = new FakeTransport();
    transport.scripts.push({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" });
    transport.sources.set("uuid-main", "print('oi')");

    await bridge.runInitialSync(transport);

    expect(existsTmp("src/server/Main.server.luau")).toBe(true);
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBe("src/server/Main.server.luau");
  });
});

describe("pastas de pacotes Wally — exclusão do live-edit-sync (2026-07-16)", () => {
  test("handleSourceChanged (Studio→disco) ignora ATUALIZAÇÃO de script já materializado dentro de Packages", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-pkg", "return 1");
    await bridge.handleScriptAdded({ uuid: "uuid-pkg", path: "ServerScriptService/Server/Packages/Foo", className: "ModuleScript" }, transport);
    expect(readTmp("src/server/Packages/Foo.luau")).toBe("return 1");
    const writesBefore = diskIO.writeCount;

    await bridge.handleSourceChanged({
      uuid: "uuid-pkg",
      path: "ServerScriptService/Server/Packages/Foo",
      className: "ModuleScript",
      source: "return 2 -- edição divergente vinda de outro Studio",
    });

    // Conteúdo em disco NÃO foi atualizado — pacote vendorizado não é live-edit-synced.
    expect(readTmp("src/server/Packages/Foo.luau")).toBe("return 1");
    expect(diskIO.writeCount).toBe(writesBefore);
    expect(logger.lines.some((l) => l.startsWith("ERROR"))).toBe(false);
    expect(logger.lines.some((l) => l.toLowerCase().includes("wally") || l.toLowerCase().includes("packages"))).toBe(true);
  });

  test("handleLocalFileChange (disco→Studio) ignora ATUALIZAÇÃO de arquivo já rastreado dentro de ServerPackages", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-sp", "return 'v1'");
    await bridge.handleScriptAdded(
      { uuid: "uuid-sp", path: "ServerScriptService/Server/ServerPackages/Bar", className: "ModuleScript" },
      transport,
    );
    transport.sent.length = 0;

    // Simula edição externa (dev local com wally.lock divergente) no arquivo já rastreado.
    writeTmp("src/server/ServerPackages/Bar.luau", "return 'v2 -- divergente localmente'");
    await bridge.handleLocalFileChange("src/server/ServerPackages/Bar.luau", transport);

    // Nenhum writeSource foi enviado ao Studio.
    expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
    expect(transport.sources.get("uuid-sp")).toBe("return 'v1'");
  });

  test("handleLocalFileChange CONTINUA criando arquivo novo dentro de DevPackages (só update é ignorado, não criação)", async () => {
    const transport = new FakeTransport();
    writeTmp("src/server/DevPackages/Novo.luau", "return 'pacote novo'");

    await bridge.handleLocalFileChange("src/server/DevPackages/Novo.luau", transport);

    const created = transport.scripts.find((s) => s.path === "ServerScriptService/Server/DevPackages/Novo");
    expect(created).toBeDefined();
    expect(transport.sources.get(created!.uuid)).toBe("return 'pacote novo'");
  });
});

describe("scriptAdded", () => {
  test("cria o arquivo correto e pede readSource quando não há conteúdo em cache", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('novo')");

    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    expect(transport.sent).toContainEqual({ kind: "readSource", uuid: "uuid-main" });
    expect(existsTmp("src/server/Main.server.luau")).toBe(true);
    expect(readTmp("src/server/Main.server.luau")).toBe("print('novo')");
  });
});

describe("promoção arquivo -> pasta", () => {
  test("script ganha o primeiro filho e o arquivo é movido para pasta/init.*", async () => {
    const transport = new FakeTransport();
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print('root')",
    });
    expect(existsTmp("src/server/Main.server.luau")).toBe(true);

    // Main ganha um filho -> deveria virar pasta.
    await bridge.handleScriptAdded({ uuid: "uuid-sub", path: "ServerScriptService/Server/Main/Sub", className: "ModuleScript" }, transport);

    expect(existsTmp("src/server/Main.server.luau")).toBe(false);
    expect(existsTmp("src/server/Main/init.server.luau")).toBe(true);
    expect(readTmp("src/server/Main/init.server.luau")).toBe("print('root')");

    // Sub só materializa depois do próprio sourceChanged/readSource.
    await bridge.handleSourceChanged({
      uuid: "uuid-sub",
      path: "ServerScriptService/Server/Main/Sub",
      className: "ModuleScript",
      source: "return {}",
    });
    expect(readTmp("src/server/Main/Sub.luau")).toBe("return {}");
  });
});

describe("scriptMoved", () => {
  test("rename simples: move o arquivo físico (rename, não duplica nem perde conteúdo)", async () => {
    const transport = new FakeTransport();
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print('conteudo original')",
    });
    expect(existsTmp("src/server/Main.server.luau")).toBe(true);
    const writesBeforeMove = diskIO.writeCount;

    await bridge.handleScriptMoved({
      uuid: "uuid-main",
      oldPath: "ServerScriptService/Server/Main",
      newPath: "ServerScriptService/Server/Renamed",
      className: "Script",
    });

    expect(existsTmp("src/server/Main.server.luau")).toBe(false);
    expect(existsTmp("src/server/Renamed.server.luau")).toBe(true);
    expect(readTmp("src/server/Renamed.server.luau")).toBe("print('conteudo original')");
    expect(diskIO.renameCount).toBeGreaterThanOrEqual(1);
    expect(diskIO.writeCount).toBe(writesBeforeMove); // rename, não write+delete
  });

  test("move que muda isInit (promoção): script raiz move para dentro de uma pasta que precisa de init.*", async () => {
    const transport = new FakeTransport();
    await bridge.handleScriptAdded({ uuid: "uuid-parent", path: "ServerScriptService/Server/Parent", className: "ModuleScript" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-parent",
      path: "ServerScriptService/Server/Parent",
      className: "ModuleScript",
      source: "return {}",
    });
    await bridge.handleScriptAdded({ uuid: "uuid-loose", path: "ServerScriptService/Server/Loose", className: "ModuleScript" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-loose",
      path: "ServerScriptService/Server/Loose",
      className: "ModuleScript",
      source: "return 1",
    });
    expect(existsTmp("src/server/Parent.luau")).toBe(true);
    expect(existsTmp("src/server/Loose.luau")).toBe(true);

    // "Loose" é movido para dentro de "Parent" -> Parent ganha o primeiro
    // filho e precisa (des)promover para pasta/init.luau; Loose vira filho.
    await bridge.handleScriptMoved({
      uuid: "uuid-loose",
      oldPath: "ServerScriptService/Server/Loose",
      newPath: "ServerScriptService/Server/Parent/Loose",
      className: "ModuleScript",
    });

    expect(existsTmp("src/server/Parent.luau")).toBe(false);
    expect(existsTmp("src/server/Parent/init.luau")).toBe(true);
    expect(readTmp("src/server/Parent/init.luau")).toBe("return {}");
    expect(existsTmp("src/server/Loose.luau")).toBe(false);
    expect(existsTmp("src/server/Parent/Loose.luau")).toBe(true);
    expect(readTmp("src/server/Parent/Loose.luau")).toBe("return 1");
  });
});

describe("disco -> Studio", () => {
  test("mudança em arquivo já conhecido (uuid) envia writeSource no modo atualizar", async () => {
    const transport = new FakeTransport();
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print('studio')",
    });
    transport.sent.length = 0; // limpa o histórico dos passos de setup acima

    fs.writeFileSync(path.join(tmpDir, "src", "server", "Main.server.luau"), "print('local')", "utf8");
    await bridge.handleLocalFileChange("src/server/Main.server.luau", transport);

    expect(transport.sent).toEqual([{ kind: "writeSource", uuid: "uuid-main", source: "print('local')" }]);
  });

  test("arquivo local novo (sem uuid conhecido) envia writeSource no modo criar e registra o uuid do writeAck", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "server", "Main.server.luau"), "print('local')", "utf8");

    const transport = new FakeTransport();
    await bridge.handleLocalFileChange("src/server/Main.server.luau", transport);

    expect(transport.sent).toEqual([
      {
        kind: "writeSource",
        path: "ServerScriptService/Server/Main",
        source: "print('local')",
        className: "Script",
      },
    ]);
    // uuid alocado pelo FakeTransport (writeAck) deve ter sido registrado:
    // uma segunda mudança no MESMO arquivo agora deve usar o modo atualizar.
    fs.writeFileSync(path.join(tmpDir, "src", "server", "Main.server.luau"), "print('local 2')", "utf8");
    await bridge.handleLocalFileChange("src/server/Main.server.luau", transport);

    expect(transport.sent).toHaveLength(2);
    const secondMessage = transport.sent[1];
    expect(secondMessage.kind).toBe("writeSource");
    expect(typeof secondMessage.uuid).toBe("string");
    expect(secondMessage.path).toBeUndefined();
    expect(secondMessage.source).toBe("print('local 2')");
  });

  test("mudança local repetida (mesmo conteúdo) não gera segundo writeSource", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "server", "Utils.luau"), "return 1", "utf8");

    const transport = new FakeTransport();
    await bridge.handleLocalFileChange("src/server/Utils.luau", transport);
    await bridge.handleLocalFileChange("src/server/Utils.luau", transport);

    expect(transport.sent).toHaveLength(1);
  });

  test("arquivo fora de qualquer mount é ignorado (log informativo, sem writeSource)", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "não é script", "utf8");
    const transport = new FakeTransport();
    await bridge.handleLocalFileChange("README.md", transport);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("scriptRemoved", () => {
  test("remove o arquivo materializado (pelo uuid, não pelo path) e limpa as caches", async () => {
    const transport = new FakeTransport();
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    await bridge.handleSourceChanged({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script", source: "x" });
    expect(existsTmp("src/server/Main.server.luau")).toBe(true);

    await bridge.handleScriptRemoved({ uuid: "uuid-main", path: "ServerScriptService/Server/Main" });

    expect(existsTmp("src/server/Main.server.luau")).toBe(false);
  });
});

describe("M3.3 — lease negado", () => {
  test("onWriteRejected callback é acionado quando writeAck retorna ok=false (atualizar)", async () => {
    const transport = new FakeTransport();

    // Setup: script conhecido
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);
    await bridge.handleSourceChanged({
      uuid: "uuid-main",
      path: "ServerScriptService/Server/Main",
      className: "Script",
      source: "print('studio')",
    });

    // Transport que rejeita o uuid específico
    class RejectingTransport implements Transport {
      readonly sent: Record<string, unknown>[] = [];
      readonly scripts = transport.scripts;
      readonly sources = transport.sources;

      async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.sent.push(message);
        if (message.kind === "writeSource" && message.uuid === "uuid-main") {
          // Simular lease negada
          return { ok: false, error: "lease negada — script sendo editado por Bob" };
        }
        return transport.request(message);
      }
    }

    const rejectingTransport = new RejectingTransport();

    // Callback para capturar eventos de rejeição
    const rejections: Array<{ diskPath: string; error: string }> = [];
    bridge.setOnWriteRejected(({ diskPath, error }) => {
      rejections.push({ diskPath, error });
    });

    // Editar o arquivo — deve ser rejeitado
    fs.mkdirSync(path.join(tmpDir, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "server", "Main.server.luau"), "print('edited')", "utf8");
    await bridge.handleLocalFileChange("src/server/Main.server.luau", rejectingTransport);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual({
      diskPath: "src/server/Main.server.luau",
      error: "lease negada — script sendo editado por Bob",
    });
  });

  test("onWriteRejected callback é acionado quando writeAck retorna ok=false (criar novo)", async () => {
    const rejections: Array<{ diskPath: string; error: string }> = [];
    bridge.setOnWriteRejected(({ diskPath, error }) => {
      rejections.push({ diskPath, error });
    });

    fs.mkdirSync(path.join(tmpDir, "src", "server"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "server", "NewScript.server.luau"), "print('new')", "utf8");

    // Transport que rejeita criação de scripts
    class RejectingCreateTransport implements Transport {
      readonly sent: Record<string, unknown>[] = [];
      readonly scripts: Array<{ uuid: string; path: string; className: string }> = [];
      readonly sources = new Map<string, string>();

      async request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.sent.push(message);
        if (message.kind === "writeSource" && "path" in message && !("uuid" in message)) {
          // Modo criar — rejeitar
          return { ok: false, error: "não é possível criar — máquina cheia" };
        }
        if (message.kind === "listScripts") {
          return { scripts: this.scripts };
        }
        return { ok: false, error: "unexpected message" };
      }
    }

    const rejectingTransport = new RejectingCreateTransport();
    await bridge.handleLocalFileChange("src/server/NewScript.server.luau", rejectingTransport);

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual({
      diskPath: "src/server/NewScript.server.luau",
      error: "não é possível criar — máquina cheia",
    });
  });
});

// M4: resolução uuid <-> diskPath, usada pela camada de presença
// (PresencePublisher resolve "qual uuid é o editor ativo" e
// FilePresenceDecorations resolve "qual arquivo notificar quando a presença
// de um uuid muda").
describe("resolveUuidForDiskPath / resolveDiskPathForUuid", () => {
  test("retornam null antes de qualquer sincronização", () => {
    expect(bridge.resolveUuidForDiskPath("src/server/Main.server.luau")).toBeNull();
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBeNull();
  });

  test("resolvem nos dois sentidos depois que o script é materializado", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('oi')");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    expect(bridge.resolveUuidForDiskPath("src/server/Main.server.luau")).toBe("uuid-main");
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBe("src/server/Main.server.luau");
  });

  test("resolveUuidForDiskPath é case-insensitive (regra de Windows/NTFS)", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('oi')");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    expect(bridge.resolveUuidForDiskPath("SRC/SERVER/MAIN.SERVER.LUAU")).toBe("uuid-main");
  });

  test("resolveUuidForDiskPath retorna null para path não sincronizado", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('oi')");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    expect(bridge.resolveUuidForDiskPath("src/server/Outro.server.luau")).toBeNull();
  });

  test("depois de scriptMoved, resolveUuidForDiskPath aponta pro novo path e não mais pro antigo", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('oi')");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    await bridge.handleScriptMoved({
      uuid: "uuid-main",
      oldPath: "ServerScriptService/Server/Main",
      newPath: "ServerScriptService/Server/Renamed",
      className: "Script",
    });

    expect(bridge.resolveUuidForDiskPath("src/server/Main.server.luau")).toBeNull();
    expect(bridge.resolveUuidForDiskPath("src/server/Renamed.server.luau")).toBe("uuid-main");
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBe("src/server/Renamed.server.luau");
  });

  test("depois de scriptRemoved, os dois sentidos voltam a null", async () => {
    const transport = new FakeTransport();
    transport.sources.set("uuid-main", "print('oi')");
    await bridge.handleScriptAdded({ uuid: "uuid-main", path: "ServerScriptService/Server/Main", className: "Script" }, transport);

    await bridge.handleScriptRemoved({ uuid: "uuid-main" });

    expect(bridge.resolveUuidForDiskPath("src/server/Main.server.luau")).toBeNull();
    expect(bridge.resolveDiskPathForUuid("uuid-main")).toBeNull();
  });
});

// "Refresh Sync": reconciliação bidirecional de 3 vias sob demanda. O ancestral
// comum é o contentCache (último conteúdo sincronizado). Cada teste estabelece
// um baseline sincronizado via runInitialSync (disco == Studio == cache) e
// depois cria a deriva desejada (editando o disco direto e/ou o
// transport.sources) antes de chamar refreshSync.
describe("refreshSync — merge de 3 vias sob demanda", () => {
  const MAIN_PATH = "ServerScriptService/Server/Main";
  const MAIN_DISK = "src/server/Main.server.luau";

  async function setupBaseline(transport: FakeTransport, content: string): Promise<void> {
    transport.scripts.push({ uuid: "u1", path: MAIN_PATH, className: "Script" });
    transport.sources.set("u1", content);
    await bridge.runInitialSync(transport);
    // Baseline garantido: disco == Studio == cache == content.
    expect(readTmp(MAIN_DISK)).toBe(content);
  }

  test("caso 2 — nada mudou dos dois lados: no-op (sem escrita, sem writeSource)", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    const writesBefore = diskIO.writeCount;
    transport.sent.length = 0;

    await bridge.refreshSync(transport);

    expect(diskIO.writeCount).toBe(writesBefore);
    expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
  });

  test("caso 3 — só o disco mudou (edição externa) → propaga disco→Studio", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    writeTmp(MAIN_DISK, "v1-disco"); // processo externo editou o arquivo
    transport.sent.length = 0;

    await bridge.refreshSync(transport);

    expect(transport.sent).toContainEqual({ kind: "writeSource", uuid: "u1", source: "v1-disco" });
    expect(transport.sources.get("u1")).toBe("v1-disco");
  });

  test("caso 4 — só o Studio mudou (colega editou) → propaga Studio→disco", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    transport.sources.set("u1", "v2-studio"); // Studio divergiu enquanto a extensão estava fechada
    transport.sent.length = 0;

    await bridge.refreshSync(transport);

    expect(readTmp(MAIN_DISK)).toBe("v2-studio");
    expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
  });

  test("caso 5 — ambos convergiram para o MESMO conteúdo → só atualiza baseline, sem escrever", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    writeTmp(MAIN_DISK, "v3-both");
    transport.sources.set("u1", "v3-both");
    const writesBefore = diskIO.writeCount;
    transport.sent.length = 0;

    await bridge.refreshSync(transport);

    // Nenhum lado é reescrito (já são iguais).
    expect(diskIO.writeCount).toBe(writesBefore);
    expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
    expect(readTmp(MAIN_DISK)).toBe("v3-both");

    // Prova de que o baseline foi atualizado para "v3-both": agora só o Studio
    // volta para "v0" (diverge do novo baseline) e o disco fica em "v3-both"
    // (== baseline) → vira caso 4, que escreve "v0" no disco.
    transport.sources.set("u1", "v0");
    transport.sent.length = 0;
    await bridge.refreshSync(transport);
    expect(readTmp(MAIN_DISK)).toBe("v0");
  });

  test("caso 6 — CONFLITO genuíno (ambos divergiram e diferem) → não sobrescreve, emite onSyncConflict", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    writeTmp(MAIN_DISK, "vDisco");
    transport.sources.set("u1", "vStudio");

    const conflicts: Array<{ diskPath: string; uuid: string }> = [];
    bridge.setOnSyncConflict((c) => conflicts.push(c));
    const writesBefore = diskIO.writeCount;
    transport.sent.length = 0;

    await bridge.refreshSync(transport);

    expect(conflicts).toEqual([{ diskPath: MAIN_DISK, uuid: "u1" }]);
    // Nenhum lado sobrescrito.
    expect(readTmp(MAIN_DISK)).toBe("vDisco");
    expect(transport.sources.get("u1")).toBe("vStudio");
    expect(diskIO.writeCount).toBe(writesBefore);
    expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
  });

  test("assimétrico A — arquivo só no disco, uuid nunca visto → criação nova (disco→Studio)", async () => {
    const transport = new FakeTransport();
    // Nenhum script registrado, nenhuma sincronização prévia. Um processo
    // externo criou este arquivo enquanto a extensão estava fechada.
    writeTmp("src/server/Novo.server.luau", "print('novo local')");

    await bridge.refreshSync(transport);

    const created = transport.scripts.find((s) => s.path === "ServerScriptService/Server/Novo");
    expect(created).toBeDefined();
    expect(created?.className).toBe("Script");
    expect(transport.sources.get(created!.uuid)).toBe("print('novo local')");
    // Passou a ser rastreado pela ponte.
    expect(bridge.resolveUuidForDiskPath("src/server/Novo.server.luau")).toBe(created!.uuid);
  });

  test("assimétrico B — script só no Studio (uuid sem diskPath) → puxa e escreve no disco", async () => {
    const transport = new FakeTransport();
    transport.scripts.push({ uuid: "u2", path: "ServerScriptService/Server/Remote", className: "ModuleScript" });
    transport.sources.set("u2", "return 'do studio'");
    // Nenhuma sincronização prévia: a ponte descobre u2 pelo listScripts fresco.

    await bridge.refreshSync(transport);

    expect(existsTmp("src/server/Remote.luau")).toBe(true);
    expect(readTmp("src/server/Remote.luau")).toBe("return 'do studio'");
    expect(bridge.resolveUuidForDiskPath("src/server/Remote.luau")).toBe("u2");
  });

  test("uuid materializado localmente mas ausente do listScripts do plugin: arquivo preservado (não-destrutivo)", async () => {
    const transport = new FakeTransport();
    await setupBaseline(transport, "v0");
    // Simula o script tendo sumido do Studio enquanto a extensão estava fechada:
    // o listScripts fresco não o reporta mais.
    transport.scripts.length = 0;

    await bridge.refreshSync(transport);

    // Deleção no Studio não é auto-propagada: o arquivo local continua lá.
    expect(existsTmp(MAIN_DISK)).toBe(true);
    expect(readTmp(MAIN_DISK)).toBe("v0");
  });

  describe("pastas de pacotes Wally — divergência ignorada silenciosamente (2026-07-16)", () => {
    const PKG_PATH = "ServerScriptService/Server/Packages/Foo";
    const PKG_DISK = "src/server/Packages/Foo.luau";

    async function setupPkgBaseline(transport: FakeTransport, content: string): Promise<void> {
      transport.scripts.push({ uuid: "upkg", path: PKG_PATH, className: "ModuleScript" });
      transport.sources.set("upkg", content);
      await bridge.runInitialSync(transport);
      expect(readTmp(PKG_DISK)).toBe(content);
    }

    test("só o disco mudou dentro de Packages → NÃO propaga ao Studio (ignorado silenciosamente)", async () => {
      const transport = new FakeTransport();
      await setupPkgBaseline(transport, "return 'v0'");
      writeTmp(PKG_DISK, "return 'v1-local-divergente'");
      transport.sent.length = 0;

      await bridge.refreshSync(transport);

      expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
      expect(transport.sources.get("upkg")).toBe("return 'v0'"); // Studio não mudou
    });

    test("só o Studio mudou dentro de Packages → NÃO propaga ao disco (ignorado silenciosamente)", async () => {
      const transport = new FakeTransport();
      await setupPkgBaseline(transport, "return 'v0'");
      transport.sources.set("upkg", "return 'v2-studio-divergente'");

      await bridge.refreshSync(transport);

      expect(readTmp(PKG_DISK)).toBe("return 'v0'"); // disco não mudou
    });

    test("CONFLITO dentro de Packages (ambos divergiram e diferem) → sem onSyncConflict, sem push, só log info", async () => {
      const transport = new FakeTransport();
      await setupPkgBaseline(transport, "return 'v0'");
      writeTmp(PKG_DISK, "return 'vDisco'");
      transport.sources.set("upkg", "return 'vStudio'");

      const conflicts: Array<{ diskPath: string; uuid: string }> = [];
      bridge.setOnSyncConflict((c) => conflicts.push(c));
      transport.sent.length = 0;

      await bridge.refreshSync(transport);

      expect(conflicts).toEqual([]); // NÃO reporta como conflito (comportamento diferente do caso 6 normal)
      expect(readTmp(PKG_DISK)).toBe("return 'vDisco'");
      expect(transport.sources.get("upkg")).toBe("return 'vStudio'");
      expect(transport.sent.some((m) => m.kind === "writeSource")).toBe(false);
      expect(logger.lines.some((l) => l.startsWith("WARN") && l.includes("CONFLITO"))).toBe(false);
    });

    test("criação nova dentro de Packages (arquivo só no disco, uuid nunca visto) CONTINUA funcionando normalmente", async () => {
      const transport = new FakeTransport();
      writeTmp("src/server/Packages/Nova.luau", "return 'novo pacote'");

      await bridge.refreshSync(transport);

      const created = transport.scripts.find((s) => s.path === "ServerScriptService/Server/Packages/Nova");
      expect(created).toBeDefined();
      expect(transport.sources.get(created!.uuid)).toBe("return 'novo pacote'");
    });
  });
});
