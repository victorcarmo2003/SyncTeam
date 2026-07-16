# Memória do extension-dev

Decisões técnicas e pegadinhas de TypeScript/Node/VS Code do projeto.
Atualize ao final de cada tarefa; mantenha curto e acionável.

- Comparação de paths no Windows precisa ser case-insensitive (bug real
  corrigido no RojoCoop, `FilePresenceDecorations`).
- **Padrão de dedupe por cache de conteúdo (harness Node), espelhando o que o
  luau-dev já usa do lado do plugin (`lastSourceByInstance` +
  `checkSourceChanged`)**: em `spikes/m0_5-local-pipeline/harness/bridge-server.mjs`
  (ponte interativa disco ↔ Studio, distinta do `server.mjs` de cenários
  automáticos — não mexer nele), mantenho um `Map` `contentCache` chaveado por
  `"<pastaKey>:<scriptPath em minúsculas>"` com o último conteúdo conhecido.
  Regra: **sempre atualizar o cache ANTES de tocar o disco/rede**, nunca
  depois — como Node é single-thread, isso garante que quando o efeito
  colateral dessa própria escrita disparar de volta (fs.watch reagindo a uma
  escrita local, ou uma segunda mensagem de broadcast chegando por outro
  canal), a comparação "conteúdo lido == cache" já bate e a propagação para
  e ignorada silenciosamente. Não precisa rastrear "quem originou" a mudança
  (sem flags tipo `recentRemoteWrites` do plugin) — só comparar valor atual
  vs. cache é suficiente quando a atualização do cache é sempre síncrona e
  anterior à escrita.
- **Descoberta importante**: o plugin `SyncTeamLab.lua` faz `broadcast()` de
  `sourceChanged`/`scriptAdded` para **todos os canais conectados**, não só
  para quem originou a mudança. Isso significa que qualquer handler que reaja
  a `sourceChanged` recebendo dos dois canais (A e B) vai ser chamado **duas
  vezes para o mesmo evento lógico** quando ambos estiverem conectados. O
  cache de conteúdo acima também resolve isso de graça: a segunda chamada
  (via o outro canal) encontra o cache já atualizado pela primeira e sai cedo
  (`continue`), evitando escrita/log duplicados. Qualquer consumidor futuro
  de `sourceChanged` (extensão de produto incluída) precisa considerar esse
  double-delivery por design, não como bug.
