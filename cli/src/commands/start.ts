// Lógica do comando `syncteam start` — sobe o MESMO motor de sincronização
// de produção que já roda dentro da extensão VS Code (ver `daemon/engine.ts`),
// só que headless/em segundo plano (daemon). Fluxo em 2 processos deliberado:
//
// 1. ESTE processo (foreground, com terminal/stdin de verdade) resolve
//    qualquer conflito de porta de forma INTERATIVA — usando o MESMO
//    mecanismo de "posse de porta" já validado em
//    `vscode-extension/src/sync/PortOwnership.ts` (reusado sem alteração,
//    cross-pacote), incluindo o diálogo Y/N real (`confirmKill`) quando a
//    porta configurada já está ocupada. Um `SyncServer` TEMPORÁRIO é usado só
//    para essa resolução — assim que confirma que dá para abrir a porta (a
//    configurada, ou uma alternativa de fallback automático), ele é
//    IMEDIATAMENTE parado (`server.stop()`), liberando a porta de novo.
// 2. Este processo então spawna um SEGUNDO processo DESTACADO (`detached:
//    true`, stdio redirecionado para `~/.syncteam/daemon.log`) — o próprio
//    binário do CLI reinvocado com a flag interna `start --daemon-child`
//    (ver `daemon/selfInvocation.ts`) — que é quem de fato liga o motor real
//    (`daemon/engine.ts`) e fica rodando em segundo plano, na porta já
//    resolvida no passo 1, SEM hook interativo (processo destacado não tem
//    terminal para perguntar nada).
// 3. Este processo espera um sinal de que o daemon abriu a porta de fato —
//    lê o lockfile de posse de porta (MESMO mecanismo do passo 1),
//    conferindo que o PID registrado é o do processo que ele ACABOU de
//    spawnar — antes de escrever `~/.syncteam/syncteam.pid` e retornar
//    sucesso; ou reporta falha com uma dica de onde olhar o log.
//
// Pequena janela de corrida aceita entre o `server.stop()` do passo 1 e o
// bind real do daemon no passo 2 (outro processo poderia teoricamente roubar
// a porta nesse meio-tempo) — mesma classe de limitação já aceita em outras
// partes do projeto (nunca reportada como bug real; ver
// `.claude/agent-memory/extension-dev.md`). Se acontecer, o daemon falha
// rápido e claro (`portFallbackAttempts: 0` em `engine.ts`) e este comando
// reporta a falha — não há corrupção silenciosa de estado.

import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { SyncServer } from "../../../vscode-extension/src/sync/SyncServer.js";
import { attemptPortReclaim, readPortLock, isProcessAlive, type PortReclaimHost } from "../../../vscode-extension/src/sync/PortOwnership.js";
import type { Logger } from "../../../vscode-extension/src/util/logger.js";
import { resolveSelfInvocation } from "../daemon/selfInvocation.js";
import type { SyncteamPaths } from "../config/paths.js";
import { readPidFile, writePidFile, removePidFile } from "../daemon/pidFile.js";

