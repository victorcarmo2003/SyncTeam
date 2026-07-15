// Testa createFileLogger (append em disco, cria diretório se preciso) e
// createTeeLogger (despacha para múltiplos loggers), introduzidos para o
// harness Node poder gravar log em arquivo (SYNCTEAM_LOG_FILE) além do
// console — ver run-node-harness.ts e SyncTeamService.routeSpontaneous
// (kind "log").

import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileLogger, createTeeLogger, createNullLogger, type Logger } from "../src/util/logger.js";

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

describe("createFileLogger", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpFilePath(...segments: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncteam-filelogger-"));
    tmpDirs.push(dir);
    return path.join(dir, ...segments);
  }

  test("cria o diretório do arquivo se ainda não existir e grava a primeira linha", () => {
    const filePath = makeTmpFilePath("logs", "aninhado", "studio.log");

    const logger = createFileLogger(filePath, "[SyncTeam teste]");
    logger.info("primeira linha");

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("[SyncTeam teste]");
    expect(content).toContain("primeira linha");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("faz append (não sobrescreve) em chamadas sucessivas, inclusive entre instâncias", () => {
    const filePath = makeTmpFilePath("studio.log");

    createFileLogger(filePath).info("linha 1");
    createFileLogger(filePath).info("linha 2");

    const lines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("linha 1");
    expect(lines[1]).toContain("linha 2");
  });

  test("warn e error recebem uma tag textual (sem cor de console para diferenciar nível em arquivo texto)", () => {
    const filePath = makeTmpFilePath("studio.log");
    const logger = createFileLogger(filePath);

    logger.warn("algo suspeito");
    logger.error("algo quebrou");

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("WARN algo suspeito");
    expect(content).toContain("ERROR algo quebrou");
  });
});

describe("createTeeLogger", () => {
  test("despacha cada chamada para todos os loggers informados", () => {
    const a = new CapturingLogger();
    const b = new CapturingLogger();
    const tee = createTeeLogger(a, b);

    tee.info("oi");
    tee.warn("cuidado");
    tee.error("quebrou");

    expect(a.lines).toEqual(["INFO oi", "WARN cuidado", "ERROR quebrou"]);
    expect(b.lines).toEqual(["INFO oi", "WARN cuidado", "ERROR quebrou"]);
  });

  test("funciona com zero loggers (no-op) e com loggers nulos misturados", () => {
    const capturing = new CapturingLogger();
    const tee = createTeeLogger(createNullLogger(), capturing);

    expect(() => tee.info("mensagem")).not.toThrow();
    expect(capturing.lines).toEqual(["INFO mensagem"]);
  });
});
