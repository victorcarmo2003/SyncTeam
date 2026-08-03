// SyncTeam CLI — motor de sincronização headless, rodado dentro do processo
// destacado que `syncteam start` spawna (ver `commands/start.ts` e
// `daemon/selfInvocation.ts`; disparado quando o CLI é reinvocado como
// `start --daemon-child`). PORTE DIRETO da composição já validada em
// `vscode-extension/tools/run-node-harness.ts` (SyncServer + SyncTeamService
// + NodeDiskIO) — não uma reimplementação; os módulos importados abaixo SÃO
// os mesmos arquivos-fonte de `vscode-extension/src/` (import relativo
// cross-pacote — `cli/` não depende de `vscode-extension/` como dependência
// de pacote instalada via npm/bun, mas compartilha o mesmo repositório e
// TypeScript resolve/type-checa a referência normalmente, confirmado por
// `bun run lint` limpo — ver `cli/README.md`).
//
// Diferenças deliberadas em relação ao harness original:
// - Configuração 100% por variável de ambiente (`SYNCTEAM_PORT`,
//   `SYNCTEAM_PROJECT_DIR`, `SYNCTEAM_PORT_LOCK_DIR`), sem argumentos
//   posicionais — quem spawna este processo é sempre `commands/start.ts`,
//   nunca um humano diretamente.
// - `portFallbackAttempts: 0` — `commands/start.ts` já resolveu qualquer
//   conflito de porta (com o MESMO mecanismo de posse de porta interativo,
//   `PortOwnership.ts::attemptPortReclaim`) ANTES de chegar aqui, e espera
//   que este processo abra EXATAMENTE a porta pedida; se não conseguir,
//   falha alto e claro em vez de silenciosamente escolher outra porta que o
//   processo pai não saberia reportar ao usuário.
// - Sem hook `onPortOccupied` — este processo roda destacado/sem terminal,
//   não há como mostrar um diálogo Y/N aqui (é por isso que a resolução
//   interativa acontece ANTES, no processo pai).
// - Log só via console (stdout/stderr): `commands/start.ts` já redireciona
//   os dois para `~/.syncteam/daemon.log` na hora do spawn (fd real aberto
//   com `fs.openSync(..., "a")`) — um segundo logger de arquivo aqui
//   duplicaria cada linha (mesma lição já registrada para
//   `run-node-harness.ts`/`SYNCTEAM_LOG_FILE`, que usa tee propositalmente
//   PARA O CASO DE stdio não estar redirecionado; aqui sempre está).

import path from "node:path";
import fs from "node:fs/promises";
import { SyncServer } from "../../../vscode-extension/src/sync/SyncServer.js";
import { SyncTeamService } from "../../../vscode-extension/src/sync/SyncTeamService.js";
import { NodeDiskIO } from "../../../vscode-extension/src/sync/NodeDiskIO.js";
import { parseMountPoints } from "../../../vscode-extension/src/mapping/projectMapping.js";
import { createConsoleLogger } from "../../../vscode-extension/src/util/logger.js";

const LOG_PREFIX = "[SyncTeam daemon]";

/**
 * Roda o motor headless até receber SIGINT/SIGTERM (encerramento gracioso —
 * `service.stop()` libera a porta e remove o lockfile, mesmo caminho que
 * `SyncController`/`extension.ts` usam do lado VS Code) ou até `service.start()`
 * falhar (retorna sem nunca resolver nesse caso — quem chama trata o
 * `process.exitCode` nunca-zero como falha).
 *
 * **Nota Windows** (já documentada em `PortOwnership.ts`): `process.kill(pid,
 * "SIGTERM")` disparado por OUTRO processo (`syncteam stop`) força término
 * imediato no Windows, sem necessariamente invocar o handler abaixo — nesse
 * caso a porta ainda é liberada pelo SO normalmente (encerramento de
 * processo sempre libera sockets), só o lockfile fica órfão até o próximo
 * bind bem-sucedido nessa porta sobrescrevê-lo (comportamento aceito, mesma
 * classe de "zumbi identificado" que `attemptPortReclaim` já sabe lidar).
 */
export async function runDaemonChild(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logger = createConsoleLogger(LOG_PREFIX);

  const portRaw = env.SYNCTEAM_PORT;
  const projectDir = env.SYNCTEAM_PROJECT_DIR;
  const portLockDir = env.SYNCTEAM_PORT_LOCK_DIR;
  const port = Number(portRaw);

  if (!portRaw || !Number.isInteger(port) || port <= 0) {
    logger.error(`SYNCTEAM_PORT ausente/inválido ("${portRaw ?? ""}") — abortando`);
    process.exitCode = 1;
    return;
  }
  if (!projectDir) {
    logger.error("SYNCTEAM_PROJECT_DIR ausente — abortando");
    process.exitCode = 1;
    return;
  }

  const projectFile = path.join(projectDir, "default.project.json");
  let mountPoints;
  try {
    const raw = await fs.readFile(projectFile, "utf8");
    mountPoints = parseMountPoints(JSON.parse(raw));
  } catch (error) {
    logger.error(`falha ao ler/interpretar "${projectFile}": ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  logger.info(`projeto: ${projectFile}`);
  logger.info(`pontos de montagem: ${mountPoints.map((m) => `${m.dataModelPath} -> ${m.diskPath}`).join(", ")}`);

  const diskIO = new NodeDiskIO(projectDir);
  const server = new SyncServer(port, logger, {
    portFallbackAttempts: 0,
    portLockDir,
  });
  const service = new SyncTeamService(server, mountPoints, diskIO, logger);

  const watcher = diskIO.watch((relPath) => service.notifyLocalFileChange(relPath));

  try {
    await service.start();
  } catch (error) {
    logger.error(`falha ao abrir a porta ${port}: ${(error as Error).message}`);
    watcher.dispose();
    process.exitCode = 1;
    return;
  }

  logger.info(`daemon rodando (PID ${process.pid}), porta ${port}, projeto "${projectDir}"`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`recebido ${signal} — encerrando graciosamente...`);
      watcher.dispose();
      service
        .stop()
        .catch((error: unknown) => logger.error(`erro ao parar o serviço: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => resolve());
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
