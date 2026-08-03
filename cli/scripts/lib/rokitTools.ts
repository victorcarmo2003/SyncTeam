// Localiza binários instalados via Rokit em `~/.rokit/tool-storage/<author>/<tool>/<version>/`
// (mesmo layout documentado em `.claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md`,
// "organização local de instalação"). Espelha a busca já usada em
// `Tools/build-and-deploy-plugin.sh` (`ls .../*/rojo.exe | sort -V | tail -n1`),
// mas com comparação de versão semver-aware de verdade em vez de depender do
// acidente de `sort -V` comparar o path inteiro (inclusive o separador após
// o número da versão) — ver nota em `cli/README.md`.

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RokitToolCandidate {
  version: string;
  binPath: string;
}

/** Compara duas versões `major.minor.patch[-prerelease]`. Prerelease sempre
 * conta como MENOR que a mesma versão sem prerelease (ex.: `7.7.0-rc.1` <
 * `7.7.0`), ao contrário do que `sort -V` faria comparando as strings cruas. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);

  const partsA = coreA.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const partsB = coreB.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1; // release > prerelease
  if (preB === undefined) return -1;
  return preA < preB ? -1 : preA > preB ? 1 : 0;
}

function splitVersion(v: string): [string, string | undefined] {
  const dashIndex = v.indexOf("-");
  if (dashIndex === -1) return [v, undefined];
  return [v.slice(0, dashIndex), v.slice(dashIndex + 1)];
}

/**
 * Procura `toolName[.exe]` sob QUALQUER autor em
 * `~/.rokit/tool-storage/<qualquer-autor>/<toolName>/<qualquer-versão>/`
 * (mesmo wildcard de autor usado pelo script shell de referência, porque o
 * autor varia por ferramenta — ex. `rojo-rbx/rojo` vs `upliftgames/wally`) e
 * devolve o caminho da versão mais alta instalada, ou `null` se nada for
 * encontrado (chamador decide o fallback, ex. tentar `toolName` via PATH).
 */
export function findRokitTool(toolName: string): RokitToolCandidate | null {
  const toolStorageRoot = path.join(os.homedir(), ".rokit", "tool-storage");
  if (!existsSync(toolStorageRoot)) return null;

  const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;
  const candidates: RokitToolCandidate[] = [];

  for (const authorEntry of safeReaddir(toolStorageRoot)) {
    const toolDir = path.join(toolStorageRoot, authorEntry, toolName);
    if (!existsSync(toolDir)) continue;
    for (const version of safeReaddir(toolDir)) {
      const binPath = path.join(toolDir, version, exeName);
      if (existsSync(binPath)) {
        candidates.push({ version, binPath });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(a.version, b.version));
  return candidates[candidates.length - 1] ?? null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Resolve o caminho de um binário: Rokit primeiro, PATH do sistema como
 * fallback (spawn vai falhar com erro claro se nem isso existir). */
export function resolveToolPath(toolName: string): string {
  const fromRokit = findRokitTool(toolName);
  if (fromRokit) return fromRokit.binPath;
  return toolName;
}