const DEFAULT_POLL_TIMEOUT_MS = 4000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface StartCommandOptions {
  /** Diretório absoluto do projeto Rojo (contém `default.project.json`). */
  projectDir: string;
  paths: SyncteamPaths;
  configuredPort: number;
  logger: Logger;
  /** Implementação real de `PortReclaimHost.confirmKill` (readline no CLI, ver `prompt/confirmPrompt.ts`). */
  confirmKill: (message: string) => Promise<boolean>;
  /** `process.execPath`/`process.argv[0]`/`process.argv[1]` do processo ATUAL — usados para reinvocar o próprio binário como daemon (ver `daemon/selfInvocation.ts` para o porquê dos três). */
  execPath: string;
  argv0: string;
  argv1: string | undefined;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type StartCommandResult = { ok: true; pid: number; port: number } | { ok: false; errorMessage: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runStartCommand(opts: StartCommandOptions): Promise<StartCommandResult> {
  const { projectDir, paths, configuredPort, logger, confirmKill } = opts;
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const projectFile = path.join(projectDir, "default.project.json");
  if (!(await fileExists(projectFile))) {
    const message = `Nenhum "default.project.json" encontrado em "${projectDir}" — aponte para uma pasta de projeto Rojo válida (use --dir <pasta>).`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  const existing = await readPidFile(paths.pidFile);
  if (existing !== null) {
    if (isProcessAlive(existing.pid)) {
      const message = `syncteam já está rodando (PID ${existing.pid}, porta ${existing.port}). Use "syncteam stop" primeiro.`;
      logger.error(message);
      return { ok: false, errorMessage: message };
    }
    // Obstáculo recuperável (.claude/rules/authority.md): PID file órfão
    // (processo já morto, provavelmente crash ou kill externo) — decide e
    // segue, log claro, sem travar pedindo confirmação.
    logger.info(
      `arquivo de PID em "${paths.pidFile}" apontava para um processo morto (PID ${existing.pid}) — removendo e ` +
        "continuando com um novo start.",
    );
    await removePidFile(paths.pidFile);
  }

  // Passo 1: resolve a porta (interativo se preciso) com um SyncServer temporário.
  const host: PortReclaimHost = {
    confirmKill,
    info: (message) => logger.info(message),
    error: (message) => logger.error(message),
  };
  const probeServer = new SyncServer(configuredPort, logger, {
    portLockDir: paths.portLockDir,
    onPortOccupied: (info) =>
      attemptPortReclaim({
        requestedPort: info.requestedPort,
        occupiedPort: info.occupiedPort,
        lockDir: paths.portLockDir,
        host,
      }),
  });

  let resolvedPort: number;
  try {
    await probeServer.start();
    resolvedPort = probeServer.getActualPort() as number;
  } catch (err) {
    const message = `Não foi possível abrir a porta ${configuredPort}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }
  await probeServer.stop();

  // Passo 2: spawn do daemon destacado, já na porta resolvida.
  const selfInvocation = resolveSelfInvocation(
    { execPath: opts.execPath, argv0: opts.argv0, argv1: opts.argv1 },
    ["start", "--daemon-child"],
  );

  await fs.mkdir(paths.configDir, { recursive: true });
  const logFd = openSync(paths.daemonLogFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(selfInvocation.command, selfInvocation.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        SYNCTEAM_PORT: String(resolvedPort),
        SYNCTEAM_PROJECT_DIR: projectDir,
        SYNCTEAM_PORT_LOCK_DIR: paths.portLockDir,
      },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  if (child.pid === undefined) {
    const message = "Falha ao iniciar o processo do daemon (spawn não retornou PID).";
    logger.error(message);
    return { ok: false, errorMessage: message };
  }
  const childPid = child.pid;

  let childExitCode: number | null = null;
  let childExited = false;
  child.once("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });

  const deadline = Date.now() + pollTimeoutMs;
  let confirmedPort: number | null = null;
  while (Date.now() < deadline) {
    if (childExited) break;
    const lock = readPortLock(paths.portLockDir, resolvedPort);
    if (lock !== null && lock.pid === childPid) {
      confirmedPort = lock.port;
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (confirmedPort === null && childExited) {
    const message =
      `O processo do daemon encerrou logo após iniciar (código ${childExitCode ?? "desconhecido"}) — veja o log em ` +
      `"${paths.daemonLogFile}" para detalhes.`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  await writePidFile(paths.pidFile, { pid: childPid, port: confirmedPort ?? resolvedPort, projectDir });

  if (confirmedPort === null) {
    logger.info(
      `daemon iniciado (PID ${childPid}), mas não foi possível confirmar a tempo que a porta ${resolvedPort} abriu — ` +
        `verifique "${paths.daemonLogFile}". O processo continua rodando; "syncteam stop" ainda funciona.`,
    );
  } else {
    logger.info(`SyncTeam iniciado em segundo plano (PID ${childPid}), porta ${confirmedPort}. Log: "${paths.daemonLogFile}".`);
  }

  return { ok: true, pid: childPid, port: confirmedPort ?? resolvedPort };
}
