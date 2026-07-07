// SyncTeam — leitura de `default.project.json` (pontos de montagem `$path`)
// e composição com o mapeador Rojo puro (rojoPathMapping.ts) para traduzir
// entre caminho completo no DataModel (o que o plugin manda, ex.:
// "ServerScriptService/Server/Foo/Bar") e caminho relativo em disco (ex.:
// "src/server/Foo/Bar.luau"), nos dois sentidos.
//
// Módulo sem I/O: recebe o JSON já parseado (quem lê o arquivo é a camada de
// ativação/harness) e devolve dados. Isso mantém a lógica testável com
// node:fs puro, conforme a tarefa pediu.

import { computeLayout, parseDiskPath, type LayoutInputEntry } from "./rojoPathMapping.js";
import type { ScriptClassName } from "../protocol.js";

export interface MountPoint {
  /** Caminho a partir de `game`, "/" como separador (ex.: "ServerScriptService/Server"). */
  dataModelPath: string;
  /** Caminho relativo à pasta do default.project.json, "/" como separador (ex.: "src/server"). */
  diskPath: string;
}

export interface DataModelEntry {
  path: string;
  className: ScriptClassName;
}

export interface FullLayoutEntry {
  dataModelPath: string;
  diskPath: string;
  isInit: boolean;
}

export interface FullLayoutResult {
  layout: FullLayoutEntry[];
  /** Paths que não caem sob nenhum ponto de montagem conhecido — informativo, não erro. */
  ignoredPaths: string[];
}

export interface ResolvedMountForDataModelPath {
  mount: MountPoint;
  /** Path relativo ao mount, "" se o próprio path é a raiz do mount. */
  relativeInstancePath: string;
}

export interface ResolvedMountForDiskPath {
  mount: MountPoint;
  /** Path relativo ao mount, "" se o próprio path é a raiz do mount. */
  relativeDiskPath: string;
}

export interface ResolvedDiskChange {
  dataModelPath: string;
  className: ScriptClassName;
  isInit: boolean;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

/**
 * Extrai os pontos de montagem (`$path`) de um `default.project.json` já
 * parseado. Percorre a árvore recursivamente a partir de `tree`; qualquer
 * nó com `$path` string não vazia é um ponto de montagem, identificado pelo
 * caminho de chaves (não-`$`) percorridas até ele.
 *
 * @throws {Error} se `projectJson` não tiver a forma esperada (`tree` ausente
 *   ou não é objeto) — estado de arquivo de projeto inválido, não deve ser
 *   silenciado.
 */
export function parseMountPoints(projectJson: unknown): MountPoint[] {
  if (typeof projectJson !== "object" || projectJson === null || Array.isArray(projectJson)) {
    throw new Error("parseMountPoints: default.project.json inválido (esperado um objeto)");
  }
  const root = projectJson as Record<string, unknown>;
  const tree = root.tree;
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    throw new Error("parseMountPoints: default.project.json sem campo 'tree' (ou não é objeto)");
  }

  const mountPoints: MountPoint[] = [];

  function walk(node: Record<string, unknown>, segments: string[]): void {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("$")) {
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue;
      }
      const childSegments = [...segments, key];
      const valueObj = value as Record<string, unknown>;
      const rawPath = valueObj.$path;
      if (typeof rawPath === "string" && rawPath.length > 0) {
        mountPoints.push({
          dataModelPath: childSegments.join("/"),
          diskPath: stripTrailingSlash(normalizeSlashes(rawPath)),
        });
      }
      walk(valueObj, childSegments);
    }
  }

  walk(tree as Record<string, unknown>, []);
  return mountPoints;
}

/**
 * Acha o ponto de montagem cujo `dataModelPath` é prefixo de `dataModelPath`
 * (ou igual a ele), escolhendo o prefixo mais específico (mais longo) em
 * caso de pontos de montagem aninhados. Comparação exata (case-sensitive) —
 * nomes de Instance no Roblox são sensíveis a caixa, diferente de paths de
 * disco no Windows.
 */
export function resolveMountForDataModelPath(
  dataModelPath: string,
  mountPoints: MountPoint[],
): ResolvedMountForDataModelPath | null {
  let best: MountPoint | null = null;
  for (const mount of mountPoints) {
    const isMatch = dataModelPath === mount.dataModelPath || dataModelPath.startsWith(`${mount.dataModelPath}/`);
    if (isMatch && (best === null || mount.dataModelPath.length > best.dataModelPath.length)) {
      best = mount;
    }
  }
  if (best === null) {
    return null;
  }
  const relativeInstancePath =
    dataModelPath === best.dataModelPath ? "" : dataModelPath.slice(best.dataModelPath.length + 1);
  return { mount: best, relativeInstancePath };
}

