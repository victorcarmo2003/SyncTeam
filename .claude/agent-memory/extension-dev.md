# Memória do extension-dev

Decisões técnicas e pegadinhas de TypeScript/Node/VS Code do projeto.
Atualize ao final de cada tarefa; mantenha curto e acionável.

## Bug de performance real: fila FIFO sem coalescência para pulses de buffer = backlog sem limite (2026-08-04, docs/DECISIONS.md "19ª rodada")

Regressão do fix da 18ª rodada (abaixo): usuário testou de novo e reportou
PIOROU — trava TOTAL de autocomplete (não só lenta), escalando com TAMANHO
do arquivo, persistindo por um tempo mesmo depois de parar de digitar.
Padrão diferente do bug anterior (aquele era sobre volume de eventos de
watcher em pastas irrelevantes, não escala com tamanho de arquivo
individual sendo editado) — hipótese nova, confirmada por MEDIÇÃO real, não
só leitura de código.

- **Lição principal, generalizável para qualquer throttle/debounce futuro
  neste projeto**: throttle de AGENDAMENTO (limitar a frequência com que um
  novo `setTimeout` é CRIADO) não é a mesma coisa que limitar quantas
  TAREFAS ficam em voo/pendentes num consumidor assíncrono mais lento. O
  `BUFFER_PULSE_THROTTLE_MS` de `extension.ts::scheduleBufferPulse` (150ms)
  só impedia agendar um SEGUNDO timer enquanto o primeiro ainda não tinha
  DISPARADO — no instante em que dispara, ele se remove do Map e chama
  `notifyBufferChange` sem aguardar nada, liberando o próximo agendamento
  imediatamente. Nada ali limitava quantas chamadas de
  `notifyBufferChange` — cada uma virando um `enqueueMutation` na fila FIFO
  ÚNICA e GLOBAL do `SyncTeamService` (`queueTail`) — ficavam empilhadas
  esperando a vez. Cada item da fila faz um `await transport.request(...)`
  (round-trip REAL até o plugin no Studio); se esse round-trip é mais lento
  que o intervalo entre pulses (bem provável durante digitação contínua), o
  backlog cresce SEM LIMITE — não é "mais lento", é "cresce sem parar", daí
  a trava total e a persistência depois de parar de digitar (a fila ainda
  está drenando o que acumulou).
