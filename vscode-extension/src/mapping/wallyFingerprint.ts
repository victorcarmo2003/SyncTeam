// SyncTeam — impressão digital do `wally.toml`, para dois devs saberem que
// divergiram.
//
// Por que uma impressão digital e não o arquivo: `Packages/`,
// `ServerPackages/` e `DevPackages/` ficam fora do sync de propósito (ver
// wallyPackageFolders.ts). Sincronizar o manifesto sem os pacotes só trocaria
// um estado inconsistente por outro — o colega teria a linha nova no
// `wally.toml` e continuaria sem a pasta. O que precisa atravessar é só a
// informação de que os dois lados NÃO batem; instalar é decisão de quem
// recebe o aviso.
//
// Módulo puro, sem I/O: recebe o texto e devolve a string. Mesmo padrão de
// rojoPathMapping.ts e layoutFallback.ts.

import { createHash } from "node:crypto";

/**
 * Seções do `wally.toml` que descrevem dependência. Mudança em `[package]`
 * (nome, versão do próprio projeto, realm) não afeta o que precisa estar
 * instalado na máquina do colega, e incluí-la faria o aviso disparar por
 * um bump de versão do jogo — alarme falso na cara de todo mundo.
 */
const DEPENDENCY_SECTIONS = new Set(["dependencies", "server-dependencies", "dev-dependencies"]);

/**
 * Normaliza o `wally.toml` para as linhas de dependência que importam, e
 * devolve um hash curto delas.
 *
 * Normalizar antes de hashear é o ponto: hash do arquivo cru dispararia
 * aviso por comentário, ordem de linha, espaço em branco e fim de linha
 * (CRLF contra LF é garantido num time com Windows e macOS). Nada disso muda
 * o que precisa estar instalado, e um aviso que grita à toa é um aviso que
 * as pessoas aprendem a ignorar.
 *
 * Parser deliberadamente pequeno: só cabeçalho de seção e `chave = valor`.
 * O objetivo não é entender TOML, é produzir a MESMA string nas duas
 * máquinas quando as dependências forem as mesmas.
 */
export function computeWallyFingerprint(tomlText: string): string {
  let section = "";
  const linhas: string[] = [];

  for (const raw of tomlText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") {
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!DEPENDENCY_SECTIONS.has(section)) {
      continue;
    }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (!pair) {
      continue;
    }
    const chave = pair[1].trim();
    // Aspas fora: `"a/b@1.0"` e `'a/b@1.0'` são a mesma dependência, e um dev
    // trocar de aspas não pode acordar o aviso na máquina do outro.
    const valor = pair[2].trim().replace(/^["']|["']$/g, "");
    linhas.push(`${section}/${chave}=${valor}`);
  }

  // Ordenar: mover uma linha de lugar no arquivo não muda o que está
  // instalado, e sem isto cada reordenação viraria uma divergência.
  linhas.sort();

  if (linhas.length === 0) {
    // Projeto sem dependência nenhuma é um estado legítimo, e precisa de uma
    // impressão digital ESTÁVEL — devolver "" faria o outro lado tratar como
    // "ainda não publicou" e nunca comparar.
    return "wally:vazio";
  }
  return `wally:${createHash("sha256").update(linhas.join("\n")).digest("hex").slice(0, 16)}`;
}
