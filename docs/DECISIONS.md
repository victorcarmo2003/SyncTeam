# Decisões registradas

## 2026-08-03 (14ª rodada, mais recente) — Logo do SyncTeam no StatusBarItem via fonte de ícone (fantasticon) — `[Verificado]` build+empacotamento reais, `[Hipótese]` renderização no VS Code real

Pedido: mostrar a logo do SyncTeam (já existente como `resources/icon.svg`/
`icon.png`, usada no ícone da extensão) também no `StatusBarItem` (barra
inferior). Confirmado por pesquisa prévia da sessão
(`.claude/research/2026-08-03-statusbaritem-custom-icon-svg.md`) que
`StatusBarItem.text` só aceita texto + `$(codicon)`, nunca SVG cru — o único
caminho é declarar `contributes.icons` no `package.json` apontando pra uma
FONTE de ícone (glifo, não SVG solto), gerada com `fantasticon` (mesma
ferramenta usada pelo próprio `microsoft/vscode-codicons`).

**Arquivos**: `vscode-extension/scripts/build-icon-font.cjs` (novo),
`vscode-extension/package.json` (`devDependencies.fantasticon`, script
`prebuild`/`build:icons`, `contributes.icons.syncteam-logo`),
`vscode-extension/src/ui/statusBarMenu.ts` (`$(syncteam-logo)` prefixado em
todos os 3 estados), `vscode-extension/test/statusBarMenu.test.ts` (+1
teste), `.gitignore` (3 entradas novas), `vscode-extension/.vscodeignore`
(exclui os intermediários da geração, `scripts/**`).

**Bug real do `fantasticon@4.1.0` no Windows, encontrado e contornado**: a
função interna `loadPaths` monta o glob de busca com
`path.join(dir, "**/*.svg")` — no Windows isso produz separador `\`, e o
`glob@13` (dependência direta do fantasticon) trata `\` como caractere de
ESCAPE no padrão, não como separador — o glob nunca casa nada e a ferramenta
falha com "No SVGs found" mesmo com o arquivo existindo (reproduzido
isolado: `glob('dir\\**\\*.svg')` → `[]`, `glob('dir/**/*.svg')` → encontra
certo). Confirmado que isso só é contornável usando a build **CJS** do
pacote (`require("fantasticon")`, resolve pra `dist/index.cjs`) — a build
**ESM** (`import`) bundla sua própria referência interna a `path` e NÃO
respeita um monkeypatch externo de `path.join` (testado isolado, falhou
mesmo com o mesmo workaround). `build-icon-font.cjs` é por isso
deliberadamente `.cjs` (não `.mjs` como `esbuild.config.mjs`), e sobrescreve
`path.join` só durante a chamada a `generateFonts` (restaurado em
`finally`), forçando `/` como separador (aceito por `glob` e por `fs`/APIs
do Node em qualquer SO). Se uma versão futura do fantasticon corrigir isso
upstream, dá pra remover o workaround — mas testar de novo isolado antes.

**Fonte única, sem duplicar o SVG no repo**: o input do fantasticon precisa
ser uma pasta (`resources/icon-font-src/`), então o script copia
`resources/icon.svg` pra lá a cada build (regenerado sempre, nunca editado
à mão) — evita duas cópias divergentes do logo no repo. Essa pasta, o
`.woff` e o `.json` de codepoints gerados são **artefato de build, não
commitados** (mesmo tratamento de `dist/`, adicionados ao `.gitignore` na
raiz); `resources/icon.png`/`icon.svg` (fontes reais, não geradas)
continuam como assets versionados normalmente.

**Codepoint real confirmado, não adivinhado** (a tarefa pediu
explicitamente para não supor o valor do exemplo da pesquisa): o glifo
`syncteam-logo` gerou codepoint decimal `61697` = `\F101` — é esse o valor
gravado em `contributes.icons` no `package.json`, não o `\E001` de exemplo
da pesquisa anterior. `build-icon-font.cjs` loga esse valor toda vez que
roda, para detectar divergência cedo se o gerador mudar o codepoint no
futuro (ex.: acrescentar um 2º glifo).

**Logo é MONOCROMÁTICA depois de virar fonte de ícone — perda de marca
esperada e aceita, não é bug**: o SVG original tem 2 cores
(`#2c333f`/`#0268fc`, 2 `<path>`), mas fontes de ícone (WOFF/TTF) só
carregam a FORMA (contorno), nunca a cor por caminho — a cor final vem
inteira do CSS/tema de quem usa o `$(nome)` (no VS Code, a cor de texto da
status bar). Verificado isolado (headless Chrome, `--headless=new`, sem
Puppeteer — mesma técnica CDP-via-arquivo já documentada em
`ui-dev.md`/6ª rodada): renderizando o `.woff` gerado com `color: red`
forçado no CSS, o glifo saiu **inteiro vermelho sólido**, forma reconhecível
preservada (confirma que é monocromático de verdade, uma tentativa anterior
com font-type `svg` adicional tinha mostrado falsamente as 2 cores originais
— artefato de cache/timing do teste, descartado depois de isolar com
`data:` URI síncrono). Em 16px (tamanho real de status bar) a forma
permanece legível, mas perde detalhe fino — esperado, mesmo trade-off de
qualquer ícone de status bar pequeno.

**`[Verificado]` de verdade** (rodado, não só lido/assumido): `npm run
build` (dispara `prebuild` → `build-icon-font.cjs` → gera
`resources/syncteam-icons.woff` com o codepoint `\F101` batendo o que está
no `package.json`) + esbuild, ambos sem erro; `tsc --noEmit` limpo; `vitest
run` 275/275 (15 arquivos, incluindo o teste novo); `npx @vscode/vsce
package --no-dependencies` real gerou um `.vsix` que, inspecionado
(unzip), contém `extension/resources/syncteam-icons.woff` e
`contributes.icons` intacto no `package.json` empacotado — e **não** contém
`icon-font-src/` nem o `.json` de codepoints (confirma que o
`.vscodeignore` novo funcionou, não vazou intermediário de build).
Confirmado também, como baseline antes de mexer em mais nada, que o
`.gitignore` da raiz **não** impede o `vsce` de empacotar um arquivo (o
`dist/extension.js`, já gitignorado antes desta tarefa, sempre apareceu no
`.vsix` de baseline) — por isso gitignorar o `.woff` gerado é seguro, seguindo
o MESMO padrão já usado pra `dist/`.

**`[Hipótese]` (não verificado nesta sessão, documentar honestamente)**: o
glifo `$(syncteam-logo)` realmente aparecendo no `StatusBarItem` dentro de
um VS Code de verdade (Extension Development Host ou instalado via
`.vsix`). Deliberadamente **não** instalei a extensão no VS Code real do
usuário nem tirei screenshot da tela real dele nesta tarefa — a tarefa já
sinalizava que "print não dá", e abrir uma janela nova/capturar a tela
inteira do usuário sem pedido explícito pareceu invasivo demais pra uma
verificação que a evidência indireta (fonte válida, monocromática,
colorível, legível em 16px, codepoint conferido, `.vsix` real inspecionado)
já cobre com confiança alta. Se quiser fechar como `[Verificado]` de
verdade: instalar o `.vsix` (`code --install-extension
<caminho>.vsix`) e abrir uma pasta com `default.project.json` no VS Code
real.

## 2026-08-03 (13ª rodada) — `syncteam-cli` v0.2.0 publicado — `[Verificado]` contra o release real

Publicado `v0.2.0` no repo real (`gh release create v0.2.0`, 3 assets:
windows-x86_64/macos-x86_64/macos-aarch64), com os 4 comandos novos da 12ª
rodada. Version bump minor (0.1.0 → 0.2.0, feature nova, não só fix).

**Bug real encontrado e corrigido antes de publicar**: `CLI_VERSION` em
`cli/src/index.ts` era uma constante HARDCODED (`"0.1.0"`), não lida de
`package.json` — `--version` do binário compilado continuava reportando
"0.1.0" mesmo depois do bump pra 0.2.0 no `package.json`. Só descoberto
rodando o binário compilado de verdade (`--version`), não no lint/teste
(nenhum teste cobria isso). Fix: `import pkg from "../package.json" with {
type: "json" }`, `CLI_VERSION = pkg.version` — import JSON é inlinado pelo
bundler em tempo de build (Bun), não precisa de leitura de arquivo em
runtime, mesmo espírito do `with { type: "file" }` já usado pro `.rbxm`/
`.vsix`. Rebuildado e reverificado (`--version` → `0.2.0` correto) antes de
publicar.

**Confirmado `[Verificado]` de ponta a ponta contra o release real**:
`rokit trust victorcarmo2003/SyncTeam` → `rokit add
victorcarmo2003/SyncTeam` (sem pin de versão) resolveu sozinho pra `0.2.0`
(release mais recente) → `rokit install` → binário baixado reporta
`--version` = `0.2.0` e `--help` lista os 5 comandos corretamente.

## 2026-08-03 (12ª rodada) — `syncteam-cli`: comandos `port`/`start`/`stop`/`extension install` — `[Verificado]` ponta a ponta, incluindo binário compilado

Pedido do usuário: estender o `syncteam-cli` (só tinha `plugin install` até
aqui, ver 10ª/11ª rodada) com 4 comandos novos, cross-stack: `syncteam port
<PORT>`, `syncteam start [--dir <pasta>]`, `syncteam stop`, `syncteam
extension install`. `plugin install` intocado.

**Decisão de arquitetura central — reuso, não reinvenção**: `start`/`stop`
sobem a MESMA composição de produção que já roda dentro da extensão VS Code
(`SyncServer`+`SyncTeamService`+`SyncBridge`+`NodeDiskIO`, todos em
`vscode-extension/src/sync/`), importados por caminho relativo CROSS-PACOTE
a partir de `cli/` (que não depende de `vscode-extension/` como dependência
de pacote instalada, mas compartilha o mesmo repositório — TypeScript
resolve/type-checa a referência normalmente). `daemon/engine.ts` é um porte
direto de `vscode-extension/tools/run-node-harness.ts`. A "posse de porta"
interativa (diálogo Y/N) reusa `vscode-extension/src/sync/PortOwnership.ts`
(`attemptPortReclaim`) inteiro, sem alteração — só a UI de confirmação muda
(prompt real de terminal via `readline/promises` em vez do modal do VS
Code). A validação de porta reusa `vscode-extension/src/util/port.ts`
(`parsePortInput`/`MIN_PORT`/`MAX_PORT`).

**Achado técnico mais relevante desta rodada — self-invocation de binário
Bun compilado** (detalhe completo, incluindo a tabela de campos observados
e as duas tentativas que falharam antes de acertar, em
`.claude/agent-memory/extension-dev.md`): `syncteam start` precisa
reinvocar A SI MESMO como processo destacado (o daemon), e a forma de fazer
isso difere entre modo interpretado (`bun run src/index.ts`) e binário
compilado (`bun build --compile`). Duas heurísticas óbvias (comparar
`argv[1]` contra o caminho do próprio arquivo via `import.meta.url`;
depois tentar reforçar com `existsSync` sobre esse caminho) foram tentadas
e **confirmadas erradas com teste real** — o binário compilado do Bun usa
um caminho virtual (`B:/~BUN/root/<nome>.exe`) que é auto-referencial por
construção E que o próprio `fs` do Bun reconhece como "existente", então
nenhuma das duas heurísticas distingue os dois modos. O sinal que
realmente funciona, descoberto com um probe dedicado rodado em ambos os
modos nesta máquina: comparar `process.execPath` contra `process.argv[0]`
— só batem em modo interpretado (no binário compilado, `argv[0]` é sempre a
string literal `"bun"`, nunca um caminho real). `[Verificado no Windows]`
— não testado em macOS/Linux.

**Design de `start` em 2 processos** (necessário porque a resolução de
porta ocupada é interativa, e um processo destacado não tem terminal): (1)
processo em foreground resolve conflito de porta com um `SyncServer`
temporário + diálogo Y/N real, depois PARA esse servidor; (2) spawna um
processo destacado (self-invocation acima) que liga o motor real na porta
já resolvida, sem hook interativo (`portFallbackAttempts: 0` — falha
claro em vez de escolher outra porta silenciosamente numa corrida rara);
(3) o processo em foreground só retorna sucesso depois de CONFIRMAR (lendo
o mesmo lockfile de posse de porta) que o daemon realmente abriu a porta.

**Config/estado do CLI**: `~/.syncteam/` (`os.homedir()`, sem dependência
nova tipo `env-paths`) — `config.json` (`{port}`, `syncteam port`),
`syncteam.pid` (`{pid,port,projectDir}` do daemon vivo, `start`/`stop`),
`daemon.log` (stdout/stderr do daemon redirecionado no spawn),
`port-locks/` (mesmo lockfile de posse de porta da extensão, reusado).

**`syncteam extension install`**: mesmo padrão de `plugin install` (`.vsix`
embutido via `with {type:"file"}`), mas escreve num arquivo TEMPORÁRIO e
chama `code --install-extension <path> --force` via subprocess (VS Code
não tem uma "pasta de extensões" análoga à pasta de Plugins do Studio).
`scripts/build-extension-asset.ts` roda `npm run build` + `npx --yes
@vscode/vsce package --no-dependencies` dentro de `vscode-extension/` e
copia o `.vsix` gerado para o nome fixo `cli/src/assets/syncteam.vsix`.

**Nota Windows sobre `stop`**: `SIGTERM` externo força término IMEDIATO no
Windows (mesmo comportamento já documentado em `PortOwnership.ts`) — o
handler gracioso do daemon não chega a rodar, deixando o lockfile de posse
de porta órfão. Confirmado ao vivo que isso é inócuo (a porta é liberada
pelo SO; um `start` seguinte na mesma porta funciona normalmente e
sobrescreve o lockfile órfão). Em POSIX o `SIGTERM` deveria disparar o
handler gracioso de verdade — não testado nesta máquina.

**`[Verificado]` de ponta a ponta nesta máquina (Windows), incluindo o
BINÁRIO COMPILADO real** (não só modo interpretado): `bun run lint` limpo;
`bun run test` 52/52 (era 17), rodado 2x sem flakiness — inclui testes de
ponta a ponta REAIS (`test/startStop.test.ts`, `test/startPortConflict.test.ts`)
que sobem um daemon de verdade (processo `bun` real via self-invocation),
confirmam PID/porta/lockfile reais, testam o diálogo Y/N com um processo
Node SEPARADO ocupando a porta (nunca o processo de teste, por segurança),
e o encerram de verdade. Compilado `bun build --compile
--target=bun-windows-x64` e testado manualmente ao vivo: `start`/`stop`
reais (processo destacado sobrevivendo ao pai, porta confirmada via
`netstat`, PID confirmado via `Get-Process`), diálogo Y/N nos dois
caminhos (aceitar mata o ocupante e reusa a porta configurada; recusar
preserva o ocupante e cai no fallback automático), `syncteam port <N>`
persistindo/lendo de volta, `syncteam extension install` confirmado via
`code --list-extensions --show-versions` mostrando `dev-hakor.syncteam@0.1.0`
recém-instalado.

**Atrito de configuração encontrado e corrigido**: `cli/tsconfig.json`
tinha `noUncheckedIndexedAccess: true` (vscode-extension não usa essa
flag) — como o cross-import type-checa os arquivos de `vscode-extension/`
sob as opções do COMPILADOR DO CLI, isso gerava ~8 erros em código já
validado do outro pacote. Removida para alinhar com a baseline de estrito
de `vscode-extension` (ambos continuam `"strict": true`).

**Não incluído nesta rodada**: nenhuma publicação nova (release/`rokit.toml`
intocados — o release v0.1.0 da 11ª rodada só tem `plugin install`);
assinatura de código; `start`/`stop` não exercitados em macOS/Linux (fica
`[Hipótese razoável]`, mesmo mecanismo cross-platform do Bun, só não
testado fora desta máquina Windows). `CLAUDE.md` (linha ~57, "Único comando
hoje: `syncteam plugin install`") ficou desatualizado — não editado nesta
rodada (fora do escopo do agente que fez esta tarefa), sinalizado para o
usuário/orquestrador atualizar se quiser.

## 2026-08-03 (11ª rodada) — `syncteam-cli` publicado de verdade — `[Verificado]` ponta a ponta no repo real

Usuário autorizou publicar de verdade (não só o spike de validação da 9ª
rodada). Feito nesta rodada:

- `gh release create v0.1.0` no repo real `victorcarmo2003/SyncTeam` (não o
  repo descartável do spike), com os 3 assets já buildados/testados
  localmente na 10ª rodada (`syncteam-windows-x86_64.zip`,
  `syncteam-macos-x86_64.zip`, `syncteam-macos-aarch64.zip`):
  https://github.com/victorcarmo2003/SyncTeam/releases/tag/v0.1.0
- **Confirmado `[Verificado]` de ponta a ponta contra o release real**
  (repo público, sem precisar de `rokit authenticate` desta vez):
  `rokit trust victorcarmo2003/SyncTeam` → `rokit add
  victorcarmo2003/SyncTeam@0.1.0` → `rokit install` → binário baixado e
  executado de verdade (`syncteam-cli 0.1.0`, texto de ajuda correto) →
  `syncteam plugin install` escreveu `SyncTeam.rbxm` de verdade em
  `%LOCALAPPDATA%\Roblox\Plugins` nesta máquina.
- Repo de teste descartável do spike (`victorcarmo2003/rokit-bun-spike`)
  mantido por enquanto só como referência do primeiro teste; sem uso
  funcional depois desta rodada.

**Ainda em aberto**: macOS continua sem execução real (só compilação
confirmada) — mesma ressalva da 10ª rodada. Tag usada foi `v0.1.0` (padrão
já validado, Rokit resolve pra `0.1.0` sem o prefixo `v` automaticamente,
igual ao comportamento confirmado no spike). Repo é monorepo (plugin +
extensão + cli no mesmo lugar) — releases futuras de OUTRO componente
nesse mesmo repo GitHub poderiam colidir com a resolução de "latest release"
do Rokit se não vierem com tag/versão explícita; por ora não é um problema
real (nenhum outro componente usa GitHub Releases), mas vale lembrar antes
de adicionar qualquer outro fluxo de release neste repo.

## 2026-08-03 (10ª rodada) — `syncteam-cli` começou a ser construído de verdade (não só o spike)

Continuação direta da 9ª rodada (spike que confirmou `bun build --compile`
aceito pelo Rokit). Pedido do usuário: construir o componente de produto
`cli/` — novo diretório na raiz, sibling de `plugin/`/`vscode-extension/`,
projeto TypeScript/Bun independente (não depende de `vscode-extension/`).
Único comando por enquanto: `syncteam plugin install`.

**O que existe agora** (`cli/`, ver `cli/README.md` para o detalhe completo):

- `src/index.ts` (entry point, único arquivo que usa API do Bun —
  `Bun.file`, import `with { type: "file" }`), `src/plugin/studioPluginsDir.ts`
  (resolve a pasta de Plugins do Studio por SO, puro/testável), `src/commands/pluginInstall.ts`
  (orquestração do comando, IO injetada — mesmo padrão de módulo puro +
  injeção já usado em `vscode-extension/`). `scripts/build-plugin-asset.ts`
  roda `wally install` + `rojo build` contra `../plugin/` (mesmo entry point
  que `Tools/build-and-deploy-plugin.sh` já usa) e escreve
  `src/assets/SyncTeam.rbxm` — **gerado em build time, nunca commitado**
  (`*.rbxm` já cai na regra global do `.gitignore`), então o usuário final do
  CLI nunca precisa ter `rojo`/`wally` instalados. `scripts/zip-release.ts`
  empacota cada target no nome de asset que o Rokit reconhece
  (`syncteam-windows-x86_64.zip`/`syncteam-macos-x86_64.zip`/`syncteam-macos-aarch64.zip`).
  17 testes vitest (só lógica pura — resolução de pasta, orquestração de
  install com fakes, comparação de versão semver-aware para localizar
  ferramentas do Rokit em `~/.rokit/tool-storage/`), `tsc --noEmit` limpo.

**Achado real durante a implementação, não estava na pesquisa anterior**:
comentário JSDoc (`/** ... */`) contendo o padrão glob literal
`.../tool-storage/*/<toolName>/*` quebra o parser do TypeScript — a
substring `*/` embutida no MEIO do comentário fecha o bloco cedo, e o resto
vira "código" inválido (`error TS1109: Expression expected`). Reescrito para
evitar `*/` literal dentro de qualquer `/** */`; documentado no próprio
código-fonte (`cli/scripts/lib/rokitTools.ts`) para não repetir.

**Verificação real feita nesta máquina (Windows) — respondendo às duas
perguntas centrais da tarefa**:

1. **O hash do `.rbxm` embutido bateu com o gerado direto por `rojo build`?**
   **Sim, `[Verificado]`** — `scripts/verify-embed-hash.ts` compila o target
   Windows, roda `syncteam.exe plugin install` de verdade (com `LOCALAPPDATA`
   redirecionado para um diretório temporário, para não tocar a instalação
   real do usuário durante a verificação automatizada) e compara SHA-256 do
   arquivo escrito contra `src/assets/SyncTeam.rbxm`: **hashes idênticos**
   (`3a7daadeea2ff2f4dbb18a191a78770c6eb980dc51c820f3373215937f2fb104` nos
   dois lados). Essa era a ressalva que a pesquisa do Bun
   (`.claude/research/2026-08-03-bun-compile-embed-binary-file-rbxm.md`)
   deixou em aberto ("vale validar com um teste real") — agora fechada.
2. **Build cross-platform funcionou para quais targets de fato vs. só
   assumidos?**
   - **Windows x64 (`bun-windows-x64`)**: `[Verificado]` ponta a ponta —
     compilado (PE32+ confirmado via `file`), EXECUTADO de verdade,
     `plugin install` funcionou, hash bateu (item 1 acima).
   - **macOS x64/arm64 (`bun-darwin-x64`/`bun-darwin-arm64`)**:
     `[Verificado]` SÓ até "compila e gera um Mach-O válido" (confirmado via
     `file`: `Mach-O 64-bit x86_64 executable` / `Mach-O 64-bit arm64
     executable`). **NÃO executados** — esta máquina é Windows, não roda
     Mach-O. `syncteam plugin install` nunca foi exercitado de fato num
     macOS real. **Atualização (mesmo dia, pesquisa de follow-up)**: o
     caminho `~/Documents/Roblox/Plugins` em si já foi confirmado por fonte
     de terceiros confiável (`.claude/research/2026-08-03-macos-studio-plugins-folder-path.md`
     — bate com o código-fonte de `Kampfkarren/roblox-install`, o mesmo
     mecanismo que o próprio Rojo usa) — vira `[Hipótese confirmada por
     fonte de terceiros, sem execução real]`; só falta rodar o binário numa
     máquina macOS de verdade pra promover a `[Verificado]` puro.
   - Confirmados como valores de `--target` aceitos pelo Bun 1.3.13 (não
     documentados na saída de `--help`, testados por tentativa real):
     `bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`,
     `bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64` (+ variantes
     `-baseline`). Linux não é usado pelo produto (Studio não roda lá).

**Pasta de Plugins do Studio no macOS (`~/Documents/Roblox/Plugins`)**: como
a tarefa já sinalizava, **isso é `[Hipótese]`, não confirmado por pesquisa
dedicada** — nenhuma entrada em `.claude/research/` cobre especificamente o
caminho da pasta de Plugins do Studio no macOS. Implementado por analogia
direta com a estrutura documentada do Windows (`%LOCALAPPDATA%\Roblox\Plugins`).
**Reportando explicitamente**: o `researcher` precisa confirmar este caminho
antes de um usuário macOS depender do `syncteam plugin install` em produção.

**Zip dos 3 targets gerado localmente** (`dist/syncteam-windows-x86_64.zip`
43.8MB, `dist/syncteam-macos-x86_64.zip` 26.2MB,
`dist/syncteam-macos-aarch64.zip` 24.0MB) — **nada publicado** (sem `gh
release create`, sem push, `rokit.toml` da raiz não foi tocado), por decisão
explícita da tarefa. Tamanho do binário confirma o trade-off já registrado
na 9ª rodada (~110-120MB por plataforma, runtime Bun completo embutido).

**Próximo passo, se o usuário decidir seguir**: publicar um release real no
repo do SyncTeam, `rokit trust`/`rokit add` de verdade contra ele (não um
repo de spike descartável desta vez), e só então adicionar `syncteam-cli` ao
`rokit.toml` da raiz. Nenhuma dessas ações foi tomada nesta rodada.

## 2026-08-02 (9ª rodada) — Spike: binário `bun build --compile` é aceito pelo Rokit — `[Verificado]`

Pergunta: dá para distribuir uma ferramenta SyncTeam via Rokit (mesmo
mecanismo que já instala `rojo`/`selene`/`stylua`/`lune` neste repo) sem
escrever em Rust, usando `bun build --compile` (gera binário nativo real a
partir de TypeScript)? Pesquisa anterior (`.claude/research/2026-08-02-rokit-artifact-format-rojo-plugin-distribution.md`)
confirmou o formato exigido (PE/ELF/Mach-O real) mas não achou nenhum caso
confirmado de ferramenta Node/Bun testada de verdade — recomendou spike
antes de comprometer arquitetura.

**Spike executado ponta a ponta, resultado positivo**: repo de teste privado
`victorcarmo2003/rokit-bun-spike` (descartável, só um "hello world"), binário
compilado com `bun build --compile --target=bun-windows-x64` (confirmado
`PE32+ executable ... x86-64` via `file`), zipado como
`rokit-bun-spike-windows-x86_64.zip` (convenção de nome do Rokit), publicado
via GitHub Release `v0.1.0`. `rokit trust` + `rokit add
victorcarmo2003/rokit-bun-spike` instalou sem erro; `rokit install` +
execução do shim gerado (`~/.rokit/bin/rokit-bun-spike.exe`) rodou o binário
de verdade, saída correta.

**Detalhes que não estavam na pesquisa anterior (achados só no teste real)**:
- Repo **privado** exige `rokit authenticate github --token <token>` antes —
  sem isso, `rokit add`/`get_latest_release` falha silenciosamente com "no
  latest release was found" (mensagem não indica que o problema é
  autenticação/visibilidade do repo).
- Tag do release precisa ser SEM prefixo `v` no valor usado por
  `rokit add owner/repo@X.Y.Z` (a tag do GitHub Release em si pode ter
  `v0.1.0` — foi o que usei — mas o Rokit resolve e refere à versão como
  `0.1.0` no `rokit.toml` gerado; passar `@v0.1.0` explicitamente no CLI dá
  erro de parse de semver).
- Ferramenta precisa ser `rokit trust`ada explicitamente antes do primeiro
  `add` (mensagem de erro é clara nesse caso, diferente do caso de
  autenticação acima).
- Tamanho do binário: **112MB** (runtime Bun inteiro embutido) — MUITO maior
  que os binários Rust do ecossistema (rojo/selene/stylua ficam na casa de
  poucos MB). Trade-off real de usar Bun em vez de Rust: download/instalação
  bem mais pesada para quem rodar `rokit add`.

**Conclusão prática**: viável tecnicamente, `[Verificado]` — mas o custo de
112MB por instalação é um trade-off real a pesar antes de decidir construir
o `syncteam-cli` de produto em cima disso (vs. Rust, que ninguém no time
mantém hoje). Repo de teste `victorcarmo2003/rokit-bun-spike` deixado como
está (privado, inofensivo) — não é parte do produto, só evidência.

## 2026-08-02 (8ª rodada) — Reversão: STALE_AFTER_SECONDS deixa de ser fixo em 8s, vira configurável (handoff quase-instantâneo de lease)

