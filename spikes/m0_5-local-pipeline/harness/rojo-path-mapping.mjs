// SyncTeam — mapeamento puro instância ↔ caminho de disco na convenção Rojo.
//
// Módulo sem I/O e sem estado: só recebe dados e devolve dados. Isso permite
// testar a convenção de nomenclatura (que é a parte fácil de errar por
// distração — extensão duplicada, escolha errada de init.*, etc.) sem
// precisar de um Studio nem de um filesystem real.
//
// Regras (ver spikes/m0_5-local-pipeline/README.md e docs/DECISIONS.md —
// "Compatibilidade com o formato de projeto Rojo"):
//
//   - Extensão gravada é sempre `.luau`. Ao interpretar um caminho existente
//     em disco (parseDiskPath), `.lua` também é aceito como alternativa
//     válida (projetos Rojo antigos/mistos usam as duas).
//   - ModuleScript sem filhos      -> `Nome.luau`
//   - ModuleScript com filhos      -> `Nome/init.luau` (+ filhos dentro de `Nome/`)
//   - Script sem filhos            -> `Nome.server.luau`
//   - Script com filhos            -> `Nome/init.server.luau` (+ filhos)
//   - LocalScript sem filhos       -> `Nome.client.luau`
//   - LocalScript com filhos       -> `Nome/init.client.luau` (+ filhos)
//   - Segmentos de caminho que não são eles mesmos um script sincronizado
//     (só agrupam outros) viram diretórios simples — nenhum tratamento
//     especial é necessário para eles: o nome do diretório é só o nome do
//     segmento, com ou sem instância própria.
//
// "path"/"instancePath" nesta API usa sempre "/" como separador de segmentos
// (é o formato que o plugin Studio já manda em `sourceChanged`/`scriptAdded`/
// `listScripts`), nunca separador de SO. Quem grava em disco de verdade
// (bridge-server.mjs) converte para `path.join` na hora de tocar o filesystem.

const KNOWN_CLASS_NAMES = new Set(["Script", "LocalScript", "ModuleScript"]);

// Extensão (sem o ponto inicial) usada tanto para o arquivo "achatado"
// (`Nome.<ext>`) quanto para o arquivo init da pasta (`init.<ext>`) — a única
// diferença entre os dois casos é o nome-base (`Nome` vs `init`), nunca a
// extensão em si.
const EXTENSION_BY_CLASS = {
  ModuleScript: "luau",
  Script: "server.luau",
  LocalScript: "client.luau",
};

const CLASS_BY_SUFFIX_KIND = {
  server: "Script",
  client: "LocalScript",
  plain: "ModuleScript",
};

function assertKnownClassName(className, contextPath) {
  if (!KNOWN_CLASS_NAMES.has(className)) {
    throw new Error(
      `rojo-path-mapping: className desconhecida '${className}' para path '${contextPath}' (esperado Script, LocalScript ou ModuleScript)`
    );
  }
}

/**
 * Decide qual sufixo de nome de arquivo bate com `filename`, tentando do mais
 * específico (`.server.`/`.client.`) para o mais genérico (`.lua`/`.luau`
 * simples) — nessa ordem, porque um arquivo `Foo.server.luau` também bate no
 * padrão genérico `.+\.(lua|luau)$` se ele for testado primeiro.
 *
 * Retorna `{ base, kind }` (kind: "server" | "client" | "plain") ou `null`
 * se `filename` não termina em `.lua`/`.luau`.
 */
function matchFilename(filename) {
  let m = filename.match(/^(.*)\.server\.(lua|luau)$/i);
  if (m) return { base: m[1], kind: "server" };
  m = filename.match(/^(.*)\.client\.(lua|luau)$/i);
  if (m) return { base: m[1], kind: "client" };
  m = filename.match(/^(.*)\.(lua|luau)$/i);
  if (m) return { base: m[1], kind: "plain" };
  return null;
}