- Limitações conhecidas do `bridge-server.mjs` (documentar se portar para
  produto): (1) `fs.watch(dir, { recursive: true })` é usado só por ser mais
  simples que uma lib de watch — funciona no Windows/macOS; no Linux só é
  suportado nativamente em versões recentes do Node, então não é portável
  sem testar; (2) condição de corrida benigna na sincronização inicial: se
  os canais A e B conectam quase ao mesmo tempo, cada um dispara seu próprio
  `listScripts`+`readSource` e os dois fluxos escrevem nas mesmas duas
  pastas concorrentemente — inofensivo porque ambos leem o mesmo estado do
  Studio e a escrita é idempotente (mesmo conteúdo final), mas gera leituras
  /escritas redundantes; (3) edições locais feitas ANTES do respectivo canal
  conectar não são enfileiradas — falham silenciosamente (log de "canal
  desconectado") e são sobrescritas pela sincronização inicial assim que o
  Studio conectar, porque a ponte só copia Studio→local na sincronização
  inicial, nunca local→Studio; (4) exclusão de arquivo/script não é tratada
  (fora de escopo do M0.5) — só logada.
- **Módulo de mapeamento Rojo (`spikes/m0_5-local-pipeline/harness/rojo-path-mapping.mjs`)**,
  funções puras `computeLayout(entries)` / `parseDiskPath(relativeDiskPath)`,
  14 testes `node:test` (`node --test rojo-path-mapping.test.mjs`, todos
  passando):
  - **Insight que simplificou tudo**: o nome de cada segmento de diretório no
    disco é sempre só o nome do segmento — não importa se aquele segmento
    corresponde ele próprio a um script sincronizado (ex.: `Foo` é um
    `ModuleScript` com filho `Foo/Bar`) ou é só uma pasta organizacional que
    nunca aparece como `entry` (ex.: `Services/Main`). A única decisão real é
    no segmento FINAL do path de cada entry: vira arquivo achatado
    (`Nome.<ext>`) se `hasChildren` for falso, ou pasta com
    `init.<ext>` dentro se for verdadeiro. `hasChildren` é só "algum outro
    entry tem `path` começando com `entry.path + "/"`" — não precisa saber se
    o path intermediário é ele mesmo um entry.
  - `computeLayout` detecta colisão de `diskPath` comparando **case-insensitive**
    (regra do `.claude/rules/typescript.md` — Windows/NTFS não distingue
    caixa) e lança erro descritivo em vez de sobrescrever; testado com dois
    entries diferindo só em maiúscula/minúscula E com um entry cujo path
    literal colide com o `init.<ext>` gerado por outro (`Parent/init` vs.
    `Parent` com filho `Parent/Child`).
  - `parseDiskPath` precisa tentar os sufixos do mais específico pro mais
    genérico (`.server.` antes de `.client.` antes de `.lua|.luau` puro),
    senão o regex genérico casa primeiro e a classe sai errada.
  - Round-trip (`computeLayout` → `parseDiskPath` de cada `diskPath` →
    bate com `{instancePath, className, isInit}` original) é o teste mais
    valioso — pego bug de extensão duplicada e de escolha errada de
    `baseName` (`init` vs. nome do segmento) direto.
  - `node:test`/`node:assert/strict` não pediram nenhuma dependência nova
    (Node 25 já traz os dois nativamente); rodar com
    `node --test caminho/arquivo.test.mjs` a partir de qualquer diretório
    funciona sem config extra porque o arquivo já é `.mjs` com imports
    relativos.
- **Ligação do mapeador em `bridge-server.mjs`**: troquei o esquema antigo
  (`<Nome>.lua` plano + `inferClassName` por regex no nome) por um pipeline de
  4 Maps: `knownClasses` (path→className, fonte de verdade pro layout),
  `sourceCache` (path→última Source do Studio, independente de onde ela mora
  no disco), `layoutCache` (path→diskPath atualmente materializado, usado só
  pra detectar quando o diskPath de um path mudou) e `contentCache` (mantido
  do design anterior, mas agora chaveado por `(pasta, diskPath)` em vez de
  `(pasta, path.lua)`).
  - **Promoção arquivo→pasta**: só acontece dentro de `recomputeAndApplyLayout`,
    chamada toda vez que `knownClasses` muda de um jeito que pode alterar
    `hasChildren` de alguém (path novo apareceu, ou — não deveria na prática —
    className mudou). Ela recalcula `computeLayout` sobre TODAS as entries e
    compara cada `diskPath` novo contra `layoutCache`; se mudou, chama
    `movePathOnBothFolders` (lê o arquivo antigo, cai pro `sourceCache` como
    fallback se o arquivo antigo não existir, escreve no novo caminho, apaga o
    antigo, sobe removendo diretórios vazios até a raiz do workspace — nunca
    remove a raiz em si). Cache é sempre atualizado (`contentCache.delete`
    da entrada antiga, `contentCache.set` da nova) ANTES de tocar o disco,
    mesmo padrão de sempre, pra o fs.watch reagindo à própria promoção não
    gerar `writeSource` de volta pro Studio.
  - **Decisão deliberada**: `handleLocalChange` NÃO escreve em `layoutCache`
    a partir do path observado por `fs.watch` — só `recomputeAndApplyLayout`
    (guiado pelo Studio via `knownClasses`) escreve nesse cache. Se deixasse
    a edição local "confirmar" `layoutCache`, um arquivo órfão/fora de
    convenção (ex.: usuário cria manualmente `Foo.luau` quando `Foo` já
    deveria ser pasta por ter filhos) poderia congelar o layout errado até o
    próximo evento do Studio. Isso é uma limitação aceita, não testada com
    Studio real neste spike — documentar se virar bug relatado.
  - `parseDiskPath` virou o ÚNICO filtro de "isso é um arquivo de script
    válido?" no `fs.watch` — removi o pre-filtro por regex de extensão que
    existia antes. Consequência aceita e pedida explicitamente pela tarefa:
    qualquer evento de fs.watch (inclusive diretórios sendo criados, arquivos
    `.txt` acidentais, etc.) agora passa por `parseDiskPath` e gera um log de
    aviso quando retorna `null`, em vez de ser silenciosamente descartado
    antes. Mais barulho no log, mas nenhum `writeSource` malformado sai.
  - **Risco não testado com Studio real**: se os dois processos de
    `fs.watch` (workspace-a e workspace-b) ou uma segunda mensagem
    `sourceChanged`/`scriptAdded` chegando durante a janela do debounce
    (150ms) disputarem uma promoção arquivo→pasta ao mesmo tempo — ex.: o
    usuário edita `Foo.luau` no exato instante em que o Studio cria
    `Foo/Bar` (fazendo `Foo` precisar virar pasta) — a ordem de eventos entre
    "handleLocalChange lê/envia o conteúdo antigo de `Foo.luau`" e
    "recomputeAndApplyLayout move `Foo.luau` para `Foo/init.luau`" não é
    garantida. Pior caso plausível: a leitura de `handleLocalChange` falha
    com ENOENT (arquivo já foi movido) e a edição do usuário se perde
    silenciosamente até o próximo `sourceChanged`. Não reproduzido de
    verdade — só análise de código; vale um cenário manual dedicado antes do
    M1 se promoção arquivo→pasta virar caminho comum de uso.
  - Limitações do `fs.watch`/dedupe já registradas na entrada anterior desta
    memória continuam valendo sem mudança (recursive watch não portável pro
    Linux, corrida benigna na sincronização inicial dupla, edição antes da
    conexão não é enfileirada, delete não é tratado).

## M1 — `vscode-extension/` real (2026-07-04)

Portei o spike M0.5 (`rojo-path-mapping.mjs` + lógica de `bridge-server.mjs`)
para `vscode-extension/` de produto. Decisões novas que valem para qualquer
trabalho futuro nessa pasta:

- **Estrutura**: `src/protocol.ts` (tipos + `PROTOCOL_VERSION`),
  `src/mapping/{rojoPathMapping,projectMapping}.ts` (puro, sem I/O),
  `src/sync/{DiskIO,NodeDiskIO,VscodeDiskIO,SyncBridge,SyncServer,SyncTeamService}.ts`,
  `src/extension.ts` (única coisa que importa `vscode` fora de
  `VscodeDiskIO.ts`/`util/vscodeLogger.ts`). Testes em `test/*.test.ts`
  (vitest) não tocam `vscode` nenhuma vez — por isso não precisou de mock de
  `vscode` no `vitest.config.mts` (diferente do RojoCoop, que precisava).
- **`DiskIO` como interface, não classe concreta única**: a tarefa exigia
  lógica testável com `node:fs` puro E ativação real via `vscode.workspace.fs`.
  Resolvido com uma interface (`readFile`/`writeFile`/`deleteFile`/
  `removeEmptyDirsUpward`, todas assíncronas, `relPath` sempre "/"-separado
  relativo à raiz do workspace de sync) + duas implementações. `SyncBridge`
  só depende da interface — nunca soube que existe VS Code. Testes usam
  `NodeDiskIO` apontado pra um `fs.mkdtempSync` real (não fake em memória);
  achei melhor porque pega bugs de path-join/mkdir recursivo que um fake em
  memória esconderia.
- **Composição de mapeamento em duas camadas**: `rojoPathMapping.ts` (puro,
  porte do spike, só sabe de `instancePath`/`diskPath` relativos) e
  `projectMapping.ts` (sabe de `MountPoint[]`, agrupa entries por mount antes
  de chamar `computeLayout`, e reconstrói o path completo prefixando com
  `mount.dataModelPath`/`mount.diskPath`). Direção disco→DataModel
  (`resolveDataModelPathForDiskChange`) é o espelho: acha o mount pelo
  prefixo do **diskPath** (comparação case-insensitive — Windows/NTFS) e só
  então chama `parseDiskPath` no resto. Nunca comparar `dataModelPath` case-
  insensitive (nomes de Instance no Roblox são case-sensitive de verdade,
  diferente de path de disco no Windows) — os dois `resolveMountFor*`
  têm regras de comparação diferentes por esse motivo, documentado inline.
- **`SyncBridge` ganhou `handleScriptRemoved`** mesmo não sendo requisito
  formal da fatia 1 do M1 (create/rename/move/delete é M2) — o protocolo já
  define `scriptRemoved` como mensagem espontânea válida, então implementei
  o caso simples (remove das caches, apaga o arquivo) para não deixar
  arquivo perdido no disco se o plugin mandar essa mensagem. Não tenta
  detectar rename (viraria remove+add sem correlação) — isso vai precisar da
  identidade por UUID do M2, documentado como limitação aceita.
- **`SyncServer` rejeita um segundo cliente conectando** (`socket.close(1013, ...)`)
  em vez de substituir o primeiro — M1 é 1 dev só, então dois plugins
  conectados ao mesmo tempo é sempre um bug/configuração errada, não um caso
  a suportar silenciosamente. Reconsiderar em M3 se o design mudar (não deve
  mudar: quem tem múltiplos clientes é o Studio conectando em várias portas
  no cenário multi-dev futuro? não — a extensão de cada dev roda seu próprio
  servidor local, então continua sendo 1 plugin por extensão mesmo em M3).
- **Confirmação de porta com `luau-dev`**: `plugin/src/Config.luau` já
  existia (trabalho paralelo) com `Config.DEFAULT_PORT = 34980` quando fui
  escrever `extension.ts` — usei o mesmo valor sem precisar negociar, e
  confirmei que o protocolo implementado em `plugin/src/init.server.luau` /
  `SourceWatcher.luau` bate exatamente com o que assumi (campo `scripts:
  [{path, className}]` em `scriptList`, `hello` com `protocolVersion`/`role`/
  `placeName`/`userId`/`pluginVersion`, `writeAck`/`sourceContent` com
  `ok`/`error` opcional). Não precisei ajustar nada do lado da extensão.
- **Ainda não testado**: round-trip real Studio↔disco (só testei a lógica
  com fakes/tmpdir — 42/42 testes, `tsc --noEmit` limpo, `esbuild` limpo).
  Próximo passo natural: instalar `plugin/` de verdade num Studio + abrir
  `vscode-extension/` no Extension Development Host contra
  `spikes/m1-test-project/`.

## M2 — identidade por UUID (2026-07-04)

Troquei a chave primária de `SyncBridge` de `dataModelPath` para `uuid`
(protocolo v2, `PROTOCOL_VERSION` 1→2). Decisões que valem para qualquer
trabalho futuro que toque `SyncBridge`/`protocol.ts`/`DiskIO`:

- **Os tipos de `protocol.ts` continuam sendo só documentação/contrato, não
  validação em runtime** — nem no M1 nem agora `SyncServer`/`SyncBridge`
  importam `ScriptListEntry`/`WriteSourceRequest`/etc. para checar mensagens;
  tudo é `Record<string, unknown>`/`RawMessage` cru, validado campo a campo
  na entrada de cada handler (`typeof x === "string"`, `isValidClassName`).
  Se algum dia isso mudar (ex.: um parser central tipado), atualizar aqui —
  por ora é uma decisão consciente pró-simplicidade, o union type
  `WriteSourceRequest`/`isWriteSourceUpdate` existe mais para o humano lembrar
  do contrato do que para o compilador pegar erro em runtime.
- **`moveOnDisk` (motor interno de `recomputeAndApplyLayout`) foi trocado de
  ler+escrever+apagar para usar `DiskIO.renameFile` como caminho primário**,
  com fallback para ler do `sourceCache` + escrever do zero se o rename
  falhar (arquivo antigo não existe de fato — ex.: registrado mas nunca
  chegou a ser materializado). Isso não era pedido explicitamente para o
  caminho de promoção "automática" (só para `handleScriptMoved`), mas decidi
  unificar porque os dois casos são literalmente "mover um arquivo para
  outro caminho, preservando conteúdo" — duplicar a lógica (uma via
  read/write/delete, outra via rename) seria pior. Testado via o cenário
  "scriptMoved que muda isInit" (`test/syncBridge.test.ts`), que dispara
  AMBOS os caminhos no mesmo teste (o rename explícito de `handleScriptMoved`
  E a promoção em cascata do pai via `recomputeAndApplyLayout` chamado ao
  final).
