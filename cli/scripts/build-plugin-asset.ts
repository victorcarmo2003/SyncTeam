#!/usr/bin/env bun
// Gera `cli/src/assets/SyncTeam.rbxm` a partir de `plugin/` (rojo build),
// PRECISA rodar antes de `bun run src/index.ts` / `bun build --compile` —
// o import `with { type: "file" }` em `src/index.ts` exige o arquivo físico
// no disco (ver `cli/README.md`).
//
// Mesmo entry point (`plugin/default.project.json`) e mesma dependência
// prévia (`wally install`, por causa de `plugin/Packages/` = Vide, usado
// pelo painel de status) que `Tools/build-and-deploy-plugin.sh` já usa para
// o deploy manual em Studio real — este script não duplica lógica nova, só
// aponta a saída para dentro de `cli/src/assets/` em vez da pasta de Plugins
// do Studio.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToolPath } from "./lib/rokitTools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugin");
const OUTPUT_PATH = path.join(CLI_DIR, "src", "assets", "SyncTeam.rbxm");

// Assinatura de arquivo `.rbxm` binário real (não XML/`.rbxmx`) — sanidade
// pós-build sugerida pela própria pesquisa do Bun
// (`.claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md`,
// seção 4) para pegar cedo um `rojo build` que silenciosamente gerou outra
// coisa (ex. arquivo vazio por erro não fatal).
const RBXM_MAGIC = "<roblox!";

function run(command: string, args: string[], cwd: string): void {
  console.log(`[build-plugin-asset] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw new Error(`Falha ao executar "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(" ")}" saiu com código ${result.status ?? "desconhecido"}`);
  }
}

function main(): void {
  if (!existsSync(PLUGIN_DIR)) {
    throw new Error(`Diretório do plugin não encontrado: ${PLUGIN_DIR}`);
  }

  const wallyBin = resolveToolPath("wally");
  const rojoBin = resolveToolPath("rojo");
  console.log(`[build-plugin-asset] wally: ${wallyBin}`);
  console.log(`[build-plugin-asset] rojo:  ${rojoBin}`);

  run(wallyBin, ["install"], PLUGIN_DIR);

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  run(rojoBin, ["build", "-o", OUTPUT_PATH], PLUGIN_DIR);

  if (!existsSync(OUTPUT_PATH)) {
    throw new Error(`rojo build não gerou o arquivo esperado em ${OUTPUT_PATH}`);
  }

  const bytes = readFileSync(OUTPUT_PATH);
  const magic = bytes.subarray(0, RBXM_MAGIC.length).toString("latin1");
  if (magic !== RBXM_MAGIC) {
    throw new Error(
      `Arquivo gerado em ${OUTPUT_PATH} não parece um .rbxm binário válido ` +
        `(assinatura esperada "${RBXM_MAGIC}", encontrado "${magic}").`,
    );
  }

  console.log(`[build-plugin-asset] OK — ${OUTPUT_PATH} (${bytes.length} bytes)`);
}

main();
