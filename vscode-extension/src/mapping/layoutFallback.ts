// SyncTeam — onde pendurar uma instância que NENHUM ponto de montagem cobre.
//
// O problema, medido no ModuxTemplate: o `rogen` deriva o `default.project.json`
// da estrutura de pastas e emite um ponto de montagem POR FEATURE E LADO —
// `ServerScriptService.server.Vital` <- `src/Vital/server`, e assim por diante.
// Não existe montagem para `ServerScriptService.server` sozinho.
//
// Consequência: um script criado no Studio dentro de uma feature que já existe
// cai certo, mas uma FEATURE NOVA nascida no Studio não casa com prefixo
// nenhum. `computeFullLayout` a joga em `ignoredPaths`, o arquivo nunca chega
// ao disco, e o único sinal é uma linha de `info` no Output da extensão — que
// ninguém está olhando enquanto cria pasta no Studio.
//
// E é galinha-e-ovo: o rogen não pode mapear a pasta porque ela não existe no
// disco, e o disco não a ganha porque não há mapeamento. Cada um espera o
// outro.
//
// Este módulo quebra o impasse lendo uma DECLARAÇÃO do projeto, em vez de
// adivinhar a convenção do rogen. A diferença importa: inferir acoplaria o
// SyncTeam a uma regra que vive cravada dentro de outra ferramenta, e que
// pode mudar sem aviso.
//
// ## Fallback, não fonte de verdade
//
// Isto só é consultado quando nenhum ponto de montagem casa. Existindo
// montagem, ela ganha SEMPRE. A distinção é o que impede este arquivo de
// virar uma terceira descrição concorrente do mesmo layout (o rogen crava a
// regra, o project file a materializa, e isto aqui só responde "e quando não
// há nada ainda?"). Na segunda vez o mount já existe de verdade e este
// módulo deixa de ser consultado para aquele caminho.
//
// Módulo puro: sem I/O, sem import de vscode — mesmo padrão de
// rojoPathMapping.ts e wallyPackageFolders.ts.

export interface LayoutDeclaration {
  /** Pasta de origem, relativa à raiz do projeto (ex.: "src"). */
  root: string;
  /**
   * Prefixo de DataModel de cada lado, "/" como separador. A chave é o nome
   * que o lado tem NO DISCO (ex.: "server"), o valor é onde ele aparece na
   * árvore (ex.: "ServerScriptService/server").
   */
  sides: Record<string, string>;
}

