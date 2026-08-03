// SyncTeam CLI — caminhos de configuração/estado PRÓPRIOS do CLI, distintos
// dos settings da extensão VS Code (`syncteam.port` etc., que vivem em
// `.vscode/settings.json` de um workspace) porque `syncteam-cli` roda
// standalone, sem VS Code aberto (`syncteam start`/`stop` administram um
// daemon headless independente da extensão).
//
// Local escolhido (decisão desta tarefa, documentada em cli/README.md):
// `~/.syncteam/` via `os.homedir()` — convenção simples e cross-platform
// (Windows: `C:\Users\<user>\.syncteam`; macOS/Linux: `~/.syncteam`), mesmo
// padrão de "pasta pontuada na home" usado por várias outras CLIs (`.aws`,
// `.docker`, `.rokit` — este último já usado neste mesmo repo por
// `scripts/lib/rokitTools.ts`). Deliberadamente NÃO usamos uma lib tipo
// `env-paths` (que resolveria `%APPDATA%`/`~/Library/Application
// Support`/XDG por SO) para não adicionar uma dependência nova só para isso —
// `~/.syncteam` sozinho já resolve o requisito (cross-platform, previsível,
// fácil de inspecionar/documentar manualmente).
//
// Módulo puro (sem I/O) — recebe `homedir` injetado, mesmo padrão de
// `src/plugin/studioPluginsDir.ts` (testável sem depender do SO real).

import path from "node:path";

export interface SyncteamPaths {
  /** `~/.syncteam` — raiz de config/estado do CLI. */
  configDir: string;
  /** `~/.syncteam/config.json` — `{ port }` persistido por `syncteam port`. */
  configFile: string;
  /** `~/.syncteam/syncteam.pid` — `{ pid, port, projectDir }` do daemon em execução, escrito por `syncteam start` / removido por `syncteam stop`. */
  pidFile: string;
  /** `~/.syncteam/daemon.log` — stdout/stderr do daemon (`syncteam start` redireciona ambos para cá no spawn). */
  daemonLogFile: string;
  /** `~/.syncteam/port-locks/` — mesmo mecanismo de lockfile de posse de porta de `vscode-extension/src/sync/PortOwnership.ts` (reusado, não reinventado), um arquivo JSON por porta. */
  portLockDir: string;
}

export function resolveSyncteamPaths(homedir: string): SyncteamPaths {
  const configDir = path.join(homedir, ".syncteam");
  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    pidFile: path.join(configDir, "syncteam.pid"),
    daemonLogFile: path.join(configDir, "daemon.log"),
    portLockDir: path.join(configDir, "port-locks"),
  };
}
