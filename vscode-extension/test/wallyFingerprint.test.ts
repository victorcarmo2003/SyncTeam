// A impressão digital existe para disparar um aviso na cara do colega, então
// o que realmente importa aqui é o que NÃO pode mudá-la. Um aviso que grita à
// toa é um aviso que as pessoas aprendem a ignorar, e aí o de verdade passa
// junto.

import { describe, expect, it } from "vitest";
import { computeWallyFingerprint } from "../src/mapping/wallyFingerprint.js";

const BASE = `[package]
name = "hakor/jogo"
version = "0.1.0"
registry = "https://github.com/UpliftGames/wally-index"
realm = "shared"

[dependencies]
Charm = "littensy/charm@0.11.0"
Vide = "centau/vide@0.4.1"

[server-dependencies]
ProfileStore = "ddashdev/profilestore@1.1.0"
`;

describe("computeWallyFingerprint — o que NÃO pode mudar a impressão", () => {
  it("fim de linha", () => {
    // Time com Windows e macOS: CRLF contra LF é garantido, e não muda
    // dependência nenhuma.
    expect(computeWallyFingerprint(BASE.replace(/\n/g, "\r\n"))).toBe(computeWallyFingerprint(BASE));
  });

  it("ordem das linhas", () => {
    const trocado = BASE.replace(
      'Charm = "littensy/charm@0.11.0"\nVide = "centau/vide@0.4.1"',
      'Vide = "centau/vide@0.4.1"\nCharm = "littensy/charm@0.11.0"',
    );
    expect(computeWallyFingerprint(trocado)).toBe(computeWallyFingerprint(BASE));
  });

  it("comentário e espaço em branco", () => {
    const sujo = BASE.replace("[dependencies]", "# as libs do cliente\n[dependencies]  ").replace(
      'Charm = "littensy/charm@0.11.0"',
      '   Charm   =   "littensy/charm@0.11.0"   # grafico',
    );
    expect(computeWallyFingerprint(sujo)).toBe(computeWallyFingerprint(BASE));
  });

  it("tipo de aspas", () => {
    expect(computeWallyFingerprint(BASE.replace(/"centau\/vide@0.4.1"/, "'centau/vide@0.4.1'"))).toBe(
      computeWallyFingerprint(BASE),
    );
  });

  it("versão do próprio projeto", () => {
    // Bump de versão do jogo não muda o que precisa estar instalado na
    // máquina do colega. Incluir `[package]` faria o aviso disparar em todo
    // release.
    expect(computeWallyFingerprint(BASE.replace('version = "0.1.0"', 'version = "9.9.9"'))).toBe(
      computeWallyFingerprint(BASE),
    );
  });
});

describe("computeWallyFingerprint — o que PRECISA mudar a impressão", () => {
  it("dependência nova", () => {
    const comNova = BASE.replace('Vide = "centau/vide@0.4.1"', 'Vide = "centau/vide@0.4.1"\nNet = "sleitnick/net@0.2.0"');
    expect(computeWallyFingerprint(comNova)).not.toBe(computeWallyFingerprint(BASE));
  });

  it("versão de uma dependência", () => {
    expect(computeWallyFingerprint(BASE.replace("@0.4.1", "@0.5.0"))).not.toBe(computeWallyFingerprint(BASE));
  });

  it("dependência removida", () => {
    expect(computeWallyFingerprint(BASE.replace('Charm = "littensy/charm@0.11.0"\n', ""))).not.toBe(
      computeWallyFingerprint(BASE),
    );
  });

  it("a MESMA lib mudando de realm", () => {
    // De shared para server muda onde o pacote aparece na árvore, então o
    // colega precisa reinstalar mesmo com a lista parecendo igual.
    const movido = BASE.replace('ProfileStore = "ddashdev/profilestore@1.1.0"', "").replace(
      "[dependencies]",
      '[dependencies]\nProfileStore = "ddashdev/profilestore@1.1.0"',
    );
    expect(computeWallyFingerprint(movido)).not.toBe(computeWallyFingerprint(BASE));
  });
});

describe("computeWallyFingerprint — bordas", () => {
  it("projeto sem dependência tem impressão estável, não vazia", () => {
    // Vazio faria o outro lado tratar como "ainda não publicou" e nunca
    // comparar — um projeto que zerou as dependências deixaria de avisar.
    const semDeps = "[package]\nname = \"hakor/jogo\"\n";
    expect(computeWallyFingerprint(semDeps)).toBe("wally:vazio");
    expect(computeWallyFingerprint("")).toBe("wally:vazio");
  });

  it("é determinística", () => {
    expect(computeWallyFingerprint(BASE)).toBe(computeWallyFingerprint(BASE));
  });
});
