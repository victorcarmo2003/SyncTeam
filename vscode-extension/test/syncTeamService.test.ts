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

function makeService(logger: Logger): SyncTeamService {
  const server = new SyncServer(0, logger); // porta nunca é bindada (start() não é chamado)
  const diskIO = new NodeDiskIO(fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-service-")));
  return new SyncTeamService(server, [], diskIO, logger);
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
