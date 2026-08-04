# Memória do ui-dev

Padrões visuais e convenções de texto adotados no SyncTeam.
Atualize ao final de cada tarefa; mantenha curto e acionável.

## Logo do SyncTeam no `StatusBarItem` via fonte de ícone (fantasticon), 2026-08-03

Pedido: mostrar a logo (já existente, `vscode-extension/resources/icon.svg`/
`icon.png`, 2 cores `#2c333f`/`#0268fc`) no `StatusBarItem` (barra inferior
do VS Code). `StatusBarItem.text` só aceita texto + `$(codicon)` — sem
caminho de SVG cru (pesquisa prévia,
`.claude/research/2026-08-03-statusbaritem-custom-icon-svg.md`). Único
caminho real: `contributes.icons` no `package.json` apontando pra uma FONTE
de ícone (glifo, WOFF), gerada com `fantasticon` (mesma ferramenta do
`microsoft/vscode-codicons`). Detalhe completo em `docs/DECISIONS.md`
"14ª rodada" (2026-08-03).

**Padrão a reusar sempre que precisar de outro ícone customizado em
`$(nome)` daqui pra frente**:
- Script dedicado `vscode-extension/scripts/build-icon-font.cjs`, rodado
  via `"prebuild"` no `package.json` (dispara sozinho em `npm run build`,
  sem passo manual) — copia o(s) SVG(s) fonte pra uma pasta temporária de
  input (`resources/icon-font-src/`, REGENERADA a cada build, nunca editada
  à mão) e chama `fantasticon` (`generateFonts`, API programática, não a
  CLI).
- **BUG real do `fantasticon@4.1.0` no Windows** (confirmado isolado, não
  suposição): a função interna `loadPaths` monta o glob com
  `path.join(dir, "**/*.svg")` — no Windows isso produz separador `\`, e o
  `glob@13` (dependência direta do fantasticon) trata `\` como caractere de
  ESCAPE no padrão, não como separador — o glob nunca acha nada e falha com
  "No SVGs found" mesmo com o arquivo existindo. Reproduzido isolado:
  `glob('dir\\**\\*.svg')` → `[]`, `glob('dir/**/*.svg')` → acha certo.
  **Workaround**: monkeypatch de `path.join` só durante a chamada a
  `generateFonts` (`path.join = (...a) => original(...a).split(path.sep).join('/')`),
  restaurado em `finally`. **Só funciona chamando a build CJS do fantasticon
  (`require("fantasticon")`, resolve pra `dist/index.cjs`)** — testado
  isolado que a build ESM (`import`, resolve pra `dist/index.js`) bundla
  sua própria referência a `path` internamente e NÃO respeita esse
  monkeypatch externo (mesmo teste, troquei só require→import, voltou a
  falhar "No SVGs found"). Por isso `build-icon-font.cjs` é
  **deliberadamente `.cjs`**, nunca `.mjs`, mesmo o resto do projeto usando
  `esbuild.config.mjs` — não "consertar" pra ESM sem retestar isso primeiro.
- Fonte gerada (`.woff`) + JSON de codepoints + a pasta de input
  (`icon-font-src/`) são **artefato de build, não commitado** — mesmo
  tratamento de `dist/` (gitignorado na raiz do repo, MAS ainda assim vai
  parar no `.vsix` porque `vsce` empacota o que existe em disco no momento
  do `vsce package`, não filtra por `.gitignore` — confirmado empírico
  comparando um baseline `vsce package` ANTES de mexer em qualquer coisa:
  `dist/extension.js`, já gitignorado desde antes desta tarefa, sempre
  apareceu no `.vsix`). O `.json`/pasta de input intermediários (não
  precisam ir no pacote final) são excluídos via `.vscodeignore` — só o
  `.woff` de fato precisa estar no `.vsix` (é o que `contributes.icons`
  referencia).
- **Codepoint: sempre ler o valor REAL gerado, nunca copiar o exemplo de um
  research doc/exemplo genérico** — o script loga o codepoint decimal→hex
  (`\FXXX`) a cada build; conferir contra o `fontCharacter` gravado em
  `contributes.icons`. Nesta tarefa: gerou `61697` decimal = `\F101` (não o
  `\E001` do exemplo da pesquisa).
- **Fonte de ícone é SEMPRE monocromática** — mesmo se o SVG de origem tiver
  múltiplas cores/`<path>` com `fill` diferentes (nosso logo tem 2), WOFF/TTF
  só carregam a FORMA (contorno), a cor final vem inteira do CSS/tema de
  quem usa `$(nome)` (status bar = cor do texto da status bar). Perda de
  marca (2 tons → 1 cor) é esperada e aceita, não é bug a corrigir. Ao
  verificar isso via headless Chrome, cuidado com falso positivo: uma
  primeira tentativa mostrou as 2 cores originais renderizando — era
  artefato de CACHE/TIMING (screenshot tirado antes do `@font-face` acabar
  de carregar via `file://`, browser caiu num fallback de sistema
  coincidentemente colorido) — só ficou confiável usando `data:` URI inline
  (síncrono, sem race) + forçar `color: red` no CSS pra provar que o glifo
  é mesmo monocromático (saiu vermelho sólido, forma preservada).
- **Adição de marca, nunca substituição do indicador de estado**: quando o
  pedido é "mostra a logo" num widget que já comunica estado (aqui, os 3
  ícones `$(circle-outline)`/`$(broadcast)`/`$(circle-filled)` do
  `StatusBarItem`), o padrão é PREFIXAR o ícone de marca antes do indicador
  existente (`` `${BRAND_ICON} $(circle-outline) ...` ``), nunca trocar um
  pelo outro — os 3 estados continuam 100% distinguíveis sem a logo.
- **Verificação sem VS Code real**: build+lint+teste+`vsce package` reais
  (unzip do `.vsix` pra conferir presença do `.woff` e integridade de
  `contributes.icons`) dão confiança alta sem precisar abrir o VS Code de
  verdade. Deliberadamente **não** instalei a extensão no VS Code real do
  usuário nem tirei screenshot da tela dele para "ver o glifo aparecer" —
  abrir uma janela nova/capturar a tela inteira sem pedido explícito é
  invasivo demais pra esse nível de verificação (a tarefa já sinalizava
  "print não dá" como esperado). Documentado como `[Hipótese]` (alta
  confiança) em vez de `[Verificado]`.

## "Nome de exibição customizado" saiu de "em breve" — implementado de verdade, 2026-08-02 (8ª rodada)

Pedido do usuário: tirar 1 dos 3 itens "em breve" do painel de Configurações
(`DisabledSettingRow`) e implementar de verdade; os outros 2
("Containers observados", "Nível de log") **continuam** desabilitados —
não tocados. Arquivos: `plugin/src/Config.luau`,
`plugin/src/TeamCreateElection.luau`, `plugin/src/init.server.luau`,
`plugin/src/ui/StatusPanel.luau`, `plugin/src/ui/PluginUI.luau`.

**Persistência**: `Config.CUSTOM_DISPLAY_NAME_SETTING_KEY =
"SyncTeam_CustomDisplayName"` + `Config.resolveCustomDisplayName(pluginObject)`
— MESMO esqueleto de `resolveNotificationsEnabled`/`resolveAutoStartEnabled`
(GetSetting em pcall; nunca setado ou tipo errado caem no default), só o tipo
esperado muda para `"string"` (as outras duas são `"boolean"`). Default `""`
= "usar o nome do Roblox normalmente". Setting GLOBAL à instalação do Studio
(mesmo grupo de NOTIFICATIONS/AUTOSTART) — **não** é o mecanismo por-place
(`PLACE_SETTINGS_KEY`), que é uma fatia recente e não relacionada (cuidado
documentado na própria tarefa para não confundir os dois).