/**
 * Acha o ponto de montagem cujo `diskPath` é prefixo de `diskPath` (ou igual
 * a ele), escolhendo o prefixo mais específico em caso de aninhamento.
 * Comparação **case-insensitive** (regra de .claude/rules/typescript.md —
 * Windows/NTFS não distingue caixa).
 */
export function resolveMountForDiskPath(diskPath: string, mountPoints: MountPoint[]): ResolvedMountForDiskPath | null {
  const normalized = normalizeSlashes(diskPath);
  const normalizedLower = normalized.toLowerCase();
  let best: MountPoint | null = null;
  for (const mount of mountPoints) {
    const mountLower = mount.diskPath.toLowerCase();
    const isMatch = normalizedLower === mountLower || normalizedLower.startsWith(`${mountLower}/`);
    if (isMatch && (best === null || mount.diskPath.length > best.diskPath.length)) {
      best = mount;
    }
  }
  if (best === null) {
    return null;
  }
  const relativeDiskPath = normalized.length === best.diskPath.length ? "" : normalized.slice(best.diskPath.length + 1);
  return { mount: best, relativeDiskPath };
}

/**
 * Composição DataModel -> disco: agrupa `entries` por ponto de montagem,
 * calcula o layout Rojo (computeLayout) dentro de cada grupo usando o path
 * relativo ao mount, e reconstrói o `diskPath` completo prefixando com
 * `mount.diskPath`. Entradas fora de qualquer ponto de montagem (ou que
 * caem exatamente na raiz de um mount, o que não é um script válido) vão
 * para `ignoredPaths` — informativo, nunca erro.
 *
 * @throws {Error} propagado de `computeLayout` se houver colisão de diskPath
 *   dentro do mesmo ponto de montagem — estado inconsistente, não deve ser
 *   engolido silenciosamente.
 */
export function computeFullLayout(entries: DataModelEntry[], mountPoints: MountPoint[]): FullLayoutResult {
  const byMount = new Map<MountPoint, LayoutInputEntry[]>();
  const ignoredPaths: string[] = [];

  for (const entry of entries) {
    const resolved = resolveMountForDataModelPath(entry.path, mountPoints);
    if (resolved === null) {
      ignoredPaths.push(entry.path);
      continue;
    }
    if (resolved.relativeInstancePath === "") {
      // O próprio ponto de montagem não é um script sincronizável.
      ignoredPaths.push(entry.path);
      continue;
    }
    const group = byMount.get(resolved.mount) ?? [];
    group.push({ path: resolved.relativeInstancePath, className: entry.className });
    byMount.set(resolved.mount, group);
  }

  const layout: FullLayoutEntry[] = [];
  for (const [mount, group] of byMount) {
    const relativeLayout = computeLayout(group);
    for (const item of relativeLayout) {
      layout.push({
        dataModelPath: `${mount.dataModelPath}/${item.instancePath}`,
        diskPath: `${mount.diskPath}/${item.diskPath}`,
        isInit: item.isInit,
      });
    }
  }

  return { layout, ignoredPaths };
}

/**
 * Composição disco -> DataModel: dado um caminho relativo em disco que
 * mudou (ex.: vindo de um watcher de arquivos), acha o ponto de montagem
 * dono, subtrai o prefixo e interpreta o restante com `parseDiskPath`.
 * Retorna `null` se o caminho não cair sob nenhum ponto de montagem, ou não
 * seguir a convenção de nomenclatura Rojo — em ambos os casos é informativo
 * (arquivo fora de escopo), nunca um erro.
 */
export function resolveDataModelPathForDiskChange(
  diskPath: string,
  mountPoints: MountPoint[],
): ResolvedDiskChange | null {
  const resolvedMount = resolveMountForDiskPath(diskPath, mountPoints);
  if (resolvedMount === null) {
    return null;
  }
  const parsed = parseDiskPath(resolvedMount.relativeDiskPath);
  if (parsed === null) {
    return null;
  }
  const dataModelPath =
    parsed.instancePath === "" ? resolvedMount.mount.dataModelPath : `${resolvedMount.mount.dataModelPath}/${parsed.instancePath}`;
  return { dataModelPath, className: parsed.className, isInit: parsed.isInit };
}