Decisão de produto, com base no spike M1.6 (`6ª`/`7ª` rodadas abaixo — dado
real: replicação sem perda até 60Hz localhost, sem crash com editor nativo
aberto e não-focado). Reverte o valor fixo de `TeamCreateElection.STALE_AFTER_SECONDS = 8`
(`.claude/rules/luau.md` marcava essa constante como "validada, não alterar
sem registro" — este é o registro).

**O que muda**: `STALE_AFTER_SECONDS` vira configurável via o scaffold já
existente de settings por-place (`Config.PLACE_SETTINGS_DEFAULTS`,
`plugin/src/Config.luau:340`), default inicial ~2-3s (era 8s fixo).
Motivação: usuário quer handoff de lease quase-instantâneo — dono muda
rápido quando outro dev começa a editar, em vez do lock atual de ~8-10s
depois que o dono para de digitar.

**Achado técnico que molda o desenho** (discutido com o usuário antes de
implementar): só baixar `STALE_AFTER_SECONDS` não teria efeito real abaixo
de ~2s, porque quem CHECA staleness (`leaderTick`, em
`plugin/src/TeamCreateLease.luau`) roda a cada
`TeamCreateElection.PULSE_INTERVAL_SECONDS` (2s) — constante COMPARTILHADA
com o heartbeat de eleição/sessão. Baixar o valor do threshold sem desacoplar
o loop que o checa é decorativo (o piso de detecção fica preso em ~2-4s,
não importa o número). Por isso o desenho desta rodada desacopla o tick do
`leaderTick` de `PULSE_INTERVAL_SECONDS`, passando a rodar em
`Config.POLL_INTERVAL_SECONDS` (0.5s — mesma cadência já usada por
`checkLeaseDrift` no mesmo arquivo) — SEM tocar em
`PULSE_INTERVAL_SECONDS`/heartbeat de eleição, que continua em 2s
(constante de coordenação intocada, conforme a regra).

Lado extensão (complementar, mesma feature): gatilho de detecção de edição
local passa a incluir `onDidChangeTextDocument` (nível de buffer, throttled
~150ms) além do `FileSystemWatcher` em disco já existente — necessário para
o `Pulse` do lease atualizar continuamente durante digitação ativa (hoje só
atualiza em save). Ver detalhe de implementação nas entregas de
`extension-dev`/`luau-dev` desta rodada.

**Riscos residuais aceitos** (herdados do spike, `7ª rodada`, não
re-avaliados aqui): write concorrente com digitação humana simultânea no
editor NATIVO do Studio (fluxo real do produto é via VS Code); replicação em
rede real entre 2 máquinas diferentes (só localhost testado).

**Continuação (`luau-dev`, mesma data) — implementação real em
`plugin/src/TeamCreateLease.luau`/`Config.luau`/`plugin/src/ui/`.**

- **Desacoplamento do tick** (`TeamCreateLease.start`, task.spawn do
  `leaderTick`): `task.wait(TeamCreateElection.PULSE_INTERVAL_SECONDS)` →
  `task.wait(Config.POLL_INTERVAL_SECONDS)` (0.5s), mesma cadência que o
  `task.spawn` de `checkLeaseDrift` já usava no mesmo `start()`.
  `TeamCreateElection.PULSE_INTERVAL_SECONDS`/heartbeat de eleição não foram
  tocados em NENHUM lugar.
- **`leaseStaleAfterSeconds` configurável**: nova chave em
  `Config.PLACE_SETTINGS_DEFAULTS` (`plugin/src/Config.luau`), default `2`
  (não 3) — com o gatilho `onDidChangeTextDocument` do lado extensão
  renovando o Pulse a cada ~150ms durante digitação ativa, 2s já dá ~4 ciclos
  de folga sobre a nova cadência de checagem de 0.5s antes de considerar o
  intent morto. `readLiveIntents` (`TeamCreateLease.luau`) passou a resolver
  o limiar via `Config.getPlaceSetting(pluginObjectRef, "leaseStaleAfterSeconds")`
  a cada chamada (barato, permite o dev editar com a sessão já conectada e o
  próximo ciclo refletir).
- **`TeamCreateLease.start` ganhou parâmetro `pluginObject`** (mesmo contrato
  de `TeamCreateElection.start`), chamado agora como
  `TeamCreateLease.start(pluginObject)` em `init.server.luau`. Guardado
  module-level em `pluginObjectRef` (diferente de
  `TeamCreateElection.start`, que só usa `pluginObject` de forma síncrona no
  boot) porque `readLiveIntents` precisa consultar a setting em TODO ciclo do
  líder, não só uma vez.
- **Decisão sobre `TeamCreateElection.elect`/`STALE_AFTER_SECONDS` (8s
  fixo)**: **NÃO** viraram configuráveis — continuam exatamente como estavam
  (detecção de sessão/líder morto, constante de SEGURANÇA de coordenação
  validada em 2 Studios reais no RojoCoop, incluindo failover forçado). A
  decisão registrada no topo desta entrada fala especificamente de LEASE
  (latência de UX de arquivo), não de eleição de líder (risco de split-brain
  já corrigido em 2026-07-07) — misturar os dois threshold arriscaria
  reintroduzir aquele bug por um motivo que não tem relação com ele. Os dois
  agora são conceitos DESACOPLADOS, cada um com seu próprio valor.
- **UI real no painel** (`plugin/src/ui/StatusPanel.luau`/`PluginUI.luau`):
  novo campo `LeaseStaleAfterSecondsField` ("Liberar lease após (s)"),
  mesmo esqueleto visual de `CustomDisplayNameField` (SettingsRow, TextBox
  0.62/0.38) mas com parse/validação numérica no molde de `PortRow`
  (`tonumber` + rejeita ≤ 0), sem forçar inteiro (fração é um valor razoável
  em segundos). `onLeaseStaleAfterSecondsSubmit` é SELF-CONTAINED em
  `PluginUI.luau` (só `Config.setPlaceSetting`, mesmo padrão de
  `onCustomDisplayNameSubmit`) — mas, diferente de Username, não precisa de
  nenhuma chamada extra de "republicar agora": `readLiveIntents` já relê a
  setting a cada ciclo do líder, então persistir já é suficiente.
- **Validado só por `selene plugin/src` (0 errors, 42 warnings — só cresceu
  pelo padrão `mixed_table` já aceito/pré-existente em todo `vide.create`
  deste arquivo, mesma classe de aviso que `CustomDisplayNameField`/`PortRow`
  já geravam antes desta tarefa, não um problema novo), `stylua --check`
  (limpo) e `lune run`** nos 5 arquivos tocados (erro esperado só na 1ª linha
  que toca `game`/`script.Parent`, `Config.luau` roda inteiro sem erro por
  não tocar `game` em nível de módulo). **Nada testado em Studio real** —
  fica `[Hipótese]`. Roteiro manual (precisa 2 Studios + a extensão com o
  novo gatilho `onDidChangeTextDocument` do `extension-dev` já mesclada, para
  o teste fazer sentido de verdade): (1) Studio A edita um script
  continuamente (segurar uma tecla/digitar) por >3s; (2) Studio B tenta obter
  a lease do mesmo arquivo — antes desta mudança levaria até ~8-10s após A
  parar; confirmar que agora o handoff acontece em ~2-3s após A parar de
  digitar; (3) editar "Liberar lease após (s)" no painel de B para um valor
  maior (ex. 6) com a sessão já conectada, repetir o teste, confirmar que o
  atraso aumenta de acordo, sem precisar reconectar; (4) confirmar que
  `plugin:GetSetting` persiste o valor entre reloads do plugin (por-place,
  `game.PlaceId` atual); (5) confirmar visualmente que a eleição de
  líder/failover continua com o timing de sempre (8s), sem regressão.

## 2026-08-02 (7ª rodada) — Spike M1.6: resultado real (2 Studios), 15/30/60Hz sem perda detectada; item cursor-jump ainda pendente

Execução real do roteiro de `spikes/m1.6-source-streaming-rate/README.md`
contra os 2 Studios que o usuário deixa abertos (mesma máquina, 2 contas),
control-server + `analyze-log.mjs` rodados pelo orquestrador nesta sessão
(não pelo `luau-dev`, que tem restrição de domínio pra isso).

**[Verificado] 15Hz / 30Hz / 60Hz — zero perda/coalescing, latência baixa**:
100% dos writes enviados foram observados como valores distintos pelo lado
observador, tanto via `GetPropertyChangedSignal` quanto via polling de 50ms
— nas 3 taxas, sem exceção, mesmo na mais agressiva (60Hz = write a cada
~16ms). Latência calculada (hop WS Studio→control-server dos dois lados,
não é latência pura do Team Create — ver ressalva no README) ficou na casa
de poucos ms via sinal e limitada pelo próprio intervalo de poll (até ~48ms)
via polling — nenhum sinal de degradação ao subir a taxa de 15 para 60Hz.

**[Dado descartado] 2Hz / 5Hz — números de latência inválidos, não usar**:
o clique do usuário no botão "Escritor" disparou a execução DUAS vezes (log
do Studio mostra um primeiro ciclo interrompido no meio da fase 5Hz às
18:14:38, seguido de um segundo ciclo completo e limpo das 18:14:46 às
18:15:51 — este segundo ciclo é a fonte de todos os `enviados` reportados
pelo `analyze-log.mjs`, os totais batem exatamente com o log do Studio:
18+32+50+56+63=219). Como o contador `n` de cada fase reinicia a cada nova
ativação do Escritor (não sobrevive a um Parado/Iniciado), o
`analyze-log.mjs` pareou write do 2º ciclo com observed remanescente do 1º
ciclo pra `n` repetido nas fases 2Hz/5Hz (as únicas que o 1º ciclo chegou a
completar/quase completar antes de ser interrompido), produzindo latência
de ~-32s (exatamente o intervalo entre os dois ciclos) — artefato de
pareamento, não medição real. **Bug real do spike encontrado**: `n`
deveria ser globalmente único por execução do control-server (ex.: prefixar
com um id de sessão/timestamp de ativação), não só monotônico dentro de um
único ciclo do Escritor — não corrigido ainda (spike descartável, baixa
prioridade corrigir agora já que 15/30/60Hz, que é o que importa pra
decisão de taxa, saiu limpo).

**Ressalva importante de generalização**: este teste rodou com os 2 Studios
na MESMA máquina (2 contas Roblox, `Add Account`) — não é representativo de
2 devs em máquinas/redes diferentes, que é o uso real do SyncTeam. Zero
perda localhost não garante zero perda entre 2 máquinas reais; a taxa
segura pra produto pode precisar ser mais conservadora que 60Hz. Antes de
promover qualquer taxa a decisão de produto, idealmente repetir com 2
máquinas físicas diferentes (não feito nesta rodada).

**[Decisão pendente] Item 2 (cursor-jump com editor nativo do Studio aberto
no mesmo Script durante write em alta frequência)**: ainda não observado —
roteiro 100% manual descrito no README, não executado nesta rodada. Continua
sendo o maior risco não descartado (é a analogia mais próxima do bug real do
Rojo `#1273`, que NÃO foi sobre volume/perda de dados e sim sobre o editor
reagir mal a write externo).

**[Verificado, com ressalva] Item 2 — cursor-jump**: usuário rodou o roteiro
manual com o script-alvo aberto no editor nativo dos 2 Studios (script fora
de foco — foco real do fluxo do produto é sempre o VS Code) durante um ciclo
completo do Escritor (2 a 60Hz). Resultado: nenhum travamento, erro ou
comportamento visivelmente quebrado nos 2 Studios. **Ressalva**: isso testa
"write externo em alta frequência com o Script aberto mas não sendo digitado
por um humano" — não reproduz o cenário exato do bug do Rojo `#1273` (write
concorrente com alguém DIGITANDO ativamente naquele editor no mesmo
instante), que continua sem teste direto. Dado o fluxo real do SyncTeam
(dev edita via VS Code, não via editor nativo do Studio), esse cenário mais
estrito é de probabilidade baixa em uso normal — não zero.

**Próximo passo**: com o que foi `[Verificado]` aqui (replicação limpa até
60Hz localhost; sem crash com editor nativo aberto e não-focado), não há
mais bloqueio de dado pra desenhar a feature de produto do handoff
quase-instantâneo. Risco residual aceito e não mais bloqueador: write
concorrente com digitação humana simultânea no editor nativo do Studio
(cenário de baixa probabilidade dado o fluxo real via VS Code); replicação
em rede real entre 2 máquinas (não testado, só localhost).

## 2026-08-02 (6ª rodada) — Spike M1.6: ferramenta de medição de taxa de streaming de Source pronta, execução real PENDENTE (exige 2 Studios — não rodada por este agente)

Pergunta do usuário: dá para substituir o lease exclusivo atual por um
**handoff quase-instantâneo**, com streaming em tempo real do Source do dono
atual (read-only) para o outro dev, escrevendo via
`ScriptEditorService:UpdateSourceAsync` em taxa fixa (pediu para testar
15/30/60Hz)? Contexto já levantado pelo `researcher`:
`.claude/research/2026-08-02-realtime-source-streaming-team-create.md` — sem
patch incremental documentado, sem rate-limit numérico da Roblox, mas o Rojo
(`rojo-rbx/rojo#1273`) já tentou sync automático "enquanto digita" e
**reverteu** por causar "repeated writes/server echoes" e cursor pulando no
Script Editor — não é confirmação da Roblox, é analogia direta de caso de
uso quase idêntico.

