// Implementação de DiskIO sobre `vscode.workspace.fs` — usada pela extensão
// real (extension.ts). Regra de .claude/rules/typescript.md: operações no
// workspace do usuário passam pela API do VS Code para o buffer aberto
// acompanhar a mudança. Não importado por nenhum teste (precisa do VS Code
// de pé) — só pela camada de ativação.

import * as vscode from "vscode";
import type { DiskIO } from "./DiskIO.js";

export class VscodeDiskIO implements DiskIO {
  constructor(private readonly root: vscode.Uri) {}

  private toUri(relPath: string): vscode.Uri {
    const segments = relPath.split("/").filter((segment) => segment.length > 0);
    return vscode.Uri.joinPath(this.root, ...segments);
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.toUri(relPath));
      return Buffer.from(bytes).toString("utf8");
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const uri = this.toUri(relPath);
    const dirUri = vscode.Uri.joinPath(uri, "..");
    try {
      await vscode.workspace.fs.createDirectory(dirUri);
    } catch {
      // já existe — createDirectory não tem "recursive" explícito, mas é
      // idempotente na prática do VS Code; falha aqui não deve bloquear a
      // escrita do arquivo em si.
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  async deleteFile(relPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.toUri(relPath), { recursive: false, useTrash: false });
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
    }
  }

  async renameFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const oldUri = this.toUri(oldRelPath);
    const newUri = this.toUri(newRelPath);
    const newDirUri = vscode.Uri.joinPath(newUri, "..");
    try {
      await vscode.workspace.fs.createDirectory(newDirUri);
    } catch {
      // já existe — mesma tolerância de writeFile.
    }
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
  }

  async removeEmptyDirsUpward(relDir: string): Promise<void> {
    let current = relDir;
    while (current !== "") {
      const uri = this.toUri(current);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        return;
      }
      if (entries.length > 0) {
        return;
      }
      try {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      } catch {
        return;
      }
      const idx = current.lastIndexOf("/");
      current = idx === -1 ? "" : current.slice(0, idx);
    }
  }
}
