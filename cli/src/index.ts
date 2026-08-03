#!/usr/bin/env bun
// Entrypoint do `syncteam-cli`. Único arquivo do pacote que usa APIs
// específicas do Bun (`Bun.file`, import `with { type: "file" }`) — todo o
// resto (`src/commands/`, `src/plugin/`, `src/daemon/`, `src/config/`) é
// Node puro e testável com vitest.
//
// IMPORTANTE (build): `src/assets/SyncTeam.rbxm` (gerado por
// `scripts/build-plugin-asset.ts`) e `src/assets/syncteam.vsix` (gerado por
// `scripts/build-extension-asset.ts`) precisam existir no disco ANTES de
// `bun run src/index.ts` / `bun build --compile` funcionarem (os imports
// abaixo não resolvem sem os arquivos físicos). Ver `cli/README.md`.

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import pluginRbxmPath from "./assets/SyncTeam.rbxm" with { type: "file" };
import extensionVsixPath from "./assets/syncteam.vsix" with { type: "file" };
import { runPluginInstall, type PluginInstallIO, type PluginInstallLogger } from "./commands/pluginInstall.js";
import { runExtensionInstall, type ExtensionInstallIO } from "./commands/extensionInstall.js";
import { runPortCommand } from "./commands/port.js";
import { runStartCommand } from "./commands/start.js";
import { runStopCommand } from "./commands/stop.js";
import { runDaemonChild } from "./daemon/engine.js";
import { resolveSyncteamPaths } from "./config/paths.js";
import { readCliConfig } from "./config/cliConfig.js";
import { promptYesNo } from "./prompt/confirmPrompt.js";
import { createConsoleLogger } from "../../vscode-extension/src/util/logger.js";
import pkg from "../package.json" with { type: "json" };

// Lida direto de package.json (import JSON é inlinado pelo bundler em tempo
// de build, não precisa de leitura de arquivo em runtime) — evita o valor
// ficar desincronizado da versão real a cada bump (achado real: existia uma
// constante hardcoded aqui que ficou parada em "0.1.0" depois do primeiro
// bump pra 0.2.0, só descoberto rodando `--version` no binário compilado).
const CLI_VERSION = pkg.version;

function printUsage(): void {
  console.log(
    [
      `syncteam-cli ${CLI_VERSION}`,
      "",
      "Uso:",
      "  syncteam plugin install       Instala o plugin SyncTeam na pasta de Plugins do Roblox Studio local.",
      "  syncteam extension install    Instala a extensão SyncTeam no VS Code local (via 'code --install-extension').",
      "  syncteam port <PORTA>         Configura a porta usada por 'start'/'stop' (~/.syncteam/config.json).",
      "  syncteam start [--dir <pasta>] Sobe o motor de sincronização em segundo plano (daemon).",
      "  syncteam stop                 Encerra o daemon subido por 'start'.",
      "  syncteam --version            Mostra a versão do CLI.",
      "  syncteam --help               Mostra esta mensagem.",
      "",
    ].join("\n"),
  );
}

function makePluginInstallLogger(): PluginInstallLogger {
  return {
    info: (message) => console.log(`[SyncTeam CLI] ${message}`),
    error: (message) => console.error(`[SyncTeam CLI] ERRO: ${message}`),
  };
}

function makePluginInstallIO(): PluginInstallIO {
  return {
    readEmbeddedPlugin: async () => {
      const bytes = await Bun.file(pluginRbxmPath).bytes();
      return bytes;
    },
    mkdir: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    fileExists: async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    removeFile: async (filePath) => {
      await fs.rm(filePath, { force: true });
    },
    writeFile: async (filePath, data) => {
      await fs.writeFile(filePath, data);
    },
  };
}

function codeCommand(): string {
  // Shim instalado pelo VS Code no PATH: "code.cmd" no Windows, "code" no
  // resto — confirmado nesta máquina (`code --version` funciona no PATH).
  return process.platform === "win32" ? "code.cmd" : "code";
}

function makeExtensionInstallIO(): ExtensionInstallIO {
  return {
    readEmbeddedExtension: async () => {
      const bytes = await Bun.file(extensionVsixPath).bytes();
      return bytes;
    },
    writeTempFile: async (data) => {
      const tempPath = path.join(os.tmpdir(), `syncteam-${process.pid}-${Date.now()}.vsix`);
      await fs.writeFile(tempPath, data);
      return tempPath;
    },
    removeFile: async (filePath) => {
      await fs.rm(filePath, { force: true });
    },
    runCodeInstall: (vsixPath) =>
      new Promise((resolve, reject) => {
        execFile(
          codeCommand(),
          ["--install-extension", vsixPath, "--force"],
          { windowsHide: true, timeout: 60000, shell: process.platform === "win32" },
          (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          },
        );
      }),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [group, action] = args;

  if (group === "--version" || group === "-v") {
    console.log(CLI_VERSION);
    return;
  }

  if (group === "--help" || group === "-h" || group === undefined) {
    printUsage();
    return;
  }

  if (group === "plugin" && action === "install") {
    const result = await runPluginInstall(
      { platform: process.platform, homedir: os.homedir(), env: process.env },
      makePluginInstallIO(),
      makePluginInstallLogger(),
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (group === "extension" && action === "install") {
    const result = await runExtensionInstall(makeExtensionInstallIO(), makePluginInstallLogger());
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const paths = resolveSyncteamPaths(os.homedir());

  if (group === "port") {
    const result = await runPortCommand(action, paths.configDir, paths.configFile, makePluginInstallLogger());
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (group === "start") {
    // Invocação interna: este processo É o daemon (spawnado por uma
    // invocação anterior de "syncteam start" rodando em foreground) — ver
    // src/commands/start.ts / src/daemon/selfInvocation.ts. Nunca é chamado
    // por um humano diretamente.
    if (action === "--daemon-child") {
      await runDaemonChild(process.env);
      return;
    }

    const logger = createConsoleLogger("[SyncTeam CLI]");
    const dirFlagIndex = args.indexOf("--dir");
    const dirArg = dirFlagIndex !== -1 ? args[dirFlagIndex + 1] : undefined;
    const projectDir = path.resolve(dirArg ?? process.cwd());
    const config = await readCliConfig(paths.configFile);

    const result = await runStartCommand({
      projectDir,
      paths,
      configuredPort: config.port,
      logger,
      confirmKill: promptYesNo,
      execPath: process.execPath,
      argv0: process.argv[0] ?? "",
      argv1: process.argv[1],
    });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (group === "stop") {
    const logger = createConsoleLogger("[SyncTeam CLI]");
    const result = await runStopCommand({ pidFile: paths.pidFile, logger });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.error(`[SyncTeam CLI] ERRO: comando desconhecido: "${args.join(" ")}"`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[SyncTeam CLI] erro inesperado: ${message}`);
  process.exitCode = 1;
});
