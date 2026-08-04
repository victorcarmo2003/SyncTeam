# Memória do luau-dev

Aprendizados de API do Studio e pegadinhas de Luau encontrados no projeto.
Atualize ao final de cada tarefa; mantenha curto e acionável.

## Bug real confirmado e corrigido: campo calculado só para log virou causa raiz de um bug funcional (eco de `sourceChanged`, revert/rebuild ao digitar rápido), 2026-08-03

- **Padrão de revisão a repetir sempre que um campo tipo `origin`/`source`/
  `reason` for calculado só "para efeito de log"**: perguntar explicitamente
  "esse valor deveria estar decidindo algum `if` em vez de só aparecer numa
  string?" antes de aceitar o comentário "só para log" como inofensivo. Aqui,
  `checkSourceChanged` (`plugin/src/SourceWatcher.luau`) computava `origin`
  (`"plugin"` vs `"studio"`, via `recentWrites[instance]`, janela de 1s
  desde o último `SourceWatcher.writeSource` NESTA instância) corretamente
  há tempos, mas só o usava no `Logger.debug` final — nunca para decidir se
  `sendMessage` deveria rodar. Resultado prático: toda escrita que o PRÓPRIO
  plugin fazia por causa de um `writeSource` vindo da extensão (inclusive o
  pulse de buffer a cada ~150ms, feature de 2026-08-02) ecoava de volta pro
  MESMO cliente WS que causou a escrita — `sendMessage`
  (`init.server.luau:192-202`) é um único callback module-level ligado a UM
  `client`, sem roteamento por conexão (produto usa 1 conexão só). Do lado
  da extensão, esse eco não tinha como ser distinguido de uma mudança
  genuína vinda de outro Studio via Team Create — `handleSourceChanged`
  (`SyncBridge.ts`) ignora `origin` (só aparece em log) e a fila FIFO
  (`enqueueMutation`) + `contentCache` atualizado ANTES do ack do
  `writeSource` (`pushKnownUuidUpdate`) faziam o eco de um pulse ANTIGO
  chegar depois de um pulse mais NOVO já ter avançado o cache — `writeToDisk`
  então tratava o eco como "genuíno" e reescrevia disco/buffer com conteúdo
  velho. Repetido a cada eco atrasado de uma rajada de digitação rápida
  (Ctrl+S logo depois de digitar com autocomplete/Tab), dava a aparência
  exata de "desfaz e reconstrói letra por letra ao longo de 10-15s" — bug
  relatado pelo usuário, que já tinha a hipótese certa com evidência de
  código; confirmei sem nenhum furo relendo os dois lados (Luau +
  TypeScript) ponta a ponta.
- **Fix**: `checkSourceChanged` só chama `sendMessage` quando `origin ~=
  "plugin"` — guard novo em volta da chamada existente, dedupe
  (`lastSourceByInstance`) e `Logger.debug` continuam incondicionais/
  intocados. Antes de aplicar, confirmei que `writeAck` (`init.server.luau`,
  por `requestId`) já é o canal real de confirmação de escrita — o eco de
  `sourceChanged` não carregava nenhuma informação que `writeAck` não
  carregasse, então suprimir é seguro sem substituto. Avaliado e
  descartado por falta de evidência real (regra do pedido: não proteger
  contra cenário hipotético): `UpdateSourceAsync` normalizar o conteúdo
  (line endings etc.) de um jeito que a extensão nunca saberia sem o eco —
  `refreshSync` (reconciliação 3-way) já existe como rede de segurança para
  esse tipo de deriva, e nada em `.claude/research/` confirma essa
  normalização acontecendo.
- **Risco residual aceito conscientemente, documentado aqui pra quem
  revisitar**: a janela de 1s de `origin` é por-INSTÂNCIA, não por-conexão —
  se o MESMO script for editado por uma via genuinamente diferente
  (ex.: usuário editando direto no Script Editor nativo do Studio) dentro de
  1s depois de um `writeSource` vindo da extensão pra ESSE MESMO script,
  essa edição também seria classificada `origin="plugin"` e teria seu envio
  suprimido — perda de notificação, não só de log (antes desta tarefa,
  origin mal-classificado só sujava o log, nunca escondia uma mudança real).
  Não é uma regressão introduzida por escolha própria; é a heurística de
  timing já existente (validada só para log) passando a ter efeito
  funcional. Aceito porque (a) o campo já era usado para essa classificação
  há tempos sem nenhuma migração para algo mais preciso, (b) o cenário
  (editar o mesmo script simultaneamente no Script Editor nativo E receber
  um push da extensão no mesmo <1s) é raro e de baixo custo se acontecer
  (próximo poll/edição detecta a divergência via dedupe de qualquer forma,
  e `refreshSync` cobre drift maior), (c) o pedido explícito da tarefa foi
  não inventar proteção para cenário hipotético sem evidência real.
- **Validação real (Tools/, 1 Studio só) TENTADA e NÃO concluída** — motivo
  registrado por completo aqui porque é reaproveitável: bug NÃO depende de
  replicação Team Create (eco acontece dentro da MESMA conexão
  plugin↔extensão), então só precisa de 1 Studio. Plugin buildado+implantado
  (`Tools/build-and-deploy-plugin.sh`, OK) e harness subido
  (`Tools/start-harness.sh 34980 spikes/m1-test-project`, confirmado
  `LISTENING` via `netstat`), mas o Studio já aberto (processo confirmado
  vivo, `tasklist`) não reconectou ao harness mesmo depois de ~5min de
  espera ativa (`Bash run_in_background` com loop `until grep "plugin
  conectado"`). Causa mais provável: autostart é opt-in por instalação de
  Studio desde 2026-07-16 (`Config.resolveAutoStartEnabled`, default OFF) —
  reconectar depois de um redeploy old exige um clique manual no toggle da
  toolbar, que é uma ação física dentro do Studio fora do alcance de
  qualquer ferramenta desta sessão (`ToolSearch` confirmou de novo, como em
  2026-08-02, que não há MCP `Roblox_Studio` nem Command Bar remoto
  disponíveis). **Padrão a levar pra próxima tarefa que precise de teste ao
  vivo com um Studio JÁ ABERTO antes da sessão começar** (diferente do fluxo
  normal onde o Studio abre DEPOIS do plugin já implantado, e autostart
  roda no boot do plugin): um redeploy no meio da sessão de um Studio que já
  estava desconectado (autostart off, ou já tinha caído) não reconecta
  sozinho — não vale esperar mais que ~1-2min por uma reconexão automática
  nesse cenário específico; é mais eficiente já reportar como pendente de
  clique manual do que ficar re-polling. Ver roteiro completo de 4 passos em
  `docs/DECISIONS.md` 2026-08-03 "17ª rodada".
- **Validado só estático**: `selene plugin/src` → 0 errors, 42 warnings
  (baseline idêntica, 0 novos em `SourceWatcher.luau`), `stylua --check`
  limpo, `lune run plugin/src/SourceWatcher.luau` erra só na 1ª linha que
  toca `game` (padrão de sempre — confirma sintaxe do resto, incluindo o
  guard novo). **Lune não é aplicável para testar `checkSourceChanged`
  diretamente** (função privada, entrelaçada com `instance.Source`/
  `ScriptRegistry`/`Config`/`game` — research já confirmado
  `.claude/research/2026-08-02-lune-selene-stylua-testez-luau-tooling.md`:
  Lune não mocka serviços do Studio, só dá um `Instance`/`DataModel`
  genérico via `@lune/roblox`) — não forcei um teste headless artificial
  sem valor real; fica só a leitura de código (alta confiança) + pendência
  de teste ao vivo.

## Handoff quase-instantâneo de lease: `leaseStaleAfterSeconds` configurável + desacoplar leaderTick do heartbeat de eleição, 2026-08-02 (8ª tarefa do dia)

- **Padrão a repetir sempre que uma constante de coordenação "compartilhada"
  precisar de um valor MAIS RÁPIDO só para um dos dois usos**: baixar só o
  threshold (aqui, `STALE_AFTER_SECONDS`) sem desacoplar o LOOP que o
  checa é decorativo — o piso de detecção fica preso na cadência do loop,
  não importa o número do threshold. `TeamCreateLease.leaderTick` rodava
  `task.wait(TeamCreateElection.PULSE_INTERVAL_SECONDS)` (2s, a MESMA
  constante do heartbeat de eleição); troquei para
  `task.wait(Config.POLL_INTERVAL_SECONDS)` (0.5s, mesma cadência que
  `checkLeaseDrift` já usava no mesmo `start()`) — só depois disso um
  `leaseStaleAfterSeconds` de 2s passou a fazer sentido de verdade.
  `TeamCreateElection.PULSE_INTERVAL_SECONDS`/o heartbeat de eleição em si
  NÃO foram tocados — só o loop de `TeamCreateLease` parou de reusar a
  constante do vizinho.
- **Decisão de escopo (a mais delicada da tarefa, explicitamente pedida para
  eu decidir): `TeamCreateElection.STALE_AFTER_SECONDS` (8s fixo, usado por
  `elect`/`applyJoinSequenceAssignments`/`tick` para detectar sessão/líder
  morto) NÃO virou configurável — só o de LEASE (agora um valor separado,
  `Config.getPlaceSetting(pluginObjectRef, "leaseStaleAfterSeconds")`, lido
  só dentro de `TeamCreateLease.readLiveIntents`)**. Os dois COMPARTILHAVAM
  a mesma constante antes desta tarefa só por acidente histórico (M3.1
  definiu STALE_AFTER_SECONDS, M3.2 reaproveitou por conveniência) — são
  conceitos de natureza diferente: eleição/sessão morta é uma constante de
  SEGURANÇA de coordenação (risco de split-brain, já validada em 2 Studios
  reais no RojoCoop incluindo failover forçado, e já corrigida uma vez em
  2026-07-07 por causa de uma corrida de replicação); lease morta é uma
  constante de UX/latência de arquivo. Baixar a de eleição também
  arriscaria reabrir aquele bug por um motivo (latência de lease) que não
  tem NADA a ver com ele. Regra geral pro projeto: antes de tornar uma
  constante de coordenação "configurável" só porque outra constante que
  reusa o mesmo número numa tarefa vizinha precisa mudar, perguntar se as
  DUAS têm o mesmo motivo de existir — se não, desacoplar em vez de
  compartilhar o dial.
- **Novo padrão de "settings por-place lidas continuamente por um loop de
  runtime"** (primeira vez que isso acontece no projeto — as settings
  por-place de 2026-08-02 (2ª tarefa) tinham ficado "decorativas", nenhum
  loop as lia ainda): `TeamCreateLease.start(pluginObject)` (assinatura
  nova, mesmo contrato de `TeamCreateElection.start`) guarda `pluginObject`
  num module-level `pluginObjectRef` (nil-safe, resetado em `stop()`) — DIFERENTE
  de `TeamCreateElection.start`, que só usa `pluginObject` de forma SÍNCRONA
  dentro do próprio `start()` (não precisa reter, resolve
  `Config.resolveCustomDisplayName` 1x no boot). Aqui `readLiveIntents` (chamado
  a cada ciclo do líder, agora 0.5s) precisa reconsultar a setting
  continuamente — dev pode editar o valor no painel com a sessão já
  conectada, e o próximo ciclo (até 0.5s depois) já reflete, sem precisar de
  nenhum evento de "config mudou" ou reconexão. `Config.getPlaceSetting`
  já é nil-safe para `pluginObjectRef == nil` (degrada pro default 2s) —
  não precisei adicionar nenhum guard extra.
- **Diferença importante entre "self-contained callback que só persiste" e
  "self-contained callback que também precisa republicar"**: ao decidir
  onde por a lógica de `onLeaseStaleAfterSecondsSubmit` (novo campo do
  painel), usei `onCustomDisplayNameSubmit` como referência mas achei uma
  diferença real — `onCustomDisplayNameSubmit` precisa de uma 2ª chamada
  (`TeamCreateElection.setLocalUsername`) porque o Username é um
  `StringValue` CACHEADO que só é escrito uma vez (não é relido do zero a
  cada ciclo); já `leaseStaleAfterSeconds` é relido do zero A CADA ciclo do
  líder por `readLiveIntents` — então `onLeaseStaleAfterSecondsSubmit` só
  precisa persistir via `Config.setPlaceSetting`, sem nenhuma chamada de
  "aplicar agora". Regra pra próxima setting por-place nova: se o valor é
  lido do Config a cada ciclo de um loop já rodando, só a persistência
  basta; se é cacheado numa Instance de valor e só escrito uma vez, precisa
  de uma função de republish explícita.
- **UI numérica em SettingsRow (2ª vez que aparece no projeto, 1ª foi
  `CustomDisplayNameField` que é string)**: copiei o esqueleto visual de
  `CustomDisplayNameField` (TextBox 0.62/0.38 dentro de SettingsRow) mas a
  validação de `FocusLost` seguiu `PortRow` (`tonumber` + rejeita
  não-positivo) em vez da validação livre de string. Diferença deliberada
  de `PortRow`: NÃO force `math.floor` — `leaseStaleAfterSeconds` é
  segundos, fração (`2.5`) é um valor sensato; porta não pode ser fracionária,
  segundos-de-timeout pode.
- **git stash em arquivo que já estava "modified" antes da tarefa (não
  commitado) reverte para o ÚLTIMO COMMIT, não para "antes da minha edição"
  — quase apaguei trabalho de sessões anteriores não commitado**: tentei
  isolar minhas mudanças rodando `git stash push -- <5 arquivos>` só para
  comparar contagem de warnings do Selene antes/depois. Como esses 5
  arquivos já apareciam como `M` no `git status` no INÍCIO da tarefa (reskin
  M4.5/ReSync de sessões anteriores, não commitado ainda), o stash reverteu
  TUDO isso para o HEAD (`1dc8b22`), não só as minhas edições desta tarefa —
  `git stash pop` imediato recuperou tudo (confirmado por grep das minhas
  strings-chave depois). **Nunca usar `git stash` (nem parcial/pathspec) só
  para "comparar antes/depois" num arquivo que já tinha mudanças não
  commitadas de outra sessão** — se precisar isolar o efeito de uma edição
  específica, usar `git diff`/copiar o arquivo pra um path temporário em vez
  de stash, ou aceitar que a comparação vai incluir o histórico não
  commitado inteiro.
- **Efeito colateral do stash/pop nesta máquina (`core.autocrlf=true`):
  os 5 arquivos tocados pelo stash voltaram com CRLF**, mesmo o projeto
  usando `line_endings = "Unix"` no `.stylua.toml` e todo o resto do
  repositório estando em LF — `git stash pop` fez o checkout re-normalizar
  para CRLF (o mesmo aviso "LF will be replaced by CRLF" que aparece em
  qualquer `git add`/`stash` nesta máquina). Sintoma: `stylua --check`
  reportou o arquivo INTEIRO como diff (toda linha "removida" e
  "re-adicionada" idêntica) — não é erro de formatação real, é diferença de
  terminador de linha byte-a-byte. Fix: `dos2unix <arquivo>` nos arquivos
  afetados antes de rodar `stylua --check` de novo (limpo depois). Regra
  geral: se `stylua --check` mostrar um diff que parece ser o arquivo
  inteiro reescrito linha por linha com texto IDÊNTICO, suspeitar de CRLF
  antes de qualquer outra coisa — `file <arquivo>` confirma
  ("CRLF line terminators" vs sem essa menção).
- **Validado**: `selene plugin/src` → 0 errors, 42 warnings (baseline local
  antes desta tarefa não é diretamente comparável por causa do imbróglio de
  stash acima, mas confirmei manualmente que os únicos avisos novos são
  exatamente 1 `mixed_table` na `FocusLost` do novo `LeaseStaleAfterSecondsField`
  — mesma classe/padrão que TODO `vide.create` com função inline + array
  children já gera neste arquivo, incluindo o `CustomDisplayNameField`
  logo acima; não é uma categoria de warning nova). `stylua --check` limpo
  (depois do fix de CRLF) nos 5 arquivos tocados
  (`Config.luau`/`TeamCreateLease.luau`/`init.server.luau`/
  `StatusPanel.luau`/`PluginUI.luau`). `lune run` em cada um: erro só na 1ª
  linha que toca `game`/`script.Parent` (padrão de sempre; `Config.luau`
  roda inteiro sem erro, não toca `game` em nível de módulo) — confirma que
  todo código novo compila sem erro de sintaxe. **Nada testado em Studio
  real** — depende também do lado extensão (`onDidChangeTextDocument`
  throttled, `extension-dev`, mesma feature, rodando em paralelo) para o
  roteiro fim-a-fim fazer sentido. Roteiro de 5 passos em
  `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md`, entrada 2026-08-02 "8ª
  rodada" (continuação `luau-dev`).

## Spike M1.6 — taxa de streaming de Source: padrão para medir latência ENTRE 2 STUDIOS sem depender de timestamp Roblox, e confirmação de que não há MCP/Command Bar disponível nesta sessão, 2026-08-02 (7ª tarefa do dia)

- **Quando a tarefa pede medir latência/timing entre os 2 Studios reais e a
  API de timestamp Roblox necessária (`DateTime.now().UnixTimestampMillis`
  ou similar) NÃO está confirmada em `.claude/research/`, não pare a
  tarefa inteira nem peça pesquisa só por causa disso** — se existir um
  processo Node LOCAL que os dois Studios já falam (control-server dedicado
  do spike, ou um harness), prefira desenhar a medição para que **o
  processo Node carimbe o instante de recebimento** de cada evento (Node
  `Date.now()`, relógio único e trivialmente comparável entre os 2
  Studios, já que ambos rodam na MESMA máquina física neste projeto — 2
  contas Roblox via "Add Account"). O Luau de cada lado manda só o dado
  relevante (número de sequência, taxa) via WebSocket; a subtração de
  `recvMs` no Node dá a "latência" (com um viés pequeno e aprox. constante
  do hop WS, documentado explicitamente onde isso é usado) sem precisar de
  NENHUMA API de timestamp Roblox nova. Útil para COMPARAR (ex.: taxa A vs
  taxa B), não para um número absoluto "puro" — se algum dia for preciso um
  número absoluto de latência de replicação sem o viés do hop WS, aí sim
  vale mandar `researcher` confirmar `DateTime.UnixTimestampMillis` antes
  de codar sobre a hipótese.
- **Confirmado por `ToolSearch` nesta sessão: MCP `Roblox_Studio` e Command
  Bar remoto NÃO estavam disponíveis** (`ToolSearch` com
  `select:mcp__Roblox_Studio__*` e busca livre por "Roblox_Studio" não
  retornaram nada) — não há como executar Luau dentro de um Studio real
  remotamente nesta sessão, nem clicar botão de toolbar. Isso muda o que dá
  para automatizar num spike de 2 Studios: a única interação física
  restante e inevitável é 1 clique de botão POR STUDIO para escolher o
  papel (padrão já usado no M0 — não vale a pena tentar eliminar isso com
  heurística de auto-detecção de papel via setting persistida; avaliei essa
  alternativa e descartei por fragilidade/acoplamento desnecessário a uma
  chave de produção só para economizar 2 cliques — ver raciocínio completo
  no histórico desta tarefa se precisar retomar). Antes de assumir que
  MCP virou disponível numa sessão nova, checar de novo com `ToolSearch`
  (pode ter mudado por restart, ver nota em `Tools/README.md`).
- **Restrição de domínio "nada de teste que exija 2 Studios rodando; escreva
  o roteiro e reporte pro orquestrador/usuário executar" é literal e
  prevalece mesmo quando `Tools/README.md`/`CLAUDE.md` descrevem partes do
  ciclo como "automatizáveis pela IA"** — nesta tarefa, construí e VALIDEI
  o tooling Node com dado SINTÉTICO (permitido — não envolve nenhum
  Studio), mas não tentei rodar o roteiro real contra os 2 Studios nem
  fabriquei número de latência nenhum. Toda alegação de "taxa recomendada"
  ficou explicitamente marcada como não verificada, com uma recomendação
  PROVISÓRIA derivada só da pesquisa já existente (não de medição própria)
  — não confundir as duas coisas em nenhum relatório futuro.
- **Alvo de spike que não deve ser sincronizado pelo plugin de produção
  (já rodando nos mesmos 2 Studios via `Tools/`)**: colocar a Instance de
  teste em `TestService.<AlgumNomeDoSpike>` — `TestService` NÃO está em
  `Config.getWatchedRoots()` (lista atual: ServerScriptService,
  StarterPlayerScripts, ReplicatedStorage, ReplicatedFirst, ServerStorage,
  StarterGui, Workspace), então o plugin de produção nunca tenta
  sincronizar o script de teste para o projeto VS Code real. Padrão a
  repetir em qualquer spike futuro que precise de uma Instance descartável
  nos mesmos 2 Studios que já têm o produto rodando.
- **Padrão de smoke test para tooling Node de um spike, sem precisar de
  Studio nenhum**: escrever um "feeder" descartável (client `ws` puro) que
  simula exatamente o formato de mensagem que o Luau real mandaria (mesmos
  campos `kind`/`n`/`rateHz`/`via`), incluindo perda/latência PROPOSITAL
  para confirmar que a análise detecta o que deveria detectar — remover o
  feeder e o log sintético depois (não fazem parte do roteiro real
  entregue). Isso valida a metade Node do tooling com confiança real antes
  de entregar, sem violar a restrição de "nada de 2 Studios".
- **Processo Node em background sobrevive ao fim do bloco Bash que o
  iniciou com `&`** (sem `run_in_background:true` da ferramenta) — depois
  do smoke test, `netstat -ano` confirmou um processo `node` ainda
  `LISTENING` na porta do control-server mesmo já tendo "saído" daquele
  bloco de comando. Sempre confirmar com `netstat`/matar explicitamente
  (`taskkill //F //PID <pid>`, processo do PRÓPRIO agente nesta mesma
  tarefa — identificado com certeza, reversível, dentro da autoridade de
  `.claude/rules/authority.md`) depois de qualquer smoke test que suba um
  servidor local, para não deixar zumbi ocupando a porta na sessão
  seguinte.
- **Validado**: `selene spikes/m1.6-source-streaming-rate` (0
  errors/warnings), `stylua --check` limpo (1 diff de formatação
  encontrado e corrigido — dois `toolbar:CreateButton` de 1 linha
  ultrapassavam `column_width=120`, StyLua quebrou em multi-linha), `lune
  run` erra só na 1ª linha que toca `game` (linha do
  `game:GetService("HttpService")`), confirmando o resto do arquivo
  parseado sem erro. `node analyze-log.mjs` confirmado funcional contra log
  sintético (ver acima). **Nada testado contra Studio real** — roteiro
  completo em `spikes/m1.6-source-streaming-rate/README.md` e
  `docs/DECISIONS.md` 2026-08-02 "(6ª rodada, mais recente)", pendente do
  usuário ou `qa-tester` executar.

