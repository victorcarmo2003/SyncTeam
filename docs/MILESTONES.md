# Marcos

Cada marco tem critérios de aceite objetivos. Validações com Team Create exigem
dois Studios reais (duas contas/máquinas).

## M0 — Validar a hipótese central (go/no-go)

Replicação de conteúdo e transporte local, antes de qualquer produto.

- [x] `[Verificado 2026-07-03]` Source escrito por plugin no Studio A aparece
      no Studio B via Team Create — inclusive criação do script e conteúdo
      inicial. Ver `logs-livetest/` e `docs/PROJECT_STATUS.md`.
- [x] `[Verificado 2026-07-03]` Studio B observa a chegada de forma confiável
      via sinal (`GetPropertyChangedSignal("Source")`) — nenhum fallback de
      polling necessário nesse teste (nuance: parece ser específico de
      receber replicação, ver PROJECT_STATUS.md).
- [ ] Testado com Drafts mode ligado e desligado; comportamento documentado
      (teste de 2026-07-03 não determinou o estado real do Drafts Mode —
      `DraftsService` não pôde ser lido por falta de capability).
- [ ] Latência medida de forma confiável (a medição de 2026-07-03 foi
      contaminada por um bug de múltiplos loops de Escritor concorrentes —
      repetir depois do fix).
- [ ] Escrita em script **aberto no editor** do Studio remoto não perde/corrompe
      (ainda não testado).
- [ ] `CreateWebStreamClient` conecta a um servidor WS Node em localhost e troca
      mensagens nos dois sentidos (revalidação no contexto SyncTeam).
- Ferramenta: `spikes/m0-source-replication/`.
- **Go/no-go: GO.** Replicação de Source via Team Create funciona e é
  observável no Studio remoto. Itens restantes (Drafts, script aberto,
  latência limpa) são refinamento, não bloqueiam avançar ao M1 em paralelo.

## M0.5 — Pipeline local com 1 Studio (testável pelo Claude)

Simula dois "VS Codes" via duas portas locais (canais A/B) com um único Studio
no meio. Valida transporte, protocolo e escrita/observação de Source **sem**
depender de duas máquinas. Não substitui o M0 (Team Create real).

- [x] `[Verificado 2026-07-03]` Plugin Lab conecta às duas portas com
      reconexão automática — confirmado ao derrubar e subir o harness:
      reconectou em <1s e rodou os 6 cenários de novo, 0 falhas.
- [x] `[Verificado 2026-07-03]` writeSource pelo canal A aplica no DataModel e
      `sourceChanged` chega ao canal B com conteúdo idêntico: 167ms.
- [x] `[Verificado 2026-07-03]` Sentido inverso (B → A): 166ms.
- [ ] Edição manual no editor do Studio gera `sourceChanged origin=studio`
      (mesmo caminho de código do polling já testado; não testado por dedo
      humano ainda — pendente se quisermos o critério 100% fechado).
- [x] `[Verificado 2026-07-03]` Escrita concorrente no mesmo script
      documentada (informativo): sem coordenação, a última escrita física
      venceu (motiva as leases do M3).
- Ferramenta: `spikes/m0_5-local-pipeline/` (plugin + harness Node).
- **Achado que virou correção permanente**: a detecção só por
  `GetPropertyChangedSignal("Source")` após `ScriptEditorService:UpdateSourceAsync`
  não é confiável (dado grava certo, sinal não dispara). Fix: polling (0.5s)
  como caminho garantido, sinal como fast-path — ver docs/DECISIONS.md.

## M1 — Ponte local mínima (1 dev)

Objetivo: pegar o que os spikes M0/M0.5 já validaram (transporte WS,
detecção de Source por polling+sinal, convenção real de nomenclatura Rojo) e
transformar em produto real — `plugin/` e `vscode-extension/` — para **um
desenvolvedor só**, sem coordenação de time (isso é M3).

**Decisão de arquitetura**: o plugin é "burro"/genérico — observa um
conjunto fixo de containers de script comuns (`ServerScriptService`,
`StarterPlayerScripts`, `ReplicatedStorage`, `ServerStorage`, `StarterGui`,
`Workspace`) recursivamente por `Script`/`LocalScript`/`ModuleScript`, e
reporta o **caminho completo no DataModel** (ex.: `ServerScriptService/Foo/Bar`).
A extensão é quem sabe ler o `default.project.json` (pontos de montagem
`$path`) e traduzir entre caminho no DataModel e caminho em disco pela
convenção Rojo — reaproveitando `rojo-path-mapping.mjs` (já testado no
M0.5). Caminhos fora de qualquer ponto de montagem configurado são
ignorados pela extensão. Motivo: não precisa de handshake
"extensão diz ao plugin o que observar" nesta fase; simplifica o plugin.

