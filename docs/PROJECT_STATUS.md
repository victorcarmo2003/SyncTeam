# Status do projeto

Última atualização: 2026-07-16 (autostart opt-in + consolidação de log de boot, plugin)

## Nota de sessão (2026-07-16, mais recente) — autostart opt-in + log de boot consolidado (plugin)

Usuário testou o painel M4.5 em Studio real e trouxe 3 pedidos (ver
`docs/DECISIONS.md` 2026-07-16 para o detalhe de cada um):

1. **Investigar `stop()` sem log de Run/Play** — descartado o guard de
   Run/Play e `onPortChange`/clique real como causa direta (leitura de
   código); candidato mais plausível não confirmado: redeploy do plugin via
   `Tools/build-and-deploy-plugin.ps1` disparando `plugin.Unloading`.
   **Prioridade rebaixada pelo próprio usuário** durante a tarefa: confirmou
   que o servidor da extensão estava desligado, o que já explica o ciclo
   `conectado`/`erro WS 400 ConnectFail`/`reconectando` como esperado. Fica
   `[Hipótese]`, sem instrumentação adicional (não pedida).
2. **Autostart agora é opt-in, default DESLIGADO**: `Config.AUTOSTART_SETTING_KEY`
   + `Config.resolveAutoStartEnabled` (`plugin/src/Config.luau`, default
   `false`). Auto-start incondicional só volta a acontecer com
   `plugin:SetSetting("SyncTeam_AutoStart", true)` manual (Command Bar, sem UI
   dedicada ainda). Botão CONNECT do painel (M4.5) já cobre conexão manual.
3. **Log de boot consolidado**: novo `Logger.debug(...)` (`plugin/src/Logger.luau`)
   — forward por WS igual a `Logger.log`, mas sem `print()` no Output. ~7
   linhas de subsistema por conexão (registry reconciliado, observação
   iniciada, sessão criada, leases/presença ciclo iniciado, `conectado`
   otimista, `iniciado. Conectando...`) rebaixadas para `Logger.debug`; uma
   ÚNICA linha `Logger.log` nova aparece quando a conexão de fato estabiliza:
   `"conectado em ws://... (N scripts observados)"` (via novo
   `SourceWatcher.getWatchedCount()`).

**Validado só por `rojo build` + `lune run`** nos 8 arquivos tocados — sem
erro de sintaxe. **Nada testado em Studio real nesta tarefa** — roteiro
pendente: reconectar com autostart desligado (confirmar que NÃO conecta
sozinho e que o log `"autostart desligado; use o painel..."` aparece);
`plugin:SetSetting("SyncTeam_AutoStart", true)` pelo Command Bar + reload
(confirmar que volta a auto-conectar); e confirmar visualmente que o Output
mostra só a linha consolidada de `"conectado"` em vez da rajada antiga.

## Nota de sessão (2026-07-16) — aviso visual de lease alheia no VS Code (lado Studio pendente)

`docs/DECISIONS.md` já registrava a decisão "conflito no mesmo arquivo = lease
por arquivo... o outro vê o arquivo somente-leitura com aviso", mas só metade
existia: o Studio já negava a escrita (`writeRejected`) e o VS Code só
mostrava um `showWarningMessage` PONTUAL na hora da rejeição — nada impedia o
usuário de continuar digitando num arquivo sob lease alheia, e não havia
indicador visual PERSISTENTE. Usuário pediu explicitamente "highlight nas
bordas"/"forçar read-only", priorizando o lado VS Code.

**Implementado pelo `ui-dev`** (lado VS Code, 100% completo e testado —
159/159 testes, `tsc --noEmit` limpo, **round-trip real em Studio/2 devs
ainda pendente**): `vscode-extension/src/ui/leaseBorderState.ts` (lógica
pura, decide "bloquear ou não" reusando `LeaseTracker.isOwnedByMe`/
`describeOwner` já existentes) + `vscode-extension/src/ui/LeaseBorderDecoration.ts`
(overlay de fundo translúcido laranja cobrindo o documento inteiro + rótulo
"🔒 Bloqueado por `<nome>`" na primeira linha), instanciado em `extension.ts`
e reagindo a `service.setOnLeaseChanged`. Reforço passivo no
`onWillSaveTextDocument` (aviso adicional ao tentar salvar um arquivo
bloqueado) — **limitação de API confirmada por pesquisa**: não existe forma
limpa de VETAR o save nesse hook (`waitUntil` só aplica edições, não
cancela), então o save prossegue e a rejeição real continua vindo do lado do
Studio depois. Detalhes de design (por que overlay em vez de borda por
linha, paleta laranja compartilhada com o painel Vide do plugin) em
`.claude/agent-memory/ui-dev.md`.

**Pendente**: (1) round-trip real em 2 Studios/2 VS Code do que foi
implementado agora; (2) **lado Studio** (highlight/readonly no Script Editor
nativo do Roblox) — não investigado nesta tarefa, viabilidade de API ainda
incerta, fica para uma sessão futura de pesquisa antes de codar.

## Nota de sessão (2026-07-15, tarde) — painel confirmado + 3 melhorias de UX pedidas pelo usuário

Usuário confirmou em Studio real que o painel Vide (M4.5) funciona depois
dos 2 fixes registrados em `docs/DECISIONS.md`. A partir do uso real,
pediu 3 melhorias, todas implementadas e verificadas (build/lint/test
limpos; **round-trip real em Studio ainda pendente** para as 3):

- **Porta padrão trocada para 1400** (era 34980) em `plugin/src/Config.luau`,
  `vscode-extension/src/extension.ts` e `package.json` — só afeta instalação
  NOVA; Studios com porta já persistida continuam nela até digitar a nova
  porta no campo do painel.
- **Botão CONNECT com 3 estados** (`ui-dev`): era binário azul/vermelho e
  piscava a cada ciclo do loop de reconexão (queixa do usuário). Agora
  `state.connectionStatus: "disconnected"|"connecting"|"connected"` —
  laranja "CONECTANDO..." estável durante todo o loop de retry; "conectado"
  visual usa critério fraco (igual à persistência de porta), toast de queda
  mantém o critério forte (`hasStabilizedOnce`) — decisão deliberada,
  documentada em `.claude/agent-memory/ui-dev.md`.
- **Popup de erro virou overlay de verdade** (`ui-dev`, pesquisa prévia em
  `.claude/research/2026-07-15-plugin-floating-overlay-notification.md`
  confirmou que plugins de Studio PODEM criar `ScreenGui` em
  `game:GetService("CoreGui")` — é isso que o Rojo real faz, não um
  `DockWidgetPluginGui` disfarçado). `Toast.luau` reescrito: `ScreenGui` em
  `CoreGui`, botão ✕ no canto superior direito, some sozinho em 5s. Não
  força mais o painel abrir (o popup já aparece sozinho). Ressalva não
  100% confirmada: overlay via CoreGui pode cobrir só o viewport 3D, não
  os painéis nativos do Studio — validar visualmente no teste real.
- **Investigação do "toast não apareceu"**: não era bug — `erro WS 400
  ConnectFail` em loop significa que o WebSocket nunca completou o
  handshake, então o plugin nunca recebeu nenhuma mensagem do harness
  (`hasStabilizedOnce` nunca vira true) — supressão de toast é
  intencional pra não notificar o cenário rotineiro "extensão ainda não
  aberta". O estado laranja novo já resolve a queixa de fundo (feedback
  visual contínuo durante o loop).
- **Comando novo "Refresh Sync"** (`extension-dev`,
  `syncteam.refreshSync`): reconciliação bidirecional sob demanda pra
  pegar deriva que o watcher ao vivo perdeu (ex.: script `.bat`/`.ps1` ou
  edição externa enquanto a extensão estava fechada). Merge de 3 vias
  usando `contentCache` (SyncBridge) como ancestral comum: só disco mudou →
  propaga pro Studio; só Studio mudou → propaga pro disco; convergiram →
  só atualiza baseline; **conflito genuíno (os 2 mudaram e divergem)** →
  não sobrescreve nenhum lado, avisa o usuário via `showWarningMessage`
  listando os arquivos, resolução manual (M5 "artefato de conflito legível"
  ainda não existe — isso é o piso mínimo até lá). 108/108 testes (vitest),
  typecheck e build limpos.
- **Pendente pra fechar de vez**: round-trip real em Studio dos 3 itens
  acima (deploy já feito, usuário testando).

## Nota de sessão (2026-07-15, madrugada) — painel Vide não aparecia: bug real encontrado e corrigido

Usuário reportou em teste real: "cliquei no SyncTeam mas não surgiu nada na
interface". Investigação (sem MCP Roblox_Studio disponível nesta sessão,
harness sem visão desse momento específico do boot — ver achado abaixo)
levou à leitura direta do código vendorizado do Vide
(`plugin/Packages/_Index/centau_vide@0.4.1/`). Causa raiz e fix completos em
`docs/DECISIONS.md` (entrada "M4.5: painel Vide não montava..."), resumo:
`StatusPanel.build(...)` rodava fora do escopo de `vide.root()` (só
`vide.mount`, chamado DEPOIS, empurra esse escopo) — toda propriedade
reativa lançava `assert_stable_scope()`, painel nunca montava (toolbar+
widget vazio criados, conteúdo não). Corrigido movendo `StatusPanel.build`
para dentro do closure de `vide.mount`. Rebuild+deploy feito
(`Tools/build-and-deploy-plugin.sh`). **Não promovido a `[Verificado]`** —
aguardando o usuário confirmar que o painel aparece agora.

Também removidos da pasta de Plugins arquivos velhos de spike (`SyncTeamM0.lua`,
`SyncTeamM1.rbxm`, uma versão antiga de `SyncTeam.rbxm`) que estavam na
subpasta `inactive/` do Roblox (desabilitados via Studio, não pelo nosso
código) — limpeza pedida pelo usuário, sem relação com o bug acima.

## Nota de sessão (2026-07-15, noite) — painel de status do plugin (Vide), substitui os 3 botões de toolbar

Pedido do usuário: decidir uma interface pro plugin (mockup: título, campo de
porta, botão CONNECT, tabela USER|INFO) e construir com **Vide** (lib
reativa nova no projeto, trazida pelo usuário via Wally nesta sessão).
Tarefa 100% `ui-dev`, lado do plugin (Luau) — ver `.claude/agent-memory/ui-dev.md`
seção "M4.5 — Painel de status do plugin com Vide" pro detalhe completo.

- **Toolbar reduzida a 1 botão** (toggle abre/fecha o `DockWidgetPluginGui`
  novo) — substitui os 3 antigos ("Conectar"/"Parar"/"Alternar porta").
- **Painel novo** (`plugin/src/ui/{Theme,Toast,StatusPanel,PluginUI}.luau`):
  campo de porta editável (reusa a mesma sequência de troca de porta que o
  botão antigo já fazia — `SetSetting`+`stop()`+`start()`, só generalizada
  pra porta arbitrária), botão CONNECT/DISCONNECT reativo, engrenagem que
  abre tela de configurações (só "mostrar notificações" é real; resto
  "em breve"), tabela USER|INFO com bolinha só no líder e INFO priorizando
  lease ativa > presença sem lease > "ocioso" — dados lidos via getters
  read-only pequenos adicionados a `TeamCreateElection`/`TeamCreateLease`/
  `TeamCreatePresence` (nenhuma mudança na lógica de eleição/lease/presença
  em si).
- **Toast interno ao painel**: `Logger.notify` (novo, ao lado de
  `Logger.log`) dispara toast (tween da direita) SÓ pros poucos pontos já
  identificados como erro genuíno (lease negada, reconexão WS falhando
  depois de já ter estabilizado uma vez, reconciliação de duplicata do
  schema) — sempre loga no Output incondicionalmente, painel auto-abre se
  estava fechado. Dedupe por "episódio de queda" evita spam no cenário
  normal de reconectar antes da extensão VS Code abrir.
- **Achado de coordenação entre tarefas paralelas**: a tarefa de M4
  (extensão, nota abaixo) tinha removido `wally.toml`/`Packages/` do plugin
  por achar Vide "não usado em lugar nenhum" NAQUELE momento (antes desta
  tarefa existir) — recriado do zero aqui. Lição registrada: `git status`
  de trabalho delegado antes de aceitar como pronto, mesmo entre tarefas
  supostamente independentes.
- **Validado nesta sessão** (não só relato do agente): `rojo build` limpo,
  `lune run` sem erro de sintaxe (erro esperado só na primeira linha que
  toca `game`/`plugin`/`script`) em todos os arquivos novos/tocados.
  **Nada testado em Studio real** — pendente (precisa ver o painel de
  verdade: cores, tween do toast, tabela populando com sessões reais).

## Nota de sessão (2026-07-15, tarde) — M4, lado da extensão: publicar/renderizar presença

Tarefa do `ui-dev`, paralela ao `luau-dev` (nota abaixo), contrato de
protocolo fechado entre os dois antes de começar (mensagens `presenceUpdate`
extensão→plugin, `presenceChanged`/`presenceLeft` plugin→extensão).

- **Novo**: `src/presence/PresencePublisher.ts` + `PresenceTracker.ts`
  (módulos puros, sem `import "vscode"`, testáveis com vitest simples) e
  `src/ui/FilePresenceDecorations.ts` (porte do badge `●` do Explorer do
  RojoCoop) + `src/ui/RemoteCursorDecorations.ts` (cursor/seleção coloridos
  DENTRO do editor — trabalho novo, sem referência no RojoCoop, que só
  validou o badge).