- **Medido ao vivo, não só hipótese**: escrevi um teste com socket ws real
  e um "plugin" fake que atrasa deliberadamente o ack de `writeSource`
  (`test/syncTeamService.test.ts`, describe "coalescência de pulses do
  MESMO path") — ANTES do fix, 12 pulses síncronos no MESMO path geravam
  **11** `writeSource` reais sequenciais (não coalescidos, quase 1:1); 6+6
  pulses em dois paths diferentes geravam 5+5. Rodei o teste com a
  asserção FINAL (`<=2`) contra o código NÃO corrigido de propósito, só
  para deixar a falha do vitest documentar o número real — é uma forma
  barata de "instrumentação" sem precisar escrever um script descartável à
  parte.
- **Pegadinha de timing ao escrever o teste**: minha primeira tentativa
  disparava os pulses com `await new Promise(r => setTimeout(r, 5))` entre
  cada um (achando que 5ms << round-trip de 50ms garantiria 1 única janela
  de coalescência). Isso deu resultados MELHORES que sem fix, mas ainda
  MAIORES que 2 (4 e 3, não 2) — não porque o algoritmo de coalescência
  estivesse errado, mas porque `setTimeout(fn, 5)` no Windows não dispara em
  5ms de verdade (timer coalescing do SO, resolução tipicamente ~15ms) — o
  burst inteiro (12 iterações) podia se espalhar por mais tempo que o
  round-trip, abrindo várias janelas LEGÍTIMAS de coalescência em vez de
  uma só. **Fix do teste**: disparar o burst SEM NENHUM `await` entre as
  chamadas (loop síncrono, mesmo tick) — isso é tanto o caso mais
  adversarial quanto o mais determinístico para CI, porque não depende de
  precisão de timer do SO. Se uma tarefa futura escrever um teste
  "N eventos rápidos, no máximo M efeitos", preferir burst síncrono a
  `setTimeout` de poucos ms entre iterações — o segundo é sujeito a timer
  coalescing e pode inflar o resultado sem que o código sob teste tenha
  bug nenhum.
- **Fix, "latest-wins, no máximo 1 em voo + 1 pendente" por path** — vive em
  `SyncTeamService.ts` (não em `extension.ts` nem `SyncBridge.ts`): é o
  único lugar que já possui a fila FIFO (`enqueueMutation`) e enxerga TODAS
  as fontes que a alimentam. `bufferPulseInFlight: Set<string>` marca — no
  instante em que a tarefa é ENFILEIRADA, não quando começa a RODAR (a fila
  pode ter outra coisa na frente) — que já existe um buffer-pulse deste
  path em algum estágio. `bufferPulsePendingContent: Map<string, string>`
  guarda só o conteúdo MAIS RECENTE recebido enquanto isso (nunca uma fila
  própria — cada chamada nova SOBRESCREVE a entrada, não adiciona).
  `notifyBufferChange`: path em voo → só atualiza o Map pendente, retorna
  sem enfileirar. Path livre → `dispatchBufferPulse` imediato.
  `dispatchBufferPulse`: marca em voo, `enqueueMutation(...)`, e no
  `.finally()` (sucesso OU erro — `Promise.finally`, `lib: ES2022` já
  cobre) libera o path e, se sobrou pendente, dispara UMA nova tarefa
  recursivamente (se mais pulses chegarem durante essa 2ª rodada, coalescem
  de novo do mesmo jeito).
- **Por que isso NÃO reintroduz a race de 2026-07-27**: cada disparo
  (imediato ou "pendente") continua entrando na MESMA `enqueueMutation` —
  a ordem relativa a OUTRAS mutações (save, mensagens espontâneas do
  Studio, sincronização inicial) continua FIFO estrita. Só pulses de buffer
  do MESMO path se coalescem entre si; paths diferentes têm suas próprias
  entradas no Set/Map, nunca se atropelam (teste dedicado prova isso).
- **`extension.ts::scheduleBufferPulse` não precisou de nenhuma mudança** —
  seu throttle de agendamento continua útil (evita criar um timer por
  tecla), só deixou de ser a única linha de defesa contra backlog. A
  coalescência agora vive na camada que TODOS os chamadores de
  `notifyBufferChange` passam (extensão, e qualquer harness/CLI futuro que
  reuse `SyncTeamService`).
- **Observação registrada, não corrigida (fora de escopo desta tarefa)**:
  `handleBufferContentChange`/`pushKnownUuidUpdate` sempre mandam o
  CONTEÚDO COMPLETO do arquivo (`document.getText()`, não um diff) — o
  payload por round-trip ainda cresce com o TAMANHO do arquivo, não com o
  tamanho da edição. O backlog agora é limitado (no máximo 2 em voo), mas
  um arquivo grande ainda paga um payload grande por pulse — reprojetar
  para diffs incrementais mudaria o protocolo (`writeSource` hoje é sempre
  `{uuid, source}` completo) e não foi pedido nesta tarefa.
- **Verificação real**: `tsc --noEmit` limpo, `vitest run` 278/278 (era
  276, +2 testes novos), `esbuild` gera os dois bundles sem erro. Ganho de
  UX real no VS Code continua `[Hipótese]` (mesma limitação de sempre:
  exigiria Extension Development Host + digitação interativa cronometrada,
  fora do alcance de automação desta sessão).

## Bug de performance real: watcher `**/*` sem escopo + I/O antes de filtrar = LSP lento (2026-08-03, docs/DECISIONS.md "18ª rodada")

Usuário relatou autocomplete/LSP ~10x mais lento (VS Code + Luau LSP) com o
SyncTeam ativo. Hipótese do usuário (com evidência de código) confirmada
sem furos por leitura ponta a ponta.

- **Padrão a lembrar para qualquer FileSystemWatcher futuro neste
  projeto**: nunca observar a raiz inteira do workspace com `"**/*"` sem
  escopo. `dir` de um projeto Rojo-compatível quase sempre tem `.git/`,
  possivelmente `sourcemap.json` reescrito em alta frequência (`rojo
  sourcemap --watch`, companion comum do Luau LSP) e pastas Wally grandes
  (`Packages/`/`ServerPackages/`/`DevPackages/`). Um watcher sem escopo gera
  uma avalanche de eventos que, se cada um dispara trabalho real (I/O,
  fila), compete pelo MESMO extension host (processo Node único,
  compartilhado com clientes de LSP de outras extensões) — mecanismo direto
  para lentidão de UI aparentemente não relacionada.
- **Fix camada 1** (`extension.ts`, dentro de `startService`): trocado UM
  `createFileSystemWatcher(new RelativePattern(dir, "**/*"))` por **um
  watcher POR ponto de montagem** (`mountPoints.map(mount =>
  createFileSystemWatcher(new RelativePattern(dir, \`${mount.diskPath}/**\`)))`),
  guardados em `fileWatchers: vscode.FileSystemWatcher[]` (era uma variável
  única `fileWatcher`). **Decisão deliberada de NÃO usar glob combinado
  `{a/**,b/**}`** (sintaxe de OR-group) — não estava confirmada em
  `.claude/research/`, e a regra do projeto é não depender de comportamento
  de API não pesquisado (mesmo espírito de `.claude/rules/luau.md` do lado
  Luau). N watchers com padrão simples (`mountPoints.length` costuma ser
  pequeno, poucas unidades) sidesteps a dependência sem custo real. Se uma
  tarefa futura quiser essa sintaxe, pedir ao `researcher` confirmar
  primeiro.
- **Pastas Wally NÃO podem ser excluídas no nível do watcher** — elas moram
  DENTRO de um mount (ex. `src/server/Packages/...`, confirmado nos
  fixtures de teste), então escopar por mount as mantém no escopo. Isso é
  intencional: teste pré-existente (`test/syncBridge.test.ts`, "criação
  nova dentro de Packages... CONTINUA funcionando normalmente",
  2026-07-16) exige que descoberta de arquivo NOVO em pasta Wally continue
  funcionando — só a ATUALIZAÇÃO contínua de conteúdo já rastreado é
  excluída (por `isInsideExcludedPackageFolder`, dentro de
  `handleLocalFileChange`/`pushKnownUuidUpdate`/`handleLocalFileRemoved`).
  Não tentar "resolver" isso excluindo Packages do glob do watcher — quebra
  esse contrato já testado.
- **Fix camada 2** (`SyncBridge.ts::handleLocalFileChange`): a função fazia
  `await this.diskIO.readFile(relDiskPath)` **incondicionalmente**, e só
  DEPOIS checava `resolveDataModelPathForDiskChange`/`uuidByDiskPath` (as
  checagens que decidem se o path é aceito). Ou seja: todo evento de
  watcher pagava uma leitura de disco REAL (`vscode.workspace.fs.readFile`,
  round-trip IPC) mesmo para paths que iam ser descartados. Reordenado:
  `uuidByDiskPath.get(key)` (Map lookup puro) e
  `resolveDataModelPathForDiskChange`/`isInsideExcludedPackageFolder`
  (funções puras, sem I/O) agora rodam ANTES do `readFile` — se nenhuma das
  duas aceita o path, retorna sem tocar disco. **Padrão geral a lembrar**:
  em qualquer handler que faz I/O condicionalmente ao resultado, sempre
  ordenar as checagens PURAS antes das checagens que exigem I/O, nunca o
  contrário — parece óbvio em retrospecto, mas o código original tinha
  ficado assim organicamente (a checagem de "é candidato a criação?" só
  fazia sentido DEPOIS de já ter o conteúdo, então acabou ficando depois do
  read por conveniência de fluxo, não por necessidade real).
- **Teste da redução de I/O**: `CountingDiskIO` em `test/syncBridge.test.ts`
  ganhou `readCount` (só tinha `writeCount`/`renameCount`) — prova via
  contador que uma atualização dentro de `Packages` com uuid já conhecido
  NÃO dispara `readFile` nenhum, não só que o resultado é descartado depois
  (teste anterior já provava isso via `transport.sent`, mas não provava
  ausência de I/O). Se qualquer handler futuro ganhar um early-exit
  parecido, esse é o padrão de teste a reusar (contador de I/O real, não só
  resultado observável).
- **Não medido nesta tarefa** (`[Hipótese]`, honesto): o ganho real de
  latência de LSP em VS Code de verdade — exigiria Extension Development
  Host + digitação interativa cronometrada, fora do alcance de automação
  desta sessão (interação de GUI). Também não testado contra Studio real
  (porta 1401 oferecida pelo orquestrador) — decisão deliberada: a mudança
  é 100% client-side (nada em `plugin/src/`), o harness Node
  (`Tools/start-harness.sh`) usa `NodeDiskIO`/`fs.watch`, não
  `vscode.FileSystemWatcher` — não exercitaria a camada 1 (a maior parte do
  ganho) de qualquer jeito; e não havia pasta de projeto conhecida com
  segurança pra apontar um harness sem risco de escrever no lugar errado da
  sessão real do usuário. A camada 2 já está coberta por teste real
  (`NodeDiskIO`/tmpdir, mesmo código que o harness usaria).

## `syncteam-cli`: comandos `port`/`start`/`stop`/`extension install` (2026-08-03, docs/DECISIONS.md "12ª rodada")

Continuação do `cli/` (10ª/11ª rodada abaixo). Adicionados 4 comandos novos
(`plugin install` intocado): `syncteam port <PORT>`, `syncteam start [--dir
<pasta>]`, `syncteam stop`, `syncteam extension install`. 52 testes no total
(era 17), `bun run lint` limpo, testado de verdade nesta máquina (Windows)
incluindo o BINÁRIO COMPILADO real, não só modo interpretado.

### Achado mais importante desta tarefa: self-invocation de binário Bun compilado

`syncteam start` precisa reinvocar A SI MESMO como processo destacado
(daemon) — não dá pra saber de antemão se está rodando via `bun run
src/index.ts` (interpretado) ou como `.exe` compilado (`bun build
--compile`), e as duas formas de spawnar são diferentes. **Duas heurísticas
erradas tentadas antes de acertar, ambas confirmadas erradas com teste real
(não só análise)**:

1ª tentativa: comparar `process.argv[1]` contra `fileURLToPath(import.meta.url)`
do próprio `index.ts` — **falha**: no binário compilado, os dois campos
resolvem para o MESMO caminho VIRTUAL dentro do bunfs (formato observado:
`B:/~BUN/root/<nome>.exe`), então a comparação dá "igual" em AMBOS os modos,
não distingue nada.

2ª tentativa: adicionar `existsSync()` sobre esse caminho, assumindo que o
caminho virtual "não existe de verdade" — **também falha**: o `fs`
(`existsSync` incluído) do Bun RECONHECE/VIRTUALIZA esses caminhos
internos e retorna `true` mesmo para o caminho virtual. Confirmado ao vivo:
com as duas heurísticas acima, `syncteam.exe start` compilado tentava
reinvocar a si mesmo passando o caminho virtual como ARGUMENTO REAL
(`syncteam.exe "B:/~BUN/root/syncteam.exe" start --daemon-child`) — o
processo filho (o próprio `.exe`) recebia isso como um comando desconhecido
e morria na hora, fazendo `start` reportar "processo encerrou logo após
iniciar".

**Sinal que REALMENTE funciona** (confirmado com um probe dedicado,
`scripts/debug-argv-probe.ts`, rodado em modo interpretado E compilado nesta
máquina, depois removido — não é suposição):

| Campo | interpretado (`bun run src/index.ts`) | compilado (`.exe`) |
|---|---|---|
| `process.execPath` | caminho REAL do `bun.exe` | caminho REAL do próprio `.exe` |
| `process.argv[0]` | **igual a `execPath`** | **literal `"bun"`** (string fixa, nunca um path) |
| `process.argv[1]` | caminho REAL do script | caminho VIRTUAL bunfs |

`process.execPath === process.argv[0]` só é verdade em modo interpretado —
é ESSE o sinal certo (`src/daemon/selfInvocation.ts::resolveSelfInvocation`).
Quando bate, repassa `argv[1]` (script real) ao processo filho; quando não
bate (compilado), usa só `execPath` como comando + os args extras, SEM
repassar nenhum path. `[Verificado no Windows]`, Bun 1.3.13 — não testado em
macOS/Linux, mas o mecanismo de compilação do Bun é o mesmo cross-platform.
**Se qualquer tarefa futura mexer em self-respawn de um binário Bun
compilado, comece por este achado — não tente `argv[1]`/`import.meta.url`/
`existsSync` de novo, já sei que não funciona.**

### Outras decisões desta tarefa

- **Design de `start` em 2 processos**: o processo em FOREGROUND resolve
  conflito de porta de forma INTERATIVA (diálogo `[s/N]` via
  `readline/promises`, `src/prompt/confirmPrompt.ts`) usando um `SyncServer`
  TEMPORÁRIO com `onPortOccupied` ligado a `attemptPortReclaim` (reusado de
  `vscode-extension/src/sync/PortOwnership.ts` sem alteração — só a UI de
  confirmação muda, mesma interface `PortReclaimHost.confirmKill` que a
  extensão já usa com um modal). Depois de resolver, PARA o servidor
  temporário (`server.stop()`) e spawna um processo DESTACADO (a auto-
  reinvocação acima) que liga o motor real numa porta JÁ resolvida, sem hook
  interativo (processo destacado não tem terminal) e com
  `portFallbackAttempts: 0` (falha alto e claro em vez de escolher outra
  porta silenciosamente se uma corrida rara acontecer). O processo em
  foreground só retorna sucesso depois de CONFIRMAR (lendo o mesmo lockfile
  de posse de porta, `readPortLock`, checando que o PID bate com o processo
  que ele acabou de spawnar) que o daemon realmente abriu a porta — não é só
  "spawnei e torço".
- **`daemon/engine.ts`** é porte direto de
  `vscode-extension/tools/run-node-harness.ts` (mesma composição
  SyncServer+SyncTeamService+NodeDiskIO), mas via IMPORT CROSS-PACOTE dos
  arquivos-fonte de `vscode-extension/src/` (não uma cópia) — `cli/` não
  depende de `vscode-extension/` como pacote instalado, mas TypeScript
  resolve/type-checa a referência relativa normalmente entre os dois
  diretórios do mesmo repo. Log só via console (stdout/stderr) no daemon —
  `start.ts` já redireciona os dois para `~/.syncteam/daemon.log` via fd
  real (`fs.openSync(..., "a")`) no spawn; um segundo logger de arquivo
  duplicaria cada linha.
- **Atrito real do cross-import**: `cli/tsconfig.json` tinha
  `noUncheckedIndexedAccess: true` (vscode-extension NÃO usa essa flag) —
  isso fazia `tsc --noEmit` do CLI gerar ~8 erros em arquivos já
  validados/testados de `vscode-extension` (`projectMapping.ts`,
  `rojoPathMapping.ts`, `PortOwnership.ts`) só porque o CLI type-checa
  arquivos importados sob as PRÓPRIAS opções do compilador, não as do
  pacote de origem. **Removida** do `cli/tsconfig.json` para alinhar com a
  baseline de `vscode-extension` (que também é `"strict": true`, só sem essa
  flag extra) — decisão registrada em vez de silenciosa. Se uma tarefa
  futura reusar mais arquivos de `vscode-extension/` no CLI e topar com o
  mesmo tipo de erro, a causa é essa — não é bug no código importado.
- **`ws`/`@types/ws` precisaram ser adicionados como dependência REAL do
  CLI** (`bun install`) — `SyncServer.ts`/`PortOwnership.ts` importam `ws`
  diretamente; sem isso, o cross-import não resolvia.
- **`~/.syncteam/`** é o local de config/estado PRÓPRIO do CLI (distinto de
  `.vscode/settings.json`/`ExtensionContext.globalStorageUri` da extensão,
  porque o CLI roda sem VS Code aberto) — `config.json` (porta),
  `syncteam.pid` (`{pid,port,projectDir}` do daemon vivo), `daemon.log`,
  `port-locks/` (MESMO lockfile de posse de porta da extensão, reusado).
  Escolha deliberada de NÃO usar `env-paths` (dependência nova) — só
  `os.homedir() + ".syncteam"`, cross-platform o bastante.
- **`syncteam extension install`**: mesmo padrão de `plugin install`
  (`.vsix` embutido via `with {type:"file"}`, `src/types/vsix.d.ts` espelha
  `rbxm.d.ts`), mas escreve num arquivo TEMPORÁRIO e chama `code
  --install-extension <path> --force` via subprocess (não existe "pasta de
  destino" pro VS Code do jeito que o Studio tem pasta de Plugins). Erro
  `ENOENT` do `code` vira mensagem amigável ("code não encontrado no PATH"),
  nunca stack cru. `scripts/build-extension-asset.ts` roda `npm run build` +
  `npx --yes @vscode/vsce package --no-dependencies` dentro de
  `vscode-extension/` e copia o `.vsix` gerado (nome `<name>-<version>.vsix`)
  para o nome FIXO `syncteam.vsix` dentro de `cli/src/assets/`.
- **Nota Windows sobre `stop`**: `process.kill(pid, "SIGTERM")` disparado por
  OUTRO processo força término IMEDIATO no Windows (já documentado em
  `PortOwnership.ts` de uma tarefa anterior) — o handler gracioso do daemon
  (`service.stop()`, que removeria o lockfile de posse de porta) não chega a
  rodar. Confirmado ao vivo que isso é INÓCUO: a porta é liberada pelo SO de
  qualquer forma, e um `start` seguinte na MESMA porta funciona normalmente
  apesar do lockfile órfão (o bind bem-sucedido sobrescreve o lockfile). Em
  POSIX o SIGTERM deveria disparar o handler gracioso de verdade — não
  testado nesta máquina.
- **Testes de ponta a ponta REAIS** (`test/startStop.test.ts`,
  `test/startPortConflict.test.ts`) — mesma filosofia de nunca mockar
  fs/child_process/net/ws já estabelecida em `vscode-extension/`: sobem um
  daemon de verdade, confirmam PID/porta/lockfile reais, encerram de
  verdade, e testam o diálogo Y/N com um processo Node SEPARADO ocupando a
  porta (nunca o próprio processo de teste — matar o processo de teste por
  engano derrubaria a suíte inteira). **Achado real que motivou um ajuste**:
  `bun run test` roda `vitest`, mas o WORKER que executa cada arquivo de
  teste é um processo NODE, não bun (`process.execPath` dentro de um teste
  aponta pra `node.exe` mesmo a suíte tendo sido lançada via `bun run test`)
  — os testes resolvem `~/.bun/bin/bun.exe` explicitamente em vez de reusar
  `process.execPath`, senão a auto-reinvocação tentaria rodar `node
  <arquivo.ts>` (que quebra na hora com `ERR_UNKNOWN_FILE_EXTENSION` no
  import `.rbxm`/`.vsix` com `with {type:"file"}`, uma sintaxe Bun-only).
- **Verificação real completa nesta máquina**: `bun run lint` limpo, `bun
  run test` 52/52 (rodado 2x, sem flakiness), `bun run build:assets` (rbxm +
  vsix) OK, binário compilado (`bun build --compile --target=bun-windows-x64`)
  testado DE VERDADE: `start`/`stop` reais (processo destacado sobrevivendo
  ao pai, porta confirmada via `netstat`, PID confirmado via
  `Get-Process`), diálogo Y/N de posse de porta nos dois caminhos (aceitar
  mata o ocupante e reusa a porta configurada; recusar preserva o ocupante e
  cai no fallback), `syncteam port <N>` persistindo e lendo de volta,
  `syncteam extension install` confirmado via `code --list-extensions
  --show-versions` (`dev-hakor.syncteam@0.1.0`). Nada publicado (sem `gh
  release`/push) — decisão de escopo desta tarefa.
- **Pendência sinalizada, não resolvida por mim**: `CLAUDE.md` linha ~57
  ainda diz "Único comando hoje: `syncteam plugin install`" — ficou stale
  depois desta tarefa, mas não editei `CLAUDE.md` (fora do meu escopo como
  subagente — sinalizando para o usuário/orquestrador atualizar se quiser).
  macOS/Linux para `start`/`stop`: mecanismo deveria funcionar (mesma
  composição, mesmo Bun), mas só testado de verdade no Windows.

## `syncteam-cli` — novo componente `cli/`, TypeScript/Bun standalone, distribuído via Rokit (2026-08-03, docs/DECISIONS.md "10ª rodada")

Primeiro código de produto do CLI (spike anterior, "9ª rodada", só validou
que `bun build --compile` é aceito pelo Rokit contra um repo descartável).
`cli/` é projeto TypeScript independente (não importa nada de
`vscode-extension/`), roda em **Bun**, não Node — primeira vez que este
projeto usa Bun como runtime de produto, não só ferramenta auxiliar.

- **Estrutura**: `src/index.ts` (único arquivo que toca API do Bun —
  `Bun.file`, import `with { type: "file" }`), `src/plugin/studioPluginsDir.ts`
  (puro, resolve pasta de Plugins do Studio por SO, recebe
  `{platform, homedir, env}` injetado — nunca lê `process.*` direto, mesmo
  padrão de módulo puro já usado em `vscode-extension/src/mapping/*.ts`),
  `src/commands/pluginInstall.ts` (orquestração com toda IO injetada via
  interface `PluginInstallIO`, testável sem compilar nada).
  `scripts/build-plugin-asset.ts` roda `wally install` + `rojo build` contra
  `../plugin/` e escreve `src/assets/SyncTeam.rbxm` (gerado, gitignored via
  regra global `*.rbxm` — NUNCA commitado, usuário final do CLI não precisa
  de `rojo`/`wally`). `scripts/lib/rokitTools.ts` localiza `rojo`/`wally` em
  `~/.rokit/tool-storage/<qualquer-autor>/<tool>/<versão>/` com comparador
  de versão semver-aware PRÓPRIO (`compareVersions`) — não confiar em `sort
  -V`/`localeCompare` puro para isso, ver pegadinha abaixo.
- **PEGADINHA REAL que me mordeu**: comentário JSDoc (`/** ... */`) com um
  path glob literal tipo `.../tool-storage/*/<toolName>/*` **quebra o
  parser do TypeScript** — a substring `*/` no MEIO do texto fecha o bloco
  de comentário cedo, e o resto do comentário + código seguinte vira
  "expressão" inválida (`error TS1109: Expression expected`, apontando pra
  uma linha bem depois do comentário real, nada óbvio de onde vem). Regra
  prática: **nunca escrever `*/` literal dentro de um bloco `/** */`**,
  mesmo dentro de texto/exemplo — se precisar mostrar um glob com `*` perto
  de `/`, reescrever por extenso (`<qualquer-versão>` em vez de `*`) ou usar
  `//` linha a linha. Fácil de re-cometer em qualquer doc/comentário futuro
  que cite paths com wildcard.
- **`sort -V` (usado por `Tools/build-and-deploy-plugin.sh` para achar a
  versão mais alta do rojo instalada) NÃO entende semver de verdade** —
  testado ao vivo: `sort -V` em `["7.6.1", "7.7.0-rc.1", "7.7.0"]` (só os
  números) põe `7.7.0` ANTES de `7.7.0-rc.1` (errado — release deveria vir
  DEPOIS/maior que prerelease da mesma versão). O script shell só "funciona
  por acidente" porque compara o PATH INTEIRO incluindo o separador depois
  da versão (`7.7.0-rc.1/rojo.exe` vs `7.7.0/rojo.exe` — o `-` de `-rc.1`
  tem código ASCII menor que `/`, então por pura sorte a comparação
  lexicográfica do path completo dá o resultado certo). Não reproduzir esse
  padrão em JS/TS achando que é "sort -V correto" — implementei
  `compareVersions` de verdade (parseia `major.minor.patch[-prerelease]`,
  prerelease sempre conta como menor que release da mesma versão), testado
  explicitamente contra esse caso real (`test/rokitTools.test.ts`).
- **Import attribute `with { type: "file" }` do Bun**: `src/types/rbxm.d.ts`
  declara `declare module "*.rbxm" { const path: string; export default
  path; }` — isso faz `tsc --noEmit` (`bun run lint`) passar mesmo num CLONE
  LIMPO sem o `.rbxm` gerado ainda (declaração de módulo por padrão de nome,
  não exige arquivo físico no disco). Só `bun run`/`bun build --compile`
  precisam do arquivo físico de verdade (é quem embute os bytes). Ordem de
  build obrigatória: `build:plugin-asset` sempre ANTES de `compile:*` — os
  scripts npm já encadeiam isso (`&&`), documentado em `cli/README.md`.
- **Zip cross-platform sem dependência de ferramenta de SO**: `tar -a -c -f
  x.zip ...` no GNU tar (git-bash Windows) **NÃO gera um zip de verdade** —
  só renomeia um `.tar` pra `.zip` sem trocar o formato (`file x.zip` acusa
  "POSIX tar archive", não "Zip archive"), armadilha real encontrada nesta
  tarefa. `zip`/`Compress-Archive` também não são uniformes nas 3 plataformas
  alvo. Usei `adm-zip` (devDependency só do script de build, não vai pro
  binário final) — justificativa registrada em `cli/README.md`.
- **Localização de binário Rokit**: `~/.rokit/tool-storage/` usa autor
  DIFERENTE por ferramenta (`rojo-rbx/rojo` mas `upliftgames/wally` —
  confirmado nesta máquina) — `findRokitTool` varre TODOS os autores sob
  `tool-storage/`, não assume um autor fixo, mesmo espírito do wildcard
  `*/wally/*` já usado em `Tools/build-and-deploy-plugin.sh`.
- **Verificação real (Windows, nesta máquina)**: `bun run build:plugin-asset`
  gerou `SyncTeam.rbxm` (194540 bytes, rojo 7.7.0 real). `bun run
  compile:win-x64` gerou PE32+ válido (~117MB). `scripts/verify-embed-hash.ts`
  — compila, roda `syncteam.exe plugin install` de verdade com `LOCALAPPDATA`
  redirecionado pra um tmpdir (não toca a instalação real do usuário) —
  **hash SHA-256 do `.rbxm` extraído do binário bateu 100% com o gerado
  direto por `rojo build`** (ressalva que a pesquisa do Bun tinha deixado em
  aberto, agora fechada). `compile:macos-x64`/`compile:macos-arm64` também
  rodados de verdade nesta máquina — geram Mach-O válidos (`file` confirma
  x86_64/arm64) — mas **nunca EXECUTADOS** (impossível numa máquina Windows);
  `plugin install` no macOS real (incluindo se `~/Documents/Roblox/Plugins`
  está certo) continua `[Hipótese]`. 17/17 testes vitest, `tsc --noEmit`
  limpo. Nada publicado (sem `gh release create`, `rokit.toml` da raiz
  intocado) — decisão explícita da tarefa.
- **Pendência sinalizada, não resolvida por mim**: pasta de Plugins do
  Studio no macOS (`~/Documents/Roblox/Plugins`) não tem confirmação em
  `.claude/research/` — implementado por analogia ao Windows, documentado
  como `[Hipótese]` no código/README/DECISIONS.md. Precisa do `researcher`
  antes de virar `[Verificado]`.

## "Handoff quase-instantâneo de lease" — pulse de buffer via onDidChangeTextDocument (2026-08-02, docs/DECISIONS.md "8ª rodada")

Objetivo: fazer o `Pulse` do lease do lado Luau (`TeamCreateLease.ensureIntent`)
atualizar continuamente durante digitação ativa, não só no save — hoje a
detecção local de edição é 100% via disco (`FileSystemWatcher`), então o dono
de um lease só parece "morto" ~8-10s depois de parar de digitar.

- **Fonte de verdade de posse REUSADA, nada duplicado**: `LeaseTracker`
  (`vscode-extension/src/sync/LeaseTracker.ts`) e `resolveUuidForDiskPath`
  (`SyncTeamService` → `SyncBridge`) já existiam — só adicionei
  `LeaseTracker.isExplicitlyOwnedByMe(uuid)`, método NOVO e deliberadamente
  DIFERENTE de `isOwnedByMe` já existente: `isOwnedByMe` é otimista (`true`
  também quando a lease ainda não foi arbitrada OU está livre — correto para
  "posso deixar o usuário editar sem aviso visual"), mas este gatilho novo
  exige posse EXPLÍCITA (`lease !== undefined && lease.ownerClientId ===
  myClientId`, com guard extra `myClientId !== null`) — a tarefa pedia
  explicitamente que "arquivo sem lease ainda resolvida" NÃO disparasse nada
  daqui (o fluxo de pedir lease pela 1ª vez continua só pelo save). Usar
  `isOwnedByMe` aqui teria disparado pulses ANTES da posse ser confirmada.
- **`SyncBridge` ganhou `handleBufferContentChange(relDiskPath, content,
  transport)`**: mesma mensagem `writeSource {uuid, source}` que
  `handleLocalFileChange` manda no save, só que `content` vem do BUFFER
  (`document.getText()`, passado pelo chamador) — este módulo nunca lê disco
  nem importa `vscode`. Extraí o núcleo comum (cache/exclusão Wally/envio/
  tratamento de ack) para um novo helper privado `pushKnownUuidUpdate(...)`,
  reusado pelos DOIS caminhos (`handleLocalFileChange`'s update-branch E
  `handleBufferContentChange`) — evita duplicar a lógica de envio/ack/erro
  que já existia. Dedupe: mesmo `contentCache` de sempre (`content ===
  cache` → sai cedo) — é isso que faz um save logo depois de um pulse de
  buffer com o MESMO conteúdo não gerar um segundo `writeSource` (testado
  explicitamente).
- **`SyncBridge.handleBufferContentChange` só age em uuid JÁ conhecido**
  (`uuidByDiskPath.get(key)`) — nunca tem um "modo criar" como
  `handleLocalFileChange` tem. Isso é redundante com o gate de
  `resolveUuidForDiskPath` que `extension.ts` já faz ANTES de chamar, mas
  mantive como checagem defensiva (early-return + log info) — segurança
  dupla barata, sem custo real.
- **`SyncTeamService.notifyBufferChange(relDiskPath, content)`**: passthrough
  fino que enfileira `bridge.handleBufferContentChange` na MESMA fila FIFO
  (`enqueueMutation`) que `notifyLocalFileChange`/`routeSpontaneous` usam —
  mesmo motivo de sempre (mexe nos mesmos mapas mutáveis do SyncBridge, uma
  pulsação de buffer concorrente com uma rajada do Studio teria a mesma
  corrida do bug de 2026-07-27). Testado com o MESMO padrão de prova de FIFO
  já usado pro `notifyLocalFileChange` (dispara `scriptMoved` + a nova
  chamada SEM esperar entre eles, confirma pela ORDEM das linhas de log que
  a segunda só começou depois da primeira terminar).
- **`extension.ts::scheduleBufferPulse` é THROTTLE, não debounce — decisão
  deliberada, divergindo do padrão de `scheduleNotify`/
  `schedulePresencePublish` já existentes no mesmo arquivo**: um debounce
  (reseta o timer a cada evento, só dispara após silêncio) NUNCA dispararia
  enquanto o usuário digitasse continuamente sem pausa — exatamente o oposto
  do objetivo ("Pulse atualiza CONTINUAMENTE durante digitação ativa").
  Implementação: reusa o MESMO mecanismo (`Map<string relPath, Timer>` +
  `setTimeout`) do `scheduleNotify`, só SEM o `clearTimeout`/reagendamento a
  cada evento — se já existe um timer pendente pro path, novos eventos
  dentro da janela (`BUFFER_PULSE_THROTTLE_MS = WATCH_DEBOUNCE_MS = 150ms`)
  são ignorados; o disparo pendente lê `document.getText()` no MOMENTO em
  que dispara (não no agendamento), sempre pegando o conteúdo mais recente —
  `vscode.TextDocument` é o mesmo objeto vivo, `getText()` nunca é um
  snapshot velho. 150ms foi calibrado pra ficar confortavelmente abaixo do
  novo `STALE_AFTER_SECONDS` configurável do lado Luau (~2-3s, ver
  `docs/DECISIONS.md`).
- **Gate completo em `scheduleBufferPulse` (extension.ts), NÃO no
  SyncBridge**: (1) `service`/`projectDir` ativos + `document.uri.scheme ===
  "file"`; (2) `service.resolveUuidForDiskPath(relPath) !== null` (arquivo
  já sincronizado — fora disso, nada dispara, save cuida da criação); (3)
  `service.getLeaseTracker()?.isExplicitlyOwnedByMe(uuid)` (posse explícita
  minha). Só depois disso agenda o throttle. Fez sentido ficar em
  `extension.ts` porque é o único lugar que já tem acesso a `LeaseTracker`
  via `service.getLeaseTracker()` (mesmo getter que `LeaseBorderDecoration`
  já usa) — `SyncBridge`/`SyncTeamService` não sabem nada de lease (quem sabe
  é só `LeaseTracker`, populado por `leaseChanged`).
- **Listener registrado UMA VEZ em `activate()`** (`vscode.workspace.
  onDidChangeTextDocument`), não recriado a cada `startService()` — mesmo
  padrão dos listeners de presença (`onDidChangeActiveTextEditor`/
  `onDidChangeTextEditorSelection`) logo acima dele. `bufferPulseTimers`
  (Map module-level) é limpo só no `dispose()` do próprio listener
  (desativação da extensão), não em `stopService()` — um timer pendente que
  dispara depois de um restart só encontra `service` apontando pra uma
  instância nova; `notifyBufferChange`/`handleBufferContentChange`
  degradam pra no-op silencioso se o uuid não for conhecido nessa instância
  nova (nunca crash). Documentado inline como aceito.
- **Watcher de disco (`FileSystemWatcher`, dentro de `startService`)
  continua 100% intocado** — as duas vias coexistem por design (a tarefa foi
  explícita sobre isso): disco continua sendo o fallback para mudanças fora
  do buffer do VS Code (checkout, outro processo).
- **Testes**: `LeaseTracker.isExplicitlyOwnedByMe` (5, incluindo o caso
  `myClientId === null`); `SyncBridge.handleBufferContentChange` (5: envia
  quando muda, dedupe quando igual, uuid desconhecido não manda nada, pulse
  seguido de save com mesmo conteúdo não duplica write, exclusão de pasta
  Wally reusa a mesma checagem); `SyncTeamService.notifyBufferChange` (1,
  prova de FIFO — mesmo padrão do teste de `notifyLocalFileChange` já
  existente). 274 testes no total. `npm run lint` (tsc --noEmit) limpo,
  `npm run build` (esbuild) gera os dois bundles sem erro.
- **Não testado em Studio real**: depende do lado Luau (`luau-dev`, em
  paralelo nesta mesma rodada) ter desacoplado `leaderTick` de
  `PULSE_INTERVAL_SECONDS` — sem isso, mesmo com pulses de buffer chegando
  mais rápido do lado da extensão, a checagem de staleness no plugin ainda
  rodaria a cada 2s (constante de heartbeat/eleição, intocada por decisão
  registrada). Nenhum `[Hipótese]` novo introduzido aqui além do já registrado
  na entrada da 8ª rodada em `docs/DECISIONS.md`.

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

## "ReSync" — reset forçado sob comando do Studio (2026-08-02)

Contrato completo em `docs/DECISIONS.md` "5ª rodada". Implementei só o lado
VS Code (`case "resyncRequest"` em `SyncTeamService.routeSpontaneous`,
`SyncBridge.resyncFromScratch`, modal de confirmação) — `luau-dev`/`ui-dev`
cuidam do botão/painel no Studio, em paralelo.

- **Regra de arquitetura que a tarefa pedia violar, e por que recusei**: a
  descrição da tarefa sugeria chamar `vscode.window.showWarningMessage`
  DIRETO dentro do `case` novo em `SyncTeamService.ts`. Não fiz isso —
  `SyncTeamService.ts`/`SyncBridge.ts`/`SyncController.ts` são os únicos
  módulos de `sync/` que NUNCA importam `vscode` (confirmado via grep: só
  `extension.ts`, `ui/*.ts` — domínio `ui-dev` — `VscodeDiskIO.ts` e
  `vscodeLogger.ts` importam `vscode` de verdade), e nenhum teste deste
  projeto mocka `vscode`. Importar `vscode` ali quebraria isso e tornaria o
  fluxo inteiro intestável sem subir o Extension Development Host. **Padrão
  reaproveitado em vez disso**: exatamente o mesmo desenho já usado por
  "posse de porta" (`PortReclaimHost.confirmKill(message): Promise<boolean>`,
  2026-08-02 3ª rodada) — um callback (`ConfirmResyncCallback`,
  `setOnConfirmResync`) que `SyncTeamService` chama e cuja implementação REAL
  (`vscode.window.showWarningMessage(msg, {modal:true}, "Confirmar",
  "Cancelar")`) só existe em `extension.ts`. Sempre que uma tarefa pedir
  "mostra um modal aqui" num módulo que hoje não importa `vscode`, este é o
  padrão a seguir — nunca importar `vscode` direto nesses módulos.
- **`enqueueMutation` (fila FIFO de `SyncTeamService`) virou genérico**
  (`<T>(task: () => Promise<T>): Promise<T>`, era `Promise<void>` fixo) —
  precisei disso porque `resyncFromScratch` devolve `deletedCount` (número) e
  o chamador (`handleResyncRequest`) precisa desse valor para montar o
  `resyncResult`. Mudança 100% compatível com todo call site pré-existente
  (`void` é só mais um `T` válido) — nenhum teste pré-existente quebrou.
- **`SyncBridge.resyncFromScratch(transport): Promise<number>`**: conta
  `deletedCount` LOGO APÓS `deleteFile` ter sucesso, ANTES de tentar
  `removeEmptyDirsUpward` — as duas operações têm try/catch SEPARADOS (delete
  falhando não deveria impedir a limpeza de diretório de outro arquivo do
  mesmo lote, e uma falha de `removeEmptyDirsUpward` não deveria "descontar"
  um delete que já teve sucesso de verdade). Snapshot de
  `diskPathByUuid.values()` em `Array.from` ANTES de zerar qualquer Map —
  óbvio em retrospecto, mas fácil de esquecer (os Maps são zerados dentro do
  mesmo método, então iterar por referência direta depois do clear() daria
  loop vazio).
- **Escopo estrito, testado explicitamente**: um arquivo escrito diretamente
  no tmpdir (bypassando o bridge, nunca aparecendo em `diskPathByUuid`)
  sobrevive ao `resyncFromScratch` — o método só apaga o que ELE PRÓPRIO
  rastreia, nunca varre o disco feito `reconcileDiskOnlyFiles` faz para
  `refreshSync`.
- **Teste mais forte do que o pedido mínimo**: além do teste de
  `SyncBridge.resyncFromScratch` com `FakeTransport` direto (prova
  delete+repull com conteúdo NOVO substituindo o antigo — não só "não lança
  erro"), escrevi um teste de `SyncTeamService` ponta-a-ponta com um plugin
  fake via `WebSocket` REAL (`ws://127.0.0.1:<porta>`, mesmo padrão de
  `syncServer.test.ts`/`syncTeamService.test.ts` watchedRoots) que muda o
  conteúdo reportado ENTRE a sincronização inicial e o resync — só assim dá
  pra provar que o `runInitialSync` de dentro do `resyncFromScratch` correu
  de fato (arquivo aparece com o conteúdo NOVO, não o antigo). Para os casos
  sem plugin conectado (sem confirmador / cancelado / confirmador que
  rejeita), bastou `vi.spyOn(server, "sendSpontaneous")` para capturar a
  resposta sem precisar de socket nenhum — `SyncServer.request()` já rejeita
  sozinho com "nenhum plugin conectado" quando não há cliente (não precisa de
  fake plugin pra esses casos, só pro caminho de sucesso onde o CONTEÚDO
  importa).
- **`resyncRequest` participa do dedupe de `multiSync`** (mesma assinatura
  sempre, `"resyncRequest"` sem campo variável) — um clique duplicado
  replicado por 2 Studios (Team Create) dentro da janela de 800ms não deve
  empilhar 2 modais de confirmação para o mesmo pedido lógico.
- **Verificação real**: `npm run lint` (tsc --noEmit) limpo, `npm run test`
  (vitest run) **263/263** (era 256, +7: 3 em `syncBridge.test.ts`, 4 em
  `syncTeamService.test.ts`), `npm run build` (esbuild) gera os dois bundles
  sem erro. **Não testado em Studio real** — depende do lado Studio
  (`luau-dev`/`ui-dev`) terminar em paralelo; nenhum round-trip Team Create
  aqui, só lógica local (mesma conclusão de outras fatias client-side-only).

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

## Materialização inicial duplicava `.lua` existente em `.luau` novo — bug real, corrigido (2026-07-16)

Achado testando com Wally de verdade em Studio: um projeto que já tinha
`wally install` puro rodado ANTES do SyncTeam existir no workspace (pacotes
`.lua`) fazia a sincronização inicial criar um `.luau` NOVO do lado do `.lua`
já existente — mesmo uuid, dois arquivos, `.lua` original abandonado.

- **Causa raiz**: `recomputeAndApplyLayout`, ramo `previous === undefined`
  (primeira materialização de um uuid, `diskPathByUuid.get(uuid)` ainda
  indefinido) — usava direto o `diskPath` de `computeLayout` (sempre `.luau`,
  regra de projeto) sem NUNCA checar se já existia um `.lua` correspondente
  em disco para o MESMO instancePath.
- **Fix**: método novo `SyncBridge.resolveInitialDiskPath(computedDiskPath)`
  — deriva o candidato `.lua` por `computedDiskPath.replace(/\.luau$/i,
  ".lua")` (funciona pros 3 casos: `Nome.lua`, `Nome.server.lua`,
  `Nome.client.lua`, e pro `init.*` também, já que o `.replace` só troca o
  sufixo de extensão, não olha o nome-base) e checa existência via
  `this.diskIO.readFile(luaCandidate) !== null`. Se existir, retorna o
  `.lua` como o diskPath a usar; senão, retorna o `.luau` computado
  (comportamento antigo, sem regressão). Chamado APENAS no ramo
  `previous === undefined` de `recomputeAndApplyLayout` — `moveOnDisk`/
  `handleScriptMoved` (rename de scripts JÁ sincronizados) não foi tocado,
  deliberadamente fora de escopo (pedido explícito da tarefa).
- **Não precisou de método novo em `DiskIO`** — `readFile` retornando
  `null` para arquivo inexistente (contrato já documentado na interface) já
  era suficiente para "existe arquivo X?"; não precisei do `listFiles` que a
  tarefa sugeria como alternativa.
- **Pegadinha ao escrever o teste**: o candidato `.lua` para uma classe
  `Script` é `Nome.server.lua` (troca só o `.luau` final por `.lua`,
  preservando `.server`/`.client`), NÃO `Nome.lua` — errei isso na primeira
  versão do teste e só percebi lendo `EXTENSION_BY_CLASS` em
  `rojoPathMapping.ts` de novo (`Script` → ext `"server.luau"`, filename
  final = `${baseName}.server.luau`). Qualquer teste futuro que monte o
  candidato `.lua` manualmente por classe precisa lembrar disso.
- **Testes**: `test/syncBridge.test.ts`, novo describe "materialização
  inicial reaproveita .lua pré-existente (2026-07-16)" (2 testes: `.lua`
  pré-existente é reaproveitado com o conteúdo novo do Studio, sem `.luau`
  duplicado; sem nada em disco continua indo pro `.luau` normal). 181 testes
  no total (era 179). `npx tsc --noEmit` limpo, `npx vitest run
  --pool=threads` 181/181, `npm run build` gera os dois bundles sem erro.
- **Registrado em `docs/DECISIONS.md`** (2026-07-16, topo do arquivo).
- **Não testado em Studio real ainda** — só a lógica com `NodeDiskIO` real
  em tmpdir (não fake em memória, mesma prática de sempre). Cenário completo
  (rodar a extensão de verdade contra o projeto Wally real do usuário que
  expôs o bug) fica pendente de confirmação com o usuário/roteiro manual.

## Delete local não propagava ao Studio — `deleteScript` (2026-07-20)

Bug real reportado pelo usuário: deletar um module no VS Code não destruía a
Instance no Studio; sintoma colateral, rename local (delete+create sem
correlação) virava DUPLICATA porque só a metade "criar" chegava ao plugin.
Tarefa em paralelo com `luau-dev` implementando o lado do plugin contra o
MESMO contrato de protocolo (definido de antemão pelo orquestrador, não por
mim — não inventei variação).

- **Contrato** (`protocol.ts`, aditivo, SEM bump de `PROTOCOL_VERSION`, mesmo
  precedente de `ping`/`leaseChanged`): extensão→plugin `{kind:"deleteScript",
  requestId, uuid}`; resposta reusa `writeAck` (`{kind:"writeAck", requestId,
  ok, uuid?, error?}`) — funciona sem mudar `SyncServer.request()` porque a
  correlação já é só por `requestId`, nunca por `kind`.
- **`SyncBridge.handleLocalFileChange`**: o ramo `content === null` (arquivo
  sumiu do disco) agora delega para um método novo,
  `handleLocalFileRemoved(relDiskPath, key, transport)`, em vez de só logar e
  sair. Lógica: sem `uuidByDiskPath.get(key)` → nada a fazer (nunca foi
  sincronizado, só limpa `contentCache` como já fazia); com uuid conhecido →
  checa `isInsideExcludedPackageFolder` (mesma exclusão de pacotes Wally que
  o ramo de update já respeita) e, se não excluído, manda `deleteScript`. Ack
  `ok=true`: limpa `scripts`/`sourceCache`/`unregisterDiskPath`/`contentCache`
  (mesma limpeza de `handleScriptRemoved`, SEM chamar `diskIO.deleteFile` —
  o arquivo já sumiu, foi isso que disparou o fluxo). Ack `ok=false`: **NÃO
  limpa nada** (uuid continua rastreado — a instância pode não ter sido
  removida no Studio de fato) e chama `onWriteRejected?.({diskPath, error})`
  — **mesmo payload/shape que os outros 2 call sites de `onWriteRejected` já
  usam** (`{diskPath: relDiskPath, error: errorMsg}`), decisão deliberada de
  não inventar um campo novo tipo "operation: delete" porque o tipo
  `OnWriteRejectedCallback` já é fixo e a UI (`ui-dev`, `extension.ts`) trata
  isso genericamente como "uma escrita foi rejeitada, mostra a mensagem" —
  não distingue create/update/delete hoje.
- **Rename ainda não é "de verdade"** (fora de escopo, pedido explícito da
  tarefa): delete+create local continuam sem correlação — o uuid antigo
  morre (`deleteScript`) e um uuid novo nasce (`writeSource` modo criar) no
  create subsequente. Isso já resolve o sintoma prático (duplicata some),
  mas não preserva histórico/identidade do uuid através do rename.
- **Achado importante que não estava no escopo original da tarefa**: o
  `vscode.FileSystemWatcher` em `extension.ts` (linha ~379-406) só assinava
  `onDidChange`/`onDidCreate` — **`onDidDelete` nunca foi registrado**. Sem
  esse fio, `handleLocalFileChange` NUNCA seria chamado para uma deleção ao
  vivo (o `readFile` retornando `null` só seria alcançável via
  `refreshSync`/`reconcileDiskOnlyFiles`, que tem sua própria lógica
  separada e deliberadamente não-destrutiva para "arquivo sumiu do disco" —
  não chama `handleLocalFileChange` nesse caso). Sem corrigir isso, o fix em
  `SyncBridge` ficaria morto para o fluxo principal (extensão aberta, editor
  ativo). Adicionei `watcher.onDidDelete(scheduleNotify)` ao lado dos outros
  dois (mesmo debounce, mesma função `scheduleNotify` — `relDiskPathFromUri`
  é só cálculo de path, funciona igual para uma URI que já não existe mais).
  **Sinalizado ao orquestrador**: essa lacuna existia desde que o watcher foi
  escrito e não tinha relação com a causa raiz apontada na tarefa original —
  vale conferir se algum outro handler de watcher (`onWill*`?) também tem
  gaps parecidos no futuro.
- **Deleção em lote (pasta com vários módulos)**: não precisou de nenhuma
  mudança de arquitetura — `vscode.FileSystemWatcher` já entrega um evento
  `onDidDelete` por ARQUIVO (não um evento agregado por pasta), e o debounce
  em `extension.ts` já é `Map` chaveado por `relPath` individual, então N
  arquivos deletados juntos viram N chamadas independentes de
  `handleLocalFileChange`/`handleLocalFileRemoved`, cada uma resolvendo seu
  próprio uuid. Confirmado com teste dedicado chamando
  `handleLocalFileChange` duas vezes em sequência para dois arquivos
  diferentes da mesma pasta.
- **`FakeTransport` (`test/syncBridge.test.ts`) ganhou `case "deleteScript"`,
  best-effort** (sempre `ok:true`, remove de `this.scripts`/`this.sources` só
  se presente) — **pegadinha que me mordeu**: minha primeira versão exigia
  que o uuid já estivesse em `transport.scripts` para confirmar `ok:true`,
  mas testes que criam o script via `bridge.handleScriptAdded(...)` NUNCA
  populam `transport.scripts` (esse array só é alimentado pelo modo "criar"
  de `writeSource` no fake) — só o estado interno do `SyncBridge` é
  atualizado. Isso fazia o ack vir `ok:false` por acidente e os testes de
  sucesso falharem com "estado não foi limpo". Corrigido para não exigir
  pré-existência, igual ao padrão solto que os outros `case` deste fake já
  seguem (`readSource` também não valida contra `transport.scripts`).
- **Testes**: novo `describe("deleção local (disco → Studio) — 2026-07-20")`
  em `test/syncBridge.test.ts` (5 testes: sucesso limpa estado + manda
  `deleteScript`; ack de falha NÃO limpa estado + aciona `onWriteRejected`;
  path sem uuid conhecido não manda nada; dentro de pasta Wally é ignorado
  sem mandar `deleteScript`; deleção em lote processa cada diskPath
  independentemente). Helper novo `deleteTmp(relPath)` (espelha `writeTmp`,
  via `fs.rmSync`). **186 testes no total** (era 181, +5). `npm run lint`
  (tsc) limpo, `npm test` 186/186, `npm run build` gera os dois bundles.
- **Não testado em Studio real** — depende do `luau-dev` ter implementado o
  handler `deleteScript` do lado do plugin contra este mesmo contrato
  (trabalho paralelo, mesma tarefa). Round-trip real (deletar no VS Code,
  confirmar Instance destruída no Studio do colega via Team Create) fica
  pendente de roteiro manual/2 Studios reais.

## Bug real corrigido: `stop()`/`deactivate()` podia travar até 30s e deixar a porta em uso (2026-07-20)

Bug relatado: fechar o VS Code com o servidor WS ativo não matava o processo
do extension host — a porta continuava em uso (`EADDRINUSE` na próxima
tentativa de start, ou a porta só sumia da listagem depois de matar o
processo manualmente).

**Causa raiz CONFIRMADA lendo o código-fonte real do `ws`, vendorizado em
`vscode-extension/node_modules/ws`** (não pesquisa externa — a lib já está no
repo, então isso não violou a regra de "não pesquisar API na web"; li
`lib/websocket.js` e `lib/websocket-server.js` diretamente):

- `WebSocket.close(code, data)` (`lib/websocket.js:302-340`) inicia um
  handshake gracioso e, na última linha, chama `setCloseTimer(this)`
  (`lib/websocket.js:1309-1314`), que arma `setTimeout(() =>
  this._socket.destroy(), this._closeTimeout)` — o socket real só é destruído
  à força depois de `closeTimeout` (default `CLOSE_TIMEOUT = 30000`,
  `lib/constants.js:10`) SE o peer nunca responder ao close. Ou seja:
  `client.close()` contra um peer morto/sem resposta pode levar até **30
  segundos** até o socket ser de fato destruído.
- `WebSocketServer.close(cb)` (`lib/websocket-server.js:169-215`), no modo em
  que o server foi criado com `{port}` (nosso caso — `SyncServer.start()`),
  cai no branch `else` (linha 201-214): delega para `server.close(() =>
  emitClose(this))`, onde `server` é o `http.Server` interno do Node. O
  `http.Server.close()`/`net.Server.close()` do Node **não fecha conexões
  existentes** — só para de aceitar novas e espera TODAS as conexões TCP
  ativas terminarem antes de emitir `'close'`. Então o callback de
  `wss.close()` fica bloqueado até o socket "pendurado" acima ser destruído
  — e `SyncServer.stop()` fazia `await new Promise(resolve => wss.close(()
  => resolve()))`, then `deactivate()` = `return stopService()` = `await
  service?.stop()`. Cadeia inteira presa por até 30s por causa de UM socket
  morto — e se o VS Code não tiver (ou não aplicar, no cenário de
  fechamento real de janela/app — ainda não 100% confirmado, ver pesquisa
  abaixo) um kill forçado do processo após esse tempo, o Node fica de pé
  com a porta bound indefinidamente.
- **Fix em `SyncServer.stop()`** (`vscode-extension/src/sync/SyncServer.ts`):
  (a) troca de `client.close()` por `socket.terminate()` — destrói o socket
  NA HORA, sem esperar handshake, elimina o risco dos 30s. Iterar
  `wss.clients` (rastreamento INTERNO do `ws`, populado em
  `completeUpgrade()` para TODO socket que fez upgrade HTTP→WS, MESMO que
  nunca tenha mandado `hello`) em vez do nosso `this.clients` privado (só
  os que passaram pelo hello) — fecha também a lacuna de um socket
  conectado mas nunca "aceito" pelo protocolo, que `this.clients` nunca
  saberia. (b) timeout de segurança configurável (`stopSafetyTimeoutMs`,
  default `DEFAULT_STOP_SAFETY_TIMEOUT_MS = 2000`) envolvendo `wss.close()`
  via `Promise` com um `setTimeout` correndo em paralelo — se `wss.close()`
  não chamar o callback dentro do prazo (qualquer razão residual não
  prevista), resolve mesmo assim e loga erro; garante que `stop()` NUNCA
  fica pendurado, mesmo que o `terminate()` não seja suficiente por algum
  motivo futuro não mapeado.
- **Por que `terminate()` é seguro aqui (sem trade-off real)**: o plugin
  (`WebStreamClient`) não distingue um `close()` gracioso de um
  `terminate()` abrupto de qualquer forma — `Closed()` no Luau não expõe
  código nem motivo (doc oficial, já confirmado em
  `.claude/research/2026-07-15-webstreamclient-close-code.md`). Não há
  UX/protocolo perdido ao trocar para terminate() sempre em `stop()`.
- **Ordem em `stop()` importa para preservar um invariante já documentado**:
  `this.clients.clear()` continua acontecendo ANTES do `terminate()` (mesmo
  que a ordem relativa não afete o resultado, já que o handler de `close`
  do socket dispara assíncrono depois) — o guard `if
  (!this.clients.has(socket)) return` no handler de `close` (`handleConnection`)
  já garantia, mesmo antes deste fix, que `onClientDisconnected` NÃO dispara
  numa parada deliberada (`stop`/`restart`/`setPort`), só em queda-surpresa.
  Esse comportamento não mudou — só o MECANISMO de fechamento (terminate vs.
  close) e a fonte dos sockets a fechar (`wss.clients` vs. `this.clients`).
- **Testes novos** (`test/syncServer.test.ts`, describe "SyncServer — stop()
  robustez", 2 testes, 188 no total — era 186): (1) um "plugin morto" conecta,
  manda hello, e NUNCA responde/fecha nada — chama `server.stop()` direto
  (sem esperar o heartbeat detectar a queda) e confirma `elapsed <
  1000ms` (bem abaixo do `CLOSE_TIMEOUT` de 30000ms do `ws`) E que a porta
  foi liberada de verdade (outro `net.createServer()` bind na mesma porta
  imediatamente depois, sem `EADDRINUSE`). (2) mesmo cenário com 2 sockets
  mortos em `multiSync=true`. `npm run lint` (tsc) limpo, `npm test`
  188/188 (rodei 3x para checar flakiness da asserção de tempo — estável,
  sempre ~749ms de suite completa do arquivo), `npm run build` gera os dois
  bundles.
- **O que fica `[Hipótese]`/não confirmado**: se o VS Code de fato aplica um
  timeout automático que mataria o processo do extension host mesmo sem
  este fix (o que explicaria por que o usuário via a porta ficar em uso por
  tempo INDEFINIDO em vez de só ~30s) — delegado ao `researcher`
  (`.claude/research/2026-07-20-vscode-deactivate-timeout-extension-host-kill.md`,
  tarefa disparada em paralelo a esta). Isso não muda a correção em si (o
  fix garante que `stop()` nunca depende de nenhum timeout do VS Code para
  resolver rápido), só é contexto complementar do diagnóstico.
- **Não testado em VS Code real** (fechar a janela de fato com o plugin
  Studio conectado e matar o Studio no meio) — só testes automatizados com
  socket `ws` real fingindo o plugin morto. Fica `[Hipótese]` quanto ao
  comportamento exato em uso real até o usuário confirmar (fechar VS Code
  com Studio aberto e conectado, matar o Studio à força, fechar o VS Code de
  novo, verificar que a porta é liberada rapidamente/`netstat` não mostra
  mais LISTENING nela).

## Fila FIFO em `SyncTeamService` corrige corrida de dados numa rajada de mensagens espontâneas (2026-07-27)

Bug real do usuário (uso real, não spike): reparent em massa no Explorer do
Studio (arrastar vários irmãos para dentro de um Script existente) gera ~30
`scriptMoved` em menos de 1.5s. Causa raiz: `SyncTeamService.routeSpontaneous`
despachava `sourceChanged`/`scriptAdded`/`scriptMoved`/`scriptRemoved`
fire-and-forget (`this.bridge.handleXxx(message).catch(...)`, sem `await`) a
partir do handler SÍNCRONO de `message` do `SyncServer` — que processa cada
frame do WebSocket assim que chega, sem esperar o handler assíncrono anterior
terminar. Uma rajada disparava N chamadas CONCORRENTES a
`SyncBridge.handleScriptMoved`/etc., todas mutando os MESMOS mapas
(`scripts`/`diskPathByUuid`/`uuidByDiskPath`/`contentCache`) com I/O de disco
intercalado — resultado real relatado: `init.server.luau` de promoção nunca
criado + pasta antiga intacta + pasta nova aninhada com CÓPIA (duplicação).
Detalhe completo da análise de causa raiz em `docs/DECISIONS.md` 2026-07-27.

- **Onde a fila vive: `SyncTeamService`, não `SyncBridge`.** Decisão
  deliberada — `SyncBridge` tem métodos que se chamam entre si internamente
  (`handleScriptMoved` chama `recomputeAndApplyLayout`, `refreshSync` chama
  `handleLocalFileChange`/`applyStudioContent` internamente). Se a fila
  vivesse dentro de `SyncBridge` envolvendo esses MESMOS métodos públicos, uma
  chamada interna de um método já enfileirado para outro método também
  enfileirado causaria AUTO-DEADLOCK (a tarefa externa nunca libera o slot da
  fila porque está esperando uma chamada interna que só roda depois que o
  slot for liberado). Como `SyncTeamService` é o único orquestrador que chama
  TODOS os pontos de entrada mutantes do `SyncBridge`
  (`runInitialSync`/`handleSourceChanged`/`handleScriptAdded`/
  `handleScriptMoved`/`handleScriptRemoved`/`handleLocalFileChange`/
  `refreshSync`) e o `SyncBridge` NUNCA chama de volta pro `SyncTeamService`,
  colocar a fila lá captura todos os entry points sem nenhum risco de
  recursão/deadlock — as chamadas internas do `SyncBridge` continuam diretas
  (não passam pela fila de novo), só os pontos de entrada EXTERNOS
  (`routeSpontaneous`, `notifyLocalFileChange`, `onClientConnected`,
  `refreshSync()` público) passam por `enqueueMutation`.
- **Padrão "mutex por fila" via encadeamento de Promise**
  (`SyncTeamService.queueTail`/`enqueueMutation`):
  ```ts
  private queueTail: Promise<void> = Promise.resolve();
  private enqueueMutation(task: () => Promise<void>): Promise<void> {
    const result = this.queueTail.then(task);
    this.queueTail = result.then(() => undefined, () => undefined);
    return result;
  }
  ```
  `queueTail` em si NUNCA rejeita (o `.then(noop, noop)` engole
  resultado/erro só para decidir "posso liberar o próximo") — isso é o que
  garante que um handler que falha não trava a fila inteira. Quem chama
  `enqueueMutation` ainda recebe a Promise ORIGINAL (`result`, não o
  `queueTail` atualizado) — preserva o `.catch(...)` de log que cada call
  site já fazia antes, sem mudar a assinatura pública de nada
  (`routeSpontaneous`/`notifyLocalFileChange` continuam `void`,
  `refreshSync()` continua `Promise<void>`).
- **Escopo do que entra na fila** — TUDO que muta `SyncBridge`/toca disco:
  `sourceChanged`/`scriptAdded`/`scriptMoved`/`scriptRemoved` (em
  `routeSpontaneous`), `notifyLocalFileChange` (watcher local — MESMOS mapas
  compartilhados, então uma edição local concorrente com uma rajada do Studio
  tem a mesma corrida — isso NÃO estava no pedido original da tarefa mas foi
  avaliado e incluído porque o mecanismo já existia e o custo de incluir era
  zero), `runInitialSync` (chamado em `onClientConnected`, também era
  fire-and-forget antes) e `refreshSync()` público (comando manual). **Fora
  da fila, deliberadamente**: `leaseChanged`/`presenceChanged`/`presenceLeft`/
  `log` — nunca tocam `this.bridge`/disco (só `LeaseTracker`/callbacks de
  UI/logger), enfileirá-los só adicionaria latência artificial a mensagens de
  alta frequência (presença/cursor por movimento do cursor) sem nenhum ganho.
- **Por que os testes provam a serialização SEM precisar de timers reais
  nem mock de scheduler**: JS é single-thread — chamar `routeSpontaneous(msgA)`
  seguido de `routeSpontaneous(msgB)` SINCRONAMENTE (sem `await` entre eles,
  exatamente como o `SyncServer` despacha frames reais um atrás do outro) faz
  cada chamada rodar sua parte SÍNCRONA até o primeiro `await` interno antes
  de ceder controle. Sem a fila, ambos chegam a interlear no I/O de disco
  (é isso que reproduz a corrida de verdade). Com a fila,
  `this.queueTail.then(taskB)` só agenda `taskB` depois que a Promise de
  `taskA` (incluindo TODOS os awaits internos) resolver — `taskB` nem começa
  sua parte síncrona até `taskA` terminar por completo. Isso permitiu escrever
  um teste 100% determinístico (sem `setTimeout`/`vi.useFakeTimers`) que
  dispara 3 `scriptMoved` synchronously e confirma o resultado final em disco.
- **`test/syncTeamService.test.ts`, novo describe "fila FIFO serializa rajada
  de mensagens mutantes"**: 3 testes novos.
  1. Mecanismo puro (cast para `enqueueMutation` privado, sem `SyncBridge`
     nem disco): 3 tarefas, a 1ª deliberadamente lenta (`setTimeout` 20ms) e
     a 2ª rejeitando de propósito — confirma ordem FIFO estrita via array
     `order` (`["1-start","1-end","2-start","3-start","3-end"]`) e que a
     rejeição da 2ª não impede a 3ª de rodar.
  2. **Regressão do bug real**: helper novo `makeServiceWithMounts(logger,
     mountPoints)` (variante de `makeService` que expõe o `tmpDir` real do
     `NodeDiskIO` — necessário para inspecionar o layout materializado em
     disco, mesma prática de `syncBridge.test.ts`). Cenário: um `Script`
     "Server" (leaf) + 3 scripts irmãos soltos; dispara 3 `scriptMoved`
     reparentando os 3 irmãos para dentro de "Server" SEM aguardar entre eles;
     confirma que "Server" foi promovido para `Server/init.server.luau`
     (conteúdo preservado), o `Server.server.luau` achatado antigo NÃO
     sobrou, os 3 filhos materializaram dentro da pasta nova com conteúdo
     íntegro e os paths antigos (soltos) sumiram — sem nenhuma pasta/arquivo
     órfão duplicado.
  3. `notifyLocalFileChange` provadamente na MESMA fila que `routeSpontaneous`:
     dispara um `scriptMoved` e, sem aguardar, `notifyLocalFileChange` para um
     path não relacionado — prova por ORDEM DE LOG (`CapturingLogger.lines`
     é um array append-only em ordem de execução real) que a linha de log do
     `notifyLocalFileChange` só aparece DEPOIS de todas as linhas do
     `scriptMoved`, provando que os dois entram na mesma fila serial (não
     filas independentes que rodariam concorrentemente).
  - **Pegadinha ao popular o estado inicial sem transport funcional**: os
    testes de `syncTeamService.test.ts` nunca chamam `server.start()` (porta
    nunca é bindada), então `transport.request(...)` SEMPRE rejeita
    ("nenhum plugin conectado") — `handleScriptAdded` chamaria `readSource`
    e falharia se `sourceCache` não tivesse o uuid ainda. Contornado
    mandando `sourceChanged` ANTES de `scriptAdded` para cada uuid de setup:
    `handleSourceChanged`/`applyStudioContent` populam `sourceCache.set(uuid,
    content)` incondicionalmente (mesmo com `diskPath` ainda desconhecido, só
    loga "layout ainda não resolvido" sem erro) e NUNCA chamam `transport` —
    depois `scriptAdded` vê `this.sourceCache.has(uuid) === true` e retorna
    cedo, sem precisar de `readSource`. `handleScriptMoved` também nunca toca
    `transport` (só estado local + disco), então a rajada em si (a parte que
    importa pro teste) não depende de transport funcional de jeito nenhum.
- **Verificação**: `npx tsc --noEmit` limpo, `npx vitest run --pool=threads`
  191/191 (era 188, +3), `npm run build` gera os dois bundles sem erro.
- **`[Verificado]` (automatizado) / `[Hipótese]` (Studio real)**: o mecanismo
  da fila em si está confirmado por teste determinístico com mensagens
  concorrentes simuladas. O round-trip genuíno (reproduzir a rajada real de
  ~30 `scriptMoved` no Studio de verdade, arrastando filhos de uma Folder
  para dentro de um Script) continua pendente de roteiro manual/2 Studios
  reais — não prometi mais que isso nos docs.

## `watchedRoots` — extensão manda os serviços de topo do projeto ao plugin (2026-07-29)

Bug real: usuário adicionou mount point novo (`ReplicatedFirst/First`) e nada
sincronizou, porque o plugin Studio tinha lista FIXA hardcoded de "watched
roots" (`plugin/src/Config.luau::Config.getWatchedRoots()`) sem
`ReplicatedFirst`. Fix estrutural: a extensão (única que lê
`default.project.json`) manda a lista de serviços de topo do projeto ATUAL ao
plugin, via mensagem nova. **Só o lado da extensão foi feito nesta tarefa** —
lado do plugin é tarefa seguinte, separada, do `luau-dev`. Contrato exaustivo
em `docs/DECISIONS.md` 2026-07-29 (kind, campo, tipos, ORDEM no handshake) —
é a interface entre as duas tarefas, escrito para o `luau-dev` não precisar
re-ler `SyncTeamService.ts` inteiro.

- **`computeWatchedRoots(mountPoints: MountPoint[]): string[]`** — função pura
  nova em `projectMapping.ts` (perto de `computeFullLayout`/
  `resolveDataModelPathForDiskChange`, mesmo arquivo — é onde toda lógica que
  só sabe de `MountPoint[]` já mora). Pega o **primeiro segmento** de
  `mount.dataModelPath.split("/")[0]` de cada mount, deduplicado via `Set`,
  ordem de primeira aparição (não alfabética — irrelevante pro plugin, que
  trata como conjunto, mas deixa o teste determinístico). Nada de I/O, nada de
  depender de `computeFullLayout`/`computeLayout` — só olha `dataModelPath`.
- **Protocolo**: `WatchedRootsMessage {kind: "watchedRoots", roots: string[]}`
  em `protocol.ts` — aditiva, **não** muda `PROTOCOL_VERSION` (mesmo
  precedente de `ping`/`leaseChanged`/`presenceUpdate`/`connectionRejected`).
  Espontânea (sem `requestId`/ack), via `SyncServer.sendSpontaneous` (mesmo
  mecanismo de `sendPresenceUpdate`).
- **Onde exatamente no ciclo de conexão**: `SyncTeamService`'s
  `onClientConnected` handler (registrado no construtor via
  `server.setHandlers({...})`) — chamado de dentro de `SyncServer.handleHello`
  DEPOIS de `protocolVersion` validado. Ordem dentro do handler: `leaseTracker`
  novo → `this.onPresenceReset?.()` → **`watchedRoots` mandada aqui** →
  `this.enqueueMutation(() => this.bridge.runInitialSync(...))`. Ou seja,
  ANTES do primeiro `listScripts`, que é o requisito da tarefa (plugin precisa
  saber quais containers escanear antes de responder `scriptList`).
- **Pegadinha real que me mordeu ao ler o código antes de codar**: o
  construtor de `SyncTeamService` recebia `mountPoints: MountPoint[]` como
  parâmetro comum (sem `private readonly`) e só repassava para
  `new SyncBridge(mountPoints, ...)` — **não ficava acessível depois** em
  nenhum outro método da classe. `SyncBridge` já guarda `mountPoints` como
  campo privado seu, mas não expunha getter. Resolvido com a mudança MÍNIMA:
  adicionar `private readonly` ao parâmetro do construtor de
  `SyncTeamService` (TypeScript parameter property — dentro do próprio
  construtor, o identificador `mountPoints` cru continua se referindo ao
  parâmetro local, então `new SyncBridge(mountPoints, ...)` não precisou virar
  `new SyncBridge(this.mountPoints, ...)` — as duas formas valem o mesmo
  valor). Não toquei em `SyncBridge` (não precisou de getter novo lá).
- **Teste de integração exigiu socket `ws` REAL** (não dá pra testar via
  `routeSpontaneous` privado, que é o padrão usado no resto deste arquivo de
  teste — o envio acontece dentro de `onClientConnected`, que só dispara com
  um `hello` de verdade aceito por `SyncServer.handleHello`). Copiei o mesmo
  padrão de `test/syncServer.test.ts` (`getFreePort`/`waitFor` via `net`/
  `WebSocket` de `ws`) direto para `syncTeamService.test.ts` (arquivos de
  teste deste projeto não compartilham helpers entre si — duplicar essas ~15
  linhas é o padrão aceito, não vale a pena um módulo de test-utils só por
  isso). Dois testes: (1) `watchedRoots` chega antes de `listScripts` com
  `roots` corretos calculados a partir de mount points reais passados ao
  serviço; (2) `mountPoints: []` ainda manda a mensagem com `roots: []` (não
  pula silenciosamente — importante porque um projeto com
  `default.project.json` mal formado/sem mounts válidos não deve deixar o
  plugin sem NENHUM sinal, mesmo que o sinal seja "lista vazia").
- **Verificação**: `npx tsc --noEmit` limpo, `npm run test` 199/199 (era 191,
  +8: 6 de `computeWatchedRoots` + 2 de integração), `npm run build` +
  `npx @vscode/vsce package --no-dependencies` geraram
  `vscode-extension/syncteam-0.1.0.vsix` novo (não instalado, combinado com o
  usuário).
- **Não testado em Studio real** (não é o escopo desta tarefa): o lado do
  plugin nem existe ainda. Quando o `luau-dev` implementar, o roteiro de
  validação é: plugin recebe `watchedRoots` logo após conectar, atualiza sua
  lista de containers ANTES de responder ao `listScripts` que chega logo em
  seguida, e um mount point novo em serviço fora da lista fixa antiga (ex.:
  `Lighting`) passa a sincronizar sem precisar tocar em `Config.luau`.

## Fallback automático de porta ocupada (2026-08-02)

Implementação real do exemplo motivador de `.claude/rules/authority.md`
(regra criada na mesma sessão, ver `docs/DECISIONS.md` para o texto
completo/justificativa). Resumo técnico para quem tocar `SyncServer`/
`SyncController`/`ConnectionState` de novo:

- **`SyncServer.start()` virou `tryListen(candidatePort, attempt)` recursivo**
  (`vscode-extension/src/sync/SyncServer.ts`): cada tentativa cria um
  `WebSocketServer` NOVO (o antigo, que já deu `error`, não é reaproveitável —
  não tentei `.close()`/limpar listeners nele, já que ele nunca chegou a
  bindar nada, então não há recurso para liberar). Em `onFirstError`, só
  `error.code === "EADDRINUSE"` acorda o fallback; qualquer outro código
  rejeita na hora — decisão deliberada porque só "porta ocupada" é o
  obstáculo recuperável coberto pela regra de autoridade, trocar de porta não
  resolve `EACCES`/porta inválida. `resolve(this.tryListen(nextPort, attempt+1))`
  — resolver uma Promise com outra Promise (thenable) faz a externa adotar o
  estado dela automaticamente; é assim que a recursão encadeia sem precisar
  de `await`/`then` explícito dentro do executor.
- **Só EADDRINUSE aciona fallback — cuidado ao testar "erro que não é
  EADDRINUSE"**: não existe jeito portável (Windows/Unix) de forçar um
  `EACCES` de verdade em CI (portas privilegiadas <1024 nem sempre falham no
  Windows). Usei uma porta FORA do intervalo válido (`70000`) — Node valida
  o `port` sincronamente dentro de `net.Server.listen()` e **lança
  synchronous** (`RangeError` `ERR_SOCKET_BAD_PORT`) ANTES de sequer emitir
  `error`; como isso acontece dentro do executor da Promise (`new
  Promise((resolve, reject) => { const wss = new WebSocketServer(...); ...
  })`), o throw síncrono vira rejeição automática da Promise — o código de
  fallback (`onFirstError`) nem chega a rodar. É um caminho de código
  DIFERENTE do que testar um `EADDRINUSE` real, mas o comportamento
  OBSERVÁVEL (rejeita imediato, zero tentativas de fallback logadas) é
  exatamente o que a regra exige, e evita depender de comportamento
  específico de SO. Documentei isso explicitamente no teste para quem ler
  depois não estranhar.
- **Esquema exato**: incremento de 1 em 1 (`port+1`, `port+2`, ...), 5
  tentativas alternativas por padrão (`portFallbackAttempts`, `0` desliga),
  nunca ultrapassa `MAX_PORT` (65535, importado de `util/port.ts` — não
  duplicar o número mágico). Full write-up em `docs/DECISIONS.md`
  2026-08-02 "(2ª rodada)".
- **Como a porta real fica visível SEM eu tocar em nenhum arquivo de UI**:
  a status bar (`ui-dev`, `src/ui/StatusBarItem.ts` + `statusBarMenu.ts`) já
  lê `ConnectionState.port` via `getConnectionState()`/
  `onDidChangeConnectionState` para montar o texto/tooltip. Eu só mudei o
  SIGNIFICADO desse campo (era "sempre a configurada", passou a ser "a
  REAL, pode diferir se houve fallback") e adicionei `portFallbackFrom?:
  number` (a porta original, só presente durante um fallback ativo) — a
  status bar já existente passa a mostrar a porta certa de graça, sem
  nenhuma mudança visual nova. `portFallbackFrom` fica disponível pro
  `ui-dev` usar num destaque visual futuro (tooltip diferenciado), não
  implementado agora (fora do escopo "lógica + ponto de integração").
  **Sinalizei isso no relatório final ao invés de inventar UI.**
- **`StartServiceResult.actualPort`**: novo campo opcional que
  `extension.ts::startService` preenche com `service.getActualPort()` só
  quando difere da porta pedida — é o que `SyncController.doStart` usa para
  decidir se mostra a mensagem normal de sucesso ou a de fallback (com as
  DUAS portas) e para atualizar `this.currentPort`/`this.portFallbackFrom`.
- **Persistência deliberadamente intocada**: um fallback NUNCA escreve em
  `syncteam.port`. Cada novo start/restart tenta a porta configurada
  ORIGINAL de novo (fallback de novo se ainda ocupada) — evita mover a
  config do usuário silenciosamente por uma ocupação transitória.
- **`getConfiguredPort()`/`getActualPort()` novos em `SyncServer` E em
  `SyncTeamService`** (passthrough simples, mesmo padrão de
  `isClientConnected`/`getConnectedCount` já existente) — `actualPort` é
  `null` enquanto parado, resetado em `stop()`.
- **Testes com sockets/portas REAIS** (`net.createServer` para "ocupar" uma
  porta antes do teste, mesma filosofia que todo o resto de
  `syncServer.test.ts` já usa — nunca mockei `ws`): 5 em
  `syncServer.test.ts` (sucesso do fallback com cliente ws real conectando na
  porta nova, esgotamento de tentativas, `portFallbackAttempts:0`,
  erro-não-EADDRINUSE via porta inválida, respeito a `MAX_PORT`), 5 em
  `syncController.test.ts` (`FakeHost`, cobre mensagens/estado/reset de
  `portFallbackFrom`), 1 em `syncTeamService.test.ts` (passthrough
  `getActualPort` de ponta a ponta com start/stop reais). 210 testes no
  total (era 199). `npm run lint` limpo, `npm run test` 210/210 (rodei a
  suíte cheia 2x pra afastar flakiness de porta real), `npm run build` gera
  os dois bundles sem erro.
- **Não precisa de Studio real**: é bind de porta local puro, testável 100%
  com vitest — nenhum `[Hipótese]` pendente de Team Create nesta tarefa.

### Correção pós-revisão do `code-reviewer` (mesmo dia): `stop()` não resetava `currentPort`/`portFallbackFrom`

Bug REAL (achado rodando teste de verdade, não só leitura de código):
`SyncController.stop()` zerava `this.running` mas nunca recalculava
`this.currentPort`/`this.portFallbackFrom` de volta para a porta CONFIGURADA.
Consequência: depois de um `start()` com fallback (ex.: 1400 ocupada, real
1401) seguido de `stop()`, `getConnectionState()` continuava devolvendo
`port: 1401, portFallbackFrom: 1400` com `running: false` — contradizia o
próprio doc-comment do campo (`ConnectionState.port`: "enquanto parado, é a
última porta CONFIGURADA lida") e faria a status bar mostrar a porta errada
com o servidor parado.

- **Por que só `stop()` tinha o bug**: `start()`/`restart()`/`setPort()` todos
  passam por `doStart()`, que SEMPRE recalcula `currentPort`/`portFallbackFrom`
  a partir de `host.getConfiguredPort()` + o resultado de `startService`. Só
  `stop()` tinha seu próprio caminho que nunca tocava esses dois campos —
  qualquer método novo de ciclo de vida que eu adicionar no futuro precisa
  ou passar por `doStart` ou replicar esse recálculo explicitamente; não
  assumir que "zerar `running`" é suficiente.
- **Fix**: em `stop()`, antes de `emitState()`: `this.currentPort =
  this.host.getConfiguredPort(); this.portFallbackFrom = undefined;`.
- **Teste novo** (`syncController.test.ts`, mesmo describe "fallback
  automático de porta ocupada", agora 6 testes no describe/20 no arquivo):
  start com fallback (1400→1401) → `stop()` → `getConnectionState()` deve
  devolver `port: 1400` (a configurada original) e `portFallbackFrom`
  undefined, com `running: false`.
- **Achado secundário de baixo risco, corrigido junto**: `ui/statusBarMenu.ts`
  redeclarava sua PRÓPRIA interface `ConnectionState` (estruturalmente
  compatível com a de `SyncController.ts`, mas duplicada, com um comentário de
  campo desatualizado — "porta configurada em `syncteam.port`", quando na
  verdade é a porta REAL em uso, que diverge da config durante fallback).
  Eliminei a duplicata em vez de só corrigir o comentário: troquei a
  `interface` local por `import type { ConnectionState } from
  "../SyncController.js"; export type { ConnectionState };` — o `export
  type {X} from` sozinho NÃO traz `X` para o escopo local (é só um
  re-export), por isso precisei do `import type` separado ANTES do `export
  type` sem `from` para o resto do arquivo (`buildStatusVisual`/
  `buildMenuOptions`) continuar enxergando o nome. `import type` é elidido em
  tempo de compilação, então `statusBarMenu.ts` continua sem depender de
  `vscode` em runtime (`SyncController.ts` também não importa `vscode`) — não
  quebrou a disciplina de "nenhum arquivo tocado por teste importa vscode".
  `StatusBarItem.ts` e `test/statusBarMenu.test.ts` continuam importando
  `ConnectionState` do mesmo lugar (`./statusBarMenu.js`) sem mudança, porque
  o re-export preserva o caminho de import.
- **Verificação real**: `npm run lint` (tsc --noEmit) limpo; `npm run test`
  (vitest run) 211/211 (era 210, +1); `npm run build` (esbuild) gera os dois
  bundles sem erro.

## "Posse de porta" — encerrar processo que ocupa a porta configurada (2026-08-02)

Item 1 do plano de 4 frentes (docs/DECISIONS.md "3ª rodada"): além do
fallback automático que já existia (2ª rodada, port+1...), a extensão agora
pode OFERECER encerrar o processo que ocupa a porta CONFIGURADA, com
confirmação explícita sempre — nunca automático, nem para o "zumbi
identificado" default.

- **Módulo novo `src/sync/PortOwnership.ts`** — lockfile (grava
  `{pid,port,startedAt}` em todo bind bem-sucedido, num dir persistente
  passado de fora — `ExtensionContext.globalStorageUri` em produção),
  detecção do dono de uma porta (Windows: `netstat -ano -p TCP` +
  `tasklist /FI "PID eq N" /FO CSV /NH`; Unix: `lsof -iTCP:N -sTCP:LISTEN -t`
  + `ps -p N -o comm=`), sondagem de handshake (`probePortSignal`) e a
  orquestração completa (`attemptPortReclaim`).
- **Gotcha #1 confirmado por teste real nesta máquina (Windows) antes de
  codar** (não usei `.claude/research/` pra isso — são utilitários de SO
  estáveis/básicos, não API Roblox/VS Code/Node sujeita a pesquisa prévia,
  mesma régua já dada a `ws`/`esbuild`/`vitest`): `netstat -ano -p TCP` linha
  = `Proto LocalAddr ForeignAddr State PID` (5 tokens por whitespace: `TCP
  127.0.0.1:PORT 0.0.0.0:0 LISTENING PID`); `tasklist ... /FO CSV /NH`
  devolve `"nome.exe","PID",...` (stdout começa com `"`) OU, se o PID não
  existe mais, `"INFO: No tasks are running..."` (sem aspas — dá pra
  distinguir só olhando o 1º char). **Rodar via `execFile` direto (nunca via
  bash/`Bash` tool)** — Git Bash MANGLA `/FI` (tenta expandir como path
  Unix, vira `C:/Program Files/Git/FI` e quebra); `child_process.execFile`
  passa os args direto pro processo, sem esse problema.
- **Gotcha #2 confirmado por teste real**: `process.kill(pid, 0)` (existência,
  não mata) e `process.kill(pid)` (mata de verdade) funcionam como
  documentado no Windows — `0` não lança se o processo existe (`ESRCH` se não
  existe, `EPERM` se existe mas sem permissão — ainda conta como "vivo"), e
  `process.kill(pid)` sem segundo argumento TERMINA o processo à força no
  Windows independente do "sinal" (Windows não tem sinais POSIX de verdade).
  Não precisei de `taskkill` externo pra matar — só pra IDENTIFICAR o nome.
- **Gotcha #3, real, achado escrevendo o teste de `probePortSignal`**:
  `probePortSignal` conecta como cliente `ws` na porta ocupada e **nunca
  manda `hello`** — se mandasse, e não houvesse ninguém realmente conectado
  do outro lado, a PRÓPRIA sonda viraria "o plugin" daquela conexão (o
  `SyncServer` remoto só registra alguém em `this.clients` depois de validar
  o `hello` em `handleHello`) — disparando `onClientConnected`/notificação
  de "plugin conectado" no VS Code de quem estiver rodando aquele servidor.
  Ficar muda funciona porque a REJEIÇÃO de 2º cliente
  (`SyncServer.handleConnection`) é decidida no momento da conexão TCP, ANTES
  de qualquer mensagem — não precisa mandar nada pra observar o sinal
  `"busy"`.
- **Gotcha #4, real, me mordeu ao testar `probePortSignal` contra um
  `net.Server` puro de teste (simulando "porta ocupada por processo
  não-WebSocket")**: chamar `socket.removeAllListeners()` ANTES de
  `socket.terminate()` numa conexão `ws` ainda em handshake HTTP pendente
  quebra tudo — `terminate()` nesse estado pode emitir um `'error'`
  ASSÍNCRONO internamente (abort do request pendente), e SEM NENHUM listener
  de erro conectado o Node relança isso como exceção não tratada do
  processo, travando o teste inteiro em timeout (o `setTimeout` de
  fallback/resolve já tinha disparado, mas o processo/test runner ficava
  destruído pelo throw). **Fix: nunca remover os listeners** — deixar o
  listener de `'error'` conectado para sempre; o guard `if (settled) return`
  no topo de `finish()` absorve com segurança qualquer disparo tardio.
- **Gotcha #5, só no test helper (não é bug de produto)**: testar essa mesma
  sondagem contra um `net.Server` de teste "ocupando a porta" pode deixar uma
  conexão TCP pendurada do lado do servidor de teste depois que o cliente
  `ws` chama `terminate()` — `net.Server.close()` só chama seu callback
  depois que TODAS as conexões existentes terminam (mesmo padrão que já
  motivou `stopSafetyTimeoutMs` em `SyncServer.stop()`, 2026-07-20), e nem
  sempre o SO propaga o fechamento do lado servidor a tempo. Fix (só no
  helper de teste): rastrear (`Set<net.Socket>` num `WeakMap<net.Server,
  Set>`) as conexões aceitas e `.destroy()` cada uma manualmente ANTES de
  `close()`. `net.Server` (ao contrário de `http.Server`) NÃO tem
  `closeAllConnections()` — esse método só existe em `http.Server`.
- **Design do hook em `SyncServer.tryListen`**: `onPortOccupied` só é chamado
  para a porta CONFIGURADA (nunca uma já de fallback) e só na 1ª tentativa —
  novo parâmetro `hookTried` na recursão privada garante no máximo 1 chamada
  por `start()`, mesmo que o retry (`{action:"retrySamePort"}`) esbarre em
  EADDRINUSE de novo (cai então no fallback normal de sempre, sem loop). A
  decisão de "o que fazer" (detectar dono, sondar, mostrar diálogo, matar)
  fica TODA fora de `SyncServer` (em `PortOwnership.ts`/`extension.ts`) — o
  `SyncServer` só sabe "hook disse retry ou fallback", mantendo o mesmo nível
  de pureza/testabilidade com sockets reais que já tinha.
- **`StartServiceResult.portReclaimed`** (novo campo, paralelo a
  `actualPort`): mutuamente exclusivo com `actualPort` diferente da porta
  pedida na prática (posse de porta bem-sucedida = servidor ficou na porta
  ORIGINALMENTE pedida, o oposto de fallback) — `SyncController.doStart`
  mostra uma mensagem distinta ("porta N estava ocupada por X — encerrado com
  sucesso") em vez da de fallback quando presente.
- **Testes**: 34 novos (248 no total, era 214) — `test/portOwnership.test.ts`
  (22, cobre lockfile/detecção/sondagem/orquestração completa incluindo
  "nunca confiar cegamente no lockfile quando o SO reporta um PID diferente
  ouvindo"), `syncServer.test.ts` (+8: hook retry/fallback/só-porta-
  configurada/hook-rejeita/retry-otimista-que-falha, +3 de lockfile),
  `syncController.test.ts` (+4: mensagem de posse reclamada). `npm run lint`
  limpo, `npm run test` 248/248 (suíte cheia rodada 2x, sem flaky), `npm run
  build` gera os dois bundles sem erro.
- **Não precisa de Studio real**: detecção/kill de processo + bind de porta é
  100% lógica local, testável com vitest — nenhum `[Hipótese]` pendente de
  Team Create nesta tarefa. Único residual: variações de locale/versão do
  Windows ou Unix sem `lsof` não testadas — ambas já degradam para "processo
  não identificado" sem quebrar (nunca lança).

## Reentrância de start/restart/setPort durante diálogo modal bloqueado (2026-08-02)

Bug real achado pelo `code-reviewer` na feature de "posse de porta" acima, não
uma nova feature — mas com implicação de design que vale registrar para
qualquer callback assíncrono futuro que possa ficar pendurado esperando
input do usuário (modal, input box, etc.) no meio de um fluxo com estado
próprio de "está rodando".

- **Padrão do bug (generalizável)**: qualquer classe de controller que só usa
  `this.running`/`this.started` (setado no FIM de uma operação assíncrona)
  para bloquear reentrada tem um buraco: enquanto a operação está PENDENTE
  (ainda não setou o flag de "rodando"), esse mesmo flag não bloqueia uma
  SEGUNDA chamada concorrente. Se a operação pendente tiver dentro dela um
  await que pode ficar bloqueado por tempo arbitrário esperando o usuário
  (aqui: `vscode.window.showWarningMessage({modal:true})` dentro de
  `attemptPortReclaim`/`host.confirmKill`, chamado de dentro de
  `host.startService`), a janela de exposição deixa de ser "alguns ms de
  event loop" e vira "o usuário pode deixar aberto por minutos" — qualquer
  gap de reentrância que antes era teórico/improvável de ser explorado vira
  prático. **Regra a aplicar de cor**: sempre que uma classe adicionar um
  ponto de espera em input do usuário (modal ou não) no meio de um fluxo,
  reverificar se o flag de "operação em andamento" já existente cobre
  literalmente o INÍCIO da chamada (antes de qualquer side-effect), não só o
  resultado final.
- **Fix em `SyncController.ts`**: campo novo `startOperationInProgress`
  (booleano), checado e liberado (via `try/finally`) em `start()`/`restart()`/
  `setPort()` — TODOS os três, não só `start()` (o gap existia nos três,
  porque `restart()` não tinha NENHUMA guarda de reentrada antes desta
  correção, nem mesmo checando `running`). A checagem acontece como a
  PRIMEIRA linha de cada método público (síncrona, antes de qualquer
  `await`) — importante para não ter uma janela entre "checou a flag" e
  "setou a flag" onde duas chamadas síncronas concorrentes pudessem passar
  pela checagem antes de qualquer uma setar. `restart()`/`setPort()`
  compartilham `restartCore()` privado (stop+doStart) que deliberadamente NÃO
  checa a flag — os dois únicos chamadores já a seguram antes de invocá-lo;
  checar de novo ali rejeitaria a PRÓPRIA chamada em andamento (bug fácil de
  introduzir se algum dia refatorar isso — documentado inline no código).
  `stop()` não precisou de nenhuma mudança: como o guard pré-existente
  `!this.running` já impede `stop()` de fazer qualquer coisa enquanto
  `running` ainda é `false` (que é o caso durante TODA a janela de uma
  operação de start pendente), não havia gap ali.
- **Mesmo padrão de mensagem de `refreshInProgress`** (`extension.ts`,
  `runRefreshSync`) — reaproveitado, não reinventado: rejeita com
  `host.info`/`showInformationMessage` claro, nunca enfileira, nunca permite
  paralelo.
- **Técnica de teste para simular um `host.startService` "pendurado" igual a
  um modal bloqueado**: reatribuir `host.startService` (método de instância
  de uma classe TS comum — sobrescrever funciona normalmente, cria uma own
  property que sombra o método do protótipo) para retornar uma Promise cujo
  `resolve` é capturado numa variável externa, permitindo ao teste chamar
  `controller.start()` (não aguardado ainda), disparar uma SEGUNDA chamada
  concorrente e só DEPOIS resolver a primeira manualmente. Sem essa técnica
  não dá pra testar reentrância de forma determinística sem `setTimeout`
  real. Ver `test/syncController.test.ts`, describe "reentrância durante
  start/restart/setPort pendente" (5 testes: start↔start, start↔restart,
  start↔setPort, restart↔restart, autostart-silencioso↔start-explícito).
- **Verificação**: `npm run lint` (tsc) limpo, `npm test` 253/253 (era 248,
  +5), `npm run build` gera os dois bundles. Documentado em
  `docs/DECISIONS.md` (continuação de "3ª rodada" §1) e
  `docs/PROJECT_STATUS.md`. **Não testado em VS Code real** (mesma limitação
  de sempre para `SyncController` — nenhum teste toca `vscode`).

## Correção do sinal `"busy"` em "posse de porta": nunca tratar sinal indireto como certeza absoluta (2026-08-02)

Pedido direto do usuário revertendo parte da heurística da feature "posse de
porta" acima, no mesmo dia. Registrar de cor para qualquer heurística futura
de "sinal forte o suficiente pra pular confirmação": **nenhum sinal indireto
de "outro processo está vivo/ativo agora", obtido por sondagem/protocolo
atravessando rede/outro processo, é certeza absoluta o bastante para pular
`host.confirmKill` — só o usuário decide, sempre; o que varia é só a força do
texto do diálogo.**

- **O que existia**: `attemptPortReclaim` tratava `probeSignal === "busy"` (o
  `SyncServer` remoto respondeu `connectionRejected`/`port_in_use` — prova de
  que HÁ um cliente registrado agora) como short-circuit definitivo para
  `{action:"fallback"}`, nunca chamando `findOwner`/`readLock`/
  `host.confirmKill`. Meu raciocínio original: "prova definitiva, nunca
  arriscar matar sessão de colega".
- **Por que estava errado**: `"busy"` prova que o SERVIDOR REMOTO acredita
  ter um cliente registrado — não prova que esse cliente ainda existe de
  verdade agora. Cenário real que o usuário apontou: o Studio do colega
  crasha/fecha, mas o `HeartbeatMonitor` do lado do servidor remoto (extensão
  dele) só detecta a queda depois do timeout (~15s, 3x o intervalo de ping,
  ver entrada "Heartbeat WS ping/pong" acima). Durante essa janela, uma sonda
  `probePortSignal` honestamente observa `"busy"` porque o servidor remoto,
  no seu próprio estado interno, ainda tem um socket "conectado" — mesmo que
  o processo do outro lado (Studio) já não exista. Tratar isso como certeza
  absoluta negava ao usuário a chance de recuperar a porta numa trava real.
- **Fix**: `"busy"` agora participa do MESMO fluxo de identificação
  (`findOwner`/`readLock`, chamados normalmente — antes nem eram chamados) e
  SEMPRE mostra o diálogo quando um PID é identificável, com a mensagem mais
  forte de todas as variantes (mais forte que `"respondsWs"` sem
  identificação). Checado ANTES de `isOwnOrphan` na escolha da mensagem —
  mesmo que o lockfile também bata com o PID detectado, a evidência de
  "sessão ativa agora" pesa mais e usa sua própria mensagem (mais forte), não
  a de "zumbi amigável". Se nenhum PID for identificável (`findOwner`/
  lockfile vazios), comportamento idêntico aos outros sinais: fallback sem
  diálogo (nada concreto pra oferecer).
- **`host.confirmKill` continua sendo a ÚNICA porta pra `killProcess` rodar**
  — isso nunca mudou, em nenhuma versão desta feature. O que mudou foi só
  "quando o diálogo aparece", nunca "se pode matar sem confirmação".
- **O que NÃO mudou**: a restrição de timing (o diálogo nunca dispara
  enquanto uma tentativa de conexão legítima do plugin Studio estiver em
  andamento naquela porta) — isso é questão do timing do próprio bind
  (`SyncServer.tryListen`/`onPortOccupied`, só a 1ª tentativa da porta
  configurada), não do sinal `"busy"` em si.
- **Teste**: o teste único que afirmava `confirmCalls === 0` pro caso "busy"
  foi substituído por 4 testes (`test/portOwnership.test.ts`, describe
  "attemptPortReclaim"): recusa (fallback, mensagem contém "CONECTADA AGORA"/
  "MUITO PROVÁVEL"/"PERDA DE TRABALHO NÃO SALVO"), confirmação (mata,
  `retrySamePort`), sem PID identificável (fallback sem diálogo), e "busy"
  prevalecendo sobre "zumbi identificado" mesmo com lockfile batendo (mensagem
  de "busy", não a de zumbi). 256 no total (era 253).
- **Verificação**: `npm run lint` (tsc) limpo, `npm test` 256/256, `npm run
  build` gera os dois bundles. Documentado em `docs/DECISIONS.md`
  (continuação de "3ª rodada" §1, bloco "Correção do sinal `busy`") e
  `docs/PROJECT_STATUS.md`. Sem `[Hipótese]` nova de Team Create — mudança é
  100% lógica local.
- **Generalização pra memória futura**: qualquer sinal de "processo do outro
  lado está X" obtido por sondagem/protocolo (não por confirmação direta do
  usuário) carrega uma janela de staleness implícita — o que ele prova é "o
  que o outro lado ACHA que é verdade agora", não "o que é verdade agora".
  Só decidir sozinho (sem perguntar) faz sentido quando a ação é reversível E
  o sinal é uma prova de fato PURAMENTE LOCAL (ex.: `process.kill(pid, 0)`
  prova existência de PID local, sem rede/timing de outro processo
  envolvido) — qualquer sinal que atravessa rede/outro processo/outro
  relógio (heartbeat, handshake remoto, etc.) é heurística, nunca certeza,
  para efeito de decidir SEM perguntar ao usuário.
