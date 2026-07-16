# Memória do luau-dev

Aprendizados de API do Studio e pegadinhas de Luau encontrados no projeto.
Atualize ao final de cada tarefa; mantenha curto e acionável.

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
