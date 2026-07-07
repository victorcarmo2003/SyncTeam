// SyncTeam — abstração de disco usada pela lógica de sincronização
// (SyncBridge). Duas implementações:
//   - NodeDiskIO (node:fs/promises): usada em testes e em qualquer harness
//     Node, sem depender do VS Code.
//   - VscodeDiskIO (vscode.workspace.fs): usada pela extensão real
//     (extension.ts), para que edições no disco passem pela API do VS Code e
//     buffers abertos acompanhem — regra de .claude/rules/typescript.md.
//
// Todo `relPath` aqui é relativo à raiz do workspace de sincronização (a
// pasta que contém o default.project.json), sempre com "/" como separador de
// segmentos — nunca separador de SO.

export interface DiskIO {
  /** `null` se o arquivo não existe. Outros erros são propagados. */
  readFile(relPath: string): Promise<string | null>;
  /** Cria diretórios intermediários conforme necessário. */
  writeFile(relPath: string, content: string): Promise<void>;
  /** No-op se o arquivo não existir. */
  deleteFile(relPath: string): Promise<void>;
  /**
   * Remove diretórios vazios subindo a partir de `relDir` até (sem incluir)
   * a raiz do workspace de sincronização. Nunca remove a própria raiz.
   */
  removeEmptyDirsUpward(relDir: string): Promise<void>;
  /**
   * Move o arquivo físico de `oldRelPath` para `newRelPath` (M2: rename/move
   * de script detectado no Studio, preservando identidade em vez de
   * delete+create). Cria diretórios intermediários do destino antes de
   * mover. Propaga o erro se `oldRelPath` não existir — quem chama decide o
   * fallback (ex.: tratar como criação nova).
   */
  renameFile(oldRelPath: string, newRelPath: string): Promise<void>;
}

export interface DiskWatcher {
  dispose(): void;
}

export interface WatchableDiskIO extends DiskIO {
  /** `onChange` recebe o `relPath` (posix) do arquivo alterado/criado. */
  watch(onChange: (relPath: string) => void): DiskWatcher;
}

/** Dirname "/"-separado (posix), sem depender de node:path — usado nas duas implementações. */
export function posixDirname(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}
