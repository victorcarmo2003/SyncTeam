// Testa o roteamento de mensagens espontâneas em SyncTeamService.routeSpontaneous,
// em particular o novo `kind: "log"` (mensagem espontânea que o plugin passou
// a mandar para todo print() do Output do Studio — ver
// .claude/agent-memory/extension-dev.md). Não abre socket nenhum: SyncServer
// é instanciado mas nunca `start()`ado, então a porta nunca é de fato aberta;
// chamamos o roteador privado diretamente, como já é prática aceitável para
// testar dispatch interno sem subir rede de verdade.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncTeamService } from "../src/sync/SyncTeamService.js";
import { SyncServer } from "../src/sync/SyncServer.js";
import { NodeDiskIO } from "../src/sync/NodeDiskIO.js";
import type { Logger } from "../src/util/logger.js";
import type { RawMessage } from "../src/protocol.js";

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
