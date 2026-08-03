// PID file do daemon (`~/.syncteam/syncteam.pid`) — JSON `{pid, port,
// projectDir}`. Mesmo espírito do lockfile de posse de porta
// (`vscode-extension/src/sync/PortOwnership.ts::PortLockInfo`), mas para o
// daemon INTEIRO (não por porta) — é o que `syncteam stop` e uma futura
// invocação de `syncteam start` usam para saber se já existe um daemon
// rodando, e onde.

import fs from "node:fs/promises";

export interface PidFileInfo {
  pid: number;
  port: number;
  projectDir: string;
}

function isValid(value: unknown): value is PidFileInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PidFileInfo).pid === "number" &&
    typeof (value as PidFileInfo).port === "number" &&
    typeof (value as PidFileInfo).projectDir === "string"
  );
}

/**
 * `null` para: arquivo ausente, JSON malformado, ou formato inesperado
 * (campo faltando/tipo errado) — nunca lança. Mesmo padrão de
 * `PortOwnership.ts::readPortLock`.
 */
export async function readPidFile(pidFilePath: string): Promise<PidFileInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(pidFilePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePidFile(pidFilePath: string, info: PidFileInfo): Promise<void> {
  await fs.writeFile(pidFilePath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

/** Remove o PID file, se existir. `ENOENT` é esperado/ok (idempotente); qualquer outro erro é relançado. */
export async function removePidFile(pidFilePath: string): Promise<void> {
  try {
    await fs.unlink(pidFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
