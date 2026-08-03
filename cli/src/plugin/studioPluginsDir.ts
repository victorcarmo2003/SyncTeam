// Resolve a pasta de Plugins do Roblox Studio local, por sistema operacional.
// Módulo puro (sem I/O) — recebe plataforma/homedir/env como parâmetros em
// vez de ler `process.*` diretamente, para ser testável sem depender do SO
// real rodando o teste (mesmo padrão de módulo puro + injeção de contexto já
// usado em `vscode-extension/src/mapping/*.ts`).
//
// Usa `path.win32`/`path.posix` (não `path` genérico) deliberadamente: o
// separador correto depende da PLATAFORMA ALVO sendo resolvida (`ctx.platform`),
// não do SO que está rodando o processo atual — os dois só coincidem em
// produção real (binário compilado por plataforma), mas em teste, os dois
// ramos rodam na mesma máquina (regra `.claude/rules/typescript.md`).

import path from "node:path";

export interface PluginsDirContext {
  platform: NodeJS.Platform;
  homedir: string;
  env: Readonly<Record<string, string | undefined>>;
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `Plataforma "${platform}" não é suportada pelo SyncTeam CLI — o Roblox Studio só roda em Windows e macOS (sem suporte Linux).`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Windows: `%LOCALAPPDATA%\Roblox\Plugins` — [Verificado], mesma pasta usada
 * por `Tools/build-and-deploy-plugin.sh` (`PLUGINS_FOLDER`).
 *
 * macOS: `~/Documents/Roblox/Plugins` — [Hipótese confirmada por fonte de
 * terceiros confiável, sem doc oficial]. `.claude/research/2026-08-03-macos-studio-plugins-folder-path.md`:
 * bate com o código-fonte real de `Kampfkarren/roblox-install` (mesmo
 * mecanismo que o próprio Rojo usa para localizar/instalar seu plugin,
 * `RobloxStudio::locate()`), `dirs::document_dir().join("Roblox").join("Plugins")`.
 * Sem confirmação em doc oficial da Roblox nem post de staff no DevForum —
 * só promove a `[Verificado]` puro com teste real num Mac.
 *
 * Linux: não suportado (lança `UnsupportedPlatformError`) — Roblox Studio
 * não roda lá.
 */
export function resolveStudioPluginsDir(ctx: PluginsDirContext): string {
  if (ctx.platform === "win32") {
    const localAppData = ctx.env.LOCALAPPDATA ?? path.win32.join(ctx.homedir, "AppData", "Local");
    return path.win32.join(localAppData, "Roblox", "Plugins");
  }
  if (ctx.platform === "darwin") {
    return path.posix.join(ctx.homedir, "Documents", "Roblox", "Plugins");
  }
  throw new UnsupportedPlatformError(ctx.platform);
}