**O que foi feito nesta rodada**: construído o spike completo em
`spikes/m1.6-source-streaming-rate/` (plugin Luau descartável +
control-server Node + script de análise) para medir, com dado real, latência
e perda/coalescing de replicação via Team Create em 2/5/15/30/60Hz.
**A execução real contra os 2 Studios NÃO foi feita nesta rodada** — é
restrição de domínio explícita do `luau-dev` ("nada de testes que exijam
dois Studios rodando; escreva o roteiro e reporte para o usuário
executar") e, à parte da restrição, este agente também não tem acesso a
MCP do Roblox Studio nem ao Command Bar nesta sessão (confirmado via
`ToolSearch`, nenhum `mcp__Roblox_Studio__*` disponível) — não há como
clicar o botão da toolbar remotamente. **Nada aqui é `[Verificado]`** —
tudo abaixo sobre taxa recomendada é `[Hipótese]`/`[Decisão pendente]`
até alguém (usuário ou `qa-tester`) rodar o roteiro.

### Desenho do spike (por que não precisa de nenhuma API nova)

- **`spikes/m1.6-source-streaming-rate/SyncTeamRateSpike.lua`**: porta do
  padrão já validado em `spikes/m0-source-replication/SyncTeamM0.lua`
  (toolbar com botões, 1 clique por Studio — Escritor/Observador/Parar,
  mesmo padrão `currentToken`/`stopAll()` de invalidação de loop). Escritor
  cicla SOZINHO pelas 5 taxas (~12s cada) depois de 1 único clique — sem
  mais interação. Alvo fixo em `TestService.SyncTeamRateSpike.Target`
  (deliberadamente FORA de `Config.getWatchedRoots()` da produção — não
  ServerScriptService/ReplicatedStorage/etc — para o plugin de produção,
  já rodando nos mesmos 2 Studios via `Tools/`, não tentar sincronizar este
  script de teste para o projeto VS Code real).
- **Decisão de design deliberada para não violar a regra "não codar sobre
  hipótese de API"**: a latência **não** é medida com nenhum timestamp
  gerado dentro do Studio (`DateTime.now().UnixTimestampMillis` nunca foi
  confirmado em `.claude/research/` — cogitado e descartado). Em vez disso,
  cada Studio manda só `{n, rateHz}` por WebSocket para
  `control-server.mjs` (Node local), e é **o processo Node** — relógio
  único, comparável entre os 2 Studios porque ambos rodam na mesma máquina
  e falam com o mesmo processo — quem carimba o instante de RECEBIMENTO de
  cada evento `write`/`observed`. Latência calculada = viés do hop WS dos
  dois lados + latência real de replicação; suficiente para **comparar
  taxas entre si** (o objetivo real), não para um número absoluto de
  latência pura do Team Create.
- **`control-server.mjs`**: logger burro (toda a lógica de ciclar taxas
  mora no plugin, autodirigido) — grava cada evento recebido num `.jsonl`
  com timestamp de recebimento. **`analyze-log.mjs`**: agrupa por
  `rateHz`, calcula, por via (`signal`/`poll`): quantos writes enviados,
  quantos valores distintos observados (evidência de perda/coalescing
  quando menor que enviados), e latência min/p50/p95/max.
- **Tooling Node validado com dado sintético** (permitido — não é teste com
  2 Studios, é só confirmar que o harness que construí funciona): rodei
  `control-server.mjs` + um feeder descartável simulando 20 writes a 2Hz
  com 50% de perda proposital + ~15ms de latência artificial;
  `analyze-log.mjs` detectou corretamente `10/20 (50%)` distintos via poll
  e latência `min=15 p50=16 p95=16 max=16`. Feeder e log sintético
  removidos depois do smoke test (não fazem parte do roteiro real).
- **Item 2 do pedido original (cursor-jump com editor nativo aberto)**:
  documentado no README do spike como **100% manual** — não existe API
  para abrir o Script Editor de um Studio remotamente, e "ter a janela em
  foco digitando durante o teste" exige uma pessoa física. Roteiro exato de
  4 passos escrito no README do spike; fica `[Decisão pendente]` até
  alguém observar e reportar.
- Live Scripting Beta: fora de escopo por decisão já tomada no pedido
  original (feature opcional, exigiria ligar manualmente nos 2 Studios) —
  não testado aqui, documentado no README do spike.

### Recomendação provisória (NÃO verificada — só para orientar até o teste real)

Baseada só na pesquisa já registrada (não em medição própria): a evidência
mais forte disponível (Rojo revertendo write-por-tecla exatamente pelo
sintoma que o SyncTeam quer evitar) aponta para **não** escrever em taxa
tão alta quanto uma tecla por vez, e a via seguramente testável mais baixa
deste spike (2Hz, ~500ms por write) é a candidata mais conservadora a
"funciona sem sintoma" — mas isso é extrapolação da pesquisa, não teste
deste projeto. **Não promover isto a recomendação de produto sem rodar o
roteiro do spike.**

### Como executar (roteiro completo em `spikes/m1.6-source-streaming-rate/README.md`)

1. `cd spikes/m1.6-source-streaming-rate && npm install && node control-server.mjs`
2. Copiar `SyncTeamRateSpike.lua` para `%LOCALAPPDATA%\Roblox\Plugins`
   (pasta compartilhada pelos 2 Studios, mesmo padrão do M0).
3. Studio A: toolbar "SyncTeam RateSpike" → "RateSpike: Escritor" (1 clique,
   cicla sozinho ~70s). Studio B: → "RateSpike: Observador" (1 clique).
4. `node analyze-log.mjs ./logs/rate-spike-<timestamp>.jsonl` — imprime a
   tabela de perda/latência por taxa.
5. Registrar o resultado real aqui (nova entrada) e em
   `.claude/agent-memory/luau-dev.md`, marcando `[Verificado]` só o que foi
   de fato medido.

**Próximo passo**: orquestrador decide quem roda o roteiro (usuário
diretamente, ou delega a `qa-tester`) — este agente (`luau-dev`) não deve
tentar de novo sem MCP/Command Bar disponível.

## 2026-08-02 (5ª rodada) — Botão "ReSync" no painel do Studio + redesign visual (INFO row, Toast) — aprovado no mockup `design-preview/`, implementação real autorizada

Usuário aprovou 3 ajustes visuais desenhados/iterados em `design-preview/`
(mockup solto, ver entrada de criação do mockup mais abaixo) e pediu
implementação real:

1. **Linha INFO vira label + box**, igual à linha Porta (`StatusPanel.luau`,
   `InfoRow`) — hoje é texto solto `"INFO: [ %s ] %ds"` num único
   `TextLabel`; mockup mostra `<label>INFO:</label>` + campo tipo caixa.
2. **Botão novo "RESYNC"** abaixo do CONNECT no painel principal do Studio.
3. **Toast redesenhado** em duas faixas (barra de título "SYNC TEAM" + X
   colorida por severidade / corpo cinza neutro do tema Studio), substituindo
   a aba fina esquerda atual.

### Contrato exato — feature real "ReSync" (a mais nova, itens 1 e 3 são só
### restyle visual sem contrato de mensagem novo)

**O que o ReSync faz de verdade**: limpa todo o Source sincronizado no
workspace do VS Code e puxa tudo de novo do Studio (autoritativo), o que
elimina arquivo duplicado/órfão que possa existir no disco. **Escopo: SÓ
Source de Script/LocalScript/ModuleScript** — não mexe em
`default.project.json`, não mexe em nada fora dos arquivos que a própria
extensão já rastreia como script sincronizado (`this.diskPathByUuid` em
`SyncBridge`). Mais agressivo que o `refreshSync` que já existe (reconciliação
de 3 vias, não-destrutiva, preserva conflito) — ReSync é um reset forçado
para quando o estado ficou realmente bagunçado (duplicatas).

- **Plugin → Extensão** (clique no botão, espontânea, sem `requestId`):
  ```json
  { "kind": "resyncRequest" }
  ```
- **Extensão**: novo `case "resyncRequest"` em
  `SyncTeamService.routeSpontaneous` (`vscode-extension/src/sync/SyncTeamService.ts:387+`,
  mesmo padrão de `watchedRoots`/`enqueueMutation`). **Antes de apagar
  qualquer coisa**, mostra confirmação modal nativa do VS Code
  (`showWarningMessage(..., {modal:true}, "Confirmar", "Cancelar")`) — apagar
  arquivo de disco do usuário é ação com risco, mesmo sendo Source já
  sincronizado; o clique no Studio pede, mas quem confirma de fato é o lado
  que vai perder o arquivo local. Se cancelado, responde `resyncResult`
  imediatamente com `ok:false, reason:"cancelled_by_user"`, sem apagar nada.
  Se confirmado: novo método em `SyncBridge`
  (ex. `resyncFromScratch(transport)`) que (a) apaga todo arquivo em
  `this.diskPathByUuid` (delete, não move — cada delete em `try/catch`
  isolado, arquivo já ausente ou locked não aborta o resto), (b) zera
  `this.scripts`/`this.diskPathByUuid`/`contentCache` (mesmo estado de um
  bridge recém-criado), (c) chama `this.runInitialSync(transport)` (mesmo
  método já usado em `onClientConnected`, `SyncTeamService.ts:162`) pra
  repuxar tudo fresco do Studio. Responde
  `{kind:"resyncResult", ok:true, deletedCount:N}` em sucesso, ou
  `{kind:"resyncResult", ok:false, reason:"<mensagem de erro>"}` em falha
  (try/catch em volta do fluxo inteiro, nunca derruba a extensão).
- **Extensão → Plugin** (espontânea, resposta ao `resyncRequest`):
  ```json
  { "kind": "resyncResult", "ok": true, "deletedCount": 3 }
  { "kind": "resyncResult", "ok": false, "reason": "cancelled_by_user" }
  ```
- **Plugin**: novo `elseif message.kind == "resyncResult"` em
  `plugin/src/init.server.luau` (`handleMessage`, junto dos outros kinds
  espontâneos por volta da linha 464+) — atualiza o Source do botão ReSync
  (`state.resyncState`, novo: `"idle" | "syncing" | "done"`) pra `"done"` se
  `ok=true` (volta a `"idle"` sozinho depois de ~1.2s, mesmo timing do
  mockup), ou volta direto a `"idle"` + Toast de erro (novo design de
  severidade `"erro"`) se `ok=false`.
- **Aditivo ao protocolo — NÃO muda `PROTOCOL_VERSION`** (mesmo precedente de
  `watchedRoots`/`ping`/`leaseChanged`).

**Divisão de trabalho** (mesma separação de sempre): `ui-dev` porta o visual
aprovado pro Luau real (não mexe em protocolo/mensagem); `luau-dev` liga o
clique do botão ao envio de `resyncRequest` e trata `resyncResult`;
`extension-dev` implementa `resyncFromScratch`/o `case` novo/o modal de
confirmação. Nenhum dos três decide sozinho apagar arquivo sem o modal — não
é uma decisão coberta por `.claude/rules/authority.md` (não é obstáculo
recuperável, é ação destrutiva deliberada pedida pelo usuário via feature do
produto, mas ainda assim exige confirmação explícita no momento por ser
apagar arquivo local).

## 2026-08-02 (4ª rodada) — Logger: remove `print()` do Output do Studio para log/notify/debug; decisão sobre os 2 prints crus de `sendMessage`

Pedido do usuário: "limpar os prints do output, pode retirar todos" — o
Output do Studio estava poluído com linhas `[SyncTeam HH:MM:SS] ...` a cada
evento de `Logger.log`/`Logger.notify` (só `Logger.debug`, criado em
2026-07-16 para reduzir ruído de BOOT, já não imprimia — o pedido desta vez
é para TODAS as chamadas, não só as de boot).

- **`render()` (`plugin/src/Logger.luau`) parou de chamar `print()`
  incondicionalmente** — antes o print era condicional a `shouldPrint`
  (`Logger.log`/`Logger.notify` = `true`, `Logger.debug` = `false`); agora
  NENHUM dos três imprime. Parâmetro renomeado `shouldPrint` → `trackPanel`:
  hoje ele só decide se a mensagem alimenta `lastMessageText`/`lastMessageAt`
  (linha INFO do painel, `StatusPanel.luau`/`PluginUI.luau`), sem nenhuma
  relação com o Output. **Nada mais mudou**: o encaminhamento por WS
  (`sendMessage({kind="log", text=...})`, observabilidade de teste
  automatizado via `Tools/README.md`) continua incondicional; o toast de
  `Logger.notify` (`onNotify`) continua disparando exatamente como antes;
  `Logger.getLastMessage()` continua alimentando o painel.
- **Decisão sobre os 2 `print()` crus de `plugin/src/init.server.luau`
  (função `sendMessage`, deliberadamente FORA do Logger — motivo de
  recursão documentado no próprio arquivo e em `Logger.luau`)**: a tarefa
  original sugeria manter os dois ("são caminho raro de erro genuíno").
  Avaliação de frequência real de cada um levou a uma decisão DIVERGENTE,
  tratando os dois de forma assimétrica:
  - **Removido**: "descartado (sem conexão): `<kind>`" (branch
    `client == nil`). Não é, na prática, um erro raro — dispara a CADA
    mensagem espontânea de QUALQUER módulo (`sourceChanged`,
    `presenceUpdate`, `leaseChanged`, `scriptAdded`, etc.) sempre que o
    plugin está com a sessão Team Create ativa mas SEM a extensão VS Code
    conectada (cenário nada incomum: extensão ainda não aberta depois do
    Studio abrir, ou qualquer janela de reconexão enquanto um colega segue
    editando do lado dele) — exatamente o padrão "rotineiro/alta
    frequência" que o resto desta tarefa suprimiu, não um "erro raro e
    acionável". Também não há PERDA de observabilidade real ao remover: por
    definição, `client == nil` já significa que o encaminhamento por WS
    está indisponível NESSE exato instante — nenhum canal (Output cru ou
    WS/Tools) conseguiria relatar essa mensagem de forma diferente, antes
    ou depois desta mudança.
  - **Mantido, sem alteração**: "falha ao enviar: `<err>`" (branch em que
    `client:Send()` de fato lança erro, apesar de `client` parecer
    conectado). Este SIM é um caminho raro e genuíno — WS quebrou sem que
    `Closed`/`Error` tivessem disparado ainda — e é o ÚNICO canal restante
    para essa falha específica: no instante exato do erro, o próprio envio
    (inclusive de uma mensagem de log via WS) está falhando, então rotear
    isso por `Logger` não ganharia nada em observabilidade e, pior,
    reintroduziria risco real de recursão sem saída (este branch não tem
    nenhum guard por `kind`, ao contrário do branch que foi removido acima).
- **Não tocado nesta tarefa (fora do escopo pedido, registrado aqui só por
  transparência)**: o pcall interno de `Logger.notify` (`"falha ao notificar
  UI: <err>"`, linha final da função em `plugin/src/Logger.luau`) continua
  como print cru. Mesma classe de raciocínio do print mantido acima (erro
  raro do próprio mecanismo de UI, sem canal alternativo no instante exato
  da falha), mas não foi mencionado explicitamente pela tarefa original. Se
  o objetivo for "zero prints, sem NENHUMA exceção", este é o próximo (e
  último) candidato.
- **Comentários stale identificados em arquivos de UI, NÃO editados aqui
  (fora do domínio de `luau-dev`, sinalizado para `ui-dev`/orquestrador)**:
  `plugin/src/ui/PluginUI.luau` (~linha 181, "o log no Output já
  aconteceu... ANTES de chamar este callback") e
  `plugin/src/ui/StatusPanel.luau` (~linha 475, "o log no Output NUNCA é
  condicionado a isso") descrevem um comportamento que deixou de existir
  (nada mais aparece no Output via `Logger.notify`). O comportamento
  FUNCIONAL que esses comentários descrevem (toast sempre dispara
  independente da preferência de exibição) não mudou — só a palavra
  "Output" ficou factualmente incorreta nesses dois comentários.
- **Validado só por `selene plugin/src` (0 errors, 37 warnings — baseline
  idêntica à anterior, nenhum warning novo), `stylua --check` (limpo, sem
  diffs) e `lune run` nos 2 arquivos tocados** (`Logger.luau` roda sem erro
  nenhum — não toca `game` em nível de módulo; `init.server.luau` erra só na
  1ª linha que toca `game`, mesmo padrão de sempre — confirma que o resto do
  arquivo, incluindo o bloco de `sendMessage` editado, compila sem erro de
  sintaxe). **Nada testado em Studio real** — fica `[Hipótese]` até o
  usuário validar. Roteiro manual (1 Studio, sem Team Create necessário):
  (1) conectar o plugin normalmente e confirmar que NENHUMA linha
  `[SyncTeam HH:MM:SS]` aparece no Output durante boot e uso normal (editar
  um script, mover cursor, lease); (2) confirmar que a linha INFO do painel
  de status continua atualizando e que toasts (ex.: lease negada) continuam
  aparecendo normalmente; (3) confirmar via `Tools/` que o log continua
  chegando pela conexão WS normalmente (canal intocado); (4) fechar/parar a
  extensão VS Code de propósito com o plugin conectado e observar a janela
  de reconexão — confirmar que o Output PERMANECE limpo mesmo com o plugin
  tentando reconectar repetidamente (cenário que motivou a remoção do print
  de "descartado (sem conexão)"); (5) o caminho do print mantido ("falha ao
  enviar") é difícil de forçar deliberadamente (exige o WS quebrar em
  condição de corrida específica) — não bloqueante para validar o pedido
  principal do usuário.

## 2026-08-02 (3ª rodada) — Plano de 4 frentes de robustez: posse de porta, conversão `init.luau` → ModuleScript, menu de configurações do painel, aviso de lock mais leve no VS Code

Pedido do usuário: o SyncTeam está "muito frágil" em uso real (máquinas mais
fracas, plugin não encerra a conexão da porta corretamente ao fechar,
exigindo troca manual de porta). Quatro frentes decididas nesta rodada
(perguntas feitas ao usuário via `AskUserQuestion`, respostas incorporadas
abaixo). Trabalho ainda NÃO iniciado — sessão pausada por limite de tokens,
retomada agendada (ver `docs/PROJECT_STATUS.md`, nota de sessão da mesma
data).

### 1. Posse de porta (amplia a 2ª rodada acima, item que dizia "nunca mata processo de terceiro")

**Reversão parcial deliberada** de um limite registrado horas antes, no mesmo
dia, a pedido explícito do usuário — não é um bypass silencioso, é decisão
nova por cima da antiga: quando a porta configurada está ocupada, além do
fallback automático (porta+1, já implementado), a extensão deve poder
**mostrar uma notificação perguntando se o usuário quer tomar posse da
porta**, encerrando o processo que a ocupa.

- Default sugerido no diálogo: matar um **zumbi identificado do próprio
  SyncTeam** (via handshake/lockfile com PID — a implementar, hoje não existe
  nenhum lockfile). Este caso pode, no futuro, virar autônomo (rule
  `authority.md` já permite: identificado com certeza + reversível).
- **Também permitido, mas só com confirmação explícita a cada vez**: matar um
  processo NÃO identificado como SyncTeam. Nunca automático, nunca "lembrar e
  não perguntar de novo" — o diálogo mostra PID/nome do processo antes de
  agir.
- **Restrição crítica de coordenação**: a extensão hospeda o servidor
  WebSocket; quem conecta como cliente é o plugin Studio
  (`CANDIDATE_PORTS = {1400, 1401}` em `plugin/src/Config.luau` — cenário
  real de 2 contas Studio na mesma máquina, cada uma com sua própria extensão
  numa porta adjacente). A oferta de "tomar posse" NUNCA pode disparar/matar
  enquanto uma tentativa de conexão legítima de um plugin Studio ainda está
  em andamento naquela porta — arriscaria derrubar uma sessão real de
  colega/segunda conta, não um zumbi.
- `.claude/rules/authority.md` atualizado (bullet "Matar processo de
  terceiro") para refletir esta permissão condicional.

**Implementação real (continuação desta seção, `extension-dev`, mesma data)**:
os pontos acima descreviam só a decisão; esta parte documenta como foi
construído.

**Módulo novo `vscode-extension/src/sync/PortOwnership.ts`** — três
responsabilidades independentes, todas puras (sem `vscode`), todas testadas
com fs/child_process/net/ws REAIS (`test/portOwnership.test.ts`, 22 testes,
mesma filosofia de sempre — nunca mockar `ws`):

1. **Lockfile** (`writePortLock`/`readPortLock`/`removePortLock`): grava
   `{pid, port, startedAt}` num diretório persistente a cada bind bem-sucedido
   do `SyncServer` (chave = a porta REAL em uso, não necessariamente a
   configurada). Se o processo morre sem chamar `stop()` (crash, kill externo,
   "Reload Window" que não roda `deactivate` a tempo — exatamente o cenário de
   fragilidade relatado pelo usuário que motivou toda esta rodada), o lockfile
   SOBREVIVE — é isso que permite a uma tentativa de bind FUTURA na mesma
   porta reconhecer "esse processo é uma instância órfã do próprio SyncTeam"
   com razoável confiança.
2. **Detecção do processo dono de uma porta ocupada**: Windows via
   `netstat -ano -p TCP` (parseia `Proto LocalAddr ForeignAddr State PID`,
   filtra por porta+`LISTENING`) + `tasklist /FI "PID eq N" /FO CSV /NH` para o
   nome; Unix via `lsof -iTCP:<porta> -sTCP:LISTEN -t` + `ps -p <pid> -o
   comm=`. **Formato do `netstat -ano` confirmado por teste real nesta máquina
   Windows** antes de codar (bind de um `net.Server` de teste + parse da saída
   real, e também `process.kill(pid, 0)`/`process.kill(pid)` confirmados como
   existência-check e término forçado respectivamente, Windows real) — não
   passou pelo `researcher`/`.claude/research/` porque são utilitários de SO
   estáveis e básicos (netstat/tasklist/lsof/ps, `process.kill`), não uma API
   Roblox/VS Code/Node sujeita a mudança de comportamento; a mesma régua já
   aplicada a `ws`/`esbuild`/`vitest` como toolchain de confiança
   (`.claude/rules/typescript.md`). Se `lsof`/`tasklist` não existirem ou
   falharem, degrada para `null` ("processo não identificado") — nunca lança.
3. **Sondagem de handshake (`probePortSignal`)** — a peça que implementa a
   "restrição crítica de coordenação" acima: conecta como cliente `ws` DE
   VERDADE na porta ocupada e **nunca manda `hello`** (de propósito: se
   mandasse, e não houvesse ninguém realmente conectado do outro lado, a
   PRÓPRIA sonda viraria "o plugin" daquela conexão — disparando
   `onClientConnected`/notificação de "plugin conectado" no VS Code de quem
   quer que esteja rodando aquele servidor, um efeito colateral inaceitável só
   para sondar). Três sinais: `"busy"` (o `SyncServer` remoto respondeu
   `connectionRejected`/`port_in_use` — prova definitiva de que já existe uma
   sessão SyncTeam ATIVA agora; isso acontece mesmo SEM enviarmos nada, porque
   `SyncServer.handleConnection` decide a rejeição no momento da conexão TCP,
   antes de qualquer mensagem); `"respondsWs"` (upgrade WebSocket teve sucesso,
   nenhuma rejeição chegou — ambíguo: SyncTeam ocioso OU qualquer outro
   servidor WS); `"silent"` (nada responde como WebSocket).

**Orquestração da decisão (`attemptPortReclaim`, mesmo arquivo)** — heurística
de segurança completa (documentada no código-fonte e testada
exaustivamente):

1. `probeSignal === "busy"` → `fallback` IMEDIATO, **`host.confirmKill` NUNCA é
   chamado** — o usuário nem chega a ver o diálogo. Único caso tratado como
   certeza absoluta; implementa a restrição "nunca dispara enquanto uma
   conexão legítima de outro Studio estiver em andamento".
2. Processo identificado como zumbi (lockfile com PID vivo — e, se o SO
   também detectou alguém ouvindo na porta, os dois PIDs precisam BATER;
   lockfile sozinho só é confiado quando o SO não conseguiu detectar nada,
   ex.: `lsof` ausente) → sugestão DEFAULT "instância anterior do próprio
   SyncTeam", tom ameno — mas SEMPRE com confirmação explícita mesmo assim
   (nunca automático, por pedido do usuário: "no futuro" podia virar autônomo,
   não nesta rodada).
3. `probeSignal === "respondsWs"` sem identificação por lockfile (fala
   WebSocket mas não é possível confirmar que é órfão) → tratado como
   "PROVAVELMENTE uma sessão viva" — ainda oferece matar, mas o texto do
   diálogo ganha um parágrafo extra de aviso explícito nomeando o cenário de
   2 contas/2 Studios na mesma máquina.
4. Nenhum PID identificável (nem lockfile, nem SO) → `fallback` sem nunca
   mostrar diálogo (nada concreto para oferecer).
5. Processo detectado pelo SO mas não relacionado a SyncTeam por nenhum sinal
   → oferece matar um processo "desconhecido", sempre com PID/nome visíveis e
   confirmação explícita.

Depois de confirmado: `killProcess(pid)` (default real =
`process.kill(pid, "SIGTERM")` — em Windows isso já força término
independente do sinal, confirmado por teste real nesta máquina; em POSIX é um
SIGTERM gracioso). Espera até 2s (configurável) a porta ficar livre
(bind-e-fecha de sondagem); se na metade do prazo o processo ainda estiver
vivo, escala para `SIGKILL` (só faz diferença em POSIX). Se a porta não
liberar a tempo, desiste e cai no fallback normal — o `SyncServer` nunca fica
esperando indefinidamente.

**Ponto de integração em `SyncServer.ts`** (`tryListen`): novo parâmetro
`hookTried` na recursão privada. Em `EADDRINUSE` na porta CONFIGURADA (nunca
numa já de fallback) e só na primeira tentativa (`attempt === 0`), se
`onPortOccupied` estiver configurado, é chamado; `{action:"retrySamePort"}` →
tenta a MESMA porta de novo (uma única vez — `hookTried=true` na recursão
impede loop, mesmo que o retry esbarre em `EADDRINUSE` de novo, caindo então
no fallback automático de sempre); `{action:"fallback"}` (ou hook ausente, ou
hook que rejeita/lança) → segue o fallback automático de porta+1... de sempre,
sem NENHUMA mudança de comportamento. `getLastReclaimed()` novo (reciclado a
cada `start()`) expõe o PID/nome encerrado com sucesso, se houve. Escrita do
lockfile (`portLockDir` opcional) acontece em TODO bind bem-sucedido
(qualquer porta, configurada ou de fallback), removido em `stop()` limpo —
comportamento de sempre preservado 100% quando `portLockDir`/`onPortOccupied`
não são passados (nenhum teste pré-existente precisou mudar).

**Wiring em `extension.ts::startService`**: `portLockDir` =
`vscode.Uri.joinPath(context.globalStorageUri, "port-locks").fsPath`
(sobrevive a "Reload Window"/reinstalação, por pedido do usuário registrado
no item 4 desta mesma rodada). `onPortOccupied` chama `attemptPortReclaim`
passando um `host.confirmKill` que abre
`vscode.window.showWarningMessage(mensagem, {modal:true}, "Encerrar
processo", "Usar porta alternativa")` — modal (não um toast que some
sozinho) porque é uma decisão que nunca deve ser tomada sem o usuário ver.

**`SyncController.ts`**: `StartServiceResult` ganhou `portReclaimed?: {pid,
processName}` — quando presente, `doStart` mostra uma mensagem DISTINTA da de
fallback ("a porta N estava ocupada por X — encerrado com sucesso, o servidor
assumiu a porta N"), porque aqui o servidor está na porta ORIGINALMENTE
pedida (nunca uma alternativa) — dizer "fallback" seria enganoso. Mutuamente
exclusivo com `portFallbackFrom` na prática (um processo só é "reclamado" na
porta configurada; se o retry falhar de verdade, cai no fallback normal e
`portReclaimed` fica ausente).

**Achados reais durante a escrita dos testes** (documentados no próprio
código/comentários dos testes, para não repetir o erro):

- `probePortSignal`, ao chamar `socket.terminate()` numa conexão ainda em
  handshake HTTP pendente (o outro lado nunca responde), pode emitir um
  `'error'` ASSÍNCRONO internamente (abort do request em andamento). Remover
  TODOS os listeners antes de `terminate()` (o que parecia "limpeza
  correta") faz esse erro tardio virar exceção não tratada do processo — o
  listener de `'error'` precisa **permanecer conectado para sempre** (o guard
  `if (settled) return` dentro de `finish()` já absorve qualquer disparo
  tardio com segurança).
- Testar essa mesma sondagem contra um `net.Server` puro de teste (simulando
  "porta ocupada por processo não-WebSocket") pode deixar uma conexão TCP
  "pendurada" do lado do servidor de teste — `net.Server.close()` só chama
  seu callback depois que TODAS as conexões existentes terminam (mesmo
  comportamento documentado que já motivou `stopSafetyTimeoutMs`/`terminate()`
  em `SyncServer.stop()`, 2026-07-20), e o `terminate()` do lado cliente nem
  sempre propaga o fechamento a tempo do lado servidor neste ambiente. Fix
  (só no test helper): rastrear e `.destroy()` manualmente as conexões
  aceitas pelo servidor de teste antes de `close()`.

**Testes** (`vscode-extension/test/`, 34 novos, 248 no total — era 214):
`portOwnership.test.ts` (22: lockfile round-trip/malformado, `isProcessAlive`
com processo real spawnado+morto, `findProcessOnPort` contra um `net.Server`
real, `probePortSignal` nos 3 sinais contra um `SyncServer`/`net.Server`
reais, `attemptPortReclaim` cobrindo toda a heurística acima incluindo nunca
confiar cegamente no lockfile quando o SO reporta um PID diferente ouvindo);
`syncServer.test.ts` (8 novos: hook retrySamePort/fallback/hook-só-na-porta-
configurada/hook-que-rejeita/retry-otimista-que-não-libera-cai-em-fallback,
mais 3 de lockfile write-on-bind/remove-on-stop/reflete-porta-de-fallback);
`syncController.test.ts` (4 novos: mensagem de posse reclamada com/sem
processName, mensagem normal sem menção a "encerrado" quando não há reclamo,
`restart` também anuncia).

**Verificação**: `npm run lint` (tsc --noEmit) limpo; `npm run test` (vitest
run) 248/248 passando, suíte completa rodada duas vezes seguidas para
confirmar que os testes com sockets/processos reais não são flaky; `npm run
build` (esbuild) gera os dois bundles sem erro. **100% testável localmente
sem Studio real** — a tarefa é puramente de detecção/kill de processo local +
bind de porta, nada de Team Create envolvido (mesma conclusão da 2ª rodada);
não há `[Hipótese]` pendente de round-trip com 2 Studios aqui. Único
`[Hipótese]` residual: o comportamento exato de `netstat`/`tasklist`/`lsof`/
`ps` foi confirmado nesta máquina Windows específica; variações de locale/
versão do Windows (`netstat` localizado noutro idioma poderia, em teoria,
mudar o texto de `State`, embora o formato de colunas historicamente não
mude) ou distribuições Linux minimalistas sem `lsof` instalado não foram
testadas — ambos já degradam graciosamente para "processo não identificado"
em vez de quebrar, então o pior caso é só "oferece menos informação", nunca
um crash.

**Correção de reentrância (continuação desta seção, `extension-dev`, mesma
data — achado do `code-reviewer` revisando a implementação acima)**: não é
violação de nenhuma decisão registrada, é um gap de reentrância pré-existente
em `SyncController` cuja janela de exposição cresceu muito com a introdução
do diálogo modal `confirmKill` acima (pode ficar bloqueado por tempo
arbitrário no meio do fluxo de start).

- **O bug**: `SyncController.start()`/`restart()`/`setPort()` só bloqueavam
  reentrada checando `this.running`, que só vira `true` DEPOIS que
  `host.startService(...)` resolve. Durante a janela em que o usuário está
  olhando o diálogo "Encerrar processo / Usar porta alternativa"
  (`attemptPortReclaim` -> `host.confirmKill`), `running` continuava `false`.
  Um segundo `SyncTeam: Restart`/`SyncTeam: Trocar porta` disparado nessa
  janela criava um SEGUNDO `SyncServer`/`SyncTeamService`, sobrescrevendo a
  variável de módulo `service` em `extension.ts` — o PRIMEIRO ficava órfão
  (sem ninguém para pará-lo) se o usuário confirmasse a modal antiga depois.
  Exatamente o oposto do objetivo da feature (evitar zumbis de porta).
- **Correção**: campo novo `SyncController.startOperationInProgress`
  (booleano), `true` do início de `start()`/`restart()`/`setPort()` até
  `doStart()` terminar (o que inclui esperar `host.startService` resolver ou
  rejeitar) — mesmo padrão de `refreshInProgress` já usado em
  `extension.ts::runRefreshSync`. Um segundo `start`/`restart`/`setPort`
  disparado enquanto a flag está ligada é REJEITADO com aviso claro
  (`host.info`, mesmo canal que as demais mensagens do controller), nunca
  enfileirado nem executado em paralelo — a checagem acontece ANTES de
  qualquer efeito colateral (antes de `host.stopService()` em `restart`, antes
  de `host.promptForPort()` em `setPort`), então nem o serviço antigo é
  derrubado nem a config é persistida por engano por uma chamada que será
  rejeitada. `restart()`/`setPort()` compartilham um `restartCore()` privado
  (stop+doStart) que NÃO checa a flag de novo (os dois chamadores já a
  seguram; checar de novo rejeitaria a própria chamada em andamento).
  `stop()` não precisou de nenhuma mudança: como `running` permanece `false`
  durante toda a janela de uma operação pendente, o guard `!this.running` já
  existente faz `stop()` cair no caminho idempotente ("já está parado") sem
  chamar `host.stopService()`.
- **Teste** (`vscode-extension/test/syncController.test.ts`, novo describe
  "reentrância durante start/restart/setPort pendente", 5 testes, 253 no
  total — era 248): usa uma Promise controlada manualmente no lugar de
  `host.startService` (mesmo papel que `host.confirmKill` bloqueado
  cumpriria em produção) para simular a janela pendente e confirmar, em cada
  combinação (start↔start, start↔restart, start↔setPort, restart↔restart,
  autostart-silencioso↔start-explícito), que a segunda chamada é rejeitada
  IMEDIATAMENTE (não espera a primeira), `host.startService` é chamado
  UMA única vez, e — nos casos de `restart`/`setPort` rejeitados —
  `host.stopService()`/`host.setConfiguredPort()` nunca chegam a ser
  chamados. Confirma também que a flag é liberada corretamente depois (um
  novo `start()` após a primeira operação terminar funciona normal, não fica
  travado para sempre).
- **Verificação**: `npm run lint` (tsc --noEmit) limpo; `npm run test`
  (vitest run) 253/253 passando; `npm run build` (esbuild) gera os dois
  bundles sem erro.
- **Não testado em VS Code real**: a lógica de reentrância foi validada só
  com `FakeHost` (mesma limitação de sempre para `SyncController` — nenhum
  teste toca `vscode`); o cenário real (segundo comando disparado enquanto o
  `showWarningMessage({modal:true})` de verdade está aberto) não foi
  reproduzido manualmente nesta sessão.

**Correção do sinal `"busy"` (continuação desta seção, `extension-dev`, mesma
data — pedido explícito do usuário, revertendo parcialmente a heurística
original implementada horas antes no mesmo dia)**: `.claude/rules/authority.md`
já foi atualizado pelo usuário (bullet "Matar processo de terceiro") refletindo
esta correção antes de qualquer código ser tocado.

- **O problema com o comportamento original**: `attemptPortReclaim` tratava
  `probeSignal === "busy"` (o `SyncServer` remoto respondeu
  `connectionRejected`/`port_in_use`, prova de que já existe um cliente
  conectado agora) como short-circuit definitivo — retornava
  `{action:"fallback"}` IMEDIATAMENTE, sem sequer chamar `findOwner`/`readLock`/
  `host.confirmKill`. O diálogo nunca aparecia nesse caso.
- **Razão da correção, dada pelo usuário**: mesmo o sinal `"busy"` não é
  certeza absoluta de que há um colega trabalhando de verdade. Uma sessão
  "ativa" no registro do servidor remoto pode, na prática, ser um processo
  fantasma que travou — ex.: o Studio do outro lado crashou/fechou, mas o
  `SyncServer` remoto (rodando na extensão VS Code do colega) ainda não
  detectou a queda porque o timeout de heartbeat (`HeartbeatMonitor`, 15s por
  padrão) ainda não estourou. Nessa janela, `probePortSignal` legitimamente
  observa `"busy"` (o servidor responde `connectionRejected` porque, do PONTO
  DE VISTA DELE, ainda há um cliente registrado) mesmo que aquele cliente já
  não exista de verdade. Negar o diálogo por completo nesse caso tira do
  usuário a chance de recuperar a porta numa situação real de trava.
- **Novo comportamento**: `"busy"` agora segue o MESMO fluxo de
  identificação/confirmação que os outros sinais (`findOwner`/`readLock`
  chamados normalmente) e **sempre** mostra o diálogo quando um PID é
  identificado — com a mensagem MAIS FORTE de todas as variantes (mais forte
  que a de `"respondsWs"` sem identificação, que já existia): deixa claro que
  uma sessão SyncTeam com o plugin do Studio conectado AGORA foi detectada,
  que é MUITO PROVÁVEL que seja um colega de verdade trabalhando (não um
  zumbi), que encerrar pode causar perda de trabalho não salvo de outra
  pessoa, mas que às vezes o processo trava sem o servidor perceber a tempo —
  e pergunta explicitamente se o usuário deseja encerrar mesmo assim.
  `host.confirmKill` continua sendo a ÚNICA porta para `killProcess` rodar
  (nunca automático, nem para este caso) — essa parte não mudou. Se nenhum
  PID puder ser identificado (`findOwner`/lockfile vazios), o comportamento
  permanece "fallback sem diálogo" (nada concreto para oferecer), igual aos
  demais sinais.
- **Precedência de mensagem**: o sinal `"busy"` é checado ANTES de
  `isOwnOrphan` na escolha do texto — mesmo que o lockfile também identifique
  o PID como uma instância órfã do próprio SyncTeam, `"busy"` usa sua própria
  mensagem (mais forte), porque a evidência de sessão ativa agora pesa mais
  que o lockfile (documentado inline em `PortOwnership.ts`).
- **O que NÃO mudou**: a restrição de timing registrada em
  `.claude/rules/authority.md` ("o diálogo nunca dispara enquanto uma
  tentativa de conexão legítima do plugin Studio estiver em andamento naquela
  porta") continua valendo — isso é uma questão do timing do próprio bind
  (`SyncServer.tryListen`/`onPortOccupied`, chamado só na 1ª tentativa da
  porta configurada), não do sinal `"busy"` em si. O resto do fluxo
  (`killProcess`, espera de `isPortFreeCheck` com escalada SIGTERM→SIGKILL)
  também não mudou.
- **Testes** (`vscode-extension/test/portOwnership.test.ts`): o teste único
  anterior (`confirmCalls === 0` para `"busy"`) foi substituído por 4 testes
  novos, describe "attemptPortReclaim": usuário recusa (fallback,
  `confirmCalls === 1`, mensagem contém "CONECTADA AGORA"/"MUITO PROVÁVEL"/
  "PERDA DE TRABALHO NÃO SALVO"); usuário confirma (mata o processo,
  `retrySamePort`); sem PID identificável (fallback sem diálogo,
  `confirmCalls === 0`); e "busy" prevalecendo sobre "zumbi identificado"
  mesmo com lockfile batendo (mensagem de `"busy"`, não a de zumbi). 256 no
  total (era 253 — 1 teste removido, 4 adicionados).
- **Verificação**: `npm run lint` (tsc --noEmit) limpo; `npm run test`
  (vitest run) 256/256 passando; `npm run build` (esbuild) gera os dois
  bundles sem erro.
- **Não precisa de Studio real**: mudança é 100% lógica local (heurística de
  mensagem + fluxo de confirmação), sem novo `[Hipótese]` de Team Create.

### 2. Pasta com `init.luau` vira ModuleScript de fato

Confirmado: hoje a pasta continua sendo criada como `Folder` mesmo depois de
`init.luau` aparecer dentro dela — falta a conversão real. `Folder` e
`ModuleScript` são classes diferentes no Roblox (não dá pra só trocar
`ClassName`); a conversão exige destruir o `Folder` e criar um `ModuleScript`
novo, reparentando os filhos.

- **Decisão**: preservar o UUID existente na conversão — `ScriptRegistry.luau`
  atualiza a entrada existente pra apontar pro novo `Instance`, em vez de
  tratar como delete+create. Lease/presença ativos no uuid sobrevivem à troca.
- **Risco levantado pelo usuário, a tratar junto**: essa é exatamente a
  classe de operação (mudança de estrutura/classe) que já causou bagunça real
  observada — módulos/pastas duplicados aparecendo no VS Code de outro dev
  quando um lado arrasta/reorganiza arquivos. A extensão que grava no disco de
  cada colaborador (`extension-dev`) precisa limpar de verdade o que ficou
  órfão nessa conversão (não só criar o novo `init.luau`, também remover
  arquivos/pastas duplicados que a reorganização deixou para trás do lado de
  quem não fez a mudança).
- **Comentário do usuário, não decisão, backlog de pesquisa**: Roblox
  aparentemente passou a permitir `SetAttribute` com valor Instance (atributo
  apontando pra outra Instance), o que poderia simplificar/substituir o
  esquema atual de `ObjectValue` sob `TestService.SyncTeam` para a identidade
  de script. **Não usar sem confirmação do `researcher`** — a regra de
  identidade atual (`luau.md`: "Proibido usar path ou attributes como
  identidade") foi escrita quando atributos só aceitavam primitivos; se o
  engine mudou, é uma decisão de arquitetura nova, registrada à parte, não um
  ajuste incidental desta tarefa.

**Continuação (`luau-dev`, mesma data) — bug real confirmado e corrigido: ordem
de operações da conversão derrubava o watch de Source dos filhos já
existentes.**

Nesta mesma sessão, o `luau-dev` levantou uma hipótese própria ao reler
`SourceWatcher.resolvePath` (registrada em
`.claude/agent-memory/luau-dev.md`, entrada "Preservação de UUID..."): a
ordem de operações da conversão Folder→ModuleScript/Script/LocalScript
reparentava cada filho (`oldChild.Parent = newInstance`) para dentro de uma
`newInstance` **ainda sem `Parent`**, e só depois anexava `newInstance` à
árvore (`newInstance.Parent = current`). O `researcher` confirmou a hipótese
com fonte oficial
(`.claude/research/2026-08-02-reparent-descendantremoving-semantics.md`,
`Roblox/creator-docs`, `Instance.yaml`):

> `DescendantRemoving`: "fires immediately before the parent Instance changes
> such that a descendant instance will no longer be a descendant."

Como `newInstance` ainda não era descendente da raiz observada no momento em
que cada `oldChild` virava filho dela, cada `oldChild` **deixava de ser
descendente da raiz observada**, mesmo que momentaneamente — batendo
exatamente com a definição oficial. O handler de `DescendantRemoving` em
`scanAndWatch` (`SourceWatcher.luau`) já existia e rodava para esses casos,
chamando `unwatchScript` incorretamente (desconectando o sinal de `Source` e
limpando o dedupe de cada filho). A reconexão via `DescendantAdded` quando
`newInstance.Parent = current` rodava, no final, **não tinha garantia
documentada** de refire individual por descendente pré-existente de uma
subárvore movida de uma vez — só um relato de fórum (não staff), com
ressalva explícita de "não garantido em todos os casos" (ver pesquisa
completa para a citação exata e as fontes).

- **Fix aplicado (`plugin/src/SourceWatcher.luau`, dentro do `pcall` de
  conversão)**: inverter a ordem — `newInstance.Parent = current` roda
  **antes** do loop que reparenta os filhos, não depois. Com `newInstance` já
  dentro da árvore observada, cada `oldChild.Parent = newInstance` passa a
  ser um reparent **direto dentro da mesma árvore já observada** (nunca deixa
  de ser descendente da raiz) — não dispara `DescendantRemoving` e não
  depende de nenhuma garantia de `DescendantAdded` para reconectar nada: a
  conexão de sinal (`watched[oldChild]`) e o registro em `ScriptRegistry` de
  cada filho nunca são tocados, sobrevivem intactos à conversão. Isso
  elimina por completo a dependência do comportamento não-garantido de
  `DescendantAdded` citado acima — não é mais preciso confiar nele para nada
  neste caminho.
- **Trade-off aceito, documentado no código**: mais eventos de replicação
  Team Create (`newInstance` entra vazia na árvore primeiro, depois cada
  filho reparenta individualmente — N+2 eventos em vez de 2) em troca de
  nunca perder o watch de Source dos filhos. A ordem antiga era mais
  econômica em replicação, mas incorreta.
- **Interação pré-existente, não alterada por este fix (documentada em
  comentário no código, não corrigida — fora do escopo)**: se
  `SignalBehavior` for `Immediate`, `DescendantAdded` do root pode disparar
  `watchScript(newInstance)`/`resolveOrAllocate` de forma síncrona dentro do
  `pcall` antes de `ScriptRegistry.reassignInstance(existingUuid, ...)`
  rodar — isso já era verdade na ordem antiga (só que no fim do `pcall`, em
  vez do início) e continua dormant hoje porque `existingUuid` é sempre
  `nil` na prática atual (uma `Folder` pura nunca é registrada). Revisitar
  se `existingUuid` deixar de ser sempre `nil` no futuro.
- **Validação**: `selene plugin/src` → 0 errors/37 warnings (baseline
  mantida, nenhum warning novo). `stylua --check plugin/src/SourceWatcher.luau`
  limpo. `lune run plugin/src/SourceWatcher.luau` erra só na 1ª linha que
  toca `game` (linha 25, `game:GetService`), confirmando que o resto do
  arquivo — incluindo o bloco de conversão editado — compila sem erro de
  sintaxe. **Nada testado em Studio real** — a correção é derivada por
  raciocínio de engine confirmado por pesquisa oficial (alta confiança na
  causa do bug e no mecanismo do fix), mas o comportamento fim-a-fim
  permanece `[Hipótese]` até confirmação em Studio real. Roteiro manual
  sugerido (exige 1 Studio só, sem Team Create):
  1. No Studio, criar uma `Folder` (ex. "Interface") direto no Explorer sob
     um dos containers observados (ex. `ServerScriptService`), com 2-3
     `Script`/`ModuleScript` filhos já dentro dela, e deixar o SyncTeam
     sincronizar normalmente (confirmar os filhos aparecem no VS Code).
  2. Pelo VS Code, criar `init.luau` dentro da pasta correspondente
     (`Interface/init.luau`) — no Rojo isso normalmente promove a pasta a
     `ModuleScript`. Confirmar no Output do Studio a linha `resolvePath:
     convertido 'Interface' de Folder para ModuleScript...`.
  3. **O teste decisivo**: editar o `Source` de um dos scripts que já vivia
     dentro da pasta ANTES da conversão (ex. `Interface/Foo.lua`), agora
     DEPOIS da conversão — pelo Explorer do Studio ou pelo VS Code. Confirmar
     que a mudança ainda propaga (log `sourceChanged` aparece, arquivo
     atualiza no outro lado). Antes do fix, a hipótese era que isso pararia
     de funcionar silenciosamente (watch derrubado, só o polling de
     `checkRegistryDrift` ainda detectaria delete, nunca edição de Source) —
     com o fix, não deveria haver nenhuma lacuna, mesmo sem depender de
     `DescendantAdded`.
  4. Repetir o passo 3 depois de fechar e reabrir o Studio (nova sessão do
     plugin) para garantir que o `watchScript` inicial via
     `ScriptRegistry.reconcile`/`scanAndWatch` também continua cobrindo os
     filhos normalmente.

### 3. Aviso visual de lock no VS Code — tirar o fundo laranja no texto inteiro

Confirmado: `LeaseBorderDecoration.ts` hoje cobre o documento inteiro com
`backgroundColor` laranja translúcido (`isWholeLine` do início ao fim),
parecendo erro no módulo inteiro. **Decisão**: remover esse overlay de fundo;
manter só marcação na overview ruler (já existe, mais discreta) + item na
status bar com o nome de quem tem o lease. Fica documentado que bloqueio de
edição de verdade por editor (impedir digitação/salvar) não existe sem
`FileSystemProvider` próprio — fora de escopo desta rodada, já registrado como
limitação conhecida no topo do próprio arquivo.

**Implementado (`ui-dev`, mesma data, continuação desta seção)**:

- `LeaseBorderDecoration.ts`: o `TextEditorDecorationType` que cobria o
  documento inteiro (`overlayDecoration`, renomeado `rulerDecoration` — deixou
  de "sobrepor" qualquer coisa) perdeu `backgroundColor`/`isWholeLine`; só
  resta `overviewRulerColor`/`overviewRulerLane.Full`, aplicado à MESMA range
  de documento inteiro de antes (o marcador na régua é proporcional a essa
  range). O `hoverMessage` (aviso completo em markdown) continua anexado a
  essa mesma decoração — como `hoverMessage` funciona independente de haver
  `backgroundColor` visível, o usuário ainda vê o aviso completo passando o
  mouse em qualquer linha do arquivo, só sem nenhuma cor brigando com a
  sintaxe. `labelDecoration` (rótulo "🔒 Bloqueado por `<nome>`" no fim da 1ª
  linha) mantido sem alteração — decisão de design deliberada: sem o fundo
  cobrindo tudo, o rótulo pontual deixa de "somar" com um erro genérico e lê
  como um reforço isolado.
- **Item de status bar novo**: `statusBarItem` (campo de
  `LeaseBorderDecoration`, `vscode.StatusBarAlignment.Right`, prioridade 99 —
  logo à direita do item de conexão existente, que usa prioridade 100 em
  `StatusBarItem.ts`; menor prioridade = mais à direita no grupo). Mostra
  `$(lock) <nome do dono>` só quando o arquivo **ATIVO** (não todo editor
  visível — é uma pergunta sobre "o que estou olhando agora") está sob lease
  alheia; oculto via `.hide()` no caso contrário, nunca aparece vazio.
  Recalculado dentro do MESMO `renderAll()` que já roda em toda troca de
  editor/lease — nenhum novo listener em `extension.ts`, o módulo já era
  chamado nos pontos certos (leaseChanged, stop do serviço, troca de
  editor/lista de editores visíveis).
- **Cor reaproveitada, não nova**: `new
  vscode.ThemeColor("statusBarItem.warningBackground")` — a MESMA cor que
  `StatusBarItem.ts`/`statusBarMenu.ts` já usam para o estado "no ar,
  aguardando plugin conectar" — para os dois avisos da status bar
  (conexão incompleta e lease alheia) lerem como a mesma linguagem visual de
  "atenção", em vez de introduzir uma cor nova só para este caso.
- **Lógica pura nova** em `leaseBorderState.ts` (mesmo módulo sem `vscode` que
  já continha `computeLeaseBorderState`/`STRINGS`): `buildLeaseStatusBarVisual(state)
  -> {visible, text, tooltip}` — decide só o empacotamento visual a partir do
  MESMO `LeaseBorderState` que já decidia a decoração de editor (nenhuma
  regra de negócio nova); `STRINGS.statusBarText`/`STRINGS.statusBarTooltip`
  novos, mesmo padrão de strings centralizadas (pt-BR, pronto para i18n
  futura).
- **Testes**: `leaseBorderState.test.ts` ganhou um describe
  `buildLeaseStatusBarVisual` (3 casos: sem lock → oculto/vazio; com lock →
  visível com `$(lock)` e nome; sem `ownerName` → usa `fallbackOwnerName`).
  214/214 testes no total (era 211). `npm run lint` (tsc --noEmit) limpo,
  `npm run build` gera os dois bundles sem erro.
- **Fora de escopo, inalterado**: bloqueio de edição de verdade (impedir
  digitar/salvar) continua sem `FileSystemProvider` próprio — mesma limitação
  documentada no topo do arquivo desde M3.4, não revisitada nesta tarefa.
  **Não testado em VS Code real** (mesma ressalva de sempre para
  `ui/*Decorations.ts`): só tipagem/build/vitest confirmados; roteiro visual
  sugerido para quando o usuário testar — (1) 2 Studios/2 VS Code, um edita
  um script, o outro abre o mesmo arquivo e confirma que NÃO há mais fundo
  laranja cobrindo o texto, só a marca na régua à direita + rótulo no fim da
  1ª linha; (2) confirmar que o item novo na status bar aparece com
  `$(lock) <nome>` e cor de aviso; (3) trocar de aba para um arquivo SEM lock
  e confirmar que o item some (`.hide()`, não fica vazio); (4) lease expira
  por inatividade → confirmar que ruler/rótulo/status bar somem juntos no
  próximo `leaseChanged`.

### 4. Menu de configurações — só no painel do plugin (Studio), não no VS Code

**Decisão**: as novas settings (preferência de posse de porta, intervalo de
atualização de arquivo, intervalo de cursor) vivem exclusivamente na tela de
configurações do `StatusPanel.luau` do lado Studio — VS Code não ganha
settings.json novo nesta rodada. Isso amplia a tela que já existe desde
2026-07-20 (toggle de autostart).

- **Gotcha técnico a resolver na implementação** (`luau-dev`): `plugin:GetSetting`/`SetSetting`
  é GLOBAL à instalação do Studio, não por lugar/place. O pedido do usuário
  foi "setar isso naquele espaço de trabalho do Roblox" (por place) — para
  cumprir isso com o único slot de armazenamento que a API oferece, as
  settings por-place precisam ser uma tabela indexada por `game.PlaceId`
  guardada dentro da MESMA chave `GetSetting` única (mesmo padrão que
  `AUTOSTART_SETTING_KEY` já usa hoje, só que hoje é um valor único global —
  vai precisar virar um mapa `{[placeId] = {...}}`).
- O diálogo de "posse de porta" (item 1) roda do lado da extensão (é ela quem
  faz o bind), não do painel do Studio — não é uma "setting" persistente,
  é uma confirmação pontual por ocorrência; a extensão pode guardar uma
  preferência leve local (`ExtensionContext.globalState`) se fizer sentido na
  implementação, sem precisar de UI de settings própria.

**Implementado (`luau-dev`, mesma data, continuação das seções 2 e 4)**:

#### Seção 2 — preservação de UUID na conversão Folder → ModuleScript

- **`ScriptRegistry.reassignInstance(uuid, newInstance)`** (novo, em
  `plugin/src/ScriptRegistry.luau`): reatribui um uuid JÁ EXISTENTE no
  registry para apontar para uma Instance nova (`InstanceRef.Value =
  newInstance`, mais atualização dos mapas em memória `uuidByInstance`/
  `recordByUuid`), sem alocar uuid novo e sem tratar como delete+create.
  Devolve `false` (no-op) se o uuid é desconhecido. Conectado em
  `SourceWatcher.resolvePath` (`plugin/src/SourceWatcher.luau`): no ramo de
  conversão Folder→Script/LocalScript/ModuleScript (já existente desde
  2026-07-26), captura `ScriptRegistry.getUuid(child)` **antes** de destruir
  a `Folder` antiga; se não-nil, chama `reassignInstance` logo após criar a
  Instance nova — isso faz `watchScript`/`resolveOrAllocate` (chamados logo
  em seguida por `SourceWatcher.writeSource`, dentro de `handleWriteSource`
  modo criação) reaproveitarem o MESMO uuid em vez de alocar um novo.
- **Nota de honestidade, importante para quem revisitar isto**: no caminho
  comum de hoje, uma `Folder` pura (agrupando filhos, sem `init.*`) **nunca**
  tem entrada no registry — só `LuaSourceContainer` é registrado (ver
  `isInstanceWatchable`/`watchScript`). Ou seja, `existingUuid` é sempre
  `nil` na prática atual, e o comportamento observável não muda: a Instance
  convertida ainda recebe um uuid novo, normalmente, via o caminho de sempre.
  A checagem é defensiva/futuro-prova (barata, protege contra qualquer
  cenário em que a Folder convertida já esteja registrada, hoje ou no
  futuro) — implementada porque a decisão do usuário pediu explicitamente
  "preservar o uuid existente", não porque um caso reprodutível disso exista
  hoje.
- **Validação**: `selene plugin/src` → `0 errors, 37 warnings` (mesma
  baseline de antes desta tarefa, nenhum warning novo); `stylua --check`
  limpo nos 3 arquivos tocados. `rojo build` (via
  `Tools/build-and-deploy-plugin.ps1`, `OK - plugin implantado`) + `lune run`
  em `ScriptRegistry.luau`/`SourceWatcher.luau` sem erro de sintaxe (erro
  esperado só na 1ª linha que toca `game`, mesma disciplina de sempre — Lua/
  Luau faz parse do arquivo INTEIRO antes de executar, então um erro de
  runtime linhas abaixo confirma que todo o código novo parseou limpo).
  **Nada testado em Studio real** — fica `[Hipótese]` até o usuário validar
  com o roteiro já registrado em 2026-07-26 (pasta com filhos ganhando
  `init.luau`), mais um passo novo: (5) repetir o cenário com uma lease/
  presença ativa em algum script já existente PRÓXIMO à pasta convertida e
  confirmar que nada quebra (este teste não exercita o caminho
  `reassignInstance` em si, já que ele não é alcançável hoje — serve só de
  não-regressão do fix de 2026-07-26).

#### Contrato exato de sinal plugin → extensão para esta conversão (pedido explícito da tarefa)

**Decisão: reaproveitar `scriptAdded` (mensagem já existente), não criar
`scriptClassChanged` nem reusar `scriptMoved`.** Motivo, em ordem de peso:

1. **Um sinal novo só ajudaria o lado que já sabe**: quem teria a informação
   "antiga vs nova" (className antigo, uuid antigo se houver) é só o Studio
   que processou o `writeSource` que disparou a conversão via
   `SourceWatcher.resolvePath` — mas esse Studio é o mesmo cujo VS Code
   **pediu** a criação (`{path, className}`), então ele já sabe o que fez; o
   `writeAck` de resposta já carrega o uuid final. **O colaborador afetado
   pelo bug relatado (módulo/pasta duplicado) é o OUTRO Studio**, que nunca
   vê a conversão via `resolvePath` — Team Create replica a destruição da
   `Folder` + criação do `ModuleScript` como operações de Instance comuns, e
   o plugin do colaborador só as observa pelo MESMO `scanAndWatch`
   (`DescendantAdded`) que qualquer script novo replicado — um
   `scriptClassChanged` emitido só do lado que converteu NUNCA chegaria à
   extensão do colaborador, que é quem precisa da informação para não
   duplicar. Um novo tipo de mensagem que só serve a um dos dois lados não
   compensa a complexidade de protocolo.
2. **`scriptMoved` está semanticamente errado aqui**: significa "mesmo
   uuid/Instance, path mudou" — o caso comum é o oposto (path IDÊNTICO, já
   que `Name`/`Parent` são preservados na conversão; a Instance/classe é que
   muda).
3. **`scriptAdded {uuid, path, className}` já carrega tudo que o plugin sabe
   de fato** sobre este evento, nos dois lados: `uuid` (novo na maioria dos
   casos hoje — ver nota de honestidade acima; preservado só no caso
   defensivo de `reassignInstance`), `path` (igual ao da `Folder` antiga —
   `Name`/`Parent` preservados), `className` (a classe nova:
   `Script`/`LocalScript`/`ModuleScript`). **Nenhum `scriptRemoved` é ou deve
   ser emitido para a `Folder` antiga** — ela nunca teve entrada no registry
   (não é um "script" sendo removido), então, do ponto de vista da extensão,
   esta conversão é **indistinguível de "um ModuleScript novo com filhos
   apareceu do nada neste path"**.
4. **Recomendação concreta para a tarefa futura de limpeza (`extension-dev`,
   não implementada aqui)**: ao receber `scriptAdded {uuid, path,
   className}` para um `path` que o mapeamento de projeto da extensão JÁ
   conhece com arquivos mapeados estritamente ABAIXO dele (`<path>/...`),
   tratar como promoção pasta→módulo (escrever `<path>/init.<ext>`,
   preservando o que já existe dentro) — a MESMA regra que a extensão já
   precisa ter para qualquer `ModuleScript` que ganhe filhos, seja por esta
   conversão ou por criação genuína já com filhos; **qualquer arquivo-folha
   antigo já existente nesse path exato** (ex.: um `<path>.luau` solto de uma
   representação anterior incorreta) deve ser removido como parte de aplicar
   a promoção. Nenhum campo novo de protocolo é necessário para isso — é
   inferível só com o `scriptAdded` existente + o mapa de projeto que a
   extensão já mantém.

**Risco novo encontrado durante esta análise, NÃO CORRIGIDO nesta tarefa
(fora do escopo pedido — preservação de uuid — e depende de comportamento de
engine não confirmado em `.claude/research/`)**: o comentário de 2026-07-26
em `SourceWatcher.resolvePath` afirma que os filhos reparentados "continuam
válidos sem nenhuma limpeza extra" porque `watched`/`ScriptRegistry` são
chaveados por Instance, não por path. Isso é verdade para a CONEXÃO DE SINAL
em si (`GetPropertyChangedSignal` não se importa com reparent), mas a
re-leitura do código mostra uma interação não considerada: `oldChild.Parent =
newInstance` (dentro do loop de reparent, com `newInstance` ainda FORA da
árvore, já que só é anexada com `newInstance.Parent = current` depois de
todos os filhos já terem sido movidos) dispara `DescendantRemoving` no
`root` observado para cada filho — e `scanAndWatch`'s `DescendantRemoving`
já trata isso: `if watched[descendant] ~= nil then ... unwatchScript(descendant)
end`, que DESCONECTA o sinal de Source e some da tabela `watched` (usada
pelo `pollLoop`). Se `DescendantAdded` **não** refizesse esse registro para
CADA descendente quando `newInstance.Parent = current` finalmente insere a
subárvore inteira de volta (só para a própria `newInstance`, por exemplo),
os filhos ficariam **permanentemente fora do polling/sinal de Source** pelo
resto da sessão do plugin (delete continuaria detectável via
`checkRegistryDrift`, que varre o registry inteiro, não só `watched` — mas
edição de Source nesses filhos pararia de sincronizar). **Isto é
`[Hipótese]`** — depende de exatamente como o Roblox dispara
`DescendantAdded`/`DescendantRemoving` para uma subárvore já populada sendo
reparentada de uma vez (não há confirmação em `.claude/research/`, e a regra
do projeto proíbe codar sobre isso sem essa confirmação). Recomendação:
**tarefa futura separada** — `researcher` confirma a semântica exata de
`DescendantAdded`/`DescendantRemoving` para reparent em massa de subárvore
(dispara por descendente ou só para o nó movido?), e então `luau-dev`
decide entre (a) reordenar a montagem (anexar `newInstance` à árvore ANTES
de reparentar os filhos, evitando o "limbo" fora da árvore que dispara o
`DescendantRemoving` — só que isso reverte a decisão deliberada de
2026-07-26 de "montar fora da árvore primeiro" para minimizar eventos de
replicação intermediários, uma troca real, não de graça) ou (b) re-registrar
explicitamente o watch de cada filho depois da conversão, sem depender do
`DescendantAdded` ambiente. Roteiro de teste sugerido para quando o usuário
tiver Studio disponível: converter uma pasta com um script filho já
sincronizado em `init.luau`, e DEPOIS editar o Source desse filho (via VS
Code ou direto no Studio) — confirmar que a edição ainda propaga
normalmente (se não propagar, o risco acima é real).

#### Seção 4 — API de settings por-place em `Config.luau`

- **`Config.PLACE_SETTINGS_KEY = "SyncTeam_PlaceSettings"`**: único slot
  `GetSetting`/`SetSetting` (GLOBAL à instalação do Studio, como toda setting
  de plugin) guardando um mapa `{[tostring(game.PlaceId)] = {chave =
  valor}}`. As 3 settings globais já existentes (porta/notificações/
  autostart) NÃO mudam — continuam globais; só as NOVAS desta rodada nascem
  por-place.
- **`Config.PLACE_SETTINGS_DEFAULTS`**: tabela `{sourcePollIntervalSeconds =
  Config.POLL_INTERVAL_SECONDS, presencePollIntervalSeconds =
  Config.POLL_INTERVAL_SECONDS}` — as 2 settings expostas ("intervalo de
  atualização de arquivo" e "intervalo de cursor"). **A 3ª setting do pedido
  original ("preferência sobre posse de porta") FICA DE FORA de propósito**:
  a seção 4 já decide que aquele diálogo roda do lado da extensão (quem faz
  o bind da porta), não é uma setting persistente do painel do Studio — fora
  do escopo deste arquivo.
- **3 funções públicas, para `ui-dev` consumir na tela de configurações**
  (nenhuma UI construída aqui, por pedido explícito da tarefa):
  - `Config.getPlaceSettings(pluginObject) -> table` — devolve a tabela
    COMPLETA (as 2 chaves acima) do place atual, já mesclada com os defaults
    para qualquer chave ausente/corrompida. Uso típico: popular a tela de
    settings inteira de uma vez.
  - `Config.getPlaceSetting(pluginObject, key) -> value | nil` — getter de
    uma chave só; `nil` se `key` não é uma das reconhecidas em
    `PLACE_SETTINGS_DEFAULTS` (nunca inventa default para chave
    desconhecida).
  - `Config.setPlaceSetting(pluginObject, key, value) -> ok: boolean, err:
    string?` — escreve UMA chave, fazendo read-modify-write do slot inteiro
    (preserva outras chaves do mesmo place E sub-tabelas de OUTROS places).
    `value == nil` remove a chave (volta ao default na próxima leitura).
    Validação genérica (não hardcoded por nome): chave desconhecida ou
    `value` de tipo diferente do default é rejeitado (`ok=false, err=...`);
    para chaves numéricas (as 2 de hoje), `value <= 0` também é rejeitado.
    Toda a função em `pcall` (regra `.claude/rules/luau.md`).
- **Deliberadamente NÃO feito nesta tarefa (fora do escopo pedido)**: nenhum
  loop de runtime (`SourceWatcher.pollLoop`, `TeamCreatePresence`'s
  `checkPresenceDrift`) foi alterado para LER estas settings — hoje os dois
  continuam usando a constante fixa `Config.POLL_INTERVAL_SECONDS`
  diretamente, sem nenhuma variação por place. As settings expostas aqui são
  hoje "decorativas" até uma tarefa futura fazer esses dois loops
  consultarem `Config.getPlaceSetting` (provavelmente precisando também de
  um jeito de reiniciar o loop quando o valor muda em runtime — não trivial,
  não investigado aqui). Também não construída: a tela em
  `plugin/src/ui/StatusPanel.luau` (`ui-dev`, tarefa separada).
- **Validação**: `selene`/`stylua`/`rojo build`+`lune run` limpos (mesma
  bateria da seção 2 acima, mesmo commit de build/deploy). `Config.luau` não
  toca `game` no nível de módulo (só dentro de funções), então `lune run
  Config.luau` roda sem erro nenhum (nem o "erro esperado" de sempre) —
  confirma que o módulo inteiro, incluindo as novas funções, carrega limpo.
  **Nada testado em Studio real** (não há UI ainda para exercitar
  `GetSetting`/`SetSetting` de verdade) — `Config.resolvePort`/
  `resolveNotificationsEnabled`/`resolveAutoStartEnabled` (padrão idêntico,
  já em produção) dão confiança razoável de que `pluginObject:GetSetting`/
  `SetSetting` funcionam como esperado, mas o par
  getPlaceSettings/setPlaceSetting em si fica `[Hipótese]` até `ui-dev`
  integrar e o usuário testar salvar/reabrir o place.

## 2026-08-02 (2ª rodada) — Fallback automático de porta ocupada em `SyncServer.start()` (implementação real da regra de autoridade)

Implementação concreta do exemplo motivador de `.claude/rules/authority.md`
(entrada anterior, mesma data): "o servidor local tenta abrir uma porta e ela
já está em uso — em vez de só falhar, avisa 'porta X ocupada' e assume outra
rota... e continua". Até aqui `SyncServer.start()` (`vscode-extension/src/sync/SyncServer.ts`)
só fazia `wss.once("error", (error) => reject(error))` — qualquer `EADDRINUSE`
na porta configurada (`syncteam.port`) virava falha visível imediata, sem
nenhuma tentativa de contornar.

**Esquema de fallback escolhido** (deliberadamente simples e documentável):

- Só `EADDRINUSE` aciona fallback. Qualquer outro erro de bind (ex.
  `EACCES`, porta fora do intervalo válido) rejeita imediatamente, sem
  tentativa — trocar de porta não resolveria essas classes de erro.
- Incremento de 1 em 1 a partir da porta configurada: `port+1`, `port+2`,
  ... — nunca aleatório, para o esquema ser previsível/explicável ao
  usuário e reproduzível em log.
- Limite pequeno: **5 tentativas alternativas por padrão**
  (`DEFAULT_PORT_FALLBACK_ATTEMPTS = 5`, ou seja até 6 portas tentadas no
  total contando a original), configurável via `SyncServerOptions.portFallbackAttempts`
  (`0` desliga o fallback por completo, voltando ao comportamento antigo).
- Nunca ultrapassa `MAX_PORT` (65535, `vscode-extension/src/util/port.ts`) —
  se a próxima porta candidata estourar o limite, desiste e rejeita com o
  erro `EADDRINUSE` original, sem tentar uma porta inválida.
- **Nunca mata processo de terceiro** para liberar a porta original — limite
  explícito de `.claude/rules/authority.md`. A porta ocupada continua
  ocupada por quem quer que seja; o SyncTeam só passa a escutar em outra.
- Cada tentativa é logada com clareza (`Logger.error`, mesmo padrão de
  severidade já usado neste arquivo para eventos notáveis/acionáveis — este
  módulo nunca usou `Logger.warn`): a porta ocupada, a próxima tentativa, e —
  na tentativa que dá certo — uma linha explícita dizendo qual era a porta
  configurada, que ela estava ocupada, e qual é a porta REAL agora em uso,
  deixando claro que nenhum processo de terceiro foi encerrado.

**Onde o usuário/o lado do plugin descobrem a porta real**:

- **Notificação visível imediata**: `SyncController.doStart` (`vscode-extension/src/SyncController.ts`)
  agora recebe `actualPort` em `StartServiceResult` (novo campo opcional) e,
  quando difere da porta pedida, mostra uma mensagem distinta e explícita
  (`host.info`, mesmo canal que já mostra "servidor iniciado na porta N"):
  "a porta configurada N estava ocupada — servidor iniciado na porta M
  (fallback automático). Aponte o plugin do Studio para a porta M, ou rode
  'SyncTeam: Trocar porta' / libere a porta N e reinicie para voltar a ela."
- **Estado consultável**: `ConnectionState` (mesmo tipo que a status bar via
  `ui-dev`/`statusBarMenu.ts` já lê através de `getConnectionState()`/
  `onDidChangeConnectionState`) ganhou dois campos novos: `port` passa a
  significar "porta REAL em uso agora" (antes "sempre a porta configurada")
  e `portFallbackFrom?: number` (presente só durante um fallback ativo, com
  o valor da porta originalmente pedida). Como a status bar já existente lê
  `state.port` para montar o texto (`$(circle-filled) SyncTeam :N`) e o
  tooltip, ela **já passa a mostrar a porta real automaticamente**, sem
  nenhuma mudança no lado visual (`StatusBarItem.ts`/`statusBarMenu.ts`, não
  tocados nesta tarefa) — só o dado que chega mudou de significado.
  Sinalizando ao `ui-dev`: `portFallbackFrom` está disponível para uma
  melhoria futura de tooltip/ícone que destaque visualmente "isto é um
  fallback", caso queiram; não implementado agora porque é polish visual,
  fora do escopo desta fatia (lógica + ponto de integração).
- **`SyncServer`/`SyncTeamService`** ganharam `getConfiguredPort()` (sempre a
  pedida) e `getActualPort()` (a real, `null` se parado) — passthrough
  simples, é o que `extension.ts::startService` lê para preencher
  `actualPort` no `StartServiceResult`.
- **Persistência deliberadamente NÃO alterada**: um fallback NUNCA escreve de
  volta em `syncteam.port` — a config do usuário continua intocada. Ao
  próximo start/restart, o SyncTeam tenta a porta ORIGINAL configurada de
  novo (e cai em fallback de novo se ainda estiver ocupada) — decisão
  consciente: mover a config silenciosamente na primeira ocupação transitória
  seria surpreendente, e "ambos os lados sempre veem uma mensagem clara
  quando isso acontece" já cobre a exigência de nunca ser silencioso.

**Testes** (`vscode-extension/test/`, 11 novos, 210 no total — era 199):

- `syncServer.test.ts`, describe "SyncServer — fallback de porta ocupada" (5
  testes, sockets `net`/`ws` REAIS, mesma filosofia de teste já usada neste
  arquivo — nunca mockou `ws`): porta ocupada cai para a próxima livre
  (`getActualPort()` correto, log com o texto exato esperado, servidor
  funcional de fato na porta nova — conecta um cliente ws real); todas as
  tentativas esgotadas rejeita com `EADDRINUSE` sem nenhuma menção a matar
  processo; `portFallbackAttempts: 0` desliga completamente; erro que NÃO é
  `EADDRINUSE` (porta fora do intervalo válido — Node lança sincronamente
  antes até de emitir `error`, então é um jeito determinístico/portável entre
  SOs de provar "não tenta fallback" sem depender de `EACCES` específico de
  Unix) rejeita na hora; respeita `MAX_PORT` (não tenta 65536).
- `syncController.test.ts`, describe "SyncController — fallback automático de
  porta ocupada" (5 testes, `FakeHost`): mensagem distinta com as duas
  portas quando há fallback; mensagem normal quando `actualPort` bate com a
  pedida; falha nunca deixa `portFallbackFrom` setado; `restart()` também
  aciona o mesmo caminho; um start com fallback seguido de outro sem
  fallback limpa `portFallbackFrom` corretamente.
- `syncTeamService.test.ts`, describe "SyncTeamService.getActualPort" (1
  teste, `start()`/`stop()` reais numa porta livre): `null` antes de
  iniciar, igual à porta real depois, `null` de novo após parar.

**Verificação real**: `npm run lint` (tsc --noEmit) limpo; `npm run test`
(vitest run) 210/210 passando (rodei a suíte completa duas vezes para
confirmar que os testes com portas reais não são flaky); `npm run build`
(esbuild) gera os dois bundles (`dist/extension.js`, `dist/run-node-harness.js`)
sem erro. **100% testável com vitest local, sem depender de Studio real** — a
tarefa é puramente de bind de porta local, nada de Team Create envolvido; não
há `[Hipótese]` pendente de 2 Studios aqui.

**Correção pós-revisão (mesmo dia, achado real do `code-reviewer` rodando
teste, não só lendo código)**: `SyncController.stop()` zerava `running` mas
nunca recalculava `currentPort`/`portFallbackFrom` de volta para a porta
CONFIGURADA — depois de um `start()` com fallback (configurada 1400 ocupada,
real 1401) seguido de `stop()`, `getConnectionState()` continuava devolvendo
`port: 1401, portFallbackFrom: 1400` com `running: false`, contradizendo o
próprio doc-comment do campo (`ConnectionState.port`: "enquanto parado, é a
última porta configurada lida") e fazendo a status bar mostrar a porta errada
com o servidor parado. `start()`/`restart()` não tinham o bug porque recalculam
tudo em `doStart` a partir de `getConfiguredPort()`; só `stop()` pulava esse
recálculo. Corrigido em `SyncController.ts::stop()` (`this.currentPort =
this.host.getConfiguredPort(); this.portFallbackFrom = undefined;` antes de
`emitState()`). Teste novo em `syncController.test.ts` (describe "fallback
automático de porta ocupada"): start com fallback → stop() → `getConnectionState()`
devolve a porta configurada original e `portFallbackFrom` undefined.
Achado secundário de baixo risco corrigido junto: `ui/statusBarMenu.ts`
redeclarava sua própria interface `ConnectionState` (com comentário de campo
desatualizado) em vez de importar o tipo de `SyncController.ts` — eliminado
via `import type`/`export type` (structurally já eram compatíveis, então nada
mais mudou). **Verificação**: `npm run lint` limpo, `npm run test` 211/211,
`npm run build` limpo.

## 2026-08-02 — Agentes de revisão/teste (code-reviewer, qa-tester) + regra de autoridade limitada

Pedido do usuário: estender o roster de agentes pra cobrir revisão de código
e testes/tooling de debug, que ainda não tinham dono claro (`luau-dev` e
`extension-dev` já rodam seu próprio teste unitário, mas revisão cross-stack
e tooling de teste do lado Luau ficavam sem agente responsável).

**Decisão: estender, não substituir.** `luau-dev`/`extension-dev`/`ui-dev`/
`researcher` continuam exatamente como estavam — frontend já é coberto por
`ui-dev`, backend já é coberto por `luau-dev` (Studio) + `extension-dev`
(VS Code). Adicionados dois agentes novos:

- `code-reviewer` (`.claude/agents/code-reviewer.md`) — revisa diff/PR nas
  duas stacks contra `docs/DECISIONS.md` e as rules; só relata, nunca corrige.
- `qa-tester` (`.claude/agents/qa-tester.md`) — roda/expande testes e cuida
  do tooling de teste/debug. Lado TS confirmado (vitest, skill
  `.claude/skills/ts-debug-tests/`). Lado Luau pesquisado e confirmado em
  2026-08-02 (`.claude/research/2026-08-02-lune-selene-stylua-testez-luau-tooling.md`,
  skill `.claude/skills/luau-debug-tests/`): Selene+StyLua cobrem lint/format
  de tudo; Lune roda headless só lógica pura sem serviço do Studio (sem
  framework — TestEZ arquivado desde 2024, sem sucessor maduro). Instalação
  via Rokit ainda não feita no repo — pendente confirmação do usuário
  (mudança de máquina fora do repo, limite de `authority.md`).

Nova regra `.claude/rules/authority.md`: agentes ganham autoridade limitada
pra resolver obstáculo recuperável sozinhos (ex.: porta ocupada por instância
travada → avisa e cai pra porta alternativa) em vez de travar pedindo
confirmação a cada obstáculo — nunca pra ação destrutiva/irreversível (matar
processo alheio, instalar tooling novo no sistema), que continua exigindo o
usuário. Motivou também uma tarefa real delegada ao `extension-dev`: hoje
`vscode-extension/src/sync/SyncServer.ts` (`start()`) só falha com erro
visível em `EADDRINUSE`; vai ganhar fallback automático de porta com aviso
claro, sem nunca matar processo alheio.

## 2026-07-29 — Mensagem `watchedRoots`: extensão manda os serviços de topo do projeto ao plugin, em vez do plugin depender de uma lista fixa hardcoded

**Bug real reportado pelo usuário em uso real** (projeto de jogo, não spike):
usuário adicionou um mount point novo ao `default.project.json`
(`ReplicatedFirst/First -> src/first`) e o SyncTeam não criou nada no
workspace correspondente. **Causa raiz**: o plugin Studio (Luau) tem uma lista
FIXA hardcoded de "watched roots" (`plugin/src/Config.luau`,
`Config.getWatchedRoots()`) — os únicos serviços do DataModel que ele escaneia
— e `ReplicatedFirst` não estava nela. Um fix rápido (adicionar
`ReplicatedFirst` à lista fixa) já foi aplicado e deployado para desbloquear o
usuário imediatamente, mas é só um remendo pontual: **qualquer** serviço do
Roblox usado como mount point no `default.project.json` e ausente da lista
fixa do plugin (ex.: `Lighting`, `Teams`, `Chat`, `SoundService`) vai quebrar
do mesmo jeito no futuro.

**Decisão estrutural**: em vez de manter a lista fixa do lado do plugin
sincronizada manualmente com o que cada projeto usa, a extensão VS Code — que
já lê e parseia o `default.project.json` (o plugin roda no sandbox do Roblox e
NÃO tem acesso a filesystem arbitrário) — extrai dinamicamente os serviços de
topo referenciados pelos mount points do projeto ATUAL e manda essa lista ao
plugin logo após o handshake. A tabela fixa do plugin passa a ser só um
FALLBACK para quando essa mensagem não chegar (plugin muito novo/velho,
algum erro) — deixa de ser a fonte de verdade quando a mensagem chega.

### Contrato exato da mensagem `watchedRoots` (interface entre extension-dev e luau-dev)

Esta seção é o contrato que a tarefa seguinte do `luau-dev` deve seguir **sem
precisar re-ler `SyncTeamService.ts` inteiro** — só esta entrada e
`vscode-extension/src/protocol.ts` (interface `WatchedRootsMessage`,
documentada no mesmo arquivo com o mesmo conteúdo abaixo).

- **`kind` exato**: `"watchedRoots"` (string literal).
- **Campo exato**: `roots` — `string[]`. Cada elemento é o nome de um Service
  do Roblox (ex.: `"ReplicatedFirst"`, `"ServerScriptService"`,
  `"StarterPlayer"`) — o **primeiro segmento** do `dataModelPath` de cada
  mount point do projeto atual (ex.: `dataModelPath: "ReplicatedFirst/First"`
  contribui `"ReplicatedFirst"`; `dataModelPath: "StarterPlayer/StarterPlayerScripts/Client"`
  contribui `"StarterPlayer"`). Lista SEM duplicata. Pode ser `[]` (projeto
  sem nenhum mount point válido) — a mensagem é mandada mesmo assim, nunca
  pulada.
- **Direção**: extensão → plugin. Mensagem **espontânea** — sem `requestId`,
  sem resposta/ack esperada (mesmo mecanismo de `ping`/`leaseChanged`/
  `presenceUpdate`, via `SyncServer.sendSpontaneous`/`send` — broadcast para
  todos os plugins conectados quando `multiSync` estiver ligado).
- **Aditiva ao protocolo — NÃO muda `PROTOCOL_VERSION`** (mesmo precedente de
  `ping`/`leaseChanged`/`presenceUpdate`/`connectionRejected`, todos
  documentados em `protocol.ts`).
- **ORDEM exata no ciclo de vida da conexão** (isto é o ponto mais importante
  do contrato): mandada **exatamente uma vez por conexão aceita**, **logo
  depois** que o `hello` do plugin é validado (`protocolVersion` compatível —
  dentro de `SyncServer.handleHello`, que então chama
  `handlers.onClientConnected(message)`), e **ANTES** do primeiro
  `listScripts` da sincronização inicial (`SyncBridge.runInitialSync`,
  disparado a partir do mesmo handler `onClientConnected` de
  `SyncTeamService`). Ou seja, a sequência que o plugin observa é: `hello`
  (que ele mandou) → `watchedRoots` chega → (mais tarde) `listScripts {requestId}`
  chega pedindo a lista de scripts. **O plugin deve terminar de processar
  `watchedRoots` (atualizar sua lista de containers a escanear) antes de
  responder a esse `listScripts`**, para que a resposta já reflita os
  containers corretos.
- **O que o plugin deve fazer com ela** (implementação é tarefa SEGUINTE do
  `luau-dev`, não feita aqui): usar `roots` para decidir quais Services do
  DataModel escanear/observar para scripts sincronizados, **em vez da** tabela
  fixa hardcoded (`Config.getWatchedRoots()`). Essa tabela fixa deve virar só
  um **fallback**: se por qualquer motivo `watchedRoots` nunca chegar (plugin
  conectado a uma extensão mais velha que não manda essa mensagem, erro
  qualquer), o plugin continua funcionando com a lista fixa em vez de travar
  ou não escanear nada.
- **Não confundir com o campo de exibição/log `path`** de outras mensagens —
  `roots` são nomes de Service (ex.: `"Lighting"`), não paths completos de
  instância.

### Onde foi implementado (lado da extensão — feito nesta entrada)

- `vscode-extension/src/mapping/projectMapping.ts`: função pura nova
  `computeWatchedRoots(mountPoints: MountPoint[]): string[]` — extrai o
  primeiro segmento de `dataModelPath` de cada mount, deduplicado, ordem por
  primeira aparição. Testada em `test/projectMapping.test.ts` (7 casos novos,
  incluindo regressão explícita do bug `ReplicatedFirst`).
- `vscode-extension/src/protocol.ts`: interface nova `WatchedRootsMessage
  {kind: "watchedRoots", roots: string[]}`, documentada com o contrato acima.
- `vscode-extension/src/sync/SyncTeamService.ts`: constructor passou a guardar
  `mountPoints` como campo (`private readonly mountPoints`, antes só repassado
  ao `SyncBridge` sem ficar acessível). No handler `onClientConnected` (dentro
  do `setHandlers` do `SyncServer`, construtor de `SyncTeamService`), logo após
  `this.onPresenceReset?.()` e ANTES de `this.enqueueMutation(() =>
  this.bridge.runInitialSync(...))`, chama `computeWatchedRoots(this.mountPoints)`
  e envia via `this.server.sendSpontaneous({ kind: "watchedRoots", roots })`.
- **Testes de integração** (`test/syncTeamService.test.ts`, novo describe
  "watchedRoots enviado no handshake"): socket `ws` real (mesmo padrão de
  `test/syncServer.test.ts`) confirma que `watchedRoots` chega ANTES de
  `listScripts` no handshake real, com os `roots` corretos calculados a partir
  dos mount points passados ao serviço; e que `mountPoints: []` ainda manda
  `watchedRoots` com `roots: []` (não pula a mensagem). 199 testes no total
  (era 191 antes desta entrada — 8 novos: 6 de `computeWatchedRoots` em
  `test/projectMapping.test.ts` + 2 de integração acima). `npx tsc --noEmit`
  limpo, `npm run test` (vitest) 199/199, `npm run build` gera os dois
  bundles sem erro.

### Onde foi implementado (lado do plugin — feito nesta entrada, `luau-dev`)

- **`plugin/src/Config.luau`**: `Config.getWatchedRoots()` deixa de devolver
  só a lista fixa hardcoded — passa a devolver a **UNIÃO** (deduplicada por
  identidade de Instance, já que Services do Roblox são singletons) da lista
  fixa com uma nova lista dinâmica module-level (`dynamicRoots`, `nil` até a
  1ª `watchedRoots` chegar nesta sessão do plugin). Nova função
  `Config.setDynamicWatchedRoots(names: {string}) -> invalidNames: {string}`:
  resolve cada nome via `game:GetService(name)` dentro de um `pcall` — nome
  desconhecido/inválido nunca derruba o plugin, só é pulado e devolvido na
  lista de retorno (para o chamador logar; `Config` em si não loga, mantém o
  módulo livre de `Logger`). `dynamicRoots` **substitui inteiramente** a
  lista dinâmica anterior a cada chamada (cada `watchedRoots` é o snapshot
  completo e atual dos mount points do momento em que a extensão a montou) —
  mas sobrevive a `SourceWatcher.stop()`/`start()` (module-level, mesmo
  padrão de estado persistente do `ScriptRegistry`), então uma troca de porta
  ou reconexão dentro da mesma sessão de Studio não esquece a última lista
  conhecida antes da próxima `watchedRoots` chegar.
- **`plugin/src/SourceWatcher.luau`**: `scanAndWatch(root, myToken)` (antes
  uma closure local DENTRO de `start()`) foi extraída para função
  module-level, guardada por um novo `scannedRoots` (Instance → true,
  zerado em `stop()`) que a torna **idempotente por root** — chamar de novo
  para um root já coberto é no-op, nunca duplica as conexões
  `DescendantAdded`/`DescendantRemoving`. Nova função pública
  `SourceWatcher.applyWatchedRoots(names)`: chama
  `Config.setDynamicWatchedRoots(names)`, loga (via `log`, nível visível —
  raro/uma vez por conexão) cada nome inválido devolvido, e então itera
  `Config.getWatchedRoots()` (já a união fixa+dinâmica) chamando
  `scanAndWatch` só para os roots que `scannedRoots` ainda não cobre — ou
  seja, só escaneia/observa os containers **novos** que a lista fixa não
  cobria. Se `SourceWatcher` não estiver `enabled` no momento (não deveria
  acontecer na prática, ver timing abaixo), só loga em debug e retorna — a
  lista dinâmica já ficou salva em `Config` e será usada no próximo `start()`.
- **`plugin/src/init.server.luau`**: novo caso no dispatch de
  `handleMessage`, entre `listScripts` e `presenceUpdate`, seguindo o MESMO
  padrão aditivo de `ping`/`deleteScript`/`connectionRejected` (comentário
  explícito "não bumpa `Config.PROTOCOL_VERSION`"): valida que
  `message.roots` é uma `table` antes de repassar a
  `SourceWatcher.applyWatchedRoots(message.roots)`; caso contrário loga e
  ignora, nunca lança erro.

**Decisão de timing (escolhida entre as duas opções levantadas no contrato
original desta entrada)**: opção **(b)** — o scan inicial de
`SourceWatcher.start()` continua rodando IMEDIATAMENTE e de forma síncrona
com `Config.getWatchedRoots()` (a lista fixa, ou a dinâmica de uma conexão
anterior desta mesma sessão de plugin), exatamente como antes desta tarefa —
**nenhum timeout/espera nova foi introduzida**. Quando (e se) a `watchedRoots`
chegar, `applyWatchedRoots` só ADICIONA os containers que a lista fixa ainda
não cobria. Motivo da escolha: a opção (a) (atrasar o scan inicial até
`watchedRoots` chegar, com timeout de fallback) introduziria um novo relógio
de espera na conexão inicial só para cobrir um caso que, na prática, já é
raro (a maioria dos mount points de projetos reais cai nos Services fixos
que já eram observados); a opção (b) não arrisca nunca travar/atrasar a
primeira conexão por uma mensagem que uma extensão mais velha nunca vai
mandar, e ainda resolve o caso comum (mount point novo em Service fora da
lista fixa) dentro da MESMA janela de tempo que o contrato exige — o handler
de `watchedRoots` roda de forma inteiramente síncrona (`GetDescendants`/
`Instance.new`/`:Connect` nunca cedem — nenhum `task.wait` no caminho), então
o container novo já está sendo escaneado e observado (e `ScriptRegistry` já
alocou uuid pra qualquer script pré-existente nele) antes do handler
retornar — e como cada mensagem WS já é processada até o fim antes da
próxima (mesma premissa de ordering que todo o resto do dispatch de
`handleMessage` já assume, ex. `connectionRejected` antes do close), o
`listScripts` que a extensão manda logo depois do `watchedRoots` já reflete
os containers novos, cumprindo o contrato sem precisar de nenhuma
sincronização explícita adicional entre os dois handlers.

**Decisão de UNIÃO (fixa ∪ dinâmica), não substituição total**: diferente do
texto do contrato original ("em vez da tabela fixa"), a implementação real
NUNCA remove um container da lista fixa quando a dinâmica chega — só
adiciona os que faltam. Justificativa: remover um container que já estava
sendo observado arriscaria "perder de vista" scripts já conhecidos (uuid já
alocado, possivelmente com lease ativa) só porque o `default.project.json`
do usuário não referencia mais aquele Service no momento exato da mensagem —
um risco desnecessário para o problema real reportado (containers
FALTANDO, nunca containers sobrando). Escanear um Service fixo a mais que o
estritamente necessário é barato (mesmo custo de hoje, já que esses 7
Services já existem e são tocados normalmente em qualquer place).

**Validação**: `rojo build` (via `Tools/build-and-deploy-plugin.ps1`) limpo —
`OK - plugin implantado`; `lune run` nos 3 arquivos tocados
(`Config.luau`, `SourceWatcher.luau`, `init.server.luau`) sem erro de
sintaxe (erro esperado só na 1ª linha que toca `game`, mesma disciplina de
sempre — confirma que todo o código novo, que vem bem depois dessas linhas,
parseou e executou sem erro). **Nada testado em Studio real nesta tarefa.**

**`[Verificado]` (lado da extensão, automatizado) / `[Verificado]` (lado do
plugin, só `rojo build`+`lune run`, sem Studio real) / `[Hipótese]`
(round-trip real)**: o envio da mensagem no ponto certo do handshake e o
cálculo de `roots` estão verificados por teste automatizado com socket real
(lado da extensão). O código do lado do plugin (`Config.setDynamicWatchedRoots`,
`SourceWatcher.applyWatchedRoots`, dispatch em `init.server.luau`) está
implementado e builda/parseia limpo, mas **o cenário real que motivou esta
tarefa — abrir o Studio, adicionar um mount point novo (ex.
`ReplicatedFirst/First`) ao `default.project.json`, reconectar e confirmar
que o SyncTeam cria o arquivo correspondente no workspace SEM precisar
editar `Config.luau` manualmente — ainda depende do usuário validar com um
Studio real.** Roteiro sugerido: (1) com o plugin já implantado (feito nesta
entrada) e a extensão do lado do usuário atualizada com o build desta sessão,
adicionar ao `default.project.json` um mount point apontando para um Service
fora da lista fixa antiga (`ReplicatedFirst`, `Lighting`, `Teams`, etc.);
(2) reconectar (ou abrir o Studio pela 1ª vez) e confirmar no log do plugin
(`Tools/logs/...` ou Output) a linha `"watchedRoots aplicado: +N
container(es) novo(s)..."`; (3) confirmar que o arquivo esperado aparece no
workspace do VS Code sem qualquer edição manual em `Config.luau`; (4) criar
um script novo dentro desse Service pelo Explorer do Studio e confirmar que
ele também sincroniza normalmente (scriptAdded chega, arquivo aparece no
disco).

## 2026-07-27 — Fila FIFO serializa mensagens espontâneas mutantes: corrige duplicação de arquivo em rajada de `scriptMoved` (extensão)

**Bug real reportado pelo usuário em uso real** (projeto de jogo, não spike):
arrastar todos os filhos de uma `Folder` "Server" para dentro de um `Script`
também chamado "Server" (mesmo nível, reparent em massa no Explorer do
Studio) gerou uma rajada de ~30 mensagens `scriptMoved` quase simultâneas
(menos de 1.5s de intervalo entre elas, log do Output do Studio). Resultado:
o `init.server.luau` que deveria ser criado para o Script "Server" (que
ganhou filhos) **nunca foi criado**; em vez disso a pasta antiga ficou
intacta com todo o conteúdo anterior E uma pasta nova aninhada (também
"Server") apareceu com uma CÓPIA de tudo — duplicação de arquivos em disco,
sem a promoção arquivo→pasta acontecer.

**Causa raiz confirmada lendo o código**: `vscode-extension/src/sync/SyncTeamService.ts`,
método `routeSpontaneous`. Para os kinds que mutam estado compartilhado e
tocam disco (`sourceChanged`, `scriptAdded`, `scriptMoved`, `scriptRemoved`),
o dispatch era **fire-and-forget** (`this.bridge.handleXxx(message).catch(...)`,
sem `await`). O handler de mensagem do `SyncServer` (`handleConnection`,
listener `socket.on("message", ...)`) processa cada frame do WebSocket assim
que chega, SEM esperar o handler assíncrono anterior terminar — então uma
rajada de mensagens quase simultâneas disparava múltiplas chamadas
CONCORRENTES a `SyncBridge.handleScriptMoved`/etc., todas lendo/escrevendo os
MESMOS mapas mutáveis (`scripts`/`diskPathByUuid`/`uuidByDiskPath`/
`contentCache`) e fazendo I/O de disco assíncrono intercalado (via
`moveOnDisk`/`recomputeAndApplyLayout`). Cada `recomputeAndApplyLayout`
concorrente rodava sobre um SNAPSHOT parcialmente atualizado de
`this.scripts` (só os uuids cujas mensagens já tinham sido processadas até
aquele ponto tinham o path novo) — a decisão de `hasChildren`/promoção
arquivo→pasta variava entre chamadas concorrentes da mesma rajada,
explicando por que o `init.server.luau` nunca chegou a ser escrito
(nenhuma chamada individual viu o estado final consistente), e o `catch` de
`moveOnDisk` (recupera do `sourceCache` e escreve um arquivo novo no destino
quando o `renameFile` falha porque outra chamada concorrente já moveu o
arquivo antigo) produzia exatamente a duplicação relatada.

**Fix**: fila FIFO assíncrona (`SyncTeamService.enqueueMutation`/`queueTail`,
padrão "mutex por fila" — cada tarefa nova é encadeada em `this.queueTail`
via `.then(task)`, e `queueTail` em si nunca rejeita — `.then(noop, noop)` —
para que um handler que falhe não trave os próximos). Passam pela fila:
`sourceChanged`/`scriptAdded`/`scriptMoved`/`scriptRemoved` (em
`routeSpontaneous`), `notifyLocalFileChange` (chamado pelo watcher de
arquivos — mexe nos MESMOS mapas compartilhados, então uma edição local
concorrente com uma rajada do Studio tem a mesma corrida), `runInitialSync`
(disparado em `onClientConnected`) e `refreshSync()` (comando manual) —
todos mutam o mesmo estado do `SyncBridge` e tocam disco. **Deliberadamente
NÃO entram na fila**: `leaseChanged`/`presenceChanged`/`presenceLeft`/`log` —
nunca tocam `SyncBridge`/disco (só `LeaseTracker`/callbacks de UI/logger),
então enfileirá-los só adicionaria latência artificial a mensagens de alta
frequência (presença/cursor) sem ganho de correção.

**Testes** (`vscode-extension/test/syncTeamService.test.ts`, novo describe
"fila FIFO serializa rajada de mensagens mutantes"): (1) mecanismo puro da
fila — 3 tarefas assíncronas com uma delay proposital e uma rejeição
proposital no meio, confirma ordem FIFO estrita e que uma falha não trava as
seguintes; (2) **regressão do bug real**: dispara 3 `scriptMoved`
reparentando 2 `ModuleScript` + 1 `Script` para dentro de um `Script`
existente, SEM aguardar entre as mensagens (mesma rajada real), contra
`SyncTeamService` real com `NodeDiskIO` num tmpdir — confirma que o `Script`
pai é promovido para `init.server.luau` preservando conteúdo, o arquivo
achatado antigo não sobra, os 3 filhos são materializados dentro da pasta
nova com conteúdo íntegro, os caminhos antigos somem, e nenhuma
pasta/arquivo órfão duplicado aparece; (3) `notifyLocalFileChange` entra na
MESMA fila que `routeSpontaneous` (prova por ordem de log: a mudança local só
começa a ser processada depois do `scriptMoved` concorrente terminar por
completo). 191 testes no total (era 188). `npx tsc --noEmit` limpo, `npx
vitest run --pool=threads` 191/191, `npm run build` gera os dois bundles sem
erro.

**`[Verificado]` (automatizado) / `[Hipótese]` (Studio real)**: o teste
automatizado com mensagens concorrentes simuladas passa de forma
determinística — a correção do mecanismo de fila em si está `[Verificado]`.
O round-trip real (reproduzir a rajada de ~30 `scriptMoved` genuína, arrastando
os filhos de uma Folder para dentro de um Script no Studio de verdade, e
confirmar que `init.server.luau` é criado sem duplicação) continua
`[Hipótese]` — pendente de roteiro manual/2 Studios reais.

## 2026-07-26 — Mitigação de undo (Ctrl+Z) destruindo instances de coordenação sob `TestService.SyncTeam`

**Bug real reportado pelo usuário**: apertar Ctrl+Z (undo) no Studio
reverte/destrói as instances de coordenação do SyncTeam sob
`TestService.SyncTeam` (sessões, heartbeats, leases, presença —
`StringValue`/`IntValue`/`ObjectValue`/`Folder` criadas via `Instance.new` +
`.Parent = ...`), quebrando o plugin e desconectando o usuário. Causa:
qualquer mudança no DataModel feita por um plugin entra no
`ChangeHistoryService` do usuário como uma edição manual qualquer — não é
específico do SyncTeam, é o comportamento padrão documentado da API.

**Pesquisa completa** (obrigatória ler antes de mexer nesta área de novo):
`.claude/research/2026-07-26-changehistoryservice-undo-exclusion.md`. Resumo
das conclusões que moldaram a decisão:

1. **Não existe API oficial pra excluir uma Instance do histórico de
   undo/redo.** `ChangeHistoryService:SetEnabled(false)` desliga o serviço
   GLOBALMENTE e LIMPA todo o histórico do usuário (inviável, afetaria
   qualquer edição concorrente dele no mesmo Studio). `TryBeginRecording`/
   `FinishRecording` fazem o OPOSTO do que se quer aqui: tornam uma mudança
   deliberadamente undo-ável (é como o Rojo real trata os próprios patches de
   sync — caso de uso oposto ao das instances de metadados internos do
   SyncTeam). Pedido de feature explícito para isso existe no DevForum desde
   2023, sem confirmação de lançamento até a data da pesquisa (jul/2026).
2. **Achado colateral que reduz o escopo real do bug**: mudanças em
   `Script`/`LocalScript`/`ModuleScript.Source` são confirmadas por staff da
   Roblox (abr/2026, "Working as Designed") como NUNCA capturadas pelo
   `ChangeHistoryService`. Ou seja, **o Ctrl+Z do usuário nunca reverte código
   sincronizado** — o bug é exclusivamente sobre a árvore de metadados sob
   `TestService.SyncTeam`, não sobre `Source`.
3. **Mitigação de 2 camadas adotada**, nenhuma garantida sozinha — mesmo
   padrão já usado no projeto para `Source.Changed`/detecção de delete
   (`.claude/rules/luau.md`, "fast-path opcional + caminho garantido"):
   - **Camada 1 (fast-path best-effort)**: `instance.Archivable = false`
     gravado ANTES de `.Parent` em toda Instance de coordenação criada sob
     `TestService.SyncTeam`. Relato de comunidade (DevForum, 2022) não
     confirmado por staff — cobertura parcial, um relato mais antigo (2015)
     sugere que mudanças de PROPRIEDADE em cascata podem não ser cobertas,
     só a criação inicial. Tratar sempre como mitigação parcial, nunca como
     solução completa.
   - **Camada 2 (caminho garantido, self-healing reativo)**: escuta
     `ChangeHistoryService.OnUndo`/`OnRedo` (eventos oficiais e documentados
     — só entregam o NOME da ação desfeita/refeita como string, nunca quais
     instances foram afetadas, então não dá pra ser seletivo) e, a cada
     disparo, roda uma checagem de integridade da subárvore
     `TestService.SyncTeam`, recriando o que estiver faltando.

**Implementação**:

- **Camada 1 aplicada em todo `Instance.new(...)` sob `TestService.SyncTeam`**
  nos 5 módulos que criam instances lá: `TeamCreateSchema.luau` (root
  `SyncTeam` + `ROOT_VALUES`/pastas `Scripts`/`Sessions`/`Leases`),
  `TeamCreateElection.luau` (valores de sessão + o próprio Folder
  `Sessions/<clientId>`), `TeamCreateLease.luau` (valores de intent/lease +
  Folders `LeaseIntents`/`LeaseIntents/<uuid>`/`Leases/<uuid>`),
  `TeamCreatePresence.luau` (valores de presença + Folder `Presence`) e
  `ScriptRegistry.luau` (Folder `Scripts/<uuid>` + `InstanceRef`/
  `CanonicalPath`).
- **Camada 2, módulo novo `plugin/src/TeamCreateUndoGuard.luau`**: conecta
  `ChangeHistoryService.OnUndo`/`OnRedo` (cada um em `pcall`,
  `.claude/rules/luau.md`) 1x no boot de `init.server.luau`, FORA de
  `start()`/`stop()` — precisa escutar independente do plugin estar
  conectado no momento (Ctrl+Z pode acontecer a qualquer momento com a place
  aberta). A cada disparo, `task.defer` (coalesce rajadas de undos seguidos
  sem fila/estado extra) chama `checkIntegrity()` (cada chamada em `pcall`
  individual, uma falha não impede as outras) de três módulos, nesta ordem
  (mesma ordem de dependência de `init.server.luau` `start()`):
  - `TeamCreateElection.checkIntegrity()` (novo): reconsulta
    `TeamCreateSchema.ensureRoot()`/`ensureFolder("Sessions")` (mesmo refresh
    que `tick()` já faz a cada pulso) e, se a PRÓPRIA sessão
    (`Sessions/<clientId>`) estiver ausente/destruída, chama
    `ensureOwnSession()` (já existia, reaproveitada — não duplicada). Sem
    isto, um Ctrl+Z que destrua a própria sessão deixaria `tick()` preso pra
    sempre no guard `sessionFolder.Parent == nil` do topo (early return
    silencioso) — heartbeat/eleição param, e `getSessionFolder()` (usado por
    Lease/Presence) passa a devolver `nil` pra sempre.
  - `TeamCreateLease.checkIntegrity()` (novo): corrige um gap JÁ DOCUMENTADO
    desde 2026-07-07 (`.claude/agent-memory/luau-dev.md`, "risco residual
    aceito") — `leasesFolder`/`sessionsFolder`/`rootValues` eram cacheados 1x
    em `ensureContainers()` (guard `if leasesFolder ~= nil then return end`)
    e nunca refeitos depois; se undo destruísse `Leases` (ou a árvore acima),
    o módulo ficaria preso operando sobre uma Instance morta pelo resto da
    sessão do plugin. Fix: força `leasesFolder = nil` (invalida o cache-once)
    antes de chamar `ensureContainers()` de novo. Não recria intents/leases
    individuais — `ensureIntent`/`leaderTick` já os recriam lazily assim que
    os containers voltarem a apontar pra Instances vivas.
  - `TeamCreatePresence.checkIntegrity()` (novo): mesmo gap/fix que Lease
    para `sessionsFolder`. A própria `Presence` não precisa de recriação
    forçada — `updateOwnPresence` já a recria lazily no próximo
    `presenceUpdate` recebido da extensão (alta frequência, a cada
    movimento de cursor).
- **Deliberadamente fora do escopo desta fatia** (a tarefa explicitamente
  limitava a "sessões/heartbeat, leases, presença"): `ScriptRegistry.luau`
  (`Scripts/<uuid>`) e `TeamCreateSchema.luau` (root/`ROOT_VALUES`) ganharam
  só a camada 1 (`Archivable = false`), sem `checkIntegrity()` dedicado.
  Risco residual aceito, documentado no próprio código
  (`ScriptRegistry.createOrAdoptRecord`): se undo destruir
  `Scripts/<uuid>`, a resolução uuid→Instance NESTE Studio continua
  funcionando (`recordByUuid[uuid].instance` já cacheia a Instance real em
  memória, independente da pasta sobreviver), mas a identidade fica sem
  replicar para outro Studio que ainda não a viu. `TeamCreateSchema`/`root`
  já tem reconciliação própria contínua via `TeamCreateElection.tick()` (a
  cada 2s, desde 2026-07-07) — não ficou sem NENHUMA proteção, só sem um
  gatilho dedicado a undo especificamente.

**Validado só por `rojo build` + `lune run`** nos 7 arquivos tocados
(`TeamCreateSchema.luau`, `TeamCreateElection.luau`, `TeamCreateLease.luau`,
`TeamCreatePresence.luau`, `ScriptRegistry.luau`, `TeamCreateUndoGuard.luau`
novo, `init.server.luau`) — sem erro de sintaxe, erro esperado só na primeira
linha que toca `game`/`script.Parent`. Plugin buildado e implantado via
`Tools/build-and-deploy-plugin.ps1` (`OK - plugin implantado`). **NÃO
`[Verificado]`** — mitigação de undo real exige testar Ctrl+Z DE VERDADE
dentro do Studio (ação física, fora do alcance de `Tools/`). Roteiro manual
sugerido:

1. Conectar o plugin normalmente (CONNECT), confirmar sessão/heartbeat
   ativos (painel de status ou `Tools/` lendo o log).
2. No Explorer do Studio, navegar até `TestService.SyncTeam.Sessions.<próprio
   clientId>` e apagar essa pasta manualmente (Delete, não `:Destroy()` via
   Command Bar — precisa passar pelo fluxo normal do Explorer que gera
   undo). **Confirmar que a pasta reaparece sozinha em poucos segundos**
   (dentro de `PULSE_INTERVAL_SECONDS`=2s, via `checkRunModeTransition`... na
   verdade via o tick natural — mas o gatilho relevante aqui é apertar
   Ctrl+Z logo depois do delete, não o delete isolado, ver próximo item).
3. Cenário principal: com o plugin conectado e a sessão criada, fazer uma
   mudança qualquer que dispare undo (ex.: mover uma Instance qualquer no
   Explorer, ou o próprio delete do passo 2) e apertar **Ctrl+Z**. Observar
   se a pasta `Sessions/<clientId>` (ou `Leases/`, ou
   `Sessions/<clientId>/Presence`) é revertida/destruída pelo undo — se
   sim, confirmar que a linha `"integridade: ... ausente (undo/redo?) —
   recriando/recriados"` aparece no log (`Logger.log`, visível no Output e
   via `Tools/`) logo em seguida, e que o plugin CONTINUA funcionando
   (heartbeat/lease/presença voltam a atualizar normalmente, sem precisar
   reconectar).
4. Repetir apertando **Ctrl+Y**/Ctrl+Shift+Z (redo) depois de um undo que
   tenha revertido uma ação NÃO relacionada ao SyncTeam, pra confirmar que o
   guard não causa nenhum efeito colateral negativo em undo/redo comuns do
   usuário (checkIntegrity() sempre no-op quando nada do SyncTeam foi
   afetado).
5. Confirmar a hipótese central da pesquisa: editar o `Source` de um script
   sincronizado, apertar Ctrl+Z — confirmar que o CÓDIGO não é revertido
   (comportamento esperado, "Working as Designed" da Roblox, não é o SyncTeam
   que garante isso).
6. Rajada: apertar Ctrl+Z várias vezes seguidas rapidamente — confirmar que
   não aparece nenhum erro/trava no Output (só o `task.defer`/idempotência
   das checagens absorvendo os disparos).

`[Hipótese]` até o usuário executar o roteiro acima. Se `Archivable = false`
se mostrar sem efeito nenhum (Camada 1 falhar completamente), a Camada 2
sozinha ainda deve ser suficiente para o plugin nunca ficar quebrado de forma
permanente — só pode haver uma janela de alguns segundos entre o undo e a
recriação reativa, nunca uma queda definitiva.

## 2026-07-26 — Bug real corrigido: `init.luau` novo dentro de pasta já existente (Folder virando ModuleScript) falhava com "alvo não é um script"

Usuário reportou: no VS Code, pegar uma pasta que já existia no projeto (já
tinha scripts filhos, então já existia no Studio como uma `Folder` simples
agrupando os filhos) e criar dentro dela um `init.luau` — convenção Rojo:
pasta com `init.luau` faz a PRÓPRIA pasta virar um ModuleScript com Source,
mantendo os filhos dentro. A extensão detecta corretamente e manda
`writeSource` modo CRIAÇÃO (sem uuid) endereçado ao path da pasta com
`className="ModuleScript"`. Erro retornado ao usuário: "SyncTeam: não foi
possível editar '.../init.luau' — alvo não é um script: .../Interface".

**Causa raiz confirmada por leitura de código**: `SourceWatcher.resolvePath`
(`plugin/src/SourceWatcher.luau`), usado só no modo CRIAÇÃO de
`handleWriteSource`, navegava segmento por segmento a partir de `game` e,
para cada segmento, se `current:FindFirstChild(name)` já existisse, SEMPRE
reusava esse child existente — nunca comparava a classe do child com
`createClassName` no segmento final. Como a pasta já existia como `Folder`
(criada antes só pra agrupar os filhos), o loop encontrava essa `Folder` e a
devolvia como resultado; de volta em `init.server.luau`, `Folder:IsA("LuaSourceContainer")`
é `false`, gerando o erro. Sem essa correção, uma pasta com filhos JAMAIS
conseguiria ganhar um `init.luau` pelo SyncTeam — quebra de compatibilidade
com o formato de projeto Rojo (decisão fixa do projeto, CLAUDE.md/ARCHITECTURE.md).

**Fix** (`plugin/src/SourceWatcher.luau`, `resolvePath`): quando o segmento
FINAL do path já existe, um `createClassName` foi passado, a classe do child
existente é diferente de `createClassName` e o child NÃO é já um
`LuaSourceContainer` (ou seja, é uma `Folder` ou similar — nunca converte um
script de uma classe pra outra, isso fica fora de escopo), o child é
CONVERTIDO: cria a Instance nova da classe pedida, copia o `Name`, reparenta
TODOS os filhos atuais da Folder pra dentro da nova Instance, seta o `Parent`
da nova Instance igual ao da Folder antiga, e só então destrói a casca vazia.
Toda a operação em `pcall`, com erro claro em falha (`.claude/rules/luau.md`).
Guard extra `index > 1`: nunca converte o 1º segmento do path (sempre um
Service do DataModel resolvido via `GetService`, nunca uma Folder de projeto)
— proteção defensiva contra um acidente catastrófico, mesmo não sendo um
caminho alcançável na prática (`Config.getWatchedRoots()` nunca produz path
de 1 segmento só).

**Por que não precisou tocar `ScriptRegistry`/limpar nada**: confirmado
lendo `ScriptRegistry.luau` e `SourceWatcher.watchScript`/`isInstanceWatchable`
— só Instances que passam `IsA("LuaSourceContainer")` são observadas/
registradas; uma `Folder` nunca é. A `Folder` convertida nunca teve entrada
no registry, então não há nada pra limpar. Os FILHOS da Folder (scripts já
sincronizados) preservam a MESMA Instance ao serem reparentados (reparent não
recria a Instance) — `ScriptRegistry`/`watched` são chaveados pela Instance,
não pelo path, então continuam válidos sem nenhuma ação extra. Como `Name` e
`Parent` da Folder→script não mudam, o caminho canônico dos filhos nem muda
de string, então o próximo `checkRegistryDrift` (polling) não confunde isso
com um `scriptMoved`.

**Validado só por `rojo build` + `lune run`** em `SourceWatcher.luau` — sem
erro de sintaxe (erro esperado só na 1ª linha que toca `game`, prova que o
resto do arquivo, incluindo a função alterada, parseou/executou até lá sem
erro). Plugin buildado e implantado via `Tools/build-and-deploy-plugin.ps1`
(`OK - plugin implantado`). **`[Hipótese]` até o usuário confirmar em Studio
real** — nada testado contra o engine de verdade nesta tarefa (não há Studio
disponível para automação deste cenário específico: exige criar um arquivo
novo via VS Code apontando pra uma pasta já materializada no Studio). Roteiro
manual sugerido: (1) com um projeto já sincronizado, pegar uma pasta que já
tem scripts filhos e criar `init.luau` dentro dela no VS Code → confirmar que
a `Folder` correspondente no Studio vira `ModuleScript` (ícone muda), o
Source do `init.luau` aparece nela, e os filhos continuam dentro, todos
funcionando normalmente (lease/edição neles continua ok); (2) repetir o
cenário pra `init.server.luau`/`init.client.luau` (deve virar `Script`/
`LocalScript`); (3) confirmar que o script novo (a ex-Folder) aparece
corretamente no colega via Team Create, com uuid próprio; (4) conferir que
uma pasta SEM filhos ganhando `init.luau` (child não existe ainda, cai no
ramo de criação normal, não no de conversão) continua funcionando sem
regressão.

## 2026-07-20 — Toggle real de "Reconectar automaticamente ao abrir a place" no painel do plugin

Pedido do usuário: expor `Config.AUTOSTART_SETTING_KEY`/`Config.resolveAutoStartEnabled`
(`plugin/src/Config.luau`) — já existentes desde 2026-07-16, mas só ligáveis
via `plugin:SetSetting(...)` no Command Bar — como um toggle de verdade na
tela de configurações do painel (`ui-dev`, mesmo mirror visual do toggle
"Mostrar notificações" já existente). **Nenhuma setting nova**: reusa a
mesma chave, mesmo default (`false`/desligado).

**Arquivos tocados**: `plugin/src/ui/StatusPanel.luau` (novo
`AutoReconnectToggle`, `SettingsRow("Reconectar automaticamente ao abrir a
place", ...)` logo abaixo do de notificações), `plugin/src/ui/PluginUI.luau`
(novo `autoReconnectEnabledSource`, inicializado via
`Config.resolveAutoStartEnabled(pluginObject)` dentro de `PluginUI.init`;
`onAutoReconnectToggle` repassado como passthrough puro pro `StatusPanel`),
`plugin/src/init.server.luau` (implementação real do callback dentro do
bloco `PluginUI.init(plugin, {onConnect, onDisconnect, onPortChange,
onAutoReconnectToggle})`), comentários de `Config.luau` atualizados (não
dizem mais "ainda sem UI dedicada").

**Decisão de UX** (pedida explicitamente pelo usuário, diferente do toggle de
notificações — que é preferência passiva): ligar o toggle enquanto
DESCONECTADO tenta conectar JÁ (`task.spawn(start, plugin)`, mesma chamada
que o botão CONNECT usa), respeitando o mesmo guard de Run/Play
(`isInRunOrPlayMode()`, extraído na entrada BUG 1 abaixo, mesma sessão) — se
em Run/Play, só notifica via `Logger.notify`/toast, não conecta. Se já
conectado (`enabled == true`), `start()` se recusa sozinho (idempotência),
então o callback não precisa checar isso explicitamente. Desligar o toggle
só salva a setting (`plugin:SetSetting`) — **não desconecta** uma sessão já
ativa; só afeta o próximo carregamento do plugin/place. Reconectar sozinho
após queda de uma conexão JÁ estabelecida continua sendo automático e
incondicional (`runConnection`/`Config.RECONNECT_SECONDS`), sem relação
nenhuma com esta setting — texto do toggle deliberadamente não menciona esse
caso para não confundir os dois conceitos.

**Validado só por `rojo build` + `lune run`** nos 4 arquivos tocados
(`Config.luau`, `StatusPanel.luau`, `PluginUI.luau`, `init.server.luau`) —
todos param no 1º global Roblox-específico (`game`/`script`), prova de parse
limpo; `Config.luau` roda até o fim sem erro (não toca nenhum global). Build
+ deploy real via `Tools/build-and-deploy-plugin.ps1` feito nesta sessão.
**`[Hipótese]`, não `[Verificado]`**: teste real em Studio (toggle aparece na
tela de configurações, liga/desliga persiste entre reloads, ligar
desconectado conecta na hora respeitando Run/Play, desligar não derruba
sessão viva) pendente de confirmação física do usuário — não dá para
automatizar clique em painel de plugin via `Tools/`.

## 2026-07-20 — Bug real corrigido: delete local não propagava ao Studio (causa raiz do "rename cria module duplicado")

Usuário reportou dois sintomas que pareciam separados: (1) renomear um script
no VS Code fazia aparecer um module NOVO duplicado no VS Code do colega
(o antigo continuava lá); (2) deletar um module no VS Code não deletava a
Instance correspondente no Roblox Studio. Investigação por leitura de código
(sessão principal, sem precisar de agente pra diagnosticar) confirmou UMA
causa raiz só: o protocolo nunca teve mensagem de "deletar" no sentido
disco→Studio. `SyncBridge.handleLocalFileChange` (`vscode-extension/src/sync/SyncBridge.ts`)
já detectava arquivo sumido (`diskIO.readFile` retornando `null`), mas só
logava `"não encontrado (removido?) — remoção local não é propagada ao
Studio nesta versão (M2)"` e retornava — limitação deliberadamente
documentada em `docs/MILESTONES.md` (M2, "fora de escopo desta fatia... fica
para uma fatia de polish depois") que nunca foi implementada. Rename local =
delete do path antigo + create do path novo sem correlação; a parte "criar"
sempre funcionou, a parte "deletar o antigo" nunca chegava ao Studio — daí a
duplicata.

**Achado adicional durante o fix** (fora do escopo original, mas bloqueava o
fix funcionar de ponta a ponta): `vscode-extension/src/extension.ts` nunca
assinava `watcher.onDidDelete(...)` no `FileSystemWatcher` — só `onDidChange`/
`onDidCreate`. Sem isso, uma deleção real nunca chegava a
`handleLocalFileChange` nem pelo caminho antigo (que já detectava `null` via
`readFile`). Corrigido junto.

**Contrato de protocolo novo** (aditivo, não bumpa `PROTOCOL_VERSION` — mesmo
raciocínio já usado para `ping`): requisição extensão→plugin
`{kind:"deleteScript", requestId, uuid}`; resposta plugin→extensão reusa o
kind `writeAck` já existente (`transport.request()`/`SyncServer.request`
correlacionam só por `requestId`, não por `kind`, então não precisou mudar
`SyncServer`) — `{kind:"writeAck", requestId, ok, uuid?, error?}`.

**Lado da extensão** (`extension-dev`, `vscode-extension/src/sync/SyncBridge.ts`):
novo método privado `handleLocalFileRemoved` chamado do ramo `content===null`
de `handleLocalFileChange`. Sem uuid conhecido pro path: nada muda (só limpa
`contentCache`, como já fazia). Com uuid conhecido: respeita a mesma exclusão
de pastas Wally que updates já respeitam (`isInsideExcludedPackageFolder`),
manda `deleteScript`, e no ack `ok=true` limpa `scripts`/`sourceCache`/
`unregisterDiskPath`/`contentCache` (mesma limpeza de `handleScriptRemoved`,
sem chamar `diskIO.deleteFile` de novo). Ack `ok=false` NÃO limpa nada e
aciona `onWriteRejected?.({diskPath, error})`, mesmo shape dos outros
call-sites. `protocol.ts` ganhou o tipo `DeleteScriptRequest` documentado.
Deleção em lote (apagar uma pasta inteira) não precisou de mudança de
arquitetura — `FileSystemWatcher` já entrega um `onDidDelete` por arquivo e o
debounce já é por `relPath` individual. 5 testes novos em
`vscode-extension/test/syncBridge.test.ts` (186/186 passando), `tsc --noEmit`
limpo, `npm run build` (esbuild) sem erro.

**Lado do plugin** (`luau-dev`, `plugin/src/init.server.luau`): novo
`handleDeleteScript(message)`, espelhando `handleWriteSource` modo
atualização — resolve por uuid (`SourceWatcher.resolveByUuid`), bloqueia
pasta vendorizada (`Config.isInsideExcludedPackageFolder`), **checa lease**
(`TeamCreateLease.ensureIntent`+`canWrite`, decisão deliberada: mesma
checagem que updates já fazem, para não deixar um dev destruir um script que
outro tem lease ativa de edição no momento) e só então `pcall(instance.Destroy)`.
Não precisou limpar `ScriptRegistry` nem emitir `scriptRemoved` manualmente —
o ciclo de polling que já existe (`checkRegistryDrift`/
`ScriptRegistry.isInstanceDestroyed`) detecta a Instance destruída sozinho
dentro de `Config.POLL_INTERVAL_SECONDS` (0.5s) e emite `scriptRemoved` pro
MESMO caminho que delete feito direto no Studio já usa — é isso que propaga a
remoção pro colega (Team Create replica o `Destroy()`). Log do
sucesso/erro mantido em `Logger.log` (visível), não `Logger.debug` — decisão
deliberada: delete é raro/consequente, diferente do `writeSource`
update/create que a tarefa irmã do mesmo dia acabou de rebaixar por ser
rotineiro. `rojo build` + `lune run` limpos; buildado e implantado via
`Tools/build-and-deploy-plugin.ps1`.

**O que continua fora de escopo, deliberadamente**: rename "de verdade" com
preservação de UUID do lado do disco (correlacionar um delete+create como um
único `scriptMoved`, como o Studio→disco já faz desde M2) não foi
implementado — continua sendo delete+create sem correlação, uuid antigo
morre e um novo nasce. O fix desta entrada já resolve o sintoma prático
(duplicata/órfão desaparecem), mas a identidade do script não sobrevive a um
rename feito no VS Code. Fica registrado como possível fatia de polish
futura, não bloqueante.

**Validado só por build + testes automatizados dos dois lados** (`rojo
build`+`lune run` no plugin; `tsc --noEmit`+`vitest`+`esbuild` na extensão) —
nada testado em Studio real nesta tarefa. Fica `[Hipótese]` até o usuário
confirmar o roteiro: (1) deletar script sincronizado no VS Code → Instance
some no Studio em ~0.5-1s → colega recebe a remoção; (2) tentar deletar
script dentro de `Packages/`/pasta vendorizada → bloqueado; (3) tentar
deletar com lease ativa de outro dev → negado; (4) renomear um script → só o
novo aparece no colega, sem duplicata.

## 2026-07-20 — BUG 1: botão CONNECT sem guard de Run/Play + guard de idempotência em start(); BUG 2: mais ruído de uso contínuo rebaixado a Logger.debug

**Contexto**: usuário relatou o plugin "parecendo que estava executando em
run-time (dando F8)". A entrada de 2026-07-16 ("Guard para não rodar sync
durante F8 Run / F5 Play") só cobre a TRANSIÇÃO edição->Run/Play detectada por
polling (`checkRunModeTransition`) — não cobre nascer JÁ em Run/Play. O
autostart no fim do arquivo já tinha essa checagem desde sempre, mas o botão
CONNECT do painel (`onConnect`, M4.5) NUNCA teve guard nenhum — documentado
explicitamente como "fora de escopo" no comentário da tarefa de 2026-07-16.
Isso deixou de ser aceitável na MESMA sessão de 2026-07-16 que tornou o
autostart opt-in/default OFF: CONNECT manual virou o fluxo normal, não mais um
atalho raro. Se o dev clicasse CONNECT já em Run/Play (plugin recarregado
durante um teste em andamento, ou clique acidental depois de já ter apertado
F8), `start()` rodava livre e o guard de TRANSIÇÃO nunca via a transição
edição->Run/Play (o sync já nascia dentro do Run/Play) — sync ficava ativo o
teste inteiro. Bate com o sintoma relatado.

**Fix (BUG 1)**, `plugin/src/init.server.luau`:

1. Extraída a condição duplicada `RunService:IsStudio() and
   RunService:IsRunning()` (antes repetida em `wasInRunOrPlayMode` e no fim do
   arquivo antes do autostart) para uma função única module-level:
   `local function isInRunOrPlayMode() return RunService:IsStudio() and
   RunService:IsRunning() end`, definida antes de `wasInRunOrPlayMode` (que
   passou a usá-la na inicialização).
2. **Padrão escolhido**: guarda em CADA ponto de entrada de `start()`, não só
   dentro de `start()` — decisão registrada em comentário no código.
   `start()` ganhou a MESMA checagem como **defesa em profundidade**, no mesmo
   estilo da guarda de idempotência já existente ali (`if enabled then ...
   return end`) — cobre qualquer chamador futuro que esqueça de checar antes,
   e só loga (`Logger.log`, sem toast, porque não sabe o CONTEXTO da chamada).
   `onConnect` (botão CONNECT) ganhou a MESMA checagem ANTES de chamar
   `start()` — não só porque é defesa redundante, mas porque só este
   call-site sabe que é uma ação EXPLÍCITA do usuário e por isso usa
   `Logger.notify` (toast), mesmo padrão dos outros pontos M4.5 que notificam
   recusas (ex.: lease negada): "CONNECT ignorado: Studio em modo Run/Play
   (F8/F5); conecte após voltar para edição normal." O autostart no fim do
   arquivo passou a chamar a função extraída em vez de repetir a condição
   inline (sem mudança de comportamento ali, só remoção de duplicação).
   `checkRunModeTransition` (guard de transição) também passou a usar a
   função — variável local interna renomeada de `isInRunOrPlayMode` (colidia
   com o nome da nova função) para `nowInRunOrPlayMode`.

**Limitação conhecida herdada, não resolvida** (mesma da entrada de
2026-07-16): quando o teste é PAUSADO, `IsRunning()`/`IsEdit()` ficam ambos
`false` — o guard de transição pode falso-negativo. Não mexido aqui, aceito
como antes.

**Fix (BUG 2)**, ruído de USO CONTÍNUO (não só boot) rebaixado a
`Logger.debug` — mesmo padrão já aplicado a ruído de BOOT em 2026-07-16, agora
estendido a eventos por-evento/por-script que disparam durante edição normal:

- `TeamCreateLease.luau`: "lease concedida", "lease liberada", "leaseChanged",
  "lease intentSequenced".
- `TeamCreatePresence.luau`: "presenceChanged" (dispara a cada movimento de
  cursor/seleção) e "presenceLeft" (os DOIS gatilhos — presença zerada e
  sessão removida; ambos disparam também por timeout/fechamento normal de
  arquivo, não só saída real).
- `TeamCreateElection.luau`: "joinSequence atribuído".
- `SourceWatcher.luau`: "sourceChanged" (dispara a cada edição de Source,
  tanto via sinal quanto polling).
- `init.server.luau`: "writeSource (update) uuid=... -> ..." e "writeSource
  (create) '...' -> uuid=...", os dois caminhos de SUCESSO/detalhe (dispara a
  cada escrita vinda do VS Code) — os early-returns de ERRO (uuid desconhecido,
  bloqueio de pasta vendorizada) continuam `Logger.log`, por serem
  raros/acionáveis, não rotina.

**Explicitamente NÃO tocado** (mesmo critério "rotineiro/alta frequência =
debug; raro/acionável = log" já usado em 2026-07-16): mudança de liderança
("sou o líder agora"/"líder atual"), lease negada (já `Logger.notify`), erros
genuínos, linhas de porta ocupada/candidatas esgotadas, "removendo sessão
obsoleta" (heartbeat stale, raro/diagnóstico), e as linhas do guard de F8/Play
("F8/F5 (Run/Play) detectado..."/"retorno ao modo de edição detectado...").
Mensagens nativas do próprio Studio ("dev_X joined live editing session.",
"Unable to load plugin icon: ...") não são geradas pelo nosso código — fora de
alcance, não tocadas.

**Validado só por `rojo build` + `lune run`** nos 5 arquivos tocados
(`init.server.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
`TeamCreateElection.luau`, `SourceWatcher.luau`) — sem erro de sintaxe, erro
esperado só na primeira linha que toca `game`/`script`/`plugin`. Plugin
buildado e implantado via `Tools/build-and-deploy-plugin.ps1` (`OK - plugin
implantado`), pronto para o usuário testar. **`[Hipótese]` até o usuário
confirmar em Studio real**: nenhum dos dois bugs pode ser testado sem apertar
F8/F5 fisicamente dentro do Studio (`Tools/` automatiza build/deploy/log, não
input físico — ver `Tools/README.md`). Roteiro manual:

1. **BUG 1**: com o plugin conectado (CONNECT clicado), apertar F8 (Run) ou F5
   (Play) — sync deve suspender (`stop()`, log "F8/F5 (Run/Play)
   detectado..."). Sair do Run/Play — sync deve retomar sozinho (comportamento
   já existente, não mudou). Cenário NOVO a testar: apertar F8/F5 PRIMEIRO
   (sync desconectado), e SÓ DEPOIS clicar CONNECT enquanto ainda em Run/Play
   — esperado: toast "CONNECT ignorado: Studio em modo Run/Play..." e o botão
   NÃO deve virar "connecting"/"connected". Sair do Run/Play e clicar CONNECT
   de novo — deve conectar normalmente.
2. **BUG 2**: com 2 Studios reais editando por alguns minutos (cursores se
   movendo, scripts sendo salvos), confirmar que o Output do Studio não mostra
   mais rajadas de "lease concedida"/"leaseChanged"/"presenceChanged"/
   "sourceChanged"/"writeSource" por evento — só as linhas que continuam
   `Logger.log` (conexão, liderança, lease negada, etc.). Observabilidade via
   `Tools/` (WS forward) deve continuar mostrando TUDO, inclusive o que virou
   `Logger.debug` — só o Output visual do Studio muda.

## 2026-07-16 — Autostart passa a ser opt-in, default DESLIGADO

**Mudança de comportamento padrão, pedida pelo usuário após teste real.** Até
esta entrada, `plugin/src/init.server.luau` chamava `start(plugin)`
incondicionalmente ao carregar (só sujeito ao guard de Run/Play) — o dev não
tinha como optar por conectar manualmente. Novo padrão: `Config.AUTOSTART_SETTING_KEY
= "SyncTeam_AutoStart"` + `Config.resolveAutoStartEnabled(pluginObject)`
(`plugin/src/Config.luau`), default **false** (deliberadamente o OPOSTO de
`Config.resolveNotificationsEnabled`, que é default true) — o comportamento
padrão agora é o dev clicar em CONNECT no painel quando quiser sincronizar.
Auto-start incondicional só volta a acontecer se alguém ligar a setting
explicitamente via `plugin:SetSetting("SyncTeam_AutoStart", true)` pelo
Command Bar (sem UI dedicada nesta fatia — mesmo padrão histórico de
`PORT_SETTING_KEY` antes de ganhar campo no painel). O botão CONNECT do painel
(M4.5) já cobria conexão manual antes desta mudança; nada novo precisou ser
criado ali.

## 2026-07-16 — Consolidação de log de boot (Logger.debug)

**Ruído reportado pelo usuário**: cada conexão gerava uma rajada de ~7 linhas
de subsistema no Output do Studio (`registry reconciliado`, `observação
iniciada`, `sessão criada`, `leases: ciclo iniciado`, `presença: ciclo
iniciado`, `conectado em ...`, `iniciado. Conectando...`), sem diferenciação
de nível. Fix: novo `Logger.debug(...)` (`plugin/src/Logger.luau`) — mesmo
forward por WS de `Logger.log` (observabilidade de teste automatizado via
`Tools/README.md` continua intacta), mas **sem** `print()` no Output do
Studio. As 7 linhas acima (em `ScriptRegistry.luau`, `SourceWatcher.luau`,
`TeamCreateElection.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
`init.server.luau`) foram rebaixadas para `Logger.debug`. Em troca, uma ÚNICA
linha `Logger.log` nova aparece quando a conexão de fato **estabiliza**
(dentro de `runConnection`, no mesmo ponto em que o botão vira "connected"):
`"conectado em ws://... (N scripts observados)"` — contagem via
`SourceWatcher.getWatchedCount()` (novo). O log antigo `conectado em %s`, que
disparava OTIMISTICAMENTE assim que o `WebStreamClient` era criado (antes de
saber se ia dar `ConnectFail`), também virou `Logger.debug` — ele descrevia
uma tentativa, não uma conexão de fato estabelecida, e podia aparecer 3x
seguidas mesmo sem nunca conectar de verdade (era um dos sintomas do log colado
pelo usuário). Resultado: as únicas linhas visíveis relacionadas a conexão
agora são "conectado em ... (N scripts)" (1x por conexão real), "desconectado;
reconectando em Xs" (1x por queda, já existia) e as linhas raras de porta
ocupada/candidatas esgotadas (já existiam, mantidas — não são ruído rotineiro).
`erro WS <code> <msg>` também virou `Logger.debug` (era redundante com
"desconectado; reconectando", que já é a linha visível da categoria
"reconectando"). Mensagens de mudança de liderança (`sou o líder agora (term
N)`) e o lado de `stop()` (`observação parada`, `sessão removida`, etc.) NÃO
foram tocados — são eventos raros/relevantes de verdade, não ruído rotineiro
de boot, e o lado de `stop()` em particular tem valor de diagnóstico (ver
entrada abaixo).

**Validado só por `rojo build` + `lune run`** nos 8 arquivos tocados
(`Config.luau`, `Logger.luau`, `SourceWatcher.luau`, `ScriptRegistry.luau`,
`TeamCreateElection.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
`init.server.luau`) — sem erro de sintaxe. Roteiro de teste real pendente:
conectar em Studio real e confirmar que o Output mostra só a linha consolidada
de "conectado" (mais scripts observados) em vez da rajada antiga.

## 2026-07-16 — Investigação do `stop()` sem log de Run/Play (prioridade rebaixada)

Usuário reportou plugin "parando sozinho" (sequência completa `observação
parada`/`leases: ciclo parado`/`presença: ciclo parado`/`sessão removida`/
`parado.` no meio de um teste, sem a linha `"F8/F5 (Run/Play) detectado..."`
que o guard de Run/Play sempre loga antes de chamar `stop()` — ver entrada
acima de 2026-07-16 sobre esse guard). Investigação por leitura de código
descartou: (a) o guard de Run/Play (confirmado ausente no log, único chamador
que teria logado algo antes), (b) `onPortChange`/troca de porta (usuário não
mexeu na porta), (c) clique real em DISCONNECT (nenhum caminho encontrado em
`PluginUI.luau`/`StatusPanel.luau` onde o painel dispararia `Activated` do
botão CONNECT/DISCONNECT sozinho — os únicos handlers de `Activated`
encontrados são conexões estáticas de sinal, criadas 1x no mount, sem
recriação/reentrância espúria localizada). Candidato mais plausível **não
totalmente confirmado**: `plugin.Unloading:Connect(stop)` disparando por um
REDEPLOY do plugin (`Tools/build-and-deploy-plugin.ps1`/`.sh` sobrescreve o
arquivo em `%LOCALAPPDATA%\Roblox\Plugins`, o que o Studio detecta como
reload — `plugin.Unloading` dispara para a instância antiga do script,
independente de o Studio ter fechado) — isso bateria com o timing observado
(shutdown completo e síncrono, sem log de motivo). **Prioridade rebaixada pelo
usuário**: confirmou que o servidor da extensão VS Code estava desligado
durante o teste, o que já explica o ciclo `conectado`→`erro WS 400
ConnectFail`→`reconectando` como comportamento esperado (plugin tentando
conectar sem ninguém escutando) — não é mais bug prioritário. Fica
`[Hipótese]`, sem instrumentação adicionada nesta tarefa (não pedida); se
reaparecer, a forma mais barata de confirmar é logar `debug.traceback()` (ou
um marcador textual simples) no topo de `stop()` na próxima ocorrência.

## 2026-07-16 — Silenciar "descartado (sem conexão): log" duplicado no boot

Ajuste de verbosidade, não decisão de arquitetura. Usuário reportou ruído real
(log colado do Output do Studio): nos primeiros segundos antes do WS conectar,
toda linha de log normal do boot vinha seguida de uma linha extra `descartado
(sem conexão): log`, dobrando a quantidade de linhas. Causa: `sendMessage`
(`plugin/src/init.server.luau`) avisa "descartado" para QUALQUER `kind`
descartado por falta de conexão — inclusive `kind == "log"`, que é o próprio
`Logger.log` se auto-encaminhando pela conexão WS (ver `Logger.luau`); o
conteúdo já apareceu no Output via `print()` dentro do próprio `Logger.log`,
então avisar de novo que o encaminhamento falhou é redundante, não uma falha
relevante. Fix: `sendMessage` só imprime o aviso "descartado (sem conexão):
<kind>" quando `message.kind ~= "log"` — mensagens de protocolo reais
(`scriptAdded`, `presenceUpdate`, etc.) continuam avisando normalmente quando
descartadas por falta de conexão, porque isso ainda é informação útil para
depurar por que algo não chegou na extensão. Comportamento de erro de envio
real (`falha ao enviar: ...`) não foi alterado.

## 2026-07-16 — Guard para não rodar sync durante F8 Run / F5 Play no Studio

**[Verificado] via pesquisa de API** (não teste em Studio real, ver
`.claude/research/2026-07-16-runservice-isstudio-isrunning-plugin-detect-test.md`):
`RunService:IsStudio()` sozinho NÃO distingue edição normal do Team Create de
um teste rodando dentro do próprio Studio — fica `true` nos dois casos. A API
correta é `RunService:IsRunning()` (inverso de `IsEdit()`): edição normal =
`IsRunning() == false`; F8 Run ou F5 Play = `IsRunning() == true`. Condição
adotada em `plugin/src/init.server.luau` para "devo sincronizar":
`RunService:IsStudio() and not RunService:IsRunning()`.

**Onde foi plugado**: novo loop próprio em `init.server.luau`
(`checkRunModeTransition`, `task.spawn` dedicado, polling a cada
`Config.POLL_INTERVAL_SECONDS` — reaproveitado o mesmo intervalo já usado para
o polling de Source, sem inventar timer novo) detecta a TRANSIÇÃO de edição
para Run/Play (chama `stop()`) e de volta (chama `start(plugin)` de novo, só
se foi este guard quem parou — flag `runGuardStoppedSync`). Checagem só no
boot não bastaria: o dev pode apertar F8/F5 depois do plugin já estar
conectado. O auto-start no fim do arquivo também ganhou a mesma checagem (não
inicia automaticamente se o script carregar já em modo Run/Play).

**Limitação conhecida, aceita, não resolvida**: quando o teste é PAUSADO, a
doc oficial afirma que `IsRunning()` (e `IsEdit()`) ficam ambos `false` — ou
seja, este guard pode falso-negativo (achar que voltou para edição normal
enquanto o teste só está pausado) e retomar o sync indevidamente durante uma
pausa de teste. Não há solução limpa documentada para isso (a pesquisa citada
não encontrou confirmação de comportamento de plugin real nesse caso
específico) — tratado como limitação conhecida, não uma tentativa de hack.

**Validado só por `rojo build` + `lune run`** em `init.server.luau` — sem erro
de sintaxe, erro esperado só na primeira linha que toca `game`. Nada testado
em Studio real nesta tarefa (transição de fato ao apertar F8/F5, comportamento
durante pause) — fica `[Hipótese]` quanto ao comportamento em runtime real até
o usuário confirmar.

## 2026-07-16 — Bug real corrigido: materialização inicial duplicava `.lua` já existente em `.luau` novo

**[Verificado]** — confirmado testando com Wally de verdade em Studio, contra
um place que já tinha pacotes instalados via `wally install` puro (extensão
`.lua`, antes do SyncTeam existir no workspace). Causa raiz:
`recomputeAndApplyLayout` (`vscode-extension/src/sync/SyncBridge.ts`) usa
`computeLayout` (`rojoPathMapping.ts`), que por decisão de projeto SEMPRE
escolhe extensão `.luau` na escrita — e a primeira materialização de um uuid
ainda sem `diskPath` conhecido nunca checava se já existia em disco um `.lua`
correspondente (mesmo diretório, mesmo nome-base) antes de decidir onde
escrever. Resultado: uuid cujo script já tinha `Nome.lua`/`Nome.server.lua`
etc. em disco (de uma instalação Wally anterior, fora do SyncTeam) ganhava um
`.luau` extra ao lado — duplicata real do mesmo script em dois arquivos,
deixando o `.lua` original órfão (não deletado, só abandonado).

**Fix**: `SyncBridge.resolveInitialDiskPath` — chamado só na materialização
INICIAL (`recomputeAndApplyLayout`, ramo `previous === undefined`, ou seja
`diskPathByUuid.get(uuid) === undefined`). Antes de escrever no `diskPath`
`.luau` computado, checa via `DiskIO.readFile` se o `.lua` equivalente
(`diskPath.replace(/\.luau$/i, ".lua")`) já existe; se existir, reaproveita
esse caminho como o `diskPath` do uuid em vez de criar o `.luau` novo. Se não
existir, comportamento anterior é preservado (`.luau`, como sempre). Escopo
deliberadamente restrito a essa primeira materialização — `moveOnDisk`/rename
de scripts já sincronizados (`handleScriptMoved`) não foi alterado, é
comportamento fora de escopo desta correção (regra geral "escrita sempre
`.luau` para arquivos NOVOS de verdade" continua valendo).

Testes: `vscode-extension/test/syncBridge.test.ts`, describe
"materialização inicial reaproveita .lua pré-existente (2026-07-16)" — uuid
novo com `.lua` pré-existente reaproveita sem criar `.luau` duplicado; uuid
novo sem nada em disco continua materializando `.luau` normalmente (sem
regressão). 181/181 testes (`npx vitest run --pool=threads`), `tsc --noEmit`
e `npm run build` limpos.

## 2026-07-16 — Rejeitado: auto-editar `wally.toml` do colega ao detectar pacote novo replicado

**Decisão pendente resolvida como "não fazer" por ora** (usuário pediu
avaliação de custo antes de decidir). Ideia avaliada: quando um pacote novo
aparece no Studio compartilhado via Team Create (alguém instalou via Wally),
o SyncTeam do lado de quem RECEBE detectaria "isso é um pacote Wally" (via
metadado novo em `TestService.SyncTeam`) e escreveria automaticamente a
entrada correspondente (`alias = "author/repo@version"`) no `wally.toml`
local do colega, evitando que o próximo `wally install` dele apague o
arquivo recebido (ver decisão acima).

**Por que não**: exigiria (1) schema novo de metadados só pra isso — alias
real só existe no `wally.toml` de quem instalou, não é 100% derivável do
nome da pasta `_Index`; (2) parser/writer de TOML de verdade do lado da
extensão (edição ingênua por string arrisca reproduzir bug de chave
duplicada real já encontrado no `wally.toml` de teste do usuário, ver
`Packages` do projeto `StudioSync/Studio1`); (3) tratamento de conflito
(arquivo aberto/sujo no editor do colega, versão já declarada diferente,
merge com git). Custo desproporcional ao ganho (economiza uma frase em
chat). **Alternativa aceita**: comunicação manual — quem instala pacote novo
avisa o time pra rodar `wally install` também. Revisitar só se isso virar
dor recorrente de verdade (múltiplos devs, múltiplos incidentes).

## 2026-07-16 — Pastas de pacotes Wally (`Packages`/`ServerPackages`/`DevPackages`) excluídas do live edit sync

**Risco de arquitetura identificado e aprovado pelo usuário** (não é
experimental — decisão já implementável): `Config.getWatchedRoots()`
(`plugin/src/Config.luau`) e o observador genérico de Source
(`SourceWatcher.luau`) tratavam QUALQUER `ModuleScript` igual, incluindo os
instalados via Wally (https://wally.sh) dentro de pastas `Packages`/
`ServerPackages`/`DevPackages` (convenção padrão do gerenciador — `Packages`
é a mais comum, mas projetos podem ter as 3, separando dependências por
lado). Isso é um problema real: se dois devs tiverem `wally.lock`/`Packages/`
locais divergentes (versão desatualizada de um lado), o SyncTeam podia
empurrar o Source do pacote vendorizado de um dev pro Team Create
compartilhado, alterando silenciosamente a dependência de TODOS os devs —
pacote vendorizado nunca deveria ser editado via editor colaborativo ao vivo.

**Escopo exato da exclusão** (não é exclusão total):

- Pastas cujo `Name` seja exatamente `Packages`, `ServerPackages` ou
  `DevPackages`, em qualquer profundidade dentro dos watched roots (não só
  na raiz), marcam tudo abaixo delas como "vendorizado".
- **Bloqueado nos dois sentidos**: (a) `checkSourceChanged` em
  `SourceWatcher.luau` nunca emite `sourceChanged` para scripts vendorizados
  (nunca puxa Studio→disco uma edição neles); (b) `handleWriteSource` em
  `init.server.luau`, modo ATUALIZAÇÃO (script já existente, `message.uuid ~=
  nil`), rejeita a escrita com `writeAck {ok=false, error="edição bloqueada:
  ..."}` e log claro, sem chamar `TeamCreateLease.ensureIntent`/`canWrite`
  nem `SourceWatcher.writeSource` — ou seja, também não arbitra lease para
  esses scripts (nunca cria intent para eles, então nunca ganham entrada em
  `Leases/<uuid>`).
- **NÃO afeta discovery/identidade nem criação**: `ScriptRegistry`
  (`resolveOrAllocate`/`forEach`/`getUuid`) e `SourceWatcher.listScripts()`
  continuam tratando scripts vendorizados normalmente — necessário para o
  "Refresh Sync" da extensão VS Code detectar "esse pacote já existe no
  Studio, não duplicar" quando o usuário instala um pacote novo. Modo
  CRIAÇÃO do `writeSource` (sem `uuid`, script novo) também não é afetado —
  é assim que um pacote novo chega ao Studio pela primeira vez; só DEPOIS de
  criado é que ele entra em "modo vendorizado" (sem watch/lease).

**Implementação**: `Config.SYNC_EXCLUDED_FOLDER_NAMES` (tabela de nomes) +
`Config.isInsideExcludedPackageFolder(instance)` (sobe `instance.Parent` até
a raiz, `true` se algum ancestral tiver `Name` na lista) em
`plugin/src/Config.luau`. Consumido em dois pontos: `SourceWatcher.luau`
(`checkSourceChanged`, early-return antes de qualquer leitura/dedupe de
`Source`) e `init.server.luau` (`handleWriteSource`, modo ATUALIZAÇÃO,
checagem logo após resolver a Instance por uuid, antes de
`TeamCreateLease.ensureIntent`). Trabalho equivalente no lado extension-dev
(TypeScript) feito em paralelo, mesmo contrato de nomes de pasta.

Validado só por `rojo build` (layout ok) + `lune run` em `Config.luau`,
`SourceWatcher.luau`, `init.server.luau` — sem erro de sintaxe, erro esperado
só na 1ª linha que toca `game`. **Nada testado em Studio real nesta tarefa**
— instalar um pacote Wally de verdade, editar `Packages/algum-pacote/init.luau`
pelo Explorer e confirmar que nenhum `sourceChanged` é emitido, e mandar um
`writeSource` de atualização via extensão contra um uuid dentro de `Packages/`
e confirmar `writeAck {ok=false}` com o motivo, ficam `[Hipótese]` até o
usuário executar com Studio real.

**Lado extensão (extension-dev, TypeScript)**: módulo puro
`vscode-extension/src/mapping/wallyPackageFolders.ts`
(`isExcludedPackageFolderName`/`isInsideExcludedPackageFolder`, mesmo contrato
exato de nomes — "Packages"/"ServerPackages"/"DevPackages", case-sensitive,
segmento inteiro do path, nunca substring), consumido em três pontos de
`SyncBridge.ts`:

- `handleSourceChanged` (Studio→disco, mensagem espontânea): early-return
  antes de `applyStudioContent` se o `instancePath` conhecido (via
  `this.scripts.get(uuid)?.path`, com fallback ao `message.path` informativo)
  estiver dentro de uma pasta excluída. Log `info` (não é erro).
- `handleLocalFileChange` (disco→Studio, watcher de arquivo), só no ramo de
  ATUALIZAÇÃO (`knownUuid` já existe): early-return equivalente, sem tocar
  `contentCache`/rede. O ramo de CRIAÇÃO (uuid ainda desconhecido) não tem
  nenhum check — continua funcionando normalmente dentro dessas pastas, é
  assim que um pacote novo chega ao Studio pela primeira vez.
- `reconcileUuidOnRefresh` (Refresh Sync, merge de 3 vias): qualquer ramo que
  faria PUSH de atualização (só disco mudou, só Studio mudou) ou reportaria
  CONFLITO (com ou sem ancestral em `contentCache`) é pulado silenciosamente
  (log `info`, sem chamar `onSyncConflict`) quando dentro de pasta excluída.
  Os ramos "descoberto só no Studio → pull" e "convergiram → atualiza
  baseline" continuam normais (não são push nem conflito); e
  `reconcileDiskOnlyFiles` (arquivo só no disco, uuid nunca visto → criação)
  não tem check nenhum, igual ao ramo de criação acima.

Testes novos: `test/wallyPackageFolders.test.ts` (13, função pura) +
`describe`s dedicados em `test/syncBridge.test.ts` (7 testes: skip de
`sourceChanged`, skip de atualização local, criação local continua
funcionando, e os 4 cenários de `refreshSync` — só disco, só Studio, conflito
sem `onSyncConflict`, criação nova continua funcionando). 179 testes no total
(`npx vitest run --pool=threads`), `npx tsc --noEmit` e `npm run build`
limpos. **Não testado com Studio real** — mesma limitação do lado Luau, fica
`[Hipótese]` até round-trip real com os dois lados.

## 2026-07-15 (2ª rodada) — mesmo bug de montagem, segundo erro real: `Enum.AutomaticCanvasSize` não existe

Depois do fix do escopo `vide.root()` (entrada abaixo), reteste real revelou
o erro EXATO pela primeira vez (usuário conseguiu ler o Output e colar o
stack trace completo): `AutomaticCanvasSize is not a valid member of "Enum"`
em `StatusPanel.luau` (`SessionsTable`, propriedade `ScrollingFrame.AutomaticCanvasSize`).

**Causa**: confusão entre nome de propriedade e nome de enum — a propriedade
`ScrollingFrame.AutomaticCanvasSize` existe de verdade, mas o TIPO do valor
é `Enum.AutomaticSize` (membros `None`/`X`/`Y`/`XY`), não um enum chamado
`Enum.AutomaticCanvasSize` (que não existe). Código tinha
`Enum.AutomaticCanvasSize.Y`, corrigido para `Enum.AutomaticSize.Y`.

**Por que `lune run` não pegou isso**: indexação de `Enum.<Nome>` inválido
não é erro de sintaxe (Lune não emula os Enums reais do Roblox com essa
fidelidade) — só quebra em tempo de execução contra o Roblox de verdade.
Nenhuma das validações usadas neste projeto (`rojo build`, `lune run`) pega
esse tipo de erro; só teste real em Studio revela. Reforça a regra já
existente do projeto ("confirme APIs contra documentação oficial antes de
depender"), mas o caso aqui é mais sutil: a API (`AutomaticCanvasSize`)
EXISTE, só o enum do valor é que tem nome diferente da propriedade — fácil
de errar por analogia com outras props que reusam o próprio nome como enum.

**Lição de processo**: o stack trace completo (via `error while running
root()/branch()/switch_map()`) só ficou visível porque o usuário limpou o
Output antes de recarregar o plugin e buscou por "painel" — sem isso,
o erro genérico da entrada anterior ("cannot use effect()...") escondia
esse segundo erro atrás de um scroll-back poluído por reloads antigos.

## 2026-07-15 — M4.5: painel Vide não montava — `vide.create`/`effect`/`indexes`/`switch` chamados fora de `vide.root()`

**Bug real, encontrado ao investigar relato do usuário** ("cliquei no SyncTeam
mas não surgiu nada na interface"): `plugin/src/ui/PluginUI.luau` chamava
`StatusPanel.build(state, callbacks)` e SÓ DEPOIS passava o `rootFrame` já
pronto para `vide.mount(function() return rootFrame end, widget)`. Como toda
a árvore (`vide.create` com propriedades reativas, `vide.indexes` da tabela
de sessões, `vide.switch` das duas telas) já tinha sido CONSTRUÍDA antes de
`vide.mount` empurrar o escopo de `vide.root()`, a primeira propriedade
reativa encontrada (ex.: `Text` do campo de porta) disparava
`assert_stable_scope()` (confirmado lendo
`plugin/Packages/_Index/centau_vide@0.4.1/vide/src/{implicit_effect,effect,graph}.luau`)
e lançava `"cannot use effect() outside a stable or reactive scope"`.

**Efeito observável**: o `pcall` em `PluginUI.init` captura esse erro (linha
já existente, log só localmente — ver entrada de descoberta relacionada
abaixo sobre o ponto cego do log remoto), mas toolbar+`DockWidgetPluginGui`
JÁ tinham sido criados nas linhas anteriores do mesmo `pcall` — resultado:
botão existe, clique alterna `widget.Enabled`, mas o painel nunca é montado
(fica vazio). Dá exatamente a impressão de "cliquei e não aconteceu nada".

**Fix**: mover a chamada de `StatusPanel.build(...)` para DENTRO do closure
passado a `vide.mount(function() ... end, widget)` — agora toda a construção
reativa acontece já dentro do escopo de `root()` que `mount` empurra.
`rojo build`/`lune run` limpos depois do fix. **Pendente confirmação real**
(usuário vai testar depois do redeploy) — não promover a `[Verificado]`
até confirmar que o painel aparece.

**Achado relacionado, mesma investigação**: `PluginUI.init` roda em código
de TOPO do script (`init.server.luau`, antes de `start()`), e `Logger.init(sendMessage)`
só é chamado DENTRO de `start()` — ou seja, qualquer `log(...)` chamado por
`PluginUI.init` (sucesso OU falha) só aparece no Output LOCAL do Studio,
nunca é encaminhado pro log remoto via WS. Isso não é um bug (é a ordem
correta — `Logger` só pode encaminhar depois que a conexão existe), mas é um
ponto cego real do fluxo de debug remoto (`Tools/`): qualquer erro que
aconteça ANTES de `start()` rodar precisa ser lido no Output do Studio
diretamente, não dá pra diagnosticar só pelos logs de arquivo.

## 2026-07-15 — M3 fechado com 2 Studios reais: convergência, failover, leases e não-regressão confirmados

Sessão de teste real completa contra os 2 Studios (`Tools/`, sem intervenção
manual de build/deploy/log — só as ações físicas de fechar/reabrir janela).
Plugin rebuildado com o código atual (auto-descoberta de porta + Logger
centralizado, ambos ainda não testados em Studio real antes de hoje).

- **M3.1 reconfirmado**: sessões convergem para o mesmo `LeaderClientId`
  nos dois lados (novo par de clientIds, já que cada `start()` gera um
  novo — sem regressão da auto-descoberta de porta/Logger sobre a eleição).
- **M3.1 failover forçado — achado importante sobre o TEMPO real**: fechar a
  janela do Studio líder no Windows dispara `plugin.Unloading` de forma
  confiável, que chama `TeamCreateElection.stop()` — isso remove a própria
  `Sessions/<clientId>` de forma SÍNCRONA antes do processo morrer de vez.
  Resultado: o outro Studio promove em **~3s** (2 Studios reais,
  `Tools/logs/studio-34981.log` 03:41:17→03:41:20), bem mais rápido que o
  orçamento teórico de "sessão obsoleta após 8s + 2 observações" citado nos
  docs anteriores — porque esse caminho nunca entra em jogo quando o
  shutdown é gracioso (a sessão simplesmente desaparece, não fica "stale").
  **Não testado**: crash não-gracioso (processo morto sem `Unloading`), que
  aí sim dependeria do timeout de 8s+observações. Registrar se algum dia
  precisarmos garantir esse caminho também (ex.: Studio travando/crashando
  de verdade, não só fechando a janela).
- **M3.2 fechado**: rejeição de lease confirmada com timestamps reais —
  dev A escreve, ganha lease; dev B tenta escrever o MESMO script
  (`ServerScriptService/Server/Renamed`, mesmo uuid, replicado via Team
  Create) enquanto o intent de A ainda está fresco → plugin de B recusa
  (`writeAck ok=false`, log `ERROR disco → Studio: FALHA aplicando ...
  lease negada — script sendo editado por dev_Hakor`). **Nuance de teste**:
  a primeira tentativa (edits via 2 chamadas de `Edit` na sessão, com
  latência de modelo entre elas) acabou com ~9s de intervalo real —
  quase exatamente o limiar de 8s de staleness — e as duas escritas foram
  aceitas em sequência (sem rejeição), porque o intent de A já tinha
  expirado quando B chegou. Repetido com escrita direta via shell
  (`>>` + `sleep` curto, gap real ~5s) para garantir sobreposição e SÓ
  ASSIM a rejeição apareceu. Lição: qualquer reteste futuro desse cenário
  precisa garantir que o segundo escritor chegue **dentro** da janela de
  8s do primeiro, não depois — timing de ferramentas/IA pode facilmente
  estourar esse limiar sem perceber.
- **M3.3, camada de dados**: `leaseChanged`/rejeição chegam corretos nos
  logs; o aviso VISÍVEL (`vscode.window.showWarningMessage`) não foi
  reverificado numa janela real de VS Code nesta sessão (só harness Node) —
  fica como único item de M3 ainda não 100% fechado, ver MILESTONES.md.
- **Não-regressão confirmada**: scripts DIFERENTES criados por cada dev na
  mesma janela de tempo (`NaoRegressaoA`/`NaoRegressaoB.server.luau`) — zero
  interferência, cada um com seu próprio uuid, replicação cruzada correta
  (`resolveOrAllocate: reaproveitado uuid=... já existente no registry
  compartilhado` quando o eco do script do outro dev chegou via disco).
- **Curiosidade não investigada, não bloqueante**: no primeiro `hello` após
  reabrir o Studio A, o campo `place` reportado foi `Place4`; na reconexão
  seguinte (mesma conta, mesma place segundo o usuário), foi `Place1` —
  mesmo valor que o Studio B sempre reportou. Não afetou nenhum teste
  (identidade da place não é usada para nada no protocolo, só exibição/log);
  registrar aqui caso apareça de novo e vire suspeito de bug real.

## 2026-07-07 — M3.1: split-brain de liderança — causa raiz confirmada por leitura de código e CORRIGIDO (pendente reteste real)

Investigação de causa raiz (só leitura de código + logs — sem Studio real
disponível) da entrada anterior ("split-brain CONFIRMADO... não corrigido").

**Hipótese de corrida confirmada como POSSÍVEL dado o fluxo atual do
código** (não apenas plausível — o padrão de código está literalmente lá):
`TeamCreateSchema.getOrCreate` (antigo) e o `getOrCreate` privado de
`TeamCreateElection.luau` seguiam o padrão clássico "singleton preguiçoso"
(`parent:FindFirstChild(name)`, se `nil` então `Instance.new`+`.Parent`).
Roblox permite duas Instances irmãs com o mesmo `Name` — não faz merge. Se
dois Studios chamam isso quase ao mesmo tempo ANTES da réplica do Team
Create assentar, cada um cria sua PRÓPRIA Instance. **Agravante confirmado
por leitura de `TeamCreateElection.start()`**: `tick()` roda SINCRONAMENTE
logo depois de `ensureOwnSession()`, dentro do próprio `start()` — sem
nenhuma espera/garantia de que o estado lido de `TestService.SyncTeam` já
reflete a réplica do outro Studio. Pior ainda: `rootValues`/`sessionsFolder`
eram capturados **1x** em `start()` e nunca reavaliados — mesmo que a
réplica do outro Studio chegasse depois como Instance irmã, o Studio
continuava lendo/escrevendo pra sempre na SUA cópia local cacheada. Isso
explica termos divergentes (6 vs 1): plausivelmente cada Studio operava
sobre uma Instance `LeaderTerm`/`Sessions` FISICAMENTE diferente, não havia
conflito de escrita na mesma Instance — havia duplicação de identidade.
`[Dedução direta do código]`: a mecânica é real e está presente no fluxo
atual; `[Hipótese]`: se foi EXATAMENTE isso (vs. duas pastas "SyncTeam"
duplicadas de sessões de teste anteriores nunca limpas) que produziu os
números observados no log — não há como confirmar sem inspecionar o
Explorer ao vivo, que não está disponível nesta investigação.

**Decisão de fix — reconciliação determinística, não só "evitar a
corrida"**: impossível garantir 100% contra corrida com replicação
assíncrona (nem um delay aleatório resolveria de verdade, só reduziria a
janela) — o fix precisa fazer TODOS os Studios convergirem pra MESMA escolha
canônica mesmo que duplicatas cheguem a ser criadas. Implementado em
`plugin/src/TeamCreateSchema.luau`:

1. **Desempate determinístico e replicado**: cada Instance-singleton criada
   por este módulo ganha um atributo `SyncTeamOrigin` (GUID aleatório,
   gravado antes de `.Parent`). Se `getOrCreate` encontra >1 candidato com o
   mesmo Name+ClassName sob o mesmo parent, a canônica é a de MENOR
   `SyncTeamOrigin` — todo Studio que já tiver ambas as duplicatas
   replicadas calcula a MESMA escolha, sem depender de ordem de observação
   local. Diferente do critério cogitado no início ("nome de Instance mais
   antigo" — Roblox não expõe timestamp de criação nem ordem estável
   cross-cliente) e do "menor valor apurado" sozinho (não serve para
   Folders, que não têm `.Value`).
2. **Merge, nunca destrói dado**: Folder → reparenta TODOS os filhos da(s)
   duplicata(s) pra dentro da canônica antes de destruir a casca vazia
   (cobre Scripts/Sessions/Leases e o próprio SyncTeam — nunca perde
   sessões/scripts/leases que nasceram por azar sob a pasta "perdedora").
   IntValue (LeaderTerm/NextJoinSequence/NextLeaseRequestSequence) → a
   canônica fica com o MAIOR valor entre as duplicatas (contadores deste
   projeto são estritamente crescentes; "maior" nunca retrocede nem perde
   progresso real). StringValue (LeaderClientId) → sem merge de conteúdo;
   o ciclo de eleição já reavalia liderança do zero no tick seguinte a
   partir de Sessions/ mesclado, autocorrigindo (custo aceito: pode gerar +1
   incremento de term "desperdiçado" na convergência, nunca viola exclusão
   mútua de líder).
3. **Reconciliação contínua, não só na criação**: `getOrCreate` roda a
   MESMA checagem de duplicata toda vez que é chamado (não só quando
   `#candidates == 0`). Isso sozinho não bastava: `TeamCreateElection.tick()`
   só chamava `ensureRoot()`/`ensureFolder("Sessions")` 1x dentro de
   `start()` e cacheava o resultado (`rootValues`/`sessionsFolder`) pelo
   resto da sessão — corrigido chamando de novo A CADA PULSO (2s) dentro de
   `tick()`, reatribuindo essas variáveis. Reaproveita a mesma ideia já
   usada em `ScriptRegistry` (reconciliar depois do fato via varredura do
   registry compartilhado, M2 2026-07-04), adaptada para o caso aqui ser
   duplicação de Values/Folders simples, não de identidade por
   ObjectValue/Instance física.

**Por que não corrigir só "evitando a corrida" (ex.: delay aleatório antes
do primeiro tick)**: reduziria a chance, não eliminaria — a tarefa exigia
convergência garantida mesmo se duplicatas chegarem a existir. O fix acima
tolera duplicatas genuinamente acontecendo e ainda assim converge.

**Constantes de tempo validadas (pulso 2s/stale 8s/cleanup 20s/2
observações) não foram alteradas** — o fix não precisou tocar nelas.

**Validado só por `rojo build` + `lune run`** (`TeamCreateSchema.luau`,
`TeamCreateElection.luau`, e os dependentes `TeamCreateLease.luau`/
`ScriptRegistry.luau`/`SourceWatcher.luau`, que consomem
`TeamCreateSchema.ensureRoot/ensureFolder` com a mesma assinatura — sem erro
de sintaxe, erro esperado só na primeira linha que toca `game`). **Nada
testado em Studio real nesta tarefa** — este fix em si é a resposta à
entrada anterior desta mesma seção, mas continua sendo código não
exercitado contra o engine/replicação real. Roteiro de reteste (mesmos 2
Studios/2 contas, repetindo o cenário de reload simultâneo) em
`docs/PROJECT_STATUS.md`.

**Adição pequena de escopo, mesma tarefa**: botão de toolbar temporário
"SyncTeam: Alternar porta (34980/34981)" em `plugin/src/init.server.luau` —
`plugin:SetSetting` não é chamável pelo Command Bar do Studio (`plugin`
global só existe dentro do script do próprio plugin), então não havia como
apontar 2 Studios na mesma máquina/pasta de Plugins para portas diferentes
sem essa UI. Ferramenta de teste, não feature de produto.

## 2026-07-07 — M3.1: split-brain de liderança CONFIRMADO em teste real com 2 Studios (não corrigido)

Primeiro teste real do M3.1 em 2 Studios (userId `9203551752` e `1402101248`,
mesma place, plugin recém-implantado via `rojo build` + cópia para
`%LOCALAPPDATA%\Roblox\Plugins`, ambos recarregando pelo auto-refresh do
Studio ao mesmo tempo, ~12:42:41). Resultado (`logs-livetest/studio1.txt`,
`logs-livetest/studio2.txt`):

- Estudio1 (clientId `f1bd550a...`): `sou o líder agora (term 6)`,
  `joinSequence sequence=8`, às 12:42:43.788.
- Estudio2 (clientId `f4d3cb03...`): `sou o líder agora (term 1)`,
  `joinSequence sequence=0` (depois `sequence=1` de novo 2s depois, mesma
  sessão), às 12:42:43.785.

**Os dois Studios se declararam líder ao mesmo tempo, com termos DIFERENTES
(6 vs 1)** — viola o critério de aceite do M3.1 ("mesmo líder nos dois
lados", `docs/MILESTONES.md`). Confirma em Studio real o achado nº4 da
revisão de código de 2026-07-04 (`docs/PROJECT_STATUS.md`, seção "code
review do M3"): "incremento não-atômico de `LeaderTerm` no cenário de
split-brain". Causa provável: os dois plugins recarregaram
quase-simultaneamente (reload disparado pelo mesmo `cp` do arquivo do
plugin) e cada um leu `LeaderTerm`/`NextJoinSequence` localmente e
incrementou/escreveu antes que a réplica do Team Create do outro lado
chegasse — não há nenhuma forma de compare-and-swap ou re-checagem pós-yield
na eleição atual (`TeamCreateElection.elect`, porte 1:1 do RojoCoop, nunca
exercitado contra essa condição de corrida específica no projeto original
porque lá a liderança era só "shadow", nunca bloqueava escrita de verdade).
`term=6`/`sequence=8` em vez de `1`/`0` no Studio1 indica que
`TestService.SyncTeam` já tinha histórico de uma sessão de teste anterior
(valores persistidos na place) — não é bug em si, só contexto.

**Não corrigido nesta sessão** — log capturado termina em ~12:43:23, sem
uma reconciliação visível (nenhum "líder atual: X" substituindo a auto-
declaração de nenhum dos dois lados nesse trecho). Pendente: (a) pedir mais
logs depois de mais alguns ciclos de pulso para ver se autocorrige sozinho
(a eleição reavalia `LeaderClientId` a cada tick, então pode convergir depois
que o Team Create sincronizar); (b) se não convergir sozinho, é bug real
bloqueante do M3.1 e precisa de fix (candidatos: reler `LeaderTerm` logo
antes de escrever e abortar se mudou — mesmo princípio de "reconfirmar após
yield" já usado em `TeamCreateLease`/`ScriptRegistry`; ou atrasar a primeira
eleição de cada sessão por um valor aleatório pequeno para reduzir chance de
corrida simultânea).

**Achado ambiental, não é bug do SyncTeam**: nenhum dos dois Studios
conseguiu manter conexão WS de verdade — `erro WS 400 HttpError:
ConnectFail` em loop nos dois lados, porque **não havia nenhum processo
escutando `127.0.0.1:34980`** (nem extensão VS Code, nem
`run-node-harness.ts`) no momento do teste — confirmado via `netstat`
(`SYN_SENT`, nunca completou o handshake) e checagem de processos Node
ativos (só processos de outro projeto, nenhum do SyncTeam). Isso significa
que só a eleição de líder pôde ser observada nesse teste — nada de
`writeSource`/lease foi exercitado (precisa da extensão ou do harness
rodando na porta 34980 antes de continuar o roteiro combinado do M3).

## 2026-07-04 — M3.3: bug de escopo Lua deixava `leaseChanged` mudo (corrigido)

Code review independente (sem execução em Studio, só leitura de código) do
trabalho noturno de M3 achou dois bugs reais em
`plugin/src/TeamCreateLease.luau` que juntos quebravam 100% da notificação
espontânea `leaseChanged` (M3.3) — nenhum dos dois dependia de Team Create
para se manifestar, então nenhum teste real teria pego a causa raiz sem
olhar o código:

1. **`TeamCreateLease.init(onMessage)` estava definida ANTES de
   `local sendMessage = nil`** no mesmo arquivo. Em Lua/Luau, uma função
   definida antes da declaração de uma `local` não fecha sobre ela — a
   atribuição `sendMessage = onMessage` dentro de `init()` criava/escrevia
   uma variável GLOBAL solta, nunca a local que `checkLeaseDrift` de fato lê.
   Resultado: `sendMessage` permanecia `nil` para sempre, `leaseChanged`
   nunca era enviado, sem erro nenhum no log — pareceria um problema de
   replicação do Team Create, mas era um bug puro de ordem de declaração.
   **Corrigido**: `local sendMessage = nil` movida para antes de
   `TeamCreateLease.init`.
2. **`ownerClientId = owner` com `owner == nil`** (lease liberada) fazia a
   chave desaparecer da tabela Lua antes do `HttpService:JSONEncode` — Lua
   não tem como representar "campo presente com valor nil" numa tabela,
   então o JSON saía com o campo AUSENTE, nunca com `null`. O lado da
   extensão validava `typeof ownerClientId === 'string' || === null` e
   descartava a mensagem inteira ao ver `undefined`. **Corrigido do lado da
   extensão** (`SyncTeamService.handleLeaseChanged`): normaliza
   `ownerClientId`/`ownerDisplayName` ausentes para `null` antes de validar
   — trata a limitação geral de Lua (nil sempre omite a chave) na borda de
   entrada, em vez de inventar um sentinela no protocolo.

**Lição para revisões futuras**: qualquer campo `T | null` que se origina de
uma tabela Lua serializada por `HttpService:JSONEncode` vai chegar como
campo AUSENTE quando o valor Lua for `nil`, nunca como `null` JSON — todo
handler do lado da extensão que trata mensagem espontânea do plugin precisa
normalizar `undefined -> null` antes de validar, não só aceitar `null`
explícito.

Verificado: `npm run lint` (tsc --noEmit) limpo, `npm test` 57/57, `npm run
build` limpo. Build do plugin via `rojo build` não verificado nesta sessão
(ambiente sem `rojo` acessível no momento — nem rokit nem instalação global
resolveram); a mudança no lado Luau é só reordenação de declaração `local` +
comentário, sem alterar lógica. Teste real em 2 Studios do M3.2/M3.3
continua pendente, adiado por orçamento de sessão — ver
`docs/PROJECT_STATUS.md`.

## 2026-07-04 — M3.1: achados reais do primeiro teste com 2 Studios

Teste real (2 Studios/2 contas, roteiro combinado do M3) revelou dois casos
de borda na eleição de líder — nenhum invalida o design, ambos registrados
como limitações conhecidas:

1. **Split-brain no bootstrap simultâneo**: os dois plugins recarregaram no
   mesmo milissegundo (reinstalação simultânea das duas contas pela IA). No
   primeiro tick (2s depois), cada um só via a própria sessão (a réplica da
   sessão do outro ainda não tinha chegado) e se elegeu líder
   independentemente — os dois em `term 1`, com clientIds diferentes. Raro
   na prática (dois devs não abrem Studio no mesmo milissegundo), mas é uma
   lacuna real do algoritmo de bootstrap. `observeCandidate` (2 observações
   consecutivas) não previne esse caso específico porque cada lado só via
   a si mesmo em AMBAS as primeiras observações, não uma leitura instável.
2. **Termo/estado desatualizado ao (re)entrar no Team Create — CONFIRMADO
   reproduzível em 2 rodadas de teste independentes, 2026-07-04**: um
   Studio que acabou de entrar/reentrar numa sessão Team Create lê por um
   período curto um "instantâneo" desatualizado de `TestService.SyncTeam`
   (ex.: `LeaderTerm` várias unidades atrás do valor real, chegando a ler
   um valor de ~5 minutos antes numa das rodadas). Diferente da replicação
   em REGIME, que já medimos em milissegundos (M0) — isso é
   especificamente sobre o estado que um cliente vê no momento em que
   entra/reentra na sessão. `[Hipótese, mas já reproduzida 2x]`, ainda não
   confirmada contra documentação oficial da Roblox.
   - **Consequência prática**: no primeiro tick após (re)conectar, um
     Studio pode tomar uma decisão de eleição baseada em estado velho —
     inclusive "roubar" a liderança de um líder já estabelecido, se no
     instantâneo desatualizado a sessão do líder real ainda não aparecer.
     Isso se autocorrige nos ciclos seguintes (confirmado: `joinSequence`
     subsequente foi atribuído corretamente pelo líder real de verdade),
     não é uma divergência permanente — mas é uma janela real de decisão
     incorreta nos primeiros ~2-4s após reconexão.
   - **Risco para o M3.2 (leases)**: a mesma defasagem pode causar decisão
     de lease transitoriamente incorreta logo após um Studio reconectar
     (ex.: não ver o dono real de uma lease por um instante). Atenção
     especial ao testar cenários de lease imediatamente após reconexão.
   - Testado com início escalonado (21s de diferença, sem reconexão) e
     funcionou perfeitamente — o problema é específico do momento de
     entrada/reentrada, não do algoritmo de eleição em si.

**Pendência encontrada nesta revisão**: `docs/MILESTONES.md` (M3.1)
menciona "resolve a divergência de UUID do M2, uma vez que existe um líder
combinado" como motivação — mas isso nunca foi de fato implementado (o
líder existe, mas nenhum código usa a liderança para arbitrar alocação de
UUID). A divergência de UUID entre Studios documentada no M2 **continua
sem correção real**, só ganhou a infraestrutura (líder eleito) que uma
correção futura poderia usar.

## 2026-07-04 — `stop()` vazava `WebStreamClient`, esgotando o limite de 6 por Studio

Teste ao vivo (2 Studios, múltiplos reloads do plugin M2 durante depuração de
delete) bateu no erro `Too many WebStreamClients active, please close
existing ones before creating new ones` — nenhuma nova conexão conseguia se
estabelecer, mascarando testes de correção como "não funcionou" quando na
verdade a mensagem nunca saía do Studio.

Causa: `stop()` (chamado por `plugin.Unloading` a cada reload) fazia
`client = nil` sem chamar `client:Close()`. O fechamento real só acontecia no
cleanup do loop `runConnection`, que roda numa coroutine separada
(`task.spawn`) — `plugin.Unloading` provavelmente interrompe essa coroutine
antes dela acordar do `task.wait` e chegar no seu próprio `newClient:Close()`,
então o `WebStreamClient` nunca era liberado. Cada reload do plugin vazava 1.

**Decisão**: `stop()` chama `client:Close()` (via `pcall`) de forma síncrona,
antes de descartar a referência — não depende mais do cleanup assíncrono do
`runConnection` para isso. Corrigido em `plugin/src/init.server.luau`.

**Consequência prática**: WebStreamClients já vazados numa sessão de Studio
em andamento não são liberados retroativamente por esse fix — é necessário
reiniciar o Studio (não só recarregar o plugin) para zerar a contagem antes
de repetir testes que envolvam múltiplos reloads.

## 2026-07-04 — `ObjectValue.Value` não detecta delete; bug real confirmado em teste ao vivo

O M2 implementou detecção de delete checando `ObjectValue.Value == nil`
(porte de um padrão validado só contra um **mock** de Roblox no RojoCoop,
`TeamCreateCoordinator.spec.lua:374-381` — nunca contra o engine real).
Teste real (2 Studios, `HttpService:GenerateGUID`, script `Hello` apagado no
Explorer) mostrou que a remoção real do DataModel (confirmada por dump de
tipos do plugin AutoType) nunca gerou `scriptRemoved` — o registry nunca
percebeu.

Pesquisa confirmou a causa: `ObjectValue.Value` **não** vira `nil` quando a
Instance referenciada é destruída (comportamento intencional, confirmado por
staff da Roblox no DevForum — ver
`.claude/research/2026-07-04-objectvalue-destroy-detection.md`). `Changed`
também não dispara nesse caso.

**Decisão**: detecção de delete passa a usar `instance.Parent == nil` +
confirmação via `pcall` de reatribuição de `Parent` (Parent nil isolado
também acontece em desparentagem temporária, não só destruição real) — nunca
mais `ObjectValue.Value == nil`. `Instance.Destroying` pode ficar como
fast-path best-effort (disparo relatado como inconsistente no DevForum),
nunca como único caminho — mesmo princípio já aplicado a `Source.Changed`
desde o M0.5 (polling é a garantia, sinal é atalho).

**Revisão da mesma decisão, mesmo dia**: testes reais repetidos (apagar
script pelo Explorer do Studio, sem nunca abrir no editor) mostraram que a
confirmação por `pcall` NUNCA falhava — ou seja, `scriptRemoved` nunca
disparava, mesmo com o fix acima aplicado. Hipótese (não confirmada contra
doc oficial): o "Delete" do Explorer do Studio faz um soft-delete
(reparenta pra `nil`, mantendo a Instance viva/editável) para suportar
Ctrl+Z, sem chamar `Instance:Destroy()` de verdade nesse momento — por isso
a confirmação por pcall nunca via a propriedade `Parent` travada.
**Simplificado para `instance.Parent == nil` sozinho**, sem a confirmação —
para os containers que este plugin observa (Services/pastas reais
manipuladas por humano via Explorer), reparentar de verdade é uma
atribuição atômica que nunca passa por um `nil` intermediário observável,
então o risco de falso positivo que motivou a confirmação por pcall não se
aplica na prática aqui.

**Confirmado em teste real, 2026-07-04**: com `Parent == nil` sozinho,
`scriptRemoved` disparou corretamente ao apagar um script pelo Explorer
(sem nunca abrir no editor), e o arquivo correspondente foi removido do
disco pela extensão. Hipótese do soft-delete do Explorer tratada como
suficientemente confirmada para uso prático (não é confirmação contra
documentação oficial da Roblox, mas o comportamento observado é
consistente e reproduzível).

**Lição maior**: comportamento validado só contra mock (mesmo que o mock seja
de um projeto anterior com histórico de testes reais em outras áreas) não
substitui confirmação contra o engine real ou documentação oficial. Regra
registrada em `.claude/rules/luau.md`.

## 2026-07-04 — Identidade UUID pode divergir entre Studios; registry precisa reconciliar continuamente

Mesmo teste real expôs um segundo problema: os dois Studios (mesma sessão de
Team Create, mesmo script `Main`/`Renamed` replicado) alocaram **UUIDs
diferentes** para a mesma Instance (`9dbf46f6...` num, `5b51cd63...` no
outro). Causa: `ScriptRegistry.reconcile()` só roda 1x no `start()` do
plugin (snapshot do registry existente); depois disso,
`resolveOrAllocate()` só consulta o mapa em memória (`uuidByInstance`) — se
uma Instance nunca vista aparece via `DescendantAdded` (replicada de outro
Studio que já alocou uuid para ela), o código não verifica se já existe uma
entrada `Scripts/<uuid>/InstanceRef` (potencialmente replicada via Team
Create) apontando pra essa mesma Instance antes de gerar um uuid novo.

**Decisão**: `resolveOrAllocate` deve, antes de alocar um uuid novo, também
buscar no registry compartilhado (`scriptsFolder`) por uma entrada existente
cujo `InstanceRef.Value` já seja a Instance em questão — não só confiar no
mapa em memória local. Isso vale tanto no `reconcile()` de startup quanto em
toda alocação subsequente (`DescendantAdded`), para que replicação de outro
Studio que chegue DEPOIS do reconcile inicial ainda seja respeitada.

## 2026-07-03 — GO: hipótese central validada com dois Studios reais

Teste real com duas contas Roblox (via "Add Account", uma delas `216675619`),
duas janelas de Studio na mesma place, Team Create ativo: um script criado e
com `Source` escrito por um Studio replicou — criação, conteúdo inicial e
edições subsequentes — para o outro Studio. Logs em `logs-livetest/escritor.txt`
e `logs-livetest/observador.txt`; análise completa em `docs/PROJECT_STATUS.md`.

**Decisão**: seguir com a arquitetura do SyncTeam (Team Create como transporte
de `Source` entre Studios). Não é necessário o plano B (conteúdo via
StringValue nos metadados) — cogitado em `docs/ARCHITECTURE.md` como
mitigação de risco, mas o caminho principal (Source real do script,
replicação nativa) funcionou.

Ressalva: essa validação cobriu só um cenário (Drafts Mode indeterminado,
script fechado no editor remoto). Os cenários de maior risco da matriz do M0
(Drafts ligado, script aberto no editor remoto) ainda não foram testados —
não bloqueiam o "go", mas devem ser cobertos antes de finalizar o M0.

Formato: decisão, data, motivação. Decisões só mudam com registro explícito.

## 2026-07-02 — Plugin próprio em vez de fork do Rojo

Manter fork do Rojo quebra a cada release upstream (aconteceu com o RojoCoop na
atualização pós-7.7.0-rc.1). O SyncTeam é um plugin Studio + extensão VS Code
independentes; o Rojo é usado apenas como ferramenta de build do `.rbxm`.

## 2026-07-02 — Team Create como transporte e autoridade

Nenhum serviço externo (sem Cloudflare, sem host próprio, sem Live Share). O
canal entre máquinas é a replicação nativa do Team Create; o Roblox é sempre a
fonte da verdade. Na conexão inicial, o Studio é autoritário e o disco é
atualizado a partir dele (UX "Connect/Override" herdada do RojoCoop).

## 2026-07-02 — Escopo do v1: apenas scripts

Sincroniza Script/LocalScript/ModuleScript (Source, create, rename, move,
delete). Propriedades de instâncias não-script ficam fora; o
`default.project.json` continua mapeando as pastas estáticas. Decisão do
usuário em 2026-07-02.

## 2026-07-02 — Conflito no mesmo arquivo: lease por arquivo

Quem começa a editar vira dono temporário; os demais veem o arquivo
somente-leitura com aviso e cursor do dono. Sem preempção; posse expira com
inatividade ou desconexão. Modelo validado no RojoCoop entre dois Studios.
Edição char-a-char (CRDT/OT) fica explicitamente fora do v1; last-writer-wins
foi rejeitado por reintroduzir sobrescrita acidental. Decisão do usuário em
2026-07-02.

## 2026-07-02 — Compatibilidade com o formato de projeto Rojo

Mesmo `default.project.json`, mesmas convenções de nomenclatura
(`*.server.luau`, `*.client.luau`, `init.*`, pastas adicionais definidas pelo
usuário). Objetivo: alternar Rojo ↔ SyncTeam sem migração de arquivos, nos
dois sentidos.

## 2026-07-02 — Identidade de script: UUID + ObjectValue

Registry `Scripts/<UUID>` com `ObjectValue.InstanceRef` apontando para a
Instance. Sobrevive a rename/move; delete/recreate gera UUID novo. Identidade
por path e por attributes foi avaliada e rejeitada no RojoCoop (paths mudam;
attributes não têm autoridade de líder). Se ObjectValue falhar entre dois
Studios, parar e investigar — não degradar para path.

## 2026-07-02 — Endpoint local hospedado pela extensão VS Code

A extensão hospeda o servidor WebSocket em localhost (Node `ws`); o plugin
conecta via `HttpService:CreateWebStreamClient` (validado no RojoCoop; limite
de 6 clientes por Studio). Sem binário/daemon separado para distribuir.

## 2026-07-03 — Detecção de mudança de Source: polling obrigatório, sinal é só fast-path

Spike M0.5 (transporte local, 1 Studio) mostrou em teste real que
`instance:GetPropertyChangedSignal("Source")` **não dispara de forma
confiável** depois de `ScriptEditorService:UpdateSourceAsync` — o dado é
gravado corretamente (confirmado por leitura direta), mas o callback do sinal
às vezes simplesmente não roda, inclusive 15s depois. Nem Drafts mode nem
Studio "Signal Behavior: Deferred" explicam sozinhos (Deferred só atrasa até o
próximo resumption point, nunca faz um evento deixar de disparar — ver
`.claude/research/2026-07-03-source-changed-signal-reliability.md`). É uma
instabilidade conhecida da API, documentada em relatos consistentes do
DevForum para script recém-criado/nunca aberto no editor + Team
Create/Drafts/Live Scripting.

O próprio Rojo evita o problema inteiro: nunca usa `UpdateSourceAsync`, escreve
`Source` por atribuição direta de propriedade e observa por `instance.Changed`
genérico.

**Decisão**: manter `UpdateSourceAsync` como escrita primária (participa do
pipeline de Drafts/edição colaborativa, mantendo abas abertas do editor em
sincronia — vantagem real sobre atribuição direta), mas **nunca depender só do
sinal para detectar mudança**. Todo componente que observa Source usa polling
periódico (0.5s no spike; medir custo antes do M1 com projetos grandes) com
dedupe por último valor visto, com o sinal como fast-path opcional. Corrigido
e validado em `spikes/m0_5-local-pipeline/plugin/SyncTeamLab.lua` (6/6
cenários, incluindo reconexão). Regra para M1+ registrada em
`.claude/rules/luau.md`.

Para o M0 real (Team Create entre máquinas), essa mesma disciplina vale com um
reforço: preferir notificar a mudança via um contador/hash nos metadados
(`TestService.SyncTeam`, canal já validado como confiável) em vez de confiar
no `Changed` do próprio script — o spike M0 (`SyncTeamM0.lua`) já segue esse
padrão.

## 2026-07-02 — Esquema de coordenação herdado do ModuxSync

Sessions/heartbeat (pulso 2s, stale 8s, cleanup 20s), eleição de líder com
termos e dupla observação, leases determinísticas sem preempção — portados de
`RojoCoop/rojo-7.7.0-rc.1/plugin/src/TeamCreate*.lua`. Diferença: no SyncTeam
as leases são autoritativas desde o início (no RojoCoop eram "shadow").
Container renomeado para `TestService.SyncTeam`.