- **`handleScriptAdded` passou a receber `transport`** (não existia no M1) —
  a tarefa pediu que ele busque `readSource {uuid}` proativamente quando o
  conteúdo ainda não está em `sourceCache`, em vez de só esperar
  passivamente por um `sourceChanged` futuro. Isso significa que em qualquer
  teste que chame `handleScriptAdded` sem pré-popular
  `transport.sources.set(uuid, conteúdo)`, vai rolar um `readSource` que
  retorna `""` (default do `FakeTransport`) e materializa um arquivo vazio
  ANTES de qualquer `sourceChanged` explícito de teste — pegadinha real que
  me mordeu no teste de dedupe por cache (contagem de `writeCount` ficou 1
  a mais do que eu esperava até eu pré-popular `transport.sources`). Se for
  escrever um teste novo que conta escritas, sempre pré-popular
  `transport.sources` para o uuid ANTES de `handleScriptAdded`, ou contar a
  partir de depois da chamada.
- **`handleSourceChanged` ignora o campo `path` recebido por completo**
  (só usa para exibição em log) — resolve só por `uuid`. Isso é mais simples
  que o M1 (que também comparava `className` recebido contra o conhecido
  para decidir se recomputa layout) porque no M2 a fonte de verdade de
  `path`/`className` é `scriptAdded`/`scriptMoved`, nunca `sourceChanged`.
- **`handleLocalFileChange`, modo "criar"**: só registra o uuid novo nos
  caches (`scripts`/`sourceCache`/`diskPathByUuid` via `registerDiskPath`) se
  o `writeAck` tiver `ok===true` E `uuid` for string não vazia — um ack malformado
  (`ok:true` sem `uuid`) é logado como erro e a edição fica sem
  rastreamento (próxima edição no mesmo arquivo vai de novo pelo modo
  "criar", gerando um SEGUNDO uuid/Instance no Studio — bug latente aceito,
  não deveria acontecer se o plugin seguir o protocolo, mas não tem proteção
  extra aqui). Depois de registrar, chamo `recomputeAndApplyLayout` (não
  pedido explicitamente na tarefa, mas simétrico ao que já faço em
  `handleScriptAdded`/`handleScriptMoved`) para cobrir o caso do arquivo novo
  local fazer um ancestral existente precisar promover para pasta.
- **`DiskIO.renameFile`**: `NodeDiskIO` via `fs.promises.rename` (cria o
  diretório destino antes com `mkdir recursive`); `VscodeDiskIO` via
  `vscode.workspace.fs.rename(..., {overwrite:false})` (mesma tolerância de
  `createDirectory` já existente em `writeFile` — falha ao criar dir que já
  existe não bloqueia). Não testei `VscodeDiskIO.renameFile` com VS Code de
  pé (nenhum teste toca `vscode` neste projeto, mesma limitação já registrada
  para o resto de `VscodeDiskIO`).
- **Testes**: reescrevi `test/syncBridge.test.ts` inteiro para o protocolo v2
  (12 testes, era 8) — `FakeTransport` agora simula os dois modos de
  `writeSource` (criar aloca uuid sequencial `uuid-N` e registra em
  `transport.scripts`/`transport.sources`, simulando o plugin de verdade
  alocando e reportando de volta). `runInitialSync`, dedupe, promoção,
  `scriptMoved` (rename simples + rename que muda `isInit`), disco→Studio
  (os dois modos, incluindo confirmar que uma segunda edição no MESMO
  arquivo já sai atualizando por uuid depois do primeiro `writeAck`),
  `scriptRemoved`. 46/46 testes no total (`vitest run`), `tsc --noEmit` e
  `npm run build` (esbuild, gera `dist/extension.js` E
  `dist/run-node-harness.js` — o harness importa os mesmos módulos, não
  esquecer de rebuildar os dois).
- **Não testado**: round-trip real contra o `plugin/` M2 num Studio de
  verdade (rename/move no Explorer chegando como `scriptMoved` de fato) — só
  a lógica com fakes/tmpdir. Depende do lado do plugin (`luau-dev`) já ter
  sido validado em Studio primeiro (ver roteiro em
  `docs/PROJECT_STATUS.md`, seção "M2 — lado do plugin").

## M3.3 — UX de lease no VS Code (2026-07-04)

Implementada a reação a mudanças de lease e negação de escrita. Decisões e padrões:

- **Protocolo v2 estendido**: `HelloMessage` recebe `clientId?: string | null` (campo novo do plugin); nova mensagem espontânea `LeaseChangedEvent` com campos `uuid`, `ownerClientId`, `ownerDisplayName`.
- **Módulo `LeaseTracker.ts`** (puro, sem vscode/I/O): rastreamento de estado de leases por uuid, com funções:
  - `updateLease(uuid, ownerClientId, ownerDisplayName)` — atualiza o mapa quando `leaseChanged` chega.
  - `isOwnedByMe(uuid): boolean` — retorna true se sou dono OU se a lease está livre (otimista) OU se nenhuma lease foi arbitrada ainda (caso ideal no bootstrap do M3.1 antes de eleição).
  - `describeOwner(uuid): string | null` — retorna o nome de quem é dono (ou clientId se nome não disponível), null se for eu ou se estiver livre.
- **Integração `SyncTeamService.ts`**: captura `clientId` do `hello` e instancia `LeaseTracker`; roteia `leaseChanged` em `routeSpontaneous` e chama callbacks de UI; callbacks públicos `setOnLeaseChanged` e `setOnWriteRejected` para que `extension.ts` reaja.
- **Integração `SyncBridge.ts`**: adicionado callback `onWriteRejected` opcional (chamado quando `writeAck.ok === false` em disco→Studio, tanto no modo atualizar quanto criar); permite que `extension.ts` mostre mensagem visível de erro.
- **Camada de ativação (`extension.ts`)**: configura os dois callbacks:
  - `onLeaseChanged`: loga mudanças para output channel (informativo, sem bloquear UI).
  - `onWriteRejected`: mostra `vscode.window.showWarningMessage` com a mensagem de erro do plugin — decisão deliberada de não implementar bloqueio de edição real em nível de arquivo (fora de escopo, simplificação documentada).
- **Testes** (57 testes, incluindo 11 novos): `test/leaseTracker.test.ts` (9 testes) cobre otimismo, mudanças de dono, liberação, fallback de clientId; `test/syncBridge.test.ts` (2 testes novos em "M3.3 — lease negado") cobre callback de `onWriteRejected` disparando corretamente em ambos os modos de `writeSource` (atualizar e criar).
- **Verificação**: `npm run lint` (tsc), `npm test` (57/57), `npm run build` (esbuild) — todos limpos.
- **Não testado em Studio real**: integração com o lado do plugin (M3.1/M3.2) que manda `hello.clientId` e `leaseChanged`; roteiro manual em `docs/PROJECT_STATUS.md`.

## Harness Node grava log em arquivo, para o orquestrador ler sem depender do usuário (2026-07-07)