export interface FallbackPlacement {
  /** Caminho de disco da PASTA da feature (ex.: "src/NovaFeature/server"). */
  featureDir: string;
  /**
   * Caminho de DataModel dessa mesma pasta (ex.:
   * "ServerScriptService/server/NovaFeature"). Junto com `featureDir` forma
   * exatamente o par que um ponto de montagem teria, e é por isso que quem
   * chama pode tratar a colocação como um mount sintético e reaproveitar o
   * `computeLayout` — inclusive a regra de `init.luau` para quem tem filhos.
   */
  featureDataModelPath: string;
  /** Caminho de instância relativo a essa pasta (ex.: "NovoService"). */
  relativeInstancePath: string;
  /** Nome do lado que casou, útil para log. */
  side: string;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Lê a declaração de layout de um `syncteam.json` já parseado.
 *
 * Devolve `null` quando o arquivo não traz `layout` — projeto sem declaração
 * é o caso normal e não é erro; ele simplesmente não ganha o fallback.
 *
 * @throws {Error} se `layout` existir mas estiver malformado. Declaração
 *   quebrada é pior que ausente: ela dá a impressão de que o fallback está
 *   configurado quando não está, e o sintoma voltaria a ser um arquivo que
 *   não chega ao disco sem ninguém avisar.
 */
export function parseLayoutDeclaration(config: unknown): LayoutDeclaration | null {
  if (typeof config !== "object" || config === null) {
    return null;
  }
  const layout = (config as { layout?: unknown }).layout;
  if (layout === undefined) {
    return null;
  }
  if (typeof layout !== "object" || layout === null) {
    throw new Error("syncteam.json: 'layout' precisa ser um objeto");
  }

  const { root, sides } = layout as { root?: unknown; sides?: unknown };
  if (typeof root !== "string" || trimSlashes(normalizeSlashes(root)) === "") {
    throw new Error("syncteam.json: 'layout.root' precisa ser um caminho não vazio (ex.: \"src\")");
  }
  if (typeof sides !== "object" || sides === null || Array.isArray(sides)) {
    throw new Error("syncteam.json: 'layout.sides' precisa ser um objeto { lado: caminhoNaArvore }");
  }

  const parsed: Record<string, string> = {};
  for (const [side, treePath] of Object.entries(sides as Record<string, unknown>)) {
    if (typeof treePath !== "string" || trimSlashes(normalizeSlashes(treePath)) === "") {
      throw new Error(`syncteam.json: 'layout.sides.${side}' precisa ser um caminho não vazio`);
    }
    if (trimSlashes(side) === "") {
      throw new Error("syncteam.json: 'layout.sides' tem uma chave vazia");
    }
    parsed[side] = trimSlashes(normalizeSlashes(treePath));
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("syncteam.json: 'layout.sides' está vazio");
  }

  return { root: trimSlashes(normalizeSlashes(root)), sides: parsed };
}

/**
 * Onde colocar, no disco, uma instância que nenhum ponto de montagem cobre.
 *
 * Casa o prefixo de lado mais LONGO — `StarterPlayer/StarterPlayerScripts/client`
 * tem que ganhar de um eventual `StarterPlayer`, senão a feature nasceria um
 * nível acima e a próxima passada do rogen a mapearia no lugar errado.
 *
 * Devolve `null` quando nenhum lado casa, ou quando o que sobra do caminho
 * não tem pelo menos dois segmentos: com um só, o que existe é a pasta da
 * feature, não um script dentro dela, e criar pasta vazia não ajudaria em
 * nada — o rogen só enxerga pasta que já tem `.luau` dentro.
 */
export function resolveFallbackPlacement(
  dataModelPath: string,
  declaration: LayoutDeclaration,
): FallbackPlacement | null {
  const path = trimSlashes(normalizeSlashes(dataModelPath));

  let bestSide: string | null = null;
  let bestPrefix = "";
  for (const [side, treePath] of Object.entries(declaration.sides)) {
    const matches = path === treePath || path.startsWith(`${treePath}/`);
    if (matches && treePath.length > bestPrefix.length) {
      bestSide = side;
      bestPrefix = treePath;
    }
  }
  if (bestSide === null) {
    return null;
  }

  const remainder = trimSlashes(path.slice(bestPrefix.length));
  const segments = remainder.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const [feature, ...rest] = segments;
  return {
    featureDir: `${declaration.root}/${feature}/${bestSide}`,
    featureDataModelPath: `${bestPrefix}/${feature}`,
    relativeInstancePath: rest.join("/"),
    side: bestSide,
  };
}

/**
 * Lados declarados que não correspondem a montagem nenhuma de verdade.
 *
 * A declaração repete uma regra que o rogen já conhece, e duas cópias
 * divergem. Se alguém mudar a convenção lá e esquecer daqui, o SyncTeam
 * passaria a criar feature no lugar errado — em silêncio, que é exatamente o
 * defeito que este módulo existe para corrigir.
 *
 * Conferir na partida faz a divergência aparecer no primeiro boot, e não no
 * primeiro arquivo perdido. Um lado é considerado válido se algum ponto de
 * montagem começa com ele: é o que prova que aquele prefixo de árvore existe
 * no projeto de verdade.
 */
export function findUnbackedSides(
  declaration: LayoutDeclaration,
  mountDataModelPaths: readonly string[],
): string[] {
  const mounts = mountDataModelPaths.map((path) => trimSlashes(normalizeSlashes(path)));
  const unbacked: string[] = [];
  for (const [side, treePath] of Object.entries(declaration.sides)) {
    const backed = mounts.some((mount) => mount === treePath || mount.startsWith(`${treePath}/`));
    if (!backed) {
      unbacked.push(side);
    }
  }
  return unbacked;
}
