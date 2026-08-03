// Lógica do comando `syncteam plugin install`. Módulo puro de orquestração —
// toda I/O real (ler o .rbxm embutido, escrever no disco) é injetada via
// `PluginInstallIO`, para ser testável sem precisar compilar o binário nem
// tocar a pasta de Plugins de verdade. `src/index.ts` é o único lugar que
// fornece a implementação real (`Bun.file`/`node:fs`).

import path from "node:path";
import { resolveStudioPluginsDir, UnsupportedPlatformError, type PluginsDirContext } from "../plugin/studioPluginsDir.js";

export const PLUGIN_FILE_NAME = "SyncTeam.rbxm";

export interface PluginInstallIO {
  readEmbeddedPlugin: () => Promise<Uint8Array>;
  mkdir: (dir: string) => Promise<void>;
  fileExists: (filePath: string) => Promise<boolean>;
  removeFile: (filePath: string) => Promise<void>;
  writeFile: (filePath: string, data: Uint8Array) => Promise<void>;
}

export interface PluginInstallLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export type PluginInstallResult =
  | { ok: true; installedPath: string }
  | { ok: false; errorMessage: string };

/**
 * Instala o `.rbxm` embutido no binário na pasta de Plugins do Studio local.
 * Delete+copy quando já existe um arquivo anterior (mesmo padrão de
 * `Tools/build-and-deploy-plugin.sh` — força o auto-refresh do Studio em vez
 * de um overwrite in-place, que o Studio às vezes não detecta).
 *
 * Toda operação de IO é try/catch isolada — nunca deixa stack trace cru
 * vazar pro usuário final, sempre uma mensagem descritiva do que falhou.
 */
export async function runPluginInstall(
  ctx: PluginsDirContext,
  io: PluginInstallIO,
  logger: PluginInstallLogger,
): Promise<PluginInstallResult> {
  let pluginsDir: string;
  try {
    pluginsDir = resolveStudioPluginsDir(ctx);
  } catch (err) {
    const message = err instanceof UnsupportedPlatformError ? err.message : describeError(err);
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  const destPath =
    ctx.platform === "win32"
      ? path.win32.join(pluginsDir, PLUGIN_FILE_NAME)
      : path.posix.join(pluginsDir, PLUGIN_FILE_NAME);

  try {
    await io.mkdir(pluginsDir);
  } catch (err) {
    const message = `Não foi possível criar/acessar a pasta de Plugins do Studio ("${pluginsDir}"): ${describeError(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  try {
    if (await io.fileExists(destPath)) {
      await io.removeFile(destPath);
    }
  } catch (err) {
    // Não-fatal: registra e tenta sobrescrever mesmo assim (write costuma
    // funcionar mesmo quando o delete falha por permissão transitória).
    logger.error(
      `Aviso: falha ao remover instalação anterior ("${destPath}"): ${describeError(err)} — tentando sobrescrever mesmo assim.`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await io.readEmbeddedPlugin();
  } catch (err) {
    const message = `Falha ao ler o plugin embutido no binário do CLI: ${describeError(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  try {
    await io.writeFile(destPath, bytes);
  } catch (err) {
    const message = `Falha ao escrever o plugin em "${destPath}": ${describeError(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  logger.info(`Plugin SyncTeam instalado em "${destPath}".`);
  return { ok: true, installedPath: destPath };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