Tarefa paralela ao `luau-dev` fazendo o plugin encaminhar todo `print()` do
Output do Studio como mensagem espontânea `{kind: "log", text}`. Do lado da
extensão:

- `src/util/logger.ts` ganhou `createFileLogger(filePath, prefix = "[SyncTeam]")`
  (append-only via `fs.appendFileSync`, sem stream — mais simples e à prova de
  perda de linha em crash; cria o diretório do arquivo com `mkdirSync
  recursive` se preciso) e `createTeeLogger(...loggers)` (despacha cada
  chamada para todos). `warn`/`error` do file logger recebem tag textual
  (`WARN `/`ERROR `) porque um arquivo texto não tem as cores que
  `console.warn`/`console.error` dão de graça.
- `tools/run-node-harness.ts` lê `process.env.SYNCTEAM_LOG_FILE` (path
  absoluto ou relativo ao cwd — `fs.appendFileSync`/`mkdirSync` já resolvem
  relativo ao `process.cwd()` de graça, não precisei de `path.resolve`
  explícito). Se setada: `logger = createTeeLogger(createConsoleLogger(...),
  createFileLogger(...))`; se ausente: comportamento idêntico ao anterior (só
  console). Quem decide o path do arquivo é quem sobe o harness (orquestrador),
  não a extensão.
- `SyncTeamService.routeSpontaneous` ganhou `case "log"` (mesmo padrão do
  `leaseChanged` já existente): valida `message.text` é string, senão loga
  erro e descarta; se válido, `this.logger.info(\`[studio] ${text}\`)`. Não
  criei callback público (`setOnLog`) tipo o `setOnLeaseChanged` — não havia
  necessidade externa, o único consumidor é o próprio logger do serviço.
  `text` já vem prefixado de dentro do plugin (`[SyncTeam HH:MM:SS] ...`), e o
  file logger acrescenta seu próprio prefixo/timestamp por cima — resultado
  tem timestamp duplicado (um da extensão, um do plugin) mas isso é aceitável
  e até útil (mostra latência de replicação Team Create → plugin → extensão).
- **Para testar `routeSpontaneous` sem abrir socket de verdade**: instanciar
  `SyncServer` normalmente mas nunca chamar `.start()` (constructor não faz
  bind, só campos) e chamar o método privado direto via
  `(service as unknown as { routeSpontaneous(m: RawMessage): void
  }).routeSpontaneous(message)` — bypassa a necessidade de simular
  WebSocket real. Ver `test/syncTeamService.test.ts` (novo arquivo, 3 testes)
  e `test/logger.test.ts` (novo, 5 testes cobrindo file logger + tee logger).
  65/65 testes totais, `tsc --noEmit` limpo, `esbuild` gera os dois bundles
  (`dist/extension.js` e `dist/run-node-harness.js`).
- Validei manualmente rodando o harness de verdade contra
  `spikes/m1-test-project` com `SYNCTEAM_LOG_FILE=./scratch-test.log`: as
  mesmas linhas aparecem no console E no arquivo, idênticas.

## Refresh Sync — reconciliação de 3 vias sob demanda (2026-07-15)

Comando `syncteam.refreshSync` que faz um merge de 3 vias bidirecional para
TODOS os arquivos mapeados de uma vez, pegando deriva que o watcher/conexão ao
vivo perdeu (cenário-alvo: processo externo — `.bat`/`.ps1`/Claude Code —
editou/criou arquivo mapeado com a extensão FECHADA; a sincronização inicial é
Studio-autoritária e sobrescreveria a edição externa).

- **Ancestral comum = `contentCache` do SyncBridge** (chaveado por diskPath
  minúsculo = último conteúdo sincronizado). NÃO é uma estrutura nova — reusei
  a que já existia para dedupe de eco. Isso é o que torna o merge de 3 vias
  possível sem persistir nada em disco.
- **`SyncBridge.refreshSync(transport)`** é só um NOVO PONTO DE ENTRADA, não
  reimplementa propagação: reusa `handleLocalFileChange` (disco→Studio),
  `applyStudioContent` (Studio→disco, mesmo núcleo de `handleSourceChanged`) e
  `recomputeAndApplyLayout` (materializar/mover). Fluxo: (1) `listScripts`
  fresco → merge em `this.scripts` + recompute (dá diskPath a scripts do Studio
  ainda não vistos e move os que mudaram de path enquanto fechado); (2) para
  cada uuid na UNIÃO de `diskPathByUuid` com o listScripts fresco,
  `reconcileUuidOnRefresh`; (3) `reconcileDiskOnlyFiles` varre `listFiles` de
  cada mount e trata arquivos sem uuid como criação nova.
- **Tabela de decisão** (`cache`=contentCache[diskPath], `disco`=readFile,
  `studio`=readSource fresco): sem ancestral (`cache` undefined) → disco null =
  pull (assimétrico B); disco==studio = registra baseline; divergem = CONFLITO
  (sem ancestral não dá pra arbitrar). Com ancestral → disco==cache&&studio==
  cache no-op; só disco mudou = disco→Studio; só studio mudou = Studio→disco;
  ambos mudaram e convergiram = registra baseline (`seedBaseline`, sem escrever);
  ambos divergem = CONFLITO.
- **Conflito NÃO é resolvido** (resolução legível é M5): `reportConflict` só
  loga warn + chama `onSyncConflict({diskPath, uuid})`, e crucialmente NÃO mexe
  no `contentCache` (deixa o ancestral velho pra que a resolução manual — salvar
  um lado — ainda divirja do ancestral e propague normal).
- **`DiskIO.listFiles(relDir)`** foi ADICIONADO à interface (+ NodeDiskIO via
  readdir recursivo com `withFileTypes`, ENOENT→[]; + VscodeDiskIO via
  `readDirectory` recursivo). Necessário porque o caso "arquivo só no disco,
  uuid nunca visto" exige enumerar o disco — o watcher não cobre (o evento
  aconteceu com a extensão fechada). Varredura é escopada por mount.diskPath
  (não a raiz toda) pra não pentear `.git`/`node_modules`; e filtrada por
  `resolveDataModelPathForDiskChange !== null` pra não logar cada `.json`/`.md`.
  Qualquer novo test-double de DiskIO precisa implementar `listFiles`
  (atualizei o `CountingDiskIO` do syncBridge.test.ts, delega ao inner).
- **Callback `onSyncConflict`**: mesmo padrão de `onWriteRejected`
  (SyncBridge campo+setter → SyncTeamService `setOnSyncConflict` → extension.ts).
  Em `extension.ts`, o comando coleta os conflitos do run atual num array
  module-level (`refreshConflicts`) que o callback alimenta, e ao final mostra
  UMA mensagem resumo via `showWarningMessage` listando os arquivos (em vez de
  um popup por conflito). Salvaguarda: se um conflito vier fora de um run do
  comando (`refreshConflicts === null`), mostra aviso avulso. Guarda
  `refreshInProgress` evita runs concorrentes.
- **Decisões em casos NÃO especificados pela tarefa** (documentar se virarem
  bug): (a) uuid em `diskPathByUuid` mas AUSENTE do listScripts fresco (script
  deletado no Studio enquanto fechado) → NÃO deleta o arquivo local
  (não-destrutivo), só loga warn; deleção Studio→disco não é propagada nesta
  versão. (b) arquivo removido do disco externamente mas com `cache` presente →
  também não-destrutivo, só loga (deleção disco→Studio já não era propagada
  desde o M2). (c) `cache` undefined mas os dois lados existem e divergem →
  tratado como conflito (safe).
- **Guarda no comando**: `service.isClientConnected()` (novo passthrough em
  SyncTeamService → `SyncServer.isClientConnected`) antes de disparar — senão o
  `listScripts` interno falha com "nenhum plugin conectado". Sem plugin/sem
  serviço/já em andamento → mensagem clara, não roda.