### Fatias de entrega

1. [x] `[Verificado 2026-07-04]` `plugin/` (Rojo-buildável): porta de
       `SyncTeamLab.lua` + `SyncTeamM0.lua` — cliente WS,
       `checkSourceChanged` (polling+sinal), handlers
       `writeSource`/`readSource`/`listScripts` (com `className`),
       observação genérica dos containers listados acima. Sem
       `TestService.SyncTeam` ainda (isso é M3). `rojo build` limpo e
       conectou de verdade num Studio real (ver item 4-7 abaixo).
2. [x] `[Verificado 2026-07-04]` `vscode-extension/` (TypeScript/esbuild/vitest):
       servidor WS local, parser de `default.project.json` (pontos de
       montagem `$path`), módulo de mapeamento de caminho (porta de
       `rojo-path-mapping.mjs`), pull inicial Studio→disco, watcher de
       arquivos local→Studio. 42/42 testes, typecheck e build limpos.
3. [x] `[Verificado 2026-07-04]` Handshake versionado: plugin envia
       `protocolVersion:1` no `hello`; extensão valida e rejeita mismatch
       com log claro; testado com plugin real conectando (aceito) e uma
       segunda conexão simultânea (corretamente rejeitada — M1 é 1 dev só).
4. [x] `[Verificado 2026-07-04]` Pull inicial Studio→disco testado com
       Studio real: 46 scripts padrão do Roblox (câmera/controles) e um
       script de outro spike, todos fora dos pontos de montagem, foram
       corretamente ignorados (nenhum arquivo espúrio criado).
5. [x] `[Verificado 2026-07-04]` Edição local → Studio testada com Studio
       real: editar/criar `src/server/Main.server.luau` e
       `src/client/Main.client.luau` criou `ServerScriptService/Server/Main`
       (Script) e `StarterPlayer/StarterPlayerScripts/Client/Main`
       (LocalScript) no Studio, via `UpdateSourceAsync`.
6. [x] `[Verificado 2026-07-04]` Studio → disco testado com Studio real:
       reiniciar a sincronização (nova conexão) recriou os dois arquivos a
       partir do Studio, com **conteúdo byte-a-byte idêntico** ao que foi
       enviado — round-trip fechado.
7. [x] `[Verificado 2026-07-04]` Depois do round-trip completo pela ponte,
       `rojo build` no `spikes/m1-test-project/` continuou funcionando sem
       erro.

**M1 fechado.** Testado com o motor real da extensão (não fakes/mocks) via
`vscode-extension/tools/run-node-harness.ts` — um harness Node que instancia
os mesmos módulos de produção (`SyncServer`/`SyncTeamService`/`SyncBridge`)
com `NodeDiskIO` em vez de `VscodeDiskIO`, contra um Studio real com o
plugin de produção instalado. Não substitui testar a extensão de dentro do
VS Code de verdade (Extension Development Host) — ainda pendente, não
bloqueia seguir para M2.

**Lacuna conhecida, não bloqueante**: nem `computeFullLayout` (Studio→disco)
nem `resolveDataModelPathForDiskChange` (disco→Studio) tratam o caso "o
próprio ponto de montagem é um Script" (ex.: `src/server/init.server.luau`
direto na raiz do mount, sem subpasta) — hoje esse caminho é silenciosamente
ignorado nos dois sentidos. Contornado no teste renomeando para um script
nomeado dentro da pasta (`src/server/Main.server.luau`), que é o padrão mais
comum. Registrar em `docs/DECISIONS.md` se decidirmos suportar esse padrão
depois.

Ferramenta de desenvolvimento: `spikes/m1-test-project/` — projeto Rojo
mínimo e real (não é o produto, é o alvo de teste manual do M1).

## M2 — Sincronização estrutural + identidade

