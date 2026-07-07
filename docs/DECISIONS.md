# Decisões registradas

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
