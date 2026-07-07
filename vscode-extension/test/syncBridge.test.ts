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
