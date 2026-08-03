// Lógica do comando `syncteam extension install` — espelha
// `pluginInstall.ts`, só que instala o `.vsix` da extensão VS Code em vez do
// `.rbxm` do plugin Studio. Diferença estrutural: não existe uma "pasta de
// destino" para copiar o arquivo para dentro (o VS Code não observa uma
// pasta de extensões manualmente populada da mesma forma que o Studio
// observa Plugins) — em vez disso, o `.vsix` embutido é escrito num arquivo
// TEMPORÁRIO e instalado via `code --install-extension <caminho> --force`
// (subprocess), o mesmo mecanismo que um usuário rodaria manualmente. Toda
// I/O injetada via `ExtensionInstallIO`, mesmo padrão de `PluginInstallIO`.

export interface ExtensionInstallIO {
  readEmbeddedExtension: () => Promise<Uint8Array>;
  /** Escreve `data` num arquivo temporário e devolve o caminho criado. */
  writeTempFile: (data: Uint8Array) => Promise<string>;
  removeFile: (filePath: string) => Promise<void>;
  /**
   * Roda `code --install-extension <vsixPath> --force`. Deve rejeitar com o
   * erro cru (preservando `.code === "ENOENT"` quando aplicável) se `code`
   * não for encontrado no PATH — `describeCodeError` abaixo depende disso
   * para dar uma mensagem clara em vez de stack trace cru.
   */
  runCodeInstall: (vsixPath: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface ExtensionInstallLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export type ExtensionInstallResult = { ok: true } | { ok: false; errorMessage: string };

export async function runExtensionInstall(io: ExtensionInstallIO, logger: ExtensionInstallLogger): Promise<ExtensionInstallResult> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readEmbeddedExtension();
  } catch (err) {
    const message = `Falha ao ler a extensão embutida no binário do CLI: ${describeError(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  let tempPath: string;
  try {
    tempPath = await io.writeTempFile(bytes);
  } catch (err) {
    const message = `Falha ao escrever o .vsix num arquivo temporário: ${describeError(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  try {
    const { stdout, stderr } = await io.runCodeInstall(tempPath);
    if (stdout.trim().length > 0) logger.info(stdout.trim());
    if (stderr.trim().length > 0) logger.info(stderr.trim());
  } catch (err) {
    const message = describeCodeError(err);
    logger.error(message);
    return { ok: false, errorMessage: message };
  } finally {
    try {
      await io.removeFile(tempPath);
    } catch {
      // Best-effort: arquivo temporário órfão em %TEMP%/tmp não é grave o suficiente para falhar o comando.
    }
  }

  logger.info("Extensão SyncTeam instalada no VS Code.");
  return { ok: true };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeCodeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return (
      'Comando "code" não encontrado no PATH. Instale o VS Code e habilite o comando "code" no PATH ' +
      "(Command Palette -> \"Shell Command: Install 'code' command in PATH\"), depois tente novamente."
    );
  }
  return `Falha ao instalar a extensão via "code --install-extension": ${describeError(err)}`;
}
