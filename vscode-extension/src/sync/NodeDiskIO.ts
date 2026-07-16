// Implementação de DiskIO sobre node:fs — usada em testes e em harness Node
// (fora do VS Code). Ver DiskIO.ts para o contrato e a convenção de path.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DiskWatcher, WatchableDiskIO } from "./DiskIO.js";

const DEFAULT_WATCH_DEBOUNCE_MS = 150;

export class NodeDiskIO implements WatchableDiskIO {
  constructor(
    private readonly root: string,
    private readonly watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  ) {}

  private toAbsolute(relPath: string): string {
    const segments = relPath.split("/").filter((segment) => segment.length > 0);
    return path.join(this.root, ...segments);
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.toAbsolute(relPath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const absolute = this.toAbsolute(relPath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, "utf8");
  }

  async deleteFile(relPath: string): Promise<void> {
    try {
      await fsp.unlink(this.toAbsolute(relPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async renameFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const oldAbsolute = this.toAbsolute(oldRelPath);
    const newAbsolute = this.toAbsolute(newRelPath);
    await fsp.mkdir(path.dirname(newAbsolute), { recursive: true });
    await fsp.rename(oldAbsolute, newAbsolute);
  }

  async listFiles(relDir: string): Promise<string[]> {
    const base = relDir === "" ? this.root : this.toAbsolute(relDir);
    const prefix = relDir === "" ? "" : `${relDir.replace(/\/+$/g, "")}/`;
    const files: string[] = [];

    const walk = async (absDir: string, relPrefix: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch (error) {
        // Diretório inexistente (ENOENT) é esperado quando um mount ainda não
        // foi materializado — devolve vazio em vez de propagar.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const childRel = `${relPrefix}${entry.name}`;
        if (entry.isDirectory()) {
          await walk(path.join(absDir, entry.name), `${childRel}/`);
        } else if (entry.isFile()) {
          files.push(childRel);
        }
      }
    };

    await walk(base, prefix);
    return files;
  }

  async removeEmptyDirsUpward(relDir: string): Promise<void> {
    const root = path.resolve(this.root);
    let dir = path.resolve(this.toAbsolute(relDir));
    while (true) {
      // Comparação case-insensitive: Windows/NTFS não distingue caixa.
      if (dir.toLowerCase() === root.toLowerCase()) {
        break;
      }
      const rel = path.relative(root, dir);
      if (rel === "" || rel.startsWith("..")) {
        break; // fora da árvore do workspace — nunca deveria acontecer, mas por segurança
      }
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        break;
      }
      if (entries.length > 0) {
        break;
      }
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  /**
   * `fs.watch(root, { recursive: true })`: funciona no Windows/macOS; no
   * Linux só é suportado nativamente em versões recentes do Node — mesma
   * limitação já documentada no spike M0.5 (ver
   * .claude/agent-memory/extension-dev.md). Aceitável para M1 (alvo é
   * Windows/macOS neste projeto); revisar se o produto precisar rodar em
   * Linux.
   */
  watch(onChange: (relPath: string) => void): DiskWatcher {
    const debounceTimers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(this.root, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      const normalized = filename.toString().replace(/\\/g, "/");
      const existing = debounceTimers.get(normalized);
      if (existing) {
        clearTimeout(existing);
      }
      debounceTimers.set(
        normalized,
        setTimeout(() => {
          debounceTimers.delete(normalized);
          onChange(normalized);
        }, this.watchDebounceMs),
      );
    });
    return {
      dispose: () => {
        for (const timer of debounceTimers.values()) {
          clearTimeout(timer);
        }
        debounceTimers.clear();
        watcher.close();
      },
    };
  }
}
