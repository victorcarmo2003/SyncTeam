// Logger que escreve num vscode.OutputChannel, com o mesmo formato do
// console logger (prefixo [SyncTeam] + timestamp). Só usado pela camada de
// ativação (extension.ts) — não importado por nenhum teste.

import * as vscode from "vscode";
import type { Logger } from "./logger.js";

export function createOutputChannelLogger(channel: vscode.OutputChannel): Logger {
  const prefix = "[SyncTeam]";
  const line = (message: string) => `${prefix} ${new Date().toISOString()} ${message}`;
  return {
    info(message: string): void {
      channel.appendLine(line(message));
    },
    warn(message: string): void {
      channel.appendLine(line(`[WARN] ${message}`));
    },
    error(message: string): void {
      channel.appendLine(line(`[ERROR] ${message}`));
    },
  };
}
