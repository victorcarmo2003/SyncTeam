// SyncTeam — ponto de ativação da extensão VS Code (M1: 1 dev, sem
// coordenação de time). Acha o `default.project.json` do workspace, lê os
// pontos de montagem, sobe o servidor WebSocket local (o plugin Studio
// conecta como cliente) e liga um FileSystemWatcher para propagar edições
// locais ao Studio.
//
// Regra de .claude/rules/typescript.md: escrita no workspace do usuário
// passa por vscode.workspace.fs (VscodeDiskIO), não node:fs direto — só a
// camada de LÓGICA (mapping/, SyncBridge) é testável com node:fs puro.

import * as vscode from "vscode";
import * as path from "node:path";
import { SyncServer } from "./sync/SyncServer.js";
import { SyncTeamService } from "./sync/SyncTeamService.js";
import { VscodeDiskIO } from "./sync/VscodeDiskIO.js";
import { parseMountPoints, type MountPoint } from "./mapping/projectMapping.js";
import { createOutputChannelLogger } from "./util/vscodeLogger.js";
import type { Logger } from "./util/logger.js";

const DEFAULT_PORT = 34980;
const WATCH_DEBOUNCE_MS = 150;

let outputChannel: vscode.OutputChannel | undefined;
let service: SyncTeamService | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;

async function findProjectFile(): Promise<vscode.Uri | null> {
  const matches = await vscode.workspace.findFiles("**/default.project.json", "**/node_modules/**", 1);
  return matches.length > 0 ? matches[0] : null;
}

async function readProjectMountPoints(projectFileUri: vscode.Uri, logger: Logger): Promise<MountPoint[] | null> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(projectFileUri);
  } catch (error) {
    logger.error(`erro lendo '${projectFileUri.fsPath}': ${(error as Error).message}`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch (error) {
    logger.error(`'${projectFileUri.fsPath}' não é JSON válido: ${(error as Error).message}`);
    return null;
  }
  try {
    return parseMountPoints(json);
  } catch (error) {
    logger.error(`erro interpretando pontos de montagem de '${projectFileUri.fsPath}': ${(error as Error).message}`);
    return null;
  }
}

function relDiskPathFromUri(projectDir: vscode.Uri, fileUri: vscode.Uri): string {
  const relative = path.relative(projectDir.fsPath, fileUri.fsPath);
  return relative.split(path.sep).join("/");
}

async function startService(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  const projectFileUri = await findProjectFile();
  if (!projectFileUri) {
    logger.info("nenhum default.project.json encontrado no workspace — SyncTeam inativo");
    return;
  }

  const mountPoints = await readProjectMountPoints(projectFileUri, logger);
  if (!mountPoints || mountPoints.length === 0) {
    logger.error(
      `'${projectFileUri.fsPath}' não tem nenhum ponto de montagem ($path) reconhecível — SyncTeam não tem o que sincronizar`,
    );
    return;
  }
  logger.info(`pontos de montagem: ${mountPoints.map((m) => `${m.dataModelPath} -> ${m.diskPath}`).join(", ")}`);

  const projectDir = vscode.Uri.joinPath(projectFileUri, "..");
  const diskIO = new VscodeDiskIO(projectDir);
  const port = vscode.workspace.getConfiguration("syncteam").get<number>("port", DEFAULT_PORT);

  const server = new SyncServer(port, logger);
  service = new SyncTeamService(server, mountPoints, diskIO, logger);

  // M3.3: configurar callbacks de UI para leaseChanged e writeRejected.
  service.setOnLeaseChanged(({ uuid, ownerClientId, ownerDisplayName }) => {
    if (ownerClientId === null) {
      // Lease foi liberada.
      logger.info(`lease de '${uuid}' foi liberada`);
    } else {
      // Alguém adquiriu ou mantém a lease.
      const owner = ownerDisplayName ?? `cliente ${ownerClientId}`;
      logger.info(`lease de '${uuid}' agora é de ${owner}`);
    }
  });

  service.setOnWriteRejected(({ diskPath, error }) => {
    logger.warn(`escrita negada em '${diskPath}': ${error}`);
    vscode.window.showWarningMessage(`SyncTeam: não foi possível editar '${diskPath}' — ${error}`);
  });

  try {
    await service.start();
  } catch (error) {
    logger.error(`falha ao iniciar o servidor WebSocket na porta ${port}: ${(error as Error).message}`);
    service = undefined;
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectDir, "**/*"));
  fileWatcher = watcher;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleNotify = (uri: vscode.Uri) => {
    const relPath = relDiskPathFromUri(projectDir, uri);
    const existing = debounceTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
    }
    debounceTimers.set(
      relPath,
      setTimeout(() => {
        debounceTimers.delete(relPath);
        service?.notifyLocalFileChange(relPath);
      }, WATCH_DEBOUNCE_MS),
    );
  };
  context.subscriptions.push(
    watcher.onDidChange(scheduleNotify),
    watcher.onDidCreate(scheduleNotify),
    watcher,
    { dispose: () => {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
    } },
  );

  logger.info(`SyncTeam ativo — projeto '${projectFileUri.fsPath}', porta ${port}`);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("SyncTeam");
  const logger = createOutputChannelLogger(outputChannel);
  logger.info("extensão SyncTeam ativada");

  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("syncteam.showOutput", () => outputChannel?.show(true)),
    vscode.commands.registerCommand("syncteam.restart", async () => {
      await service?.stop();
      service = undefined;
      fileWatcher?.dispose();
      fileWatcher = undefined;
      await startService(context, logger);
    }),
  );

  startService(context, logger).catch((error: Error) => {
    logger.error(`falha inesperada ao ativar o SyncTeam: ${error.message}`);
  });
}

export function deactivate(): Promise<void> | void {
  fileWatcher?.dispose();
  return service?.stop();
}
