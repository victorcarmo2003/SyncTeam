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
import { parseLayoutDeclaration } from "../src/mapping/layoutFallback.js";
import { computeWallyFingerprint } from "../src/mapping/wallyFingerprint.js";
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

  // Declaracao de layout, se houver: e o que permite uma feature NOVA criada
  // no Studio cair no disco quando nenhum ponto de montagem a cobre (ver
  // mapping/layoutFallback.ts). Sem carregar aqui, o harness nao exercitaria
  // esse caminho — e o harness e justamente o que permite medir sem ninguem
  // clicando no VS Code.
  let layoutDeclaration = null;
  try {
    const declRaw = await fs.readFile(path.join(projectDir, "syncteam.json"), "utf8");
    layoutDeclaration = parseLayoutDeclaration(JSON.parse(declRaw));
    if (layoutDeclaration) {
      logger.info(`syncteam.json: raiz '${layoutDeclaration.root}', lados ${Object.keys(layoutDeclaration.sides).join(", ")}`);
    }
  } catch {
    // ausente e o caso normal
  }

  const port = Number(process.env.SYNCTEAM_PORT ?? DEFAULT_PORT);
  const diskIO = new NodeDiskIO(projectDir);
  const server = new SyncServer(port, logger);
  const service = new SyncTeamService(server, mountPoints, diskIO, logger, false, layoutDeclaration);

  const watcher = diskIO.watch((relPath) => service.notifyLocalFileChange(relPath));

  await service.start();

  // Mesma publicacao que a extensao faz: sem ela o plugin nunca teria a
  // impressao digital deste lado para comparar com a do outro Studio.
  try {
    const wally = await fs.readFile(path.join(projectDir, "wally.toml"), "utf8");
    service.sendWallyFingerprint(computeWallyFingerprint(wally));
    // "registrada", nao "publicada": neste instante quase nunca ha plugin
    // conectado, e o envio e descartado. Quem entrega de verdade e o
    // republish de onClientConnected. Dizer "publicada" aqui foi um log
    // mentiroso que custou uma rodada de teste.
    logger.info("wally.toml: impressão digital registrada");
  } catch {
    // projeto sem wally.toml: nada a comparar
  }
  service.setOnWallyDrift(({ displayName }) => {
    logger.warn(`WALLY DRIFT: ${displayName} está com dependências diferentes — rode \`wally install\``);
  });

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