Objetivo: script deixa de ser endereçado por caminho no DataModel (frágil a
rename/move) e passa a ser endereçado por **UUID + `ObjectValue`**, padrão já
validado em dois Studios reais no RojoCoop
(`TeamCreateCoordinator:__resolveScriptRegistry`, `TeamCreateSchema.lua`).
Sem eleição de líder/heartbeat/leases ainda — isso é M3. Cada Studio mantém
seu próprio registry local (a replicação entre Studios é automática via
Team Create, não precisa de coordenação nesta fatia).

### Protocolo v2 (bump de `PROTOCOL_VERSION` 1 → 2, breaking change deliberado)

- `scriptList`: `scripts: [{uuid, path, className}]` (`path` passa a ser só
  informativo/exibição; `uuid` é a chave de endereçamento).
- `readSource {uuid}` (não mais `path`).
- `writeSource` tem dois modos, distinguidos pela presença do campo:
  - **Atualizar** script já conhecido: `{uuid, source}`.
  - **Criar** script novo: `{path, source, className}` (sem `uuid` — o
    plugin aloca um UUID novo e cria a Instance).
- `writeAck {ok, uuid, api?, error?}` — `uuid` sempre presente quando
  `ok=true` (seja o mesmo enviado, seja o recém-alocado na criação).
- `sourceChanged {uuid, path, source, className, origin?, via?}`,
  `scriptAdded {uuid, path, className}`, `scriptRemoved {uuid, path}` — como
  antes, só com `uuid` adicionado.
- **Nova mensagem espontânea**: `scriptMoved {uuid, oldPath, newPath, className}`
  — plugin detecta comparando o caminho canônico atual da Instance (via
  `ObjectValue.Value`) contra o último caminho conhecido daquele UUID, no
  mesmo ciclo de polling que já detecta mudança de Source.

### Plugin (Luau)

- [x] `[Implementado 2026-07-04, rojo build + lune run limpos; NÃO testado em
      Studio real]` `TestService.SyncTeam.Scripts.<uuid>` (`InstanceRef:
      ObjectValue`, `CanonicalPath: StringValue`, display-only). UUID via
      `HttpService:GenerateGUID(false)`. Módulo novo `plugin/src/ScriptRegistry.luau`.
- [x] `[Implementado 2026-07-04, idem]` Ao iniciar, reconciliar registry
      existente (`Scripts:GetChildren()`, ler `InstanceRef.Value`) antes de
      alocar UUID novo — identidade sobrevive reload do plugin dentro da
      mesma sessão de place. `ScriptRegistry.reconcile()`, chamado no início
      de `SourceWatcher.start()`.
- [x] `[Implementado 2026-07-04, idem; corrigido 2026-07-04 — ver DECISIONS.md]`
      Delete detectado via `ScriptRegistry.isInstanceDestroyed` (`Parent ==
      nil` + confirmação por `pcall`; NÃO `ObjectValue.Value == nil`, que não
      é sinal confiável — bug real corrigido em teste com 2 Studios) →
      `scriptRemoved`, limpar registry. Delete+recreate com mesmo
      nome/caminho é uma Instance nova → UUID novo automaticamente (nunca
      reusar por path/nome). Detecção movida para o ciclo de polling
      (`checkRegistryDrift` em `SourceWatcher.luau`), não mais para
      `DescendantRemoving` — decisão registrada abaixo.
- [x] `[Implementado 2026-07-04, idem]` `readSource`/`writeSource` resolvem
      por UUID (`writeSource` sem uuid = criação, aloca UUID novo).

**Decisão de design não 100% especificada na tarefa** (registrada aqui e em
`.claude/agent-memory/luau-dev.md`): a detecção de delete deixou de usar o
evento `DescendantRemoving` (usado no M1) como gatilho de `scriptRemoved` e
passou a usar exclusivamente o ciclo de polling verificando
`ScriptRegistry.isInstanceDestroyed` no registry (`checkRegistryDrift`, mesmo
ciclo que detecta `scriptMoved`). Motivo: `DescendantRemoving` dispara tanto
para delete real (`Instance:Destroy()`) quanto para reparent de um script
para fora dos containers observados (a Instance continua existindo, só saiu
da área observada) — os dois casos são indistinguíveis a partir desse evento
isolado, então mover a decisão para o registry (que pode reavaliar a cada
ciclo) é mais correto (evita falso-positivo de "removido" para um script só
movido para fora da árvore observada) ao custo de até
`Config.POLL_INTERVAL_SECONDS` (0.5s) de latência — aceitável pelo mesmo
raciocínio já usado para `sourceChanged`. `DescendantRemoving` continua
conectado, mas só faz limpeza local de cache/conexão (`unwatchScript`), sem
tocar no registry nem emitir mensagem.