/**
 * Calcula o layout em disco (convenção Rojo) para um conjunto de scripts.
 *
 * @param {Array<{path: string, className: "Script"|"LocalScript"|"ModuleScript"}>} entries
 *   `path` usa "/" como separador de segmentos. Um entry com path "Foo/Bar"
 *   é filho do segmento "Foo" (que pode ou não ser, ele próprio, um entry —
 *   se não for, "Foo" é só uma pasta organizacional).
 * @returns {Array<{instancePath: string, diskPath: string, isInit: boolean}>}
 *   `diskPath` é relativo, sempre com "/" como separador, sem extensão
 *   duplicada. A ordem do array de saída corresponde à ordem de `entries`.
 * @throws {Error} se dois entries diferentes produzirem o mesmo `diskPath`
 *   (comparação case-insensitive, pois o disco de destino real é Windows/NTFS
 *   — ver `.claude/rules/typescript.md`). Isso indica um estado inconsistente
 *   (ex.: dois scripts cujo nome difere só em maiúsculas/minúsculas) e nunca
 *   deve ser resolvido silenciosamente sobrescrevendo um pelo outro.
 */
export function computeLayout(entries) {
  const results = [];
  const diskPathOwners = new Map(); // diskPath em minúsculas -> instancePath original

  for (const entry of entries) {
    const { path: instancePath, className } = entry;
    assertKnownClassName(className, instancePath);

    const hasChildren = entries.some((other) => other.path.startsWith(`${instancePath}/`));
    const segments = instancePath.split("/");
    const ext = EXTENSION_BY_CLASS[className];
    const baseName = hasChildren ? "init" : segments[segments.length - 1];
    const dirSegments = hasChildren ? segments : segments.slice(0, -1);
    const diskPath = [...dirSegments, `${baseName}.${ext}`].join("/");

    const dedupeKey = diskPath.toLowerCase();
    const owner = diskPathOwners.get(dedupeKey);
    if (owner !== undefined && owner !== instancePath) {
      throw new Error(
        `computeLayout: colisão de diskPath '${diskPath}' entre '${owner}' e '${instancePath}' — ` +
          `estado inconsistente (provavelmente dois scripts cujo nome difere só em maiúsculas/minúsculas)`
      );
    }
    diskPathOwners.set(dedupeKey, instancePath);

    results.push({ instancePath, diskPath, isInit: hasChildren });
  }

  return results;
}

/**
 * Interpreta um caminho relativo em disco (separador "/") de volta para
 * `{instancePath, className, isInit}`, ou `null` se `relativeDiskPath` não
 * corresponder a nenhum padrão reconhecido da convenção Rojo (extensão
 * ausente/errada, ou arquivo `init.*` na raiz sem pasta pai).
 *
 * Aceita tanto `.luau` quanto `.lua` como extensão válida na entrada (só a
 * escrita em disco feita por `computeLayout`/pelo bridge é sempre `.luau`).
 *
 * @param {string} relativeDiskPath
 * @returns {{instancePath: string, className: "Script"|"LocalScript"|"ModuleScript", isInit: boolean} | null}
 */
export function parseDiskPath(relativeDiskPath) {
  if (typeof relativeDiskPath !== "string" || relativeDiskPath.length === 0) {
    return null;
  }

  const normalized = relativeDiskPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  const filename = segments[segments.length - 1];
  const match = matchFilename(filename);
  if (!match || match.base.length === 0) {
    return null;
  }

  const className = CLASS_BY_SUFFIX_KIND[match.kind];

  if (match.base === "init") {
    const parentSegments = segments.slice(0, -1);
    if (parentSegments.length === 0) {
      // init.* direto na raiz: não há pasta pai para ser a instância dona
      // deste Source, então não é um caminho reconhecível.
      return null;
    }
    return { instancePath: parentSegments.join("/"), className, isInit: true };
  }

  const instanceSegments = [...segments.slice(0, -1), match.base];
  return { instancePath: instanceSegments.join("/"), className, isInit: false };
}
