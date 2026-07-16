// SyncTeam — convenção de nomes de pastas de pacotes Wally (wally.sh).
//
// Decisão (ver docs/DECISIONS.md, 2026-07-16): scripts vendorizados por Wally
// (`Packages`, `ServerPackages`, `DevPackages`) continuam tendo discovery e
// identidade normais (uuid, listScripts) — o plugin/extensão sabem que eles
// existem — mas ficam de FORA do live-edit-sync contínuo (polling de
// mudança de Source e arbitragem de lease do lado do plugin; propagação de
// ATUALIZAÇÃO de conteúdo nos dois sentidos do lado da extensão). Motivo:
// dois devs podem ter `Packages/` locais divergentes (wally.lock desatualizado
// de um lado) — empurrar Source de pacote vendorizado para o Team Create
// compartilhado alteraria a dependência de todo mundo silenciosamente.
//
// Módulo puro, sem I/O, sem import de vscode — mesmo padrão de
// rojoPathMapping.ts. Contrato de nomes tem que bater EXATAMENTE com o lado
// Luau (luau-dev): "Packages", "ServerPackages", "DevPackages", case-sensitive,
// segmento exato de path (nunca substring).

const EXCLUDED_PACKAGE_FOLDER_NAMES: ReadonlySet<string> = new Set(["Packages", "ServerPackages", "DevPackages"]);

/**
 * `name` é exatamente um nome de pasta de pacotes Wally reconhecido
 * ("Packages", "ServerPackages" ou "DevPackages")? Comparação exata
 * (case-sensitive), nunca substring — "MyPackagesFolder" não conta.
 */
export function isExcludedPackageFolderName(name: string): boolean {
  return EXCLUDED_PACKAGE_FOLDER_NAMES.has(name);
}

/**
 * Algum segmento de `instancePath`/`diskPath` (separado por "/", mesmo formato
 * de rojoPathMapping.ts) é exatamente um nome de pasta de pacotes Wally
 * reconhecido? Usado tanto para `instancePath` (caminho no DataModel, ex.
 * "ServerScriptService/Packages/Foo/Bar") quanto para `diskPath` (caminho
 * relativo em disco, ex. "Packages/Foo/Bar.luau") — os segmentos de diretório
 * são os mesmos nos dois formatos, só o segmento final do diskPath difere
 * (nome de arquivo achatado ou `init.<ext>`).
 *
 * Exemplos: "Packages/Foo/Bar" conta (segmento "Packages" exato). "src/Packages"
 * TAMBÉM conta (segmento "Packages" exato em qualquer posição, não só no
 * início). "MyPackagesFolder" NÃO conta — é um segmento inteiro diferente;
 * substring não é suficiente, precisa ser o segmento completo.
 */
export function isInsideExcludedPackageFolder(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  return path.split("/").some((segment) => isExcludedPackageFolderName(segment));
}