## Botão ReSync — padrão exato de "enviar mensagem espontânea do plugin" (reaproveitável pra próxima feature nesse molde), 2026-08-02 (6ª tarefa do dia)

Tarefa com contrato JÁ FECHADO em `docs/DECISIONS.md` (entrada "5ª rodada"),
rodando em paralelo com `ui-dev` (visual em `StatusPanel.luau`/`Toast.luau`)
e `extension-dev` (lado VS Code) — minha parte foi só ligar o clique do botão
(feito pelo `ui-dev`) ao protocolo e tratar a resposta.

- **Receita para uma mensagem espontânea NOVA plugin→extensão (sem
  `requestId`, sem `request()`/pending)**: (1) o "emissor" é sempre um
  callback dentro da tabela passada a `PluginUI.init(plugin, {...})` em
  `init.server.luau` — nunca um novo mecanismo de envio; ele só chama a MESMA
  `sendMessage(message)` module-level (função privada de `init.server.luau`,
  já usada por `sourceChanged`/`presenceUpdate`/`scriptAdded`/etc.) com
  `{kind = "<novoKind>"}`. (2) o callback correspondente entra no MESMO
  `statusPanelCallbacks` de `PluginUI.luau` como **passthrough puro**
  (`onXRequest = callbacks.onXRequest`, zero lógica própria ali) — só é
  self-contained dentro de `PluginUI.luau` quando a ação NÃO depende de nada
  que só `init.server.luau` conhece (`client`/`sendMessage`/`enabled`); aqui
  dependia dos dois, então passthrough é a escolha certa (mesmo critério já
  registrado na entrada de `onAutoReconnectToggle`, 2026-07-20, e confirmado
  em `.claude/agent-memory/ui-dev.md`).
- **Receita para tratar a resposta espontânea NOVA extensão→plugin**: vira
  só mais um `elseif message.kind == "<novoKindResult>" then` dentro da
  cadeia já existente de `handleMessage` (`init.server.luau`, ~linha
  464+/514+ conforme o arquivo cresce) — NUNCA um mecanismo de
  request/pending novo, mesmo que a mensagem "pareça" uma resposta a um
  pedido (aqui, `resyncResult` respondendo a `resyncRequest`): o par inteiro
  é tratado como dois eventos espontâneos independentes, correlacionados só
  por ORDEM/CONVENÇÃO (a extensão manda `resyncResult` depois de processar o
  `resyncRequest` mais recente), nunca por id de requisição. Extraí a lógica
  para uma função nomeada `handleResyncResult(message)` (padrão já usado por
  `handleWriteSource`/`handleDeleteScript`/`handleReadSource`/
  `handleListScripts` sempre que o corpo tem mais de ~3 linhas ou 2 branches
  — casos mais simples como `ping`/`presenceUpdate` continuam inline dentro
  do próprio `elseif`).
- **Estado visual empurrado por `init.server.luau`, nunca decidido dentro de
  `PluginUI.luau`**: `resyncStateSource` (`"idle"|"syncing"|"done"`, novo
  `vide.source`) segue EXATAMENTE o mesmo padrão de
  `connectionStatusSource`/`portSource` — um setter validado+dedupado
  exposto (`PluginUI.setResyncState`, tabela `VALID_RESYNC_STATES` +
  `if valid and state ~= atual then atual(state) end`, cópia do molde de
  `PluginUI.setConnectionStatus`) chamado de fora por `init.server.luau` em
  3 pontos: clique (`"syncing"`), sucesso (`"done"`, com `task.delay(1.2,
  ...)` de volta a `"idle"`), falha (direto a `"idle"`). `PluginUI.luau`
  nunca decide sozinho quando trocar de estado — só reflete.
- **Achado de design que vale generalizar**: quando o contrato pede um toast
  que deve aparecer SEMPRE, independente da preferência "Mostrar
  notificações" (`Config.NOTIFICATIONS_SETTING_KEY`), NÃO usar
  `Logger.notify`/`notify` (esse canal É condicionado à preferência via
  `PluginUI.notify`, mesmo sendo incondicional no log/WS) — usar
  `Toast.show(text, severity)` DIRETO, exigindo `local Toast =
  require(script.ui.Toast)` em `init.server.luau` (novo nesta tarefa; antes
  só `PluginUI.luau` requeria `Toast`). Critério para decidir qual dos dois
  canais usar num aviso novo: é resposta imediata a uma ação EXPLÍCITA do
  usuário que acabou de clicar um botão (aqui, RESYNC) → sempre visível,
  `Toast.show` direto; é evento espontâneo do sistema (lease negada, queda de
  conexão, reconciliação) → `Logger.notify`, respeita a preferência.
