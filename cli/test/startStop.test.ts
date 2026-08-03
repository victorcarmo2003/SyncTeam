// Teste de ponta a ponta REAL de `syncteam start`/`syncteam stop` — mesma
// filosofia do resto do projeto (nunca mockar fs/child_process/net/ws, ver
// `vscode-extension/src/sync/PortOwnership.ts`): sobe um daemon DE VERDADE
// (processo filho real, via `bun`), confirma que a porta abre de fato (lock
// file real escrito pelo próprio daemon), depois para de verdade (SIGTERM
// real) e confirma que o processo e os arquivos de estado desaparecem.
//
// `execPath`/`argv0`/`argv1` são passados para `runStartCommand`
// exatamente como `src/index.ts` passaria em produção (`process.execPath`,
// `process.argv[0]`, `process.argv[1]`) — isso exercita o MESMO caminho de
// auto-reinvocação (`daemon/selfInvocation.ts`) que uma chamada real de
// `bun run src/index.ts start` usaria, sem precisar spawnar o CLI inteiro
// como processo de teste (mais rápido, mesma cobertura do mecanismo real).

import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runStartCommand } from "../src/commands/start.js";
import { runStopCommand } from "../src/commands/stop.js";
import { resolveSyncteamPaths } from "../src/config/paths.js";
import { isProcessAlive } from "../../vscode-extension/src/sync/PortOwnership.js";
import type { Logger } from "../../vscode-extension/src/util/logger.js";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TEST_PORT = 39871;

/**
 * Achado real desta tarefa: `bun run test` executa a suíte inteira via
 * `vitest`, mas o WORKER que roda cada arquivo de teste é um processo NODE
 * (confirmado empiricamente — `process.execPath` dentro de um teste aponta
 * para `node.exe`, não `bun.exe`, mesmo a suíte tendo sido lançada com `bun
 * run test`; vitest usa pools de worker próprios, independentes do runtime
 * que invocou o CLI do vitest). Isso NÃO é um bug de produto: em uso real,
 * quem chama `bun run src/index.ts start` (ou o binário compilado) tem
 * `process.execPath` apontando para o bun de verdade — é só este AMBIENTE
 * DE TESTE que não reflete isso. Por isso o teste resolve o `bun.exe` real
 * explicitamente em vez de reusar `process.execPath`, para exercitar a MESMA
 * auto-reinvocação (`daemon/selfInvocation.ts`) que a produção usa.
 */
function resolveBunExecutable(): string {
  const home = os.homedir();
  const candidate = path.join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  return existsSync(candidate) ? candidate : "bun";
}

const BUN_EXECUTABLE = resolveBunExecutable();

function makeCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    logger: {
      info: (m) => lines.push(`INFO ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    },
    lines,
  };
}

async function makeTmpProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-project-"));
  const projectJson = {
    name: "SyncTeamCliTest",
    tree: {
      $className: "DataModel",
      ServerScriptService: { $path: "src/server" },
    },
  };
  await fs.writeFile(path.join(dir, "default.project.json"), JSON.stringify(projectJson, null, 2), "utf8");
  return dir;
}

async function makeTmpHomePaths(): Promise<ReturnType<typeof resolveSyncteamPaths>> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-home-"));
  return resolveSyncteamPaths(home);
}

describe("start/stop (processo real)", () => {
  const cleanupPids: number[] = [];

  afterEach(async () => {
    for (const pid of cleanupPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // já morto — ok.
      }
    }
  });

  test(
    "start sobe um daemon real (PID vivo, PID file escrito, porta confirmada) e stop encerra de verdade",
    async () => {
      const projectDir = await makeTmpProject();
      const paths = await makeTmpHomePaths();
      const { logger: startLogger, lines: startLines } = makeCapturingLogger();

      const startResult = await runStartCommand({
        projectDir,
        paths,
        configuredPort: TEST_PORT,
        logger: startLogger,
        confirmKill: async () => false, // não deveria nem ser chamado (porta livre) — recusa por padrão de segurança se for.
        execPath: BUN_EXECUTABLE,
        argv0: BUN_EXECUTABLE,
        argv1: CLI_ENTRY,
      });

      expect(startResult.ok, `start deveria ter sucesso; log: ${startLines.join("\n")}`).toBe(true);
      if (!startResult.ok) return;
      cleanupPids.push(startResult.pid);

      expect(startResult.port).toBe(TEST_PORT);
      expect(isProcessAlive(startResult.pid)).toBe(true);

      const pidFileRaw = await fs.readFile(paths.pidFile, "utf8");
      const pidFileInfo = JSON.parse(pidFileRaw) as { pid: number; port: number; projectDir: string };
      expect(pidFileInfo.pid).toBe(startResult.pid);
      expect(pidFileInfo.port).toBe(TEST_PORT);

      const lockRaw = await fs.readFile(path.join(paths.portLockDir, `port-${TEST_PORT}.json`), "utf8");
      const lockInfo = JSON.parse(lockRaw) as { pid: number; port: number };
      expect(lockInfo.pid).toBe(startResult.pid);

      // stop: encerra de verdade e limpa o PID file.
      const { logger: stopLogger, lines: stopLines } = makeCapturingLogger();
      const stopResult = await runStopCommand({ pidFile: paths.pidFile, logger: stopLogger });

      expect(stopResult.ok, `stop deveria ter sucesso; log: ${stopLines.join("\n")}`).toBe(true);
      if (stopResult.ok) {
        expect(stopResult.stopped).toBe(true);
      }
      expect(isProcessAlive(startResult.pid)).toBe(false);
      await expect(fs.access(paths.pidFile)).rejects.toThrow();
    },
    20000,
  );

  test("start recusa um segundo start enquanto o primeiro está rodando (PID file aponta pra processo vivo)", async () => {
    const projectDir = await makeTmpProject();
    const paths = await makeTmpHomePaths();
    const { logger } = makeCapturingLogger();

    const first = await runStartCommand({
      projectDir,
      paths,
      configuredPort: TEST_PORT + 1,
      logger,
      confirmKill: async () => false,
      execPath: BUN_EXECUTABLE,
      argv0: BUN_EXECUTABLE,
      argv1: CLI_ENTRY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    cleanupPids.push(first.pid);

    const second = await runStartCommand({
      projectDir,
      paths,
      configuredPort: TEST_PORT + 1,
      logger,
      confirmKill: async () => false,
      execPath: BUN_EXECUTABLE,
      argv0: BUN_EXECUTABLE,
      argv1: CLI_ENTRY,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.errorMessage).toMatch(/já está rodando/);
    }

    const stop = await runStopCommand({ pidFile: paths.pidFile, logger });
    expect(stop.ok).toBe(true);
  }, 20000);

  test("stop sem daemon rodando (nenhum PID file): idempotente, ok:true, stopped:false", async () => {
    const paths = await makeTmpHomePaths();
    const { logger } = makeCapturingLogger();

    const result = await runStopCommand({ pidFile: paths.pidFile, logger });
    expect(result).toEqual({ ok: true, stopped: false });
  });

  test("start limpa PID file órfão (processo morto) e segue com um novo start", async () => {
    const projectDir = await makeTmpProject();
    const paths = await makeTmpHomePaths();
    const { logger, lines } = makeCapturingLogger();

    await fs.mkdir(paths.configDir, { recursive: true });
    // PID praticamente garantido de não existir (fora da faixa comum de PID vivo neste teste).
    await fs.writeFile(paths.pidFile, JSON.stringify({ pid: 999999, port: TEST_PORT + 2, projectDir }), "utf8");

    const result = await runStartCommand({
      projectDir,
      paths,
      configuredPort: TEST_PORT + 2,
      logger,
      confirmKill: async () => false,
      execPath: BUN_EXECUTABLE,
      argv0: BUN_EXECUTABLE,
      argv1: CLI_ENTRY,
    });

    expect(result.ok, `esperado sucesso; log: ${lines.join("\n")}`).toBe(true);
    if (result.ok) {
      cleanupPids.push(result.pid);
      expect(lines.some((l) => l.includes("processo morto"))).toBe(true);
    }

    if (result.ok) {
      await runStopCommand({ pidFile: paths.pidFile, logger });
    }
  }, 20000);
});
