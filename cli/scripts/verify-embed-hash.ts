#!/usr/bin/env bun
// Verifica que o .rbxm ESCRITO em disco por `syncteam plugin install`
// (extraído de dentro do binário compilado) é BYTE-IDÊNTICO ao `.rbxm`
// gerado direto por `rojo build` em `src/assets/SyncTeam.rbxm` — ressalva
// que a pesquisa do Bun deixou em aberto (
// .claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md, "Média
// para... nenhum bug conhecido afetando .rbxm... vale validar com um teste
// real").
//
// Só roda de fato contra o binário WINDOWS (único target executável nesta
// máquina) — para macOS, o binário cross-compilado aqui não pode ser
// EXECUTADO nesta máquina Windows; validar em uma máquina macOS real antes
// de assumir o mesmo resultado lá (a lógica de embed do Bun é a mesma, mas
// não foi exercida ponta-a-ponta para esses dois targets nesta sessão).
//
// Uso: bun run scripts/verify-embed-hash.ts

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const SOURCE_RBXM = path.join(CLI_DIR, "src", "assets", "SyncTeam.rbxm");
const COMPILED_EXE = path.join(CLI_DIR, "dist", "staging", "windows-x86_64", "syncteam.exe");

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function main(): void {
  if (process.platform !== "win32") {
    throw new Error(
      "Este script só valida o binário Windows (único compilável+executável nesta máquina). " +
        `Plataforma atual: ${process.platform}.`,
    );
  }
  if (!existsSync(SOURCE_RBXM)) {
    throw new Error(`${SOURCE_RBXM} não existe — rode "bun run build:plugin-asset" primeiro.`);
  }
  if (!existsSync(COMPILED_EXE)) {
    throw new Error(`${COMPILED_EXE} não existe — rode "bun run compile:win-x64" primeiro.`);
  }

  const tempHome = mkdtempSync(path.join(os.tmpdir(), "syncteam-cli-verify-"));
  const fakeLocalAppData = path.join(tempHome, "AppData", "Local");

  try {
    console.log(`[verify-embed-hash] LOCALAPPDATA de teste: ${fakeLocalAppData}`);
    const result = spawnSync(COMPILED_EXE, ["plugin", "install"], {
      env: { ...process.env, LOCALAPPDATA: fakeLocalAppData },
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`Falha ao executar ${COMPILED_EXE}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`${COMPILED_EXE} plugin install saiu com código ${result.status ?? "desconhecido"}`);
    }

    const installedPath = path.join(fakeLocalAppData, "Roblox", "Plugins", "SyncTeam.rbxm");
    if (!existsSync(installedPath)) {
      throw new Error(`Esperava encontrar o arquivo instalado em ${installedPath}, mas não existe.`);
    }

    const sourceHash = sha256(SOURCE_RBXM);
    const installedHash = sha256(installedPath);

    console.log(`[verify-embed-hash] hash do .rbxm gerado por "rojo build" direto: ${sourceHash}`);
    console.log(`[verify-embed-hash] hash do .rbxm extraído do binário compilado: ${installedHash}`);

    if (sourceHash !== installedHash) {
      throw new Error("MISMATCH — o .rbxm embutido no binário difere do gerado por rojo build. Investigar antes de confiar no embed do Bun.");
    }

    console.log("[verify-embed-hash] OK — hashes idênticos (SHA-256).");
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

main();
