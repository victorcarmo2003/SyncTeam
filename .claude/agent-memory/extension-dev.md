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
