// Config PRÓPRIA do CLI (`~/.syncteam/config.json`) — hoje só `{ port }`.
// Reusa `parsePortInput`/`MIN_PORT`/`MAX_PORT` de
// `vscode-extension/src/util/port.ts` (módulo puro, zero import, sem
// `vscode`) em vez de reimplementar a mesma validação de porta — mesma régua
// de "porte, não reinvente" aplicada ao resto desta tarefa
// (SyncServer/SyncTeamService/SyncBridge/NodeDiskIO/PortOwnership).

import fs from "node:fs/promises";
import { parsePortInput } from "../../../vscode-extension/src/util/port.js";

export { MIN_PORT, MAX_PORT } from "../../../vscode-extension/src/util/port.js";

/**
 * Porta default quando `~/.syncteam/config.json` ainda não existe — mesmo
 * default de `plugin/src/Config.luau::Config.DEFAULT_PORT` e de
 * `syncteam.port` (`vscode-extension/package.json`), para o CLI concordar
 * com o resto do produto de fábrica (nenhum dos três decide um número
 * diferente sem o usuário mexer em nada).
 */
export const DEFAULT_PORT = 1400;

export interface CliConfig {
  port: number;
}

/**
 * Lê `configFile`. Arquivo ausente (ENOENT), JSON malformado, ou campo
 * `port` inválido degradam para o default — nunca lança. Um config
 * corrompido não deveria impedir `syncteam start` de funcionar com o
 * comportamento de fábrica.
 */
export async function readCliConfig(configFile: string): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    return { port: DEFAULT_PORT };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const rawPort = (parsed as { port?: unknown } | null)?.port;
    const port = parsePortInput(rawPort === undefined || rawPort === null ? null : String(rawPort));
    return { port: port ?? DEFAULT_PORT };
  } catch {
    return { port: DEFAULT_PORT };
  }
}

export async function writeCliConfig(configDir: string, configFile: string, config: CliConfig): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