- **Status bar NÃO foi adicionada** — é domínio do `ui-dev` (regra de
  workflow); implementei só o comando (Command Palette via package.json
  `contributes.commands`, que é ponto de integração, não UI visual). Sinalizar
  ao orquestrador se quiser um atalho na status bar / ícone / progress
  notification durante o refresh.
- **Setup de teste do merge**: `runInitialSync` com `transport.sources` pré-
  populado dá o baseline `disco==Studio==cache`; depois `writeTmp` (escreve no
  tmpdir direto, bypassando a ponte) simula edição externa de disco e
  `transport.sources.set` simula edição do Studio. Provar que o baseline foi
  atualizado no caso "convergiram" (caso 5): segundo refresh com só o Studio
  voltando pro valor antigo vira caso 4 e escreve — se o baseline não tivesse
  movido, seria conflito. 28 testes no syncBridge.test.ts (era 20), 108 no
  total. `tsc`/`vitest`/`esbuild` limpos.

## Heartbeat WS ping/pong + notificações de conexão (2026-07-15)

Bug do usuário: após "Reload Window" do VS Code (mata o processo da extensão,
derruba o servidor WS SEM mandar frame de close), o painel do plugin no Studio
ficava mostrando "conectado" por tempo indefinido, porque a queda só era
detectada pelos eventos `Closed`/`Error` do WebStreamClient — que não disparam
num kill abrupto. Fix definitivo: heartbeat ativo nos dois lados.

### CONTRATO ping/pong que o lado Luau (luau-dev) PRECISA espelhar

- **Aditivo ao protocolo, SEM bump de `PROTOCOL_VERSION`** (mesmo precedente de
  `leaseChanged`/`presenceUpdate`). Dois `kind` novos em `protocol.ts`:
  `PingMessage {kind:"ping"}` (extensão→plugin) e `PongMessage {kind:"pong"}`
  (plugin→extensão). Ambos sem `requestId`/ack — são espontâneos.
- **Extensão→plugin**: o `SyncServer` manda `{"kind":"ping"}` a cada
  **5000ms** (`DEFAULT_HEARTBEAT_INTERVAL_MS`) enquanto houver plugin conectado
  (começa logo após aceitar o `hello`).
- **Plugin→extensão (a implementar pelo luau-dev)**: ao receber `{kind:"ping"}`
  no `MessageReceived`, responder com `{"kind":"pong"}` (via
  `client:Send(HttpService:JSONEncode({kind="pong"}))`). Qualquer outra
  mensagem do plugin também conta como sinal de vida para a extensão — o pong é
  só a resposta barata dedicada quando não há mais nada a dizer.
- **Detecção do lado da extensão (já implementada)**: se NENHUMA mensagem (pong
  OU qualquer outra) chegar do plugin em **15000ms**
  (`DEFAULT_HEARTBEAT_TIMEOUT_MS` = 3x o intervalo — tolera até 2 pings
  perdidos sem falso positivo), a extensão trata como morto: `socket.terminate()`
  → dispara o handler de `close` → `onClientDisconnected` → `ConnectionState`
  vira desconectada, MESMO que o TCP nunca tenha avisado. É exatamente o
  requisito "fecha a conexão do lado do servidor e atualiza estado sem depender
  do socket avisar".
- **Detecção do lado do plugin (a implementar pelo luau-dev, é o que conserta o
  BUG relatado)**: o plugin deve considerar a extensão morta se não receber
  nenhum `ping` (nem outra mensagem) da extensão dentro de um timeout análogo
  (sugestão: mesmo 3x do intervalo que a extensão usa = ~15s, ou 2-3 pings
  perdidos). Com pings a cada 5s, o painel do Studio detecta a queda em ~15s em
  vez de "indefinido". Sem isso do lado Luau, o bug do painel continua — o meu
  lado só GARANTE que os pings chegam de 5 em 5s para o plugin poder contar.

### Onde ficou o código (extensão)

- `src/sync/HeartbeatMonitor.ts` — módulo PURO (sem `ws`/`vscode`), testável com
  timers fake. `start()`/`recordActivity()`/`stop()`/`isRunning()`; construtor
  recebe `intervalMs`/`timeoutMs`/`sendPing`/`onTimeout`/`now?`/`onDeadLog?`.
  Relógio (`now`) injetável só para robustez de teste; na prática usa `Date.now`
  (que o `vi.useFakeTimers()` do vitest também controla). Comparação de timeout é
  estritamente `>` — silêncio == timeoutMs ainda manda ping; estoura no tick
  seguinte (por isso a detecção real acontece em ~4x o intervalo, não 3x — ok,
  dá margem). `tick()` chama `stop()` ANTES de `onTimeout()` pra evitar
  reentrância (onTimeout fecha o socket → handler de close chama `stop()` de
  novo, idempotente).
- `src/sync/SyncServer.ts` — construtor mudou de 3º param posicional
  `requestTimeoutMs` para um objeto `SyncServerOptions`
  (`{requestTimeoutMs?, heartbeatIntervalMs?, heartbeatTimeoutMs?}`). Nenhum
  caller passava o 3º param posicional, então foi seguro
  (`new SyncServer(port, logger)` continua igual). `startHeartbeat(socket)`
  criado em `handleHello` no sucesso; `recordActivity()` chamado no TOPO do
  handler de `message` (antes até do parse — qualquer frame conta); `pong`
  engolido (não vai pro `onSpontaneous`, evita "kind desconhecido"); `ping`
  vindo do plugin (fora do contrato) responde `pong` por robustez. Heartbeat
  parado/nulo em `close` e em `stop()`.
- **Pegadinha que confirmei lendo o fluxo**: `SyncServer.stop()` zera
  `this.client = null` logo após `client.close()`, e o handler de `close` tem
  guard `if (this.client === socket)`. Consequência: numa parada DELIBERADA do
  servidor (stop/restart/setPort) o `onClientDisconnected` NÃO dispara. Só
  dispara em desconexão-surpresa (peer fechou, ou `terminate()` do heartbeat).
  Isso é o que deixa a notificação "plugin desconectou" ser precisa (sem ruído
  ao parar o servidor de propósito) — usei isso de propósito.

### Notificações visíveis (Pedido 2)

- Reaproveitei o padrão de callback `setOnX` já estabelecido (não inventei
  mecanismo novo): 3 callbacks novos em `SyncTeamService` —
  `setOnPluginConnected` / `setOnPluginDisconnected` / `setOnProtocolError`.
  `extension.ts` liga cada um a `showInformationMessage` (conectou) /
  `showWarningMessage` (desconectou) / `showErrorMessage` (protocolo
  incompatível). Os dois primeiros disparam dos handlers
  `onClientConnected`/`onClientDisconnected` do `SyncServer` (sinal preciso:
  eventos reais de socket, não start/stop do servidor — ver pegadinha acima).
  O protocolo-error é um caminho novo em `SyncServer.handleHello`: no mismatch
  de `protocolVersion` chama `handlers.onProtocolError(msg)` além do log/close
  1002 que já existiam.
- **Decisão de UX**: notifico em TODA conexão real (não só a "primeira") —
  reconexão após queda também mostra "conectado", o que é útil (confirma
  recuperação). Desconexão só notifica em queda-surpresa. Escolhi
  `showWarningMessage` (não error) para desconexão porque é recuperável e o
  servidor continua no ar esperando reconexão.

### Testes (127 no total, +9)

- `test/heartbeatMonitor.test.ts` (6, timers fake): silêncio→timeout; pong/
  atividade mantém vivo; `stop()` cancela; `start()` idempotente; recordActivity
  fora do ciclo é no-op; `onDeadLog` com o silêncio medido.
- `test/syncServer.test.ts` (3, socket ws REAL em 127.0.0.1 = "plugin fake",
  timers reais curtos 30ms/90ms): plugin que ignora pings é desconectado sem
  frame de close (`isClientConnected()` vira false); pong mantém vivo + ping é
  enviado + pong não vira espontâneo; protocolVersion incompatível dispara
  `onProtocolError` e fecha 1002. Helper `getFreePort()` via `net` (efêmera +
  close) porque o `SyncServer` recebe porta fixa e não expõe a atribuída.