**Onde o TextBox grava / runtime-update foi implementado de verdade (não só
"efeito na próxima sessão")**: `TeamCreateElection.luau` ganhou
`TeamCreateElection.setLocalUsername(customName)` — escreve direto em
`sessionValues.Username.Value` (o MESMO `Username` que
`TeamCreateLease.describeClient` usa nas mensagens de lease negada e que a
tabela de sessões do painel lê) se `customName` não-vazio; se vazio (dev
LIMPOU o campo, "voltar a usar o nome do Roblox"), dispara de novo a
resolução assíncrona via `Players:GetNameFromUserIdAsync` em vez de publicar
string vazia. No-op silencioso se `sessionValues == nil` (eleição ainda não
rodando) — o próximo `start()` aplica a setting do zero. `PluginUI.luau`
chama esse setter **direto** (self-contained, dentro do callback
`onCustomDisplayNameSubmit`, junto do `SetSetting`) — **não** é passthrough
para `init.server.luau` como `onAutoReconnectToggle`: `TeamCreateElection` já
era `require`'d em `PluginUI.luau` para os getters de leitura da tabela de
sessões (M4.5), então nenhuma lógica exclusiva de `init.server.luau`
(`start()`/`isInRunOrPlayMode()`) estava envolvida — diferente do padrão
documentado na entrada M4.5+ mais abaixo ("dois padrões de callback
distintos"), este é um 3º caso: ação real que não precisa nem de
`start()`/guard de Run-Play nem fica 100% dentro de `StatusPanel.luau` (não é
só estado local de UI, precisa persistir + propagar).

**Resolução assíncrona do nome do Roblox refatorada, não duplicada**: o
bloco `task.spawn(Players:GetNameFromUserIdAsync...)` que já existia dentro
de `TeamCreateElection.start()` foi extraído para
`resolveAndPublishRobloxUsername(myToken)` (função local module-level) —
reusada tanto por `start()` (branch "sem nome customizado") quanto por
`setLocalUsername` (branch "campo limpo, volta a resolver"). `start()` agora
recebe um 2º parâmetro `pluginObject` (não recebia antes — `init.server.luau`
precisou passar a repassar: `TeamCreateElection.start(userIdParam,
pluginObject)`), usado só para `Config.resolveCustomDisplayName` no boot;
**decisão explícita**: quando a setting já tem um nome customizado no boot,
a resolução assíncrona do nome real do Roblox é **pulada por completo** (não
"resolvida mas descartada") — menos 1 yield/chamada de rede que o resultado
nem seria usado.

**UI (`StatusPanel.luau`)**: `CustomDisplayNameField(state, callbacks)` —
`TextBox` (novo tipo de controle de settings no arquivo; até aqui só existia
`TextButton` de toggle binário) com o MESMO layout de coluna dos toggles
(`SettingsRow`, controle em 0.62/0.38 da linha) mas fundo/borda copiados do
`portBox` de `PortRow` (`Theme.Color.Background` + `BorderStroke()`, não o
`Theme.Color.Border` sólido dos toggles) — decisão: um campo de texto editável
já se distingue de um botão pelo cursor/caret, mas reforçar com a MESMA
linguagem visual dos outros CAMPOS (não botões) do painel deixa "isto é
texto, não uma ação" claro à primeira vista. `FocusLost` confirma em
Enter/perda de foco (mesmo padrão de `PortRow`) e só dispara o callback se o
valor mudou de verdade (evita gravar/republicar à toa a cada FocusLost sem
edição real) — campo vazio é um valor válido e intencional (não é tratado
como "cancelar", é "volte ao nome do Roblox"). `DISABLED_SETTINGS` (array)
perdeu o primeiro item — os 2 restantes (`Containers observados`/`Nível de
log`) foram reindexados para `[1]`/`[2]`.

**Contrato de `state`/`callbacks` no cabeçalho do arquivo** atualizado:
`state.customDisplayName: Source<string>` entrou no grupo de campos que
`StatusPanel` também ESCREVE diretamente (junto de `view`/
`notificationsEnabled`/`autoReconnectEnabled` — mesmo raciocínio: troca de
texto é estado local de UI até o `FocusLost` confirmar, só a PERSISTÊNCIA
exige o callback); `callbacks.onCustomDisplayNameSubmit(newName: string)`
entrou no grupo de callbacks que persistem/agem.

**Validação**: `selene plugin/src/` 0 errors, 41 warnings (só
`mixed_table`/`roblox_manual_fromscale_or_fromoffset`, mesmas 2 categorias já
aceitas — nenhuma categoria nova). `stylua --check` limpo nos 5 arquivos
tocados. `lune run` nos 5: todos parseiam o arquivo INTEIRO antes de falhar
no 1º acesso a global do Roblox (`game`/`script.Parent` — `Config.luau` nem
chega a falhar, carrega 100% porque não toca `game` no top-level), mesmo
padrão de sempre usado neste projeto pra confirmar sintaxe sem Studio.

**Não testado em Studio real** (2 Studios necessários — mesma ressalva de
sempre para qualquer coisa que toque `TestService.SyncTeam`/replicação):
roteiro sugerido — (1) setar o nome customizado em 1 Studio ANTES de
conectar, conectar, confirmar que a tabela de sessões do OUTRO Studio mostra
o nome customizado, não o nome do Roblox; (2) com sessão já conectada nos
dois lados, editar o campo no painel de 1 Studio e confirmar que o outro
Studio vê o nome mudar SEM precisar reconectar (e que uma mensagem de lease
negada, se disparada nesse meio-tempo, já usa o nome novo); (3) limpar o
campo (voltar a `""`) com sessão conectada e confirmar que volta a mostrar o
nome do Roblox (não fica em branco/vazio na tabela do outro lado).

## Reskin "Modux Companion" portado pro Luau real, 2026-08-02 (7ª rodada)

Tarefa de portar o reskin (6ª rodada, mockup) pra `plugin/src/ui/` **falhou
no meio** por limite de gasto mensal da conta (erro de API, não bug de
código). Estado em que ficou: `Theme.luau` e `StatusPanel.luau` já tinham
sido reescritos por completo (paleta nova, sem corner, texto
centralizado+negrito via `Theme.applyBold`, indicador de status quadrado,
conteúdo centralizado verticalmente — 0 errors no selene, 0 parse errors no
lune) — mas `Toast.luau` ainda usava tokens antigos que a nova `Theme.luau`
já tinha removido (`ConnectIdle`/`ConnectConnecting`/`ConnectActive`/
`FieldBackground`/`ToastText`/`Font.Title`/`Font.Body`), quebrando em
runtime (`BackgroundColor3`/`TextColor3` recebendo `nil`). **O orquestrador
(sessão principal) terminou esse pedaço específico diretamente** (não
delegou de novo, pra não arriscar outra falha de API): remapeou a
severidade do toast pra 4 casos (fonte de verdade:
`design-preview/styles.css`, `.st-toast__titlebar[data-severity=...]`) —
`sucesso`→`GreenStrong`, `aviso`→`YellowStrong`, `erro`→`RedStrong` (as 3
com texto branco `ButtonText`), `info` (default/fallback, inclusive
chamadores antigos que só passam `text`) → fundo `SubText` + texto PRETO
`ToastInfoText` (única exceção à regra de texto branco do reskin). Título e
corpo do toast também centralizados + negrito, fonte trocada pra
`Theme.Font.Rounded`. Validado: `selene plugin/src` 0 errors/0 parse errors,
`stylua --check` limpo, `lune run` chega até a 1ª linha que toca
`game:GetService` (padrão de sempre — confirma que o arquivo INTEIRO
parseou antes de rodar).

**Lição pra próxima vez que uma tarefa de reskin/token-removal for
dividida**: se `Theme.luau` for reescrito removendo tokens antigos, TODOS os
arquivos que os referenciam precisam ser atualizados na MESMA tarefa (ou a
tarefa precisa terminar com uma varredura final tipo
`grep -rn "Theme\.\(Color\|Font\|Layout\)\.\w\+"` cruzada contra os campos
que sobraram em `Theme.luau`) — não presumir que "só StatusPanel.luau e
Toast.luau usam Theme" é suficiente sem checar CADA referência depois da
reescrita, especialmente se a tarefa puder ser interrompida no meio.

## Reskin "Modux Companion" nas 3 telas Studio do mockup, 2026-08-02 (6ª rodada)

Pedido do usuário: reaplicar o visual de outro plugin dele (Modux Companion,
projeto separado — ModuxWatcher) nas 3 telas Roblox Studio de
`design-preview/` (`screen-studio-main`, `screen-studio-settings`,
`screen-studio-toast`). **Escopo estritamente mockup** — `plugin/src/` real
NÃO foi tocado; portar pro Luau é uma tarefa futura separada, depois de
aprovação visual. Telas VS Code do mockup (`.vsc-*`) também não tocadas de
propósito (identidade visual própria, ligada ao tema real do VS Code).

**Arquivos tocados**: `design-preview/styles.css` (grosso da mudança — novo
bloco `:root` com paleta `--mc-*` logo no início da seção 3, e reescrita de
todo o CSS de `.st-panel` pra baixo até o fim do toast), `design-preview/index.html`
(status square na titlebar principal, wrapper `.st-content` novo pra
centralização vertical, divisor `.st-divider` reusado em 2 lugares, select de
cor da INFO novo, `data-severity` no toast + opção "sucesso" nova no select),
`design-preview/app.js` (sync do quadrado de status com `connStatus`, função
`applyMainInfoColor`/`setMainInfoColorAndSyncLab`, toast trocou de
`style.background` inline por `dataset.severity` — cor 100% no CSS agora).

**Paleta**: variáveis `--mc-*` (prefixo "Modux Companion", pra não colidir
com `--tool-*` do chrome da própria ferramenta de preview) definidas 1x no
topo da seção 3 do CSS. Nomes espelham 1:1 os nomes do briefing do usuário
(`background/border/text/subtext/muted/green/greenStrong/...`). Regra
inegociável do briefing, sempre 2 tons por cor semântica: a versão clara
(`--mc-green` etc.) é só TEXTO/indicador sobre fundo escuro; a `-strong` é só
FUNDO de botão com texto branco em cima — nunca inverter. `--mc-blue` e
`--mc-purple` não têm par (o briefing já avisa) — não usados em nenhum botão
nesta tarefa por isso mesmo.

**Fonte "arredondada" sem webfont**: `--mc-font-rounded: "Nunito",
"Quicksand", "Century Gothic", system-ui, sans-serif` — decisão deliberada
de NÃO adicionar `<link>` de Google Fonts (o arquivo já se descreve como
"sem build step, sem pré-processador"; carregar fonte externa quebraria
isso e dependeria de rede pra um preview local). Century Gothic (já usada
no chrome do `.studio-window`) é o fallback real na prática — geométrica/
arredondada o bastante pra aproximar sem precisar de rede. Campo técnico
(porta) usa `--mc-font-mono` (Cascadia Code) — único lugar que foge da
fonte arredondada, por pedido explícito do briefing.

**Decisões não-óbvias / reconciliação com decisões anteriores**:

- **CONNECT (3 estados) usa cores diferentes do quadrado de status,
  DELIBERADAMENTE**: botão = "ação disponível" (disconnected→verde-forte
  como call-to-action "conectar"; connecting→amarelo-forte; connected→
  vermelho-forte porque clicar agora DESCONECTA, ação de parar). Quadrado
  de status na titlebar = "saúde da conexão" (disconnected→cinza/neutro;
  connecting→amarelo; connected→verde; vermelho reservado pra um futuro
  estado de erro genuíno, não modelado nos 3 `connStatus` atuais — a
  classe CSS `[data-state="error"]` já existe, só não é alcançável pelos
  controles do lab ainda). São duas leituras do mesmo estado, cores
  propositalmente não-espelhadas — documentar isso evita "corrigir" um dos
  dois achando que é inconsistência no futuro.
- **RESYNC idle reconciliado com decisão antiga de M4.5+ 5ª rodada** ("peso
  visual secundário, nunca cor de destaque"): o briefing novo exige TODOS
  os botões com texto branco + fundo "Strong". Reconciliação: idle usa
  `--mc-border` (único tom acromático do palette, sem parceiro "Strong"
  porque não é cor semântica) — continua lendo como secundário por ser
  cinza/dessaturado ao lado do CONNECT colorido, mesmo com texto branco
  igual nos dois.
- **Toast ganhou uma 4ª categoria** ("sucesso", verde) que não existia antes
  (eram só info/aviso/erro) — "info" foi REPAGINADO de "estado calmo azul"
  pra "fallback genérico/neutro" (fundo `--mc-subtext` claro, texto PRETO —
  única exceção à regra de texto branco no projeto inteiro, briefing
  explícito). Se um chamador real do produto (`Toast.show(text, severity)`,
  hoje só `"info"|"aviso"|"erro"`) quiser usar a cor verde de sucesso, vai
  precisar de um 4º valor de severidade (`"sucesso"`) quando isso for
  portado pro Luau — sinalizar ao `luau-dev` nessa hora.
- **Conteúdo do painel principal, centralização vertical**: técnica =
  wrapper novo `.st-content` (flex:1, `justify-content:center`) envolvendo
  tudo que fica abaixo da titlebar; a titlebar continua fixa no topo fora
  do wrapper. A tabela de sessões (`.st-table`) mudou de `flex:1` (esticava
  pra preencher, texto sempre colado no topo) pra `flex:none` +
  `max-height:150px` + `overflow-y:auto` — só assim o bloco inteiro
  (INFO/Porta/Connect/ReSync/tabela) centraliza como grupo em vez da tabela
  absorver todo o espaço livre e anular o efeito. Confirmado visualmente
  (screenshot) que o espaço acima do divisor e abaixo da última linha da
  tabela ficou aproximadamente igual. Tela de Configurações não precisou de
  wrapper novo — `.st-settings-body` já era o único bloco entre titlebar e
  fim do painel, só ganhou `flex:1; justify-content:center` direto.
- **Linha divisória `.st-divider`** (1px, `rgba(242,242,242,0.12)`) é UMA
  classe reusada em 2 lugares (topo do `.st-content` da tela principal, topo
  do `.st-settings-body`) — não criei uma segunda classe redundante.
- **Texto de linha da tabela (`st-row__user`/`st-row__info`) ficou de fora
  do "tudo centralizado + negrito"**: mantido peso 400 e alinhado à
  esquerda, só o CABEÇALHO da tabela (`st-tableheader`) ficou centralizado
  + negrito. Julgamento deliberado: dado dinâmico truncado (nome de
  colaborador, caminho de arquivo) fica pior de escanear centralizado, e
  negrito em toda uma lista competiria com os botões/títulos que devem ser
  o foco visual principal. Se o usuário reportar que quer TUDO centralizado
  sem exceção depois de ver o mockup, essa é a única linha que ficou de
  fora conscientemente.
- **`.studio-window*` (chrome que simula a janela real do Roblox Studio: 
  titlebar/menubar/toolbar/viewport) NÃO foi reskinado** — só o painel
  SyncTeam (`.st-*`) segue a paleta nova. Julgamento: esse chrome representa
  o Studio de verdade (que tem sua própria aparência, fora do controle do
  plugin), não faz sentido "pintar" ele com a paleta do Modux Companion.
  Se o usuário achar que quer o chrome também estilizado, é uma decisão
  nova a discutir, não algo que o checklist do briefing pedia (o briefing
  fala em "3 telas Studio" mas no contexto de "o painel", não da janela
  fake do Studio ao redor).
- **Leader dot da tabela virou quadrado** (era `border-radius:50%`,
  círculo) — decisão de consistência total com "sem cantos arredondados"
  do briefing, já que o indicador de status da titlebar também é quadrado.
  Pequeno, mas documentar pra não "corrigir de volta" pra círculo achando
  que foi engano.

**Verificação visual real feita nesta tarefa** (pedido explícito do
usuário: "rode/veja o index.html você mesmo antes de reportar"): sem
Puppeteer instalado no projeto, usei **CDP (Chrome DevTools Protocol) cru
via WebSocket nativo do Node 21+** (`new WebSocket(wsUrl)`, sem nenhum `npm
install`) — `chrome.exe --headless=new --remote-debugging-port=N`, `GET
/json/list` pra pegar a URL do DevTools, `Page.navigate` +
`Runtime.evaluate` (pra clicar nav-items/botões e ler `dataset.state`) +
`Page.captureScreenshot`. Confirmei visualmente as 3 telas E os 3 estados
dinâmicos do CONNECT/RESYNC (disconnected/connecting/connected,
idle/syncing/done) sem nenhum erro de JS (`exceptionDetails` vazio em todo
`Runtime.evaluate`). **Técnica reaproveitável por qualquer agente futuro que
precise de screenshot headless deste repo sem depender de instalar
Puppeteer/Playwright** — script ficou só no scratchpad da sessão, não
commitado (é ferramenta de verificação pontual, não parte do produto).

## M4.5+ — Painel Studio: InfoRow vira label+caixa, botão RESYNC (contrato), Toast em 2 faixas com severidade, 2026-08-02 (5ª rodada)

Portou 1:1 os 3 ajustes já aprovados/validados no mockup `design-preview/`
(que agora é a fonte de verdade pixel-a-pixel — CSS de
`design-preview/styles.css` tem os valores literais, ver seções `.st-inforow`/
`.st-resync-btn`/`.st-toast*`) para o Luau real. Arquivos:
`plugin/src/ui/StatusPanel.luau`, `plugin/src/ui/Toast.luau`,
`plugin/src/ui/Theme.luau`.

**InfoRow (era 1 TextLabel com `"INFO: [ %s ] %ds"` solto)**: virou label
fixo "INFO:" (44px, mesma largura do label "Porta") + uma CAIXA
somente-exibição (Frame+TextLabel, `Theme.Color.FieldBackground`/`FieldText`
— **nunca um TextBox**, o usuário só lê) + um "selo" (chip) pequeno de
segundos à DIREITA da caixa (`Theme.Color.FieldBackground` de novo, 40×18px,
corner radius `UDim.new(0,4)`), em vez de concatenar `"[ %s ] %ds"` dentro do
texto — decisão: chip evita competir com `TextTruncate` de mensagens de log
longas. `INFO_ROW_HEIGHT` agora É `PORT_ROW_HEIGHT` (30, era 18) — mesma
estrutura, mesma altura.

**Botão RESYNC** (`ResyncRow`, entre `ConnectRow` e `TableHeader`): 3 estados
lidos de `state.resyncState()` (`"idle"|"syncing"|"done"`, Source criada pelo
`luau-dev` em `PluginUI.luau` — `ui-dev` só CONSOME). Cores **zero
inventadas**: idle = `Theme.Color.IconButton`/`IconButtonHover` (cinza, com
hover — único estado clicável); syncing = `Theme.Color.ConnectConnecting`
(laranja, MESMO do CONNECT "connecting"); done = `Theme.Color.LeaderDot`
(único verde do Theme). **Decisão não especificada pela tarefa mas confirmada
pelo mockup aprovado**: syncing/done NÃO têm variação de hover (o CSS do
mockup faz o seletor `[data-state="syncing"]` vencer sobre `:hover` por ordem
de declaração) — só o estado idle reage a MouseEnter/Leave, porque só ele é
de fato clicável (`Activated` só chama `callbacks.onResyncRequest()` quando
`state.resyncState() == "idle"`). Texto: idle usa `Theme.Color.FieldText`
(tom discreto, peso visual SECUNDÁRIO de propósito — não deve competir com
CONNECT); syncing/done usam `Theme.Color.ButtonText` (branco), como todo
botão colorido do painel. Altura `RESYNC_ROW_HEIGHT = 28` (mais baixo que
`CONNECT_ROW_HEIGHT=34`, reforça o peso secundário; 28 coincide com
`Theme.Layout.IconButtonSize` por acaso, sem relação semântica).

**Contrato `state.resyncState`/`callbacks.onResyncRequest`** documentado no
cabeçalho do arquivo (comentário `state = {...}`/`callbacks = {...}`) — texto
exato acordado com `luau-dev` para a tarefa em paralelo. **Confirmado depois
que o `luau-dev` já tinha terminado a parte dele** (achado ao ler
`PluginUI.luau`/`init.server.luau`, ambos já modificados quando eu comecei):
os nomes batem 100% (`state.resyncState = resyncStateSource`,
`callbacks.onResyncRequest = callbacks.onResyncRequest` passthrough) —
nenhum ajuste necessário depois de eu terminar. Lição: quando duas tarefas em
paralelo compartilham um contrato só por texto de spec (sem código ainda
escrito por nenhum dos lados), vale a pena, ao terminar, grepar o lado do
outro agente pra CONFIRMAR que os nomes batem de verdade, não só assumir.

**Toast — duas faixas + severidade** (`Toast.show(text, severity)`,
`severity: "info"|"aviso"|"erro"` opcional, default `"info"`): faixa de cima
("SYNC TEAM" + botão X, ambos DENTRO do fluxo normal — nada mais floating por
cima do texto) muda de cor conforme severidade, reaproveitando as MESMAS 3
cores do CONNECT (`ConnectIdle`/`ConnectConnecting`/`ConnectActive` — info/
aviso/erro); faixa de baixo (corpo da mensagem) usa
`Theme.Color.FieldBackground` (cinza neutro, mesmo do portBox). Cantos RETOS
(removido `UICorner` do frame raiz) e `Frame "Accent"` de 4px removido por
completo (cor de severidade já vive inteira na faixa de cima). Botão de
fechar trocou de cor própria (`ToastCloseIdle`/`Hover`, removidas do Theme)
para `Theme.Color.ButtonText` fixo + hover via `TextTransparency` (0 → 0.25,
já que agora tem que contrastar sobre 3 fundos coloridos diferentes, não mais
1 fundo neutro único). `TITLE_BAND_HEIGHT` reaproveita
`Theme.Layout.TitleBarHeight` (36, mesmo do título do painel principal, pra
ler como a mesma linguagem visual); `BODY_HEIGHT = 48` é decisão nova (dá
~28px de texto, similar à área de texto do design antigo). Removidos de
`Theme.luau` (ficaram órfãos): `ToastBackground`, `ToastAccent`,
`ToastCloseIdle`, `ToastCloseHover` — `ToastText` continua (cor do corpo da
mensagem, não mudou).

**Achado crítico durante o "grep por `Toast.show(` no resto do plugin"** (a
tarefa pedia explicitamente essa verificação): `init.server.luau` — já escrito
pelo `luau-dev` em paralelo, uncommitted quando eu peguei a tarefa — chama
`Toast.show(friendlyMessage, "erro")` como função ESTÁTICA do módulo
(`local Toast = require(script.ui.Toast)`), **não** através de
`toastHandle.show()`/`PluginUI.notify` (de propósito: o toast de erro do
ReSync precisa aparecer sempre, ignorando a preferência "Mostrar
notificações", que só governa o caminho `PluginUI.notify`). Antes desta
tarefa, `Toast.luau` só expunha `Toast.mount(pluginObject) -> {show,
destroy}` — nenhuma função estática. Resolvido adicionando um singleton
módulo-level (`local activeToast = nil`, setado dentro de `Toast.mount`) +
`function Toast.show(text, severity)` que repassa pro `activeToast.show`
(no-op com log se chamado antes de qualquer `mount()`) — MESMO padrão já
usado por `Logger` no projeto (`Logger.init` guarda estado interno, chamadas
estáticas subsequentes usam esse estado). Lição geral: ao redesenhar a API
pública de um módulo de UI, sempre grepar TODOS os chamadores reais no
repo antes de declarar a tarefa concluída — inclusive os escritos por uma
tarefa paralela ainda não mesclada; o grep pedido explicitamente pela tarefa
foi o que pegou esse caso, não uma inspeção manual.

**CRLF armadilha (ambiente Windows)**: `Edit`/o ambiente local introduziram
terminadores CRLF nos 3 arquivos tocados (confirmado via `file <arquivo>`),
enquanto o resto do repo usa LF puro (sem `.gitattributes` — depende de
`core.autocrlf` do usuário) — isso fazia `stylua --check` reportar um diff de
100% das linhas (todo o arquivo aparecendo como removido+adicionado, sintoma
clássico de mismatch de line-ending, não de estilo real). Corrigido com
`sed -i 's/\r$//'` nos 3 arquivos antes de validar. Lição para a próxima vez:
se `stylua --check` mostrar um diff onde CADA linha do arquivo aparece como
alterada (não só as linhas realmente tocadas), suspeitar de CRLF/LF antes de
qualquer outra coisa — rodar `file <arquivo>` pra confirmar antes de tentar
"consertar" o conteúdo.

**Validação**: `selene plugin/src/` 0 errors (47 warnings, todas categorias
`mixed_table`/`roblox_manual_fromscale_or_fromoffset` já aceitas no projeto —
baseline antes das minhas 3 edições era 35; crescimento de 12 é proporcional
aos novos blocos `vide.create` adicionados, mesma categoria, não uma
regressão). `stylua --check` limpo nos 3 arquivos e no `plugin/src/` inteiro.
`lune run` nos 3 arquivos: parseiam limpo, param só no 1º global Roblox
(`script.Parent`/`game`/`Color3.fromRGB`), mesmo padrão de sempre. **Nada
testado em Studio real** (fora de escopo desta tarefa, que era só visual —
quem liga o clique do RESYNC de verdade e testa a mensagem `resyncRequest`/
`resyncResult` é o `luau-dev`, em paralelo).

## M3.4 revisão — Overlay de fundo era percebido como "erro no módulo inteiro": trocado por status bar, 2026-08-02

Usuário testou o overlay de M3.4 (entrada mais abaixo neste arquivo,
2026-07-16) em uso real e reportou que o `backgroundColor` laranja
translúcido cobrindo o documento inteiro (`isWholeLine`) parecia "erro no
módulo inteiro", não um aviso de lock de colaboração — mesmo com alpha baixo.
**Lição para a próxima vez que a tentação for "cobrir o editor inteiro para
não passar despercebido"**: em VS Code, qualquer `backgroundColor` de
decoração que cubra TODO o documento lê como "algo está errado com este
arquivo" (linter/diagnóstico), não como "atenção: metadado externo sobre
este arquivo" — o canal certo para esse segundo tipo de aviso é a **status
bar** (persistente, sempre visível, não compete com a leitura do código), não
o corpo do editor.

**Fix aplicado, padrão para avisos futuros do tipo "algo external limita este
arquivo/esta sessão"**:
- Remover `backgroundColor`/`isWholeLine` da decoração; manter só
  `overviewRulerColor`/`overviewRulerLane.Full` na MESMA range (a régua não
  compete com a leitura do texto, é um "radar" na borda). `hoverMessage`
  continua funcionando mesmo sem `backgroundColor` — anexado à mesma range,
  passar o mouse em qualquer linha do documento ainda mostra o aviso
  completo. Renomeei a variável (`overlayDecoration` → `rulerDecoration`)
  para o nome não mentir sobre o que o tipo faz.
- Rótulo inline pontual (`renderOptions.after`, uma linha só) pode continuar
  — é a diferença entre "uma marca de rodapé" e "o arquivo inteiro pintado".
- **Item de status bar dedicado por-arquivo-ativo é o padrão a reusar**:
  quando o aviso é sobre "o arquivo que estou olhando AGORA" (não todo editor
  visível), um `vscode.StatusBarItem` próprio, oculto via `.hide()` quando
  não aplicável (nunca "aparece vazio"), recalculado dentro do mesmo hook que
  já re-renderiza a decoração (aqui, `renderAll()` — nenhum novo listener
  precisou ser criado, o módulo já rodava nos pontos certos: leaseChanged,
  stop do serviço, troca de editor/lista de visíveis). **Reusar a cor de
  aviso já estabelecida** (`new
  vscode.ThemeColor("statusBarItem.warningBackground")`, mesma da
  `SyncTeamStatusBar`/`statusBarMenu.ts` para "no ar, aguardando plugin") em
  vez de inventar uma cor nova — dois avisos na mesma barra devem ler como a
  MESMA linguagem visual de "atenção", nunca cores diferentes concorrendo.
- **Prioridade de status bar**: itens mais genéricos/fundamentais
  (conexão geral) ganham prioridade MAIOR (mais à esquerda no grupo — aqui
  100); itens mais específicos/contextuais (lease do arquivo ativo) ganham
  prioridade um pouco menor (aqui 99, logo à direita do primeiro). Convenção
  a seguir: quanto mais "sempre relevante", mais à esquerda.
- **Lógica pura primeiro**: antes de tocar o arquivo `vscode`-dependente,
  adicionar a função de decisão em módulo puro já existente (aqui,
  `leaseBorderState.ts` ganhou `buildLeaseStatusBarVisual(state) ->
  {visible, text, tooltip}`, testável sem `vscode`) — nenhuma regra de
  negócio nova, só reempacota o MESMO estado que já decidia a decoração
  anterior. Mesma disciplina de sempre: strings centralizadas em `STRINGS`,
  texto pt-BR.
- Arquivos: `vscode-extension/src/ui/leaseBorderState.ts` (puro, +
  `buildLeaseStatusBarVisual`), `vscode-extension/src/ui/LeaseBorderDecoration.ts`
  (status bar item + rename), `vscode-extension/test/leaseBorderState.test.ts`
  (+3 testes). Ver `docs/DECISIONS.md` 2026-08-02 "3ª rodada" seção 3
  (continuação) para o detalhe completo.

## M4+ — Cursor remoto: rótulo inline → hover, barra piscando, 2026-07-29

Pedido do usuário depois de ver o M4 em uso: o rótulo com nome do
colaborador (`renderOptions.after` de `DecorationOptions`) era **inline** —
empurrava o texto real do documento local, ficando ilegível quando o cursor
remoto caía no meio de uma palavra. `RemoteCursorDecorations.ts` reescrito
com a técnica que fica valendo daqui pra frente sempre que precisar de um
"pisca" ou de um "rótulo que não pode deslocar texto" em decoração de
editor:

- **Pisca sem CSS animation**: `TextEditorDecorationType`/
  `DecorationRenderOptions` não tem `@keyframes`. Técnica: `setInterval`
  (530ms por fase, aproximando o caret nativo do SO/VS Code, sem precisão
  milimétrica) alternando entre a lista cheia de `DecorationOptions` e uma
  lista VAZIA no MESMO `DecorationType` reciclado (nunca recriar o tipo por
  frame). Reset de fase (`blinkVisible = true`) em toda mudança de presença/
  editor ativo/editores visíveis — um cursor que acabou de aparecer/mover
  sempre entra SÓLIDO, nunca numa fase aleatória do ciclo já em andamento
  (evita a sensação de "cadê o cursor, ele nem apareceu"). Timer limpo em
  `dispose()` (`clearInterval`), mesmo cuidado de vazamento de todo
  `setInterval`/`setTimeout` no projeto (ver `HeartbeatMonitor.ts` pro
  mesmo padrão de campo `timer: ReturnType<typeof setInterval> | null`).
- **Rótulo que NUNCA desloca texto = hover, não inline, e NUNCA no mesmo
  `DecorationType` que pisca**: quando um rótulo/badge precisa aparecer só
  sob demanda (mouse em cima) em vez de sempre visível/inline, criar um
  `DecorationType` **separado e invisível** (`createTextEditorDecorationType({})`
  — sem nenhuma propriedade de estilo) cobrindo uma range um pouco mais
  larga que o alvo real (aqui: 1 caractere a mais que a posição exata do
  cursor, pra não depender de acertar um alvo de largura zero com o mouse —
  ver `computeHoverRange`, prefere expandir pra DIREITA, cai pra ESQUERDA
  perto do fim de linha, mantém largura zero em linha vazia) e que carrega
  só o `hoverMessage`. Esse tipo de decoração **nunca pisca/nunca some** —
  se ele compartilhasse o ciclo de vida do elemento visual que pisca, o
  hover pararia de funcionar durante a fase "apagada", experiência ruim.
  Regra geral: sempre que uma decoração tiver uma parte "sempre visível
  levemente" (barra/ícone) e uma parte "só sob demanda" (nome/detalhe), são
  DOIS `DecorationType`s com ciclos de vida independentes, nunca um
  renderOptions condicional dentro do mesmo tipo.
- **Badge colorido em hover via HTML no `MarkdownString`**: `hoverMessage`
  aceita `vscode.MarkdownString`; com `supportHtml: true`, o sanitizador do
  VS Code permite `style` inline **somente em `<span>`**, **somente** nesta
  ordem exata: `color:<hex|var(--vscode-*)>;background-color:<hex|var(--vscode-*)>;border-radius:<N>px;`
  — confirmado lendo o código-fonte real (`domSanitize.ts`/
  `markdownRenderer.ts`, branch main E tag estável 1.131.0), ver
  `.claude/research/2026-07-29-markdownstring-supporthtml-span-style-badge.md`.
  **`padding` e `display` NÃO estão na allowlist** e, como a validação é do
  atributo `style` INTEIRO (não por propriedade), incluir `padding` derruba
  o `style` inteiro — pra dar "respiro" visual ao texto dentro do badge,
  usar `&nbsp;` no conteúdo (`&nbsp;${nome}&nbsp;`), nunca `padding`. Não
  depende de `isTrusted` (isso só habilita link `command:`). Sempre escapar
  texto livre (nome do colaborador) antes de embutir no `<span>`
  (`escapeHtml`: `&`/`<`/`>`) — é conteúdo remoto, não confiável 100%.
  `supportHtml` existe desde VS Code 1.62 (2021), sem necessidade de
  fallback de versão neste projeto.
- **Cor precisa ser hex** (`#rrggbb`) para entrar no regex do sanitizador —
  a paleta `COLLABORATOR_COLORS` de `PresenceTracker.ts` já é hex, nenhuma
  conversão extra necessária.
- **Não testado ponta-a-ponta** (mesma ressalva de sempre para tudo em
  `ui/*Decorations.ts`): puramente visual, precisa de VS Code real com
  cursor remoto de verdade pra confirmar pisca/hover/posição. Roteiro
  completo em `docs/PROJECT_STATUS.md` 2026-07-29.

## M4.5+ — Toggle real de "Reconectar automaticamente" no painel do plugin, 2026-07-20

Padrão para expor uma setting já existente (sem UI) como toggle real: NUNCA
criar uma segunda setting nem duplicar a lógica de resolução (`Config.resolveX`)
— só espelhar o valor num `vide.source` inicializado dentro do `pcall` de
`PluginUI.init` (mesmo lugar que já inicializava `notificationsEnabledSource`
via `Config.resolveNotificationsEnabled`).

**Dois padrões de callback distintos, escolha depende de ONDE a lógica
mora**:
- Se a ação do toggle é só `plugin:SetSetting(...)` (nenhuma dependência de
  `start()`/estado de conexão): implementar o callback INTEIRO dentro de
  `PluginUI.luau` (padrão `onNotificationsToggle` — self-contained, não
  precisa voltar pra `init.server.luau`).
- Se a ação depende de lógica que só `init.server.luau` conhece (`start()`,
  `isInRunOrPlayMode()`, `enabled`): o callback é só um PASSTHROUGH em
  `PluginUI.luau` (`onAutoReconnectToggle = callbacks.onAutoReconnectToggle`,
  sem lógica própria) e a implementação real vive em `init.server.luau`,
  dentro do MESMO bloco `PluginUI.init(plugin, {onConnect, onDisconnect,
  onPortChange, onAutoReconnectToggle})` que já hospeda `onConnect`/
  `onDisconnect`/`onPortChange` — nunca duplicar `isInRunOrPlayMode()` em
  `PluginUI.luau` (essa função é module-level privada de `init.server.luau`).

**Texto/label**: `SettingsRow("Reconectar automaticamente ao abrir a
place", ...)` — evitar a palavra "reconectar" sozinha porque no projeto ela
já tem um significado técnico DIFERENTE (o retry loop incondicional de
`runConnection`/`Config.RECONNECT_SECONDS` após queda de uma sessão viva,
que não tem nada a ver com esta setting) — o texto do toggle precisa deixar
claro que é sobre AUTOSTART (abrir a place / recarregar o plugin), não sobre
recuperação de queda. Botão em si (`AutoReconnectToggle`) é mirror visual
1:1 de `NotificationsToggle` (mesmo tamanho/posição/hover, texto
"Ativado"/"Desativado") — quando duas preferências booleanas do painel usam
o mesmo controle, reusar a MESMA aparência, só o texto do rótulo à esquerda
muda.

**Toggle que AGE, não só persiste**: quando o pedido explicitamente distingue
"isso é diferente do toggle passivo de notificações, esse aqui deveria
also fazer a coisa na hora" — implementar a ação (aqui: `task.spawn(start,
plugin)` ao ligar, se desconectado) reusando o MESMO caminho que o botão de
ação equivalente já usa (aqui: `onConnect`), incluindo o MESMO guard (Run/
Play) e o MESMO padrão de feedback (`Logger.notify`/toast quando recusado).
Deliberadamente assimétrico: desligar nunca desfaz uma ação já em curso
(aqui: não desconecta sessão viva) — só afeta o comportamento futuro. Regra
geral pra próxima vez que aparecer um toggle "ativo": ligar pode agir agora,
desligar só muda o padrão pra depois, nunca o inverso (evita surpresa de
"eu só queria parar de reconectar sozinho no futuro e caí da sessão atual").

- Referência validada: `RojoCoop/vscode-extension/src/ui/` — cores por
  colaborador mapeadas a temas do VS Code, cursor com etiqueta de nome
  posicionada abaixo da linha, seleção como overlay semitransparente,
  badge ● via FileDecorationProvider.

## M4 — Presença (lado extensão), 2026-07-15

Implementado: `src/presence/PresencePublisher.ts`, `src/presence/PresenceTracker.ts`,
`src/ui/FilePresenceDecorations.ts` (porte), `src/ui/RemoteCursorDecorations.ts`
(novo, sem referência). Protocolo aditivo (`presenceUpdate`/`presenceChanged`/
`presenceLeft`), sem bump de `PROTOCOL_VERSION` — ver `src/protocol.ts` e
`docs/DECISIONS.md`/`MILESTONES.md` M4 para o contrato fechado com o
`luau-dev`. 100/100 testes, lint e build limpos (só o lado extensão; teste
real com Studio/2 devs ainda pendente, precisa do lado plugin pronto).

**Arquitetura — divisão pura vs. vscode-dependente** (mesma disciplina de
`LeaseTracker.ts`/`SyncBridge.ts`): `PresenceTracker` e `PresencePublisher`
NÃO importam `vscode` — são testáveis com vitest puro porque o módulo
`vscode` não existe fora do Extension Host (importar `vscode` em qualquer
arquivo tocado por um teste quebra o vitest). Toda a parte vscode-dependente
(`FileDecorationProvider`, `createTextEditorDecorationType`,
`onDidChangeActiveTextEditor`) fica em `src/ui/` ou em `extension.ts`
diretamente, sem teste unitário direto (mesmo padrão já aceito para
`VscodeDiskIO.ts`, que também não tem teste próprio — só `NodeDiskIO` é
testado).

**Identidade por uuid, não por filePath** (diferença do RojoCoop): lá a
presença carregava `filePath` cru; aqui carrega `uuid` (identidade de script
do SyncTeam desde o M2). Isso exigiu duas resoluções novas em
`SyncBridge.ts`/`SyncTeamService.ts`: `resolveUuidForDiskPath` (já existia
como mapa privado `uuidByDiskPath`, só exposto) e `resolveDiskPathForUuid`
(direção inversa, nova — usada por `FilePresenceDecorations.fireChanges` pra
saber qual Uri notificar o VS Code quando a presença de um uuid muda).

**Transporte espontâneo sem ack**: `SyncServer` só tinha `request()`
(request/response com `requestId`). Adicionado `sendSpontaneous(message)`
(chama o `send()` privado direto) para `presenceUpdate`, que não tem
resposta — evita usar `request()` e tomar timeout de 10s à toa esperando um
ack que nunca vem.

**Decisões de design não 100% especificadas na tarefa** (documentadas aqui
porque a tarefa pediu explicitamente):

- **Staleness do PresenceTracker**: `PRESENCE_STALE_THRESHOLD_MS = 10_000`
  (10s). Raciocínio: é só rede de segurança contra sessão remota que sumiu
  sem mandar `presenceLeft` (ex.: crash não-gracioso do Studio remoto — a
  mesma lacuna não testada documentada em `DECISIONS.md` 2026-07-15 para
  sessões). Valor = staleness de SESSÃO já estabelecida no M3.1 (8s) + 2s de
  margem, para nunca expirar presença ANTES do próprio mecanismo de sessão
  detectar a queda — no caminho normal (desconexão graciosa) isso nunca
  deveria disparar. `expireStale(now, threshold)` é um método puro (recebe
  `now`, não usa timer interno) pra ficar determinístico em teste;
  `extension.ts` chama isso via `setInterval` a cada 5s
  (`PRESENCE_STALE_CHECK_INTERVAL_MS`).
- **Debounce de publish**: reaproveitada a mesma constante do
  FileSystemWatcher (`WATCH_DEBOUNCE_MS` = 150ms, renomeada localmente
  `PRESENCE_DEBOUNCE_MS` por clareza, mesmo valor) — um único timer
  compartilhado (não por-arquivo, diferente do watcher) porque só existe UM
  editor ativo local por vez.
- **Dedupe no PresencePublisher**: além do debounce em `extension.ts`,
  `PresencePublisher.publish` compara o payload serializado com o último
  enviado e não reenvia se idêntico — cobre o caso do debounce disparar sem
  mudança real (ex.: evento de seleção por foco, sem o cursor se mover).
  `resetDedupe()` existe pra forçar reenvio após reconexão (o plugin novo
  não tem memória do que já mandamos antes).
- **Paleta de cores**: portada literalmente de
  `RojoCoop/vscode-extension/src/presence/PresenceTracker.ts`
  (`COLLABORATOR_COLORS`, 8 cores hex: azul/vermelho/verde/amarelo/roxo/
  ciano/laranja/marrom), ciclando por índice (`getColorIndex` = posição
  alfabética do clientId — critério estável, não depende de ordem de
  chegada). Índice usado tanto no badge do Explorer (mapeado para
  `vscode.ThemeColor` — `charts.blue`/`charts.red`/etc., mesma lista
  `THEME_COLORS` do RojoCoop, adapta ao tema) quanto no cursor/seleção do
  editor (cor hex literal direto, com alpha 0.25 pro overlay de seleção via
  `hexToRgba` — ThemeColor não serve aqui porque `DecorationRenderOptions`
  precisa de mais controle de contraste do que os 8 tokens semânticos
  `charts.*` oferecem).
- **Técnica de cursor remoto** (sem referência pra portar — RojoCoop só
  tinha o badge do Explorer): borda esquerda de 2px (`borderWidth: "0 0 0
  2px"`) na cor do colaborador simulando um "caret", com um pseudo-elemento
  `after` (rótulo com o nome, fundo na cor do colaborador, texto branco)
  ANEXADO por `DecorationOptions.renderOptions` individualmente (não no
  `TextEditorDecorationType` em si) — necessário porque o texto do rótulo
  varia por colaborador mesmo quando duas pessoas compartilham a mesma cor
  (paleta cíclica de 8, mais de 8 simultâneos é o caso extremo aceito).
  Seleção: overlay `backgroundColor` translúcido num `Range` separado
  (âncora→cursor, `Range` normaliza start/end sozinho não importa a ordem).
  `hoverMessage` com o nome no cursor como reforço. `overviewRulerColor` no
  tipo do cursor pra aparecer na minimap/régua em arquivos longos.
  DecorationTypes são criadas 1x por índice de cor (não por colaborador nem
  por render) e recicladas — só o array de `DecorationOptions`/`Range` muda
  a cada `setDecorations`, seguindo a recomendação da API do VS Code.
- **Posição fora dos limites**: `clampPosition` (linha/coluna clampadas ao
  documento local) — aceito que um colaborador remoto pode estar vendo uma
  versão do arquivo com mais/menos linhas por edição concorrente ainda não
  convergida; sem reconciliação char-a-char (fora de escopo do v1, mesma
  decisão de "conflito no mesmo arquivo" em `DECISIONS.md`).
- **Ciclo de vida em `extension.ts`**: `PresenceTracker` é instanciado 1x em
  módulo (sobrevive a `syncteam.restart`, diferente de `service`).
  `PresencePublisher` é recriado a cada `startService` (amarrado ao
  transporte da conexão atual). `FilePresenceDecorations`/
  `RemoteCursorDecorations` são criados 1x em `activate()`, resolvendo
  uuid↔fsPath via closures que leem `service`/`projectDir` (variáveis de
  módulo mutáveis) NO MOMENTO da chamada, não capturadas na criação — assim
  sobrevivem a restart sem precisar recriar as decorações. `service.setOnPresenceReset`
  dispara tanto em `onClientConnected` quanto `onClientDisconnected`: limpa
  o tracker (presença remota) E força a minha própria presença a ser
  republicada do zero (`resetDedupe` + `schedulePresencePublish`).
- **Não implementado (fora de escopo, documentado)**: nenhuma mensagem
  "estou saindo" explícita do lado da extensão (o protocolo não define uma —
  a limpeza do lado do plugin já é coberta pelo mecanismo de sessão/heartbeat
  do M3.1). A extensão só limpa/republica presença local reagindo a
  `onPresenceReset` (conexão nova/caiu), nunca envia proativamente ao
  desativar.

**Pendente para fechar M4 de verdade**: teste com 2 Studios reais + 2 janelas
de VS Code (Extension Development Host), depois que o `luau-dev` fechar o
lado do plugin (`Sessions/<id>/Presence`, emissão de `presenceChanged`/
`presenceLeft`). Nada disso foi testado contra Studio/VS Code real nesta
sessão — só fakes/stubs em vitest, conforme pedido na tarefa.

## M3.4 — Aviso visual de lease alheia no VS Code (metade que faltava do lease-UX), 2026-07-16

Contexto: `docs/DECISIONS.md` já registrava "conflito no mesmo arquivo = lease
por arquivo... o outro vê o arquivo somente-leitura com aviso", mas só a
metade do Studio existia (nega a escrita) mais um `showWarningMessage`
PONTUAL do lado VS Code (`writeRejected`) — nada impedia o usuário de digitar
livremente num arquivo sob lease alheia, e não havia indicador PERSISTENTE.
Usuário pediu explicitamente "highlight nas bordas" / "forçar read-only",
priorizando VS Code (Studio fica para depois — API incerta lá, fora de
escopo desta tarefa).

**Arquivos novos**: `src/ui/leaseBorderState.ts` (puro, sem `vscode` —
`computeLeaseBorderState(leaseTracker, uuid) -> {locked, ownerName}` +
`STRINGS` centralizado) e `src/ui/LeaseBorderDecoration.ts`
(vscode-dependente, mesmo padrão de ciclo de vida de
`RemoteCursorDecorations.ts`). Teste puro em `test/leaseBorderState.test.ts`
(9 casos, cobre leaseTracker/uuid null, lease livre/minha/de outro, fallback
de nome). 159/159 testes, `tsc --noEmit` limpo.

**Reusado, não reinventado**: `LeaseTracker.isOwnedByMe`/`describeOwner` já
continham toda a regra de negócio (inclusive o caso otimista "lease nunca
arbitrada = permitir") — `computeLeaseBorderState` só decide o "show ou não"
e empacota o nome pro texto, nenhuma lógica de posse duplicada.

**Decisão de design — overlay de fundo translúcido, não borda por linha**:
avaliei as duas opções que a tarefa sugeria. Borda por linha
(`isWholeLine` + `borderStyle`/`borderWidth`) fica visualmente poluída em
arquivo longo (parece um grid de retângulos empilhados, não uma moldura
única) e o efeito de "página inteira avisando" que o usuário pediu não se
sustenta ao rolar. Escolhido: `backgroundColor` translúcido
(`rgba(224,132,32,0.14)`, mesma família de laranja "atenção/conectando" já
adotada no painel Vide do plugin — `Theme.ConnectConnecting`, ver entrada
M4.5+ acima — para manter a linguagem visual de aviso consistente nos dois
lados) cobrindo `Range(0,0, lastLine, lastLineLength)` com `isWholeLine:
true`, mais `overviewRulerColor` reforçando na régua/minimap (mesma técnica
de `RemoteCursorDecorations`). Reforço passivo: rótulo "🔒 Bloqueado por
`<nome>`" via `renderOptions.after` ancorado no fim da PRIMEIRA linha (tipo
de decoração SEPARADO do overlay, porque o texto do rótulo varia por dono e
não pode viver fixo no tipo reciclado).

**Limitação de API confirmada por pesquisa (não tentar contornar de novo)**:
não existe `editor.options.readOnly` por editor sem um `FileSystemProvider`
customizado (mudaria como TODO o workspace lê/escreve — fora de escopo, não
é "read-only só deste arquivo"). `vscode.workspace.onWillSaveTextDocument`
**não tem forma limpa de vetar o save**: `event.waitUntil` só aceita um
`Thenable<TextEdit[]>` para aplicar edições ANTES de salvar, não existe
`preventDefault`/cancelamento (confirmado via WebSearch na documentação e
issues do `microsoft/vscode`, 2026-07-16). Implementado como reforço
best-effort: `onWillSave` mostra `showWarningMessage` adicional quando o
arquivo salvo está sob lease alheia, mas o save PROSSEGUE — a rejeição real
continua vindo depois, do lado do Studio (`writeRejected`, já tratado).

**Ciclo de vida em `extension.ts`**: `leaseBorderDecoration` é module-level
(como `presenceTracker`), não local a `activate()`, porque o callback
`service.setOnLeaseChanged` é registrado dentro de `startService()` (função
top-level, recriada a cada start/restart/setPort) e precisa chamar
`leaseBorderDecoration.renderAll()` quando uma lease muda. Getter
`() => service?.getLeaseTracker() ?? null` passado ao construtor (não o
valor capturado), mesma técnica de `resolveUuidForFsPath` — `service` é
recriado a cada start. `stopService()` também chama `renderAll()` no final,
para o aviso não ficar "pendurado" num editor até a próxima troca de aba.

**Não testado em Studio/VS Code real** (pedido explícito de registrar como
pendente, mesmo padrão M3/M4): roteiro sugerido — (1) 2 Studios + 2 VS Code,
um edita um script, o outro abre o mesmo arquivo e confirma overlay laranja
+ rótulo "🔒 Bloqueado por `<nome>`" aparecendo; (2) editar mesmo assim e
salvar, confirmar o aviso adicional de `onWillSave` E a rejeição normal via
`writeRejected` depois; (3) lease expira por inatividade → confirmar que o
overlay some sozinho (via `renderAll` no próximo `leaseChanged`); (4) trocar
de aba/arquivo várias vezes rápido, confirmar que não sobra overlay em
arquivo errado. **Lado Studio (highlight/readonly no Script Editor nativo)
continua pendente de pesquisa de viabilidade** — não investigado nesta
tarefa (fora de escopo, API incerta, fica para sessão futura).

## M4.5 — Painel de status do plugin com Vide (lado Studio), 2026-07-15

Tarefa 100% do lado do plugin (Luau): substituir os 3 botões de toolbar
antigos por 1 painel de verdade (`DockWidgetPluginGui`), construído com
**Vide** (lib reativa nova no projeto, trazida pelo usuário nesta sessão).

**Achado ANTES de codar**: a tarefa dizia que `wally.toml`/`Packages/` já
existiam com Vide sincronizado — não existiam mais. Uma nota de sessão
anterior em `docs/PROJECT_STATUS.md` (M4, lado da extensão) registra que o
`ui-dev` de uma tarefa paralela **removeu** `rokit.toml`/`wally.toml`/
`wally.lock`/`Packages/` porque, naquele momento, Vide não era referenciado
em lugar nenhum do código. Recriei tudo do zero nesta tarefa: `plugin/wally.toml`
(`Vide = "centau/vide@0.4.1"`, registry UpliftGames), `wally install` gerou
`plugin/Packages/` (`Vide.lua` + `_Index/centau_vide@0.4.1/vide/`).
`plugin/default.project.json` ganhou um segundo nó no `tree` (`"Packages": {
"$path": "Packages" }`, irmão do `$path: "src"` raiz) — confirmado via
build+inspeção de árvore que `Packages` fica como Folder irmão direto de
`Config`/`Logger`/etc. sob o Script raiz, então o require de dentro de
`src/ui/*.luau` é `require(script.Parent.Parent.Packages.Vide)` (`script` =
o módulo ui atual, `.Parent` = pasta `ui`, `.Parent.Parent` = raiz do
plugin). `Packages/` foi colocado no `.gitignore` do plugin (regenerável via
`wally install`, mesmo princípio de `node_modules/`) — **importante**:
`Tools/build-and-deploy-plugin.sh` agora roda `wally install` antes de
`rojo build` por causa disso (senão falha em qualquer checkout limpo).

**Pesquisa feita antes de depender de Vide 0.4.1**: a lib usa
require-by-string relativo (`require "./graph"`) e o alias `@self`
internamente (só o entry-point real `src/init.luau` usa
`require(script.lib)`, instance-require tradicional). Confirmei via
WebSearch que require-by-string com paths relativos e `@self` são feature
LANÇADA (não beta) do Luau/Roblox, habilitada platform-wide desde maio de
2025 — salvo em
`.claude/research/2026-07-15-dockwidgetplugingui-and-require-by-string.md`
junto com a confirmação de `DockWidgetPluginGuiInfo.new`/
`CreateDockWidgetPluginGui` (API nunca usada antes neste projeto,
diferente de `CreateToolbar`/`CreateButton`, que já eram "bedrock" desde o
M1). Verifiquei também na prática: `rojo build` mantém os `require "./x"`
como texto dentro dos `ModuleScript`s gerados (não reescreve nada — é o
runtime do Roblox que resolve, não o Rojo).

### Arquitetura

- **`plugin/src/ui/Theme.luau`** (novo): cores/fontes/espaçamentos
  centralizados — nenhum valor mágico solto em outro arquivo. Paleta ESCURA
  FIXA (não reage ao tema claro/escuro do Studio — ver decisão abaixo).
- **`plugin/src/ui/Toast.luau`** (novo): toast reutilizável (1 só por vez,
  sem fila) — Vide só constrói o Frame (estilo via Theme), a ANIMAÇÃO
  (entrar/segurar/sair) é imperativa via `TweenService` + `task.delay`,
  protegida por token de geração (mesmo idioma de `currentToken` do resto do
  plugin) para uma chamada antiga de `show()` não fechar por cima de uma mais
  nova. `Toast.mount(parentFrame)` retorna `{ show = function(text) end }`.
- **`plugin/src/ui/StatusPanel.luau`** (novo): árvore de componentes Vide
  inteira — `MainView` (título/porta/connect+engrenagem/cabeçalho/tabela) e
  `SettingsView` (voltar/título/toggle de notificações/3 itens "em breve"),
  trocadas por `vide.switch(state.view) { main = ..., settings = ... }`
  dentro do MESMO Frame raiz (nunca um segundo `DockWidgetPluginGui`, spec da
  tarefa). Tabela via `vide.indexes(state.sessionsMap, rowComponent)`
  (chave = clientId, mantém a MESMA Instance de linha entre refreshes em vez
  de recriar tudo).
- **`plugin/src/ui/PluginUI.luau`** (novo): único ponto de contato entre
  `init.server.luau` (dono da lógica de conexão) e a UI. Cria
  toolbar+`DockWidgetPluginGui` 1x (ciclo de vida separado do
  `start()`/`stop()` de conexão — sobrevive a reconexões/troca de porta,
  só `plugin.Unloading` desliga o refresh em segundo plano), monta
  `StatusPanel` via `vide.mount`, expõe `init(pluginObject, callbacks)`/
  `setConnected(bool)`/`setPort(number)`/`notify(text)`/`stop()`.
  `callbacks = { onConnect, onDisconnect, onPortChange }` — nomenclatura
  igual à de `init.server.luau`, PluginUI só invoca, nunca reimplementa
  start()/stop()/troca de porta.

### Dados da tabela — getters read-only adicionados (sem mudar lógica interna)

Confirmando que nenhum módulo de coordenação precisou de refatoração —
só leituras pequenas adicionadas ao final de cada arquivo, todas puras
(nenhuma cria/muta Instance nem participa de eleição/lease/presença):

- `TeamCreateElection.getLeaderClientId()` / `.listSessions()` (array de
  `{clientId, username, userId, joinSequence}`, sessão própria incluída).
- `TeamCreateLease.forEachLease(callback(uuid, ownerClientId))`.
- `TeamCreatePresence.getActiveUuid(clientId)`.
- `ScriptRegistry.getCanonicalPath(uuid)` já existia desde o M2, reusado.

`PluginUI.buildSessionsMap()` (privada) combina os quatro: prioridade da
coluna INFO é lease ativa ("editando `<path>`") > presença sem lease
("vendo `<path>`") > "ocioso". **Decisão**: se uma sessão tiver lease em
mais de 1 uuid (extremo raro — leases não expiram por troca de arquivo, só
por inatividade, ver `TeamCreateLease.luau`), mostra só a primeira
encontrada (ordem de iteração de `Leases/*`, não garantida) — a spec pede
"texto único", então virar lista está fora de escopo.

**Ordem visual da tabela**: `vide.indexes` usa um `Map<clientId, RowData>`
como entrada — a ORDEM em que ele entrega o array de Instances (baseada em
iteração de tabela Lua) **não é garantida/estável entre refreshes**. Resolvido
por `LayoutOrder = joinSequence` em cada linha + `UIListLayout(SortOrder =
Enum.SortOrder.LayoutOrder)` no container — a ordem visual correta nunca
depende da ordem de criação/parenting das Instances, só do `LayoutOrder`.

### Decisões de design não 100% especificadas (documentadas aqui conforme pedido)

- **Cadência do refresh da tabela**: `Config.POLL_INTERVAL_SECONDS` (0.5s),
  reusando a mesma constante já validada como "responsividade de UX" no
  projeto (`checkLeaseDrift`/`checkPresenceDrift`), não o pulso de eleição
  (2s).
- **Paleta escura fixa, não reage ao tema claro/escuro do Studio**: mockup do
  usuário já pedia "título no topo escuro"; observar
  `StudioService`/`Settings().Studio.Theme` para adaptar ao tema claro fica
  para uma iteração futura (não pesquisado nesta tarefa — sinalizar se
  virar pedido explícito).
- **Widget começa fechado** (`DockWidgetPluginGuiInfo.new(...,
  initialEnabled=false, overrideRestore=false, ...)`) — só vale na
  primeiríssima instalação; Studio persiste sozinho o estado
  aberto/fechado real entre sessões depois disso. Botão de toolbar único
  (`"SyncTeam"`) faz `widget.Enabled = not widget.Enabled` e sincroniza
  `toggleButton:SetActive(widget.Enabled)` via
  `GetPropertyChangedSignal("Enabled")`.
- **Campo de porta**: `TextBox` com `Text` ligado reativamente a
  `state.port()` (one-way, só exibição); leitura do que o usuário digitou
  acontece em `FocusLost` (cobre Enter E perda de foco — os dois disparam o
  mesmo evento no Roblox, sem precisar distinguir motivo) via padrão
  "forward-declare local + closure captura upvalue" (`local portBox;
  portBox = vide.create "TextBox" { FocusLost = function() portBox.Text ...
  end }` — funciona porque o evento só dispara depois que a atribuição já
  aconteceu). Texto inválido (não-numérico) ou igual ao atual: reverte
  para o valor confirmado sem chamar callback. Nunca reinventa mecanismo de
  porta — `onPortSubmit`/`onPortChange` disparam a MESMA sequência que o
  antigo botão "Alternar porta" fazia (`SetSetting` + `stop()` +
  `start(plugin)`), só generalizada para porta arbitrária em vez de alternar
  entre 2 constantes fixas.
- **Botão CONNECT/DISCONNECT**: 1 botão só, cor+texto reativos a
  `state.connected()` (azul "CONNECT" / vermelho "DISCONNECT",
  `AutoButtonColor = false` porque a cor já é 100% controlada
  reativamente). Hover manual via `MouseEnter`/`MouseLeave` +
  `vide.source(false)` local (Theme já reservava cores de hover; sem hover
  os botões pareciam "mortos" ao lado da tabela reativa) — mesmo padrão
  aplicado à engrenagem e ao botão de voltar das configurações.
- **Ícones**: sem asset de imagem (nenhum disponível no projeto) — glyphs
  Unicode em `TextLabel`/`TextButton` (`\u{2699}` engrenagem, `\u{2190}` seta
  pra voltar). Simples, sem dependência de upload de imagem.
- **Toast**: `Frame` 240x56, `AnchorPoint(1,1)`, escondido via posição em
  OFFSET além da borda direita (`UDim2.new(1, W+margem+20, 1, -margem)`,
  Scale X=1 então funciona em qualquer largura de painel/flutuante),
  animado pra `UDim2.new(1, -margem, 1, -margem)`. `ClipsDescendants = true`
  no Frame raiz do painel é o que produz o efeito visual de "entrar
  deslizando" (a parte fora dos limites some sozinha até o tween trazer pra
  dentro) — sem esse `ClipsDescendants`, o toast ficaria visível fora do
  painel antes de entrar. Duração: entrada 0.28s, permanência 4.5s, saída
  0.22s (`Enum.EasingStyle.Quad`) — nenhum valor veio de referência, só
  bom senso de UX (rápido o suficiente pra não parecer lento, tempo de
  leitura razoável pra uma frase curta).
- **Mecanismo de toast genérico (`Logger.notify`)**: em vez de espalhar
  `PluginUI`/toast por `TeamCreateSchema.luau`/`TeamCreateLease.luau`
  (módulos de coordenação, que NÃO deveriam depender de UI), adicionei
  `Logger.notify(...)` em `Logger.luau` — mesmo `print`+forward-por-WS
  incondicional que `Logger.log` já fazia (extraído para
  `renderPrintAndForward`), MAIS uma chamada a um callback `onNotify`
  injetado via `Logger.initNotify` (mesmo padrão de `Logger.init`/
  `SourceWatcher.init`). Só os poucos pontos já identificados como "erro
  genuíno" viraram `Logger.notify` em vez de `Logger.log`:
  `TeamCreateSchema.luau` (reconciliação de duplicata) e
  `init.server.luau` (lease negada; falha de reconexão WS, novo). Isso
  satisfaz literalmente a regra da tarefa ("todo toast SEMPRE tem log
  correspondente, incondicional") sem precisar que módulos de baixo nível
  conheçam `PluginUI`.
- **Gatilho de toast para "reconexão falhando"**: criteriosamente PRECISA
  de uma conexão que já funcionou (`hasStabilizedOnce`, vira `true` só
  quando `receivedAnyMessage` fica `true` de verdade — não basta "ficou de
  pé um tempo", que é o critério mais fraco já usado pra persistir porta
  auto-descoberta) antes de disparar toast numa queda subsequente — sem
  isso, o cenário NORMAL "extensão VS Code ainda não foi aberta" (loop de
  reconexão a cada 3s desde o primeiro segundo) dispararia toast repetido
  desde sempre, exatamente o "evento rotineiro" que a spec pede pra NÃO
  notificar. `outageToasted` garante só 1 toast por "episódio" de queda
  (reseta quando uma nova conexão estabiliza de novo).
- **`view`/`notificationsEnabled` são Sources geridos DENTRO de
  `StatusPanel`/`PluginUI`, não callbacks de ida-e-volta**: trocar de tela
  e ligar/desligar notificações são estado 100% local de UI; só a
  PERSISTÊNCIA da preferência de notificações precisa de callback
  (`onNotificationsToggle`, chama `plugin:SetSetting` dentro do próprio
  `PluginUI.luau` — `init.server.luau` nunca fica sabendo dessa
  preferência).
- **Inclui a própria sessão na tabela** (não só sessões remotas) — "quem
  mais está na sessão" também se beneficia de ver o próprio status (sou eu
  o líder? o que eu tô editando?) num relance só.
- **Toda a UI protegida por `pcall`** no nível de `PluginUI.init` (API de
  Studio nova pro projeto — `DockWidgetPluginGuiInfo`/
  `CreateDockWidgetPluginGui`) e em `Logger.notify`→`onNotify` (uma falha na
  UI nunca deve derrubar a lógica de conexão/coordenação, que continua
  funcionando mesmo se o painel falhar ao inicializar).

### Validação desta tarefa

`rojo build` limpo (confirmado via build+inspeção da árvore de Instances
gerada — `Packages` aparece como Folder irmão de `Config`/`Logger`/etc. sob
o Script raiz, exatamente como esperado para os requires
`script.Parent.Parent.Packages.Vide`). `lune run` em TODOS os arquivos
novos/tocados (`Config.luau`, `Logger.luau`, `TeamCreateElection.luau`,
`TeamCreateLease.luau`, `TeamCreatePresence.luau`, `TeamCreateSchema.luau`,
`init.server.luau`, `ui/Theme.luau`, `ui/Toast.luau`, `ui/StatusPanel.luau`,
`ui/PluginUI.luau`) — todos passam sem erro de sintaxe. **Nota nova para
sessões futuras**: `ui/Theme.luau` produz um erro esperado DIFERENTE do
padrão usual do projeto — não toca `game`/`script` (é só uma tabela de
constantes), então o primeiro global Roblox-específico que ele toca é
`Color3` (`attempt to index nil with 'fromRGB'`), não
`game:GetService`/`script.Parent`. Mesma categoria de "prova que parseou
sem erro de sintaxe", só que via um datatype (`Color3`) em vez de um
serviço/instância — não confundir com um bug real numa sessão futura.

**Nada testado em Studio real nesta tarefa** (pedido explícito: registrar
como pendente, mesmo padrão de M3/M4). Roteiro sugerido para quando o
orquestrador testar contra Studio real: (1) confirmar que o painel abre/
fecha pelo botão único da toolbar; (2) editar a porta no campo e confirmar
que reconecta na porta nova (mesmo comportamento do antigo botão "Alternar
porta"); (3) CONNECT/DISCONNECT alternando cor/texto corretamente; (4)
engrenagem abre configurações, toggle de notificações persiste entre
reloads do plugin (`plugin:GetSetting`); (5) com 2 Studios reais, tabela
mostra as 2 sessões, bolinha só na líder, INFO correto (editando/vendo/
ocioso) conforme lease/presença mudam; (6) forçar uma rejeição de lease (2
Studios editando o mesmo script) e confirmar que aparece toast + o painel
auto-abre se estiver fechado; (7) desligar "Mostrar notificações" e
confirmar que o MESMO evento (5/6) loga no Output mas não anima toast.

## M4.5+ — UX do painel: estado "connecting" + popup em CoreGui, 2026-07-15

Duas melhorias pedidas pelo usuário depois de ver o painel funcionando em
Studio real, mais uma investigação. (Antes desta tarefa, 2 bugs do painel Vide
já tinham sido corrigidos pelo orquestrador: `StatusPanel.build` fora do escopo
`vide.root()`; `Enum.AutomaticCanvasSize` inexistente → `Enum.AutomaticSize` —
ver docs/DECISIONS.md 2026-07-15.)

### 1. Botão CONNECT com 3 estados (era booleano)

`state.connected: Source<boolean>` virou
`state.connectionStatus: Source<"disconnected"|"connecting"|"connected">`
(PluginUI `connectionStatusSource`, inicial "disconnected"). API do setter:
`PluginUI.setConnectionStatus(status)` (substitui `setConnected`), com
**dedupe** (só escreve se mudou) e validação (`VALID_STATUSES`) — runConnection
chama "connecting" toda volta do loop, sem dedupe reexecutaria os effects do
botão à toa.

- **Cores** (Theme): azul `ConnectIdle` RGB(46,111,219) = parado; **laranja
  novo** `ConnectConnecting` RGB(224,132,32) / hover (238,146,46) =
  tentando/reconectando; vermelho `ConnectActive` = conectado. Texto:
  `CONNECT` / `CONECTANDO...` / `DISCONNECT`.
- **Máquina de estados** (init.server.luau): `start()` → connecting (imediato,
  antes do loop); topo de `runConnection` → connecting (dedupe); ao
  **estabilizar** → connected; na **queda com `enabled` ainda true** →
  connecting (cobre a espera de RECONNECT_SECONDS sem prender em vermelho);
  `stop()` → disconnected. **"disconnected" é setado SÓ por `stop()`, nunca por
  runConnection** — essa é a chave que mata o flicker azul/vermelho: um loop de
  ConnectFail fica **laranja estável** em vez de piscar (o bug reportado). Removi
  o `setConnected(true)` otimista que ficava logo após `sendHello` (era ele +
  o `setConnected(false)` da queda que causavam o pisca-pisca).
- **Dois critérios de estabilização, de propósito diferentes**: o VISUAL
  (botão → vermelho) usa o critério FRACO `receivedAnyMessage OR (alive ≥
  PROBABLE_REJECTION_WINDOW=3s)` (mesmo da persistência de porta); o TOAST de
  queda mantém o critério FORTE `hasStabilizedOnce` (= só `receivedAnyMessage`).
  Consequência aceita (rara): um servidor estranho ocupando a porta que segure
  a conexão ≥3s sem falar nosso protocolo faria o botão ficar vermelho mas uma
  queda dele NÃO daria toast — tolerável (é exatamente o caso "não tenho certeza
  que é minha extensão"). No caso normal a extensão manda `listScripts` em ~1s,
  então vermelho aparece em <1s de qualquer jeito.
- **Ação do botão**: "disconnected" → `onConnect`; "connecting" E "connected"
  → `onDisconnect` (ambos oferecem PARAR — cancela o loop / encerra a conexão).

### 2. Popup de erro flutuante de verdade (ScreenGui em CoreGui)

`Toast.luau` reescrito: **não vive mais dentro do DockWidgetPluginGui**. Agora
cria um `ScreenGui` (`Name = "SyncTeamNotifications"`, `DisplayOrder=100`,
`IgnoreGuiInset=true`) parentado direto em `game:GetService("CoreGui")` —
técnica confirmada por pesquisa e usada pelo Rojo real
(`.claude/research/2026-07-15-plugin-floating-overlay-notification.md`). Frame
âncora inferior-direito, slide-in da direita, **botão ✕ no canto superior
direito** (hover imperativo), **some sozinho em 5s** (`HOLD_SECONDS`, era 4.5).

- **Sem escopo reativo**: o Toast agora usa `vide.create` só com props
  **estáticas** + handlers de evento; o texto é setado imperativamente em
  `show()`. Verifiquei na fonte da Vide 0.4.1 (`src/apply.luau`): props com
  valor-função que são `RBXScriptSignal` (MouseEnter/Activated) vão para
  `cache.events` e são conectadas via `:Connect` — **não criam effect**; só
  props NÃO-evento com valor-função chamam `implicit_effect` (que exige
  `assert_stable_scope`). Como o Toast não tem nenhuma dessas, `Toast.mount()`
  roda FORA de `vide.mount` (chamado por `PluginUI.init` diretamente, em pcall
  ISOLADO do pcall do painel — falha de CoreGui não pode matar o refresh da
  tabela). Isso o desacopla da árvore reativa do painel (era o que o confinava
  antes).
- **Ciclo de vida manual** (CoreGui NÃO é auto-limpo no unload do plugin, ao
  contrário do DockWidgetPluginGui — mesma classe do vazamento de
  WebStreamClient em DECISIONS.md): `mount()` faz **self-heal**
  (`CoreGui:FindFirstChild("SyncTeamNotifications")` + `:Destroy()` antes de
  criar, limpa vazamento de load anterior) e devolve `destroy()`, chamado por
  `PluginUI.stop()` (conectado a `plugin.Unloading`). `Toast.mount()` devolve
  `{ show, destroy }` (antes só `{ show }`).
- **`PluginUI.notify` NÃO força mais o painel abrir** (`widget.Enabled = true`
  removido): o popup aparece sozinho, forçar o painel seria intrusivo. Ressalva
  da pesquisa (a validar em teste real): overlay via CoreGui provavelmente só
  cobre o viewport 3D, não Explorer/Properties/Output — por isso o log no
  Output (`Logger.notify`, incondicional) segue sendo o registro GARANTIDO.
- `StatusPanel.build` deixou de montar o toast e agora retorna só o `rootFrame`
  (era tupla `rootFrame, toast`); removido `require(Toast)` de StatusPanel.
  `ClipsDescendants` do root do painel mantido só por higiene (não serve mais
  ao slide-in do toast).

### 3. Por que o toast NÃO apareceu na queda que o usuário testou — NÃO era bug

Cenário do usuário: loop de `erro WS 400 HttpError: ConnectFail` /
"desconectado; reconectando em 3s", sem nenhum popup. **Conclusão: (a) o
critério existente estava certo; era o cenário "nunca conectou de verdade".**
`ConnectFail` = o WebSocket NUNCA se estabeleceu (falha no upgrade HTTP) → a
extensão nunca validou o `hello` → nunca rodou `runInitialSync`/`listScripts` →
o plugin **nunca recebeu mensagem** → `receivedAnyMessage`/`hasStabilizedOnce`
nunca viraram true → toast intencionalmente silencioso (anti-spam do cenário
"extensão ainda não aberta", indistinguível de "caiu" pelo lado do plugin).
Confirmei o gatilho olhando a extensão:
`vscode-extension/src/sync/SyncTeamService.ts:81` chama
`bridge.runInitialSync(transport)` no `onClientConnected` → envia `listScripts`
(`SyncBridge.ts:241`). Logo **toda conexão saudável faz o plugin receber uma
mensagem em ~1s** — se ela cair DEPOIS disso, `hasStabilizedOnce` é true e a
queda dá 1 toast (via `outageToasted`). Não mexi no critério (era decisão
deliberada). **Bônus**: o estado laranja "connecting" do item 1 agora dá o
feedback contínuo que faltava durante o loop de ConnectFail (o botão fica
laranja o tempo todo em vez de nada/flicker), resolvendo a preocupação de fundo
do usuário sem enfraquecer o gatilho de toast.

### Validação desta tarefa

`rojo build` limpo + `lune run` limpo (parse) nos 5 arquivos tocados
(`Theme.luau`, `Toast.luau`, `StatusPanel.luau`, `PluginUI.luau`,
`init.server.luau`) — todos param no 1º global Roblox (Color3/game/script nil),
prova de compilação sem erro de sintaxe. Rebuild+deploy real e teste em Studio
NÃO rodados nesta tarefa (orquestrador faz depois). Roteiro extra para o teste
real: (a) confirmar botão laranja "CONECTANDO..." estável durante um loop sem
extensão aberta (não pisca azul/vermelho); (b) com extensão aberta, laranja →
vermelho em ~1s; (c) fechar a extensão com conexão viva → 1 toast de "conexão
perdida" + botão volta a laranja; (d) popup flutuante aparece sobre o viewport,
✕ fecha na hora, some sozinho em 5s; (e) confirmar VISUALMENTE se o popup cobre
ou não Explorer/Properties (ressalva da pesquisa); (f) reload do plugin não
deixa ScreenGui "SyncTeamNotifications" órfão em CoreGui (self-heal).