- **Nota importante para quem mexer aqui achando `Toast.show` quebrado**: no
  momento desta tarefa, `Toast.luau` (domínio do `ui-dev`, rodando em
  paralelo) ainda só expõe `Toast.mount(pluginObject) -> {show, destroy}`
  (função de instância, sem severidade) — **não existe ainda** um
  `Toast.show(text, severity)` module-level. Escrevi a chamada assumindo essa
  assinatura por contrato explícito da tarefa ("`Toast.show(text)` sem 2º
  arg continua funcionando por causa do default `'info'`... não quebra nada
  se rodar antes do ui-dev terminar") — se `ui-dev` não tiver mesclado até
  este código rodar em Studio real, `Toast.show` vai ser `nil` e a chamada em
  `handleResyncResult` vai lançar (capturado por nenhum pcall hoje — decisão
  deliberada de NÃO envolver em pcall, já que mascarar um erro de
  contrato-ainda-não-cumprido seria pior que deixar aparecer). Confirmar que
  `ui-dev` mesclou `Toast.show` module-level antes de testar o fluxo de erro
  em Studio real.
- **Validado só por `selene plugin/src` (0 errors, 37 warnings — baseline
  idêntica, nenhum warning novo, incluindo o `StatusPanel.luau` já tocado
  pelo `ui-dev` em paralelo), `stylua --check` (limpo, sem diffs) nos 2
  arquivos tocados, e `lune run`** em `PluginUI.luau` (erra na linha do 1º
  `require(script.Parent...)`, padrão de sempre) e `init.server.luau` (erra
  na 1ª linha que toca `game:GetService`) — confirma que todo o código novo,
  incluindo `handleResyncResult`/`onResyncRequest`/`setResyncState`,
  compilou sem erro de sintaxe. **Nada testado em Studio real** — depende de
  `ui-dev` (visual do botão/estado/Toast.show) e `extension-dev`
  (resyncRequest/resyncResult/modal de confirmação) terminarem a parte deles
  antes de um roteiro fim-a-fim fazer sentido. Não escrevi roteiro de teste
  aqui (nem em DECISIONS.md/PROJECT_STATUS.md) por pedido explícito do
  orquestrador — ele consolida depois de ler os 3 agentes juntos.

## Logger: `print()` removido do Output para log/notify/debug (unificado com debug); 2 prints crus de `sendMessage` tratados de forma ASSIMÉTRICA, 2026-08-02 (4ª tarefa do dia)

- **Pedido literal "retirar todos" não significa tratar todo print
  igual** — o valor desta tarefa esteve em diferenciar por FREQUÊNCIA REAL
  de disparo, não só por "é log ou é erro". `render()` em
  `plugin/src/Logger.luau` perdeu o `print(prefix, ...)` incondicional (só
  `Logger.debug`, desde 2026-07-16, já não imprimia; agora nenhum dos três —
  `log`/`notify`/`debug` — imprime). Parâmetro renomeado `shouldPrint` →
  `trackPanel` porque, pós-mudança, ele só controla se a mensagem alimenta
  `lastMessageText`/`lastMessageAt` (linha INFO do painel) — não tem mais
  NENHUMA relação com Output, manter o nome antigo seria enganoso. WS forward
  (`sendMessage`) e toast (`onNotify`) continuam incondicionais, intocados.
- **Os 2 `print()` crus de `init.server.luau` (`sendMessage`, fora do Logger
  por causa de recursão) foram avaliados INDIVIDUALMENTE, não como par** —
  a tarefa sugeria manter os dois ("caminho raro de erro genuíno"), mas
  reler o resto do arquivo (`start()`/`stop()` amarram
  `SourceWatcher`/`TeamCreateElection`/`TeamCreateLease`/`TeamCreatePresence`
  ao MESMO ciclo de vida do cliente WS, ver `runConnection`) revelou que o
  branch "descartado (sem conexão): `<kind>`" (`client == nil`) dispara a
  CADA mensagem espontânea de QUALQUER módulo (`sourceChanged`,
  `presenceUpdate`, `leaseChanged`, `scriptAdded`...) enquanto a sessão Team
  Create roda sem a extensão VS Code conectada — cenário nada raro (extensão
  ainda não aberta, qualquer janela de reconexão com colega ativo do outro
  lado). Isso o desqualifica como "erro raro"; é o mesmo padrão
  "rotineiro/alta frequência" que o resto da tarefa suprimiu. REMOVIDO.
  Já o branch "falha ao enviar: `<err>`" (`client:Send()` lança apesar de
  `client` parecer vivo) é de fato raro/genuíno e é o ÚNICO canal restante
  para essa falha exata — MANTIDO como print cru, sem mudança.
- **Por que não virou `Logger.debug` em vez de deletado**: quando
  `client == nil`, o encaminhamento por WS já está indisponível POR
  DEFINIÇÃO nesse exato instante — rotear a notícia do drop por
  `Logger.debug` não ganharia observabilidade nenhuma (nada para encaminhar
  agora mesmo) e ainda reintroduziria uma recursão (bounded, mas
  desnecessária) através de `render()`. Deletar de vez é estritamente mais
  simples e sem perda. Padrão a repetir: antes de propor "rebaixar para
  debug" como meio-termo em qualquer decisão parecida, perguntar se o canal
  alternativo (aqui, WS) está de fato disponível no exato momento do evento
  — se não estiver, debug e delete são equivalentes em efeito, e delete é
  mais simples.
- **Achado sobre a recursão em si (útil se mexer aqui de novo)**: o branch
  "sem conexão" JÁ tinha um guard `if message.kind ~= "log" then` que
  limitava qualquer recursão via `Logger.log` a 1 nível (a mensagem de
  "descartado" gerada pelo próprio Logger, ao tentar se auto-encaminhar,
  bate nesse guard e para). O branch "falha ao enviar" NÃO tem esse guard —
  aplica a QUALQUER mensagem que falhe o `:Send()`, inclusive uma futura
  mensagem de log sobre a própria falha — por isso É o branch onde rotear
  por `Logger` seria genuinamente perigoso (sem teto natural), e é
  exatamente por isso que só ele precisa continuar como print puro.
- **Domínio respeitado, não editado**: `plugin/src/ui/PluginUI.luau`
  (~linha 181) e `plugin/src/ui/StatusPanel.luau` (~linha 475) têm
  comentários que agora estão FACTUALMENTE errados ("o log no Output já
  aconteceu...", "o log no Output NUNCA é condicionado a isso") — o
  comportamento FUNCIONAL que descrevem não mudou (toast sempre dispara
  independente da preferência), só a palavra "Output" ficou obsoleta.
  Sinalizado em `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md` para
  `ui-dev`/orquestrador corrigir — não tocado aqui por ser arquivo de
  `plugin/src/ui/` (domínio de `ui-dev`, não `luau-dev`).
- **Não tocado, fora do escopo pedido (registrado por transparência)**: o
  pcall interno de `Logger.notify` ("falha ao notificar UI: `<err>`", linha
  final da função) continua print cru — mesma classe de raciocínio do print
  mantido em `init.server.luau` (erro raro do próprio mecanismo, sem canal
  alternativo no instante da falha), mas a tarefa original só mencionou
  `render()` e os 2 prints de `sendMessage`. Se aparecer um pedido de "zero
  prints, sem NENHUMA exceção" no futuro, este é o próximo candidato.
- **Validado por `selene plugin/src` (0 errors, 37 warnings — baseline
  idêntica, nenhum warning novo), `stylua --check` (limpo) e `lune run`**
  nos 2 arquivos tocados (`Logger.luau` roda INTEIRO sem erro — não toca
  `game` em nível de módulo, diferente da maioria dos módulos do plugin;
  `init.server.luau` erra só na 1ª linha que toca `game`, padrão de sempre).
  **Nada testado em Studio real** — fica `[Hipótese]`, roteiro de 5 passos
  em `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md`, entrada 2026-08-02 "(4ª
  rodada, mais recente)".
- **Nota de processo**: `docs/PROJECT_STATUS.md`/`docs/DECISIONS.md` já
  tinham sido editados por OUTRA sessão em paralelo nesta mesma data (linha
  "Última atualização" e topo do arquivo mudaram entre minha 1ª e 2ª leitura)
  — reli os dois arquivos por completo imediatamente antes de inserir minha
  entrada, para inserir no topo certo e não sobrescrever trabalho concorrente.
  Rebaixei o marcador "(3ª rodada, mais recente)"/"(mais recente)" das
  entradas anteriores para simples "(3ª rodada)"/sem sufixo, já que minha
  entrada nova assumiu o topo — mesmo padrão que essas entradas já usavam
  entre si. Referências antigas em OUTRAS partes do arquivo que citam o texto
  literal "(3ª rodada, mais recente)" como âncora ficaram levemente
  desatualizadas (apontam pro título como era quando escritas) — não persegui
  corrigir cada citação histórica, é churn de baixo valor num changelog
  append-only.

## Bug confirmado e corrigido: ordem de operações na conversão Folder→ModuleScript derrubava o watch de Source dos filhos, 2026-08-02 (3ª tarefa do dia)

- **Fecha o "achado real (NÃO CORRIGIDO)" registrado na entrada logo abaixo,
  desta mesma data** — o `researcher` confirmou a hipótese com fonte oficial
  (`.claude/research/2026-08-02-reparent-descendantremoving-semantics.md`,
  `Roblox/creator-docs`, `Instance.yaml`): `DescendantRemoving` "fires
  immediately before the parent Instance changes such that a descendant
  instance will no longer be a descendant" — bate exatamente com o código
  antigo, que reparentava cada `oldChild` pra dentro de uma `newInstance`
  ainda SEM `Parent` (só anexada à árvore no final). Cada `oldChild` de fato
  deixava de ser descendente da raiz observada, mesmo que momentaneamente —
  disparando `unwatchScript` incorretamente via `scanAndWatch`'s
  `DescendantRemoving`. A reconexão via `DescendantAdded` no final NÃO tinha
  garantia oficial (só relato de fórum, não staff, com ressalva explícita de
  "não garantido").
- **Fix em `plugin/src/SourceWatcher.luau`** (dentro do `pcall` de
  conversão, ramo Folder→Script/LocalScript/ModuleScript de
  `resolvePath`): inverter a ordem — `newInstance.Parent = current` roda
  ANTES do loop `for _, oldChild in child:GetChildren() do oldChild.Parent =
  newInstance end`, não depois. Com `newInstance` já dentro da árvore
  observada, cada `oldChild.Parent = newInstance` vira um reparent DIRETO
  dentro da MESMA árvore já observada — nunca deixa de ser descendente da
  raiz, então não dispara `DescendantRemoving` nenhum. Efeito colateral bom:
  isso elimina de vez a dependência do comportamento não-garantido de
  `DescendantAdded` para reconectar os filhos — a conexão de sinal
  (`watched[oldChild]`) e o registro em `ScriptRegistry` de cada filho nunca
  são tocados, sobrevivem intactos, sem precisar de nenhum re-watch.
- **Trade-off aceito e documentado no código**: mais eventos de replicação
  Team Create (newInstance entra vazia na árvore primeiro, depois cada
  filho reparenta individualmente — N+2 eventos em vez de 2 na ordem
  antiga, que montava tudo fora da árvore e anexava de uma vez só). A ordem
  antiga era deliberadamente mais econômica em replicação (decisão de
  2026-07-26) — esta correção prioriza corretude sobre esse ganho, porque a
  ordem antiga estava simplesmente errada (perdia o watch de Source dos
  filhos, não só "gastava mais rede").
- **Interação pré-existente que a reordenação NÃO introduz nem piora**
  (documentada em comentário no código, deliberadamente não corrigida —
  fora do escopo desta tarefa): se `SignalBehavior` for `Immediate`,
  `DescendantAdded` do root pode disparar `watchScript(newInstance)` ->
  `ScriptRegistry.resolveOrAllocate` de forma SÍNCRONA, dentro do próprio
  `pcall`, alocando um uuid novo pra `newInstance` ANTES de
  `ScriptRegistry.reassignInstance(existingUuid, ...)` rodar (que só roda
  DEPOIS que o `pcall` inteiro retorna). Isso já era verdade na ordem antiga
  também (só que a chance disparava no FIM do `pcall`, em vez do INÍCIO,
  já que `newInstance.Parent = current` sempre esteve dentro do mesmo
  `pcall`) — não é uma regressão desta tarefa. Continua dormant hoje porque
  `existingUuid` é sempre `nil` na prática atual (uma `Folder` pura nunca é
  registrada no `ScriptRegistry` — só `LuaSourceContainer` é). Se
  `existingUuid` deixar de ser sempre `nil` no futuro (e algum lugar passar
  a registrar Folders), revisitar: `reassignInstance` sobrescreve
  `uuidByInstance[newInstance]` corretamente, mas o registro criado por
  `resolveOrAllocate` para o uuid novo (efêmero) ficaria orfão em
  `recordByUuid` (vazamento, não crash).
- **Padrão a levar pra qualquer análise futura de reparent+observação por
  `DescendantAdded`/`DescendantRemoving`**: a definição oficial é sobre
  RELAÇÃO DE DESCENDÊNCIA COM A RAIZ OBSERVADA, não sobre "a Instance mudou
  de posição". Um reparent de A pra B onde AMBOS já são descendentes da
  mesma raiz observada nunca deveria disparar nenhum dos dois eventos nessa
  raiz (a relação de descendência nunca se rompe) — só dispara quando o
  destino intermediário (ou final) está FORA da árvore observada no momento
  exato da atribuição, mesmo que seja só um instante (`Instance.new(...)`
  ainda sem `Parent` conta como "fora"). Ao escrever qualquer lógica nova de
  "montar fora da árvore, anexar depois" pra minimizar replicação, checar
  primeiro se algum observador (sinal, sub-processo do próprio código)
  depende de continuidade de descendência durante a montagem — se depender,
  inverter pra "anexar primeiro, montar depois" é o fix correto, não um
  patch alternativo.
- **Validação**: `selene plugin/src` -> `0 errors, 37 warnings, 0 parse
  errors` (baseline idêntica à da tarefa anterior, nenhum warning novo em
  `SourceWatcher.luau`). `stylua --check plugin/src/SourceWatcher.luau` sem
  diffs. `lune run plugin/src/SourceWatcher.luau` erra só na linha 25
  (`game:GetService`, 1ª linha que toca `game`, padrão de sempre) —
  confirma que o resto do arquivo, incluindo o bloco de conversão editado,
  compila sem erro de sintaxe. **Nada testado em Studio real** — fica
  `[Hipótese]` corrigida por raciocínio de engine confirmado por pesquisa
  oficial (alta confiança na causa e no mecanismo do fix, já que é dedução
  direta da definição textual do `DescendantRemoving` aplicada à ordem real
  do código), pendente de confirmação em Studio real. Roteiro de 4 passos
  em `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md`, entrada 2026-08-02 mais
  recente — exige só 1 Studio (sem Team Create), passo decisivo é editar o
  `Source` de um filho que já vivia na pasta ANTES da conversão, DEPOIS de
  convertida, e confirmar que a propagação continua.

## Preservação de UUID na conversão Folder→ModuleScript + settings por-place + achado sobre reparent em massa, 2026-08-02 (2ª tarefa do dia)

- **`ScriptRegistry.reassignInstance(uuid, newInstance)`** (novo): reatribui
  um uuid JÁ EXISTENTE no registry para uma Instance nova (atualiza
  `InstanceRef.Value` + os 2 mapas em memória `uuidByInstance`/
  `recordByUuid`), sem alocar uuid novo. Conectado em
  `SourceWatcher.resolvePath` no ramo de conversão Folder→Script (existente
  desde 2026-07-26): captura `ScriptRegistry.getUuid(child)` ANTES de
  `child:Destroy()`; se não-nil, reaproveita. **Honestidade importante**:
  hoje uma `Folder` pura NUNCA tem uuid registrado (só `LuaSourceContainer`
  é registrado via `isInstanceWatchable`/`watchScript`) — então
  `existingUuid` é sempre `nil` na prática atual, o comportamento observável
  não muda, e este é um fix DEFENSIVO/futuro-prova, não a correção de um bug
  reprodutível hoje. Documentado assim, sem inflar a tarefa como "corrigiu
  bug X" quando na verdade é proteção preventiva pedida explicitamente pelo
  usuário ("preservar o uuid existente na conversão").
- **Achado real durante a análise — CORRIGIDO na mesma data, entrada nova no
  topo deste arquivo ("Bug confirmado e corrigido: ordem de operações...")
  depois que o `researcher` validou a hipótese abaixo com fonte oficial.**
  Texto original da hipótese preservado como registro histórico: relendo
  `resolvePath`'s ramo de conversão, o reparent dos filhos
  (`oldChild.Parent = newInstance`, com `newInstance` AINDA FORA da árvore
  — só é anexada com `.Parent = current` DEPOIS de todos os filhos já
  movidos, decisão deliberada de 2026-07-26 pra minimizar eventos de
  replicação) dispara `DescendantRemoving` no root observado PRA CADA
  filho — e o handler de `DescendantRemoving` de `scanAndWatch` JÁ existe e
  RODA para eles (`if watched[descendant] ~= nil then ... unwatchScript(descendant) end`),
  desconectando o sinal de Source e removendo da tabela `watched` (usada
  pelo `pollLoop`). Se `DescendantAdded` NÃO re-registrar cada descendente
  individualmente quando a subárvore inteira é anexada de volta (só a
  própria `newInstance`, por exemplo — não confirmado como o Roblox se
  comporta pra reparent em massa de subárvore já populada), os filhos
  ficariam PERMANENTEMENTE fora do polling/sinal de Source pelo resto da
  sessão (delete continuaria detectável via `checkRegistryDrift`, que varre
  o registry inteiro, não só `watched` — só a detecção de EDIÇÃO de Source
  pararia). Isto contradiz a afirmação do comentário de 2026-07-26 ("filhos
  reparentados... continuam válidos sem nenhuma limpeza extra") — aquele
  comentário está certo sobre a CONEXÃO de sinal em si sobreviver ao
  reparent (não se importa com árvore), mas não considerou que
  `DescendantRemoving` dispararia e acionaria `unwatchScript` de qualquer
  jeito. **Próximo passo se isto for investigado**: `researcher` confirma a
  semântica exata de `DescendantAdded`/`DescendantRemoving` pra reparent em
  massa (dispara por descendente ou só pro nó movido?) antes de qualquer
  fix — ver `docs/DECISIONS.md` 2026-08-02 (3ª rodada, continuação seção 2)
  pro roteiro de teste manual sugerido (editar Source de um filho já
  sincronizado DEPOIS de converter a pasta-pai em `init.luau`, confirmar que
  ainda propaga).
- **Contrato de protocolo (pedido explícito da tarefa, decisão registrada em
  `docs/DECISIONS.md`)**: decidido reaproveitar `scriptAdded` (mensagem já
  existente) em vez de criar `scriptClassChanged` ou reusar `scriptMoved`.
  Raciocínio central: um sinal NOVO só ajudaria o Studio que INICIOU a
  conversão (via seu próprio `writeSource`, que já sabe o que pediu) — mas o
  colaborador afetado pelo bug de duplicação relatado pelo usuário é o
  OUTRO Studio, que nunca chama `resolvePath` (só observa a conversão via
  replicação Team Create + seu próprio `scanAndWatch`/`DescendantAdded`,
  IGUAL a qualquer script novo) — um sinal que só um dos dois lados recebe
  não resolve o problema relatado. `scriptMoved` está semanticamente errado
  (implica mesmo uuid/Instance, path mudou — aqui o path é IDÊNTICO na
  maioria dos casos, é a Instance/classe que muda). Recomendação passada
  pra frente (não implementada, é tarefa de `extension-dev`): tratar
  `scriptAdded` pra um path que já tem filhos mapeados como promoção
  pasta→módulo, removendo qualquer arquivo-folha órfão de uma representação
  anterior — inferível só com os campos já existentes (`uuid`/`path`/
  `className`), sem precisar de campo novo de protocolo.
- **Settings por-place (`Config.luau`)**: `plugin:GetSetting`/`SetSetting` é
  GLOBAL à instalação do Studio — não existe API por-place. Padrão adotado:
  UM slot `GetSetting` (`PLACE_SETTINGS_KEY`) guardando
  `{[tostring(game.PlaceId)] = {chave -> valor}}`; toda leitura/escrita
  resolve `game.PlaceId` NA HORA da chamada (nunca recebido como parâmetro).
  3 funções: `getPlaceSettings(pluginObject)` (tabela inteira, mesclada com
  `PLACE_SETTINGS_DEFAULTS`), `getPlaceSetting(pluginObject, key)` (uma
  chave, `nil` se desconhecida), `setPlaceSetting(pluginObject, key, value)`
  (`ok, err` — read-modify-write do slot INTEIRO, preserva outras chaves do
  mesmo place e sub-tabelas de OUTROS places; `value == nil` remove a
  chave). Validação genérica por TIPO do default (não hardcoded por nome de
  chave — extensível): `value` precisa bater `type(default)`, e se for
  `number`, precisa ser `> 0`. **Padrão a repetir** se o projeto precisar de
  mais settings por-place no futuro: nunca dar `SetSetting` direto no call
  site pra uma setting por-place (ao contrário do padrão de settings
  GLOBAIS existentes, que fazem `pluginObject:SetSetting` direto em
  `init.server.luau`/`PluginUI.luau`) — o read-modify-write do mapa inteiro
  PRECISA ficar centralizado em `Config.luau`, senão qualquer call site que
  esqueça de ler o mapa completo antes de escrever apaga silenciosamente as
  settings de OUTROS places/chaves.
- **Escopo deliberadamente NÃO feito**: nenhum loop de runtime
  (`SourceWatcher.pollLoop`/`TeamCreatePresence.checkPresenceDrift`) foi
  alterado pra LER as novas settings — continuam com
  `Config.POLL_INTERVAL_SECONDS` fixo. As settings expostas são
  "decorativas" até uma tarefa futura fazer esses loops consultarem
  `Config.getPlaceSetting` (não trivial: precisa de um jeito de reiniciar o
  loop quando o valor muda em runtime, não investigado). Também não
  construída: a tela em `StatusPanel.luau` (`ui-dev`).
- **Validação**: `selene plugin/src` → 0 errors/37 warnings (baseline
  mantida — 1 warning novo de `manual_table_clone` apareceu e foi corrigido
  com `table.clone` antes do relatório final). `stylua --check` limpo sem
  precisar reformatar nada. `rojo build` (via
  `Tools/build-and-deploy-plugin.ps1`, `OK - plugin implantado`) + `lune
  run` nos 3 arquivos tocados sem erro de sintaxe (erro esperado só na 1ª
  linha que toca `game`, exceto `Config.luau` que não toca `game` em nível
  de módulo — nesse caso `lune run` roda sem NENHUM erro, confirmando o
  módulo inteiro carrega limpo). **Nada testado em Studio real** — ambos os
  itens ficam `[Hipótese]`, roteiros completos em `docs/DECISIONS.md`
  2026-08-02 (3ª rodada, continuação).

## Selene (linter novo, `selene.toml` na raiz): 3 `unused_variable` corrigidos, 2026-08-02

- **Comando confirmado**: `selene plugin/src` (binário em `~/.rokit/bin/selene.exe`,
  já no PATH). **Exit code é sempre 1 mesmo só com warnings** — nunca julgar
  sucesso/falha pelo exit code, sempre ler o resumo final `"X errors, Y
  warnings, Z parse errors"` no output.
- **3 fixes, sem mudar lógica**: (1) `TeamCreateSchema.luau` — removi de vez
  `local log = Logger.log` (linha ~89): confirmado por grep que `log(...)`
  nunca é chamado nesse arquivo (o módulo só usa `Logger.notify` direto, ver
  comentário "M4.5: toast-worthy" já existente perto de `getOrCreate`). (2)
  `TeamCreateLease.luau`, dentro de `checkLeaseDrift()` (~linha 574) — o
  closure passado a `ScriptRegistry.forEach` tinha assinatura
  `function(uuid, instance, storedPath)` mas só `uuid` era usado no corpo;
  virou `function(uuid)`.
- **Decisão de técnica: REMOVER, não renomear com `_`/`_nome`** — escolhida
  em vez do prefixo `_` porque (a) não achei NENHUM precedente no projeto de
  parâmetro/local nomeado `_algo` (só o uso padrão de Lua `for _, x in
  ipairs(...)` para descartar índice, que já é convenção deste repo mas não
  é o mesmo caso — aqui os 2 params extras não tinham motivo de existir); e
  (b) confirmei em `ScriptRegistry.forEach` (`plugin/src/ScriptRegistry.luau`,
  linha ~298) que a chamada é `callback(entry.uuid, entry.instance,
  entry.storedPath)` — Lua/Luau não exige aridade igual entre callback
  declarado e args passados (args extras não usados na declaração são só
  descartados), então remover parâmetros TRAILING não usados de um closure é
  sempre seguro e não muda nenhum comportamento, mesmo se o chamador continuar
  passando mais argumentos do que o closure declara. Regra geral pro
  projeto: quando o warning for de parâmetro TRAILING de closure passado a
  uma função de ordem superior própria do projeto (não uma API do Studio com
  assinatura fixa), preferir remover a assinatura em vez de prefixar com `_`
  — mais limpo, sem introduzir uma convenção nova sem precedente.
- **Validado**: `selene plugin/src` depois do fix -> `0 errors, 37 warnings,
  0 parse errors`; nenhum `unused_variable` nem menção a
  `TeamCreateSchema`/`TeamCreateLease` sobrou no output (confirmado via grep
  no output). Os 37 warnings restantes são todos `roblox_manual_
  fromscale_or_fromoffset`/`mixed_table` em `plugin/src/ui/Toast.luau` e
  `plugin/src/ui/StatusPanel.luau` — fora de escopo desta tarefa (área de
  UI/`ui-dev`, não tocada).
- **Nota de processo**: durante a edição, `Edit` avisou que
  `TeamCreateSchema.luau` "foi modificado no disco desde a última leitura" —
  investiguei antes de prosseguir (havia uma outra sessão Claude Code rodando
  em paralelo no mesmo repo nesta data). Reli o arquivo inteiro: a única
  diferença era a chamada `Logger.notify(...)` reformatada de 1 linha para
  multi-linha (cosmético, provavelmente algum formatter/hook externo rodando
  em paralelo — não StyLua deste agente, que não foi invocado aqui) — nenhuma
  lógica mudou, e o arquivo não constava na lista de arquivos da outra sessão.
  Segui a edição normalmente. Lição: esse aviso do `Edit` vale a pena
  investigar (reler o arquivo) sempre que houver risco real de sessão
  paralela mexendo na mesma área, mas não é motivo automático para abortar —
  só para conferir antes de prosseguir.

## `watchedRoots` — plugin consome a lista dinâmica de Services da extensão em vez de só a tabela fixa, 2026-07-29

- **Tarefa com contrato JÁ FECHADO e exaustivo em `docs/DECISIONS.md`**
  (entrada 2026-07-29, escrita por outra sessão especificamente para esta
  tarefa) — não precisei re-derivar nada do lado da extensão, só ler essa
  entrada + a doc inline de `WatchedRootsMessage` em
  `vscode-extension/src/protocol.ts`. Padrão de processo a repetir: quando o
  orquestrador já deixou um contrato assim, a implementação é bem mais rápida
  só lendo o contrato + o código real dos arquivos afetados, sem precisar
  abrir `SyncTeamService.ts` inteiro.
- **Arquitetura escolhida (3 arquivos)**: `Config.luau` ganha
  `Config.setDynamicWatchedRoots(names) -> invalidNames` (resolve cada nome
  via `game:GetService` em `pcall`, substitui inteiramente uma variável
  module-level `dynamicRoots`, `nil` até a 1ª chamada) e
  `Config.getWatchedRoots()` passa a devolver a UNIÃO (dedupe por identidade
  de Instance — Services são singletons, `game:GetService(mesmoNome)` sempre
  devolve a MESMA Instance, então `seen[root]` funciona entre chamadas
  diferentes) da lista fixa com `dynamicRoots`, quando não-nil. `Config` em
  si NUNCA loga (mantive o módulo livre de `require(Logger)` — não há
  circular dependency real ali, mas não havia necessidade; o chamador loga os
  nomes inválidos devolvidos). `SourceWatcher.luau`: extraí `scanAndWatch`
  (antes uma closure local DENTRO de `start()`, capturando `myToken`) para
  função module-level `scanAndWatch(root, myToken)`, guardada por um `Set`
  novo `scannedRoots` (Instance → true, `table.clear`ado em `stop()`) que a
  torna idempotente por root — permite chamar de novo sem duplicar
  `DescendantAdded`/`DescendantRemoving`. Nova função pública
  `SourceWatcher.applyWatchedRoots(names)` chama
  `Config.setDynamicWatchedRoots`, loga nomes inválidos, e escaneia só os
  roots de `Config.getWatchedRoots()` (já a união) que `scannedRoots` ainda
  não cobre. `init.server.luau`: novo case `"watchedRoots"` no dispatch de
  `handleMessage`, mesmo padrão aditivo de `ping`/`deleteScript` (comentário
  explícito de "não bumpa PROTOCOL_VERSION"), valida `type(message.roots) ==
  "table"` antes de repassar.
- **Decisão de timing (a escolha mais delicada da tarefa, avaliada
  explicitamente entre 2 opções no contrato)**: escolhi NÃO atrasar o scan
  inicial de `start()` esperando `watchedRoots` (rejeitei introduzir um
  timeout novo) — em vez disso, `start()` continua escaneando
  `Config.getWatchedRoots()` na hora (fixa, ou dinâmica de uma reconexão
  anterior desta sessão), e quando `watchedRoots` chega (mais tarde, via
  `handleMessage`), `applyWatchedRoots` só ADICIONA os containers novos.
  Justificativa central: o handler inteiro (`Config.setDynamicWatchedRoots` +
  `scanAndWatch` dos roots novos: `GetDescendants`/`Instance.new`/`:Connect`)
  é 100% síncrono, SEM NENHUM `task.wait`/yield no caminho — então o
  processamento da mensagem `watchedRoots` termina por completo antes do
  handler retornar, e como o resto do dispatch de `handleMessage` já assume
  que mensagens WS são processadas até o fim antes da próxima (mesma premissa
  usada por `connectionRejected` antes do close), o `listScripts` que a
  extensão manda LOGO DEPOIS do `watchedRoots` já reflete os containers
  novos — sem precisar de nenhuma fila/lock/timeout adicional. Atrasar o scan
  inicial (opção alternativa) arriscaria travar a conexão inicial esperando
  uma mensagem que uma extensão mais velha nunca vai mandar; não valia o
  ganho, já que o caso comum (mount point em Service já fixo) nem precisa da
  mensagem para funcionar.
- **Decisão de UNIÃO, não substituição total** (diferença deliberada do texto
  literal do contrato, "em vez da tabela fixa" — justificada em
  DECISIONS.md): a lista fixa NUNCA é removida quando a dinâmica chega, só
  complementada. Motivo: remover um container já observado arriscaria
  "esquecer" scripts com uuid/lease já ativos só porque o
  `default.project.json` no momento exato da mensagem não referencia mais
  aquele Service — risco desnecessário pro problema real (containers
  FALTANDO, nunca sobrando). Escanear 1-2 Services fixos a mais que o
  estritamente necessário é praticamente grátis.
- **Pegadinha evitada por design**: `scannedRoots` é chaveado pela própria
  Instance do Service (não pelo nome), e como `game:GetService(nome)` sempre
  devolve a MESMA Instance (singleton), tanto o dedupe de
  `Config.getWatchedRoots()` quanto o guard de idempotência de `scanAndWatch`
  funcionam corretamente entre chamadas separadas no tempo (scan inicial vs.
  `applyWatchedRoots` chamado minutos depois) sem precisar comparar por nome
  de string em lugar nenhum.
- **Validado só por `rojo build` (via `Tools/build-and-deploy-plugin.ps1`,
  `OK - plugin implantado`) + `lune run`** nos 3 arquivos tocados
  (`Config.luau`, `SourceWatcher.luau`, `init.server.luau`) — sem erro de
  sintaxe (erro esperado só na 1ª linha que toca `game`, mesma disciplina de
  sempre). **Nada testado em Studio real nesta tarefa** — o cenário que
  motivou tudo isso (mount point novo em Service fora da lista fixa antiga,
  ex. `ReplicatedFirst/First`, sincronizando sem editar `Config.luau` à mão)
  fica `[Hipótese]`, roteiro de 4 passos em `docs/DECISIONS.md`/
  `docs/PROJECT_STATUS.md` (entrada 2026-07-29), pendente do usuário validar.

## Mitigação de undo (Ctrl+Z) destruindo instances de coordenação, 2026-07-26

- **Não existe API oficial pra excluir uma Instance do `ChangeHistoryService`
  do usuário** (pesquisa completa em
  `.claude/research/2026-07-26-changehistoryservice-undo-exclusion.md`,
  ler antes de tocar nesta área de novo). `SetEnabled(false)` desliga
  GLOBAL e LIMPA o histórico (inviável); `TryBeginRecording`/
  `FinishRecording` fazem o OPOSTO (tornam algo deliberadamente
  undo-ável — é o que o Rojo real usa para os próprios patches). Mitigação
  de 2 camadas, nenhuma garantida: (1) `instance.Archivable = false`
  gravado ANTES de `.Parent` em toda Instance criada sob
  `TestService.SyncTeam` — best-effort, relato de comunidade não
  confirmado por staff; (2) self-healing reativo via
  `ChangeHistoryService.OnUndo`/`OnRedo` (eventos oficiais, só entregam o
  NOME da ação desfeita como string, nunca quais instances — não dá pra
  ser seletivo, só reagir com uma checagem de integridade ampla).
- **Achado que muda o escopo real de qualquer bug parecido no futuro**:
  mudanças em `Script`/`LocalScript`/`ModuleScript.Source` são confirmadas
  por staff da Roblox (abr/2026, "Working as Designed") como NUNCA
  capturadas pelo `ChangeHistoryService` — Ctrl+Z do usuário NUNCA reverte
  código sincronizado pelo SyncTeam. Qualquer bug relatado como "undo
  quebrou o SyncTeam" só pode vir da árvore de metadados
  (`TestService.SyncTeam`), nunca do `Source` em si — não perder tempo
  investigando o caminho de escrita de Source quando esse sintoma aparecer.
- **Módulo novo `plugin/src/TeamCreateUndoGuard.luau`**: conecta
  `ChangeHistoryService.OnUndo`/`OnRedo` (cada um em `pcall`) 1x no boot de
  `init.server.luau`, FORA de `start()`/`stop()` (precisa escutar
  independente do plugin estar conectado — Ctrl+Z pode acontecer a
  qualquer momento com a place aberta). Debounce deliberadamente simples:
  só `task.defer` por disparo (coalesce rajadas de undo seguidos), sem
  fila/tempo — justificativa: `checkIntegrity()` de cada módulo já é barata
  e idempotente (na maioria das vezes só um `FindFirstChild`/checagem de
  `Parent` que não faz nada), então disparos redundantes são inofensivos.
  Orquestra `checkIntegrity()` de 3 módulos, cada chamada em `pcall`
  individual (uma falha não impede as outras), MESMA ordem de dependência
  que `init.server.luau` `start()` já usa (Election antes de Lease/
  Presence, porque `getSessionFolder()` depende da sessão já existir).
- **Padrão de `checkIntegrity()` — reaproveitar lógica de criação
  existente, nunca duplicar**: `TeamCreateElection.checkIntegrity()`
  chama a mesma `ensureOwnSession()` privada já usada em `start()`, só
  precedida do mesmo refresh de containers que `tick()` já faz a cada
  pulso (`TeamCreateSchema.ensureRoot()`/`ensureFolder("Sessions")`).
  `TeamCreateLease`/`TeamCreatePresence.checkIntegrity()` forçam
  `leasesFolder`/`sessionsFolder = nil` (invalida o guard de cache-once
  `if leasesFolder ~= nil then return end`) antes de chamar
  `ensureContainers()` de novo — não precisou tocar a assinatura dessas
  funções privadas nem duplicar a lógica de criação de Folder/Values.
- **Bug latente PRÉ-EXISTENTE encontrado e corrigido como efeito colateral
  desta tarefa, não só especulação sobre undo**: `TeamCreateLease.luau` e
  `TeamCreatePresence.luau` cacheiam `leasesFolder`/`sessionsFolder`/
  `rootValues` 1x em `ensureContainers()` (guard `if X ~= nil then return
  end`) e NUNCA os refazem depois — esse gap já estava documentado como
  "risco residual aceito" na entrada de 2026-07-07 deste mesmo arquivo
  (split-brain de liderança), mas nunca tinha sido corrigido porque, até
  agora, só a eleição de líder (`TeamCreateElection.tick()`) tinha esse
  refresh contínuo. Isso significa que QUALQUER destruição dessas pastas
  raiz (não só por undo — reconciliação de duplicata de
  `TeamCreateSchema.getOrCreate` também as substitui via `Destroy()` da
  cópia perdedora) deixaria esses dois módulos presos numa referência morta
  pelo resto da sessão do plugin, ANTES desta correção. `checkIntegrity()`
  agora cobre isso, mas só é DISPARADO por undo/redo — se algum bug futuro
  aparecer fora de um cenário de Ctrl+Z (ex.: reconciliação de duplicata
  destruindo `Leases`/`Sessions` do lado "perdedor"), vale considerar
  chamar `checkIntegrity()` também de outros gatilhos (ex.: periodicamente,
  não só reativo a undo).
- **Decisão de escopo deliberada, não descuido**: só os 3 módulos
  explicitamente citados na tarefa (Election/Lease/Presence) ganharam
  `checkIntegrity()` dedicado. `ScriptRegistry.luau` (`Scripts/<uuid>`) e
  `TeamCreateSchema.luau` (root/`ROOT_VALUES`) ganharam só a camada 1
  (`Archivable = false`) — `ScriptRegistry` porque a resolução uuid→Instance
  já sobrevive à destruição da pasta de metadados NESTE Studio (o mapa em
  memória `recordByUuid[uuid].instance` guarda a referência direta,
  independente da árvore de `Folder`/`ObjectValue` sob
  `TestService.SyncTeam` sobreviver) — só a REPLICAÇÃO da identidade para
  outro Studio que ainda não a viu ficaria comprometida; `TeamCreateSchema`
  porque já tem reconciliação contínua via `TeamCreateElection.tick()` a
  cada 2s (não fica sem proteção nenhuma, só sem gatilho dedicado a undo).
  Documentado como risco residual aceito em ambos os arquivos/DECISIONS.md
  — revisitar se undo destruindo `Scripts/<uuid>` aparecer como problema
  real em teste teste com múltiplos Studios.
- **Validado só por `rojo build` + `lune run`** nos 7 arquivos (5 editados +
  `TeamCreateUndoGuard.luau` novo + `init.server.luau`) — sem erro de
  sintaxe, erro esperado só na 1ª linha que toca `game`/`script.Parent`
  (`TeamCreateUndoGuard.luau` para na linha do `game:GetService`, mesmo
  padrão de todo módulo novo do projeto). Buildado e implantado via
  `Tools/build-and-deploy-plugin.ps1` (`OK - plugin implantado`). **Nada
  testado em Studio real** — mitigação de undo por definição exige apertar
  Ctrl+Z de verdade dentro do Studio (ação física, fora do alcance de
  `Tools/`). Fica `[Hipótese]`, roteiro de 6 passos em `docs/DECISIONS.md`
  2026-07-26 (inclui: apagar `Sessions/<clientId>` pelo Explorer + Ctrl+Z,
  confirmar log "integridade: ... recriando" e que o plugin não trava;
  rajada de Ctrl+Z repetidos; confirmar que `Source` nunca é revertido por
  undo, validando o achado colateral da pesquisa).

## Bug real: `resolvePath` nunca comparava classe do child reusado no segmento final (Folder virando ModuleScript via `init.luau`), 2026-07-26

- **Padrão geral a vigiar em qualquer resolução de path que faz "reusa se
  existe, cria se não existe"**: `current:FindFirstChild(name)` que existe é
  SEMPRE reusado sem checar se a CLASSE bate com o que o chamador pediu —
  isso é uma armadilha silenciosa sempre que uma convenção de projeto permite
  uma Instance "virar" outra classe com o tempo (aqui: convenção Rojo, pasta
  ganha `init.luau` e a própria pasta vira o ModuleScript). Vale revisitar
  qualquer outro lugar do código que resolva/materialize path por
  `FindFirstChild` reusado cegamente se aparecer bug parecido no futuro.
- **Fix aplicado em `SourceWatcher.resolvePath`**: no segmento FINAL do path,
  se o child já existe, tem classe diferente de `createClassName` E não é já
  um `LuaSourceContainer` (guarda deliberada: só converte Folder-like, nunca
  um Script/LocalScript/ModuleScript de OUTRA classe — isso é conflito de
  verdade, fora de escopo), CONVERTE: `Instance.new(createClassName)`, copia
  `Name`, reparenta TODOS `child:GetChildren()` pra dentro da nova Instance,
  seta `Parent` da nova = `current`, só então `child:Destroy()`. Tudo dentro
  de 1 `pcall`, erro claro se falhar. Guard extra `index > 1` (nunca converte
  o 1º segmento, que é sempre um Service resolvido via `GetService` — proteção
  defensiva mesmo não sendo alcançável na prática, já que
  `Config.getWatchedRoots()` nunca produz path de 1 segmento só).
- **Por que os filhos reparentados não precisam de nenhuma limpeza/migração**:
  `ScriptRegistry`/`watched` (`SourceWatcher.luau`) são chaveados pela
  `Instance` (referência de objeto), nunca por path — reparentar não recria a
  Instance, então uuid/conexão de sinal/cache de dedupe dos filhos continuam
  válidos sem tocar em nada. E como a pasta convertida mantém o MESMO `Name` e
  o MESMO `Parent` (só troca de classe), o caminho canônico dos filhos
  (`SourceWatcher.pathFor`) nem muda de string — o próximo `checkRegistryDrift`
  não confunde isso com `scriptMoved`. Confirmado por leitura de código, não
  precisou tocar `ScriptRegistry.luau` (a Folder em si nunca foi registrada —
  só `LuaSourceContainer` é observado/registrado, via `isInstanceWatchable`/
  `watchScript`, ambos checam `IsA("LuaSourceContainer")` antes de qualquer
  coisa).
- **Ordem de operações escolhida na conversão**: montar a nova Instance FORA
  da árvore primeiro (Name, reparent dos filhos) e só DEPOIS atribuir
  `.Parent = current` (anexar à árvore), destruindo a Folder antiga por
  último. Minimiza eventos de replicação intermediários (Team Create só
  precisa replicar o estado final da subárvore de uma vez, não passos
  parciais) — mesmo princípio geral de "montar antes de anexar" já usado em
  outras partes do projeto para Instances novas.
- **Validado só por `rojo build` + `lune run`** em `SourceWatcher.luau` — sem
  erro de sintaxe (erro esperado só na linha que toca `game`, primeira linha
  do arquivo). Buildado e implantado via `Tools/build-and-deploy-plugin.ps1`.
  **Nada testado em Studio real nesta tarefa** — cenário exige criar arquivo
  novo via VS Code apontando pra pasta já materializada no Studio, fora do
  alcance de automação sem harness rodando nesta sessão. Fica `[Hipótese]` —
  roteiro de 4 cenários (Folder→ModuleScript com filhos, init.server/client,
  uuid correto pro colega via Team Create, não-regressão de pasta vazia
  ganhando init.luau) em `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md`,
  entrada 2026-07-26.

## `deleteScript` — plugin destrói Instance ao receber delete do VS Code (contrato fechado com extension-dev), 2026-07-20

- **Tarefa com contrato de protocolo JÁ FECHADO pelo orquestrador** (não
  inventado aqui): requisição aditiva `{kind="deleteScript", requestId, uuid}`
  (extensão -> plugin), resposta reusa `writeAck` (mesmo formato de
  `writeSource`). Trabalho irmão no lado extensão feito em paralelo pelo
  `extension-dev` na mesma sessão, mesmo contrato.
- **`handleDeleteScript` (`plugin/src/init.server.luau`, entre
  `handleWriteSource` e `handleReadSource`) é paralelo a `handleWriteSource`
  modo ATUALIZAÇÃO, na mesma ordem de checagens**: resolve por
  `SourceWatcher.resolveByUuid` -> bloqueia pasta vendorizada
  (`Config.isInsideExcludedPackageFolder`, mesma mensagem de erro adaptada
  para "delete bloqueado: ...") -> `TeamCreateLease.ensureIntent` +
  `TeamCreateLease.canWrite` (mesmo padrão de lease negada com
  `Logger.notify`) -> só então `pcall(function() instance:Destroy() end)`.
  Decisão de checar lease antes de deletar (a tarefa deixava em aberto):
  mantive a MESMA checagem que updates já fazem, por consistência e
  segurança — evita um dev destruir um script que outro está com lease ativa
  de edição no exato momento (a alternativa, permitir delete sem lease,
  abriria um jeito de apagar trabalho em andamento de outro sem arbitragem
  nenhuma).
- **Deliberadamente NÃO limpa `ScriptRegistry` nem emite `scriptRemoved`
  manualmente aqui** — o `checkRegistryDrift` que já existe desde o M2
  (`SourceWatcher.luau`, ciclo de poll a cada `Config.POLL_INTERVAL_SECONDS`)
  detecta a Instance destruída via `ScriptRegistry.isInstanceDestroyed`
  (`Parent == nil` + confirmação por `pcall`, nunca `ObjectValue.Value ==
  nil` — bug real documentado desde 2026-07-04) e emite `scriptRemoved`
  sozinho, pelo MESMO caminho que já cobre delete feito direto no Explorer do
  Studio — inclusive é o que propaga a remoção pro OUTRO dev via Team Create
  (o `Destroy()` replica, o Studio remoto detecta pelo próprio polling, o
  plugin dele manda `scriptRemoved` pra extensão dele). Duplicar essa lógica
  aqui seria reinventar um caminho já validado.
- **Log: mantive `Logger.log` (visível) pro sucesso E erro de delete**,
  diferente de `writeSource` update/create que a MESMA sessão (tarefa irmã de
  guard F8 + rebaixamento de ruído) acabou de rebaixar pra `Logger.debug` por
  serem rotineiros/alta-frequência. Delete é raro e consequente (evento
  destrutivo) — mesmo critério já estabelecido em 2026-07-20
  ("rotineiro/alta frequência = debug; raro/acionável = log") aponta pro lado
  oposto aqui.
- **Registro no dispatch**: `elseif message.kind == "deleteScript" then
  handleDeleteScript(message)`, com comentário de que é mensagem ADITIVA
  (mesmo padrão de `ping` — não bumpa `Config.PROTOCOL_VERSION`).
- **Validado só por `rojo build` (7.7.0 cacheado) + `lune run`** em
  `init.server.luau` — build `EXIT 0`; `lune run` erra em `init.server:45`
  (`game:GetService`, 1ª linha que toca `game`), confirmando que TODO o
  arquivo (incluindo o handler novo) compilou sem erro de sintaxe. Plugin
  buildado e implantado via `Tools/build-and-deploy-plugin.ps1` (`OK - plugin
  implantado`). **Nada testado em Studio real nesta tarefa** — teste
  ponta-a-ponta de verdade (delete local no VS Code -> instância some no
  Studio -> `scriptRemoved` chega no colega via Team Create) depende do lado
  da extensão (feito em paralelo pelo `extension-dev` na mesma sessão) e
  idealmente dos 2 Studios reais + harness (`Tools/README.md`). Fica
  `[Hipótese]` até o usuário validar. Roteiro sugerido (não escrito em
  DECISIONS.md/PROJECT_STATUS.md por pedido explícito do orquestrador — ele
  consolida a entrada depois de ler os dois agentes juntos): (1) via VS Code,
  deletar um arquivo `.luau` de um script já sincronizado -> confirmar a
  Instance correspondente é destruída no Studio dentro de ~0.5-1s, e o colega
  (outro Studio+VS Code) recebe a remoção também; (2) repetir tentando
  deletar um script dentro de `Packages/` -> confirmar bloqueio (`writeAck
  ok=false`, "delete bloqueado..."); (3) repetir enquanto outro dev tem lease
  ativa no mesmo script (edição recente, <8s) -> confirmar `writeAck
  ok=false` "lease negada...".

## Guard de Run/Play no botão CONNECT + mais ruído de uso contínuo rebaixado, 2026-07-20

- **Lição de processo, a que mais vale reter**: quando um comentário no código
  diz literalmente "X está fora de escopo desta tarefa" (aqui: "o botão
  CONNECT em si não tem guard de Run/Play — fora de escopo desta tarefa",
  deixado pela tarefa de 2026-07-16 que criou o guard de transição), esse
  comentário é uma DÍVIDA TÉCNICA anotada, não uma decisão permanente — vale a
  pena reler o contexto ao redor (aqui: a MESMA sessão de 2026-07-16 que
  deixou esse comentário também tornou o autostart opt-in/default OFF,
  mudando CONNECT manual de "atalho raro" pra "fluxo normal" — o que
  invalidava a premissa implícita de "fora de escopo" sem que ninguém tivesse
  voltado pra atualizar o comentário). Bug relatado pelo usuário ("plugin
  parecia estar em run-time") bateu exatamente com esse gap.
- **Padrão adotado para condição booleana duplicada em vários pontos de
  entrada, com granularidade de resposta diferente por call-site**: extrair
  para uma função pura module-level (`isInRunOrPlayMode()`, sem estado) e
  aplicar em CADA ponto de entrada, não só num lugar central — porque cada
  call-site precisava de uma RESPOSTA diferente à mesma condição:
  `onConnect` (ação explícita do usuário) usa `Logger.notify` (toast,
  feedback visível); `start()` (não sabe quem chamou) usa só `Logger.log`
  como defesa em profundidade, no MESMO estilo da guarda de idempotência já
  existente ali (`if enabled then ... return end` logo acima — a nova guarda
  segue o padrão visual/posicional de "checagem de recusa antes de
  `enabled = true`"). Alternativa rejeitada: centralizar a checagem só dentro
  de `start()` e deixar todos os call-sites chamarem sem checar antes — mais
  DRY, mas perderia a diferenciação de feedback (toast só faz sentido pra
  quem sabe que foi o usuário que clicou).
- **Pegadinha de nome ao extrair função com o mesmo nome de uma variável local
  existente**: `checkRunModeTransition` já tinha `local isInRunOrPlayMode =
  RunService:IsStudio() and RunService:IsRunning()` (variável, não função) —
  ao extrair a mesma expressão para uma função module-level com esse nome,
  a variável local teria colidido/sombreado a função dentro do próprio
  escopo onde ela precisava ser CHAMADA. Renomeada para `nowInRunOrPlayMode`
  (comunica também a semântica "valor observado agora", distinta de
  `wasInRunOrPlayMode`, o estado anterior guardado module-level).
- **Ruído de uso CONTÍNUO (não só boot) é uma categoria distinta do ruído de
  boot já resolvido em 2026-07-16** — mesmo mecanismo (`Logger.debug`), mas
  identificar OS locais certos exige olhar quais logs disparam por
  EVENTO/EDIÇÃO (a cada tecla, a cada movimento de cursor, a cada troca de
  dono de lease) em vez de só na conexão. Lista final desta tarefa: lease
  concedida/liberada/leaseChanged/intentSequenced
  (`TeamCreateLease.luau`), presenceChanged/presenceLeft — os DOIS gatilhos
  de presenceLeft, "presença zerada" E "sessão removida"
  (`TeamCreatePresence.luau`), joinSequence atribuído
  (`TeamCreateElection.luau`), sourceChanged (`SourceWatcher.luau`),
  writeSource update/create — só os caminhos de SUCESSO/detalhe, não os
  early-returns de erro (uuid desconhecido, bloqueio de pasta vendorizada
  seguem `Logger.log`) (`init.server.luau`). Critério usado, herdado de
  2026-07-16: "rotineiro/alta frequência = debug; raro/acionável = log".
  `presenceLeft` foi o caso mais ambíguo (o usuário explicitamente pediu
  julgamento) — decidido como debug porque dispara também por TIMEOUT
  (sessão some de `Sessions/` após `CLEANUP_AFTER_SECONDS`), não só por saída
  real, então tratá-lo como "log" geraria falsos alarmes de "alguém saiu"
  toda vez que uma sessão zumbi expirasse.
- **Validado só por `rojo build` + `lune run`** nos 5 arquivos tocados
  (`init.server.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
  `TeamCreateElection.luau`, `SourceWatcher.luau`) — sem erro de sintaxe.
  Plugin buildado e implantado via `Tools/build-and-deploy-plugin.ps1`.
  **Nenhum dos dois bugs pôde ser exercitado nesta tarefa** — BUG 1 exige
  apertar F8/F5 fisicamente dentro do Studio (ação física, fora do alcance de
  `Tools/`); BUG 2 exige ler o Output real durante uso contínuo de 2 Studios.
  Fica `[Hipótese]` até o usuário confirmar — roteiro em
  `docs/DECISIONS.md`/`docs/PROJECT_STATUS.md`, entrada 2026-07-20.

## Autostart opt-in + `Logger.debug` (consolidação de ruído de boot), 2026-07-16

- **Padrão "default invertido" entre duas settings booleanas irmãs**:
  `Config.resolveNotificationsEnabled` (default `true`) e o novo
  `Config.resolveAutoStartEnabled` (default `false`) têm a MESMA forma de
  função (`pcall(GetSetting)` -> se `boolean`, usa; senão, default) mas
  defaults opostos por design — não é inconsistência, é intencional (uma é
  "ligado a menos que o dev desligue", outra é "desligado a menos que o dev
  ligue"). Ao adicionar uma nova setting booleana no projeto, sempre perguntar
  explicitamente qual o default correto antes de copiar o padrão existente.
- **`Logger.debug(...)` novo (`plugin/src/Logger.luau`)**: mesmo forward por
  WS de `Logger.log` (a extensão/Tools continuam vendo tudo — observabilidade
  de teste automatizado nunca foi tocada), só que sem `print()` no Output do
  Studio. Não existe (ainda) um conceito real de "log level" no projeto — isto
  é a MENOR mudança que resolve "usuário vê rajada de ruído no Output" sem
  perder informação de diagnóstico (que continua acessível via WS/Tools). Se
  o projeto precisar de mais níveis no futuro (ex.: um 3º nível "trace"), essa
  função é o lugar natural de estender (parâmetro de nível em vez de
  log/debug separados), mas não havia necessidade concreta ainda — YAGNI.
- **Qual log virou o "consolidado" de conexão**: o antigo `log("conectado em
  %s")` disparava OTIMISTICAMENTE assim que `CreateWebStreamClient` retornava
  com sucesso — ANTES de saber se o handshake ia realmente vingar (podia
  logar "conectado" e cair com `ConnectFail` 40ms depois, e repetir isso 3x
  seguidas, exatamente o log colado pelo usuário nesta tarefa). Isso já era
  reconhecido no comentário do código ("NÃO vira connected/vermelho aqui...
  otimista") só que o LOG não seguia essa mesma disciplina até esta tarefa —
  lição: quando um comentário já documenta "isto é otimista, o estado real é
  mais adiante", o LOG ao lado da criação do objeto deveria seguir a MESMA
  disciplina do estado visual, não só a UI. Fix: virou `Logger.debug`; o
  `Logger.log` de verdade (`"conectado em ... (N scripts observados)"`) foi
  movido para dentro do `if stabilized and not shownConnected then` (mesmo
  ponto que já fazia `PluginUI.setConnectionStatus("connected")`).
- **Novo `SourceWatcher.getWatchedCount()`**: getter trivial (conta o mapa
  `watched` module-level) adicionado só para a linha de log consolidada poder
  reportar quantos scripts estão sendo observados no momento da conexão
  estabilizar, sem duplicar a lógica de contagem que já existia (inline)
  dentro de `SourceWatcher.start()`.
- **Investigação do `stop()` sem log de Run/Play (2026-07-16, prioridade
  rebaixada pelo usuário no meio da tarefa)**: sequência completa de shutdown
  (`observação parada`/`sessão removida`/`parado.`) apareceu no log real sem
  a linha que o guard de Run/Play sempre loga ANTES de chamar `stop()` —
  então o guard está excluído como causa (confirmado por leitura de código,
  não só suposição). Também descartados por leitura de código:
  `onPortChange` (usuário não mexeu na porta) e qualquer disparo espúrio de
  `Activated` no botão CONNECT/DISCONNECT via `PluginUI.luau`/`StatusPanel.luau`
  — todo `Activated`/`MouseEnter`/`MouseLeave` naqueles arquivos é uma conexão
  de sinal ESTÁTICA, criada 1x dentro de `vide.mount`/`vide.create` (não
  dentro de nenhum efeito reativo que rode de novo), e a árvore inteira
  (`MainView`/`ConnectRow`) é construída 1x só — não há caminho óbvio de
  recriação/reconexão espúria do botão. **Candidato mais plausível, não
  confirmado**: `plugin.Unloading:Connect(stop)` disparando por REDEPLOY do
  plugin (`Tools/build-and-deploy-plugin.ps1`/`.sh` sobrescreve o arquivo
  instalado, o que o Studio trata como reload — `Unloading` dispara para a
  instância antiga, independente de o Studio ter fechado; a suposição do
  usuário de "não é isso, Studio não fechou" não cobre esse caso). **Não
  investigado mais a fundo**: usuário confirmou que a causa raiz do ciclo de
  reconexão observado era simplesmente o servidor da extensão estar desligado
  (comportamento esperado, não bug) — tarefa despriorizada antes de eu
  esgotar a investigação do `stop()` isolado; nenhuma instrumentação foi
  adicionada (não pedida). Se reaparecer: instrumentar `stop()` com
  `debug.traceback()` no topo é o próximo passo mais barato.
- Validado só por `rojo build` + `lune run` nos 8 arquivos tocados
  (`Config.luau`, `Logger.luau`, `SourceWatcher.luau`, `ScriptRegistry.luau`,
  `TeamCreateElection.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
  `init.server.luau`) — sem erro de sintaxe. **Nada testado em Studio real
  nesta tarefa** — roteiro em `docs/PROJECT_STATUS.md` (seção mais recente).

## Exclusão de pastas Wally (`Packages`/`ServerPackages`/`DevPackages`) do live edit sync, 2026-07-16

- **Risco de arquitetura aprovado pelo usuário, não experimental**: plugin
  tratava scripts vendorizados via Wally igual a qualquer outro — risco real
  de empurrar Source de pacote desatualizado de um dev pro Team Create
  compartilhado. Ver docs/DECISIONS.md 2026-07-16 para motivação/escopo
  completo.
- **`Config.SYNC_EXCLUDED_FOLDER_NAMES`** (`plugin/src/Config.luau`): tabela
  `{Packages, ServerPackages, DevPackages}`. **
  `Config.isInsideExcludedPackageFolder(instance)`**: sobe `instance.Parent`
  até a raiz, `true` se algum ancestral tiver `Name` na lista. Não depende de
  posição (raiz dos watched roots ou aninhado mais fundo).
- **Dois pontos de enforcement, escolhidos deliberadamente para não misturar
  discovery com watch/lease**:
  1. `SourceWatcher.checkSourceChanged` (mesmo arquivo, mesma função usada
     tanto pelo sinal fast-path quanto pelo polling garantido) — early
     `return` logo no topo, ANTES de tocar `lastSourceByInstance`. Isso
     bloqueia o sentido Studio→disco (nunca emite `sourceChanged` para script
     vendorizado editado direto no Explorer/editor do Studio).
  2. `init.server.luau` `handleWriteSource`, modo ATUALIZAÇÃO (`message.uuid
     ~= nil`) — checagem logo após resolver a Instance por uuid, ANTES de
     `TeamCreateLease.ensureIntent`/`canWrite`. Bloqueia o sentido
     disco→Studio (writeAck `ok=false` com erro claro) e, como consequência
     natural de retornar antes de `ensureIntent`, também nunca arbitra lease
     para esses uuids (nunca ganham intent, nunca aparecem em `Leases/<uuid>`).
- **Deliberadamente NÃO tocado**: `ScriptRegistry` (resolveOrAllocate/
  forEach/getUuid) e `SourceWatcher.listScripts()` continuam normais para
  scripts vendorizados — a extensão precisa continuar vendo a EXISTÊNCIA
  deles via `listScripts`/uuid para o "Refresh Sync" não duplicar um pacote
  já instalado. Modo CRIAÇÃO do `writeSource` (sem uuid) também não passa
  pela checagem — é assim que um pacote novo chega ao Studio pela 1ª vez; só
  DEPOIS de criado (uuid já alocado) é que a checagem de modo ATUALIZAÇÃO
  passa a bloquear edições nele.
- **Não precisou tocar `TeamCreateLease.checkLeaseDrift`**: como
  `ensureIntent` nunca é chamado para uuids vendorizados, `getOwner(uuid)`
  sempre devolve `nil` pra eles — `checkLeaseDrift` continua rodando sobre
  todo o `ScriptRegistry` (não distingue vendorizado), mas nunca emite
  `leaseChanged` de verdade para esses uuids (fica só na baseline "sem
  dono"). Simplificação deliberada: evita uma dependência nova de
  `TeamCreateLease` → `Config` só para replicar a mesma checagem que já é
  garantida indiretamente pelo bloqueio em `init.server.luau`.
- Validado só por `rojo build` + `lune run` (`Config.luau`, `SourceWatcher.luau`,
  `init.server.luau`) — sem erro de sintaxe. **Nada testado em Studio real
  nesta tarefa** — roteiro pendente: instalar pacote Wally real, editar
  `Packages/<pacote>/init.luau` pelo Explorer (confirmar nenhum
  `sourceChanged`), e um `writeSource` de atualização via extensão contra
  esse uuid (confirmar `writeAck {ok=false}`). Fica `[Hipótese]` até o
  usuário rodar isso com Studio real.

- Uso validado de `CreateWebStreamClient` (RojoCoop
  `plugin/src/ApiContext.lua:230-290`): criar com pcall, eventos
  `MessageReceived`/`Closed`/`Error`, converter URL http→ws.
- **[Verificado, spike M0.5, 2026-07-02/03] `GetPropertyChangedSignal("Source")`
  não é confiável para observar escritas feitas via
  `ScriptEditorService:UpdateSourceAsync`.** Teste real no harness M0.5: a
  propriedade `.Source` muda de fato (confirmado por `readSource` logo
  depois), mas o callback do sinal às vezes simplesmente não roda —
  reproduzido nos dois sentidos de escrita cruzada (timeout de 15s esperando
  `sourceChanged`). Causa raiz exata ainda não confirmada (outro agente
  investigando em paralelo); o fix não depende dela. **Mitigação obrigatória:
  polling como caminho garantido, sinal só como fast-path opcional** — mesmo
  padrão já usado no spike M0 (`spikes/m0-source-replication/SyncTeamM0.lua`,
  `POLL_INTERVAL_SECONDS = 0.5`, função `onSourceObserved(counter, via)` com
  dedupe por `lastSourceCounter`). Portado para M0.5 em
  `spikes/m0_5-local-pipeline/plugin/SyncTeamLab.lua` como
  `checkSourceChanged(instance, lab, via)` + cache `lastSourceByInstance`
  (dedupe por instância, não por counter global). **Regra a levar para o
  plugin de produto (M1+): nunca depender só do sinal para detectar mudança
  de Source — sempre ter polling (ou heartbeat de reconciliação) como
  garantia.**
- **Pegadinha de ordering em script recém-criado**: se você cria a Instance
  (`Instance.new` + `.Parent = x`) e SÓ DEPOIS registra a observação a partir
  do handler de `DescendantAdded`, o registro pode acontecer DEPOIS de uma
  escrita imediata no mesmo Source (o `DescendantAdded` é evento adiado —
  "deferred" — então pode rodar depois que o código síncrono já escreveu a
  Source nova). Isso faz a baseline do cache já nascer igual ao valor final,
  mascarando a própria mudança que você queria detectar. Fix: registrar a
  observação (`watchScript`) de forma SÍNCRONA logo após criar/resolver a
  Instance e ANTES de chamar `UpdateSourceAsync`/escrever — não espere o
  `DescendantAdded`. A baseline capturada é `""` (Source default de scripts
  novos), então a escrita seguinte é detectada normalmente pelo polling.
- **Auto-start de plugin instalado como arquivo solto**: quando o plugin é um
  único `.lua` direto em `%LOCALAPPDATA%\Roblox\Plugins` (sem `.rbxmx`), o
  Studio auto-executa o script inteiro ao (re)carregar o arquivo — não requer
  clique em botão. Padrão adotado: chamar a função de start incondicionalmente
  no fim do arquivo (`task.spawn(start)`, fora de qualquer handler de clique),
  com guard de idempotência (`if enabled then return end`) para tolerar
  reload/reinstalação duplicada. Botão de start manual mantido só como
  fallback (chama a mesma função, no-op se já ativo); botão de stop continua
  como único controle manual necessário. Isso permite iterar reescrevendo o
  arquivo direto na pasta de Plugins sem depender de interação do usuário no
  Studio.
- **Protocolo `listScripts` (2026-07-03)**: resposta `scriptList` agora inclui,
  além do `paths` original (mantido inalterado para não quebrar
  `harness/server.mjs`), um campo aditivo `scripts: [{path, className}]`
  montado no mesmo loop `for instance in watched do`, usando
  `instance.ClassName` (serve para trabalho paralelo de mapeamento de pastas
  estilo Rojo, que precisa distinguir `Script`/`LocalScript`/`ModuleScript`).
- **[Verificado, teste real com 2 Studios/2 contas, 2026-07-04] Bug de clique
  duplo no mesmo botão de papel reinicia um loop concorrente com o antigo,
  mesmo com `stopAll()` desconectando `connections`.** Causa: usar uma flag
  global compartilhada (`running = "writer"|"observer"|nil`) simultaneamente
  como (a) identidade do papel ativo pra UI e (b) única condição de saída de
  `while running == "writer" do ... end`. `stopAll()` zera `running` e
  desconecta `RBXScriptConnection`s, mas não tem handle sobre a coroutine que
  está parada em `task.wait(...)` — quando essa coroutine acorda, a nova
  chamada já reescreveu `running` para o mesmo valor, e o loop "morto"
  continua rodando em paralelo com o novo. Sintoma real observado:
  `IntValue` counter saindo não-linear (`4,5,6,4,6,7...`) e latência
  reportada pelo observador bimodal (dois "trens" de escrita se misturando).
  **Fix (aplicado em `spikes/m0-source-replication/SyncTeamM0.lua`): token de
  geração.** `local currentToken = 0` incrementado dentro de `stopAll()`;
  cada `runX()` chama `stopAll()` primeiro, captura `local myToken =
  currentToken` (valor já pós-incremento), e todo `while` de longa duração
  (inclusive loops de espera/polling ANTES do loop "principal", ex.: o
  "aguardando alvo até 60s" do observador) passa a checar `currentToken ==
  myToken` além da flag de papel. `running` continua existindo só para
  UI/estado do botão, nunca mais como única guarda de loop. **Regra pro
  plugin de produto (M1+): qualquer botão/comando que pode reiniciar um loop
  de fundo (writer, observer, heartbeat de eleição, watcher de lease) precisa
  desse padrão de token/geração — flag de string sozinha não basta quando o
  mesmo papel pode ser start-clicado 2x antes do loop antigo acordar do
  `task.wait`.**
- Riscos observados nesse padrão de polling (ainda não testados sob carga):
  polling por instância (`for instance in watched do instance.Source end` a
  cada 0.5s) escala linear com nº de scripts observados — ok para sandbox de
  spike (dezenas), medir antes de levar para M1 com projetos reais (centenas
  de scripts). Caches por instância (`lastSourceByInstance`,
  `recentRemoteWrites`) precisam ser limpos em `DescendantRemoving` e em
  `stop()`, senão acumulam entradas de instâncias destruídas — feito no
  M0.5, mas confirmar que o mesmo cuidado entra no plugin de produto.

## M1 — plugin de produção (`plugin/`), 2026-07-04

- **Criado `plugin/` Rojo-buildável**: `plugin/default.project.json` (`{"name":
  "SyncTeam", "tree": {"$path": "src"}}`, igual ao template de plugin do
  RojoCoop) + `plugin/src/init.server.luau` (entry: toolbar, conexão WS
  única, dispatch de mensagens, auto-start) + dois módulos auxiliares
  `plugin/src/Config.luau` (constantes: porta 34980, timings, versão de
  protocolo) e `plugin/src/SourceWatcher.luau` (observação genérica +
  resolução de caminho + escrita). `rojo build` confirmado funcionando (ver
  abaixo como rodar sem `rokit add`).
- **Endereçamento por caminho no DataModel, não por UUID, nesta fatia do
  M1** — decisão deliberada, não desvio da regra de identidade. A regra
  "identidade de script é sempre UUID + ObjectValue" (CLAUDE.md, DECISIONS.md
  2026-07-02) vale para o registry `Scripts/<UUID>` do **M2**, que ainda não
  existe e cobre rename/move/delete. O M1 (fatia 1) não tem rename/move —
  só create/read/write/list — então o protocolo endereça por caminho
  completo relativo a `game` (ex.: `ServerScriptService/Foo/Bar`,
  `StarterPlayer/StarterPlayerScripts/Client`), calculado subindo
  `instance.Parent` até `game`. Quando o M2 chegar, isso precisa ser
  substituído/complementado pelo registry UUID — não esquecer.
- **`SourceWatcher.resolvePath(path, createClassName)`**: primeiro segmento
  tenta `game:FindFirstChild(name)` e cai para `game:GetService(name)` como
  fallback defensivo (serviços padrão às vezes só aparecem no DataModel
  depois de tocados). Segmentos seguintes criam `Folder` intermediário ou a
  classe final pedida, mesma lógica do `resolvePath` dos spikes — só que a
  raiz agora é `game`, não uma pasta sandbox.
- **Containers observados (fixos, decisão M1 em MILESTONES.md)**:
  `ServerScriptService`, `StarterPlayer.StarterPlayerScripts`,
  `ReplicatedStorage`, `ServerStorage`, `StarterGui`, `Workspace` —
  centralizados em `Config.getWatchedRoots()`. `StarterPlayerScripts` é
  filho direto de `StarterPlayer` (serviço), por isso o caminho reportado
  para scripts lá é `StarterPlayer/StarterPlayerScripts/...` (dois
  segmentos), não só `StarterPlayerScripts/...`.
- **Porta configurável sem UI ainda**: `Config.resolvePort(plugin)` lê
  `plugin:GetSetting("SyncTeam_WsPort")` (pcall) e cai para o default
  (`34980`, escolhida nova para não colidir com 34901/34902 dos spikes) se
  ausente/inválida. Sem UI para setar isso ainda — usuário avançado usaria
  `plugin:SetSetting(...)` no Command Bar. `[Hipótese]` GetSetting/SetSetting
  funcionam como esperado (não testado em Studio real nesta tarefa).
- **Handshake versionado novo**: mensagem `hello` do plugin agora leva
  `protocolVersion` (inteiro, começa em 1) além de `role`/`placeName`/
  `userId`/`pluginVersion`. Extensão decide o que fazer em mismatch (não é
  responsabilidade do plugin recusar a própria conexão).
- **1 única conexão WS no produto** (`init.server.luau`), diferente dos
  spikes M0.5 que usavam 2 portas para simular dois "VS Codes" — regra de
  `.claude/rules/luau.md` ("o produto usa 1 conexão, spikes no máximo 2").
  Reaproveitado o padrão de token de geração (`currentToken`) tanto na
  conexão WS quanto dentro de `SourceWatcher.start()/stop()` para
  start/stop repetido (botão) não deixar loop antigo rodando em paralelo —
  mesmo bug real documentado acima, agora com guarda em dois lugares
  (conexão e observação) porque são dois loops de fundo independentes.
- **Como testar sintaxe/build sem instalar rokit no projeto**: `rokit`
  recusa `rojo`/`lune` direto (`rojo --version` → "Failed to find tool ...
  in any project manifest") porque os shims em `~/.rokit/bin/*.exe` exigem
  um `rokit.toml` resolvendo a versão. Contorno que funcionou: chamar o
  binário real cacheado direto, ex.
  `~/.rokit/tool-storage/rojo-rbx/rojo/7.7.0/rojo.exe build -o out.rbxm` e
  `~/.rokit/tool-storage/lune-org/lune/0.10.4/lune.exe run arquivo.luau`.
  `rojo build` valida `default.project.json`/layout mas não faz parsing
  profundo de Luau; `lune run` roda o arquivo de verdade com parser Luau
  completo — como não há emulação de Roblox, o erro esperado e aceitável é
  `attempt to index nil with 'GetService'` na primeira linha que usa
  `game`/`script`/`plugin` (prova que tudo antes disso parseou e executou
  sem erro de sintaxe). Usado para validar `Config.luau`, `SourceWatcher.luau`
  e `init.server.luau` desta tarefa — nenhum erro de sintaxe encontrado.
- **Supressão de eco na própria escrita**: `SourceWatcher.writeSource` já
  atualiza `lastSourceByInstance` para o novo valor ANTES de retornar, então
  o polling/sinal que rodar depois não vê mudança e não dispara
  `sourceChanged` para a própria escrita pedida via WS — só edições feitas
  de fato no editor do Studio (fora do fluxo de `writeSource`) geram
  `sourceChanged origin="studio"`. Decisão não pedida explicitamente na
  tarefa; diferente do comportamento dos spikes (que sempre faziam
  broadcast, usando `origin` só como campo informativo, porque queriam medir
  o round-trip). Faz sentido para 1 conexão só (eco pra quem pediu a escrita
  é redundante), mas revisitar se algum cenário futuro (M3+, múltiplos
  Studios) precisar do eco.
- **Não testado em Studio real nesta tarefa** (fora do escopo pedido):
  toolbar, auto-start, conexão de fato com uma extensão VS Code (que ainda
  não existe/não foi integrada), `GetSetting`/`SetSetting`, comportamento
  real de `DescendantAdded` nos 6 containers simultaneamente. Tudo isso
  fica `[Hipótese]` até round-trip real com a extensão (fatia 5/6 do M1).

## M2 — identidade UUID+ObjectValue (`plugin/`), 2026-07-04

- **Novo módulo `plugin/src/ScriptRegistry.luau`**: dono exclusivo de
  `TestService.SyncTeam.Scripts.<uuid>` (`Folder` com `InstanceRef:
  ObjectValue` + `CanonicalPath: StringValue`). API: `init()`,
  `reconcile(isWatched)`, `resolveOrAllocate(instance, canonicalPathStr) ->
  uuid, isNew`, `getInstance(uuid)`, `getUuid(instance)`,
  `updateCanonicalPath(uuid, path)`, `remove(uuid)`, `forEach(callback)`.
  Estado (`uuidByInstance`/`recordByUuid`) é module-level, sobrevive a
  `SourceWatcher.stop()`/`start()` (só é reconstruído/podado por
  `reconcile()`, nunca zerado por `stop()`) — é isso que faz a identidade
  sobreviver a reload do plugin dentro da mesma sessão de place.
- **Pegadinha real evitada por design, não descoberta por bug**: `forEach`
  tira um snapshot (`table.insert` num array novo) ANTES de chamar qualquer
  callback, porque o chamador (`checkRegistryDrift` em `SourceWatcher.luau`)
  pode chamar `ScriptRegistry.remove(uuid)` dentro do próprio callback —
  mutar (deletar chave) o mapa que está sendo percorrido por `pairs`
  enquanto percorre é terreno arriscado em Lua/Luau; snapshot primeiro evita
  o problema por completo em vez de confiar em "deletar a chave atual é
  seguro" (que só vale pra chave atual, não pras outras).
- **Decisão de design (registrada em DECISIONS.md/MILESTONES.md): delete não
  usa mais `DescendantRemoving` como gatilho, só o ciclo de polling.**
  `DescendantRemoving` dispara tanto para `Instance:Destroy()` real quanto
  para reparent de um script pra FORA dos containers observados (a Instance
  continua viva, só saiu da área observada) — via esse evento isolado os
  dois casos são indistinguíveis. A partir do M2, `unwatchScript` (chamado
  no handler de `DescendantRemoving`) só faz limpeza de cache local
  (desconecta sinal, limpa `lastSourceByInstance`/`recentWrites`) e NÃO toca
  no registry nem emite `scriptRemoved`. Quem decide "isso foi delete de
  verdade" é `checkRegistryDrift()` (chamado 1x por ciclo do `pollLoop`,
  mesmo lugar que detecta `scriptMoved`), checando `InstanceRef.Value ==
  nil` no registry — esse comportamento (`ObjectValue.Value` zera quando a
  Instance referenciada é destruída) é o mesmo já exercitado nos testes do
  componente portado do RojoCoop (`TeamCreateCoordinator.spec.lua:374-381`,
  `script:Destroy()` seguido de `instanceRef.Value == nil`) — `[Hipótese]`
  ainda não reconfirmado num Studio real do SyncTeam (só herdado/portado).
- **Ordem de alocação de uuid segue a mesma disciplina de "registrar ANTES
  de agir" já usada pra baseline de Source**: `watchScript(instance)` conecta
  o sinal E chama `ScriptRegistry.resolveOrAllocate` de forma síncrona, ANTES
  de qualquer escrita. Isso é o que permite `handleWriteSource` (modo
  criação, sem `uuid` na mensagem recebida) responder o `writeAck` já com o
  uuid certo: `SourceWatcher.writeSource(instance, source)` chama
  `watchScript` internamente antes de escrever, então por ora que
  `writeSource` retorna, `SourceWatcher.getUuid(instance)` já tem o valor
  alocado. O `scriptAdded` espontâneo que a extensão recebe depois (via
  `DescendantAdded`, que é um evento ADIADO/deferred) chega com o MESMO uuid
  porque `watchScript` é idempotente (`watched[instance] ~= nil` já é
  verdade na segunda chamada) — não há alocação duplicada nem uuid
  divergente entre o `writeAck` e o `scriptAdded` da mesma criação.
- **Protocolo v2 (`Config.PROTOCOL_VERSION = 2`)**: `writeSource` distingue
  modo atualização (`uuid` presente) de modo criação (`uuid` ausente, usa
  `path`+`className`) só pela presença do campo `uuid` na mensagem —
  `message.uuid ~= nil` no handler. `writeAck`/`sourceChanged`/`scriptAdded`/
  `scriptRemoved` ganharam `uuid`; nova mensagem espontânea `scriptMoved
  {uuid, oldPath, newPath, className}`. `path` nas mensagens continua
  existindo, mas passou a ser só informativo/exibição — nunca mais chave de
  endereçamento de `readSource`/`writeSource` (isso é `resolveByUuid`, não
  `resolvePath`; `resolvePath` só sobrevive pro modo criação, pra achar/criar
  a Instance a partir de `game`).
- **Validado só por `rojo build` + `lune run` nos 4 arquivos (`Config.luau`,
  `ScriptRegistry.luau`, `SourceWatcher.luau`, `init.server.luau`) — sem
  erro de sintaxe, erro esperado só na primeira linha que toca `game`.**
  Nada testado em Studio real nesta tarefa (reconciliação entre reloads,
  `scriptMoved`/`scriptRemoved` de verdade, round-trip com extensão) —
  roteiro manual completo escrito em `docs/PROJECT_STATUS.md` (seção "M2 —
  lado do plugin"), pendente do usuário executar com Studio real.

## M2 — dois bugs reais corrigidos após teste com 2 Studios, 2026-07-04

- **[Verificado, DevForum + doc oficial via `.claude/research/2026-07-04-objectvalue-destroy-detection.md`]
  `ObjectValue.Value` NÃO vira `nil` quando a Instance referenciada é
  destruída via `:Destroy()` — é comportamento intencional confirmado por
  staff da Roblox em múltiplos threads do DevForum (a doc oficial de
  `Destroy()` até recomenda zerar manualmente qualquer referência, o que só
  faz sentido se o engine não fizer isso por conta própria). `Changed`
  também **não dispara** quando o valor referenciado morre (só dispara ao
  reatribuir `Value` para outra coisa). O teste do RojoCoop citado como
  "validado" (`TeamCreateCoordinator.spec.lua:374-381`) só provou isso contra
  um **mock**, nunca contra o engine real — mock e engine divergem aqui.
  **Nunca usar `instanceRef.Value == nil` como sinal de destruição.**
  **Padrão correto** (aplicado em `ScriptRegistry.isInstanceDestroyed`):
  `instance.Parent == nil` (necessário, não suficiente — reparent legítimo
  também passa por Parent nil por um instante) **+** confirmação por `pcall`
  tentando reatribuir o PRÓPRIO `Parent` (`instance.Parent = instance.Parent`)
  — a doc oficial garante que `Destroy()` trava `Parent`, então só numa
  destruição real essa reatribuição falha. `Instance.Destroying` existe mas
  tem múltiplos relatos de disparo inconsistente no DevForum (sem resposta de
  staff em alguns) — pode ficar como fast-path best-effort, nunca como único
  caminho; o polling por ciclo continua sendo a garantia (mesmo princípio já
  usado para `Source.Changed` desde o M0.5). Bug real reproduzido: script
  apagado no Explorer em teste com 2 Studios nunca gerou `scriptRemoved`
  porque `checkRegistryDrift` dependia da premissa errada. Fix aplicado em
  `plugin/src/ScriptRegistry.luau` (`isInstanceDestroyed`, usado em
  `reconcile`/`getInstance`) e `plugin/src/SourceWatcher.luau`
  (`checkRegistryDrift`).
- **[Verificado por teste real com 2 Studios]** Registry de UUID pode
  divergir entre Studios para a MESMA Instance replicada via Team Create se
  `resolveOrAllocate` só consultar o mapa em memória local
  (`uuidByInstance`) — `reconcile()` só roda 1x no `start()`, então uma
  Instance que aparece via `DescendantAdded` DEPOIS (replicada de outro
  Studio que já alocou uuid pra ela) não era comparada contra o registry
  compartilhado (`Scripts/<uuid>/InstanceRef`) antes de gerar um uuid novo.
  Reproduzido: dois Studios alocaram uuids diferentes (`9dbf46f6...`/
  `5b51cd63...`) pro mesmo script. **Fix**: `resolveOrAllocate` agora varre
  `scriptsFolder:GetChildren()` (`findRegistryEntryFor`, novo helper privado
  em `ScriptRegistry.luau`) procurando uma entrada cujo `InstanceRef.Value`
  já seja a Instance recebida (ignorando entradas cuja Instance já morreu de
  verdade, via `isInstanceDestroyed`) ANTES de chamar `HttpService:GenerateGUID`.
  Isso é o mesmo escaneio que `reconcile()` faz no startup, só que sob
  demanda a cada alocação — decidi NÃO extrair uma função compartilhada com
  `reconcile()` porque os padrões de iteração são inversos (`reconcile`
  itera folder→decide-se-reaproveita; `findRegistryEntryFor` itera
  folder→compara instance) e a duplicação de ~10 linhas de validação de
  schema pareceu mais legível que uma abstração forçada — revisitar se o
  schema ganhar mais campos no M3 (SchemaVersion/sessões/leases) e a
  duplicação começar a doer.
- **Lição geral, já registrada em DECISIONS.md**: comportamento só validado
  contra mock de teste unitário (mesmo de projeto com histórico real em
  outras áreas) não substitui confirmação contra o engine real ou doc
  oficial antes de virar premissa de produção. Os dois bugs desta entrada
  vieram da mesma origem (RojoCoop testado só com mock nesse componente
  específico).
- Validado apenas por `rojo build` (layout ok) + `lune run` nos dois
  arquivos alterados (sem erro de sintaxe; erro esperado só na 1ª linha que
  toca `game`). Teste real com 2 Studios repetindo o cenário que expôs os
  bugs (apagar script pelo Explorer → confirmar `scriptRemoved`; replicar
  script novo entre os dois Studios → confirmar mesmo uuid dos dois lados)
  fica `[Hipótese]`/pendente do usuário — roteiro em
  `docs/PROJECT_STATUS.md` (seção "M2 — dois bugs reais corrigidos...").

## M2 — fast-path opcional de delete via `DescendantRemoving`, 2026-07-04

- **`DescendantRemoving` dispara ANTES da remoção terminar — cuidado ao usar
  como gatilho de "delete detectado".** O nome do evento é "Removing", não
  "Removed": no momento exato do handler, `instance.Parent` costuma ainda
  ser o Parent ANTIGO (não `nil`), inclusive para um `Destroy()` real. Isso
  significa que `ScriptRegistry.isInstanceDestroyed` (que depende de
  `Parent == nil` + confirmação por `pcall`) checado SINCRONAMENTE dentro do
  handler tende a sempre devolver falso — mesmo pra delete de verdade — e o
  fast-path fica inerte. **Mitigação aplicada** (`checkDeadFastPath` em
  `plugin/src/SourceWatcher.luau`): a checagem roda dentro de
  `task.defer(function() ... end)`, cedendo um resumption point antes de
  checar `isInstanceDestroyed`. **`[Hipótese], não confirmada em Studio
  real** — não há como testar timing exato de `task.defer` vs. o momento em
  que o engine trava `Parent` sem um Studio de verdade, e isso não está
  coberto por nenhum research salvo (`.claude/research/`). Se essa hipótese
  se mostrar errada, não é regressão: o fast-path simplesmente não emite
  nada e `checkRegistryDrift` (polling, 0.5s) continua sendo a garantia —
  exatamente o comportamento de antes desta mudança. Roteiro de teste manual
  (comparar timestamp do log `scriptRemoved` contra o intervalo de poll) em
  `docs/PROJECT_STATUS.md`, seção "M2 — fast-path opcional de delete...".
- **Padrão de extração ao compartilhar lógica entre caminho garantido e
  fast-path**: `emitScriptRemoved(uuid, storedPath)` (remove do registry +
  `sendMessage scriptRemoved` + log) foi extraída de dentro de
  `checkRegistryDrift` e reusada por `checkDeadFastPath` — qualquer nova
  detecção alternativa do mesmo evento de negócio (scriptRemoved) deve
  reusar essa função, não duplicar o trio remove+sendMessage+log.
- **Dedupe entre dois caminhos que podem detectar a mesma morte**: quando
  existem dois caminhos concorrentes para o mesmo evento (aqui: polling e
  fast-path via `DescendantRemoving`+`task.defer`), reconferir a condição
  "ainda não processado" IMEDIATAMENTE ANTES de agir, depois de qualquer
  yield (`task.wait`/`task.defer`) — não confiar em "só um caminho vai
  chegar primeiro". Aqui: `ScriptRegistry.getUuid(instance) ~= uuid` depois
  do `task.defer` detecta se `ScriptRegistry.remove(uuid)` já rodou por outro
  caminho enquanto o defer esperava (remove() limpa `uuidByInstance`, então a
  comparação falha e o handler tardio desiste sem duplicar
  `scriptRemoved`). Mesmo princípio do token de geração já usado em outros
  lugares deste arquivo — só que aqui a "geração" é implícita no próprio
  estado do registry, não precisou de um contador dedicado.

## M3.1 — Sessions + heartbeat + eleição de líder (`plugin/`), 2026-07-04

- **Dois módulos novos**: `plugin/src/TeamCreateSchema.luau` (container raiz
  `TestService.SyncTeam` idempotente + `LeaderClientId`/`LeaderTerm`/
  `NextJoinSequence`, extraído de dentro de `ScriptRegistry.ensureContainers`
  porque agora dois módulos precisam da mesma lógica "criar Folder SyncTeam
  sob TestService se não existir" — `ScriptRegistry` foi refatorado para
  chamar `TeamCreateSchema.ensureFolder("Scripts")` em vez de duplicar) e
  `plugin/src/TeamCreateElection.luau` (algoritmo de eleição + schema
  `Sessions/<clientId>/` + loop de heartbeat).
- **Porte 1:1 confirmado, sem alterar lógica nem números**: `elect`,
  `observeCandidate`, `assignJoinSequences` são cópias diretas de
  `RojoCoop/rojo-7.7.0-rc.1/plugin/src/TeamCreateElection.lua`. Constantes
  também idênticas: `PULSE_INTERVAL_SECONDS=2`, `STALE_AFTER_SECONDS=8`,
  `CLEANUP_AFTER_SECONDS=20`, `PROMOTION_OBSERVATIONS=2`. Regra do projeto
  reforçada: qualquer PR futuro que toque esses números precisa passar por
  DECISIONS.md primeiro.
- **`ClientId` gerado de novo a cada `start()`, nunca persistido entre
  reloads** — decisão desta fatia (documentada no cabeçalho do arquivo e em
  PROJECT_STATUS.md). Justificativa: `stop()` já remove a própria entrada de
  `Sessions/` de forma SÍNCRONA (mesma disciplina do fix de
  `WebStreamClient` do M2 — nunca depender de coroutine assíncrona para
  cleanup em `plugin.Unloading`), então não há lixo acumulando por reload
  normal; persistir só ganharia continuidade de `JoinSequence`/
  `ObservedRole` entre reloads, sem valor real aqui. Se algum teste real
  mostrar que isso causa churn de liderança indesejado em reloads
  frequentes durante debug, é o primeiro lugar a revisitar.
- **Username via `Players:GetNameFromUserIdAsync`, pcall + fallback
  `tostring(userId)`** — mesmo padrão já usado no RojoCoop
  (`TeamCreateCoordinator:__resolveUsername`), portado sem mudança. Tratado
  como porte de componente já validado (tabela do CLAUDE.md: "Schema de
  metadados Team Create" e o coordinator inteiro estão marcados como
  validados em 2 Studios), não como pesquisa de API nova — não foi preciso
  (nem criado) research novo para isso. Roda em `task.spawn` separado
  (é uma chamada que yield) com reconfirmação de `enabled`/`currentToken`
  antes de escrever de volta, mesmo cuidado usado em outros lugares do
  projeto para qualquer escrita pós-yield.
- **Observação de heartbeatAge é sempre LOCAL, nunca confia em timestamp
  remoto**: `readSessions` guarda `{pulse, observedAt=os.clock() local}` por
  `clientId` e só atualiza `observedAt` quando o `Pulse` lido muda de valor
  — o "quão obsoleta" uma sessão está é medido pelo tempo decorrido desde a
  ÚLTIMA VEZ que ESTE Studio observou o Pulse mudar, não por qualquer coisa
  escrita pelo Studio remoto (que poderia estar com o clock dessincronizado
  ou simplesmente ter parado sem avisar). Mesmo princípio já usado para
  dedupe de Source/delete desde o M0.5/M2 — portado do
  `TeamCreateCoordinator:__readSessions` do RojoCoop sem alteração de
  lógica.
- **Arbitragem de UUID pelo líder (mencionada em MILESTONES.md como
  consequência natural do M3.1) NÃO foi implementada nesta fatia** —
  decisão deliberada de manter o escopo estrito (só
  sessões/heartbeat/eleição, sem tocar em `ScriptRegistry`/UUID). Fica
  para M3.2, quando o líder já estará decidindo outras coisas (leases).
- **Integração em `init.server.luau`**: `start()` resolve `userId` uma vez
  via `pcall(StudioService.GetUserId, StudioService)` e passa pra
  `TeamCreateElection.start(userId)`; `stop()` chama
  `TeamCreateElection.stop()` antes de fechar o `WebStreamClient` — mesma
  ordem/disciplina do fix de vazamento do M2 (cleanup síncrono de recursos
  que não podem depender de coroutine assíncrona sobrevivendo a
  `plugin.Unloading`).
- Validado só por `rojo build` (binário cacheado, layout ok) + `lune run`
  nos 4 arquivos tocados (`TeamCreateSchema.luau`, `TeamCreateElection.luau`,
  `ScriptRegistry.luau`, `init.server.luau`) — sem erro de sintaxe, erro
  esperado só na primeira linha que toca `game`/`plugin`. **Nada testado em
  Studio real nesta tarefa** — convergência de líder, failover forçado,
  timing exato de promoção (2 pulsos = ~4s de atraso mínimo antes de
  qualquer Studio se considerar líder, mesmo no caso trivial de 1 Studio só)
  ficam `[Hipótese]` até o roteiro manual em PROJECT_STATUS.md ser
  executado pelo usuário com 2 Studios reais.

## M3.2 — Leases autoritativas por script (`plugin/`), 2026-07-04

- **Módulo novo `plugin/src/TeamCreateLease.luau`**: porte do algoritmo de
  decisão do RojoCoop (`TeamCreateShadowLease.lua`:
  `chooseWinner`/`assignRequestSequences`/`groupByScript`, cópia 1:1 da
  lógica de comparação/desempate) + ciclo do líder equivalente a
  `TeamCreateCoordinator:__assignRequestSequences`/`__reconcileShadowLeases`.
  Diferença central de arquitetura (já em DECISIONS.md/ARCHITECTURE.md):
  aqui a lease é AUTORITATIVA — bloqueia `writeSource` de verdade — não
  "shadow" como no RojoCoop (lá o bloqueio real era do servidor Rust).
- **Onde ficou a checagem "tenho a lease?"**: decidi colocar em
  `init.server.luau` (`handleWriteSource`, modo atualização — `message.uuid
  ~= nil`), NÃO dentro de `SourceWatcher.luau`. A tarefa deixava a escolha
  aberta ("decida o melhor lugar"). Motivo: `SourceWatcher` já tinha a
  responsabilidade bem definida de "só I/O de Source + ScriptRegistry"
  desde o M2 (ver comentário no cabeçalho do próprio arquivo); `init.server.luau`
  já é quem requer `TeamCreateElection` e orquestra semântica de protocolo
  (distinção criação/atualização já vivia lá) — colocar a checagem de lease
  ali evita uma dependência nova de `SourceWatcher` → `TeamCreateLease` só
  para isso. Fluxo: `TeamCreateLease.ensureIntent(uuid, instance)` (cria/
  refresca intent, incrementa Pulse) seguido de `TeamCreateLease.canWrite(uuid)`
  — se `false`, `writeAck {ok=false, error="lease negada — script sendo
  editado por <owner>"}` e RETORNA sem chamar `SourceWatcher.writeSource`
  (nada é escrito no DataModel). Modo criação (sem uuid) não passa por essa
  checagem (fora de escopo da fatia, resolvido no `if message.uuid ~= nil`
  que já existia).
- **Novo accessor em `TeamCreateElection.luau`**: `getSessionFolder()`
  retorna o Folder `Sessions/<clientId>` da própria sessão (ou `nil` se a
  eleição não estiver rodando/sessão destruída) — antes esse estado
  (`sessionFolder`) era 100% privado ao módulo. Necessário porque
  `TeamCreateLease.ensureIntent` precisa criar a subpasta `LeaseIntents`
  DENTRO da sessão própria, mas quem é dono/cria `Sessions/<clientId>` é
  `TeamCreateElection`, não `TeamCreateLease` — evitei duplicar essa lógica
  de criação de sessão num segundo módulo. `getSessionFolder()` já defende
  contra `Parent == nil` (sessão em processo de destruição), retornando
  `nil` nesse caso — quem chama (`ensureIntent`) degrada sem erro (skip),
  nunca lança.
- **Schema**: `NextLeaseRequestSequence` (IntValue) somado a
  `TeamCreateSchema.ROOT_VALUES` (mesmo padrão dos 3 valores do M3.1, não um
  container/módulo novo). `Sessions/<clientId>/LeaseIntents/<uuid>/`
  (IntentId StringValue GUID, Pulse IntValue, RequestSequence IntValue,
  ScriptRef ObjectValue) é subpasta da sessão, criada por
  `TeamCreateLease` mas vivendo dentro de uma Instance que
  `TeamCreateElection` destrói (cascata) ao sair — não precisei de nenhum
  cleanup explícito de intents no `stop()` de `TeamCreateLease` por causa
  disso. `Leases/<uuid>/` (OwnerClientId StringValue, LeaseId StringValue
  GUID, LeaderTerm IntValue, RequestSequence IntValue) é container próprio
  (`TeamCreateSchema.ensureFolder("Leases")`), dono exclusivo de
  `TeamCreateLease`.
- **"Vivo" para um intent = só a observação local de mudança do próprio
  `Pulse`** (mesmíssimo princípio de Source.Changed/scriptRemoved/heartbeat
  de sessão desde M0.5/M2/M3.1 — nunca confiar em timestamp remoto).
  Deliberadamente NÃO verifiquei também se a SESSÃO dona está viva (o
  RojoCoop fazia essa checagem dupla em `__readLiveIntents`) — como o Pulse
  do intent só é incrementado por um `writeSource` local (não por um timer
  de heartbeat independente do de sessão), se a sessão dona morre o Pulse do
  intent também para de mudar e cai fora da janela de `STALE_AFTER_SECONDS`
  pelo mesmo relógio. Simplificação deliberada, ainda não contrariada por
  teste real — revisitar se aparecer um cenário divergente (ex.: sessão
  finalizada mas o registro de intent, por algum motivo, continuar sendo
  lido como "vivo" por mais tempo que o esperado).
- **Ciclo do líder é um `task.spawn` PRÓPRIO de `TeamCreateLease`**, checando
  `TeamCreateElection.isLeader()` no início de cada iteração de
  `PULSE_INTERVAL_SECONDS` — não acoplei ao tick interno de
  `TeamCreateElection` (que é uma função `local`, não exposta) para não
  precisar reabrir/expor internals de um módulo já validado no M3.1. Custo:
  dois loops de `task.spawn` independentes rodando no mesmo intervalo em vez
  de um só — aceito conscientemente (tarefa dava essa opção explicitamente
  como alternativa mais simples).
- **Limitação aceita, não pedida pela tarefa**: pastas de intent
  (`LeaseIntents/<uuid>`) nunca são destruídas por `TeamCreateLease` quando
  ficam obsoletas (só `Leases/<uuid>` é gerenciado ativamente) — diferente
  do RojoCoop, que tinha `__pulseLocalIntents` removendo intents locais
  inativos expirados do lado do próprio cliente. Numa sessão de Studio longa
  editando muitos scripts diferentes ao longo do tempo, isso acumula uma
  pasta de intent por uuid já tocado, nunca removida enquanto a sessão
  inteira estiver viva. Não é bug (não corrompe nada, é só lixo acumulado em
  memória/replicação) — registrar como candidato a polish se aparecer em
  teste real com sessões longas.
- **Validado só por `rojo build` + `lune run`** nos 4 arquivos tocados
  (`TeamCreateSchema.luau`, `TeamCreateElection.luau`, `TeamCreateLease.luau`
  novo, `init.server.luau`) — sem erro de sintaxe, erro esperado só na
  primeira linha que toca `game`. **Nada testado em Studio real nesta
  tarefa** — negação de escrita concorrente, liberação de lease após
  inatividade (~10s), e o caso "sem preempção" (dono mantém mesmo com
  `RequestSequence` maior que o de outro candidato) ficam `[Hipótese]` até o
  roteiro manual em PROJECT_STATUS.md (seção "M3.2 — Leases por script...")
  ser executado pelo usuário com 2 Studios reais.

## M3.3 — parte plugin: `clientId` no hello + `leaseChanged` (`plugin/`), 2026-07-04

- **Tarefa era só duas adições pequenas e delimitadas** a
  `plugin/src/init.server.luau` e `plugin/src/TeamCreateLease.luau`, ambos já
  implementados (M3.1/M3.2) — sem redesenhar eleição/lease.
- **`clientId` no `hello`**: `sendHello()` ganhou
  `clientId = TeamCreateElection.getClientId()`. Como `TeamCreateElection`
  já é `require`d em `init.server.luau` desde o M3.1, não é dependência
  nova.
- **`leaseChanged {uuid, ownerClientId, ownerDisplayName}`**: a tarefa
  oferecia 2 opções de onde colocar a checagem de drift — (a) nova função em
  `SourceWatcher.luau` chamada pelo `pollLoop`, exigindo `SourceWatcher` →
  `TeamCreateLease` que o cabeçalho do arquivo (M3.2) documenta ter evitado
  de propósito; (b) ciclo próprio dentro de `TeamCreateLease.luau`. Escolhi
  **(b)**, respeitando a decisão anterior. Implementação: `checkLeaseDrift()`
  novo em `TeamCreateLease.luau`, chamado por um `task.spawn` PRÓPRIO desse
  módulo (paralelo ao `leaderTick` já existente, não acoplado a ele) a
  `Config.POLL_INTERVAL_SECONDS` (0.5s — não `PULSE_INTERVAL_SECONDS`, 2s,
  do `leaderTick`: `leaseChanged` é sinal de UX, quer a mesma
  responsividade da detecção de Source, não a cadência de heartbeat/eleição).
  `checkLeaseDrift` varre `ScriptRegistry.forEach(uuid, instance, storedPath)`
  (nova dependência de `TeamCreateLease` → `ScriptRegistry` — unidirecional,
  aceitável: `TeamCreateLease` já lida com uuids de script desde o M3.2),
  compara `TeamCreateLease.getOwner(uuid)` contra `lastOwnerByUuid[uuid]`
  (cache, dedupe — mesmíssimo padrão de `checkSourceChanged`/
  `checkRegistryDrift` em `SourceWatcher.luau`) e emite via callback injetado
  por `TeamCreateLease.init(sendMessage)` (novo, espelha `SourceWatcher.init`;
  chamado em `init.server.luau` com o MESMO `sendMessage` já passado a
  `SourceWatcher.init`).
- **Sentinela para distinguir "nunca observado" de "observado como sem
  dono"**: `lastOwnerByUuid[uuid]` guarda o `OwnerClientId` real ou
  `NO_OWNER_KEY = ""` (GUID real nunca é vazio) quando não há lease — chave
  ausente na tabela (`lastKey == nil`) significa "uuid ainda não visto nesta
  sessão", tratado como baseline (grava e RETORNA sem emitir). Decisão não
  pedida explicitamente: evita uma rajada de `leaseChanged` para todo script
  que já tinha lease arbitrada no momento em que este Studio conecta/inicia
  (script antigo, lease de sessão anterior replicada). Consequência: se um
  Studio conecta e um script já tem dono, esse Studio só saberá do dono na
  PRÓXIMA mudança de dono, não na conexão — aceitável para esta fatia
  (checagem de lease em si, `canWrite`, sempre lê o estado atual direto, não
  depende dessa notificação; é só um aviso proativo de UI).
- **`ownerDisplayName` sempre calculado via `describeClient(owner)`, mesmo
  quando `owner == nil`** (lease liberada) — `describeClient(nil)` já
  retorna `"desconhecido"` desde o M3.2, seguido literalmente como pedido na
  tarefa (não computei `nil`/vazio condicionalmente).
- **Limitação nova aceita, mesma natureza da já documentada para
  `LeaseIntents` no M3.2**: `lastOwnerByUuid` nunca remove uma entrada
  quando o uuid correspondente é removido de `ScriptRegistry` (script
  deletado) — só cresce durante a vida do plugin. Lixo pequeno em memória,
  não replicado, não corrigido nesta fatia.
- Validado só por `rojo build` + `lune run` em `TeamCreateLease.luau` e
  `init.server.luau` — sem erro de sintaxe, erro esperado só na primeira
  linha que toca `game`. **Nada testado em Studio real** — não há roteiro
  manual isolado desta fatia (o consumo de `clientId`/`leaseChanged` é
  trabalho paralelo de outro agente na extensão/UI).

## M3.1 — fix de split-brain de liderança (`plugin/`), 2026-07-07

- **Confirmado por leitura de código (não só suspeita)**: o padrão
  "singleton preguiçoso" (`parent:FindFirstChild(name)` → se `nil`,
  `Instance.new`+`.Parent`), usado em `TeamCreateSchema.luau` (container raiz
  + valores de coordenação) e no `getOrCreate` privado de
  `TeamCreateElection.luau`, é uma corrida real quando dois Studios chamam
  quase-simultaneamente ANTES da réplica do Team Create assentar — Roblox
  permite duas Instances IRMÃS com o mesmo `Name` (não faz merge), então cada
  Studio pode criar sua própria cópia. Agravante que só a leitura do fluxo de
  `start()` revelou: `tick()` roda SINCRONAMENTE logo depois de
  `ensureOwnSession()`, sem NENHUMA espera de assentamento; e
  `rootValues`/`sessionsFolder` eram cacheados 1x em `start()` e NUNCA
  reavaliados depois — mesmo que a réplica do outro lado chegasse depois
  como Instance irmã, o Studio ficava preso pra sempre na sua cópia local.
  Bug real reproduzido em teste com 2 Studios: `LeaderTerm` divergente (6 vs
  1) no mesmo momento, cada lado citando um clientId diferente como líder.
- **Lição principal, generalizável**: "evitar a corrida" (ex.: delay
  aleatório antes do primeiro tick) NUNCA é suficiente sozinho quando a
  replicação é assíncrona — só reduz a chance, não elimina. Qualquer
  singleton compartilhado entre Studios via Team Create (container Folder OU
  Value simples tipo IntValue/StringValue) precisa de RECONCILIAÇÃO
  determinística: um critério de desempate que seja (a) replicado (dado que
  qualquer Studio, tendo visto ambas as duplicatas, calcula igual — nunca
  "quem eu vi primeiro" local) e (b) nunca destrutivo (merge antes de
  destruir, não escolher-e-descartar). Ordem de criação/timestamp não existe
  como propriedade nativa do Roblox entre clientes — usei um atributo GUID
  (`SetAttribute` gravado ANTES de `.Parent`) como o dado replicado de
  desempate, comparado lexicograficamente (menor = canônica).
- **Fix em `TeamCreateSchema.luau`**: `getOrCreate` agora escaneia TODOS os
  filhos com o Name+ClassName pedidos (não só `FindFirstChild`, que só acha
  o primeiro) a CADA chamada (não só na criação), e se houver >1: ordena por
  atributo `SyncTeamOrigin` (GUID, gravado na criação — instâncias
  pré-existentes sem o atributo recebem um na primeira reconciliação, com
  fallback de desempate por conteúdo replicado — `.Value` para Values,
  contagem de filhos para Folder — só no caso raríssimo de nenhum candidato
  ainda ter o atributo, `[Hipótese]` não exercitada contra Studio real).
  Merge ANTES de destruir a(s) duplicata(s): Folder → reparenta TODOS os
  filhos pra dentro da canônica (nunca perde sessão/script/lease que nasceu
  por azar sob a pasta "perdedora" — se isso deixar netos com nome repetido
  sob a canônica, a PRÓXIMA chamada de `getOrCreate` para aquele nome
  específico reconcilia de novo, mesmo princípio aplicado recursivamente).
  IntValue → canônica fica com o MAIOR valor entre as duplicatas (contadores
  deste projeto — `LeaderTerm`/`NextJoinSequence`/`NextLeaseRequestSequence`
  — são estritamente crescentes, nunca é retrocesso). StringValue
  (`LeaderClientId`) → sem merge de conteúdo, aceito porque o próprio ciclo
  de eleição reavalia do zero no tick seguinte a partir de `Sessions/` já
  mesclado (autocorrige; custo aceito: pode gerar +1 term "gasto" na
  convergência, nunca viola exclusão mútua de líder).
- **`ensureRoot()` perdeu o cache module-level** (`if rootFolder == nil
  then...`) — esse cache-once era EXATAMENTE a mesma classe de bug (nunca
  reavaliava se uma duplicata aparecia depois). Agora sempre reconsulta
  `TestService:GetChildren()` via `getOrCreate` — barato (poucos filhos),
  chamado a cada pulso (2s), não em hot loop.
- **Fix em `TeamCreateElection.luau`**: `tick()` (não só `start()`) agora
  chama `TeamCreateSchema.ensureRoot()`/`ensureFolder("Sessions")` DE NOVO a
  cada pulso e REATRIBUI `rootValues`/`sessionsFolder` — reconciliar
  duplicatas em `TeamCreateSchema` não adianta nada se quem consome nunca
  atualiza a própria referência cacheada. Regra geral pro projeto: qualquer
  módulo que chama `ensureRoot()`/`ensureFolder()` UMA VEZ em `start()` e
  guarda o resultado numa variável de longa duração precisa reconsultar
  periodicamente (ou a cada uso), não só na inicialização — o mesmo se aplica
  a `TeamCreateLease.luau` (`leasesFolder`/`sessionsFolder`/`rootValues`
  cacheados em `ensureContainers()` com o MESMO guard `if leasesFolder ~=
  nil then return end`) e ao `getOrCreate`/`ensureContainers` PRÓPRIOS desse
  arquivo (não tocados nesta tarefa — risco residual aceito porque, uma vez
  a eleição de líder convergindo corretamente, só o líder ÚNICO escreve em
  `Leases/<uuid>`, o que elimina a corrida cross-Studio nesse caso específico
  — mas se `TeamCreateLease.luau` for revisitado, aplicar o mesmo padrão de
  reconciliação/refresh por consistência).
- **Sem alterar constantes de tempo validadas** (pulso 2s/stale 8s/cleanup
  20s/2 observações) — não foi necessário pra este fix.
- **Adição pequena pedida pelo orquestrador durante a tarefa**: botão de
  toolbar temporário "SyncTeam: Alternar porta (34980/34981)" em
  `plugin/src/init.server.luau`, porque `plugin:SetSetting(...)` não é
  chamável pelo Command Bar do Studio (`plugin` global só existe dentro do
  script do próprio plugin — `attempt to index nil with 'SetSetting'`).
  Alterna entre os dois únicos valores usados nos testes atuais e reconecta
  na hora (`stop()` + `start(plugin)`) — ferramenta de teste, não feature de
  produto.
- Validado só por `rojo build` (binário cacheado, layout ok) + `lune run` em
  `TeamCreateSchema.luau`, `TeamCreateElection.luau`, `init.server.luau` e
  nos dependentes que consomem `TeamCreateSchema` com a mesma assinatura
  (`TeamCreateLease.luau`, `ScriptRegistry.luau`, `SourceWatcher.luau`) — sem
  erro de sintaxe, erro esperado só na primeira linha que toca `game`. **Nada
  testado em Studio real nesta tarefa** — o fix responde a um bug só
  reproduzido em Studio real, mas o próprio fix continua `[Hipótese]` até
  repetir o cenário exato (2 Studios, reload simultâneo) e confirmar
  convergência — roteiro em `docs/PROJECT_STATUS.md`.

## Logger centralizado + forwarding por WS (`plugin/`), 2026-07-07

- **Motivação**: 6 arquivos tinham cada um sua PRÓPRIA `local function log(...)`
  idêntica (`print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), ...)`) — sem
  jeito de o orquestrador/IA ver o log sem o usuário colar o Output do Studio
  manualmente. Novo módulo `plugin/src/Logger.luau` centraliza isso:
  `Logger.log(...)` mantém a chamada `print(prefix, ...)` BYTE-IDÊNTICA à de
  antes (Output do Studio não muda nada) e, se houver `sendMessage` injetado
  via `Logger.init(onMessage)` (mesmo padrão exato de
  `SourceWatcher.init`/`TeamCreateLease.init` — reaproveitado, não inventado),
  encaminha o texto pela MESMA conexão WS já existente como
  `{kind = "log", text = "<string>"}`. Sem fila/buffer: log perdido enquanto
  desconectado é aceitável (objetivo é observabilidade em tempo real de
  teste, não persistência garantida).
- **Padrão de substituição nos 6 arquivos**: `local function log(...) ... end`
  → `require(script.Parent.Logger)` (ou `script.Logger` em
  `init.server.luau`, que é o script raiz) + `local log = Logger.log`. Zero
  mudança de chamador (`log("x", y)` continua igual em todo o resto do
  arquivo) — só a origem da função mudou.
- **Pegadinha de recursão evitada por design (não descoberta por bug)**: em
  `init.server.luau`, `sendMessage` (a função real de envio por WS, que
  `Logger.init` recebe como `onMessage`) tem dois pontos onde loga sobre SI
  MESMA (descartada por falta de conexão; falha ao `client:Send`). Se esses
  dois pontos usassem `log`/`Logger.log` em vez de `print` puro, o ciclo
  seria: `Logger.log` chama `sendMessage` → `sendMessage` falha/descarta →
  loga a falha via `Logger.log` → que chama `sendMessage` de novo → sem saída
  natural (cada tentativa gera uma nova mensagem de log sobre a tentativa
  anterior). **Regra geral pro projeto**: qualquer módulo que seja ao mesmo
  tempo (a) o transporte usado por `Logger.init` E (b) tenha logging interno
  sobre falhas do próprio transporte, esse logging interno específico deve
  usar `print` cru, nunca passar pelo `Logger` — só esse módulo (hoje só
  `init.server.luau`) tem essa restrição; todos os outros `log(...)` do
  projeto podem/devem usar `Logger.log` livremente.
- **Grafo de dependência sem ciclo**: `Logger.luau` não `require`s nenhum
  outro módulo do projeto (só `os.date`/`select`/`tostring`, sem `game`
  nenhum) — por isso é seguro todo módulo (`ScriptRegistry`,
  `TeamCreateSchema`, `TeamCreateElection`, `TeamCreateLease`,
  `SourceWatcher`, `init.server.luau`) `require`-lo sem risco de dependência
  circular.
- **Reconstrução do `text` enviado por WS usa espaço como separador entre
  argumentos** (`prefix .. " " .. tostring(arg1) .. " " .. tostring(arg2)...`,
  via `select("#", ...)`/`select(index, ...)` para não perder argumentos
  `nil` no meio) — é uma reconstrução best-effort do conteúdo, NÃO uma cópia
  do separador exato que o Output do Studio usa internamente para múltiplos
  argumentos de `print` (não verificado/pesquisado nesta tarefa, `[Hipótese]`,
  mas irrelevante: o `print(...)` em si, que é o que aparece no Output, não
  foi alterado nem reformatado — só passou a viver dentro de `Logger.log` em
  vez de duplicado).
- **Validado só por `rojo build` + `lune run` nos 8 arquivos** (7 tocados +
  `Logger.luau` novo) — sem erro de sintaxe; erro esperado só na primeira
  linha que toca `game`/`plugin`. `Logger.luau` roda até o fim SEM NENHUM
  erro no `lune run` (não toca `game` em lugar nenhum) — diferente de todo
  outro módulo do plugin, que sempre erra na primeira linha `game:GetService`.
  **Nada testado em Studio real nesta tarefa** — é infraestrutura de teste
  (o lado que grava em arquivo é tarefa paralela de `extension-dev`), não uma
  feature com roteiro de validação próprio; fica implícito que só será
  exercitada de fato quando os dois lados existirem juntos.

## Auto-descoberta de porta WS (`plugin/`), 2026-07-07

- **Motivação**: teste com 2 Studios na MESMA máquina/MESMA pasta de Plugins
  (2 contas via "Add Account" carregam o mesmo arquivo de plugin) colidia na
  mesma porta mais de uma vez, exigindo clique manual no botão "Alternar
  porta" (M3.1). Pedido do orquestrador: plugin se autodescobre.
- **Critério de "rejeição provável" escolhido — o ponto central da tarefa**:
  NÃO tentei interpretar `code`/`errorMessage` que o evento `Error` do
  `WebStreamClient` recebe para identificar o close code 1013/motivo que o
  harness manda (`socket.close(1013, "SyncTeam: já existe um plugin
  conectado")` em `SyncServer.ts`) — não existe nenhuma entrada em
  `.claude/research/` confirmando o que `CreateWebStreamClient` expõe nesses
  parâmetros para um close code custom do servidor, e a regra do projeto
  proíbe pesquisar API nova direto (a tarefa em si já antecipava esse caso e
  pedia fallback conservador). Critério usado, 100% observação local: a
  conexão caiu (`Closed`/`Error`) **sem nunca ter recebido nenhuma mensagem
  do harness** (nem `MessageReceived` nenhum, nem eco/ack de infra) **E**
  dentro de `Config.PROBABLE_REJECTION_WINDOW_SECONDS` (3s, nova constante,
  não é constante de eleição) desde que o `WebStreamClient` foi criado. Se
  qualquer uma das duas condições falhar (ficou de pé mais que a janela, OU
  recebeu qualquer mensagem antes de cair), é tratada como queda normal e
  reconecta na MESMA porta — comportamento idêntico ao de antes desta
  tarefa. `code`/`errorMessage` continuam só logados (nunca usados pra
  decisão), exatamente como já era.
- **Ciclo de candidatas com dois "atrasos" diferentes**: candidata rejeitada
  → avança pra próxima (`(index % #ports) + 1`) com
  `Config.CANDIDATE_RETRY_DELAY_SECONDS` (0.75s, curto, pra não fazer
  sentido esperar `RECONNECT_SECONDS` inteiro antes de tentar a alternativa
  quando a porta está claramente ocupada por outro Studio); depois de
  `#ports` rejeições seguidas na mesma "volta" (contador `attemptsInLap`),
  volta pro início da lista mas com `RECONNECT_SECONDS` normal (evita
  busy-loop se nenhum harness estiver de pé em porta nenhuma). Uma porta
  explícita (`explicitAtStart == true`, `#ports == 1`) nunca entra nesse
  ramo (`probablyRejected` exige `#ports > 1`) — preserva 100% o
  comportamento anterior (retry na mesma porta) pra quem já tem porta
  setada manualmente.
- **Persistência só de descobertas automáticas**: `persistedAutoPort`
  inicializado como `explicitAtStart` — se a porta já era explícita, NUNCA
  chama `SetSetting` de novo (evita sobrescrever escolha manual/anterior por
  engano, mesmo que o fluxo passasse por ali, o que nem acontece já que
  `#ports == 1` nesse caso). Grava assim que a conexão "estabiliza" (mensagem
  recebida OU `PROBABLE_REJECTION_WINDOW_SECONDS` decorrido sem cair) —
  IMEDIATAMENTE, não espera a conexão cair primeiro, verificado a cada
  `task.wait(0.5)` do loop conectado.
- **`Config.resolveCandidatePorts(pluginObject)`** (novo, ao lado do já
  existente `Config.resolvePort`, que continua igual e é usado pelo botão
  "Alternar porta" pra ler a porta atual): devolve `(lista, explicit)` — lista
  de 1 item + `true` se já há setting válida, senão `Config.CANDIDATE_PORTS`
  + `false`.
- **Botão manual "Alternar porta" mantido sem nenhuma mudança de
  comportamento** — só interage com a auto-descoberta indiretamente (ao
  chamar `SetSetting`, a próxima `start()` vê a porta como explícita e nunca
  mais cicla).
- Validado só por `rojo build` + `lune run` em `Config.luau` e
  `init.server.luau` — sem erro de sintaxe (erro esperado só na 1ª linha que
  toca `game` em `init.server.luau`; `Config.luau` roda até o fim sem erro
  porque o único uso de `game` fica dentro de uma função não invocada no
  parse). **Nada testado em Studio real nesta tarefa** — o critério de
  rejeição provável (3s sem nenhuma mensagem) é `[Hipótese]`: não há como
  confirmar sem 2 Studios reais colidindo de propósito se o harness realmente
  fecha rápido o suficiente (e sem nenhuma mensagem trafegada) pra essa
  janela nunca dar falso-negativo/falso-positivo. Roteiro manual em
  `docs/PROJECT_STATUS.md` (seção "auto-descoberta de porta").

## M4 — Presença: publicar e observar cursor/seleção/arquivo ativo (`plugin/`), 2026-07-15

- **Módulo novo `plugin/src/TeamCreatePresence.luau`**: passthrough puro de
  dados opacos vindos da extensão VS Code — o plugin NUNCA lê cursor de uma
  Instance de Script no Studio (decisão já fechada na tarefa,
  `docs/MILESTONES.md` M4). Espelha a estrutura de `TeamCreateLease.luau`
  quase 1:1: schema/ensure, `init(onMessage)`, `start()`/`stop()` com token de
  geração, ciclo próprio de `task.spawn` a `Config.POLL_INTERVAL_SECONDS`
  (mesma cadência de `checkLeaseDrift`, não `PULSE_INTERVAL_SECONDS` — mesma
  justificativa: sinal de UX quer a responsividade da UI de sincronização,
  não a cadência de heartbeat/eleição).
- **Schema**: `Sessions/<clientId>/Presence/` (`ActiveScriptUuid: StringValue`
  `""=nenhum`, `CursorLine`/`CursorColumn`/`SelectionStartLine`/
  `SelectionStartColumn`: `IntValue` `-1=null`). Nomes e sentinelas EXATOS
  fechados com `ui-dev` — não mudar sem registrar em DECISIONS.md e avisar o
  outro lado. Subpasta owned exclusivamente pela própria sessão (mesmo padrão
  de `LeaseIntents/<uuid>` em `TeamCreateLease`) — nenhuma race de criação
  cross-Studio possível, então o `getOrCreate` local (não-reconciliador, só
  `FindFirstChild`→`Instance.new`) é suficiente, sem precisar do
  `getOrCreate` com reconciliação de duplicatas de `TeamCreateSchema.luau`.
- **Escrita da própria presença é IMEDIATA ao receber `presenceUpdate`**, não
  passa pelo ciclo de poll — só a OBSERVAÇÃO de outras sessões usa o ciclo
  (`checkPresenceDrift`). Assimetria deliberada: escrever é só "gravar o que
  me mandaram" (mesmo espírito de `writeSource`), não há arbitragem entre
  Studios como em leases (que por isso tem ciclo de decisão do líder
  separado).
- **Escrita protegida por `pcall`** (`updateOwnPresence`): os 4 campos
  numéricos vêm de mensagem JSON externa não confiável — `IntValue.Value`
  exige um valor íntegro; um float fracionário do lado JS (bug ou não)
  lançaria erro em vez de degradar. Primeira vez neste projeto que dado
  numérico vindo direto de fora (não gerado localmente) é escrito num
  `IntValue` — todos os outros `IntValue` do schema (`Pulse`,
  `RequestSequence`, `JoinSequence`, `LeaderTerm`) são sempre incrementados/
  atribuídos localmente, nunca recebem valor bruto de mensagem. Regra a levar
  adiante: qualquer FUTURO campo numérico de protocolo escrito direto num
  `IntValue`/`IntValue`-like deveria seguir o mesmo cuidado de `pcall`.
- **Dedupe por chave composta (string concatenada dos 5 campos)**, não por
  tabela — Lua compara tabelas por referência, não por valor, então uma
  tabela nova a cada leitura nunca seria `==` à anterior mesmo com os mesmos
  campos. Chave: `uuid|cursorLine|cursorColumn|selStartLine|selStartCol`
  (sentinelas crus, antes de converter pra `null`) — mesmo princípio do
  `NO_OWNER_KEY` de `TeamCreateLease.checkLeaseDrift`, estendido a múltiplos
  campos via concatenação simples em vez de introduzir alguma lib de
  comparação estrutural.
- **`presenceLeft` tem DOIS gatilhos, não um só** — decisão de design que a
  tarefa deixava implícita, não 100% explícita: (a) a sessão observada ZEROU
  a própria presença (`ActiveScriptUuid` virou `""`) — detectado dentro do
  loop principal de `checkPresenceDrift`, mesma passada que detectaria um
  `presenceChanged`; (b) a sessão SUMIU inteira de `Sessions/` (Folder
  destruído, via `stop()` síncrono do dev remoto — medido em ~3s no M3.1 — ou
  via `cleanupStaleSessions` do líder após 20s) — detectado numa segunda
  passada comparando o snapshot da rodada (`seenThisCycle`) contra
  `lastPresenceByClientId`. **Não reimplementei nenhuma checagem própria de
  staleness/Pulse de sessão aqui** — confio inteiramente no ciclo de vida já
  existente da sessão (`TeamCreateElection`) para o Folder eventualmente
  desaparecer; mesmo espírito de `checkLeaseDrift`, que também não duplica
  staleness de sessão (RojoCoop fazia essa checagem dupla em
  `__readLiveIntents`; decisão deliberada de não duplicar, aqui e lá).
- **Baseline na primeira observação de um `clientId`** (mesmo princípio já
  decidido e documentado para `leaseChanged` em `TeamCreateLease`): só grava,
  nunca emite — evita rajada de mensagens para presença já existente no
  momento em que este Studio conecta. Aplica-se tanto a `presenceChanged`
  quanto a `presenceLeft`.
- **`describeClient` duplicado** (não reusa `TeamCreateLease.describeClient`)
  para não criar dependência cruzada entre os dois módulos só por ~5 linhas
  de lookup de `Username` — mesmo raciocínio já registrado em DECISIONS.md
  (2026-07-04) para `ScriptRegistry.reconcile`/`findRegistryEntryFor`.
- **Deletar a chave ATUAL de uma tabela durante a própria iteração de
  `pairs` sobre ela é seguro em Lua** (só inserir chaves NOVAS durante a
  travessia é comportamento indefinido) — usado no loop de "sessão sumiu"
  (`for clientId in lastPresenceByClientId do ... lastPresenceByClientId[clientId] = nil ... end`).
  Diferente do cuidado de snapshot em `ScriptRegistry.forEach` (que existe
  porque ali o callback do CHAMADOR podia remover uma chave DIFERENTE da que
  estava sendo iterada) — aqui só a própria chave da iteração corrente é
  removida, então não precisou de snapshot.
- **Pegadinha de validação do `lune run` neste módulo especificamente**: como
  `TeamCreatePresence.luau` não usa `HttpService`/nenhum `game:GetService`
  (não gera GUID nenhum — presença não tem `LeaseId`/`IntentId` equivalente),
  o primeiro global do Roblox tocado no arquivo é `script` (na linha
  `require(script.Parent.Config)`), não `game`. O erro esperado no `lune run`
  saiu como `attempt to index nil with 'Parent'` em vez do
  `attempt to index nil with 'GetService'` visto em todo outro módulo do
  plugin (que sempre tem `local HttpService = game:GetService(...)` como
  primeira linha real). Mesma categoria de erro esperado (primeira linha que
  toca um global inexistente no sandbox do `lune`, prova que tudo antes
  parseou sem erro de sintaxe) — só a propriedade indexada muda
  (`.Parent` de `script` vs. `.GetService` de `game`). Registrar para não
  confundir uma sessão futura que espere sempre literalmente "GetService" no
  texto do erro.
- **Integração em `init.server.luau`**: `require(script.TeamCreatePresence)`
  junto dos outros; dispatch de `presenceUpdate` em `handleMessage` (sem
  ack/requestId, espontânea — chama só `TeamCreatePresence.updateOwnPresence`
  e retorna); `TeamCreatePresence.init(sendMessage)` + `.start()` em `start()`
  DEPOIS de `TeamCreateElection.start()` (mesma dependência de
  `getSessionFolder()`/`getClientId()` que `TeamCreateLease` já tinha);
  `TeamCreatePresence.stop()` em `stop()` ao lado de `TeamCreateLease.stop()`,
  antes de `TeamCreateElection.stop()` (mesma disciplina "parar o que depende
  antes do que é dependido", ordem não estritamente necessária aqui já que
  `stop()` só limpa memória, mas mantém consistência com o resto do arquivo).
- **Validado só por `rojo build` + `lune run`** em `TeamCreatePresence.luau`
  (novo) e `init.server.luau` — sem erro de sintaxe, erro esperado só na
  primeira linha que toca `script`/`game` (ver nuance acima). **Nada testado
  em Studio real nesta tarefa** — não é escopo pedido (o lado espelhado da
  extensão, que consome `presenceChanged`/`presenceLeft` e envia
  `presenceUpdate`, é trabalho paralelo do `ui-dev`; teste real combinado com
  2 Studios fica para quando os dois lados existirem juntos, mesmo padrão já
  seguido em M3.3). Sem roteiro manual isolado desta fatia por esse motivo —
  quando o `ui-dev` terminar, o roteiro combinado deve cobrir: (1) mover
  cursor/seleção no VS Code de A aparece em B em ~2s (alvo de latência do M4,
  `docs/MILESTONES.md`); (2) trocar de arquivo ativo em A limpa a presença
  antiga e publica a nova; (3) fechar o editor/arquivo em A emite
  `presenceLeft` em B; (4) fechar o Studio de A (ou a extensão) emite
  `presenceLeft` em B mesmo sem `presenceUpdate` explícito de limpeza (via o
  gatilho "sessão sumiu").

## Heartbeat WS: `pong` + detecção de conexão morta por silêncio (`plugin/`), 2026-07-15

- **Bug real que motivou (reportado pelo usuário)**: após "Reload Window" do
  VS Code, o processo da extensão morre SEM enviar frame de close WS, e o
  painel do plugin ficava mostrando "conectado" (botão DISCONNECT) por muito
  tempo — porque a detecção de queda dependia só de `Closed`/`Error` do
  `WebStreamClient`, que podem NÃO disparar quando o servidor morre sem avisar.
  Mesma classe de "sinal não confiável, precisa de caminho garantido" já vista
  em `Source.Changed`/`scriptRemoved`/heartbeat de sessão — aqui o caminho
  garantido é o SILÊNCIO (ausência de mensagens), não polling de uma
  propriedade.
- **Lado extensão (já feito por `extension-dev`, 127 testes)**: manda
  `{kind:"ping"}` a cada 5s enquanto conectada; se ela mesma ficar 15s sem
  receber NENHUMA mensagem do plugin, derruba a conexão (`socket.terminate()`).
- **Item 1 — responder ping**: `handleMessage` em `init.server.luau` ganhou
  `elseif message.kind == "ping"` → `sendMessage({ kind = "pong" })`,
  imediatamente, no MESMO dispatch de `writeSource`/`readSource`/
  `presenceUpdate`. Sem `requestId`, sem estado — é só liveness. Mensagens
  `ping`/`pong` são ADITIVAS: **NÃO bumpei `PROTOCOL_VERSION`** (continua 2),
  conforme a tarefa.
- **Item 2 — timeout escolhido: `Config.DEAD_CONNECTION_TIMEOUT_SECONDS = 20`
  (não 15).** A extensão pinga a cada 5s e se auto-derruba a 15s; escolhi 20s
  (= 4 intervalos de ping) do lado do plugin para dar 1 ping de folga sobre o
  timeout da extensão — evita teardown falso por UM único ping atrasado/
  perdido, ao custo de no máximo ~5s a mais exibindo "conectado" após uma
  queda real (irrelevante perto do bug original, que era "muito tempo"). A
  tarefa deixava a escolha entre "15s ou um pouco mais de folga" aberta e
  pediu para documentar — está no comentário longo da constante em
  `Config.luau` também.
- **Onde/como reaproveitei o rastreamento de "última mensagem recebida"**:
  `runConnection` já tinha `local receivedAnyMessage = false` (booleano, usado
  pelo heurístico de auto-descoberta de porta e pela estabilização) e
  `connectedAt = os.clock()`. **Estendi** — não dupliquei — adicionando
  `local lastMessageAt = connectedAt` (o QUANDO, além do SE) e, no ÚNICO ponto
  que já marcava atividade (o handler de `MessageReceived`), passei a setar
  também `lastMessageAt = os.clock()` ao lado do `receivedAnyMessage = true`
  que já existia. Como o dispatch inteiro (inclusive o novo `ping`) passa por
  esse mesmo handler, **receber `ping` conta automaticamente como atividade**
  (item 3) — nada é filtrado da contagem de vida. Inicializei `lastMessageAt`
  em `connectedAt` (não em 0) para que o silêncio conte desde a abertura da
  conexão, não desde a época Unix.
- **Onde a checagem roda**: dentro do loop interno "conectado"
  (`while ... and not closed do task.wait(0.5)`), logo após o `task.wait(0.5)`
  que já existia — mesma cadência de 0.5s, sem thread nova. Se
  `os.clock() - lastMessageAt >= DEAD_CONNECTION_TIMEOUT_SECONDS`, loga e faz
  **só `closed = true`** — EXATAMENTE o que os handlers de `Closed`/`Error` já
  fazem. Isso cai no MESMO teardown (disconnect das conexões + `newClient:Close()`
  já existentes logo abaixo do loop) e no MESMO ciclo de reconexão, que por sua
  vez já repõe o painel em `"connecting"` sozinho (`PluginUI.setConnectionStatus`
  não foi duplicado). Não usei `continue`: deixar a iteração corrente terminar
  inócua e o `while` encerrar na próxima checagem de condição é o timing
  IDÊNTICO ao de um `Closed` que dispara durante o `task.wait` — mais fiel ao
  caminho existente e evita a pegadinha de `continue` pular declaração de local.
- **Efeito colateral desejável (não pedido, mas coerente)**: como uma conexão
  que recebeu pings tem `hasStabilizedOnce == true`, o teardown por silêncio
  cai no toast já existente `"conexão com a extensão VS Code perdida; tentando
  reconectar..."` (Logger.notify) — o usuário é avisado da queda em vez de só
  ver o botão mudar de cor. Se a conexão nunca recebeu nada (silêncio total 20s
  sem nenhum ping/mensagem), `hasStabilizedOnce` fica false e não há toast —
  também correto (é o cenário "nunca conectou de verdade").
- **Validado só por `rojo build` + `lune run`** em `Config.luau` e
  `init.server.luau` — `Config.luau` roda até o fim sem erro (uso de `game` só
  dentro de função não invocada); `init.server.luau` erra na linha 45
  (`game:GetService`), a 1ª que toca `game`, provando que todo o código novo
  (bem abaixo) parseou sem erro de sintaxe. **Não testado em Studio real nesta
  tarefa (pendente)** — roteiro para o usuário: (1) conectar plugin+extensão,
  confirmar painel "conectado"; (2) dar "Reload Window" no VS Code; (3)
  confirmar que em ~20s o log emite "sem mensagens da extensão há 20s..." e o
  painel volta a "connecting"/reconecta, SEM depender de `Closed`/`Error`
  terem disparado. `[Hipótese]` até esse ciclo real: que 20s nunca dá
  falso-positivo com a extensão viva (depende de o ping de 5s chegar com
  folga) e que o teardown por `closed=true` + `newClient:Close()` de fato
  libera o cliente para a reconexão na mesma porta.

## Rejeição de porta por sinal explícito `connectionRejected` (`plugin/`), 2026-07-15

- **Motivação**: `WebStreamClient.Closed` não tem parâmetro nenhum (close code
  nem reason) — confirmado pela pesquisa
  `.claude/research/2026-07-15-webstreamclient-close-code.md`. Então o plugin
  nunca sabe pelo protocolo WS que uma queda foi "porta ocupada por outro
  Studio". Fix cross-time: a extensão passou a mandar uma MENSAGEM DE
  APLICAÇÃO `{kind:"connectionRejected", reason:"port_in_use"}` (chega no
  `MessageReceived` normal) ANTES de fechar o WS de um 2º cliente rejeitado.
- **Onde encaixei a lógica de candidatas/heurística de rejeição** (o que a
  tarefa pediu para registrar): tudo vive em `plugin/src/init.server.luau`,
  função `runConnection`. A heurística de tempo é `local probablyRejected =
  (not receivedAnyMessage) and aliveSeconds <
  Config.PROBABLE_REJECTION_WINDOW_SECONDS and #ports > 1`, logo DEPOIS do
  teardown do cliente (disconnect das conexões + `newClient:Close()`), ANTES do
  `if probablyRejected then` que avança de candidata (`(index % #ports) + 1`,
  atraso `CANDIDATE_RETRY_DELAY_SECONDS`) vs. o `else` de reconexão normal
  (`RECONNECT_SECONDS`). Não removi essa heurística — ADICIONEI o sinal
  explícito como caminho confirmado: `local rejected = connectionRejected or
  ((not receivedAnyMessage) and aliveSeconds < ...janela)` e `probablyRejected
  = rejected and #ports > 1`. A heurística de tempo virou o FALLBACK para
  extensão antiga sem o fix.
- **Pegadinha central que só o código (não a pesquisa) revelou**:
  `connectionRejected` chega como MENSAGEM, então o handler de
  `MessageReceived` seta `receivedAnyMessage = true`. Isso tem DOIS efeitos
  ruins se não tratado: (a) quebraria o critério `not receivedAnyMessage` da
  heurística de tempo (por isso o sinal explícito dispensa esse critério); e
  PIOR (b) `stabilized = receivedAnyMessage or ...` viraria true → o bloco `if
  not persistedAutoPort and stabilized` faria `SetSetting(PORT_SETTING_KEY,
  port)` **PERSISTINDO a porta OCUPADA como porta descoberta** — bug real
  evitado. Fix: `stabilized` ganhou guarda `not connectionRejected and (...)`.
  Também guardei `hasStabilizedOnce` com `and not connectionRejected` (senão o
  toast genérico "conexão perdida" dispararia junto com o toast específico de
  porta ocupada). **Regra geral**: qualquer sinal que a extensão mande como
  mensagem de aplicação para SINALIZAR uma queda iminente precisa ser excluído
  explicitamente de toda contagem de "a conexão funcionou" (`stabilized`,
  `hasStabilizedOnce`, persistência de porta) — receber a mensagem não é a
  conexão estar viva.
- **Flags module-level (não locals de `runConnection`)** porque `handleMessage`
  é função module-level (dispatch genérico) e não enxerga os locals do loop:
  `connectionRejected` (setada em `handleMessage`, lida em `runConnection`,
  RESETADA `= false` no topo de cada iteração do loop de `runConnection` antes
  de conectar o `MessageReceived` — senão vaza rejeição de tentativa
  anterior), `activePort` (porta em curso, setada no topo do loop, usada só
  para o texto do toast), `lastRejectedPortToasted` (dedupe).
- **Texto EXATO do toast** (`Logger.notify`, não `Logger.log` — vira toast
  visível via `PluginUI.notify`): `("porta %d já está em uso por outro
  Studio"):format(activePort or 0)`. Chamado na branch `elseif message.kind ==
  "connectionRejected"` de `handleMessage`.
- **Dedupe do toast por porta** (decisão minha, NÃO pedida na tarefa —
  flagged ao orquestrador): o Toast (`plugin/src/ui/Toast.luau`) é
  single-instance e um novo `show()` reinicia texto+tween+timer de 5s. Sem
  dedup, uma porta EXPLÍCITA ocupada reconecta a cada `RECONNECT_SECONDS` (3s <
  5s de hold) → `connectionRejected` a cada ciclo → toast permanente que o ✕
  não consegue fechar (volta em 3s). `lastRejectedPortToasted` guarda a última
  porta toastada; toast só se `~= activePort`, senão só `log`. Reset `= nil`
  em `stop()` e quando uma conexão real estabiliza (bloco `if stabilized and
  not shownConnected`) — para que reencontrar a mesma porta ocupada depois
  volte a avisar. Mesma disciplina anti-spam já registrada para
  `outageToasted`/`hasStabilizedOnce`.
- **Comportamento por cenário**: porta explícita (`#ports==1`) +
  `connectionRejected` → `probablyRejected` false (exige `#ports>1`) →
  reconexão normal `RECONNECT_SECONDS` na MESMA porta, mas agora com o toast
  já explicando o motivo (item 2 da tarefa: usuário decide trocar de porta no
  painel). Lista de candidatas (`#ports>1`) + `connectionRejected` →
  `probablyRejected` true → avança direto pra próxima candidata (mesmo caminho
  da heurística de tempo), sem esperar a janela de 3s.
- **`reason` só tem "port_in_use" definido hoje** — a flag/toast assumem esse
  motivo. Se surgir outro `reason` (ex.: mismatch de versão), avançar
  candidatas não faria sentido: revisitar a branch para ramificar por `reason`
  antes de generalizar.
- **Validado só por `rojo build` (7.7.0 cacheado) + `lune run`** em
  `init.server.luau` — build EXIT 0; `lune run` erra em `init.server:45`
  (`game:GetService`, 1ª linha que toca `game`), provando que TODO o arquivo
  compilou sem erro de sintaxe (Luau compila o chunk inteiro antes de
  executar). Nenhum outro arquivo tocado. **Não testado em Studio real
  (pendente)** — roteiro para 2 Studios reais na mesma máquina/porta: (1)
  Studio A conecta numa porta; (2) Studio B tenta a MESMA porta explícita →
  confirmar toast "porta N já está em uso por outro Studio" UMA vez + log de
  rejeição repetida nos ciclos seguintes, botão nunca pisca "connected", porta
  ocupada NUNCA é persistida; (3) com lista de candidatas, B pula direto pra
  próxima porta livre em vez de esperar a janela de 3s. `[Hipótese]` até isso.

## Investigação de "Too many WebStreamClients" reportado pelo usuário, 2026-07-15

- **Bug relatado**: Studio preso em loop `falha ao criar cliente WS (Too many
  WebStreamClients active...)`, usuário relatou que acontecia
  "especificamente ao usar portas diferentes". Suspeita inicial: vazamento
  novo introduzido pelo branch de avanço rápido via `connectionRejected` ou
  pelo timeout de heartbeat (`DEAD_CONNECTION_TIMEOUT_SECONDS`), ambos
  adicionados na mesma sessão.
- **Investigação (releitura completa de `runConnection`, linha a linha,
  rastreando a ÚNICA chamada de `CreateWebStreamClient` do projeto inteiro
  contra TODO caminho de saída do loop "conectado")**: **nenhum bug de lógica
  encontrado.** O teardown (`for connection in connections do
  connection:Disconnect() end` + `pcall(newClient:Close())`, linhas ~506-513)
  roda de forma INCONDICIONAL logo após o `while` "conectado" terminar,
  qualquer que seja o motivo (`Closed`/`Error` nativo, timeout de heartbeat
  setando só `closed=true`, ou queda por `connectionRejected` que também passa
  pelo `Closed` nativo do protocolo) — e esse teardown SEMPRE roda antes de
  qualquer possibilidade de looping (criar cliente novo) ou `return`. O branch
  de avanço de candidata (heurística de tempo OU `connectionRejected`
  confirmado) só decide o PRÓXIMO índice/delay DEPOIS do teardown já ter
  fechado o cliente atual — nunca antes. `stop()` fecha o `client` (var
  module-level) de forma síncrona independente da coroutine de
  `runConnection`; se essa coroutine acordar depois, ela só faz um
  `Close()` redundante em objeto já fechado, sempre dentro de `pcall` — não é
  vazamento, é no-op inofensivo.
- **Conclusão/hipótese mais provável, não uma correção de código**: o
  travamento real observado é explicado por ACÚMULO de reloads repetidos do
  plugin durante uma sessão de teste (build+deploy manual do
  `Tools/build-and-deploy-plugin.sh`, facilmente 10+ vezes numa sessão),
  somado ao ciclo de auto-descoberta de porta (que já existia antes desta
  sessão, `Config.CANDIDATE_PORTS`) gerando MAIS tentativas de conexão (logo
  mais objetos `WebStreamClient` criados e fechados) por sessão de teste do
  que um uso normal de produto — não uma condição de corrida nova introduzida
  pelos dois recursos desta sessão (heartbeat/`connectionRejected`). **Não
  apliquei nenhum fix** porque nenhum caminho de código com vazamento real foi
  encontrado — inventar uma mudança sem bug identificado só arriscaria
  regressão. Se o sintoma reaparecer especificamente após MUITOS reloads
  seguidos em curto espaço de tempo (não após uso normal), é consistente com
  esta hipótese (latência do próprio Studio para finalizar a liberação interna
  do socket, fora do controle do código Luau, que já fecha tudo
  sincronicamente do lado dele). `[Hipótese]` — não há como confirmar sem
  reproduzir de novo com contagem exata de reloads/tentativas, e a regra do
  projeto proíbe pesquisar internals do Studio sem research salvo. Ação
  recomendada ao usuário: reabrir o Studio (já feito a pedido do orquestrador)
  libera os 6 clientes presos; se reaparecer fora de um cenário de MUITOS
  reloads em sequência, revisitar esta conclusão.
- Nenhum arquivo alterado nesta investigação (não havia bug para corrigir) —
  `rojo build`/`lune run` não re-executados por não haver diff.

## Troca de porta pelo painel matava a própria conexão (reentrância de FocusLost), 2026-07-16

- **Bug real com log**: trocar a porta no painel (1401->1405) conectava com
  sucesso (`conectado em ws://127.0.0.1:1405`) e ~40ms depois rodava um
  `stop()` COMPLETO da MESMA sessão recém-criada (mesmo clientId), matando a
  conexão. **Causa raiz CONFIRMADA por leitura** (não refutada): o único guard
  contra repetição de troca era `newPort ~= state.port()` DENTRO de
  `PortRow.FocusLost` (`ui/StatusPanel.luau`), mas ele NÃO é seguro contra
  reentrância — `state.port()` (=`portSource` em `PluginUI.luau`) só é
  atualizado de forma ASSÍNCRONA por `PluginUI.setPort`, chamado dentro de
  `runConnection` (já no novo `start()`, linha ~369). `FocusLost` de `TextBox`
  tem quirk conhecido de disparar mais de uma vez pro mesmo Enter/perda de
  foco; o 2º disparo lê `state.port()` AINDA ANTIGO (1401) contra
  `portBox.Text` já NOVO (1405), passa pelo guard e dispara um 2º
  `onPortChange` -> 2º `stop()+start()` -> o `stop()` mata a sessão/conexão que
  o 1º `start()` acabou de criar. Guard baseado em estado atualizado
  assincronamente nunca serve como proteção de reentrância de evento síncrono.
- **Fix (só em `init.server.luau`, callback `onPortChange`)**: duas camadas
  module-level complementares. (a) `portChangeInFlight` — enquanto o
  `stop()+start()` de uma troca ainda roda (start() pode yieldar internamente),
  uma 2ª chamada é ignorada (protege reentrância por yield). (b) dedupe por
  VALOR+TEMPO (`lastPortChangeValue`/`lastPortChangeAt`,
  `PORT_CHANGE_DEDUPE_SECONDS = 1`) — 2ª chamada com o MESMO `newPort` em <1s é
  ignorada mesmo depois da flag baixar, cobrindo a janela entre `start()`
  retornar (flag=false) e `runConnection` de fato chamar `setPort` (exatamente
  quando o guard do PortRow falha). `lastPortChangeAt` é REINICIADO no FIM do
  `stop()+start()` para a janela contar a partir daí.
- **Pegadinha resolvida no fix**: `stop()`/`start()` originalmente NÃO estavam
  em pcall. Se algum deles lançasse, `portChangeInFlight` ficaria travado em
  `true` PARA SEMPRE (bug pior que o corrigido — bloquearia toda troca de porta
  futura). Envolvi `stop()+start()` num pcall só para GARANTIR que a flag
  sempre baixa; o erro continua logado, não engolido. Mesma disciplina aplicada
  ao early-return de falha de `SetSetting` (libera a flag antes de sair).
- **NÃO toquei em `ui/StatusPanel.luau`**: o `PortRow` fica como está; a
  correção é do lado do dono da lógica de conexão (`init.server.luau`), que é
  quem tem o estado module-level para deduplicar. Notei um efeito cosmético
  secundário no PortRow (`portBox.Text = tostring(state.port())` pode reverter
  brevemente para a porta antiga se `setPort` ainda não rodou), mas se
  autocorrige no próximo refresh reativo e não é o bug reportado — deixado como
  está.
- Validado por `rojo build` (limpo, `Built project to ...rbxm`) + `lune run`
  em `init.server.luau` (para na linha 45 `game:GetService`, o marcador
  esperado de "parseou/executou sem erro de sintaxe"). **Não testado em Studio
  real nesta tarefa** — pendente do usuário: trocar a porta pelo painel e
  confirmar que a conexão nova SOBREVIVE (nenhum `stop()` do clientId
  recém-criado ~40ms depois), e que uma troca legítima subsequente (porta
  diferente) ainda funciona apesar do dedupe.

## Limpeza de prints de debug + guard de Run/Play (F8/F5), 2026-07-16

- **Auditoria de `print()` cru em `plugin/src/` (init.server.luau, Config.luau,
  Logger.luau, SourceWatcher.luau, TeamCreateElection.luau,
  TeamCreateLease.luau, TeamCreateSchema.luau, TeamCreatePresence.luau,
  ScriptRegistry.luau, ui/*.luau): nada para remover.** `grep -rn "print("`
  recursivo só achou 2 arquivos: `Logger.luau` (o próprio canal oficial de
  log — `print(prefix, ...)` dentro de `renderPrintAndForward`, é o Logger em
  si, não um debug esquecido) e `init.server.luau` (dois `print()` dentro de
  `sendMessage`, já documentados no próprio arquivo desde 2026-07-07 como
  exceção deliberada anti-recursão: se usassem `Logger.log`, uma falha de
  envio disparia Logger.log -> sendMessage -> falha -> log via Logger.log ->
  sendMessage de novo, sem saída natural do ciclo). Nenhum print achado sem
  justificativa documentada — não houve conversão para `Logger.info` porque
  não havia nada "órfão" carregando informação útil sem canal.
- **Guard de Run/Play (F8 Run / F5 Play) em `plugin/src/init.server.luau`**:
  confirmado por `.claude/research/2026-07-16-runservice-isstudio-isrunning-plugin-detect-test.md`
  que `RunService:IsStudio()` sozinho NÃO distingue edição de teste (fica
  `true` nos dois); condição correta = `RunService:IsStudio() and not
  RunService:IsRunning()`. Implementado com um loop `task.spawn` PRÓPRIO
  (independente de `enabled`/`currentToken`, porque precisa detectar o
  retorno à edição mesmo desconectado) que faz polling a
  `Config.POLL_INTERVAL_SECONDS` (reaproveitado, não criei timer novo) via
  `checkRunModeTransition()`: ao detectar a transição edição->Run/Play,
  chama `stop()` e marca `runGuardStoppedSync = true`; ao detectar a
  transição de volta, só chama `start(plugin)` de novo SE foi este guard
  quem parou (não reativa se o usuário tinha desconectado manualmente antes
  do F8/F5). Estado inicial (`wasInRunOrPlayMode`) já nasce lendo
  `RunService:IsRunning()` no load do módulo, e o auto-start no fim do
  arquivo ganhou a mesma checagem (não inicia automaticamente se o script
  carregar já em modo Run/Play — caso raro, ex. reinstalação do plugin com
  teste já rodando). Loop desligado via `plugin.Unloading` (nova conexão,
  flag `runModeMonitorEnabled = false`).
- **Limitação conhecida e aceita, documentada em vez de "resolvida"**: doc
  oficial diz que `IsRunning()`/`IsEdit()` ficam AMBOS `false` quando o teste
  está PAUSADO — este guard pode falso-negativo e retomar o sync durante uma
  pausa de teste (achando que voltou pra edição). Não tentei mitigar com
  hack (ex.: monitorar Selection/outro evento) porque a pesquisa não
  encontrou confirmação de comportamento real de plugin nesse caso
  específico — registrado como limitação em docs/DECISIONS.md 2026-07-16,
  não código defensivo especulativo.
- Validado só por `rojo build` (limpo) + `lune run` em `init.server.luau`
  (para na linha esperada `game:GetService`, sem erro de sintaxe antes
  disso). **Nada testado em Studio real** — a transição de fato ao apertar
  F8/F5 (stop()/start() disparando, timing do polling, e o caso de pause)
  fica `[Hipótese]` até o usuário confirmar com Studio real. Sem roteiro
  manual dedicado ainda escrito (tarefa não pediu, e a ação é só "apertar
  F8/F5 com o plugin conectado e observar o Output/painel") — se o usuário
  quiser, um roteiro simples é: (1) conectar normalmente, (2) apertar F8,
  confirmar log "sync suspenso durante o teste" e painel indo para
  desconectado, (3) parar o teste, confirmar log "retomando sync" e nova
  reconexão automática.

## Silenciar "descartado (sem conexão): log" duplicado no boot, 2026-07-16

- **Ruído real reportado pelo usuário via log colado do Output**: nos
  primeiros segundos antes do WS conectar, toda linha de log normal do boot
  (`observação iniciada`, `sessão criada`, `leases: ciclo iniciado`,
  `presença: ciclo iniciado`) vinha seguida de uma linha extra `descartado
  (sem conexão): log` — dobrava a quantidade de linhas. Causa: `sendMessage`
  em `plugin/src/init.server.luau` avisava "descartado" para QUALQUER `kind`
  descartado por falta de conexão, inclusive `kind == "log"` — que é o
  próprio `Logger.log` (`Logger.luau`, `renderPrintAndForward`) se
  auto-encaminhando pela conexão WS. Como o conteúdo já apareceu no Output
  via `print()` dentro do próprio `Logger.log`, o aviso "descartado" pra esse
  `kind` era 100% redundante, nunca informação nova.
- **Fix cirúrgico, um `if` a mais dentro do branch `client == nil` de
  `sendMessage`**: só imprime `"descartado (sem conexão): <kind>"` quando
  `message.kind ~= "log"`. Mensagens de protocolo reais (`scriptAdded`,
  `presenceUpdate`, `leaseChanged`, etc.) continuam avisando normalmente
  quando descartadas sem conexão — isso ainda é sinal útil pra depurar por
  que algo não chegou na extensão. Não toquei no aviso de erro real (`falha
  ao enviar: ...`, branch do `pcall` de `client:Send`) — continua idêntico
  pra qualquer kind, é falha de verdade, não redundância.
- **Por que não mexer em `Logger.luau`**: a causa não é o `Logger.log`
  chamar `sendMessage` demais — é o `sendMessage` decidir logar sobre a
  PRÓPRIA tentativa de encaminhamento de log. Resolver no ponto de origem
  (`init.server.luau`) evita qualquer necessidade de `Logger.luau` saber que
  está se auto-referenciando (o cuidado de recursão já documentado no
  cabeçalho de `Logger.luau` — os dois `print()` de `sendMessage` são puros,
  nunca `Logger.log` — continua intacto e não foi mexido).
- Validado só por `rojo build` (limpo) + `lune run init.server.luau` (para na
  linha esperada `attempt to index nil with 'GetService'`, sem erro de
  sintaxe antes disso). **Nada testado em Studio real** — não precisa: é
  puramente uma condição de `print`, sem lógica de rede/replicação nova pra
  validar; o próprio usuário fecha o loop ao rodar o plugin de novo e ver o
  Output limpo.