**Correção de 2026-07-04** (ver `DECISIONS.md`): a premissa original de que
"`InstanceRef.Value` vira `nil` quando a Instance é destruída" — herdada do
teste do componente portado do RojoCoop
(`TeamCreateCoordinator.spec.lua:374-381`) — só foi validada contra um mock,
nunca contra o engine real. Teste real com 2 Studios mostrou que
`ObjectValue.Value` **não** zera em `Destroy()` (comportamento intencional da
Roblox, confirmado por pesquisa em
`.claude/research/2026-07-04-objectvalue-destroy-detection.md`); a checagem
correta é `ScriptRegistry.isInstanceDestroyed` (`Parent == nil` + confirmação
por `pcall` de reatribuição de `Parent`).

### Extensão (TypeScript)

- [x] `[Verificado 2026-07-04]` Mapa `uuid -> diskPath` substitui o
      mapeamento hoje quase todo por `path` do M1 (`SyncBridge.ts`:
      `scripts`, `sourceCache`, `diskPathByUuid`, `uuidByDiskPath`,
      `contentCache`).
- [x] `[Verificado 2026-07-04]` `scriptMoved` renomeia o arquivo/pasta em
      disco (não delete+recreate) — `DiskIO.renameFile` novo, implementado em
      `NodeDiskIO` (`fs.promises.rename` + `mkdir` recursivo do destino) e em
      `VscodeDiskIO` (`vscode.workspace.fs.rename(..., {overwrite:false})`),
      preservando o padrão de promoção arquivo↔pasta já existente do M1
      quando a mudança de caminho também muda `isInit` (via
      `recomputeAndApplyLayout` chamado ao final de `handleScriptMoved`, que
      cobre efeitos colaterais em OUTROS uuids como pai que precisa
      (des)promover).
- [x] **Fora de escopo desta fatia** (limitação aceita, documentada em
      `SyncBridge.handleLocalFileChange` e em
      `.claude/agent-memory/extension-dev.md`): detectar rename/move feito do
      lado do disco (VS Code) e refletir como `scriptMoved` para o Studio —
      por ora continua sendo delete+create local (nesta fatia, só
      "criar"/"atualizar" via `writeSource`, sem correlação com um arquivo
      antigo removido). Fica para uma fatia de polish depois.

### Testes

- [x] `[Verificado 2026-07-04]` Rename/move de script feito no Studio real
      reflete como rename real em disco (não delete+create), via
      `run-node-harness.ts` contra Studio real — múltiplas rodadas, várias
      combinações de containers (`ReplicatedStorage/Shared`,
      `ServerScriptService/Server`).
- [x] `[Verificado 2026-07-04]` Delete de script no Studio (Explorer, sem
      abrir no editor) remove o arquivo certo em disco. Caminho até chegar
      lá exigiu 2 correções reais em sequência, ambas em
      `plugin/src/ScriptRegistry.luau` (ver docs/DECISIONS.md): (1)
      `ObjectValue.Value` não detecta destruição — trocado para checar a
      Instance via `InstanceRef.Value` mais diretamente; (2) o "Delete" do
      Explorer do Studio não chama `Destroy()` de verdade (aparenta ser
      soft-delete para suportar Ctrl+Z) — a confirmação por `pcall` de
      reatribuição de `Parent` nunca falhava, então a checagem final ficou
      só `instance.Parent == nil`, sem essa confirmação.
- [x] `[Verificado 2026-07-04]` Bug de vazamento de `WebStreamClient`
      corrigido (`plugin/src/init.server.luau`, `stop()` agora fecha o
      cliente de forma síncrona) — sem isso, reloads repetidos do plugin
      esgotavam o limite de 6 clientes por Studio e bloqueavam qualquer
      nova conexão, mascarando os testes de delete como "não funciona".
- [ ] Delete + recreate (mesmo nome) gera UUID diferente — não testado
      isoladamente nesta rodada; esperado funcionar dado o design (uuid
      nunca é reaproveitado por coincidência de nome/path).
