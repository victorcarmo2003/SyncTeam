// Testa o roteamento de mensagens espontâneas em SyncTeamService.routeSpontaneous,
// em particular o novo `kind: "log"` (mensagem espontânea que o plugin passou
// a mandar para todo print() do Output do Studio — ver
// .claude/agent-memory/extension-dev.md). Não abre socket nenhum: SyncServer
// é instanciado mas nunca `start()`ado, então a porta nunca é de fato aberta;
// chamamos o roteador privado diretamente, como já é prática aceitável para
// testar dispatch interno sem subir rede de verdade.

import { describe, test, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";
import { SyncTeamService } from "../src/sync/SyncTeamService.js";
import { SyncServer } from "../src/sync/SyncServer.js";
import { NodeDiskIO } from "../src/sync/NodeDiskIO.js";
import type { Logger } from "../src/util/logger.js";
import { PROTOCOL_VERSION, type RawMessage } from "../src/protocol.js";
import type { MountPoint } from "../src/mapping/projectMapping.js";

/** Pega uma porta TCP livre pedindo ao SO uma efêmera e fechando em seguida (mesmo helper de test/syncServer.test.ts). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (condition()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("waitFor: condição não satisfeita no tempo"));
      }
    }, 5);
  });
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

function makeService(logger: Logger, multiSync = false): SyncTeamService {
  const server = new SyncServer(0, logger); // porta nunca é bindada (start() não é chamado)
  const diskIO = new NodeDiskIO(fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-")));
  return new SyncTeamService(server, [], diskIO, logger, multiSync);
}

/**
 * Variante de `makeService` que expõe o `tmpDir` real (NodeDiskIO) e aceita
 * `mountPoints` — necessária para os testes de rajada abaixo, que precisam
 * inspecionar o layout materializado em disco de verdade (mesma prática de
 * `test/syncBridge.test.ts`: NodeDiskIO num `fs.mkdtempSync`, não um fake em
 * memória).
 */
function makeServiceWithMounts(logger: Logger, mountPoints: MountPoint[]): { service: SyncTeamService; tmpDir: string } {
  const server = new SyncServer(0, logger);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-burst-"));
  const diskIO = new NodeDiskIO(tmpDir);
  return { service: new SyncTeamService(server, mountPoints, diskIO, logger), tmpDir };
}

/** Acesso ao roteador privado + à cauda da fila FIFO — mesmo padrão de acesso a membro privado já usado neste arquivo para `routeSpontaneous`. */
function castInternal(service: SyncTeamService): { routeSpontaneous(m: RawMessage): void; queueTail: Promise<void> } {
  return service as unknown as { routeSpontaneous(m: RawMessage): void; queueTail: Promise<void> };
}

describe("SyncTeamService.routeSpontaneous — kind 'log'", () => {
  test("encaminha message.text para o logger prefixado com '[studio]'", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    const message: RawMessage = { kind: "log", text: "[SyncTeam 13:15:08] sou o líder agora (term 6)" };
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message);

    expect(logger.lines).toContain("INFO [studio] [SyncTeam 13:15:08] sou o líder agora (term 6)");
  });

  test("mensagem 'log' sem 'text' válido é logada como erro e descartada, sem derrubar o serviço", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    const message: RawMessage = { kind: "log" };
    expect(() => (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message)).not.toThrow();

    expect(logger.lines.some((line) => line.startsWith("ERROR") && line.includes("log"))).toBe(true);
    expect(logger.lines.some((line) => line.startsWith("INFO [studio]"))).toBe(false);
  });

  test("kind desconhecido continua caindo no default (comportamento preexistente, não quebrado pela mudança)", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({ kind: "algoDesconhecido" });

    expect(logger.lines.some((line) => line.includes("kind desconhecido"))).toBe(true);
  });
});

