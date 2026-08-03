// SyncTeam — gera a fonte de ícone (WOFF) usada pela contribution point
// `contributes.icons` do package.json, a partir de `resources/icon.svg`
// (fonte única — nada aqui duplica o SVG no repo, a cópia usada como input
// do fantasticon é criada e regenerada por este script a cada build).
//
// Por que uma fonte de ícone: `vscode.StatusBarItem.text` só aceita texto +
// sintaxe de codicon `$(nome)` (ThemeIcon) — não existe caminho de SVG cru.
// Pra ter um ícone customizado utilizável como `$(nome)`, é obrigatório
// declarar `contributes.icons` apontando pra um arquivo de fonte (glifo),
// nunca SVG solto (doc oficial: "VS Code requires the icons to be defined
// as glyph in an icon font"). Ver
// .claude/research/2026-08-03-statusbaritem-custom-icon-svg.md para a
// pesquisa completa. `fantasticon` é a mesma ferramenta usada pelo próprio
// microsoft/vscode-codicons para gerar a fonte de ícones do VS Code.
//
// Rodado via "prebuild" (package.json) — dispara sozinho em `npm run build`,
// sem passo manual extra.
//
// BUG DO FANTASTICON@4.1.0 NO WINDOWS (confirmado isolado, 2026-08-03 — ver
// .claude/agent-memory/ui-dev.md e docs/DECISIONS.md pra reprodução
// completa): a função interna `loadPaths` monta o glob de busca dos SVGs com
// `path.join(dir, "**/*.svg")`. No Windows, `path.join` usa `\` como
// separador — e o pacote `glob@13` (dependência direta do fantasticon)
// trata `\` como caractere de ESCAPE dentro do padrão, não como separador de
// path. Resultado: o glob nunca casa nada e o fantasticon falha com "No SVGs
// found" mesmo com o arquivo existindo de verdade. Confirmado que isso SÓ
// acontece na build CJS (`require("fantasticon")`, a que este script usa de
// propósito) — a build ESM do pacote não respeita o monkeypatch abaixo
// (bundla sua própria referência a `path`), então NÃO trocar este arquivo
// para ESM/`import` sem testar de novo.
//
// Workaround: durante a chamada a `generateFonts`, sobrescrever `path.join`
// pra sempre devolver `/` como separador (glob aceita `/` em qualquer SO,
// e `fs`/APIs do Node aceitam path com `/` mesmo no Windows). Restaurado no
// `finally` pra não vazar o monkeypatch pro resto do processo. Se uma
// versão futura do fantasticon corrigir isso, dá pra remover — rodar de
// novo o teste isolado documentado na memória antes de tirar.

"use strict";

const fs = require("fs");
const path = require("path");
const { generateFonts } = require("fantasticon");

const RESOURCES_DIR = path.join(__dirname, "..", "resources");
const SOURCE_SVG = path.join(RESOURCES_DIR, "icon.svg");
const FONT_SRC_DIR = path.join(RESOURCES_DIR, "icon-font-src");
const FONT_NAME = "syncteam-icons";
const GLYPH_NAME = "syncteam-logo";

async function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    throw new Error(`SVG de origem não encontrado: ${SOURCE_SVG}`);
  }

  // Input do fantasticon precisa ser uma PASTA de SVGs (1 arquivo = 1 glifo).
  // Regenerada a cada build a partir de icon.svg — nunca editar o arquivo
  // dentro de icon-font-src/ diretamente, ele é sobrescrito sempre.
  fs.mkdirSync(FONT_SRC_DIR, { recursive: true });
  fs.copyFileSync(SOURCE_SVG, path.join(FONT_SRC_DIR, `${GLYPH_NAME}.svg`));

  const originalJoin = path.join;
  path.join = (...args) => originalJoin(...args).split(path.sep).join("/");
  let result;
  try {
    result = await generateFonts({
      inputDir: FONT_SRC_DIR,
      outputDir: RESOURCES_DIR,
      name: FONT_NAME,
      fontTypes: ["woff"],
      // "json" só pra este script conferir/logar o codepoint real gerado —
      // não é usado em runtime pela extensão (excluído do pacote via
      // .vscodeignore, junto de icon-font-src/).
      assetTypes: ["json"],
      normalize: true,
      fontHeight: 300,
    });
  } finally {
    path.join = originalJoin;
  }

  const glyphCount = Object.keys(result.assetsIn).length;
  if (glyphCount !== 1 || !result.assetsIn[GLYPH_NAME]) {
    throw new Error(
      `Esperava exatamente 1 glifo ("${GLYPH_NAME}"), encontrou: ${Object.keys(result.assetsIn).join(", ")}`,
    );
  }

  const codepointsPath = path.join(RESOURCES_DIR, `${FONT_NAME}.json`);
  const codepoints = JSON.parse(fs.readFileSync(codepointsPath, "utf8"));
  const codepoint = codepoints[GLYPH_NAME];
  if (typeof codepoint !== "number") {
    throw new Error(`Codepoint de "${GLYPH_NAME}" não encontrado em ${codepointsPath}`);
  }
  const hex = codepoint.toString(16).toUpperCase().padStart(4, "0");

  console.log(`[SyncTeam] Fonte de ícone gerada: resources/${FONT_NAME}.woff`);
  console.log(
    `[SyncTeam] Glifo "${GLYPH_NAME}" -> fontCharacter "\\${hex}" (confira contra contributes.icons no package.json — se divergir, o build não falha sozinho, o ícone só aparece quebrado no VS Code).`,
  );
}

main().catch((err) => {
  console.error("[SyncTeam] Falha ao gerar a fonte de ícone (contributes.icons):", err);
  process.exitCode = 1;
});