- [x] `[Verificado 2026-07-04]` `rojo build` continua limpo depois de
      round-trips com rename/delete, tanto em `plugin/` (com todos os fixes
      desta rodada) quanto em `spikes/m1-test-project/` (estado do disco
      pós-teste). `lune run` sem erro de sintaxe nos 3 arquivos alterados
      (`ScriptRegistry.luau`, `SourceWatcher.luau`, `init.server.luau`).
- [x] `[Verificado 2026-07-04 — divergência CONFIRMADA, não resolvida]`
      Convergência de UUID entre dois Studios reais após criação
      quase-simultânea: os dois Studios alocaram UUIDs **diferentes** para o
      mesmo script recém-criado/replicado, mesmo com o fix de "checar
      registry compartilhado antes de alocar" (`findRegistryEntryFor` em
      `ScriptRegistry.lua`) — a corrida acontece quando nenhum dos dois viu
      a entrada do outro replicar ainda. Resolver de verdade exige
      coordenação de líder (M3); registrado como limitação de fundo, não
      bug simples, em docs/DECISIONS.md.

## M3 — Coordenação de time (leases autoritativas)

Maior fatia do projeto até agora. Dividida em 3 sub-fatias testáveis
independentemente, na ordem — cada uma só avança depois da anterior validada
com 2 Studios reais (mesmo padrão do M0/M2).

### M3.1 — Sessions + heartbeat + eleição de líder (só plugin, sem VS Code)

Porte direto do algoritmo já validado em 2 Studios reais no RojoCoop
(`c:/Users/hakor/Documents/GitHub/RojoCoop/rojo-7.7.0-rc.1/plugin/src/TeamCreateElection.lua`
e `TeamCreateCoordinator.lua`) — reusar as constantes exatas, não redesenhar:
pulso 2s, sessão obsoleta após 8s, limpeza de sessões obsoletas após 20s,
promoção de líder só após 2 observações consecutivas do mesmo candidato.

- [x] `[Implementado 2026-07-04, rojo build + lune run limpos; NÃO testado em
      Studio real]` `TestService.SyncTeam.Sessions/<clientId>/` (ClientId,
      UserId, Username, JoinSequence, Pulse, ObservedRole StringValue:
      "leader" | "follower"). Novo módulo `plugin/src/TeamCreateElection.luau`
      + container raiz compartilhado `plugin/src/TeamCreateSchema.luau`
      (extraído de `ScriptRegistry.ensureContainers`, ver comentário no
      próprio arquivo).
- [x] `[Implementado 2026-07-04, idem]` Bootstrap: menor `clientId` vivo sem
      sessão assume; eleição normal: menor `JoinSequence` vivo, depois
      `clientId` como desempate — porte 1:1 de `TeamCreateElection.elect`/
      `observeCandidate`/`assignJoinSequences` do RojoCoop, sem alterar
      lógica nem constantes.
- [x] `[Implementado 2026-07-04, idem]` Detecção de sessão obsoleta (>8s sem
      pulso, via observação local de mudança de `Pulse`, mesmo princípio já
      usado para `Source`/delete desde M0.5/M2) exclui a sessão da eleição
      sem removê-la; limpeza real (`Folder:Destroy()`, só pelo líder, >20s)
      é `cleanupStaleSessions`.
- [x] `[Implementado 2026-07-04, idem]` `stop()` remove a própria entrada de
      `Sessions/` de forma síncrona (mesmo cuidado do fix de
      `WebStreamClient` do M2) — não depende do loop de heartbeat.
- [x] `[Verificado 2026-07-07]` Dois Studios reais: sessões convergem, mesmo
      líder nos dois lados. Primeira tentativa expôs split-brain real (termos
      divergentes, corrigido — ver docs/DECISIONS.md); reteste após o fix
      confirmou convergência genuína (mesmo `LeaderClientId`/term nos dois
      Studios, log de reconciliação de duplicata disparou de verdade).
- [x] `[Verificado 2026-07-15]` Failover forçado (fechar o Studio líder)
      promove o outro. Resultado real: ~3s (mais rápido que o esperado
      pelo caminho de staleness/8s) — porque fechar a janela do Studio no
      Windows disparou `plugin.Unloading` de verdade, chamando o `stop()`
      síncrono de `TeamCreateElection` (remove a própria `Sessions/<clientId>`
      na hora), então o outro lado reeegeu por sessão AUSENTE, não por
      sessão OBSOLETA (>8s). Zero split-brain na promoção. **Nuance**: o
      caminho de crash não-gracioso (processo morto sem `Unloading`, que
      cairia no timeout de staleness de 8s + 2 observações) continua não
      testado — só fechar a janela normalmente foi exercitado.