- **Modificado**: `protocol.ts` (3 tipos novos, aditivos, sem bump de
  `PROTOCOL_VERSION`), `SyncServer.sendSpontaneous` (envio sem
  requestId/ack), `SyncBridge`/`SyncTeamService` (`resolveUuidForDiskPath`/
  `resolveDiskPathForUuid` + roteamento de `presenceChanged`/`presenceLeft`
  com a mesma normalização `undefined→null` já usada em `leaseChanged`),
  `extension.ts` (wiring completo, debounce de 150ms na publicação).
- **Verificado nesta sessão** (independente do relato do agente):
  `npm run lint` (tsc --noEmit) limpo, `npm test` 100/100 passando, `npm run
  build` limpo.
- **Achado ao revisar o trabalho do `luau-dev` (não pedido, removido)**: a
  tarefa dele deixou pra trás `rokit.toml`/`wally.toml`/`wally.lock`/
  `Packages/` (dependência Wally de uma lib de UI reativa, `vide`,
  **nunca usada em lugar nenhum do código** — nem `TeamCreatePresence.luau`
  nem `init.server.luau` a referenciam). Removido antes de qualquer commit.
  Registrar como lembrete: revisar `git status` de trabalho delegado antes
  de commitar, mesmo quando o agente reporta sucesso — relato descreve
  intenção, não necessariamente execução completa.
- **Pendente, MAIS pesado que M1-M3**: teste real precisa de **2 janelas de
  VS Code Extension Development Host** (não dá pra usar só o harness Node —
  presença depende de `vscode.window`, que não existe fora de um VS Code de
  verdade), cada uma conectada a um Studio diferente. Ver `docs/MILESTONES.md`
  (M4) para o roteiro.

## Nota de sessão (2026-07-15, tarde) — M4, lado do plugin: presença (cursor/seleção/arquivo ativo)

Tarefa do `luau-dev`, paralela ao trabalho do `ui-dev` no lado da extensão
(contrato de protocolo já fechado entre os dois, ver `plugin/src/TeamCreatePresence.luau`).

- **Módulo novo `plugin/src/TeamCreatePresence.luau`**: passthrough puro de
  cursor/seleção/arquivo ativo vindo da extensão VS Code — o plugin NUNCA lê
  cursor de uma Instance de Script no Studio. Grava a própria presença em
  `Sessions/<clientId>/Presence` (`ActiveScriptUuid` `""=nenhum`,
  `CursorLine`/`CursorColumn`/`SelectionStartLine`/`SelectionStartColumn`
  `IntValue` `-1=null`) ao receber `presenceUpdate` (espontânea, sem ack), e
  observa as sessões de outros devs no mesmo ciclo de poll de
  `TeamCreateLease.checkLeaseDrift` (`Config.POLL_INTERVAL_SECONDS`),
  emitindo `presenceChanged`/`presenceLeft` espontâneos. Mesmo padrão
  estrutural de `TeamCreateLease.luau` (schema/ensure, token de geração,
  dedupe por último valor visto).
- **Integrado em `plugin/src/init.server.luau`**: dispatch de `presenceUpdate`
  em `handleMessage`; `TeamCreatePresence.init(sendMessage)`/`.start()` em
  `start()` (depois de `TeamCreateElection.start()`); `.stop()` em `stop()`
  (ao lado de `TeamCreateLease.stop()`).
- Decisões de design não 100% especificadas na tarefa (dedupe por chave
  composta, dois gatilhos distintos para `presenceLeft`, escrita protegida
  por `pcall` por ser o primeiro campo numérico do schema vindo direto de
  mensagem externa não confiável) documentadas em detalhe em
  `.claude/agent-memory/luau-dev.md` (seção "M4 — Presença...").
- **Validado só por `rojo build` + `lune run`** (`TeamCreatePresence.luau`
  novo, `init.server.luau`) — sem erro de sintaxe, erro esperado só na
  primeira linha que toca `script`/`game`. **Nada testado em Studio real
  nesta tarefa** — pendente o lado da extensão (`ui-dev`) terminar para
  rodar o roteiro combinado com 2 Studios (latência ~2s, troca de arquivo
  ativo, `presenceLeft` ao fechar editor/Studio). `docs/MILESTONES.md` (M4)
  atualizado com o item do plugin marcado `[Implementado]`.

## Nota de sessão (2026-07-15) — M3 fechado com 2 Studios reais

Pedido do usuário: terminar o M3 hoje. Rodado o roteiro combinado completo
(`Tools/`, sem colar Output) contra os 2 Studios reais (userId `9203551752` e
`1402101248`), com o código atual (inclui auto-descoberta de porta e Logger
centralizado, ambos usados de verdade pela primeira vez nesta sessão):

- **Build+deploy+harnesses**: `Tools/build-and-deploy-plugin.sh` seguido de
  `Tools/start-harness.sh` nas duas portas — os dois Studios reconectaram
  sozinhos, auto-descoberta de porta confirmou "porta 34980 confirmada e
  salva" no Studio A sem precisar clicar "Alternar porta" (setup já feito
  em sessão anterior).
- **M3.1 (eleição)**: convergência reconfirmada (mesmo `LeaderClientId` nos
  dois lados). Failover forçado (fechar a janela do Studio líder) promoveu
  o outro em **~3s** — mais rápido que o esperado porque fechar a janela no
  Windows dispara `plugin.Unloading` de verdade (`stop()` síncrono remove a
  sessão na hora, não precisa esperar os 8s de staleness). Detalhe completo
  em `docs/DECISIONS.md` (entrada 2026-07-15).
