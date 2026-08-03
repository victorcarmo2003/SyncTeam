// Lógica do comando `syncteam stop` — lê `~/.syncteam/syncteam.pid`, encerra
// o daemon (SIGTERM gracioso, escalando para SIGKILL se não morrer a tempo —
// mesmo padrão de escalada já usado por
// `vscode-extension/src/sync/PortOwnership.ts::attemptPortReclaim`, mas
// esperando o PROCESSO morrer, não a porta liberar). PID file órfão
// (processo já morto) é tratado como obstáculo recuperável
// (.claude/rules/authority.md): loga a decisão e limpa, sem travar.
//
// Nota Windows (já documentada em `PortOwnership.ts`/`daemon/engine.ts`):
// `process.kill(pid, "SIGTERM")` força término imediato no Windows — o
// handler gracioso do daemon pode não rodar, mas a porta é liberada pelo SO
// de qualquer forma; aceito.

import { isProcessAlive } from "../../../vscode-extension/src/sync/PortOwnership.js";
import type { Logger } from "../../../vscode-extension/src/util/logger.js";
import { readPidFile, removePidFile } from "../daemon/pidFile.js";

const DEFAULT_GRACEFUL_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 100;

export interface StopCommandOptions {
  pidFile: string;
  logger: Logger;
  gracefulWaitMs?: number;
}

export type StopCommandResult = { ok: true; stopped: boolean; pid?: number } | { ok: false; errorMessage: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStopCommand(opts: StopCommandOptions): Promise<StopCommandResult> {
  const { pidFile, logger } = opts;
  const gracefulWaitMs = opts.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS;

  const info = await readPidFile(pidFile);
  if (info === null) {
    logger.info("nenhum daemon do SyncTeam rodando (nenhum arquivo de PID encontrado) — nada a fazer.");
    return { ok: true, stopped: false };
  }

  if (!isProcessAlive(info.pid)) {
    logger.info(
      `arquivo de PID em "${pidFile}" apontava para um processo morto (PID ${info.pid}) — removendo (nada a parar).`,
    );
    await removePidFile(pidFile);
    return { ok: true, stopped: false };
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (err) {
    const message = `Falha ao enviar SIGTERM para o PID ${info.pid}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  const deadline = Date.now() + gracefulWaitMs;
  let escalated = false;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      await removePidFile(pidFile);
      logger.info(`SyncTeam parado (PID ${info.pid}).`);
      return { ok: true, stopped: true, pid: info.pid };
    }
    if (!escalated && Date.now() > deadline - gracefulWaitMs / 2) {
      escalated = true;
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // Melhor esforço de escalada — a próxima checagem decide o resultado final de qualquer forma.
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!isProcessAlive(info.pid)) {
    await removePidFile(pidFile);
    logger.info(`SyncTeam parado (PID ${info.pid}).`);
    return { ok: true, stopped: true, pid: info.pid };
  }

  const message = `Processo PID ${info.pid} não encerrou a tempo (${gracefulWaitMs}ms) — arquivo de PID mantido.`;
  logger.error(message);
  return { ok: false, errorMessage: message };
}