- Resolve de vez a divergência de UUID entre Studios registrada no M2: uma
  vez que existe um líder combinado, a alocação de UUID pode passar a ser
  arbitrada por ele em vez de cada Studio decidir sozinho. **Ainda não
  implementado nesta fatia** (fora de escopo do M3.1, que é só
  sessões/heartbeat/eleição — arbitragem de UUID pelo líder ficaria natural
  para entrar junto com M3.2/leases, quando o líder já está decidindo outras
  coisas; revisitar se a divergência voltar a aparecer em teste real).

### M3.2 — Leases por script (autoritativas, sem preempção)

- [x] `[Implementado 2026-07-04, rojo build + lune run limpos; NÃO testado em
      Studio real]` `TestService.SyncTeam.Leases/<uuid>/` (OwnerClientId,
      LeaseId, LeaderTerm, RequestSequence). Novo módulo
      `plugin/src/TeamCreateLease.luau`; `NextLeaseRequestSequence` (IntValue)
      adicionado a `TeamCreateSchema.ROOT_VALUES`.
- [x] `[Implementado 2026-07-04, idem]` Intent de edição: **não é a extensão
      quem avisa** (decisão desta fatia — o plugin já sabe que vai escrever
      no momento de `handleWriteSource`, não precisa de uma mensagem de
      protocolo separada) — o próprio `init.server.luau` chama
      `TeamCreateLease.ensureIntent(uuid, instance)` antes de escrever, que
      cria/refresca `Sessions/<clientId>/LeaseIntents/<uuid>` e incrementa
      `Pulse`. Líder decide dono no próprio ciclo (`leaderTick`,
      `TeamCreateLease.luau`): sem preempção, dono atual mantém enquanto
      tiver intent vivo no grupo (`Pulse` mudou há menos de
      `STALE_AFTER_SECONDS`); senão, menor `RequestSequence` vence
      (`chooseWinner`/`assignRequestSequences`, porte 1:1 de
      `TeamCreateShadowLease.lua`).
- [x] `[Implementado 2026-07-04, idem]` Plugin recusa `writeSource` de quem
      não é dono: `handleWriteSource` (modo atualização) chama
      `TeamCreateLease.canWrite(uuid)` antes de `SourceWatcher.writeSource` —
      nega com `writeAck {ok=false, error="lease negada — script sendo
      editado por <username/clientId>"}` sem escrever nada no DataModel;
      permite otimisticamente quando o dono é o próprio clientId OU nenhuma
      lease foi arbitrada ainda (decisão explícita, ver
      `plugin/src/TeamCreateLease.luau`).
- [x] `[Verificado 2026-07-15]` Dois Studios reais: dev A escreve (lease
      concedida), dev B tenta escrever o MESMO script enquanto o intent de A
      está fresco — plugin de B recusa com `writeAck ok=false,
      error="lease negada — script sendo editado por dev_Hakor"` (log real:
      `ERROR disco → Studio: FALHA aplicando ... lease negada`). Depois que o
      intent de A expira (~8s sem novo write), líder reatribui o lease a B
      (`lease concedida ... owner=<B> requestSequence=2`); B reenvia a
      escrita e desta vez é aceita (`UpdateSourceAsync` sem erro). Ciclo
      completo negar→liberar→conceder confirmado com timestamps reais nos
      dois logs (`Tools/logs/studio-34980.log`/`studio-34981.log`,
      03:45:39–03:46:10).

### M3.3 — UX de lease no VS Code (delegar a `ui-dev`)

**Parte plugin (pré-requisito, `luau-dev`)**:

