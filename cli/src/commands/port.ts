// Lógica do comando `syncteam port <PORT>` — persiste a porta usada por
// `start`/`stop` em `~/.syncteam/config.json` (ver `../config/paths.ts` para
// o porquê do local). Reusa `parsePortInput`/`MIN_PORT`/`MAX_PORT` de
// `vscode-extension/src/util/port.ts` (módulo puro, já validado, zero
// dependência de `vscode`) em vez de reimplementar a mesma validação.

import { parsePortInput, MIN_PORT, MAX_PORT } from "../../../vscode-extension/src/util/port.js";
import { writeCliConfig, type CliConfig } from "../config/cliConfig.js";

export interface PortCommandLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export type PortCommandResult = { ok: true; port: number } | { ok: false; errorMessage: string };

export async function runPortCommand(
  rawArg: string | undefined,
  configDir: string,
  configFile: string,
  logger: PortCommandLogger,
): Promise<PortCommandResult> {
  const port = parsePortInput(rawArg ?? null);
  if (port === null) {
    const message = `Porta inválida: "${rawArg ?? ""}" — informe um número inteiro entre ${MIN_PORT} e ${MAX_PORT}.`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  const config: CliConfig = { port };
  try {
    await writeCliConfig(configDir, configFile, config);
  } catch (err) {
    const message = `Falha ao salvar a configuração em "${configFile}": ${err instanceof Error ? err.message : String(err)}`;
    logger.error(message);
    return { ok: false, errorMessage: message };
  }

  logger.info(`Porta configurada: ${port} (salva em "${configFile}"). Use "syncteam start" para aplicar.`);
  return { ok: true, port };
}
