#!/usr/bin/env bun
// Gera `cli/src/assets/syncteam.vsix` a partir de `vscode-extension/` (build
// esbuild + empacotamento vsce), PRECISA rodar antes de `bun run
// src/index.ts` / `bun build --compile` — o import `with { type: "file" }`
// em `src/index.ts` exige o arquivo físico no disco (mesmo padrão de
// `build-plugin-asset.ts`/`SyncTeam.rbxm`, ver `cli/README.md`).
//
// Roda `npm run build` (esbuild, gera dist/extension.js) + `npx --yes
// @vscode/vsce package --no-dependencies` (mesmo comando já usado
// manualmente em sessões anteriores para gerar o .vsix de teste, ver
// `.claude/agent-memory/extension-dev.md`) dentro de `../vscode-extension/`,
// depois copia o `.vsix` gerado (nome `<name>-<version>.vsix`, convenção
// default do vsce a partir de `package.json`) para `src/assets/syncteam.vsix`
// — nome FIXO no destino (independente da versão), para o import `with {
// type: "file" }` em `src/index.ts` não precisar mudar a cada bump de versão
// da extensão.

import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "vscode-extension");
const OUTPUT_PATH = path.join(CLI_DIR, "src", "assets", "syncteam.vsix");

function run(command: string, args: string[], cwd: string): void {
  console.log(`[build-extension-asset] $ ${command} ${args.join(" ")}`);
  // shell:true no Windows: "npm"/"npx" são shims .cmd, que exigem
  // interpretação pelo shell para resolver via PATHEXT (diferente de
  // build-plugin-asset.ts, que chama binários .exe resolvidos por caminho
  // completo e não precisa disso). Sem risco de quoting aqui — todos os
  // argumentos passados são tokens simples, sem espaços.
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) {
    throw new Error(`Falha ao executar "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(" ")}" saiu com código ${result.status ?? "desconhecido"}`);
  }
}

function main(): void {
  if (!existsSync(EXTENSION_DIR)) {
    throw new Error(`Diretório da extensão não encontrado: ${EXTENSION_DIR}`);
  }

  const pkgRaw = readFileSync(path.join(EXTENSION_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as { name: string; version: string };
  const generatedVsixName = `${pkg.name}-${pkg.version}.vsix`;
  const generatedVsixPath = path.join(EXTENSION_DIR, generatedVsixName);

  run("npm", ["run", "build"], EXTENSION_DIR);
  run("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies"], EXTENSION_DIR);

  if (!existsSync(generatedVsixPath)) {
    throw new Error(
      `vsce package não gerou o arquivo esperado em ${generatedVsixPath} (confira se "name"/"version" de ` +
        `vscode-extension/package.json mudaram, ou se o vsce mudou a convenção de nome do artefato).`,
    );
  }

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  copyFileSync(generatedVsixPath, OUTPUT_PATH);

  console.log(`[build-extension-asset] OK — ${OUTPUT_PATH} (copiado de ${generatedVsixPath})`);
}

main();