// M4: presença — roteamento de presenceChanged/presenceLeft. Mesmo padrão de
// teste do bloco 'log' acima: chama o roteador privado diretamente, sem
// abrir socket nenhum.
describe("SyncTeamService.routeSpontaneous — kind 'presenceChanged'/'presenceLeft'", () => {
  test("presenceChanged válido chama o callback com os campos normalizados", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceChanged((presence) => received.push(presence));

    const message: RawMessage = {
      kind: "presenceChanged",
      clientId: "client-b",
      displayName: "Dev B",
      uuid: "uuid-1",
      cursorLine: 10,
      cursorColumn: 4,
      selectionStartLine: 8,
      selectionStartColumn: 0,
    };
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message);

    expect(received).toEqual([
      {
        clientId: "client-b",
        displayName: "Dev B",
        uuid: "uuid-1",
        cursorLine: 10,
        cursorColumn: 4,
        selectionStartLine: 8,
        selectionStartColumn: 0,
      },
    ]);
  });

  test("presenceChanged normaliza campos AUSENTES (uuid/cursor/seleção) para null — mesma lição do M3.3 sobre HttpService:JSONEncode omitir chaves nil", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceChanged((presence) => received.push(presence));

    // uuid/cursorLine/etc. propositalmente AUSENTES (não undefined explícito
    // — simula o que realmente chega de HttpService:JSONEncode de uma
    // tabela Lua com esses campos nil).
    const message: RawMessage = { kind: "presenceChanged", clientId: "client-b", displayName: "Dev B" };
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message);

    expect(received).toEqual([
      {
        clientId: "client-b",
        displayName: "Dev B",
        uuid: null,
        cursorLine: null,
        cursorColumn: null,
        selectionStartLine: null,
        selectionStartColumn: null,
      },
    ]);
  });

  test("presenceChanged sem clientId válido é rejeitado sem chamar o callback", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceChanged((presence) => received.push(presence));

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "presenceChanged",
      displayName: "Dev B",
    });

    expect(received).toEqual([]);
    expect(logger.lines.some((line) => line.startsWith("ERROR") && line.includes("presenceChanged"))).toBe(true);
  });

  test("presenceChanged com cursorLine de tipo inválido é rejeitado", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceChanged((presence) => received.push(presence));

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "presenceChanged",
      clientId: "client-b",
      displayName: "Dev B",
      cursorLine: "não é número",
    });

    expect(received).toEqual([]);
    expect(logger.lines.some((line) => line.startsWith("ERROR") && line.includes("cursorLine"))).toBe(true);
  });

  test("nenhum callback registrado: presenceChanged válido não quebra (callback é opcional)", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    expect(() =>
      (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
        kind: "presenceChanged",
        clientId: "client-b",
        displayName: "Dev B",
      }),
    ).not.toThrow();
  });

  test("presenceLeft válido chama o callback com clientId", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceLeft((msg) => received.push(msg));

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "presenceLeft",
      clientId: "client-b",
    });

    expect(received).toEqual([{ clientId: "client-b" }]);
  });

  test("presenceLeft sem clientId válido é rejeitado sem chamar o callback", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const received: unknown[] = [];
    service.setOnPresenceLeft((msg) => received.push(msg));

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({ kind: "presenceLeft" });

    expect(received).toEqual([]);
    expect(logger.lines.some((line) => line.startsWith("ERROR") && line.includes("presenceLeft"))).toBe(true);
  });
});

describe("SyncTeamService — resolveUuidForDiskPath/resolveDiskPathForUuid/sendPresenceUpdate (M4)", () => {
  test("resolveUuidForDiskPath e resolveDiskPathForUuid retornam null quando nada foi sincronizado ainda", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    expect(service.resolveUuidForDiskPath("src/server/Main.server.luau")).toBeNull();
    expect(service.resolveDiskPathForUuid("uuid-desconhecido")).toBeNull();
  });

  test("sendPresenceUpdate não lança quando nenhum plugin está conectado (mesmo comportamento silencioso de SyncServer.send)", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    expect(() =>
      service.sendPresenceUpdate({ uuid: null, cursorLine: null, cursorColumn: null, selectionStartLine: null, selectionStartColumn: null }),
    ).not.toThrow();
    expect(logger.lines.some((line) => line.includes("presenceUpdate"))).toBe(true);
  });

  test("getConnectedCount() delega para SyncServer (0 sem conexão)", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);

    expect(service.getConnectedCount()).toBe(0);
  });

  test("getPresenceTransport().sendPresenceUpdate delega para sendPresenceUpdate do serviço", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const transport = service.getPresenceTransport();

    expect(() =>
      transport.sendPresenceUpdate({ uuid: "uuid-1", cursorLine: 0, cursorColumn: 0, selectionStartLine: null, selectionStartColumn: null }),
    ).not.toThrow();
    expect(logger.lines.some((line) => line.includes("presenceUpdate"))).toBe(true);
  });
});

// multiSync (2026-07-15): dedupe de mensagem espontânea duplicada quando 2+
// Studios reportam a mesma mudança quase ao mesmo tempo. Usa `leaseChanged`
// (sem I/O de disco) para isolar o dedupe do resto do pipeline — o mesmo
// roteador privado `routeSpontaneous` é chamado 2x seguidas com a MESMA
// mensagem (simula os 2 plugins mandando o evento replicado pelo Team Create).
describe("SyncTeamService.routeSpontaneous — dedupe multiSync", () => {
  test("multiSync=true: 2ª mensagem idêntica (mesmo kind+uuid+campos) dentro da janela é descartada", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger, true);
    const received: unknown[] = [];
    service.setOnLeaseChanged((msg) => received.push(msg));

    const message: RawMessage = { kind: "leaseChanged", uuid: "uuid-1", ownerClientId: "client-a", ownerDisplayName: "Dev A" };
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message);
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({ ...message });

    expect(received).toHaveLength(1); // só a 1ª chamou o callback
    expect(logger.lines.some((line) => line.includes("duplicada") && line.includes("dedupe"))).toBe(true);
  });

  test("multiSync=false (default): a MESMA verificação NÃO é aplicada — 2ª mensagem idêntica processa normalmente (sem regressão)", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger); // multiSync=false (default)
    const received: unknown[] = [];
    service.setOnLeaseChanged((msg) => received.push(msg));

    const message: RawMessage = { kind: "leaseChanged", uuid: "uuid-1", ownerClientId: "client-a", ownerDisplayName: "Dev A" };
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous(message);
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({ ...message });

    expect(received).toHaveLength(2); // comportamento de sempre: as duas processam
  });

  test("multiSync=true: mensagens DIFERENTES (uuid distinto) não são dedupidas mesmo em sequência imediata", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger, true);
    const received: unknown[] = [];
    service.setOnLeaseChanged((msg) => received.push(msg));

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "leaseChanged",
      uuid: "uuid-1",
      ownerClientId: "client-a",
      ownerDisplayName: "Dev A",
    });
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "leaseChanged",
      uuid: "uuid-2",
      ownerClientId: "client-a",
      ownerDisplayName: "Dev A",
    });

    expect(received).toHaveLength(2);
  });

  test("multiSync=true: mesmo uuid mas conteúdo diferente (sourceChanged com source distinto) não é dedupido", () => {
    const logger = new CapturingLogger();
    const service = makeService(logger, true);

    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "sourceChanged",
      uuid: "uuid-1",
      path: "a.luau",
      source: "conteúdo 1",
      className: "ModuleScript",
    });
    (service as unknown as { routeSpontaneous(m: RawMessage): void }).routeSpontaneous({
      kind: "sourceChanged",
      uuid: "uuid-1",
      path: "a.luau",
      source: "conteúdo 2",
      className: "ModuleScript",
    });

    // Nenhum dos dois deve ter sido descartado por dedupe (conteúdo mudou).
    expect(logger.lines.some((line) => line.includes("duplicada") && line.includes("dedupe"))).toBe(false);
  });
});

