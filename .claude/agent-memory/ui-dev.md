# Memória do ui-dev

Padrões visuais e convenções de texto adotados no SyncTeam.
Atualize ao final de cada tarefa; mantenha curto e acionável.

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
