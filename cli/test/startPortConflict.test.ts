// Teste de ponta a ponta REAL do fluxo de "posse de porta" interativo dentro
// de `syncteam start` — a peça central do pedido da tarefa ("com Y/N se
// porta ocupada"). Reusa `attemptPortReclaim`/`SyncServer.onPortOccupied`
// (`vscode-extension/src/sync/PortOwnership.ts`, já exaustivamente testado
// naquele pacote) sem reimplementar nada; o que este teste prova é a
// LIGAÇÃO em `runStartCommand` — o diálogo `confirmKill` é chamado de
// verdade, e aceitar mata o processo ocupante e reaproveita A MESMA porta
// configurada (sem cair no fallback automático port+1).
//
// A porta é ocupada por um PROCESSO FILHO SEPARADO (não pelo próprio
// processo de teste) — importante porque `attemptPortReclaim` mata pelo PID
// identificado via `netstat`/`lsof`; se o "ocupante" fosse o processo do
// próprio teste (vitest worker), aceitar o kill destruiria a suíte inteira.

import { describe, test, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { runStartCommand } from "../src/commands/start.js";
import { runStopCommand } from "../src/commands/stop.js";
import { resolveSyncteamPaths } from "../src/config/paths.js";
import { isProcessAlive } from "../../vscode-extension/src/sync/PortOwnership.js";
import type { Logger } from "../../vscode-extension/src/util/logger.js";

const TEST_PORT = 39881;

function resolveBunExecutable(): string {
  const home = os.homedir();
  const candidate = path.join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  return existsSync(candidate) ? candidate : "bun";
}
const BUN_EXECUTABLE = resolveBunExecutable();
const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-conflict-project-"));
  const projectJson = { name: "SyncTeamCliConflictTest", tree: { $className: "DataModel", ServerScriptService: { $path: "src/server" } } };
  await fs.writeFile(path.join(dir, "default.project.json"), JSON.stringify(projectJson, null, 2), "utf8");
  return dir;
}

async function makeTmpHomePaths(): Promise<ReturnType<typeof resolveSyncteamPaths>> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "syncteam-cli-conflict-home-"));
  return resolveSyncteamPaths(home);
}

/** Spawna um processo Node SEPARADO só para ocupar `port` (plain TCP, não fala WebSocket) — seguro de matar, ao contrário do próprio processo de teste. */
function occupyPortInChildProcess(port: number): Promise<ChildProcess> {
  const script = `require('net').createServer().listen(${port}, '127.0.0.1', () => { console.log('listening'); });`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => reject(new Error("timeout esperando o processo ocupante começar a escutar")), 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("start: posse de porta interativa (Y/N) quando a porta configurada está ocupada", () => {
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
    "usuário confirma (Y): o processo ocupante é encerrado, o daemon sobe na MESMA porta configurada, confirmKill foi chamado",
    async () => {
      expect(await isPortFree(TEST_PORT), "porta de teste deveria começar livre").toBe(true);

      const occupier = await occupyPortInChildProcess(TEST_PORT);
      expect(occupier.pid).toBeDefined();
      if (occupier.pid) cleanupPids.push(occupier.pid);

      const projectDir = await makeTmpProject();
      const paths = await makeTmpHomePaths();
      const { logger, lines } = makeCapturingLogger();

      const confirmCalls: string[] = [];
      const startResult = await runStartCommand({
        projectDir,
        paths,
        configuredPort: TEST_PORT,
        logger,
        confirmKill: async (message) => {
          confirmCalls.push(message);
          return true; // usuário confirma: "sim, encerre o processo"
        },
        execPath: BUN_EXECUTABLE,
        argv0: BUN_EXECUTABLE,
        argv1: CLI_ENTRY,
      });

      expect(startResult.ok, `esperado sucesso; log: ${lines.join("\n")}`).toBe(true);
      expect(confirmCalls.length, "confirmKill deveria ter sido chamado (porta ocupada)").toBeGreaterThan(0);
      if (startResult.ok) {
        cleanupPids.push(startResult.pid);
        // A parte central do pedido: reaproveitar a MESMA porta configurada, não cair pro fallback (port+1).
        expect(startResult.port).toBe(TEST_PORT);
        await runStopCommand({ pidFile: paths.pidFile, logger });
      }

      // O processo ocupante original não deveria mais existir (foi encerrado pela posse de porta).
      if (occupier.pid) {
        expect(isProcessAlive(occupier.pid)).toBe(false);
      }
    },
    20000,
  );

  test(
    "usuário recusa (N): processo ocupante sobrevive, syncteam cai para uma porta alternativa (fallback automático)",
    async () => {
      expect(await isPortFree(TEST_PORT + 1), "porta de teste deveria começar livre").toBe(true);

      const occupier = await occupyPortInChildProcess(TEST_PORT + 1);
      if (occupier.pid) cleanupPids.push(occupier.pid);

      const projectDir = await makeTmpProject();
      const paths = await makeTmpHomePaths();
      const { logger, lines } = makeCapturingLogger();

      const confirmCalls: string[] = [];
      const startResult = await runStartCommand({
        projectDir,
        paths,
        configuredPort: TEST_PORT + 1,
        logger,
        confirmKill: async (message) => {
          confirmCalls.push(message);
          return false; // usuário recusa
        },
        execPath: BUN_EXECUTABLE,
        argv0: BUN_EXECUTABLE,
        argv1: CLI_ENTRY,
      });

      expect(startResult.ok, `esperado sucesso (via fallback); log: ${lines.join("\n")}`).toBe(true);
      expect(confirmCalls.length).toBeGreaterThan(0);
      if (startResult.ok) {
        cleanupPids.push(startResult.pid);
        expect(startResult.port).not.toBe(TEST_PORT + 1); // NÃO é a porta configurada — caiu no fallback
        await runStopCommand({ pidFile: paths.pidFile, logger });
      }

      // Processo ocupante original sobrevive (recusa nunca mata ninguém).
      if (occupier.pid) {
        expect(isProcessAlive(occupier.pid)).toBe(true);
      }
    },
    20000,
  );
});