- `npm run lint` (tsc) limpo, `npm test` 127/127, `npm run build` gera os dois
  bundles (`dist/extension.js`, `dist/run-node-harness.js`).
- **Não testado em Studio real**: o round-trip do heartbeat depende do lado
  Luau responder `pong` E implementar a própria detecção de ping ausente — isso
  é tarefa do luau-dev (o contrato acima é o que ele precisa seguir). Só validei
  o lado da extensão com plugin fake.

## Rejeição de 2ª conexão avisa o motivo por MENSAGEM antes do close (2026-07-15)

Contexto: `WebStreamClient` do plugin NÃO consegue ler o close code nem o reason
de um close (evento `Closed()` do Luau não tem parâmetro — doc oficial,
`.claude/research/2026-07-15-webstreamclient-close-code.md`). Então o
`socket.close(1013, "...")` que já rejeitava a 2ª conexão em `handleConnection`
não dava NENHUM aviso legível ao plugin — só um retry loop genérico.

- **Fix em `SyncServer.handleConnection`** (bloco de rejeição de 2º cliente):
  ANTES de `socket.close(1013, ...)`, mando uma mensagem de aplicação de verdade
  `{kind:"connectionRejected", reason:"port_in_use"}` (que `MessageReceived`
  recebe normalmente — esse canal funciona, diferente do close). Uso o CALLBACK
  do `send()` da lib `ws` (assinatura confirmada no
  `node_modules/@types/ws/index.d.ts`: `send(data, cb?: (err?: Error) => void)`)
  para só chamar `socket.close()` DEPOIS que o envio confirmar — evita a corrida
  em que `close` engole o frame antes de ele sair. `err` é logado como erro se
  presente, mas o close acontece de qualquer jeito.
- **`connectionRejected` é ADITIVA ao protocolo, SEM bump de `PROTOCOL_VERSION`**
  (mesmo precedente de `ping`/`leaseChanged`/`presenceUpdate`). Documentada como
  `ConnectionRejectedMessage` em `protocol.ts`. `reason` é STRING (não booleano)
  de propósito — pode crescer (ex.: um dia rejeição por versão incompatível
  poderia reusar o mesmo formato), mas HOJE o único valor é `"port_in_use"` e
  NÃO mexi no fluxo separado de rejeição por `protocolVersion` (que continua
  fechando 1002 + `onProtocolError`, sem mensagem `connectionRejected`).