- **M3.2 (leases)**: rejeição confirmada com timestamps reais — dev A
  segurando o lease, dev B tentando escrever o MESMO script
  (`ServerScriptService/Server/Renamed`) foi recusado
  (`writeAck ok=false`/"lease negada — script sendo editado por
  dev_Hakor"); depois que o intent de A expirou, líder reatribuiu a B, que
  reenviou e foi aceito. **Cuidado de timing**: a primeira tentativa via 2
  chamadas de `Edit` (latência de modelo entre elas) ficou por acidente bem
  em cima do limiar de 8s e não gerou rejeição nenhuma — refeito com
  escrita direta via shell (gap curto e controlado) para garantir
  sobreposição real. Ver DECISIONS.md para a lição de timing.
- **Não-regressão**: dois scripts DIFERENTES criados por cada dev na mesma
  janela — zero interferência, uuids corretos, replicação cruzada correta.
- **M3.3**: camada de dados confirmada (mesmos logs de rejeição/leaseChanged
  acima); o aviso VISÍVEL (`showWarningMessage`) numa janela real de VS Code
  não foi reverificado nesta sessão (só harness Node) — único item de M3
  ainda em aberto, não bloqueante (lógica já validada por teste unitário +
  pelos logs de hoje).
- **M3.1/M3.2 marcados `[Verificado 2026-07-15]` em `docs/MILESTONES.md`.**

## Nota de sessão (2026-07-07, noite) — auto-descoberta de porta (resolve a colisão 34980/34981 citada logo abaixo)

Seguimento direto do "Pendente de setup" da nota anterior (Studio2 colidindo
na mesma porta do Studio1 depois de um redeploy, exigindo clique manual no
botão "Alternar porta"). Pedido do usuário: fazer o PRÓPRIO plugin se
autodescobrir em vez de depender desse clique.

- **`Config.CANDIDATE_PORTS = {34980, 34981}`** (novo, `plugin/src/Config.luau`)
  — só entra em jogo quando NÃO há nenhuma porta já persistida via
  `plugin:SetSetting` (manual ou de descoberta automática anterior);
  `Config.resolveCandidatePorts(pluginObject)` devolve `(lista, explicit)`.
- **`runConnection` (`plugin/src/init.server.luau`) cicla candidatas ao
  detectar "rejeição provável"**: conexão caiu sem NUNCA ter recebido
  nenhuma mensagem do harness E dentro de `Config.PROBABLE_REJECTION_WINDOW_SECONDS`
  (3s) desde que abriu. Critério deliberadamente NÃO depende de interpretar
  `code`/`errorMessage` do evento `Error` do `WebStreamClient` (sem
  confirmação salva em `.claude/research/` sobre como o close code 1013 do
  harness — `socket.close(1013, ...)` em `SyncServer.ts` — aparece nesses
  parâmetros) — só observação local (tempo + mensagens recebidas). Uma queda
  que ficou de pé mais que a janela ou que já recebeu mensagem é queda
  normal (reconecta na MESMA porta, comportamento de antes).
- **Persistência da porta descoberta**: assim que a conexão "estabiliza"
  (recebeu qualquer mensagem OU passou da janela curta sem cair) E a porta
  não era explícita, `plugin:SetSetting(Config.PORT_SETTING_KEY, port)` é
  chamado — reload futuro do mesmo Studio já reconecta direto, sem ciclar de
  novo. Nunca sobrescreve uma porta setada manualmente (botão "Alternar
  porta", mantido como fallback, inalterado).
- **Validado só por `rojo build` + `lune run`** (`Config.luau`,
  `init.server.luau`) — sem erro de sintaxe. **Nada testado em Studio real
  nesta tarefa** — roteiro: derrubar os dois harnesses, remover a porta
  persistida dos dois Studios (ou usar builds novos), subir só o harness A
  (34980), confirmar nos logs (`Tools/logs/studio-*.log`) que o segundo
  Studio loga "porta 34980 parece ocupada, tentando 34981..." seguido de
  "porta 34981 confirmada e salva" ao conectar no harness B.

## Nota de sessão (2026-07-07, fim de tarde) — `Tools/` fechada: teste autônomo sem intervenção do usuário

Pedido do usuário: montar tudo que a IA precisa para testar o M3+ sozinha
contra os 2 Studios reais que ele deixa abertos, sem precisar colar Output
nem clicar em nada a cada rodada (exceto o setup inicial de porta). Ver
[Tools/README.md](../Tools/README.md) para o fluxo completo — resumo aqui:

- **MCP `Roblox_Studio`** adicionado (`claude mcp add --transport stdio
  Roblox_Studio -- cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`) — **rodar
  esse comando pelo Bash/git-bash mangla `/c` para `C:/` (MSYS path
  conversion) e quebra a conexão; usar o PowerShell tool evita isso**.
  Conecta (`claude mcp list` mostra "✔ Connected"), mas as tools
  `mcp__Roblox_Studio__*` não populam na MESMA sessão em que foi
  adicionado — parece exigir restart do Claude Code. Tratado como canal
  complementar, não principal (o usuário já avisou que pode enxergar só 1
  dos 2 Studios).
- **Canal principal de observação, sem MCP**: `plugin/src/Logger.luau`
  (novo, `luau-dev`) centraliza os 6 `log()` locais duplicados e encaminha
  TODO log também como `{kind: "log", text: ...}` pela MESMA conexão WS já
  existente com o harness — sem conexão nova, sem tocar no limite de 6
  `WebStreamClient`. Do lado do harness (`extension-dev`):
  `createFileLogger`/`createTeeLogger` novos em
  `vscode-extension/src/util/logger.ts`, `SyncTeamService.routeSpontaneous`
  ganhou o `case "log"`, `run-node-harness.ts` lê `SYNCTEAM_LOG_FILE` e
  passa a gravar em arquivo (console continua funcionando igual quando a
  env var não está setada). Formato de linha e detalhes completos em
  `Tools/README.md`.
- **Validado end-to-end nesta sessão, de verdade** (não só teoria): plugin
  reconstruído (`Tools/build-and-deploy-plugin.sh`) e reimplantado; harnesses
  antigos derrubados e subidos de novo via `Tools/start-harness.sh` com
  `SYNCTEAM_LOG_FILE` setado; `Tools/logs/studio-34981.log` mostrou a linha
  `[studio] [SyncTeam 13:31:55] conectado em ws://127.0.0.1:34981` —
  confirma que um log gerado DENTRO do Studio chegou no arquivo em disco
  sem nenhuma ação do usuário.
- **Pendente de setup**: Studio2 (`1402101248`) não reconectou ao harness A
  (34980) depois do redeploy — provavelmente ainda com a porta 34981
  persistida (`plugin:SetSetting`) de um teste anterior, colidindo com
  Studio1. Próxima vez que o usuário estiver por perto, pedir para conferir/
  clicar "SyncTeam: Alternar porta" em um dos dois se os dois harnesses não
  mostrarem exatamente 1 Studio conectado cada.
- **Testes ainda não automatizáveis, mesmo com essa infra**: fechar a janela
  do Studio líder (failover forçado do M3.1) e o setup inicial de porta
  (primeira vez, ou depois de uma colisão) exigem ação física do usuário
  dentro do Studio. Todo o resto do ciclo (build/deploy do plugin, disparar
  edições via arquivo em disco, ler resultado) já é autônomo.

## Nota de sessão (2026-07-07) — logger centralizado no plugin (observabilidade sem colar Output manualmente)

Lado do plugin de uma tarefa maior (o outro lado, extensão/harness gravando
em arquivo, é trabalho paralelo de `extension-dev`): `plugin/src/Logger.luau`
(novo) centraliza o `local function log(...)` que antes existia duplicado em
6 arquivos (`init.server.luau`, `TeamCreateElection.luau`,
`TeamCreateSchema.luau`, `TeamCreateLease.luau`, `ScriptRegistry.luau`,
`SourceWatcher.luau`). `Logger.log(...)` mantém o `print(prefix, ...)`
IDÊNTICO ao de antes (Output do Studio inalterado) e, se houver um
`sendMessage` injetado via `Logger.init` (mesmo padrão de
`SourceWatcher.init`/`TeamCreateLease.init`), encaminha o texto pela mesma
conexão WS já existente como `{kind = "log", text = ...}`. `Logger.init(sendMessage)`
é chamado em `init.server.luau` `start()`, mesmo lugar que já chama
`SourceWatcher.init`/`TeamCreateLease.init`. Cuidado de recursão: os dois
logs internos da própria `sendMessage` (descarte sem conexão / falha ao
enviar) usam `print` puro, não `Logger.log` — senão uma falha de envio
dispararia log-sobre-a-falha via WS, que tentaria enviar de novo, sem saída
natural do ciclo. Validado só por `rojo build` + `lune run` nos 8 arquivos
tocados (7 existentes + `Logger.luau` novo) — sem erro de sintaxe, erro
esperado só na primeira linha que toca `game`/`plugin` (`Logger.luau` não
toca `game` nenhuma vez, então rodou sem nenhum erro). Nada testado em
Studio real nesta tarefa (é infraestrutura de teste, não feature validável
sem o lado da extensão também pronto). Detalhe completo em
`.claude/agent-memory/luau-dev.md`.

## Nota de sessão (2026-07-07, fim de tarde) — reteste real confirma o fix do split-brain

Depois do fix de reconciliação determinística (seção abaixo), plugin
reconstruído e reimplantado; Studio1 (`9203551752`) usou o novo botão
"SyncTeam: Alternar porta" para migrar de 34980 para 34981 (harness B). No
Output:

- Studio1: `reconciliada(s) 1 duplicata(s) de Folder 'Sessions' sob
  TestService.SyncTeam` — o merge determinístico disparou de verdade contra
  o engine real, não é só teoria de código. Logo depois: `sou o líder agora
  (term 6)`.
- Studio2 (`1402101248`, harness A): `líder atual:
  300e4572-34c8-47cc-8e1d-69241439ff99 (term 6)` — **mesmo clientId, mesmo
  term** anunciado pelo Studio1. Convergência real confirmada, zero
  divergência de termo desta vez (contraste direto com o split-brain
  original: 6 vs 1).

**Confirmado via log dos harnesses** (não só client-side, que é otimista —
loga "conectado" antes de confirmar o handshake): harness B aceitou a
conexão do Studio1 como único cliente; quando o Studio2 tentou entrar na
mesma porta B logo depois (ao clicar "Alternar porta" também), foi
genuinamente rejeitado pela regra de 1 cliente por servidor do M1
(`segundo plugin tentou conectar... fechando a nova conexão` no log do
harness) — essa rejeição só aparece no harness, não no Output do plugin.

**Estado dos harnesses ao final desta nota**: harness A (34980) sem ninguém
conectado; harness B (34981) com Studio1. Studio2 precisa clicar "Alternar
porta" mais uma vez para voltar a 34980 antes de continuar o roteiro
combinado do M3 (que precisa dos dois em servidores separados, simulando 2
devs — não compartilhando 1 harness só).

**M3.1 dado como fechado no critério de convergência** (`docs/MILESTONES.md`
atualizado). **Ainda pendente**: failover forçado (fechar o Studio líder e
confirmar que o outro promove sozinho nos tempos esperados) — não exercitado
nesta rodada. Depois disso, seguir para o roteiro de M3.2 (rejeição/
liberação de lease) com os dois harnesses já no ar.

## Nota de sessão (2026-07-07, tarde) — split-brain de liderança: causa raiz + fix (código), reteste real PENDENTE

Investigação de causa raiz do split-brain relatado na nota de sessão anterior
(abaixo), feita só por leitura de código/logs (sem Studio real disponível
nesta tarefa). Detalhe completo em [DECISIONS.md](DECISIONS.md) (entrada
"2026-07-07 — M3.1: split-brain de liderança — causa raiz confirmada..."),
resumo aqui:

- **Mecanismo confirmado por leitura de código** (não só teorizado): o
  padrão "singleton preguiçoso" (`FindFirstChild` → se nil, `Instance.new`)
  usado tanto em `TeamCreateSchema.luau` (container raiz + valores de
  coordenação) quanto no `getOrCreate` privado de `TeamCreateElection.luau`
  permite que dois Studios criem Instances DUPLICADAS (Roblox não faz merge
  de irmãos com mesmo Name) se chamado quase-simultaneamente antes da
  réplica assentar — agravado por `tick()` rodar SINCRONAMENTE dentro de
  `start()` sem nenhuma espera de assentamento, e por `rootValues`/
  `sessionsFolder` serem cacheados 1x em `start()` e nunca reavaliados
  depois (mesmo se a réplica do outro lado chegasse depois, o Studio
  continuava preso na sua cópia local).
- **Fix aplicado**: `plugin/src/TeamCreateSchema.luau` — `getOrCreate` agora
  reconcilia duplicatas sempre que é chamado (não só na criação), com
  desempate determinístico/replicado (atributo `SyncTeamOrigin`, GUID
  gravado na criação; canônica = menor) e merge que nunca perde estado
  (Folder: reparenta filhos antes de destruir a casca; IntValue: mantém o
  MAIOR valor entre duplicatas — contadores deste projeto são
  estritamente crescentes). `plugin/src/TeamCreateElection.luau` —
  `tick()` agora chama `TeamCreateSchema.ensureRoot()`/
  `ensureFolder("Sessions")` DE NOVO a cada pulso (2s), reatribuindo
  `rootValues`/`sessionsFolder`, em vez de confiar na referência capturada
  1x em `start()`. Constantes de tempo validadas (pulso/stale/cleanup/
  observações) não foram alteradas.
- **Adição pequena de escopo (pedido do orquestrador durante a tarefa)**:
  botão de toolbar temporário "SyncTeam: Alternar porta (34980/34981)" em
  `plugin/src/init.server.luau` — `plugin:SetSetting` não é chamável pelo
  Command Bar do Studio (`plugin` global só existe dentro do script do
  próprio plugin), então não havia UI para apontar 2 Studios na mesma
  máquina/pasta de Plugins para portas diferentes. Ferramenta de teste, não
  feature de produto.
- **Validado só por `rojo build` + `lune run`** nos arquivos tocados e nos
  dependentes (`TeamCreateLease.luau`/`ScriptRegistry.luau`/
  `SourceWatcher.luau`, que consomem `TeamCreateSchema.ensureRoot/
  ensureFolder` com a mesma assinatura) — sem erro de sintaxe, erro
  esperado só na primeira linha que toca `game`.

**PENDENTE — precisa de teste real, não pode ser automatizado**: repetir o
CENÁRIO EXATO que expôs o bug (os mesmos 2 Studios, userId `9203551752` e
`1402101248`, mesma place com Team Create, plugin reconstruído/reinstalado
nos dois — reload/auto-refresh simultâneo do arquivo do plugin, igual da
primeira vez) e confirmar no Output dos dois:

1. Nenhum dos dois Studios se declara líder com um term MAIOR que 1 sem o
   outro convergir para o MESMO `LeaderClientId`/`LeaderTerm` em poucos
   ciclos de pulso (~4-6s) — critério de aceite do M3.1 ("mesmo líder nos
   dois lados").
2. Se aparecer o log `reconciliada(s) N duplicata(s) de ... sob ...` (novo,
   `TeamCreateSchema.luau`) em qualquer um dos dois lados, isso confirma que
   a corrida realmente aconteceu de novo E que a reconciliação rodou —
   nesse caso, confirmar que AMBOS os Studios convergem para o mesmo líder
   logo em seguida (não só que o log de reconciliação apareceu).
3. Repetir o roteiro combinado do M3 (M3.1 failover forçado + M3.2 leases +
   M3.3 UX), já escrito abaixo em "Roteiro combinado M3" — continua válido,
   sem mudança.

Sem esse reteste, o fix fica `[Hipótese]` — coerente com a leitura de código
e com o design pedido (convergência determinística mesmo com duplicatas),
mas nunca exercitado contra o engine/replicação real do Team Create.

## Nota de sessão (2026-07-07) — primeiro teste real do M3 em 2 Studios, split-brain de líder encontrado

Plugin buildado (`rojo build`) e implantado em
`%LOCALAPPDATA%\Roblox\Plugins\SyncTeam.rbxm` pela primeira vez com o código
de M3.1/M3.2/M3.3. Auto-refresh do Studio recarregou o plugin nos dois
Studios reais (userId `9203551752` e `1402101248`) quase simultaneamente.

**Resultado**: eleição de líder teve **split-brain confirmado** — os dois
Studios se declararam líder ao mesmo tempo, com termos diferentes (6 vs 1).
Detalhe completo, causa provável e próximos passos em
[DECISIONS.md](DECISIONS.md) (entrada 2026-07-07). Não sabemos ainda se
autocorrige depois de mais ciclos de pulso — logs capturados terminam pouco
depois da divergência. **Próxima ação pedida ao usuário**: observar mais
alguns segundos e colar logs atualizados dos dois Studios para confirmar se
convergiu ou se o split-brain persiste (nesse caso é bug bloqueante do M3.1,
candidato a fix antes de continuar o roteiro do M3.2/M3.3).

**Achado separado, ambiental**: nenhum servidor WS estava escutando a porta
34980 durante o teste (nem extensão VS Code nem
`vscode-extension/tools/run-node-harness.ts`) — confirmado via `netstat`
(conexões presas em `SYN_SENT`). Os dois plugins ficaram em loop de
reconexão (`erro WS 400 HttpError: ConnectFail` a cada ~3s) o teste todo.
Isso não invalida o teste de eleição (que roda inteiramente dentro de
`TestService.SyncTeam`, sem depender da extensão), mas significa que
**nada do fluxo de leases (M3.2) foi exercitado ainda** — precisa da
extensão ou do harness rodando antes do próximo passo do roteiro combinado.

## Nota de sessão (2026-07-04, madrugada — trabalho autônomo)

Usuário foi dormir e pediu para eu continuar sozinho até de manhã, incluindo
a sugestão de usar subagents Haiku para tarefas mais mecânicas (salvo em
memória — ver `[[delegate-simple-tasks-to-haiku]]`). Resultado da noite:
**M3.1, M3.2 e M3.3 inteiros implementados** (sessions/eleição, leases
autoritativas, UX de lease no VS Code) — todos com build/lint/testes locais
limpos, **nenhum testado com Studio real ainda**. Uma tentativa de delegação
falhou por limite de sessão da API no meio da noite; retomada automática
funcionou sem intervenção. Ver "Roteiro combinado M3" abaixo — é o que falta
para fechar o M3 de vez.

## Extensão testada dentro de um VS Code real (2026-07-04)

Pendência aberta desde o M1 ("testar a extensão de dentro de um VS Code
Extension Development Host de verdade") **fechada**: `code
--extensionDevelopmentPath="vscode-extension" spikes/m1-test-project`
abre uma janela real do VS Code com a extensão ativa (sem precisar de F5
manual). Confirmado: `SyncServer` bindou a porta 34980 de verdade, o
plugin Studio (já rodando, reconectando automaticamente) conectou nela, e
a sincronização inicial escreveu arquivos via `VscodeDiskIO`/
`vscode.workspace.fs` (caminho de código nunca antes exercitado — só
tínhamos testado `NodeDiskIO` via harness). Útil a partir de agora: os
avisos de lease do M3.3 (`showWarningMessage`) finalmente aparecem de
verdade numa janela visível, não só em teste unitário com fake.

**Cuidado prático**: só pode ter 1 processo escutando a porta 34980 por
vez — antes de abrir essa janela, pare o harness Node
(`run-node-harness.ts`) se estiver rodando, senão a extensão real falha ao
iniciar o servidor (porta ocupada).

## Roteiro combinado M3 (2 Studios reais) — o que falta pra fechar o M3

Um roteiro só, cobrindo M3.1+M3.2+M3.3 numa sessão (evita reinstalar/reabrir
Studio três vezes separadas). Pré-requisito: plugin reconstruído e
reinstalado nas duas contas (`rojo build` em `plugin/`, mesmo processo de
sempre — apagar e recriar o `.rbxm` na pasta de Plugins, ou reiniciar o
Studio, para garantir reload; ver docs/DECISIONS.md 2026-07-04 sobre o
vazamento de `WebStreamClient` já corrigido, mas o cuidado de reload
continua valendo).

1. **Eleição (M3.1)**: abra a mesma place nas duas contas com Team Create.
   No Output de cada uma, procure `[SyncTeam] sessão criada clientId=...` e,
   depois de ~4s (2 ciclos de pulso), `sou o líder agora (term N)` numa
   das duas e `líder atual: <clientId> (term N)` na outra — mesmo líder
   nos dois lados. Force o failover: feche a janela líder, confirme que a
   outra promove sozinha (procure o log de promoção; deve levar uns
   4-6s pelos tempos validados no RojoCoop).
2. **Leases (M3.2)**: nas duas contas, abra/edite o MESMO script
   repetidamente (ex.: um loop simples ou várias edições manuais
   seguidas) — dev A editando continuamente, dev B tentando editar o
   mesmo script. B deve ver a escrita recusada (verifique tanto o
   `writeAck ok=false` no harness/log da extensão de B, quanto — item 3 —
   o aviso visível no VS Code de B). Pare as edições de A, espere ~10s
   (folga sobre os 8s de stale), tente de novo em B — deve conseguir
   agora.
3. **UX (M3.3)**: durante o passo 2, confirme que o VS Code de B mostra
   `vscode.window.showWarningMessage` com o texto de erro do plugin
   (não falha silenciosa) quando a escrita é recusada, e que aparece uma
   mensagem no Output/status bar quando a lease de um script muda de
   dono. Lembre-se: **não há bloqueio real de edição de arquivo** (decisão
   documentada) — B ainda pode digitar no VS Code, só a escrita pro
   Studio é que é recusada; o aviso é o único sinal.
4. **Não-regressão**: enquanto isso, edite um script DIFERENTE em cada
   conta ao mesmo tempo — as duas escritas devem funcionar sem
   interferência (leases são por uuid, independentes).

Qualquer resultado divergente do esperado: colar aqui os logs relevantes
(Output do Studio dos dois lados) para eu investigar, mesmo padrão que já
usamos no M0/M2.

## Objetivo atual

M0/M0.5/**M1 encerrados**. **M2 substancialmente fechado** após uma sessão
longa de teste real com 2 Studios: create/rename/move/delete todos
verificados end-to-end (disco ↔ Studio real). Achado principal: dois bugs
reais de API encontrados e corrigidos (ver docs/DECISIONS.md 2026-07-04) —
`ObjectValue.Value` não detecta destruição, e o "Delete" do Explorer do
Studio parece ser um soft-delete (não chama `Destroy()` de verdade
imediatamente), então a checagem certa é só `Parent == nil`. Também corrigido
um vazamento de `WebStreamClient` que mascarava os testes.

**M3.1 e M3.2 fechados em 2026-07-15** com 2 Studios reais: convergência de
líder, failover forçado, rejeição/liberação de lease e não-regressão
(scripts diferentes simultâneos) todos confirmados — ver nota de sessão
2026-07-15 acima e `docs/MILESTONES.md`. **Único item de M3 ainda em
aberto**: aviso visível (`showWarningMessage`) numa janela real de VS Code
(M3.3) — a camada de dados já está confirmada pelos mesmos logs de hoje, só
falta o "olhar pra tela" com um VS Code Extension Development Host de
verdade. Ver docs/MILESTONES.md.

## M1 — fechado (2026-07-04)

`plugin/` e `vscode-extension/` criados em paralelo por `luau-dev` e
`extension-dev` (mesmo protocolo, mesma porta `34980`, sem precisar de
mediação manual) e testados juntos contra um Studio real:

- Harness `vscode-extension/tools/run-node-harness.ts` instancia o motor
  real da extensão (`SyncServer`/`SyncTeamService`/`SyncBridge`, os mesmos
  módulos de `extension.ts`) com `NodeDiskIO`, sem precisar abrir um VS Code
  Extension Development Host.
- Pull inicial: 46 scripts padrão do Roblox + 1 script de outro spike,
  todos fora dos pontos de montagem, corretamente ignorados.
- Disco→Studio: editar/criar `Main.server.luau`/`Main.client.luau` em
  `spikes/m1-test-project/` criou os scripts certos no Studio
  (`ServerScriptService/Server/Main`, `StarterPlayer/StarterPlayerScripts/Client/Main`)
  com `className` correto.
- Studio→disco: reconexão recriou os arquivos com conteúdo byte-a-byte
  idêntico ao enviado.
- `rojo build` no projeto de teste continuou funcionando depois do
  round-trip.
- Segunda conexão de plugin simultânea corretamente rejeitada (M1 é 1 dev).
- **Lacuna conhecida, não bloqueante**: mount cujo próprio ponto de
  montagem é um Script (`init.*.luau` direto na raiz, sem subpasta) é
  ignorado nos dois sentidos — contornado no teste, não corrigido. Ver
  docs/MILESTONES.md, seção M1.
- Pendente (não bloqueia M2): testar a extensão de dentro de um VS Code
  Extension Development Host de verdade (só o harness Node foi validado).

## Estado

- `[Verificado]` Repositório criado com documentação inicial (arquitetura,
  marcos, decisões) e git inicializado. Ainda sem commit.
- `[Verificado]` Base de referência analisada em
  `c:/Users/hakor/Documents/GitHub/RojoCoop`: esquema Team Create, eleição de
  líder, leases e extensão VS Code validados lá em dois Studios reais.
- `[Verificado]` Spike M0 escrito em `spikes/m0-source-replication/`
  (plugin local com papéis Escritor/Observador).
- `[Verificado 2026-07-03]` **HIPÓTESE CENTRAL CONFIRMADA — teste real com dois
  Studios/duas contas** (`logs-livetest/escritor.txt`, `logs-livetest/observador.txt`):
  script criado e com `Source` escrito por um Studio (userId `216675619`)
  replicou via Team Create para outro Studio, incluindo o conteúdo inicial
  (Observador já viu `counter=1` ao iniciar, antes de clicar em qualquer
  botão). Toda mudança subsequente chegou via `GetPropertyChangedSignal("Source")`
  — nenhuma precisou do fallback de polling nesse teste.
- `[Verificado 2026-07-03]` **Nuance importante sobre o achado do M0.5**: o
  sinal de mudança de `Source` não confiável (`.claude/research/2026-07-03-source-changed-signal-reliability.md`)
  parece ser específico de quem ESCREVE localmente e tenta observar a própria
  escrita via `UpdateSourceAsync`. Para quem RECEBE uma mudança replicada via
  Team Create de outro Studio, o sinal disparou de forma consistente nesse
  teste — `[Hipótese]` (uma amostra só; repetir para confirmar).
- `[Verificado 2026-07-03]` **Bug de loops concorrentes corrigido**
  (`SyncTeamM0.lua`): trocado o controle de "qual loop é o atual" de uma flag
  global (`running`) para um token de geração (`currentToken`), incrementado
  em `stopAll()` e checado em todo `while` de longa duração (writer,
  observer, incluindo o loop de espera inicial "aguardando alvo até 60s").
  Clique duplo no mesmo botão agora invalida o loop antigo de fato.
- `[Verificado 2026-07-03]` **Segundo teste real com dois Studios/duas
  contas, pós-fix**: sequência de `counter` limpa (1→7, sem saltos/duplicação),
  toda mudança chegou via sinal (nenhum fallback de polling necessário),
  latência escrita→chegada da ordem de **milissegundos** (baixa dezena de ms;
  alguns deltas levemente negativos, atribuídos a ruído de relógio entre os
  dois painéis de Output, não a violação real de causalidade). Confirma e
  refina o resultado do primeiro teste com dados limpos. Logs em
  `logs-livetest/studio1.txt` (Escritor, userId `1402101248`) e
  `logs-livetest/studio2.txt` (Observador).
- `[Verificado 2026-07-03]` Rodar `SyncTeamM0.lua` e `SyncTeamLab.lua` (M0.5)
  instalados juntos gera ruído no Output: o Lab tem auto-start incondicional
  e fica tentando reconectar às portas locais 34901/34902 (erro
  `HttpError: ConnectFail` a cada ~3s) sem harness Node rodando para
  aceitá-las — inofensivo (sistemas independentes, não afeta o teste do M0),
  mas prejudica a leitura do log. `SyncTeamLab.lua` removido da pasta de
  Plugins para os testes de M0 subsequentes; reinstalar se precisar
  retomar o M0.5.
- `[Verificado 2026-07-03]` **Terceiro teste, papéis invertidos**: mesma conta
  que antes observava (`userId 1402101248`) agora escreveu, e vice-versa.
  counter=8→13, mesmo padrão limpo (sinal sempre, antes dos metadados,
  sem saltos). Replicação de Source via Team Create é simétrica e
  reprodutível nas duas direções.

## M0 — encerrado (GO)

Três rodadas reais com duas contas/Studios confirmam a hipótese central sem
excepção: script criado e `Source` escrito por um Studio replica para o
outro via Team Create, com o sinal de mudança disparando de forma confiável
do lado de quem recebe, em latência de milissegundos. Itens que ficaram sem
teste dedicado (estado real de Drafts Mode — `DraftsService` inacessível por
script nas contas de teste; script aberto no editor remoto durante a
replicação) são refinamento de robustez, não bloqueiam avançar — retomar se
algum desses cenários aparecer como suspeito num bug real do M1+.
- `[Decisão pendente]` Ainda não testado: Drafts Mode ligado, e script aberto
  no editor do lado do Observador enquanto a replicação chega (os dois
  cenários da matriz do README que geram mais risco). Este teste cobriu só
  "Drafts indeterminado (DraftsService não pôde ser lido por falta de
  capability) + script fechado".

- `[Verificado]` Estrutura `.claude/` criada a pedido do usuário: agentes
  (researcher, luau-dev, extension-dev, ui-dev), regras (workflow, luau,
  typescript), memória por agente e pasta de pesquisa. Regra de delegação
  registrada no CLAUDE.md.
- `[Verificado]` Spike M0.5 executado pela primeira vez em 2026-07-03: ping/pong
  passou nos dois canais; escrita cruzada A→B e B→A deu timeout (15s) esperando
  o evento `sourceChanged` — mas leitura direta confirmou que o `.Source` tinha
  sido escrito corretamente nos dois lados. Causa: `GetPropertyChangedSignal("Source")`
  não dispara de forma confiável após `ScriptEditorService:UpdateSourceAsync`
  num script recém-criado (achado de pesquisa: nem Drafts, nem Signal Behavior
  Deferred explicam por si só; é uma instabilidade conhecida da API, ver
  `.claude/research/2026-07-03-source-changed-signal-reliability.md`). O Rojo
  upstream nunca usa `UpdateSourceAsync`: escreve `Source` por atribuição direta
  e observa por `instance.Changed` genérico.
- `[Verificado]` Fix aplicado em `SyncTeamLab.lua`: detecção por polling
  (0.5s) como caminho garantido, sinal mantido só como fast-path; plugin agora
  auto-inicia ao carregar (sem depender de clique), permitindo reinstalação e
  reteste diretos pela IA.
- `[Verificado 2026-07-03]` **M0.5 fechado, 6/6 cenários, duas rodadas**:
  ping/pong, escrita cruzada A→B (167ms) e B→A (165-169ms) via
  `UpdateSourceAsync`, escrita concorrente documentada (last-write-wins sem
  coordenação), listScripts. Reconexão testada derrubando e subindo o
  harness: plugin reconectou em <1s e os 6 cenários rodaram de novo, 0
  falhas. Único item do M0.5 não fechado: edição manual por humano no editor
  do Studio (mesmo caminho de detecção já testado via polling, mas não
  exercitado por dedo humano).
- `[Decisão pendente]` Para o M0 real (Team Create entre máquinas): não confiar
  no `Changed`/`GetPropertyChangedSignal` do próprio script como notificação;
  usar um contador/hash em `TestService.SyncTeam` (canal já validado como
  confiável no RojoCoop) como aviso de "algo mudou, vá ler o Source" — o spike
  M0 (`SyncTeamM0.lua`) já segue esse padrão (Counter IntValue + polling
  independente do Source).
- `[Verificado 2026-07-03]` Mapeamento de nomenclatura Rojo implementado como
  módulo puro: `spikes/m0_5-local-pipeline/harness/rojo-path-mapping.mjs`
  (`computeLayout`/`parseDiskPath`), 14/14 testes `node:test` passando
  (`rojo-path-mapping.test.mjs`, inclui round-trip e colisão de `diskPath`).
  `bridge-server.mjs` foi religado para usar esse mapeador em vez do esquema
  ingênuo anterior (`<Nome>.lua` plano + className adivinhada por regex):
  agora grava `Nome.luau`/`Nome.server.luau`/`Nome.client.luau` ou
  `Nome/init.*.luau` de verdade, com promoção arquivo→pasta quando um script
  ganha o primeiro filho.
- `[Verificado 2026-07-03]` **Convenção Rojo validada ao vivo** (não só nos
  testes unitários): criação de `ModuleScript` plano (`Utils.luau`), depois
  adição de um filho (`Utils/Helper`) disparou promoção real
  `Utils.luau` → `Utils/init.luau` nas duas pastas (`workspace-a`,
  `workspace-b`), conteúdo íntegro nos dois arquivos, convergência confirmada
  nos dois lados. Também validada criação de script novo do zero (`Greeting`,
  `Script` → `Greeting.server.luau`) e filtro de nomenclatura ignorando
  arquivos temporários do editor sem enviar `writeSource` malformado.
- `[Verificado 2026-07-03]` **Bug de robustez encontrado**: depois de um
  período ocioso (~36min), o canal B do plugin ficou preso desconectado
  enquanto o canal A reconectou normalmente — sem nenhum log de erro no
  Output do Studio, sugerindo o loop de reconexão trava silenciosamente em
  vez de tentar de novo. O botão "Lab: Conectar" não resolve nesse caso
  (guard `if enabled then return end` impede nova tentativa); precisou de
  "Lab: Parar" + "Lab: Conectar" para resetar. `[Decisão pendente]`
  investigar causa raiz e corrigir antes do M1 (possível causa: `Closed`/
  `Error` não disparam para todo tipo de falha de `WebStreamClient`, deixando
  o loop preso em `task.wait` indefinidamente).

## M1 — plugin de produção (`plugin/`), 2026-07-04

- `[Verificado]` Criado `plugin/` como projeto Rojo-buildável:
  `plugin/default.project.json` (raiz `$path: src`, mesmo formato do template
  de plugin do RojoCoop), `plugin/src/init.server.luau` (entry: toolbar
  "SyncTeam" Conectar/Parar, auto-start, conexão WS única com reconexão e
  token de geração, dispatch de mensagens), `plugin/src/Config.luau`
  (constantes: porta padrão `34980`, timings, `protocolVersion = 1`,
  `pluginVersion`, lista dos 6 containers observados) e
  `plugin/src/SourceWatcher.luau` (observação genérica por
  polling+sinal — porte de `SyncTeamLab.lua`/`SyncTeamM0.lua` — resolução de
  caminho a partir de `game`, escrita via `UpdateSourceAsync`/fallback
  `.Source`, listagem).
- `[Verificado]` `rojo build` do projeto roda sem erro (binário cacheado do
  rokit chamado direto, ver `.claude/agent-memory/luau-dev.md` para o
  comando) e os três arquivos `.luau` passam por `lune run` sem erro de
  sintaxe (só o esperado `attempt to index nil with 'GetService'` na
  primeira linha que usa `game`, porque o Lune não emula Roblox). Não
  testado em Studio real — toolbar, auto-start, `GetSetting/SetSetting` e
  round-trip com uma extensão ficam `[Hipótese]` até esse teste.
- **Decisão de design não 100% especificada na tarefa, registrada aqui e em
  `.claude/agent-memory/luau-dev.md`**: o protocolo desta fatia do M1
  endereça scripts por **caminho completo no DataModel relativo a `game`**
  (ex.: `ServerScriptService/Foo/Bar`), não por UUID+ObjectValue. Isso não
  contraria a decisão de identidade de 2026-07-02 — aquele registry
  (`Scripts/<UUID>`) é explicitamente escopo do **M2** (create/rename/move/
  delete), que ainda não existe; a fatia 1 do M1 só cobre
  create-se-não-existir/read/write/list, sem rename/move. Precisa ser
  revisitado quando o M2 chegar.
- Handshake versionado: `hello` do plugin agora leva `protocolVersion` (1) —
  primeira mensagem versionada do protocolo, conforme pedido na tarefa.
- **Outra decisão não 100% especificada**: `writeSource` atualiza o cache de
  dedupe (`lastSourceByInstance`) para o valor recém-escrito antes de
  devolver o `writeAck`. Efeito: a própria escrita pedida pela extensão
  nunca gera um `sourceChanged` de eco de volta (o `writeAck` já basta);
  só edições feitas de fato no editor do Studio (fora do fluxo WS) chegam
  como `sourceChanged origin="studio"`. Os spikes faziam diferente
  (broadcast sempre, com `origin` só informativo) porque queriam medir o
  round-trip; no plugin de produto, com 1 única extensão conectada, ecoar a
  própria escrita de volta pareceu redundante/potencialmente confuso.
  Revisitar se a extensão precisar do eco por algum motivo (ex.: confirmar
  que Team Create replicou de volta — mas isso é cenário multi-Studio, M3+).
- Próximo bloqueador real do M1: integrar com a extensão VS Code
  (`vscode-extension/`, trabalho paralelo do `extension-dev`) e rodar o
  round-trip completo contra `spikes/m1-test-project/`.

- `[Verificado 2026-07-04]` **`vscode-extension/` criada (fatia 2 do M1,
  `extension-dev`)**: TypeScript estrito, esbuild, vitest. Estrutura:
  - `src/protocol.ts` — tipos das mensagens e `PROTOCOL_VERSION = 1`,
    `parseIncomingMessage` (só garante `kind` string não vazia; resto é
    validado por quem consome cada `kind`).
  - `src/mapping/rojoPathMapping.ts` — porte 1:1 de
    `spikes/m0_5-local-pipeline/harness/rojo-path-mapping.mjs`
    (`computeLayout`/`parseDiskPath`) para TypeScript.
  - `src/mapping/projectMapping.ts` — parser de `default.project.json`
    (`parseMountPoints`, percorre `tree` recursivamente, qualquer nó com
    `$path` string é um ponto de montagem) + composição com
    `rojoPathMapping` nos dois sentidos: `computeFullLayout`
    (DataModel→disco, agrupa entries por mount e chama `computeLayout` só
    com o path relativo ao mount) e `resolveDataModelPathForDiskChange`
    (disco→DataModel, acha o mount pelo prefixo do diskPath — comparação
    **case-insensitive** — e usa `parseDiskPath` no restante). Paths fora de
    qualquer mount vão para `ignoredPaths`/retornam `null` (log informativo,
    nunca erro).
  - `src/sync/DiskIO.ts` (+ `NodeDiskIO.ts`, `VscodeDiskIO.ts`) — interface
    de disco com duas implementações: `NodeDiskIO` (node:fs/promises, usada
    em testes e em qualquer harness Node) e `VscodeDiskIO`
    (`vscode.workspace.fs`, só usada por `extension.ts`) — separação pedida
    na tarefa para a camada de lógica ser testável sem VS Code de pé.
  - `src/sync/SyncBridge.ts` — porte da lógica de
    `bridge-server.mjs` (dedupe por `contentCache` sempre atualizado ANTES
    de tocar disco/rede, promoção arquivo→pasta via `recomputeAndApplyLayout`
    quando `knownClasses` muda de um jeito que afeta `hasChildren`) adaptada
    para múltiplos pontos de montagem (via `projectMapping.ts`) e 1 canal só
    (sem os dois workspaces A/B do spike). Trata `scriptRemoved` (fora do
    escopo formal do M1, mas já é mensagem do protocolo): remove das caches e
    apaga o arquivo, sem tentar detectar rename — isso é M2 com UUID.
  - `src/sync/SyncServer.ts` — servidor `ws` bind exclusivo em `127.0.0.1`,
    valida `protocolVersion` do `hello` (rejeita com log claro e
    `socket.close(1002, ...)` em mismatch, sem derrubar o servidor), request/
    response por `requestId`, rejeita um segundo cliente tentando conectar
    (M1 é 1 plugin só).
  - `src/sync/SyncTeamService.ts` — junta `SyncServer`+`SyncBridge`.
  - `src/extension.ts` — ativação real: acha `default.project.json` via
    `vscode.workspace.findFiles`, lê e faz parse dos mounts, cria
    `VscodeDiskIO` enraizado na pasta do project.json, lê a porta de
    `syncteam.port` (config, default `34980` — **confirmado igual ao que o
    `luau-dev` já tinha em `plugin/src/Config.luau`**, sem precisar
    renegociar), sobe o `SyncTeamService`, e liga um
    `vscode.workspace.createFileSystemWatcher` com debounce de 150ms
    chamando `service.notifyLocalFileChange`.
  - Testes (`vitest run`): **42/42 passando** — 14 em
    `test/rojoPathMapping.test.ts` (mesmos casos do spike, portados),
    20 em `test/projectMapping.test.ts` (parser + composição nos dois
    sentidos, incluindo round-trip completo com o fixture do
    `spikes/m1-test-project/default.project.json`), 8 em
    `test/syncBridge.test.ts` (sincronização inicial, dedupe por cache,
    promoção arquivo→pasta, disco→Studio, `scriptRemoved`) usando
    `NodeDiskIO` num diretório temporário real + um `Transport` fake — sem
    VS Code nem WebSocket de verdade.
  - `npx tsc --noEmit`: **sem erros**. `npm run build` (esbuild): **sem
    erros**, gera `dist/extension.js`.
  - **Ainda não testado**: round-trip real contra o `plugin/` de verdade
    dentro do Studio (só a lógica foi validada com fakes/tmpdir) — próximo
    passo natural agora que os dois lados (`plugin/` e `vscode-extension/`)
    existem. Também não implementado: UX de diff "Connect/Override" antes de
    sobrescrever o disco na sincronização inicial (mencionada em
    ARCHITECTURE.md, não exigida pelos critérios de aceite do M1 conforme
    escritos em MILESTONES.md) — sinalizar ao `ui-dev`/orquestrador se for
    entrar no escopo do M1.

## M2 — lado do plugin (`plugin/`), 2026-07-04

- `[Verificado via rojo build + lune run; NÃO verificado em Studio real]`
  Identidade por UUID+ObjectValue implementada:
  - Novo módulo `plugin/src/ScriptRegistry.luau`: cria/mantém
    `TestService.SyncTeam.Scripts.<uuid>` (`InstanceRef: ObjectValue`,
    `CanonicalPath: StringValue`); `reconcile(isWatched)` reaproveita uuids
    de entradas existentes cuja `InstanceRef.Value` ainda é uma Instance
    observada, e já limpa (`folder:Destroy()`) entradas cuja Instance foi
    destruída ou saiu da área observada; `resolveOrAllocate` aloca uuid novo
    via `HttpService:GenerateGUID(false)` só quando necessário;
    `getInstance`/`getUuid`/`updateCanonicalPath`/`remove`/`forEach`
    (`forEach` tira um snapshot antes de chamar o callback — mutar o mapa
    durante a própria iteração não é seguro).
  - `plugin/src/SourceWatcher.luau`: `watchScript` agora resolve/aloca uuid
    de forma síncrona (mesma ordem/pegadinha de sempre capturar a baseline
    de Source antes de qualquer escrita); `checkSourceChanged` inclui `uuid`
    na mensagem; nova função `checkRegistryDrift()` chamada 1x por ciclo de
    `pollLoop` (mesmo ciclo do polling de Source) que detecta `scriptMoved`
    (compara caminho atual vs `CanonicalPath` guardado) e `scriptRemoved`
    (via `InstanceRef.Value == nil`) — ver decisão de design registrada em
    `docs/MILESTONES.md` (M2) sobre por que isso saiu de `DescendantRemoving`.
    `SourceWatcher.start()` chama `ScriptRegistry.reconcile()` antes de
    qualquer scan. Novas funções públicas: `resolveByUuid`, `getUuid`.
  - `plugin/src/init.server.luau`: `handleWriteSource` com dois modos
    (`uuid` presente = atualização; ausente = criação com `path`+`className`,
    aloca uuid novo); `handleReadSource` resolve por `uuid`; `writeAck`
    sempre inclui `uuid` quando `ok=true`.
  - `plugin/src/Config.luau`: `PROTOCOL_VERSION` 1→2 (breaking change
    deliberado, documentado em MILESTONES.md); `PLUGIN_VERSION` bump para
    `0.2.0` (decisão não pedida explicitamente, mas consistente com a mudança
    de protocolo).
- **Validado apenas por build/parse, não por execução real**: `rojo build`
  (binário cacheado, `~/.rokit/tool-storage/rojo-rbx/rojo/7.7.0/rojo.exe build`)
  sem erros; `lune run` nos 4 arquivos `.luau` sem erro de sintaxe (erro
  esperado só na primeira linha que toca `game`, já que o Lune não emula
  Roblox — mesmo critério usado no M1).
- **Roteiro de teste manual (Studio real — pedir para o usuário executar,
  não pode ser automatizado)**:
  1. `rojo build plugin -o SyncTeam.rbxm` e instalar na pasta de Plugins (ou
     copiar `plugin/src/*.luau` direto, como nos spikes). Abrir um Studio
     (Team Create real, se possível — mas mesmo local já cobre boa parte).
  2. No Explorer, habilitar "Show FilteredInstances"/instâncias ocultas para
     ver `TestService`. Confirmar que `TestService.SyncTeam.Scripts` existe
     e tem uma entrada (`Folder`) por script sob os containers observados
     (`Config.getWatchedRoots()`), cada uma com `InstanceRef` apontando de
     volta pro script certo e `CanonicalPath` com o caminho certo.
  3. Criar um `ModuleScript` novo (Explorer, ex. em `ReplicatedStorage`):
     confirmar (dentro de ~0.5s) uma entrada nova em `Scripts` com uuid novo.
  4. Mover/renomear esse script (arrastar pra outra pasta observada, ou
     `F2`): confirmar que `CanonicalPath.Value` da MESMA entrada (mesmo
     nome de Folder/uuid) atualiza para o novo caminho, sem criar uma
     segunda entrada. Se a extensão VS Code/harness estiver conectada,
     confirmar que ela recebeu `scriptMoved {uuid, oldPath, newPath, className}`.
  5. Deletar esse script (Explorer → Delete): confirmar que a entrada
     `Scripts/<uuid>` correspondente é destruída em até ~0.5s, e (se
     conectado) que chegou `scriptRemoved {uuid, path}`.
  6. Recarregar o plugin (botão "SyncTeam: Parar" seguido de "SyncTeam:
     Conectar", ou reinstalar o arquivo): no Output, confirmar a linha
     `registry reconciliado: N reaproveitados, 0 removidos` com N igual ao
     número de scripts observados antes do reload — nenhuma entrada
     duplicada em `Scripts`.
  7. Com uma extensão/harness conectado: enviar `writeSource` SEM `uuid`
     (`{path, source, className, requestId}`) para um caminho novo;
     confirmar `writeAck {ok:true, uuid:"<algum-uuid>"}` e, um instante
     depois, um `scriptAdded {uuid, path, className}` espontâneo com o MESMO
     uuid (dois eventos para uma ação — esperado, não é bug).
  8. Enviar `writeSource` COM esse `uuid` e uma nova `source`; confirmar
     `writeAck {ok:true, uuid: <mesmo>}` e que o `Source` do script no
     Studio mudou de fato.
  9. Enviar `readSource {uuid, requestId}` para o mesmo `uuid`; confirmar
     `sourceContent {ok:true, source: <o texto do passo 8>}`.
  10. Deletar esse script pelo Explorer; confirmar `scriptRemoved` com o
      `uuid` certo chega em até ~0.5s.
  11. Enviar `listScripts`; confirmar que `scripts` inclui `{uuid, path,
      className}` para todos os scripts observados, sem duplicatas.
- **Fora de escopo desta fatia** (fica para depois, ver docs/MILESTONES.md):
  detectar rename/move feito do lado do disco (VS Code) — responsabilidade
  da extensão; convergência entre dois Studios reais após operações
  concorrentes disjuntas.

## M2 — lado da extensão (`vscode-extension/`), 2026-07-04

`[Verificado com fakes/tmpdir — vitest, tsc, esbuild; NÃO testado em Studio
real]` Identidade por UUID substituindo o mapeamento por `path` do M1:

- `src/protocol.ts`: `PROTOCOL_VERSION` 1→2 (breaking change deliberado).
  `ScriptListEntry`/`SourceChangedEvent`/`ScriptAddedEvent`/`ScriptRemovedEvent`
  ganharam `uuid`; `path` passou a ser documentado como informativo/exibição.
  `readSource` agora leva `uuid` em vez de `path`. `writeSource` modelado como
  união discriminada `WriteSourceUpdateRequest` (`{uuid, source}`) |
  `WriteSourceCreateRequest` (`{path, className, source}`), com helper
  `isWriteSourceUpdate`. `WriteAckResponse` ganhou `uuid?`. Nova
  `ScriptMovedEvent {uuid, oldPath, newPath, className}`. **Nota**: esses
  tipos continuam sendo só documentação/contrato — `SyncBridge`/`SyncServer`
  operam sobre `Record<string, unknown>`/`RawMessage` crus (mesmo padrão do
  M1, nenhum lugar do código de fato importa os tipos de mensagem
  individuais para validação em runtime).
- `src/sync/DiskIO.ts`: novo método `renameFile(oldRelPath, newRelPath): Promise<void>`
  na interface. `NodeDiskIO.renameFile` usa `fs.promises.rename` com
  `mkdir(dirname(destino), {recursive:true})` antes. `VscodeDiskIO.renameFile`
  usa `vscode.workspace.fs.rename(oldUri, newUri, {overwrite:false})`
  (criando o diretório destino antes, mesma tolerância de erro do
  `writeFile` já existente).
- `src/sync/SyncBridge.ts` — reescrito para chave primária `uuid`:
  - Caches: `scripts: Map<uuid, {path, className}>` (substitui
    `knownClasses`), `sourceCache: Map<uuid, source>`,
    `diskPathByUuid: Map<uuid, diskPath>` (substitui `layoutCache`),
    `uuidByDiskPath: Map<diskPathMinúsculo, uuid>` (mapa reverso NOVO,
    necessário para `handleLocalFileChange` decidir atualizar vs. criar sem
    iterar), `contentCache` inalterado (ainda chaveado por diskPath — é isso
    que está fisicamente no disco).
  - `recomputeAndApplyLayout` continua sendo o motor de layout, mas agora
    resolve `dataModelPath -> uuid` num mapa auxiliar construído a cada
    chamada (paths são únicos por natureza da árvore do DataModel) antes de
    comparar contra `diskPathByUuid`.
  - **Decisão não pedida explicitamente na tarefa**: `moveOnDisk` (usado
    tanto pela promoção/despromoção "automática" do `recomputeAndApplyLayout`
    quanto por `handleScriptMoved`) foi trocado de ler+escrever+apagar para
    usar `DiskIO.renameFile` como caminho primário, com fallback para
    ler(cache)+escrever se o rename falhar (arquivo antigo não existe de
    fato). Mais eficiente (sem round-trip de conteúdo pela memória) e
    unifica os dois casos de "mover" no mesmo código.
  - `handleScriptAdded` ganhou um parâmetro `transport` (não existia no M1)
    porque a tarefa pede que ele busque `readSource {uuid}` proativamente
    quando o conteúdo ainda não é conhecido, em vez de esperar passivamente
    por um `sourceChanged` — `SyncTeamService.routeSpontaneous` foi ajustado
    para passar `this.transport`.
  - `handleSourceChanged` **não** usa mais o `path` recebido para nada (nem
    para log de decisão) além de exibição — só resolve por `uuid`, conforme
    pedido explicitamente na tarefa. Se o `uuid` for desconhecido
    (`diskPathByUuid` sem entrada), o conteúdo fica em `sourceCache` esperando
    um layout futuro, igual ao M1.
  - `handleScriptMoved` (nova): recalcula o layout completo para o `newPath`,
    resolve o `diskPath`/`isInit` do próprio uuid pelo resultado, e move o
    arquivo físico via `moveOnDisk` (rename) em vez de recriar. Chama
    `recomputeAndApplyLayout` ao final para propagar efeitos colaterais em
    OUTROS uuids (ex.: pai que ganhou o primeiro filho por causa do move e
    precisa promover para pasta). Casos de borda tratados: uuid sem arquivo
    físico anterior conhecido (trata como materialização nova) e `newPath`
    fora de qualquer ponto de montagem (remove o arquivo físico antigo, já
    que deixou de ser rastreado).
  - `handleScriptRemoved`: mesma lógica do M1, mas por `uuid`.
  - `handleLocalFileChange`: decide "atualizar" vs. "criar" consultando
    `uuidByDiskPath` pelo `diskPath` que mudou. Modo criar: resolve
    `dataModelPath`/`className` via `resolveDataModelPathForDiskChange`
    (mesma função do M1), manda `writeSource {path, source, className}`, e
    **só se `writeAck.ok===true` e `writeAck.uuid` for string** registra
    `scripts`/`sourceCache`/`diskPathByUuid`/`uuidByDiskPath` para o uuid
    recém-alocado — chama `recomputeAndApplyLayout` depois para cobrir o
    mesmo efeito colateral de promoção mencionado acima.
- **Testes** (`test/syncBridge.test.ts`, reescrito para o protocolo v2):
  12 testes, todos com `FakeTransport` simulando os dois modos de
  `writeSource` (o modo criar aloca um uuid sequencial e o registra em
  `transport.scripts`/`transport.sources`, simulando o plugin de verdade).
  Cobre: `runInitialSync` com uuid; dedupe por conteúdo; `scriptAdded`
  materializa e chama `readSource`; promoção arquivo→pasta; `scriptMoved`
  rename simples (via `renameFile`, sem write/delete); `scriptMoved` que
  também muda `isInit` (script se torna filho de outro, que precisa
  promover para `init.*`) — testado como cenário único que exercita
  `recomputeAndApplyLayout` reagindo ao próprio `scriptMoved`; disco→Studio
  nos dois modos (`writeSource {uuid,...}` para arquivo conhecido,
  `writeSource {path,...}` para arquivo novo + registro do uuid do
  `writeAck`, confirmado por uma segunda edição no mesmo arquivo já sair no
  modo atualizar); dedupe de edição local repetida; arquivo fora de mount
  ignorado; `scriptRemoved` por uuid.
- **Resultado real das ferramentas** (2026-07-04): `npx vitest run` → **46/46
  passando** (14 `rojoPathMapping` + 20 `projectMapping`, inalterados + 12
  `syncBridge`, reescritos/ampliados de 8→12). `npx tsc --noEmit` → sem
  erros. `npm run build` (esbuild) → sem erros, gerou `dist/extension.js` e
  `dist/run-node-harness.js` (o harness também importa `SyncBridge`/
  `protocol.ts`, então precisa do rebuild).
- **Não testado nesta fatia** (precisa do lado do plugin já validado em
  Studio, ver roteiro na seção "M2 — lado do plugin" acima):
  `run-node-harness.ts` contra um Studio real com o `plugin/` M2 instalado —
  em particular, confirmar que um rename/move de verdade no Explorer do
  Studio chega como `scriptMoved` (não um par scriptRemoved+scriptAdded) e
  resulta num `fs.rename` real em disco, e que `rojo build` continua limpo
  depois.

## M2 — dois bugs reais corrigidos após teste com 2 Studios (2026-07-04)

Teste real com 2 Studios/2 contas expôs dois bugs no M2 (`plugin/src/ScriptRegistry.luau`,
`plugin/src/SourceWatcher.luau`), ambos registrados em [DECISIONS.md](DECISIONS.md)
(entradas 2026-07-04) e corrigidos nesta tarefa:

- `[Verificado por build/lune, teste real com 2 Studios pendente de repetição]`
  **Bug 1 — detecção de delete usava premissa falsa.** `checkRegistryDrift`
  checava `InstanceRef.Value == nil` para decidir "script deletado"; pesquisa
  (`.claude/research/2026-07-04-objectvalue-destroy-detection.md`) confirmou
  que `ObjectValue.Value` **não** zera quando a Instance referenciada é
  destruída (comportamento intencional da Roblox) — script apagado no
  Explorer nunca gerava `scriptRemoved`. Fix: nova função
  `ScriptRegistry.isInstanceDestroyed(instance)` (`Parent == nil` +
  confirmação por `pcall` de reatribuição do próprio `Parent`, que só falha
  em destruição real) substitui a checagem antiga em `checkRegistryDrift`,
  `ScriptRegistry.reconcile` e `ScriptRegistry.getInstance`.
- `[Verificado por build/lune, teste real com 2 Studios pendente de repetição]`
  **Bug 2 — UUID podia divergir entre Studios para o mesmo script
  replicado.** `resolveOrAllocate` só consultava o mapa em memória
  (`uuidByInstance`) antes de gerar um uuid novo, ignorando entradas já
  existentes no registry compartilhado (potencialmente replicadas de outro
  Studio via Team Create) apontando para a mesma Instance — reproduzido: dois
  Studios alocaram uuids diferentes (`9dbf46f6...`/`5b51cd63...`) para o
  mesmo script. Fix: nova função privada `findRegistryEntryFor(instance)`
  varre `scriptsFolder:GetChildren()` procurando uma entrada existente cujo
  `InstanceRef.Value` (usando `isInstanceDestroyed` para ignorar entradas
  mortas) seja a mesma Instance; `resolveOrAllocate` reaproveita esse uuid em
  vez de alocar um novo.
- Validado com `rojo build` (layout ok) e `lune run` nos dois arquivos (sem
  erro de sintaxe, erro esperado só na primeira linha que toca `game`/
  `plugin`). **Não testado em Studio real nesta tarefa** — repetir o roteiro
  de 2 Studios (criar script, apagar pelo Explorer, confirmar
  `scriptRemoved`; replicar o mesmo script para o outro Studio e confirmar
  uuid idêntico dos dois lados) fica pendente do usuário.

## M2 — fast-path opcional de delete via `DescendantRemoving` (2026-07-04)

Pedido do usuário durante teste ao vivo: reduzir a latência de detecção de
delete (hoje até `Config.POLL_INTERVAL_SECONDS`, 0.5s) usando o
`DescendantRemoving` que já era conectado em `SourceWatcher.start()` (só para
bookkeeping local via `unwatchScript`) como gatilho adicional.

- `[Hipótese, não confirmada em Studio real]` Implementado em
  `plugin/src/SourceWatcher.luau`: extraída `emitScriptRemoved(uuid,
  storedPath)` (remove do registry + `sendMessage scriptRemoved` + log),
  compartilhada entre `checkRegistryDrift` (caminho garantido, inalterado) e
  a nova `checkDeadFastPath(uuid, instance, storedPath)`. O handler de
  `DescendantRemoving` (em `scanAndWatch`) agora captura `uuid`/`storedPath`
  via `ScriptRegistry.getUuid`/`getCanonicalPath` e chama
  `checkDeadFastPath` ANTES de `unwatchScript`.
- **Cuidado de timing decidido por análise, não por teste real**:
  `DescendantRemoving` dispara ANTES da remoção terminar ("Removing", não
  "Removed") — no momento do handler, `instance.Parent` normalmente ainda é
  o Parent antigo, então checar `isInstanceDestroyed` sincronamente ali
  sempre veria `Parent ~= nil` e retornaria falso, mesmo para um `Destroy()`
  real. Fix: `checkDeadFastPath` faz a checagem dentro de `task.defer(...)`,
  cedendo um resumption point antes de checar. **Não há como confirmar se
  esse defer é suficiente sem um Studio real** — não coberto por
  `.claude/research/`, e a tarefa autorizou explicitamente não implementar
  workaround mais complexo se isso não se provar confiável. Continua
  `[Hipótese]` até o usuário testar (deletar um script pelo Explorer e
  observar, no Output, se `scriptRemoved` chega visivelmente antes do próximo
  ciclo de poll — timestamp do log já ajuda a distinguir).
- **Dedupe**: `checkDeadFastPath` reconfere `ScriptRegistry.getUuid(instance)
  == uuid` depois do `task.defer`, porque o polling (ou outro disparo do
  mesmo fast-path) pode já ter processado e removido a entrada enquanto o
  defer esperava — sem essa reconfirmação haveria risco de `scriptRemoved`
  duplicado. Confirmado por leitura do código (não só suposição): `forEach`
  usa `recordByUuid` como fonte do snapshot, e `remove(uuid)` deleta a chave
  de `recordByUuid`/`uuidByInstance` antes do `Folder:Destroy()` — então o
  ciclo de poll seguinte simplesmente não encontra mais a entrada.
- **Nenhuma regressão possível no caminho garantido**: se o `task.defer` não
  for suficiente (Parent ainda não travado no momento da checagem), o
  fast-path só não emite nada — `checkRegistryDrift` continua cobrindo no
  próximo ciclo, exatamente como antes desta mudança.
- Validado só por `rojo build` (layout ok) + `lune run` em
  `plugin/src/SourceWatcher.luau` (sem erro de sintaxe; erro esperado só na
  primeira linha que toca `game`). **Roteiro manual pendente do usuário**:
  1. Instalar o `plugin/` atualizado (rebuild + copiar `.luau`/`.rbxm` para a
     pasta de Plugins, ou reinstalar).
  2. Criar um script novo sob um dos containers observados; confirmar entrada
     em `TestService.SyncTeam.Scripts`.
  3. Apagar esse script pelo Explorer e observar o Output: comparar o
     timestamp do log `scriptRemoved` com o intervalo de poll (0.5s) — se o
     log aparecer muito antes de qualquer múltiplo de 0.5s desde o delete,
     o fast-path funcionou; se só aparecer alinhado ao ciclo de poll, o
     `task.defer` não foi suficiente e o fast-path é efetivamente inerte
     (sem prejuízo — o polling garante o resultado do mesmo jeito).
  4. Repetir apagando um script que estava aberto no editor do Studio no
     momento do delete (cenário citado na pesquisa como propenso a
     comportamento inconsistente de eventos de destruição).

## M3.1 — Sessions + heartbeat + eleição de líder (`plugin/`), 2026-07-04

`[Implementado, rojo build + lune run limpos; NÃO testado em Studio real]`
Porte direto do algoritmo de eleição já validado em 2 Studios reais no
RojoCoop (`TeamCreateElection.lua` + ciclo de tick de
`TeamCreateCoordinator.lua`), sem leases/intents (M3.2/M3.3) e sem nenhuma
mudança na extensão VS Code (fatia 100% plugin, conforme pedido).

- Dois módulos novos:
  - `plugin/src/TeamCreateSchema.luau`: container raiz compartilhado
    `TestService.SyncTeam` (idempotente) + os 3 valores de coordenação
    `LeaderClientId`/`LeaderTerm`/`NextJoinSequence` no mesmo nível de
    `TestService.SyncTeam.Scripts`. Extraído porque `ScriptRegistry.luau`
    (M2) e `TeamCreateElection.luau` (M3.1) precisavam da mesma lógica
    "criar Folder SyncTeam sob TestService se não existir" — antes só
    existia duplicada dentro de `ScriptRegistry.ensureContainers`, que foi
    refatorado para reusar `TeamCreateSchema.ensureFolder("Scripts")`.
  - `plugin/src/TeamCreateElection.luau`: constantes exatas do RojoCoop
    (pulso 2s, stale 8s, cleanup 20s, 2 observações para promoção); funções
    `elect`/`observeCandidate`/`assignJoinSequences` copiadas 1:1 (mesma
    lógica, mesmos nomes); schema `Sessions/<clientId>/` (ClientId, UserId,
    Username, JoinSequence, Pulse, ObservedRole); loop de heartbeat
    (`task.spawn`, token de geração igual a `SourceWatcher`/
    `init.server.luau`) chamando `tick()` a cada `PULSE_INTERVAL_SECONDS`.
- **Decisões tomadas nesta fatia, não 100% especificadas na tarefa**
  (documentadas também no cabeçalho de `TeamCreateElection.luau`):
  1. `ClientId` é gerado de NOVO a cada `start()` (não persistido entre
     reloads do plugin) — motivo: `stop()` já remove a própria entrada de
     `Sessions/` de forma síncrona, então não há entrada órfã acumulando
     por reload normal; persistir só ganharia continuidade de
     `JoinSequence`/`ObservedRole` entre reloads, sem valor aqui (mesmo
     modelo do RojoCoop: `clientId` novo por instância do coordinator).
  2. `Username` via `Players:GetNameFromUserIdAsync` (pcall, fallback
     `tostring(userId)`) — mesmo padrão já usado e validado no RojoCoop
     (`TeamCreateCoordinator:__resolveUsername`), portado sem alteração;
     tratado como porte de componente já validado, não pesquisa de API
     nova (não há nem precisava haver entrada em `.claude/research/` para
     isso).
  3. Log claro de liderança ("sou o líder agora (term N)" / "líder atual: X
     (term N)") implementado (sugerido como opcional pela tarefa) — ajuda a
     validar visualmente com 2 Studios reais depois.
  4. Arbitragem de UUID pelo líder (mencionada em MILESTONES.md como
     consequência natural de ter um líder combinado) **não** foi
     implementada nesta fatia — fora do escopo estrito do M3.1 (só
     sessões/heartbeat/eleição); revisitar em M3.2 se a divergência de UUID
     entre Studios (registrada no M2) voltar a aparecer em teste real.
- `plugin/src/init.server.luau`: `start()` resolve `userId` uma vez (mesmo
  pcall que já existia dentro de `sendHello`, agora reaproveitado) e chama
  `TeamCreateElection.start(userId)` depois de `SourceWatcher.start()`;
  `stop()` chama `TeamCreateElection.stop()` antes de fechar o
  `WebStreamClient`, seguindo a mesma disciplina de cleanup síncrono do fix
  de vazamento do M2.
- Validado só por `rojo build` (binário cacheado, layout ok) + `lune run`
  nos 4 arquivos tocados (`TeamCreateSchema.luau`, `TeamCreateElection.luau`,
  `ScriptRegistry.luau`, `init.server.luau`) — sem erro de sintaxe, erro
  esperado só na primeira linha que toca `game`/`plugin` (Lune não emula
  Roblox). **Nada testado em Studio real nesta tarefa.**

**Roteiro de teste manual (Studio real, 2 Studios — pedir para o usuário
executar, não pode ser automatizado, `.claude/rules/workflow.md`)**:

1. `rojo build plugin -o SyncTeam.rbxm` (ou copiar `plugin/src/*.luau`
   direto) e instalar em dois Studios com Team Create ativo na mesma place
   (roteiro de 2 contas/Studios já documentado em
   `.claude/research/2026-07-03-dois-studios-mesma-maquina.md`).
2. No Explorer de cada Studio, habilitar instâncias ocultas e navegar até
   `TestService.SyncTeam`. Confirmar que existem `LeaderClientId`
   (StringValue), `LeaderTerm` (IntValue), `NextJoinSequence` (IntValue) e
   uma pasta `Sessions` com uma entrada por Studio conectado.
3. Em cada Studio, no Output, procurar a linha `sessão criada clientId=...
   userId=...` (confirma clientId gerado e UserId resolvido via
   `StudioService:GetUserId()`).
4. Esperar alguns segundos (>2 pulsos) e confirmar em AMBOS os Studios que
   `TestService.SyncTeam.LeaderClientId.Value` é o MESMO valor — e que só o
   Studio cujo `ClientId` bate com esse valor mostrou a linha "sou o líder
   agora (term N)" no Output; o outro Studio deve mostrar "líder atual: X
   (term N)".
5. Confirmar `Sessions/<clientId>/JoinSequence` maior que 0 para os dois
   (atribuído pelo líder) e `ObservedRole.Value` == "leader" na entrada do
   líder, "follower" na do outro.
6. Confirmar que `Pulse` de cada sessão incrementa a cada ~2s (observável
   lendo o valor no Explorer/Command Bar repetidamente).
7. **Failover forçado**: fechar o Studio líder (ou clicar "SyncTeam: Parar"
   nele). No Studio remanescente, confirmar em até
   ~`STALE_AFTER_SECONDS + 2*PULSE_INTERVAL_SECONDS` (~12s, folga para 2
   observações consecutivas) que `LeaderClientId` muda para o clientId
   restante, `LeaderTerm` incrementa, e o Output mostra "sou o líder agora
   (term N+1)". Confirmar que a entrada `Sessions/<clientId antigo>` foi
   removida do Explorer se o Studio antigo chamou `stop()` antes de fechar
   (remoção síncrona); se o Studio antigo foi fechado sem `stop()` (X da
   janela), a entrada deve desaparecer só depois de
   `CLEANUP_AFTER_SECONDS` (~20s) pela limpeza do novo líder.
8. Reabrir o Studio removido, reconectar (mesma place, Team Create): deve
   entrar como novo participante (clientId novo, JoinSequence novo,
   ObservedRole "follower" já que o outro Studio continua líder).

## M3.2 — Leases por script (autoritativas), `plugin/`, 2026-07-04

`[Implementado, rojo build + lune run limpos; NÃO testado em Studio real]`
Porte do algoritmo de decisão já validado em 2 Studios reais no RojoCoop
(`TeamCreateShadowLease.lua`: `chooseWinner`/`assignRequestSequences`/
`groupByScript`, e o ciclo `__assignRequestSequences`/
`__reconcileShadowLeases` de `TeamCreateCoordinator.lua`), com a diferença
central já registrada em `docs/ARCHITECTURE.md`/`docs/DECISIONS.md`: aqui as
leases são **autoritativas** desde o início — o plugin recusa `writeSource`
de quem não é o dono, em vez de só observar ("shadow") como no RojoCoop.

- **Módulo novo `plugin/src/TeamCreateLease.luau`**: ciclo do líder roda em
  `task.spawn` PRÓPRIO (a cada `TeamCreateElection.PULSE_INTERVAL_SECONDS`,
  checando `TeamCreateElection.isLeader()` no início de cada iteração) —
  decisão explícita de não acoplar ao tick interno de `TeamCreateElection`
  (que é privado ao módulo), evitando reabrir esse arquivo já validado no
  M3.1.
- **Schema**: `TestService.SyncTeam.NextLeaseRequestSequence` (IntValue)
  adicionado a `TeamCreateSchema.ROOT_VALUES` (mesmo nível de `LeaderTerm`/
  `NextJoinSequence`); `Sessions/<clientId>/LeaseIntents/<uuid>/` (IntentId
  StringValue GUID, Pulse IntValue, RequestSequence IntValue, ScriptRef
  ObjectValue) — subpasta de `Sessions/<clientId>`, que é *owned* por
  `TeamCreateElection` (novo accessor `TeamCreateElection.getSessionFolder()`
  exposto para isso); `Leases/<uuid>/` (OwnerClientId StringValue, LeaseId
  StringValue GUID, LeaderTerm IntValue, RequestSequence IntValue).
- **Ciclo do líder** (`leaderTick` em `TeamCreateLease.luau`): lê todos os
  intents vivos (`Pulse` mudou há menos de `STALE_AFTER_SECONDS`, observado
  localmente — mesmo princípio já usado para sessões/Source desde
  M0.5/M2/M3.1), atribui `RequestSequence` via `NextLeaseRequestSequence` aos
  que ainda não têm um (`assignRequestSequences`, desempate
  `joinSequence`→`clientId`→`intentId`), agrupa por uuid e escolhe o
  vencedor por grupo **sem preempção** (`chooseWinner`: dono atual continua
  dono enquanto tiver intent vivo no grupo; senão, menor `RequestSequence`
  vence), grava/atualiza `Leases/<uuid>` rotacionando `LeaseId` quando dono
  OU `LeaderTerm` mudam, e destrói `Leases/<uuid>` cujo grupo não tem mais
  nenhum intent vivo.
- **Todo Studio (líder ou não), integrado em `init.server.luau`**: modo
  ATUALIZAÇÃO de `handleWriteSource` (mensagem com `uuid`) agora chama
  `TeamCreateLease.ensureIntent(uuid, instance)` (cria/refresca o próprio
  intent, incrementa `Pulse`) e `TeamCreateLease.canWrite(uuid)` ANTES de
  chamar `SourceWatcher.writeSource` — nega com `writeAck {ok=false, error=
  "lease negada — script sendo editado por <username ou clientId>"}` sem
  escrever nada no DataModel se o dono for outro clientId; permite
  (inclusive quando `Leases/<uuid>` ainda não existe — decisão explícita de
  design, "otimista", spec da tarefa) quando o dono é o próprio clientId ou
  não há lease arbitrada ainda. Modo CRIAÇÃO (sem `uuid`) não passa por essa
  checagem (fora de escopo desta fatia, como especificado).
- **Decisão de design não 100% especificada na tarefa**: a checagem de lease
  ficou em `init.server.luau` (`handleWriteSource`), não dentro de
  `SourceWatcher.luau`. Motivo: manter `SourceWatcher` focado só em I/O de
  Source + `ScriptRegistry` (separação já estabelecida desde o M2);
  `TeamCreateElection`/`TeamCreateLease` já são requeridos em
  `init.server.luau`, que é quem orquestra a semântica do protocolo — evita
  criar uma dependência nova de `SourceWatcher` para `TeamCreateLease` só
  para isso.
- **Limitação aceita, não pedida para corrigir nesta fatia**: pastas de
  intent (`LeaseIntents/<uuid>`) nunca são destruídas por
  `TeamCreateLease` quando ficam obsoletas — só `Leases/<uuid>` é
  criado/atualizado/destruído. Numa sessão de Studio longa editando muitos
  scripts diferentes, isso acumula uma pasta de intent por uuid já tocado,
  só limpa quando a sessão inteira morre (destrói `Sessions/<clientId>` em
  cascata). Registrado como possível polish futuro, não bug bloqueante.
- Validado só por `rojo build` (binário cacheado, layout ok) + `lune run` nos
  4 arquivos tocados (`TeamCreateSchema.luau`, `TeamCreateElection.luau`,
  `TeamCreateLease.luau` novo, `init.server.luau`) — sem erro de sintaxe,
  erro esperado só na primeira linha que toca `game`. **Nada testado em
  Studio real nesta tarefa.**

**Roteiro de teste manual (Studio real, 2 Studios — pedir para o usuário
executar, não pode ser automatizado, `.claude/rules/workflow.md`)**:

1. `rojo build plugin -o SyncTeam.rbxm` (ou copiar `plugin/src/*.luau`
   direto) e instalar em dois Studios (A e B) com Team Create ativo na
   mesma place (roteiro de 2 contas/Studios em
   `.claude/research/2026-07-03-dois-studios-mesma-maquina.md`). Esperar a
   eleição de líder convergir (ver roteiro do M3.1 acima) antes de começar.
2. No Explorer, confirmar `TestService.SyncTeam.NextLeaseRequestSequence`
   (IntValue) e a pasta `Leases` (vazia no início).
3. Em A, escrever repetidamente no MESMO script (via extensão VS Code
   conectada, ou simulando `writeSource` pelo Command Bar/harness) — várias
   vezes em menos de 8s entre escritas, para manter o intent vivo.
4. Confirmar em `TestService.SyncTeam.Leases.<uuid>` que `OwnerClientId` ==
   `ClientId` de A, dentro de até ~2 ciclos do líder (~4s) depois da
   primeira escrita.
5. Em B, tentar escrever no MESMO uuid (mesmo script) enquanto A continua
   escrevendo. Esperado: B recebe `writeAck {ok=false, error="lease negada —
   script sendo editado por <username/clientId de A>"}`; confirmar no
   Explorer que o `Source` do script NÃO mudou para o valor que B tentou
   escrever.
6. A para de escrever. Esperar mais que `STALE_AFTER_SECONDS` (8s) — dar
   folga, ~10s — sem nenhuma escrita de A nesse uuid.
7. Em B, tentar escrever de novo no mesmo uuid. Esperado: `writeAck
   {ok=true}`, `Source` atualizado com o valor de B, e
   `Leases/<uuid>.OwnerClientId` passa a ser o `ClientId` de B no próximo
   ciclo do líder (~2s depois do intent de B).
8. (Opcional, cobre "sem preempção") Repetir os passos 3-5 mas com A e B
   escrevendo quase simultaneamente pela primeira vez no mesmo uuid (sem
   lease prévia): ambos devem ser aceitos na primeira escrita (decisão
   otimista); no ciclo seguinte do líder, um dos dois deve ganhar a lease
   (aquele com menor `RequestSequence`) e o outro passa a ser negado nas
   escritas seguintes até A ou B parar.

## M3.3 — lado do plugin: `clientId` no hello + `leaseChanged` (`plugin/`), 2026-07-04

`[Implementado, rojo build + lune run limpos; NÃO testado em Studio real]`
Fatia estrita de plugin da UX de lease (o resto de M3.3 — decorações/avisos
visuais no VS Code — é trabalho paralelo de `ui-dev`, fora deste escopo).
Só ADIÇÕES pequenas a `TeamCreateElection.luau`/`TeamCreateLease.luau`
(já implementados no M3.1/M3.2), sem redesenhar nada.

- **`clientId` na mensagem `hello`** (`plugin/src/init.server.luau`,
  `sendHello()`): novo campo `clientId = TeamCreateElection.getClientId()`,
  ao lado de `role`/`placeName`/`userId`/`pluginVersion`/`protocolVersion`.
  Permite a extensão comparar o próprio Studio contra o `ownerClientId` de
  uma lease.
- **Nova mensagem espontânea `leaseChanged {uuid, ownerClientId,
  ownerDisplayName}`**: implementada dentro de `TeamCreateLease.luau`
  (opção (b) das duas oferecidas pela tarefa — ciclo PRÓPRIO deste módulo,
  não em `SourceWatcher.luau`), para respeitar a decisão já registrada no
  cabeçalho do arquivo desde o M3.2 de manter a integração de lease FORA de
  `SourceWatcher`. Novo `checkLeaseDrift()`: varre
  `ScriptRegistry.forEach` (dependência nova, unidirecional,
  `TeamCreateLease` → `ScriptRegistry`), compara `TeamCreateLease.getOwner(uuid)`
  contra o último dono visto (cache `lastOwnerByUuid`, dedupe — mesmo padrão
  de `checkSourceChanged`/`checkRegistryDrift`) e emite via callback
  injetado por `TeamCreateLease.init(sendMessage)` (chamado em
  `init.server.luau`, mesmo `sendMessage` já passado a `SourceWatcher.init`).
- **Cadência**: ciclo próprio a `Config.POLL_INTERVAL_SECONDS` (0.5s), não
  `PULSE_INTERVAL_SECONDS` (2s) do `leaderTick` — decisão: `leaseChanged` é
  sinal de UX (arquivo virou read-only/foi liberado), quer a mesma
  responsividade já usada para o resto da UI de sincronização de Source, não
  a cadência mais lenta de heartbeat/eleição.
- **Baseline sem emissão na primeira observação**: a primeira vez que um
  uuid aparece em `ScriptRegistry.forEach` nesta sessão do Studio só grava
  o dono atual em `lastOwnerByUuid` (sem mandar `leaseChanged`) — evita uma
  rajada de mensagens para todo script que já tinha lease arbitrada no
  momento em que este Studio conecta/inicia. Decisão não pedida
  explicitamente na tarefa; documentada no comentário de `checkLeaseDrift`
  em `TeamCreateLease.luau`.
- **`ownerDisplayName` sempre presente, mesmo quando `ownerClientId` é
  `nil`** (lease liberada): `TeamCreateLease.describeClient(nil)` já
  retornava `"desconhecido"` desde o M3.2 — seguido literalmente aqui
  (`ownerDisplayName = describeClient(owner)` sempre, sem condicional).
- **Limitação aceita, análoga à já documentada para `LeaseIntents`**: se um
  uuid é removido do `ScriptRegistry` (script deletado), a entrada
  correspondente em `lastOwnerByUuid` nunca é limpa — lixo pequeno e
  inofensivo em memória (não replicado), não corrigido nesta fatia.
- Validado só por `rojo build` + `lune run` (`TeamCreateLease.luau`,
  `init.server.luau`) — sem erro de sintaxe, erro esperado só na primeira
  linha que toca `game`. **Nada testado em Studio real nesta tarefa** — o
  roteiro depende do trabalho paralelo de `ui-dev` consumindo essas duas
  mensagens; não há roteiro manual isolado só para o plugin nesta fatia
  (verificação prática é ler o `leaseChanged`/`clientId` chegando na
  extensão, que é escopo de outro agente).

## M3.3 — lado da extensão VS Code: reação a leases e negações, 2026-07-04

`[Implementado, npm test/lint/build limpos; NÃO testado em Studio real]`
Complementa a fatia de plugin acima com a UX no VS Code — feedback visível ao
usuário quando uma lease muda e quando uma escrita é negada. Decisão deliberada
de **não implementar bloqueio de edição real** (read-only de arquivo): fora de
escopo (exigiria `FileSystemProvider` customizado, complexo), apenas mensagens
claras suficientes.

- **Protocolo estendido** (`protocol.ts`): `HelloMessage.clientId?: string | null`
  (novo campo do plugin para se identificar); nova mensagem espontânea
  `LeaseChangedEvent { uuid, ownerClientId, ownerDisplayName }`.
- **Módulo `LeaseTracker.ts`** (puro, sem vscode/I/O): rastreador de estado de
  leases. Métodos principais:
  - `updateLease(uuid, ownerClientId, ownerDisplayName)` — registra mudança quando
    `leaseChanged` chega.
  - `isOwnedByMe(uuid): boolean` — otimista: permite se sou dono OU se está
    livre (null) OU se nenhuma lease foi arbitrada ainda.
  - `describeOwner(uuid): string | null` — retorna nome de quem é dono (ou
    clientId como fallback), null se for eu ou se estiver livre.
- **Integração `SyncTeamService.ts`**: captura `clientId` do `hello` recebido
  em `onClientConnected`, instancia `LeaseTracker` com ele; roteia `leaseChanged`
  em `routeSpontaneous` (novo caso em switch) com validação de campos; oferece
  callbacks públicos `setOnLeaseChanged(callback)` e `setOnWriteRejected(callback)`
  para que `extension.ts` reaja com UI.
- **Integração `SyncBridge.ts`**: novo callback opcional `onWriteRejected` passado
  no construtor, chamado quando `writeAck.ok === false` chega (ambos os modos:
  atualizar script conhecido ou criar novo). Setter público
  `setOnWriteRejected(callback)` para composição tardia.
- **Camada de ativação `extension.ts`** (única que usa `vscode` fora de
  `VscodeDiskIO`): configura os dois callbacks depois de instanciar
  `SyncTeamService`:
  - `onLeaseChanged`: log informativo no output channel (não bloqueia UI).
  - `onWriteRejected`: `vscode.window.showWarningMessage(mensagem de erro)`.
- **Testes** (57 testes: 9 novos em `test/leaseTracker.test.ts`, 2 novos em
  `test/syncBridge.test.ts`):
  - LeaseTracker: otimismo, muda de dono, liberação (null), fallback de clientId,
    getSstate bruto.
  - SyncBridge: callback dispara em modo atualizar (uuid conhecido) e criar
    (novo arquivo).
- **Verificação**: `npm run lint` (tsc --noEmit, clean); `npm test` (57/57 passed);
  `npm run build` (esbuild, dist/ atualizado).
- **Decisão não 100% especificada**: `onLeaseChanged` só loga — não tenta
  decorar arquivo ("read-only" label) nem bloqueia edição de fato. Simplificação
  aceita e documentada como "feedback visível, não preempção". A edição local
  de um arquivo sem lease será enviada para o Studio; ele rejeitará com
  `writeAck.ok=false`, e o callback de `onWriteRejected` vai mostrar o erro ao
  usuário. Fluxo completo, sem bloqueio de SO.
- **Não testado em Studio real**: integração com o plugin que manda `hello.clientId`
  e `leaseChanged`; roteiro manual pendente no `docs/PROJECT_STATUS.md` —
  requer os dois lados (plugin M3.1/M3.2 + extensão M3.3) já validados
  isoladamente e compilando.

## Próximas ações

1. ~~`vscode-extension/`: servidor WS local, parser de `default.project.json`,
   módulo de mapeamento Rojo, pull inicial Studio→disco, watcher
   local→Studio~~ — feito (ver acima). Falta o round-trip real Studio↔disco.
2. Round-trip real em Studio com `spikes/m1-test-project/`: instalar
   `plugin/` (via `rojo build` + copiar para a pasta de Plugins, mesmo
   padrão dos spikes) e abrir `spikes/m1-test-project/` no VS Code com
   `vscode-extension/` carregada (`F5`/Extension Development Host, ou
   `vsce package` + instalar o `.vsix`); confirmar toolbar/auto-start/conexão
   de fato nos dois lados, e que depois do round-trip `rojo build`/
   `rojo serve` no mesmo projeto continua sem diff espúrio (critério de
   aceite explícito do M1, fatia 7).
3. **M0 com o colega** (2 máquinas, Team Create real) ainda pendente para os
   itens de robustez da matriz (Drafts on/off × script aberto/fechado) —
   não bloqueia o M1, que é escopo de 1 Studio só; roteiro em
   `spikes/m0-source-replication/README.md`.
4. `[Feito 2026-07-04, plugin + extensão]` Identidade por UUID+ObjectValue
   (M2): ver seções "M2 — lado do plugin" e "M2 — lado da extensão" acima.
   Falta: (a) roteiro de teste manual em Studio real (escrito na seção do
   plugin, pendente de execução pelo usuário) — é o único bloqueador restante
   para fechar o M2, já que os dois lados foram implementados e testados
   isoladamente (build/lune do lado do plugin; vitest/tsc/esbuild do lado da
   extensão) mas nunca um contra o outro com um Studio de verdade.

## Nota sobre agentes customizados nesta sessão

`[Verificado]` Os agentes definidos em `.claude/agents/*.md` não apareceram
como `subagent_type` disponíveis na sessão que os criou (lista de tipos parece
fixada no carregamento da conversa). Contorno usado: `general-purpose` com
instrução explícita para ler o arquivo de persona correspondente antes de
trabalhar. A expectativa é que sessões novas reconheçam os agentes
nativamente — confirmar na próxima conversa.

## Nota de sessão — code review do M3 + fix pré-teste (2026-07-04)

Antes do teste real combinado M3.2+M3.3 em 2 Studios, foi feita uma revisão
de código independente (8 ângulos de busca + verificação) sobre todo o
trabalho do M3 (sem git diff disponível — repo sem commits ainda; escopo
tratado como "revisão completa dos arquivos novos/alterados"). Achados
completos com veredito em `ReportFindings` desta sessão; os 2 mais graves
foram **corrigidos direto na sessão principal** (exceção de correção
trivial do `.claude/rules/workflow.md`, sem passar por subagent — decisão
consciente por orçamento de sessão em ~5% do plano semanal):

- Ver `docs/DECISIONS.md` (entrada "M3.3: bug de escopo Lua deixava
  `leaseChanged` mudo") para os 2 bugs confirmados e corrigidos:
  `TeamCreateLease.init`/`sendMessage` (escopo Lua) e normalização de
  `ownerClientId`/`ownerDisplayName` ausentes para `null` do lado da
  extensão.
- Verificado: `npm run lint`/`npm test` (57/57)/`npm run build` limpos.
  `rojo build` do plugin **não verificado** — ambiente sem `rojo` acessível
  no momento (nem via rokit nem instalação global em `/c/Program
  Files/Rojo`); investigar isso na próxima sessão antes de reinstalar o
  plugin em Studio.
- **8 achados adicionais não corrigidos** (não bloqueiam o teste, mas valem
  atenção antes de fechar M3 de vez): janela de corrida na lease otimista
  quando ainda não existe `Leases/<uuid>` (`TeamCreateLease.canWrite`);
  arbitragem de UUID por líder prometida em M3.1 nunca implementada
  (`ScriptRegistry.resolveOrAllocate` ainda não usa `isLeader()`); cache
  otimista de disco não revertido quando `writeSource` é rejeitado por
  lease (`SyncBridge.handleLocalFileChange`); incremento não-atômico de
  `LeaderTerm` no cenário de split-brain já documentado;
  `LeaseTracker` recriado vazio a cada reconexão WS, perdendo baseline;
  `lastOwnerByUuid` resetado a cada `start()` do plugin sem reemitir estado
  atual; `getOrCreate` duplicado em 3 arquivos apesar de `TeamCreateSchema`
  existir para isso; 4 loops de fundo quase idênticos (token de geração)
  sem infraestrutura compartilhada.
- **Pendente**: teste real combinado M3.2 (rejeição de lease) + M3.3 (aviso
  espontâneo) em 2 Studios — roteiro já escrito em sessão anterior deste
  mesmo arquivo. Adiado por decisão do usuário (orçamento de plano semanal
  baixo); retomar quando o plano renovar (~3 dias a partir de 2026-07-04).
  Antes de retomar: reinstalar o plugin com o fix aplicado (precisa
  resolver o `rojo build` primeiro) e reconfigurar a porta 34981 na Studio B
  (`plugin:SetSetting("SyncTeam_WsPort", 34981)` no Command Bar, ação que só
  o usuário pode executar).

## Checklist de retomada

1. Ler este arquivo.
2. Ler [MILESTONES.md](MILESTONES.md) para o critério de aceite vigente.
3. Ler [DECISIONS.md](DECISIONS.md) antes de propor mudança de rumo.
4. Verificar afirmações `[Hipótese]` contra código/teste antes de construir
   sobre elas.