// Bug real relatado pelo usuário em uso real, 2026-07-27 (ver
// .claude/agent-memory/extension-dev.md e docs/DECISIONS.md mesma data):
// arrastar vários scripts/pastas irmãos para dentro de um Script existente no
// Explorer do Studio gera uma RAJADA de ~30 `scriptMoved` quase simultâneos.
// Antes da fila FIFO (`enqueueMutation`), `routeSpontaneous` despachava cada
// um fire-and-forget a partir do handler síncrono de mensagem do
// `SyncServer` — múltiplas chamadas concorrentes a `handleScriptMoved`
// liam/escreviam os MESMOS mapas do SyncBridge e faziam I/O de disco
// intercalado, corrompendo o layout final (arquivo duplicado, promoção
// pasta->arquivo nunca concluída). Os testes abaixo disparam a mesma rajada
// (SEM aguardar entre as mensagens, exatamente como o SyncServer despacha
// frames reais) contra a fila já corrigida e confirmam que o resultado final
// é determinístico e sem duplicação.
describe("SyncTeamService — fila FIFO serializa rajada de mensagens mutantes (bug real 2026-07-27)", () => {
  function readTmp(tmpDir: string, relPath: string): string {
    return fs.readFileSync(path.join(tmpDir, ...relPath.split("/")), "utf8");
  }
  function existsTmp(tmpDir: string, relPath: string): boolean {
    return fs.existsSync(path.join(tmpDir, ...relPath.split("/")));
  }

  test("mecanismo da fila: tarefas enfileiradas rodam em ordem FIFO, uma de cada vez, e um erro não trava as próximas", async () => {
    const logger = new CapturingLogger();
    const service = makeService(logger);
    const cast = service as unknown as { enqueueMutation(task: () => Promise<void>): Promise<void> };

    const order: string[] = [];
    // Tarefa 1 é deliberadamente mais LENTA que a 2 e a 3 — se a fila não
    // serializasse de verdade, "2" e/ou "3" terminariam antes de "1".
    const p1 = cast.enqueueMutation(async () => {
      order.push("1-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("1-end");
    });
    const p2 = cast.enqueueMutation(async () => {
      order.push("2-start");
      throw new Error("falha proposital da tarefa 2");
    });
    const p3 = cast.enqueueMutation(async () => {
      order.push("3-start");
      order.push("3-end");
    });

    await expect(p1).resolves.toBeUndefined();
    await expect(p2).rejects.toThrow("falha proposital da tarefa 2");
    await expect(p3).resolves.toBeUndefined();

    // FIFO estrito: "2-start" só aparece depois de "1-end" (não começou
    // enquanto "1" ainda rodava), e "3-start" só depois de "2-start" — mesmo
    // a tarefa 2 tendo REJEITADO, a fila seguiu para a 3 (erro não trava).
    expect(order).toEqual(["1-start", "1-end", "2-start", "3-start", "3-end"]);
  });

  test("rajada concorrente de 3 scriptMoved reparentando scripts sob um Script existente promove para init.server.luau sem duplicar arquivos", async () => {
    const logger = new CapturingLogger();
    const mountPoints: MountPoint[] = [{ dataModelPath: "ServerScriptService", diskPath: "src/server" }];
    const { service, tmpDir } = makeServiceWithMounts(logger, mountPoints);
    const cast = castInternal(service);

    // Estado inicial: reproduz o cenário relatado — um Script "Server" (folha,
    // sem filhos ainda) e 3 scripts irmãos soltos no mesmo nível.
    const initial: Array<{ uuid: string; path: string; className: "Script" | "ModuleScript"; source: string }> = [
      { uuid: "uuid-server", path: "ServerScriptService/Server", className: "Script", source: "-- server" },
      { uuid: "uuid-a", path: "ServerScriptService/SiblingA", className: "ModuleScript", source: "-- a" },
      { uuid: "uuid-b", path: "ServerScriptService/SiblingB", className: "ModuleScript", source: "-- b" },
      { uuid: "uuid-c", path: "ServerScriptService/SiblingC", className: "Script", source: "-- c" },
    ];
    for (const entry of initial) {
      cast.routeSpontaneous({ kind: "sourceChanged", uuid: entry.uuid, path: entry.path, source: entry.source, className: entry.className });
      cast.routeSpontaneous({ kind: "scriptAdded", uuid: entry.uuid, path: entry.path, className: entry.className });
    }
    await cast.queueTail;

    // Baseline: tudo materializado como arquivo achatado (sem filhos ainda).
    expect(existsTmp(tmpDir, "src/server/Server.server.luau")).toBe(true);
    expect(existsTmp(tmpDir, "src/server/SiblingA.luau")).toBe(true);
    expect(existsTmp(tmpDir, "src/server/SiblingB.luau")).toBe(true);
    expect(existsTmp(tmpDir, "src/server/SiblingC.server.luau")).toBe(true);

    // RAJADA: os 3 irmãos são reparentados para dentro do Script "Server"
    // quase ao mesmo tempo (usuário arrastando-os no Explorer) — disparados
    // SEM aguardar um pelo outro.
    cast.routeSpontaneous({
      kind: "scriptMoved",
      uuid: "uuid-a",
      oldPath: "ServerScriptService/SiblingA",
      newPath: "ServerScriptService/Server/SiblingA",
      className: "ModuleScript",
    });
    cast.routeSpontaneous({
      kind: "scriptMoved",
      uuid: "uuid-b",
      oldPath: "ServerScriptService/SiblingB",
      newPath: "ServerScriptService/Server/SiblingB",
      className: "ModuleScript",
    });
    cast.routeSpontaneous({
      kind: "scriptMoved",
      uuid: "uuid-c",
      oldPath: "ServerScriptService/SiblingC",
      newPath: "ServerScriptService/Server/SiblingC",
      className: "Script",
    });
    await cast.queueTail;

    // uuid-server foi promovido para pasta com init.server.luau, preservando
    // o conteúdo original — e o arquivo achatado antigo NUNCA sobrou (essa é
    // a duplicação relatada: pasta velha intacta + pasta nova com cópia).
    expect(existsTmp(tmpDir, "src/server/Server/init.server.luau")).toBe(true);
    expect(readTmp(tmpDir, "src/server/Server/init.server.luau")).toBe("-- server");
    expect(existsTmp(tmpDir, "src/server/Server.server.luau")).toBe(false);

    // Os 3 irmãos foram movidos para dentro da pasta nova, conteúdo íntegro,
    // e os caminhos antigos (soltos) não sobraram.
    expect(existsTmp(tmpDir, "src/server/Server/SiblingA.luau")).toBe(true);
    expect(readTmp(tmpDir, "src/server/Server/SiblingA.luau")).toBe("-- a");
    expect(existsTmp(tmpDir, "src/server/SiblingA.luau")).toBe(false);

    expect(existsTmp(tmpDir, "src/server/Server/SiblingB.luau")).toBe(true);
    expect(readTmp(tmpDir, "src/server/Server/SiblingB.luau")).toBe("-- b");
    expect(existsTmp(tmpDir, "src/server/SiblingB.luau")).toBe(false);

    expect(existsTmp(tmpDir, "src/server/Server/SiblingC.server.luau")).toBe(true);
    expect(readTmp(tmpDir, "src/server/Server/SiblingC.server.luau")).toBe("-- c");
    expect(existsTmp(tmpDir, "src/server/SiblingC.server.luau")).toBe(false);

    // Nenhuma pasta/arquivo órfão duplicado.
    expect(existsTmp(tmpDir, "src/server/Server/Server")).toBe(false);
    expect(existsTmp(tmpDir, "src/server/Server/Server.server.luau")).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("notifyLocalFileChange entra na MESMA fila que scriptMoved — não roda concorrente com a rajada do Studio", async () => {
    const logger = new CapturingLogger();
    const mountPoints: MountPoint[] = [{ dataModelPath: "ServerScriptService", diskPath: "src/server" }];
    const { service, tmpDir } = makeServiceWithMounts(logger, mountPoints);
    const cast = castInternal(service);

    cast.routeSpontaneous({ kind: "sourceChanged", uuid: "uuid-x", path: "ServerScriptService/X", source: "-- x", className: "ModuleScript" });
    cast.routeSpontaneous({ kind: "scriptAdded", uuid: "uuid-x", path: "ServerScriptService/X", className: "ModuleScript" });
    await cast.queueTail;

    // Dispara um scriptMoved (Studio) e uma mudança local (disco) SEM esperar
    // entre eles — mesma condição de corrida de origem dupla que o
    // handleLocalFileChange também precisa respeitar (ver item 4 do bug
    // reportado: watcher local concorrendo com rajada do Studio).
    cast.routeSpontaneous({
      kind: "scriptMoved",
      uuid: "uuid-x",
      oldPath: "ServerScriptService/X",
      newPath: "ServerScriptService/Y",
      className: "ModuleScript",
    });
    service.notifyLocalFileChange("src/server/arquivo-local-nao-relacionado.luau");
    await cast.queueTail;

    const movedLogIndex = logger.lines.findIndex(
      (line) => line.includes("scriptMoved") && line.includes("ServerScriptService/X") && line.includes("ServerScriptService/Y"),
    );
    const localChangeLogIndex = logger.lines.findIndex((line) => line.includes("arquivo-local-nao-relacionado"));

    expect(movedLogIndex).toBeGreaterThanOrEqual(0);
    expect(localChangeLogIndex).toBeGreaterThanOrEqual(0);
    // A mudança local só começou a ser processada DEPOIS do scriptMoved
    // terminar por completo — prova que os dois entram na mesma fila serial,
    // não filas independentes que rodariam concorrentemente.
    expect(localChangeLogIndex).toBeGreaterThan(movedLogIndex);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // "Handoff quase-instantâneo de lease" (2026-08-02, docs/DECISIONS.md "8ª
  // rodada"): notifyBufferChange (chamado pelo listener onDidChangeTextDocument
  // do lado extension.ts) precisa entrar na MESMA fila FIFO que
  // notifyLocalFileChange/scriptMoved — mesma razão: mexe nos mapas
  // compartilhados do SyncBridge (contentCache/sourceCache), então uma
  // pulsação de buffer concorrente com uma rajada do Studio teria o mesmo
  // tipo de corrida que motivou a fila em 2026-07-27.
  test("notifyBufferChange entra na MESMA fila que scriptMoved — não roda concorrente com a rajada do Studio", async () => {
    const logger = new CapturingLogger();
    const mountPoints: MountPoint[] = [{ dataModelPath: "ServerScriptService", diskPath: "src/server" }];
    const { service, tmpDir } = makeServiceWithMounts(logger, mountPoints);
    const cast = castInternal(service);

    cast.routeSpontaneous({ kind: "sourceChanged", uuid: "uuid-x", path: "ServerScriptService/X", source: "-- x", className: "ModuleScript" });
    cast.routeSpontaneous({ kind: "scriptAdded", uuid: "uuid-x", path: "ServerScriptService/X", className: "ModuleScript" });
    await cast.queueTail;

    // Dispara um scriptMoved (Studio) e uma pulsação de buffer (editor, ainda
    // sem save) para o NOVO diskPath, SEM esperar entre os dois.
    cast.routeSpontaneous({
      kind: "scriptMoved",
      uuid: "uuid-x",
      oldPath: "ServerScriptService/X",
      newPath: "ServerScriptService/Y",
      className: "ModuleScript",
    });
    service.notifyBufferChange("src/server/Y.luau", "-- editado no buffer, ainda não salvo");
    await cast.queueTail;

    const movedLogIndex = logger.lines.findIndex(
      (line) => line.includes("scriptMoved") && line.includes("ServerScriptService/X") && line.includes("ServerScriptService/Y"),
    );
    const bufferLogIndex = logger.lines.findIndex((line) => line.includes("buffer → Studio") && line.includes("src/server/Y.luau"));

    expect(movedLogIndex).toBeGreaterThanOrEqual(0);
    expect(bufferLogIndex).toBeGreaterThanOrEqual(0);
    // A pulsação de buffer só começou a ser processada DEPOIS do scriptMoved
    // terminar por completo (mesma prova de FIFO estrito do teste acima) —
    // se rodasse concorrente, o novo diskPath "src/server/Y.luau" ainda
    // poderia não ter uuid registrado no momento em que o buffer tentasse.
    expect(bufferLogIndex).toBeGreaterThan(movedLogIndex);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// watchedRoots (2026-07-29, ver protocol.ts e docs/DECISIONS.md mesma data):
// bug real relatado pelo usuário — o plugin Studio dependia de uma lista fixa
// hardcoded de "watched roots" (plugin/src/Config.luau) que não incluía
// ReplicatedFirst, então um mount point novo apontando pra lá não sincronizava
// nada. Fix do lado da extensão: mandar a lista de serviços de topo derivada
// do default.project.json ATUAL, no handshake. Teste com socket ws REAL
// (mesmo padrão de test/syncServer.test.ts) porque o envio acontece dentro do
// handler `onClientConnected` do SyncServer, que só dispara com um `hello` de
// verdade aceito — não dá para exercitar via routeSpontaneous (que é privado
// e não cobre o hello).
describe("SyncTeamService — watchedRoots enviado no handshake (2026-07-29)", () => {
  test("watchedRoots chega ANTES do listScripts da sincronização inicial, com os serviços de topo dos mount points atuais", async () => {
    const port = await getFreePort();
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-watchedroots-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const mountPoints: MountPoint[] = [
      { dataModelPath: "ReplicatedFirst/First", diskPath: "src/first" },
      { dataModelPath: "ServerScriptService/Server", diskPath: "src/server" },
    ];
    const service = new SyncTeamService(server, mountPoints, diskIO, logger);
    await service.start();

    const received: RawMessage[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as RawMessage));
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    await waitFor(() => received.some((m) => m.kind === "listScripts"));

    const watchedRootsIndex = received.findIndex((m) => m.kind === "watchedRoots");
    const listScriptsIndex = received.findIndex((m) => m.kind === "listScripts");
    expect(watchedRootsIndex).toBeGreaterThanOrEqual(0);
    expect(listScriptsIndex).toBeGreaterThan(watchedRootsIndex);
    expect(received[watchedRootsIndex].roots).toEqual(["ReplicatedFirst", "ServerScriptService"]);

    client.terminate();
    await service.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("mountPoints vazio manda watchedRoots com roots: [] (não pula a mensagem)", async () => {
    const port = await getFreePort();
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-watchedroots-empty-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const service = new SyncTeamService(server, [], diskIO, logger);
    await service.start();

    const received: RawMessage[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as RawMessage));
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    await waitFor(() => received.some((m) => m.kind === "watchedRoots"));

    const watchedRoots = received.find((m) => m.kind === "watchedRoots");
    expect(watchedRoots?.roots).toEqual([]);

    client.terminate();
    await service.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// getActualPort (2026-08-02, fallback automático de porta ocupada — ver
// SyncServer.tryListen/docs/DECISIONS.md): passthrough simples para
// SyncServer.getActualPort, mas confirmado de ponta a ponta com um start()
// real para não confiar só na leitura do código.
describe("SyncTeamService.getActualPort", () => {
  test("null antes de start(); igual à porta real depois de start() (sem fallback aqui)", async () => {
    const port = await getFreePort();
    const logger = new CapturingLogger();
    const server = new SyncServer(port, logger);
    const diskIO = new NodeDiskIO(fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-actualport-")));
    const service = new SyncTeamService(server, [], diskIO, logger);

    expect(service.getActualPort()).toBeNull();

    await service.start();
    expect(service.getActualPort()).toBe(port);

    await service.stop();
    expect(service.getActualPort()).toBeNull();
  });
});

// "ReSync" (2026-08-02, docs/DECISIONS.md "5ª rodada"): roteamento de
// `resyncRequest` — confirmação modal ANTES de apagar qualquer coisa
// (`onConfirmResync`, mesmo padrão de `PortReclaimHost.confirmKill`), e as
// 4 saídas possíveis (sem confirmador registrado / cancelado / confirmado com
// sucesso / erro durante o reset), todas sempre respondendo `resyncResult`
// para nunca deixar o botão do painel do Studio travado em "syncing".
describe("SyncTeamService.routeSpontaneous — kind 'resyncRequest' (ReSync, 2026-08-02)", () => {
  const MOUNTS: MountPoint[] = [{ dataModelPath: "ServerScriptService/Server", diskPath: "src/server" }];

  /** Popula um script sincronizado (uuid-a) via o mesmo par sourceChanged+scriptAdded que os outros testes de rajada já usam. */
  async function seedScript(cast: { routeSpontaneous(m: RawMessage): void; queueTail: Promise<void> }): Promise<void> {
    cast.routeSpontaneous({ kind: "sourceChanged", uuid: "uuid-a", path: "ServerScriptService/Server/A", source: "conteudo", className: "Script" });
    cast.routeSpontaneous({ kind: "scriptAdded", uuid: "uuid-a", path: "ServerScriptService/Server/A", className: "Script" });
    await cast.queueTail;
  }

  test("sem onConfirmResync registrado: recusa por segurança, resyncResult ok:false reason:no_confirm_handler, nada apagado", async () => {
    const logger = new CapturingLogger();
    const server = new SyncServer(0, logger); // nunca start()ado
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-resync-noconfirm-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const service = new SyncTeamService(server, MOUNTS, diskIO, logger);
    const cast = castInternal(service);
    await seedScript(cast);

    const filePath = path.join(tmpDir, "src", "server", "A.server.luau");
    expect(fs.existsSync(filePath)).toBe(true);

    const sent: RawMessage[] = [];
    vi.spyOn(server, "sendSpontaneous").mockImplementation((m) => {
      sent.push(m as RawMessage);
    });

    cast.routeSpontaneous({ kind: "resyncRequest" });
    await waitFor(() => sent.some((m) => m.kind === "resyncResult"));

    expect(sent.find((m) => m.kind === "resyncResult")).toEqual({ kind: "resyncResult", ok: false, reason: "no_confirm_handler" });
    expect(fs.existsSync(filePath)).toBe(true); // nada apagado
    expect(logger.lines.some((l) => l.startsWith("ERROR") && l.includes("confirmador"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("usuário cancela a confirmação (onConfirmResync resolve false): resyncResult ok:false reason:cancelled_by_user, nenhum arquivo apagado", async () => {
    const logger = new CapturingLogger();
    const server = new SyncServer(0, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-resync-cancel-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const service = new SyncTeamService(server, MOUNTS, diskIO, logger);
    service.setOnConfirmResync(async () => false);
    const cast = castInternal(service);
    await seedScript(cast);

    const filePath = path.join(tmpDir, "src", "server", "A.server.luau");
    expect(fs.existsSync(filePath)).toBe(true);

    const sent: RawMessage[] = [];
    vi.spyOn(server, "sendSpontaneous").mockImplementation((m) => {
      sent.push(m as RawMessage);
    });

    cast.routeSpontaneous({ kind: "resyncRequest" });
    await waitFor(() => sent.some((m) => m.kind === "resyncResult"));

    expect(sent.find((m) => m.kind === "resyncResult")).toEqual({ kind: "resyncResult", ok: false, reason: "cancelled_by_user" });
    expect(fs.existsSync(filePath)).toBe(true); // nada apagado

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("onConfirmResync rejeita (erro na própria UI): resyncResult ok:false com a mensagem do erro, nunca deixa a exceção subir", async () => {
    const logger = new CapturingLogger();
    const server = new SyncServer(0, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-resync-confirmthrows-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const service = new SyncTeamService(server, MOUNTS, diskIO, logger);
    service.setOnConfirmResync(() => Promise.reject(new Error("falha simulada mostrando o modal")));
    const cast = castInternal(service);

    const sent: RawMessage[] = [];
    vi.spyOn(server, "sendSpontaneous").mockImplementation((m) => {
      sent.push(m as RawMessage);
    });

    expect(() => cast.routeSpontaneous({ kind: "resyncRequest" })).not.toThrow();
    await waitFor(() => sent.some((m) => m.kind === "resyncResult"));

    expect(sent.find((m) => m.kind === "resyncResult")).toEqual({
      kind: "resyncResult",
      ok: false,
      reason: "falha simulada mostrando o modal",
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("usuário confirma: apaga o Source antigo, repuxa fresco de um plugin real conectado e responde ok:true com deletedCount", async () => {
    const logger = new CapturingLogger();
    const port = await getFreePort();
    const server = new SyncServer(port, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-resync-confirm-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const service = new SyncTeamService(server, MOUNTS, diskIO, logger);
    service.setOnConfirmResync(async () => true);
    await service.start();

    // Fake plugin (ws real): reporta uuid-a com conteúdo mutável — a
    // sincronização inicial da conexão materializa "old"; depois do resync
    // pedido, o Studio "muda de ideia" e passa a reportar conteúdo novo,
    // provando que o reset de fato apagou e repuxou (não deixou o antigo).
    let sourceForUuidA = "old";
    const received: RawMessage[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      received.push(message);
      if (message.kind === "listScripts") {
        client.send(
          JSON.stringify({
            kind: "scriptList",
            requestId: message.requestId,
            scripts: [{ uuid: "uuid-a", path: "ServerScriptService/Server/A", className: "Script" }],
          }),
        );
      } else if (message.kind === "readSource") {
        client.send(JSON.stringify({ kind: "sourceContent", requestId: message.requestId, ok: true, source: sourceForUuidA }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));

    const filePath = path.join(tmpDir, "src", "server", "A.server.luau");
    await waitFor(() => fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === "old");

    sourceForUuidA = "new after resync";
    client.send(JSON.stringify({ kind: "resyncRequest" }));

    await waitFor(() => received.some((m) => m.kind === "resyncResult"));

    const result = received.find((m) => m.kind === "resyncResult");
    expect(result).toMatchObject({ kind: "resyncResult", ok: true, deletedCount: 1 });
    expect(fs.readFileSync(filePath, "utf8")).toBe("new after resync");

    client.terminate();
    await service.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// "Fila FIFO sem coalescência para pulses de buffer" (2026-08-04, bug real
// reportado pelo usuário — trava de LSP/autocomplete "que demora mais quanto
// maior o arquivo e persiste depois de parar de digitar"). Hipótese
// confirmada por este teste ANTES do fix (ver .claude/agent-memory/
// extension-dev.md e docs/DECISIONS.md desta data): `notifyBufferChange`
// enfileirava incondicionalmente em `enqueueMutation` — cada pulse de
// digitação pagava um round-trip REAL (`transport.request`), e como a fila é
// FIFO estrita, N pulses do MESMO path viravam N round-trips SERIALIZADOS,
// não coalescidos. Com um round-trip mais lento que o intervalo entre
// pulses (aqui simulado por um ack atrasado do "plugin" fake), o backlog
// cresce sem limite — exatamente o sintoma relatado (trava que dura mais
// tempo quanto mais o usuário digitou, mesmo depois de parar).
//
// Usa um socket ws REAL (mesmo padrão de "watchedRoots"/"resyncRequest"
// acima) porque o que está sendo provado é o comportamento observável do
// TRANSPORTE (quantos writeSource saem pela rede), não só o dispatch interno
// — routeSpontaneous/enqueueMutation sozinhos não expõem isso.
describe("SyncTeamService.notifyBufferChange — coalescência de pulses do MESMO path (2026-08-04)", () => {
  const ROUND_TRIP_DELAY_MS = 50;

  /** Sobe um serviço real + um "plugin" fake que resolve writeSource só após ROUND_TRIP_DELAY_MS (simula o round-trip real Studio). */
  async function makeConnectedServiceWithSlowPlugin(logger: Logger): Promise<{
    service: SyncTeamService;
    tmpDir: string;
    client: WebSocket;
    writeSourceReceived: RawMessage[];
  }> {
    const port = await getFreePort();
    const server = new SyncServer(port, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-coalesce-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const mountPoints: MountPoint[] = [{ dataModelPath: "ServerScriptService", diskPath: "src/server" }];
    const service = new SyncTeamService(server, mountPoints, diskIO, logger);
    await service.start();

    const writeSourceReceived: RawMessage[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      if (message.kind === "listScripts") {
        client.send(JSON.stringify({ kind: "scriptList", requestId: message.requestId, scripts: [] }));
      } else if (message.kind === "readSource") {
        client.send(JSON.stringify({ kind: "sourceContent", requestId: message.requestId, ok: true, source: "-- inicial" }));
      } else if (message.kind === "writeSource") {
        writeSourceReceived.push(message);
        // Round-trip real do Studio simulado: ack só chega depois do delay —
        // é isso que faz um pulse "estar em voo" por tempo suficiente para um
        // segundo pulse (ou dez) chegar antes dele terminar.
        setTimeout(() => {
          client.send(
            JSON.stringify({ kind: "writeAck", requestId: message.requestId, ok: true, uuid: message.uuid, api: "UpdateSourceAsync" }),
          );
        }, ROUND_TRIP_DELAY_MS);
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    client.send(JSON.stringify({ kind: "scriptAdded", uuid: "uuid-x", path: "ServerScriptService/X", className: "Script" }));
    await waitFor(() => service.resolveUuidForDiskPath("src/server/X.server.luau") === "uuid-x");

    return { service, tmpDir, client, writeSourceReceived };
  }

  test("N pulses rápidos no MESMO path resultam em NO MÁXIMO 2 writeSource reais, não N (prova de coalescência)", async () => {
    const logger = new CapturingLogger();
    const { service, tmpDir, client, writeSourceReceived } = await makeConnectedServiceWithSlowPlugin(logger);

    const PULSE_COUNT = 12;
    const relPath = "src/server/X.server.luau";
    // Dispara os PULSE_COUNT pulses de forma SÍNCRONA (sem nenhum await entre
    // eles) — o caso mais adversarial possível, e também o mais determinístico
    // para CI: qualquer atraso via setTimeout entre chamadas fica sujeito à
    // granularidade real do timer do SO (no Windows, setTimeout(fn, 5) pode na
    // prática disparar só ~15ms depois — timer coalescing), o que tornaria o
    // teste flaky (o burst poderia "vazar" para além de uma única janela de
    // round-trip e produzir mais de 1 rodada de coalescência, cada uma
    // legitimamente justificada, não um bug). Disparando tudo no mesmo tick,
    // GARANTE que todos os 12 pulses cheguem MUITO antes do primeiro
    // round-trip (ROUND_TRIP_DELAY_MS) sequer começar a resolver.
    for (let i = 0; i < PULSE_COUNT; i++) {
      service.notifyBufferChange(relPath, `buffer-content-${i}`);
    }

    // Espera o backlog drenar por completo. Coalescido corretamente, isso
    // exige no máximo 2 round-trips (~2 * ROUND_TRIP_DELAY_MS); dá uma folga
    // generosa (10x) para não flakar em CI lento.
    await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_DELAY_MS * 10));

    expect(writeSourceReceived.length).toBeLessThanOrEqual(2);
    // O ÚLTIMO writeSource enviado precisa carregar o conteúdo MAIS RECENTE
    // (latest-wins) — nenhum pulse intermediário pode "vencer" o mais novo.
    expect(writeSourceReceived[writeSourceReceived.length - 1]?.source).toBe(`buffer-content-${PULSE_COUNT - 1}`);

    client.terminate();
    await service.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("pulses de paths DIFERENTES não se atropelam — cada path tem sua própria coalescência", async () => {
    const logger = new CapturingLogger();
    const port = await getFreePort();
    const server = new SyncServer(port, logger);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-coalesce-multi-"));
    const diskIO = new NodeDiskIO(tmpDir);
    const mountPoints: MountPoint[] = [{ dataModelPath: "ServerScriptService", diskPath: "src/server" }];
    const service = new SyncTeamService(server, mountPoints, diskIO, logger);
    await service.start();

    const writeSourceReceived: RawMessage[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString()) as RawMessage;
      if (message.kind === "listScripts") {
        client.send(JSON.stringify({ kind: "scriptList", requestId: message.requestId, scripts: [] }));
      } else if (message.kind === "readSource") {
        client.send(JSON.stringify({ kind: "sourceContent", requestId: message.requestId, ok: true, source: "-- inicial" }));
      } else if (message.kind === "writeSource") {
        writeSourceReceived.push(message);
        setTimeout(() => {
          client.send(
            JSON.stringify({ kind: "writeAck", requestId: message.requestId, ok: true, uuid: message.uuid, api: "UpdateSourceAsync" }),
          );
        }, ROUND_TRIP_DELAY_MS);
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ kind: "hello", protocolVersion: PROTOCOL_VERSION, role: "studio" }));
    client.send(JSON.stringify({ kind: "scriptAdded", uuid: "uuid-a", path: "ServerScriptService/A", className: "Script" }));
    client.send(JSON.stringify({ kind: "scriptAdded", uuid: "uuid-b", path: "ServerScriptService/B", className: "Script" }));
    await waitFor(() => service.resolveUuidForDiskPath("src/server/A.server.luau") === "uuid-a");
    await waitFor(() => service.resolveUuidForDiskPath("src/server/B.server.luau") === "uuid-b");

    // Mesmo raciocínio do teste acima: burst síncrono, sem await entre
    // chamadas, para não depender da granularidade real do timer do SO.
    for (let i = 0; i < 6; i++) {
      service.notifyBufferChange("src/server/A.server.luau", `a-${i}`);
      service.notifyBufferChange("src/server/B.server.luau", `b-${i}`);
    }
    await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_DELAY_MS * 10));

    const forA = writeSourceReceived.filter((m) => m.uuid === "uuid-a");
    const forB = writeSourceReceived.filter((m) => m.uuid === "uuid-b");
    expect(forA.length).toBeLessThanOrEqual(2);
    expect(forB.length).toBeLessThanOrEqual(2);
    expect(forA[forA.length - 1]?.source).toBe("a-5");
    expect(forB[forB.length - 1]?.source).toBe("b-5");

    client.terminate();
    await service.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