- **Teste** (`syncServer.test.ts`, "segunda conexão recebe connectionRejected
  ANTES do close", agora 4 testes no arquivo, 128 no total): 1º plugin conecta
  e vira dono; 2º plugin ws real registra a ORDEM dos eventos num array
  (`["message","close"]`) e confirma `reason==="port_in_use"`, `closeCode===1013`,
  e que o 1º plugin continua conectado. **Pegadinha que me mordeu**: anexei os
  listeners de `message`/`close` DEPOIS de `await openClient` e o teste falhou
  (`rejected` null) — o frame de rejeição chega cedo demais e se perde se o
  listener não estiver anexado. Corrigido construindo o `new WebSocket(...)`
  direto e anexando `message`/`close` na CONSTRUÇÃO (antes de "open"). Vale para
  qualquer teste futuro que dependa de uma mensagem que o servidor manda
  imediatamente na conexão.
- **Verificação**: `npm run lint` (tsc) limpo, `npm test` 128/128, `npm run build`
  gera os dois bundles (`dist/extension.js`, `dist/run-node-harness.js`).
- **Contrato para o luau-dev** (não implementado aqui, sinalizar ao
  orquestrador): o plugin pode tratar `{kind:"connectionRejected",
  reason:"port_in_use"}` chegando em `MessageReceived` como "porta já tem outro
  plugin" e mostrar isso ao usuário no painel, em vez do retry silencioso. É o
  único jeito de o plugin saber o motivo — o close não carrega nada.

## Comandos start/stop/restart/setPort agora dão feedback visível (2026-07-15)

Bug do usuário: rodar `SyncTeam: Iniciar servidor` pelo Command Palette não
confirmava NADA visível (sucesso OU falha só iam para o Output channel), então
o usuário não sabia se o servidor subiu, falhou (ex.: `EADDRINUSE`/porta em uso)
ou travou.

- **Onde a mensageria vive: DENTRO do `SyncController`, roteada por
  `host.info`/`host.error`** — NÃO nos handlers de comando em `extension.ts`.
  Motivo decisivo é testabilidade: os testes vitest não tocam `vscode`, então a
  única forma de asserir "mostrou info com a porta certa / mostrou error com o
  motivo" é um FakeHost capturando `info`/`error`. Handlers de comando em
  `extension.ts` chamam `vscode.window.showX` direto e seriam intestáveis.
  Segui o precedente que já existia (o `host.info` das mensagens idempotentes já
  passava por aqui exatamente por isso).
- **`SyncControllerHost` ganhou `error(message)`** (par do `info` já existente;
  `extension.ts` liga a `showErrorMessage`). E **`startService` mudou de
  `Promise<boolean>` para `Promise<StartServiceResult>`** (`{ ok: boolean;
  reason?: string }`) — o `boolean` perdia o MOTIVO da falha, que o usuário
  precisa ver. Os 4 pontos de `return` em `extension.ts::startService` agora
  devolvem `reason` legível: sem `default.project.json`, sem ponto de montagem,
  e o `catch` do `service.start()` (que é onde `EADDRINUSE` aparece) →
  `erro ao abrir a porta N — <message>`.
- **As assinaturas PÚBLICAS de `start/stop/restart/setPort` continuam
  `Promise<void>`** (a tarefa pediu para não mudá-las sem necessidade). Só
  adicionei um `options?: { announce?: boolean }` opcional ao `start` — ver
  abaixo.
- **`announce` existe por causa do autostart**: se a mensageria fosse
  incondicional em `start()`, o autostart (roda a cada abertura de workspace,
  já que `activationEvents` é `workspaceContains:**/default.project.json`)
  poparia "servidor iniciado na porta N" TODA vez — spam. Então
  `extension.ts` chama `controller.start({ announce: false })` no autostart
  (silencioso em sucesso E falha, idêntico ao comportamento anterior); os
  comandos usam o default `announce: true`. Decisão consciente: **falha de
  autostart continua só no log**, não popa — se algum dia quiserem surfaçar
  falha de autostart (mesma classe do bug original), é um `announce` de dois
  campos (announceSuccess/announceFailure) ou similar; deixei fora de escopo.
- **`doStart(announce)` é o núcleo compartilhado** por start/restart/setPort:
  lê `getConfiguredPort()`, chama o host, atualiza `running`, emite estado e (se
  announce) mostra info-sucesso-com-porta ou error-falha-com-motivo. Tem
  `try/catch` em volta do `host.startService` mesmo o contrato dizendo que ele
  nunca lança — a tarefa exigia que "qualquer exceção de start()" virasse
  feedback, e a cadeia de comando não pode terminar numa Promise rejeitada
  borbulhando pro `registerCommand` (que a engoliria sem UI). Exceção → falha
  anunciada, `start()` resolve normalmente.
- **`restart` mostra só o resultado do START** (um popup "iniciado na porta N"),
  não "parado" + "iniciado" (dois popups = ruído). `setPort` válido →
  `setConfiguredPort` + `restart` → mesmo popup, agora com a porta NOVA; se o
  restart falhar (porta nova ocupada), mostra o error — a cadeia do setPort
  nunca termina em silêncio. `setPort` cancelado/ inválido (`parsePortInput`
  === null) continua no-op silencioso (correto: usuário desistiu).
- **Mensagem idempotente de start ganhou a porta**: era "o servidor já está
  rodando.", agora "...na porta N." (o controller tem `this.currentPort`). Stop
  idempotente ("já está parado.") ficou igual.
- **Teste**: `test/syncController.test.ts` NOVO (13 testes), FakeHost
  implementando `SyncControllerHost` com arrays `infos`/`errors` +
  `nextStartResult`/`startThrows` configuráveis + contadores
  (`startCalls`/`stopCalls`/`setPortCalls`) para asserir idempotência. Cobre:
  start sucesso (info+porta), start falha (error+motivo), start exceção (resolve
  sem rejeitar), start já-rodando (não rechama startService), stop sucesso/já-
  parado, restart sucesso/falha, setPort válido/restart-falha/cancelado, e os
  dois caminhos de `announce:false` (autostart silencioso em sucesso e falha).
- **Verificação**: `npm run lint` (tsc) limpo, `npm test` 141/141 (era 128,
  +13), `npm run build` gera os dois bundles (`dist/extension.js`,
  `dist/run-node-harness.js`). **Não testado em VS Code real** — só a lógica do
  controller com FakeHost; a fiação `host.info`/`host.error` →
  `showInformationMessage`/`showErrorMessage` em `extension.ts` é trivial e não
  coberta por teste (nenhum teste toca `vscode`, limitação de sempre).

## `syncteam.multiSync` — N Studios na mesma porta/extensão (2026-07-15)

Feature pedida pelo usuário: cenário de 1 dev com 2 contas Roblox/2 Studios na
MESMA máquina testando multiplayer, sincronizando os dois com 1 VS Code só (em
vez de precisar de 2 janelas de VS Code em portas diferentes). Setting novo
`syncteam.multiSync` (boolean, default `false`) — com o default, o
comportamento é EXATAMENTE o de antes (2º cliente rejeitado com
`connectionRejected`/`port_in_use`), confirmado pelos 4 testes de heartbeat/
rejeição pré-existentes continuando a passar sem alteração nenhuma.

- **`SyncServer.ts`**: `this.client: WebSocket | null` → `this.clients: Set<WebSocket>`
  + `this.heartbeats: Map<WebSocket, HeartbeatMonitor>` (cada plugin tem seu
  PRÓPRIO monitor de heartbeat — importante: `sendPing`/`onTimeout` fecham
  sobre O SOCKET ESPECÍFICO, nunca broadcast; um plugin lento/morto não afeta
  o relógio de silêncio dos outros). `isClientConnected()` = `openClients().length > 0`;
  `getConnectedCount()` novo (passthrough até `SyncTeamService.getConnectedCount()`,
  não fiado em nenhuma UI ainda — ver decisão de escopo abaixo).
- **`handleConnection`**: a rejeição do 2º cliente agora é `if (!this.multiSync && this.openClients().length > 0)`
  — com `multiSync=true` simplesmente não entra nesse bloco e segue o fluxo
  normal de hello para qualquer número de conexões.
- **Broadcast de saída (`send()`)**: mudou de "manda pro `this.client`" para
  "manda pra TODOS os `openClients()`". Funciona igual com 1 ou N clientes —
  **não precisou de nenhum `if (multiSync)` no `send()`**, porque com
  `multiSync=false` o Set nunca tem mais de 1 elemento mesmo (a rejeição em
  `handleConnection` garante isso antes de qualquer hello). Isso cobre
  `request()` e `sendSpontaneous()` de graça, sem duplicar lógica.
- **Pegadinha real que peguei DURANTE a implementação (não estava no desenho
  original)**: o `sendPing` do heartbeat e a resposta a um `ping` vindo do
  plugin (`message.kind === "ping"` no handler de `message`) usavam
  `this.send(...)` — que agora é broadcast! Isso faria CADA heartbeat/pong
  vazar para TODOS os clientes conectados (ping de um plugin sendo mandado
  também pro outro, resposta de pong indo pros dois). Corrigido: ambos usam
  `socket.send(...)` DIRETO no socket específico (com guard
  `socket.readyState === socket.OPEN`), nunca `this.send`. `this.send` (via
  `request`/`sendSpontaneous`) continua sendo o único caminho de broadcast
  de verdade — reservado para mensagens que fazem sentido pra todos os
  Studios (writeSource, presenceUpdate encaminhado), nunca para eco 1:1 como
  ping/pong.
- **`request()` — primeira resposta vence**: NENHUMA mudança de código foi
  necessária além do broadcast em `send()`. `resolvePending` já deletava a
  entrada do `pending` map ao resolver — uma 2ª resposta com o mesmo
  `requestId` (de um 2º plugin respondendo à mesma requisição broadcast) não
  encontra mais a entrada, `resolvePending` retorna `false`, e a mensagem cai
  no fallback `handlers?.onSpontaneous(message)`. Isso é seguro: os `kind`s de
  resposta (`scriptList`/`sourceContent`/`writeAck`) não são tratados no
  `switch` de `SyncTeamService.routeSpontaneous`, então caem no `default` e só
  geram um log informativo "kind desconhecido ignorado" — nenhum erro, nenhum
  crash. Testado explicitamente (`syncServer.test.ts`, "request() broadcast...
  resolve na PRIMEIRA resposta e ignora a 2ª sem erro") fazendo o 2º cliente
  responder com delay de 30ms de propósito.
- **Desconexão de 1 cliente entre N**: o handler de `close` só chama
  `rejectAllPending` quando `this.clients.size === 0` DEPOIS de remover o
  socket que caiu — se outros plugins continuam conectados, uma requisição
  pendente pode ainda ser respondida por eles (ou estoura no timeout normal).
  `onClientDisconnected` ainda dispara por conexão individual (não é
  "resetado" globalmente) — ver decisão de escopo abaixo sobre
  `SyncTeamService` reagir a isso por conexão, não por servidor.
- **Dedupe de espontânea duplicada (`SyncTeamService.routeSpontaneous`)**:
  novo campo `multiSync: boolean` no construtor (default `false`, ÚLTIMO
  parâmetro — todo call site existente que não passa continua com o
  comportamento de sempre). Guarda simples (`lastSpontaneousSignature`/
  `lastSpontaneousAt`, SEM histórico, "simples e barato" como pedido):
  `computeSpontaneousSignature(message)` extrai só os campos relevantes por
  `kind` (`sourceChanged`→uuid+source, `scriptAdded`→uuid+path+className,
  etc.; fallback `JSON.stringify` genérico pra `kind` não listado) —
  DELIBERADAMENTE não usa `JSON.stringify(message)` inteiro pra tudo, porque
  campos informativos como `origin`/`via` em `sourceChanged` poderiam variar
  entre os 2 Studios reportando o MESMO evento e mascarar uma duplicata real.
  Janela: **800ms** (escolhida dentro do range sugerido 500ms-1s). Só ativo
  quando `this.multiSync` é `true` — com o default, `routeSpontaneous` nem
  entra no bloco de checagem, então NENHUMA mudança de comportamento pro caso
  default (confirmado por teste dedicado comparando multiSync=true vs false
  com a MESMA sequência de mensagens).
- **`getConnectedCount()`**: adicionei em `SyncServer` e `SyncTeamService`
  (passthrough simples) pensando no comentário da tarefa sobre
  `ConnectionState.connected: boolean` virar `connectedCount: number` no
  futuro. **Decisão deliberada de NÃO mexer em `ConnectionState`/`SyncController`
  agora** — mudar o tipo exposto pro `ui-dev` sem necessidade concreta desta
  fatia (nenhum consumidor pede isso ainda) é risco desnecessário; deixei só
  o método novo disponível para quem quiser consumir depois. Sinalizar ao
  `ui-dev`/orquestrador se quiserem "N Studios conectados" na status bar.
- **Item 5 da tarefa (clientId nos logs) — implementado PARCIALMENTE por
  decisão consciente**: o log de conexão aceita (`handleHello`) agora inclui
  `clientId=...` e a contagem atual de plugins conectados. NÃO propaguei
  `clientId` para dentro de cada mensagem espontânea individual roteada em
  `SyncTeamService` (`sourceChanged`/`scriptAdded`/etc.) porque o protocolo
  não carrega "qual socket originou" nessas mensagens — só o socket sabe, e
  `SyncServer.handlers.onSpontaneous(message)` não repassa a origem. Adicionar
  isso exigiria mudar a assinatura de `onSpontaneous` (2º parâmetro com
  metadado da conexão) — fora de escopo desta fatia por ser mudança maior de
  contrato; documentado aqui para quem quiser puxar depois.
- **`package.json`**: `syncteam.multiSync` (boolean, default `false`) em
  `contributes.configuration`. `extension.ts::startService` lê a config uma
  vez no início (mesmo padrão de `syncteam.port`/`autoStart` — mudar a config
  exige stop+start/restart pra ter efeito) e passa pro `SyncServer` (opção
  `multiSync`) E pro `SyncTeamService` (5º parâmetro construtor).
- **Testes**: `syncServer.test.ts` ganhou `describe("SyncServer — multiSync")`
  (4 testes nos, 8 no total do arquivo): 2 conectam sem rejeição +
  `getConnectedCount()`; broadcast de `sendSpontaneous` chega nos 2;
  `request()` resolve na 1ª resposta e a 2ª (atrasada de propósito) cai em
  `onSpontaneous` sem erro; desconectar 1 não afeta o outro
  (`getConnectedCount()` cai pra 1, `isClientConnected()` continua `true`).
  `syncTeamService.test.ts` ganhou `describe(".. — dedupe multiSync")` (4
  testes): duplicata idêntica é descartada com `multiSync=true`; a MESMA
  duplicata NÃO é descartada com `multiSync=false` (prova de não-regressão);
  uuids diferentes não dedupem; mesmo uuid com conteúdo DIFERENTE
  (`sourceChanged`) não dedupe. **150 testes no total** (era 141, +9).
- **Verificação**: `npm run lint` (tsc) limpo, `npm test` 150/150, `npm run build`
  gera os dois bundles. **Não testado com 2 Studios reais** — só a lógica com
  ws real (2 clientes fake) e fakes de `SyncBridge`/logger; validação de
  verdade (2 contas Roblox no mesmo VS Code) fica pro roteiro manual em
  `docs/PROJECT_STATUS.md` se o usuário quiser confirmar antes do M5.
- **Nenhuma das decisões do desenho original precisou de desvio** — os 3
  pontos que a tarefa marcou como "pare e sinalize se não bater" (broadcast
  de saída, `request()` primeira-resposta-vence, dedupe de espontânea) todos
  encaixaram de forma limpa na estrutura existente; a única surpresa foi a
  pegadinha do ping/pong vazando por broadcast (documentada acima), que não
  era uma decisão de desenho, só um bug que eu mesmo teria introduzido se não
  tivesse revisado todo uso de `this.send`.

## Exclusão de pastas de pacotes Wally do live-edit-sync (2026-07-16)

Tarefa em paralelo com `luau-dev` (que fez o lado plugin em `Config.luau`/
`SourceWatcher.luau`/`init.server.luau`, ver `docs/DECISIONS.md` mesma data).
Motivo: dois devs com `Packages/` locais divergentes (wally.lock desatualizado)
não podem empurrar Source de pacote vendorizado um pro outro via Team Create.

- **Módulo puro novo**: `src/mapping/wallyPackageFolders.ts`
  (`isExcludedPackageFolderName`/`isInsideExcludedPackageFolder`), mesmo
  padrão de `rojoPathMapping.ts` (sem I/O, sem `vscode`). Contrato de nomes
  EXATO combinado com o luau-dev: `"Packages"`, `"ServerPackages"`,
  `"DevPackages"`, case-sensitive, segmento INTEIRO do path (nunca
  substring — `"MyPackagesFolder"` não conta, mas `"src/Packages"` conta
  porque `"Packages"` é um segmento exato ali).
- **Distinção crítica que guiou toda a implementação: CRIAÇÃO sempre passa,
  só ATUALIZAÇÃO de conteúdo já existente é bloqueada.** Isso significa que o
  check nunca vai no início de uma função genérica — sempre DEPOIS de saber
  que o script/arquivo já tinha uuid conhecido (update), nunca no ramo de
  "uuid ainda não visto" (create). Os 3 pontos de integração em
  `SyncBridge.ts`:
  1. `handleSourceChanged` (Studio→disco, mensagem espontânea de verdade,
     não é a leitura inicial de `runInitialSync`/`scriptAdded`): early-return
     ANTES de `applyStudioContent`, checando `this.scripts.get(uuid)?.path`
     (fallback pro `message.path` informativo se por algum motivo o uuid
     ainda não estiver em `this.scripts`).
  2. `handleLocalFileChange`, SÓ dentro do ramo `knownUuid !== undefined`
     (update): early-return antes de tocar `contentCache`/mandar
     `writeSource`. O ramo de baixo (uuid desconhecido = criação) fica
     intocado — segue funcionando normal dentro dessas pastas, porque é
     assim que um pacote novo aparece no Studio pela primeira vez.
  3. `reconcileUuidOnRefresh` (Refresh Sync/merge de 3 vias) — o mais
     delicado dos três porque tem 5+ ramos. Calculei `excluded` uma vez logo
     depois de confirmar `diskPath !== undefined` (usando
     `pluginScripts.get(uuid)?.path`, o listScripts FRESCO, não o antigo
     `this.scripts`) e só apliquei o skip nos ramos que fazem PUSH (só disco
     mudou → skip; só Studio mudou → skip) ou reportam CONFLITO (com ou sem
     ancestral no `contentCache` → skip, sem chamar `onSyncConflict`, log
     `info` em vez de `warn`). Os ramos "descoberto só no Studio, sem arquivo
     local → pull" e "convergiram → atualiza baseline" ficaram SEM check —
     não são push nem conflito, são descoberta/bookkeeping que a tarefa
     pediu para preservar. `reconcileDiskOnlyFiles` (arquivo só em disco,
     uuid nunca visto → cria) também ficou sem check nenhum, mesmo raciocínio
     do item 2.
- **Decisão consciente ao pular update em pasta excluída**: NÃO atualizo
  `contentCache` no early-return (nem em `handleSourceChanged` nem em
  `handleLocalFileChange`) — não haveria ganho (o conteúdo não foi de fato
  sincronizado) e deixar o cache "congelado" no último valor realmente
  sincronizado é o que faz `reconcileUuidOnRefresh` continuar vendo a
  divergência do jeito certo numa reconciliação futura (se um dia a exclusão
  for removida/ajustada, o histórico de divergência não se perde
  silenciosamente).
- **Testes**: `test/wallyPackageFolders.test.ts` (13, função pura — nomes
  exatos, substring não conta, segmento em qualquer posição, path vazio,
  funciona igual para diskPath com extensão). `test/syncBridge.test.ts` ganhou
  um `describe` dedicado (3 testes: skip de `sourceChanged`, skip de update
  local, criação local dentro de `DevPackages` continua funcionando) mais um
  sub-`describe` dentro do bloco de `refreshSync` (4 testes: só disco mudou
  ignorado, só Studio mudou ignorado, conflito genuíno SEM `onSyncConflict`
  disparado, criação nova via `reconcileDiskOnlyFiles` continua funcionando).
  179 testes no total (era 172). `npx tsc --noEmit` limpo, `npx vitest run
  --pool=threads` 179/179 (pool forks quebra neste ambiente, sempre
  `--pool=threads`), `npm run build` gera os dois bundles sem erro.
- **Não testado em Studio real** — mesma limitação do lado luau-dev; fica
  `[Hipótese]` até round-trip real (instalar pacote Wally de verdade, editar
  pelos dois lados, confirmar que nada vaza).
