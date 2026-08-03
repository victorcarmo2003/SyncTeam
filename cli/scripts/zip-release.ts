#!/usr/bin/env bun
// Zipa o binário já compilado em `dist/staging/<target>/` para
// `dist/syncteam-<target>.zip`, no formato de nome de asset que o Rokit
// reconhece por substring de SO/arch (confirmado em
// .claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md
// — "stylua-linux-x86_64-musl", "rojo-...-win64" como exemplos reais do
// ecossistema). Não publica nada (sem `gh release create`) — só deixa o
// artefato pronto localmente, por decisão explícita da tarefa que criou
// este script.
//
// Uso: bun run scripts/zip-release.ts <windows-x86_64|macos-x86_64|macos-aarch64>

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(CLI_DIR, "dist");
const STAGING_DIR = path.join(DIST_DIR, "staging");

const VALID_TARGETS = ["windows-x86_64", "macos-x86_64", "macos-aarch64"] as const;
type Target = (typeof VALID_TARGETS)[number];

function isValidTarget(value: string): value is Target {
  return (VALID_TARGETS as readonly string[]).includes(value);
}

function main(): void {
  const target = process.argv[2];
  if (target === undefined || !isValidTarget(target)) {
    throw new Error(
      `Uso: bun run scripts/zip-release.ts <${VALID_TARGETS.join("|")}> (recebido: ${JSON.stringify(target)})`,
    );
  }

  const stagingDir = path.join(STAGING_DIR, target);
  if (!existsSync(stagingDir)) {
    throw new Error(
      `Pasta de staging não encontrada: ${stagingDir} — rode "bun run compile:${targetToCompileScript(target)}" primeiro.`,
    );
  }

  const files = readdirSync(stagingDir);
  if (files.length === 0) {
    throw new Error(`Pasta de staging vazia: ${stagingDir}`);
  }

  const zip = new AdmZip();
  for (const file of files) {
    zip.addLocalFile(path.join(stagingDir, file));
  }

  mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, `syncteam-${target}.zip`);
  zip.writeZip(outPath);

  console.log(`[zip-release] OK — ${outPath} (${files.length} arquivo(s): ${files.join(", ")})`);
}

function targetToCompileScript(target: Target): string {
  if (target === "windows-x86_64") return "win-x64";
  if (target === "macos-x86_64") return "macos-x64";
  return "macos-arm64";
}

main();
