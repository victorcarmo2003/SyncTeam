// SyncTeam — harness Node para testar o motor real da extensão (SyncServer +
// SyncTeamService + SyncBridge, os mesmos módulos usados em extension.ts) SEM
// precisar abrir um VS Code Extension Development Host. Usa NodeDiskIO em vez
// de VscodeDiskIO — é o único ponto de diferença real com a ativação de
// produto; toda a lógica de protocolo/mapeamento é idêntica.
//
// Uso: node dist/run-node-harness.js <pasta-do-projeto-rojo>
// (pasta deve conter um default.project.json)

import fs from "node:fs/promises";
import path from "node:path";
import { SyncServer } from "../src/sync/SyncServer.js";
import { SyncTeamService } from "../src/sync/SyncTeamService.js";
import { NodeDiskIO } from "../src/sync/NodeDiskIO.js";
import { parseMountPoints } from "../src/mapping/projectMapping.js";
import { createConsoleLogger, createFileLogger, createTeeLogger } from "../src/util/logger.js";

const DEFAULT_PORT = 34980;
const HARNESS_LOG_PREFIX = "[SyncTeam harness]";

async function main(): Promise<void> {
  const projectDir = path.resolve(process.argv[2] ?? ".");
  const projectFile = path.join(projectDir, "default.project.json");
  const consoleLogger = createConsoleLogger(HARNESS_LOG_PREFIX);
  // SYNCTEAM_LOG_FILE (opcional, absoluto ou relativo ao cwd): quando
  // presente, todo log do harness (incluindo mensagens espontâneas "log" do
  // plugin, tratadas em SyncTeamService.routeSpontaneous) também vai para
  // esse arquivo — permite o orquestrador ler o Output do Studio sem depender
  // do usuário copiar/colar nem de nenhum MCP externo. Sem a env var, o
  // comportamento é idêntico ao anterior (só console).
  const logFile = process.env.SYNCTEAM_LOG_FILE;
  const logger = logFile ? createTeeLogger(consoleLogger, createFileLogger(logFile, HARNESS_LOG_PREFIX)) : consoleLogger;

  const raw = await fs.readFile(projectFile, "utf8");
  const json = JSON.parse(raw);
  const mountPoints = parseMountPoints(json);
  logger.info(`projeto: ${projectFile}`);
  logger.info(`pontos de montagem: ${mountPoints.map((m) => `${m.dataModelPath} -> ${m.diskPath}`).join(", ")}`);

  const port = Number(process.env.SYNCTEAM_PORT ?? DEFAULT_PORT);
  const diskIO = new NodeDiskIO(projectDir);
  const server = new SyncServer(port, logger);
  const service = new SyncTeamService(server, mountPoints, diskIO, logger);

  const watcher = diskIO.watch((relPath) => service.notifyLocalFileChange(relPath));

  await service.start();
  logger.info(`harness rodando. Abra o Studio com o plugin M1 apontado para a porta ${port}.`);

  const shutdown = async () => {
    logger.info("encerrando...");
    watcher.dispose();
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: Error) => {
  console.error(`[SyncTeam harness] erro fatal: ${error.message}`);
  process.exit(1);
});