- [x] `[Implementado 2026-07-04, rojo build + lune run limpos; NÃO testado
      em Studio real]` `hello` inclui `clientId` (via
      `TeamCreateElection.getClientId()`). Nova mensagem espontânea
      `leaseChanged {uuid, ownerClientId, ownerDisplayName}` emitida por um
      ciclo próprio em `plugin/src/TeamCreateLease.luau`
      (`checkLeaseDrift`, a `Config.POLL_INTERVAL_SECONDS`), que compara
      `getOwner(uuid)` contra o último dono visto para todo uuid em
      `ScriptRegistry.forEach`. Ver `docs/PROJECT_STATUS.md` (seção "M3.3 —
      lado do plugin...") para decisões detalhadas.

**Parte extensão (`ui-dev`, testado com `model: haiku` — ver
[[delegate-simple-tasks-to-haiku]] na memória, resultado equivalente ao
Sonnet por um custo menor)**:

- [x] `[Verificado localmente 2026-07-04 — lint/57 testes/build limpos;
      NÃO testado contra Studio real]` `LeaseTracker.ts` (módulo puro,
      9 testes): `isOwnedByMe`/`describeOwner` com os casos dono=eu,
      dono=outro, dono=null (otimista, mesma regra do plugin). `hello`
      captura `clientId` próprio. `leaseChanged` roteado e aplicado ao
      tracker. `onWriteRejected` (novo callback em `SyncBridge`) dispara
      quando `writeAck.ok === false`, nos dois modos (atualizar/criar) —
      2 testes novos em `syncBridge.test.ts`.
- [x] `[Implementado 2026-07-04]` Mensagem clara ao tentar editar um
      arquivo negado: `extension.ts` mostra
      `vscode.window.showWarningMessage` com o texto de erro que já vem
      pronto do plugin — não falha silenciosa.
- [ ] **Simplificação deliberada, documentada como decisão**: arquivo sem
      lease local NÃO fica read-only de verdade (exigiria
      `FileSystemProvider` customizado do VS Code, fora de escopo desta
      fatia) — hoje só mostra aviso (status bar/output) quando outro dono
      assume um script que o dev local tem sincronizado. Bloqueio real de
      edição fica para uma fatia de polish futura, se o feedback visual
      não for suficiente na prática.
- [x] `[Verificado 2026-07-15]` Dois devs criando arquivos DIFERENTES ao
      mesmo tempo (`NaoRegressaoA.server.luau` em A,
      `NaoRegressaoB.server.luau` em B, criados na mesma rajada de shell):
      zero interferência, cada um alocou seu próprio uuid e replicou para o
      outro Studio corretamente (`resolveOrAllocate: reaproveitado uuid=...
      já existente no registry compartilhado` — o eco do disco→Studio do
      script do OUTRO dev foi corretamente reconhecido como já existente,
      sem duplicar).
- [ ] **Ainda não verificado**: o aviso VISÍVEL (`vscode.window.showWarningMessage`)
      dentro de uma janela real do VS Code (Extension Development Host) — a
      rejeição acima foi confirmada só até a camada de dados (harness Node,
      `NodeDiskIO`, sem VS Code de verdade aberto). O callback que dispara
      esse aviso (`onWriteRejected`) já é exercitado pelos mesmos logs
      (`writeAck.ok=false` chega e é logado), então a lógica está
      validada — falta só o "de-olho-na-tela" com uma janela de VS Code
      real, que nenhuma sessão fez ainda.

**M3.1 e M3.2 fechados com 2 Studios reais em 2026-07-15** (ver
`docs/PROJECT_STATUS.md`, nota de sessão do dia). M3.3 fechado na camada de
dados/lógica; só a checagem visual do popup do VS Code segue pendente.

Ferramenta de teste: mesma dupla de contas/Studios já usada no M0/M2 —
`Add Account`, roteiro documentado em `.claude/research/2026-07-03-dois-studios-mesma-maquina.md`.

## M4 — Presença

- [ ] Cursor/seleção/arquivo ativo publicados em `Sessions/<id>/Presence`.
- [ ] VS Code renderiza cursores coloridos com nome, seleções e badge ● no
      explorer (porta da extensão do RojoCoop).
- [ ] Latência de presença aceitável para uso real (alvo: ≤ ~2s, um pulso).

## M5 — Empacotamento e hardening

- [ ] Plugin distribuído como `.rbxm` (build via `rojo build`); extensão como `.vsix`.
- [ ] Reconexão automática (WS local e reentrada na sessão Team Create).
- [ ] Recuperação de conflito: arquivo divergente ao reconectar gera artefato de
      conflito legível em vez de sobrescrita silenciosa.
- [ ] Documentação de instalação e de migração Rojo → SyncTeam → Rojo.
