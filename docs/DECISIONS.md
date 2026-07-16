# Decisões registradas

## 2026-07-16 — Autostart passa a ser opt-in, default DESLIGADO

**Mudança de comportamento padrão, pedida pelo usuário após teste real.** Até
esta entrada, `plugin/src/init.server.luau` chamava `start(plugin)`
incondicionalmente ao carregar (só sujeito ao guard de Run/Play) — o dev não
tinha como optar por conectar manualmente. Novo padrão: `Config.AUTOSTART_SETTING_KEY
= "SyncTeam_AutoStart"` + `Config.resolveAutoStartEnabled(pluginObject)`
(`plugin/src/Config.luau`), default **false** (deliberadamente o OPOSTO de
`Config.resolveNotificationsEnabled`, que é default true) — o comportamento
padrão agora é o dev clicar em CONNECT no painel quando quiser sincronizar.
Auto-start incondicional só volta a acontecer se alguém ligar a setting
explicitamente via `plugin:SetSetting("SyncTeam_AutoStart", true)` pelo
Command Bar (sem UI dedicada nesta fatia — mesmo padrão histórico de
`PORT_SETTING_KEY` antes de ganhar campo no painel). O botão CONNECT do painel
(M4.5) já cobria conexão manual antes desta mudança; nada novo precisou ser
criado ali.

## 2026-07-16 — Consolidação de log de boot (Logger.debug)

**Ruído reportado pelo usuário**: cada conexão gerava uma rajada de ~7 linhas
de subsistema no Output do Studio (`registry reconciliado`, `observação
iniciada`, `sessão criada`, `leases: ciclo iniciado`, `presença: ciclo
iniciado`, `conectado em ...`, `iniciado. Conectando...`), sem diferenciação
de nível. Fix: novo `Logger.debug(...)` (`plugin/src/Logger.luau`) — mesmo
forward por WS de `Logger.log` (observabilidade de teste automatizado via
`Tools/README.md` continua intacta), mas **sem** `print()` no Output do
Studio. As 7 linhas acima (em `ScriptRegistry.luau`, `SourceWatcher.luau`,
`TeamCreateElection.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
`init.server.luau`) foram rebaixadas para `Logger.debug`. Em troca, uma ÚNICA
linha `Logger.log` nova aparece quando a conexão de fato **estabiliza**
(dentro de `runConnection`, no mesmo ponto em que o botão vira "connected"):
`"conectado em ws://... (N scripts observados)"` — contagem via
`SourceWatcher.getWatchedCount()` (novo). O log antigo `conectado em %s`, que
disparava OTIMISTICAMENTE assim que o `WebStreamClient` era criado (antes de
saber se ia dar `ConnectFail`), também virou `Logger.debug` — ele descrevia
uma tentativa, não uma conexão de fato estabelecida, e podia aparecer 3x
seguidas mesmo sem nunca conectar de verdade (era um dos sintomas do log colado
pelo usuário). Resultado: as únicas linhas visíveis relacionadas a conexão
agora são "conectado em ... (N scripts)" (1x por conexão real), "desconectado;
reconectando em Xs" (1x por queda, já existia) e as linhas raras de porta
ocupada/candidatas esgotadas (já existiam, mantidas — não são ruído rotineiro).
`erro WS <code> <msg>` também virou `Logger.debug` (era redundante com
"desconectado; reconectando", que já é a linha visível da categoria
"reconectando"). Mensagens de mudança de liderança (`sou o líder agora (term
N)`) e o lado de `stop()` (`observação parada`, `sessão removida`, etc.) NÃO
foram tocados — são eventos raros/relevantes de verdade, não ruído rotineiro
de boot, e o lado de `stop()` em particular tem valor de diagnóstico (ver
entrada abaixo).

**Validado só por `rojo build` + `lune run`** nos 8 arquivos tocados
(`Config.luau`, `Logger.luau`, `SourceWatcher.luau`, `ScriptRegistry.luau`,
`TeamCreateElection.luau`, `TeamCreateLease.luau`, `TeamCreatePresence.luau`,
`init.server.luau`) — sem erro de sintaxe. Roteiro de teste real pendente:
conectar em Studio real e confirmar que o Output mostra só a linha consolidada
de "conectado" (mais scripts observados) em vez da rajada antiga.

## 2026-07-16 — Investigação do `stop()` sem log de Run/Play (prioridade rebaixada)

Usuário reportou plugin "parando sozinho" (sequência completa `observação
parada`/`leases: ciclo parado`/`presença: ciclo parado`/`sessão removida`/
`parado.` no meio de um teste, sem a linha `"F8/F5 (Run/Play) detectado..."`
que o guard de Run/Play sempre loga antes de chamar `stop()` — ver entrada
acima de 2026-07-16 sobre esse guard). Investigação por leitura de código
descartou: (a) o guard de Run/Play (confirmado ausente no log, único chamador
que teria logado algo antes), (b) `onPortChange`/troca de porta (usuário não
mexeu na porta), (c) clique real em DISCONNECT (nenhum caminho encontrado em
`PluginUI.luau`/`StatusPanel.luau` onde o painel dispararia `Activated` do
botão CONNECT/DISCONNECT sozinho — os únicos handlers de `Activated`
encontrados são conexões estáticas de sinal, criadas 1x no mount, sem
recriação/reentrância espúria localizada). Candidato mais plausível **não
totalmente confirmado**: `plugin.Unloading:Connect(stop)` disparando por um
REDEPLOY do plugin (`Tools/build-and-deploy-plugin.ps1`/`.sh` sobrescreve o
arquivo em `%LOCALAPPDATA%\Roblox\Plugins`, o que o Studio detecta como
reload — `plugin.Unloading` dispara para a instância antiga do script,
independente de o Studio ter fechado) — isso bateria com o timing observado
(shutdown completo e síncrono, sem log de motivo). **Prioridade rebaixada pelo
usuário**: confirmou que o servidor da extensão VS Code estava desligado
durante o teste, o que já explica o ciclo `conectado`→`erro WS 400
ConnectFail`→`reconectando` como comportamento esperado (plugin tentando
conectar sem ninguém escutando) — não é mais bug prioritário. Fica
`[Hipótese]`, sem instrumentação adicionada nesta tarefa (não pedida); se
reaparecer, a forma mais barata de confirmar é logar `debug.traceback()` (ou
um marcador textual simples) no topo de `stop()` na próxima ocorrência.

## 2026-07-16 — Silenciar "descartado (sem conexão): log" duplicado no boot

Ajuste de verbosidade, não decisão de arquitetura. Usuário reportou ruído real
(log colado do Output do Studio): nos primeiros segundos antes do WS conectar,
toda linha de log normal do boot vinha seguida de uma linha extra `descartado
(sem conexão): log`, dobrando a quantidade de linhas. Causa: `sendMessage`
(`plugin/src/init.server.luau`) avisa "descartado" para QUALQUER `kind`
descartado por falta de conexão — inclusive `kind == "log"`, que é o próprio
`Logger.log` se auto-encaminhando pela conexão WS (ver `Logger.luau`); o
conteúdo já apareceu no Output via `print()` dentro do próprio `Logger.log`,
então avisar de novo que o encaminhamento falhou é redundante, não uma falha
relevante. Fix: `sendMessage` só imprime o aviso "descartado (sem conexão):
<kind>" quando `message.kind ~= "log"` — mensagens de protocolo reais
(`scriptAdded`, `presenceUpdate`, etc.) continuam avisando normalmente quando
descartadas por falta de conexão, porque isso ainda é informação útil para
depurar por que algo não chegou na extensão. Comportamento de erro de envio
real (`falha ao enviar: ...`) não foi alterado.

## 2026-07-16 — Guard para não rodar sync durante F8 Run / F5 Play no Studio

**[Verificado] via pesquisa de API** (não teste em Studio real, ver
`.claude/research/2026-07-16-runservice-isstudio-isrunning-plugin-detect-test.md`):
`RunService:IsStudio()` sozinho NÃO distingue edição normal do Team Create de
um teste rodando dentro do próprio Studio — fica `true` nos dois casos. A API
correta é `RunService:IsRunning()` (inverso de `IsEdit()`): edição normal =
`IsRunning() == false`; F8 Run ou F5 Play = `IsRunning() == true`. Condição
adotada em `plugin/src/init.server.luau` para "devo sincronizar":
`RunService:IsStudio() and not RunService:IsRunning()`.

**Onde foi plugado**: novo loop próprio em `init.server.luau`
(`checkRunModeTransition`, `task.spawn` dedicado, polling a cada
`Config.POLL_INTERVAL_SECONDS` — reaproveitado o mesmo intervalo já usado para
o polling de Source, sem inventar timer novo) detecta a TRANSIÇÃO de edição
para Run/Play (chama `stop()`) e de volta (chama `start(plugin)` de novo, só
se foi este guard quem parou — flag `runGuardStoppedSync`). Checagem só no
boot não bastaria: o dev pode apertar F8/F5 depois do plugin já estar
conectado. O auto-start no fim do arquivo também ganhou a mesma checagem (não
inicia automaticamente se o script carregar já em modo Run/Play).

**Limitação conhecida, aceita, não resolvida**: quando o teste é PAUSADO, a
doc oficial afirma que `IsRunning()` (e `IsEdit()`) ficam ambos `false` — ou
seja, este guard pode falso-negativo (achar que voltou para edição normal
enquanto o teste só está pausado) e retomar o sync indevidamente durante uma
pausa de teste. Não há solução limpa documentada para isso (a pesquisa citada
não encontrou confirmação de comportamento de plugin real nesse caso
específico) — tratado como limitação conhecida, não uma tentativa de hack.

**Validado só por `rojo build` + `lune run`** em `init.server.luau` — sem erro
de sintaxe, erro esperado só na primeira linha que toca `game`. Nada testado
em Studio real nesta tarefa (transição de fato ao apertar F8/F5, comportamento
durante pause) — fica `[Hipótese]` quanto ao comportamento em runtime real até
o usuário confirmar.

## 2026-07-16 — Bug real corrigido: materialização inicial duplicava `.lua` já existente em `.luau` novo

**[Verificado]** — confirmado testando com Wally de verdade em Studio, contra
um place que já tinha pacotes instalados via `wally install` puro (extensão
`.lua`, antes do SyncTeam existir no workspace). Causa raiz:
`recomputeAndApplyLayout` (`vscode-extension/src/sync/SyncBridge.ts`) usa
`computeLayout` (`rojoPathMapping.ts`), que por decisão de projeto SEMPRE
escolhe extensão `.luau` na escrita — e a primeira materialização de um uuid
ainda sem `diskPath` conhecido nunca checava se já existia em disco um `.lua`
correspondente (mesmo diretório, mesmo nome-base) antes de decidir onde
escrever. Resultado: uuid cujo script já tinha `Nome.lua`/`Nome.server.lua`
etc. em disco (de uma instalação Wally anterior, fora do SyncTeam) ganhava um
`.luau` extra ao lado — duplicata real do mesmo script em dois arquivos,
deixando o `.lua` original órfão (não deletado, só abandonado).

**Fix**: `SyncBridge.resolveInitialDiskPath` — chamado só na materialização
INICIAL (`recomputeAndApplyLayout`, ramo `previous === undefined`, ou seja
`diskPathByUuid.get(uuid) === undefined`). Antes de escrever no `diskPath`
`.luau` computado, checa via `DiskIO.readFile` se o `.lua` equivalente
(`diskPath.replace(/\.luau$/i, ".lua")`) já existe; se existir, reaproveita
esse caminho como o `diskPath` do uuid em vez de criar o `.luau` novo. Se não
existir, comportamento anterior é preservado (`.luau`, como sempre). Escopo
deliberadamente restrito a essa primeira materialização — `moveOnDisk`/rename
de scripts já sincronizados (`handleScriptMoved`) não foi alterado, é
comportamento fora de escopo desta correção (regra geral "escrita sempre
`.luau` para arquivos NOVOS de verdade" continua valendo).

Testes: `vscode-extension/test/syncBridge.test.ts`, describe
"materialização inicial reaproveita .lua pré-existente (2026-07-16)" — uuid
novo com `.lua` pré-existente reaproveita sem criar `.luau` duplicado; uuid
novo sem nada em disco continua materializando `.luau` normalmente (sem
regressão). 181/181 testes (`npx vitest run --pool=threads`), `tsc --noEmit`
e `npm run build` limpos.

## 2026-07-16 — Rejeitado: auto-editar `wally.toml` do colega ao detectar pacote novo replicado

**Decisão pendente resolvida como "não fazer" por ora** (usuário pediu
avaliação de custo antes de decidir). Ideia avaliada: quando um pacote novo
aparece no Studio compartilhado via Team Create (alguém instalou via Wally),
o SyncTeam do lado de quem RECEBE detectaria "isso é um pacote Wally" (via
metadado novo em `TestService.SyncTeam`) e escreveria automaticamente a
entrada correspondente (`alias = "author/repo@version"`) no `wally.toml`
local do colega, evitando que o próximo `wally install` dele apague o
arquivo recebido (ver decisão acima).

**Por que não**: exigiria (1) schema novo de metadados só pra isso — alias
real só existe no `wally.toml` de quem instalou, não é 100% derivável do
nome da pasta `_Index`; (2) parser/writer de TOML de verdade do lado da
extensão (edição ingênua por string arrisca reproduzir bug de chave
duplicada real já encontrado no `wally.toml` de teste do usuário, ver
`Packages` do projeto `StudioSync/Studio1`); (3) tratamento de conflito
(arquivo aberto/sujo no editor do colega, versão já declarada diferente,
merge com git). Custo desproporcional ao ganho (economiza uma frase em
chat). **Alternativa aceita**: comunicação manual — quem instala pacote novo
avisa o time pra rodar `wally install` também. Revisitar só se isso virar
dor recorrente de verdade (múltiplos devs, múltiplos incidentes).

## 2026-07-16 — Pastas de pacotes Wally (`Packages`/`ServerPackages`/`DevPackages`) excluídas do live edit sync

**Risco de arquitetura identificado e aprovado pelo usuário** (não é
experimental — decisão já implementável): `Config.getWatchedRoots()`
(`plugin/src/Config.luau`) e o observador genérico de Source
(`SourceWatcher.luau`) tratavam QUALQUER `ModuleScript` igual, incluindo os
instalados via Wally (https://wally.sh) dentro de pastas `Packages`/
`ServerPackages`/`DevPackages` (convenção padrão do gerenciador — `Packages`
é a mais comum, mas projetos podem ter as 3, separando dependências por
lado). Isso é um problema real: se dois devs tiverem `wally.lock`/`Packages/`
locais divergentes (versão desatualizada de um lado), o SyncTeam podia
empurrar o Source do pacote vendorizado de um dev pro Team Create
compartilhado, alterando silenciosamente a dependência de TODOS os devs —
pacote vendorizado nunca deveria ser editado via editor colaborativo ao vivo.

**Escopo exato da exclusão** (não é exclusão total):

- Pastas cujo `Name` seja exatamente `Packages`, `ServerPackages` ou
  `DevPackages`, em qualquer profundidade dentro dos watched roots (não só
  na raiz), marcam tudo abaixo delas como "vendorizado".
- **Bloqueado nos dois sentidos**: (a) `checkSourceChanged` em
  `SourceWatcher.luau` nunca emite `sourceChanged` para scripts vendorizados
  (nunca puxa Studio→disco uma edição neles); (b) `handleWriteSource` em
  `init.server.luau`, modo ATUALIZAÇÃO (script já existente, `message.uuid ~=
  nil`), rejeita a escrita com `writeAck {ok=false, error="edição bloqueada:
  ..."}` e log claro, sem chamar `TeamCreateLease.ensureIntent`/`canWrite`
  nem `SourceWatcher.writeSource` — ou seja, também não arbitra lease para
  esses scripts (nunca cria intent para eles, então nunca ganham entrada em
  `Leases/<uuid>`).
- **NÃO afeta discovery/identidade nem criação**: `ScriptRegistry`
  (`resolveOrAllocate`/`forEach`/`getUuid`) e `SourceWatcher.listScripts()`
  continuam tratando scripts vendorizados normalmente — necessário para o
  "Refresh Sync" da extensão VS Code detectar "esse pacote já existe no
  Studio, não duplicar" quando o usuário instala um pacote novo. Modo
  CRIAÇÃO do `writeSource` (sem `uuid`, script novo) também não é afetado —
  é assim que um pacote novo chega ao Studio pela primeira vez; só DEPOIS de
  criado é que ele entra em "modo vendorizado" (sem watch/lease).

**Implementação**: `Config.SYNC_EXCLUDED_FOLDER_NAMES` (tabela de nomes) +
`Config.isInsideExcludedPackageFolder(instance)` (sobe `instance.Parent` até
a raiz, `true` se algum ancestral tiver `Name` na lista) em
`plugin/src/Config.luau`. Consumido em dois pontos: `SourceWatcher.luau`
(`checkSourceChanged`, early-return antes de qualquer leitura/dedupe de
`Source`) e `init.server.luau` (`handleWriteSource`, modo ATUALIZAÇÃO,
checagem logo após resolver a Instance por uuid, antes de
`TeamCreateLease.ensureIntent`). Trabalho equivalente no lado extension-dev
(TypeScript) feito em paralelo, mesmo contrato de nomes de pasta.

Validado só por `rojo build` (layout ok) + `lune run` em `Config.luau`,
`SourceWatcher.luau`, `init.server.luau` — sem erro de sintaxe, erro esperado
só na 1ª linha que toca `game`. **Nada testado em Studio real nesta tarefa**
— instalar um pacote Wally de verdade, editar `Packages/algum-pacote/init.luau`
pelo Explorer e confirmar que nenhum `sourceChanged` é emitido, e mandar um
`writeSource` de atualização via extensão contra um uuid dentro de `Packages/`
e confirmar `writeAck {ok=false}` com o motivo, ficam `[Hipótese]` até o
usuário executar com Studio real.

**Lado extensão (extension-dev, TypeScript)**: módulo puro
`vscode-extension/src/mapping/wallyPackageFolders.ts`
(`isExcludedPackageFolderName`/`isInsideExcludedPackageFolder`, mesmo contrato
exato de nomes — "Packages"/"ServerPackages"/"DevPackages", case-sensitive,
segmento inteiro do path, nunca substring), consumido em três pontos de
`SyncBridge.ts`:

- `handleSourceChanged` (Studio→disco, mensagem espontânea): early-return
  antes de `applyStudioContent` se o `instancePath` conhecido (via
  `this.scripts.get(uuid)?.path`, com fallback ao `message.path` informativo)
  estiver dentro de uma pasta excluída. Log `info` (não é erro).
- `handleLocalFileChange` (disco→Studio, watcher de arquivo), só no ramo de
  ATUALIZAÇÃO (`knownUuid` já existe): early-return equivalente, sem tocar
  `contentCache`/rede. O ramo de CRIAÇÃO (uuid ainda desconhecido) não tem
  nenhum check — continua funcionando normalmente dentro dessas pastas, é
  assim que um pacote novo chega ao Studio pela primeira vez.
- `reconcileUuidOnRefresh` (Refresh Sync, merge de 3 vias): qualquer ramo que
  faria PUSH de atualização (só disco mudou, só Studio mudou) ou reportaria
  CONFLITO (com ou sem ancestral em `contentCache`) é pulado silenciosamente
  (log `info`, sem chamar `onSyncConflict`) quando dentro de pasta excluída.
  Os ramos "descoberto só no Studio → pull" e "convergiram → atualiza
  baseline" continuam normais (não são push nem conflito); e
  `reconcileDiskOnlyFiles` (arquivo só no disco, uuid nunca visto → criação)
  não tem check nenhum, igual ao ramo de criação acima.

Testes novos: `test/wallyPackageFolders.test.ts` (13, função pura) +
`describe`s dedicados em `test/syncBridge.test.ts` (7 testes: skip de
`sourceChanged`, skip de atualização local, criação local continua
funcionando, e os 4 cenários de `refreshSync` — só disco, só Studio, conflito
sem `onSyncConflict`, criação nova continua funcionando). 179 testes no total
(`npx vitest run --pool=threads`), `npx tsc --noEmit` e `npm run build`
limpos. **Não testado com Studio real** — mesma limitação do lado Luau, fica
`[Hipótese]` até round-trip real com os dois lados.

## 2026-07-15 (2ª rodada) — mesmo bug de montagem, segundo erro real: `Enum.AutomaticCanvasSize` não existe

Depois do fix do escopo `vide.root()` (entrada abaixo), reteste real revelou
o erro EXATO pela primeira vez (usuário conseguiu ler o Output e colar o
stack trace completo): `AutomaticCanvasSize is not a valid member of "Enum"`
em `StatusPanel.luau` (`SessionsTable`, propriedade `ScrollingFrame.AutomaticCanvasSize`).

**Causa**: confusão entre nome de propriedade e nome de enum — a propriedade
`ScrollingFrame.AutomaticCanvasSize` existe de verdade, mas o TIPO do valor
é `Enum.AutomaticSize` (membros `None`/`X`/`Y`/`XY`), não um enum chamado
`Enum.AutomaticCanvasSize` (que não existe). Código tinha
`Enum.AutomaticCanvasSize.Y`, corrigido para `Enum.AutomaticSize.Y`.

**Por que `lune run` não pegou isso**: indexação de `Enum.<Nome>` inválido
não é erro de sintaxe (Lune não emula os Enums reais do Roblox com essa
fidelidade) — só quebra em tempo de execução contra o Roblox de verdade.
Nenhuma das validações usadas neste projeto (`rojo build`, `lune run`) pega
esse tipo de erro; só teste real em Studio revela. Reforça a regra já
existente do projeto ("confirme APIs contra documentação oficial antes de
depender"), mas o caso aqui é mais sutil: a API (`AutomaticCanvasSize`)
EXISTE, só o enum do valor é que tem nome diferente da propriedade — fácil
de errar por analogia com outras props que reusam o próprio nome como enum.

**Lição de processo**: o stack trace completo (via `error while running
root()/branch()/switch_map()`) só ficou visível porque o usuário limpou o
Output antes de recarregar o plugin e buscou por "painel" — sem isso,
o erro genérico da entrada anterior ("cannot use effect()...") escondia
esse segundo erro atrás de um scroll-back poluído por reloads antigos.

## 2026-07-15 — M4.5: painel Vide não montava — `vide.create`/`effect`/`indexes`/`switch` chamados fora de `vide.root()`

**Bug real, encontrado ao investigar relato do usuário** ("cliquei no SyncTeam
mas não surgiu nada na interface"): `plugin/src/ui/PluginUI.luau` chamava
`StatusPanel.build(state, callbacks)` e SÓ DEPOIS passava o `rootFrame` já
pronto para `vide.mount(function() return rootFrame end, widget)`. Como toda
a árvore (`vide.create` com propriedades reativas, `vide.indexes` da tabela
de sessões, `vide.switch` das duas telas) já tinha sido CONSTRUÍDA antes de
`vide.mount` empurrar o escopo de `vide.root()`, a primeira propriedade
reativa encontrada (ex.: `Text` do campo de porta) disparava
`assert_stable_scope()` (confirmado lendo
`plugin/Packages/_Index/centau_vide@0.4.1/vide/src/{implicit_effect,effect,graph}.luau`)
e lançava `"cannot use effect() outside a stable or reactive scope"`.

**Efeito observável**: o `pcall` em `PluginUI.init` captura esse erro (linha
já existente, log só localmente — ver entrada de descoberta relacionada
abaixo sobre o ponto cego do log remoto), mas toolbar+`DockWidgetPluginGui`
JÁ tinham sido criados nas linhas anteriores do mesmo `pcall` — resultado:
botão existe, clique alterna `widget.Enabled`, mas o painel nunca é montado
(fica vazio). Dá exatamente a impressão de "cliquei e não aconteceu nada".

**Fix**: mover a chamada de `StatusPanel.build(...)` para DENTRO do closure
passado a `vide.mount(function() ... end, widget)` — agora toda a construção
reativa acontece já dentro do escopo de `root()` que `mount` empurra.
`rojo build`/`lune run` limpos depois do fix. **Pendente confirmação real**
(usuário vai testar depois do redeploy) — não promover a `[Verificado]`
até confirmar que o painel aparece.

**Achado relacionado, mesma investigação**: `PluginUI.init` roda em código
de TOPO do script (`init.server.luau`, antes de `start()`), e `Logger.init(sendMessage)`
só é chamado DENTRO de `start()` — ou seja, qualquer `log(...)` chamado por
`PluginUI.init` (sucesso OU falha) só aparece no Output LOCAL do Studio,
nunca é encaminhado pro log remoto via WS. Isso não é um bug (é a ordem
correta — `Logger` só pode encaminhar depois que a conexão existe), mas é um
ponto cego real do fluxo de debug remoto (`Tools/`): qualquer erro que
aconteça ANTES de `start()` rodar precisa ser lido no Output do Studio
diretamente, não dá pra diagnosticar só pelos logs de arquivo.

## 2026-07-15 — M3 fechado com 2 Studios reais: convergência, failover, leases e não-regressão confirmados

Sessão de teste real completa contra os 2 Studios (`Tools/`, sem intervenção
manual de build/deploy/log — só as ações físicas de fechar/reabrir janela).
Plugin rebuildado com o código atual (auto-descoberta de porta + Logger
centralizado, ambos ainda não testados em Studio real antes de hoje).

- **M3.1 reconfirmado**: sessões convergem para o mesmo `LeaderClientId`
  nos dois lados (novo par de clientIds, já que cada `start()` gera um
  novo — sem regressão da auto-descoberta de porta/Logger sobre a eleição).
- **M3.1 failover forçado — achado importante sobre o TEMPO real**: fechar a
  janela do Studio líder no Windows dispara `plugin.Unloading` de forma
  confiável, que chama `TeamCreateElection.stop()` — isso remove a própria
  `Sessions/<clientId>` de forma SÍNCRONA antes do processo morrer de vez.
  Resultado: o outro Studio promove em **~3s** (2 Studios reais,
  `Tools/logs/studio-34981.log` 03:41:17→03:41:20), bem mais rápido que o
  orçamento teórico de "sessão obsoleta após 8s + 2 observações" citado nos
  docs anteriores — porque esse caminho nunca entra em jogo quando o
  shutdown é gracioso (a sessão simplesmente desaparece, não fica "stale").
  **Não testado**: crash não-gracioso (processo morto sem `Unloading`), que
  aí sim dependeria do timeout de 8s+observações. Registrar se algum dia
  precisarmos garantir esse caminho também (ex.: Studio travando/crashando
  de verdade, não só fechando a janela).
- **M3.2 fechado**: rejeição de lease confirmada com timestamps reais —
  dev A escreve, ganha lease; dev B tenta escrever o MESMO script
  (`ServerScriptService/Server/Renamed`, mesmo uuid, replicado via Team
  Create) enquanto o intent de A ainda está fresco → plugin de B recusa
  (`writeAck ok=false`, log `ERROR disco → Studio: FALHA aplicando ...
  lease negada — script sendo editado por dev_Hakor`). **Nuance de teste**:
  a primeira tentativa (edits via 2 chamadas de `Edit` na sessão, com
  latência de modelo entre elas) acabou com ~9s de intervalo real —
  quase exatamente o limiar de 8s de staleness — e as duas escritas foram
  aceitas em sequência (sem rejeição), porque o intent de A já tinha
  expirado quando B chegou. Repetido com escrita direta via shell
  (`>>` + `sleep` curto, gap real ~5s) para garantir sobreposição e SÓ
  ASSIM a rejeição apareceu. Lição: qualquer reteste futuro desse cenário
  precisa garantir que o segundo escritor chegue **dentro** da janela de
  8s do primeiro, não depois — timing de ferramentas/IA pode facilmente
  estourar esse limiar sem perceber.
- **M3.3, camada de dados**: `leaseChanged`/rejeição chegam corretos nos
  logs; o aviso VISÍVEL (`vscode.window.showWarningMessage`) não foi
  reverificado numa janela real de VS Code nesta sessão (só harness Node) —
  fica como único item de M3 ainda não 100% fechado, ver MILESTONES.md.
- **Não-regressão confirmada**: scripts DIFERENTES criados por cada dev na
  mesma janela de tempo (`NaoRegressaoA`/`NaoRegressaoB.server.luau`) — zero
  interferência, cada um com seu próprio uuid, replicação cruzada correta
  (`resolveOrAllocate: reaproveitado uuid=... já existente no registry
  compartilhado` quando o eco do script do outro dev chegou via disco).
- **Curiosidade não investigada, não bloqueante**: no primeiro `hello` após
  reabrir o Studio A, o campo `place` reportado foi `Place4`; na reconexão
  seguinte (mesma conta, mesma place segundo o usuário), foi `Place1` —
  mesmo valor que o Studio B sempre reportou. Não afetou nenhum teste
  (identidade da place não é usada para nada no protocolo, só exibição/log);
  registrar aqui caso apareça de novo e vire suspeito de bug real.

## 2026-07-07 — M3.1: split-brain de liderança — causa raiz confirmada por leitura de código e CORRIGIDO (pendente reteste real)

Investigação de causa raiz (só leitura de código + logs — sem Studio real
disponível) da entrada anterior ("split-brain CONFIRMADO... não corrigido").

**Hipótese de corrida confirmada como POSSÍVEL dado o fluxo atual do
código** (não apenas plausível — o padrão de código está literalmente lá):
`TeamCreateSchema.getOrCreate` (antigo) e o `getOrCreate` privado de
`TeamCreateElection.luau` seguiam o padrão clássico "singleton preguiçoso"
(`parent:FindFirstChild(name)`, se `nil` então `Instance.new`+`.Parent`).
Roblox permite duas Instances irmãs com o mesmo `Name` — não faz merge. Se
dois Studios chamam isso quase ao mesmo tempo ANTES da réplica do Team
Create assentar, cada um cria sua PRÓPRIA Instance. **Agravante confirmado
por leitura de `TeamCreateElection.start()`**: `tick()` roda SINCRONAMENTE
logo depois de `ensureOwnSession()`, dentro do próprio `start()` — sem
nenhuma espera/garantia de que o estado lido de `TestService.SyncTeam` já
reflete a réplica do outro Studio. Pior ainda: `rootValues`/`sessionsFolder`
eram capturados **1x** em `start()` e nunca reavaliados — mesmo que a
réplica do outro Studio chegasse depois como Instance irmã, o Studio
continuava lendo/escrevendo pra sempre na SUA cópia local cacheada. Isso
explica termos divergentes (6 vs 1): plausivelmente cada Studio operava
sobre uma Instance `LeaderTerm`/`Sessions` FISICAMENTE diferente, não havia
conflito de escrita na mesma Instance — havia duplicação de identidade.
`[Dedução direta do código]`: a mecânica é real e está presente no fluxo
atual; `[Hipótese]`: se foi EXATAMENTE isso (vs. duas pastas "SyncTeam"
duplicadas de sessões de teste anteriores nunca limpas) que produziu os
números observados no log — não há como confirmar sem inspecionar o
Explorer ao vivo, que não está disponível nesta investigação.

**Decisão de fix — reconciliação determinística, não só "evitar a
corrida"**: impossível garantir 100% contra corrida com replicação
assíncrona (nem um delay aleatório resolveria de verdade, só reduziria a
janela) — o fix precisa fazer TODOS os Studios convergirem pra MESMA escolha
canônica mesmo que duplicatas cheguem a ser criadas. Implementado em
`plugin/src/TeamCreateSchema.luau`:

1. **Desempate determinístico e replicado**: cada Instance-singleton criada
   por este módulo ganha um atributo `SyncTeamOrigin` (GUID aleatório,
   gravado antes de `.Parent`). Se `getOrCreate` encontra >1 candidato com o
   mesmo Name+ClassName sob o mesmo parent, a canônica é a de MENOR
   `SyncTeamOrigin` — todo Studio que já tiver ambas as duplicatas
   replicadas calcula a MESMA escolha, sem depender de ordem de observação
   local. Diferente do critério cogitado no início ("nome de Instance mais
   antigo" — Roblox não expõe timestamp de criação nem ordem estável
   cross-cliente) e do "menor valor apurado" sozinho (não serve para
   Folders, que não têm `.Value`).
2. **Merge, nunca destrói dado**: Folder → reparenta TODOS os filhos da(s)
   duplicata(s) pra dentro da canônica antes de destruir a casca vazia
   (cobre Scripts/Sessions/Leases e o próprio SyncTeam — nunca perde
   sessões/scripts/leases que nasceram por azar sob a pasta "perdedora").
   IntValue (LeaderTerm/NextJoinSequence/NextLeaseRequestSequence) → a
   canônica fica com o MAIOR valor entre as duplicatas (contadores deste
   projeto são estritamente crescentes; "maior" nunca retrocede nem perde
   progresso real). StringValue (LeaderClientId) → sem merge de conteúdo;
   o ciclo de eleição já reavalia liderança do zero no tick seguinte a
   partir de Sessions/ mesclado, autocorrigindo (custo aceito: pode gerar +1
   incremento de term "desperdiçado" na convergência, nunca viola exclusão
   mútua de líder).
3. **Reconciliação contínua, não só na criação**: `getOrCreate` roda a
   MESMA checagem de duplicata toda vez que é chamado (não só quando
   `#candidates == 0`). Isso sozinho não bastava: `TeamCreateElection.tick()`
   só chamava `ensureRoot()`/`ensureFolder("Sessions")` 1x dentro de
   `start()` e cacheava o resultado (`rootValues`/`sessionsFolder`) pelo
   resto da sessão — corrigido chamando de novo A CADA PULSO (2s) dentro de
   `tick()`, reatribuindo essas variáveis. Reaproveita a mesma ideia já
   usada em `ScriptRegistry` (reconciliar depois do fato via varredura do
   registry compartilhado, M2 2026-07-04), adaptada para o caso aqui ser
   duplicação de Values/Folders simples, não de identidade por
   ObjectValue/Instance física.

**Por que não corrigir só "evitando a corrida" (ex.: delay aleatório antes
do primeiro tick)**: reduziria a chance, não eliminaria — a tarefa exigia
convergência garantida mesmo se duplicatas chegarem a existir. O fix acima
tolera duplicatas genuinamente acontecendo e ainda assim converge.

**Constantes de tempo validadas (pulso 2s/stale 8s/cleanup 20s/2
observações) não foram alteradas** — o fix não precisou tocar nelas.

**Validado só por `rojo build` + `lune run`** (`TeamCreateSchema.luau`,
`TeamCreateElection.luau`, e os dependentes `TeamCreateLease.luau`/
`ScriptRegistry.luau`/`SourceWatcher.luau`, que consomem
`TeamCreateSchema.ensureRoot/ensureFolder` com a mesma assinatura — sem erro
de sintaxe, erro esperado só na primeira linha que toca `game`). **Nada
testado em Studio real nesta tarefa** — este fix em si é a resposta à
entrada anterior desta mesma seção, mas continua sendo código não
exercitado contra o engine/replicação real. Roteiro de reteste (mesmos 2
Studios/2 contas, repetindo o cenário de reload simultâneo) em
`docs/PROJECT_STATUS.md`.

**Adição pequena de escopo, mesma tarefa**: botão de toolbar temporário
"SyncTeam: Alternar porta (34980/34981)" em `plugin/src/init.server.luau` —
`plugin:SetSetting` não é chamável pelo Command Bar do Studio (`plugin`
global só existe dentro do script do próprio plugin), então não havia como
apontar 2 Studios na mesma máquina/pasta de Plugins para portas diferentes
sem essa UI. Ferramenta de teste, não feature de produto.

## 2026-07-07 — M3.1: split-brain de liderança CONFIRMADO em teste real com 2 Studios (não corrigido)

Primeiro teste real do M3.1 em 2 Studios (userId `9203551752` e `1402101248`,
mesma place, plugin recém-implantado via `rojo build` + cópia para
`%LOCALAPPDATA%\Roblox\Plugins`, ambos recarregando pelo auto-refresh do
Studio ao mesmo tempo, ~12:42:41). Resultado (`logs-livetest/studio1.txt`,
`logs-livetest/studio2.txt`):

- Estudio1 (clientId `f1bd550a...`): `sou o líder agora (term 6)`,
  `joinSequence sequence=8`, às 12:42:43.788.
- Estudio2 (clientId `f4d3cb03...`): `sou o líder agora (term 1)`,
  `joinSequence sequence=0` (depois `sequence=1` de novo 2s depois, mesma
  sessão), às 12:42:43.785.

**Os dois Studios se declararam líder ao mesmo tempo, com termos DIFERENTES
(6 vs 1)** — viola o critério de aceite do M3.1 ("mesmo líder nos dois
lados", `docs/MILESTONES.md`). Confirma em Studio real o achado nº4 da
revisão de código de 2026-07-04 (`docs/PROJECT_STATUS.md`, seção "code
review do M3"): "incremento não-atômico de `LeaderTerm` no cenário de
split-brain". Causa provável: os dois plugins recarregaram
quase-simultaneamente (reload disparado pelo mesmo `cp` do arquivo do
plugin) e cada um leu `LeaderTerm`/`NextJoinSequence` localmente e
incrementou/escreveu antes que a réplica do Team Create do outro lado
chegasse — não há nenhuma forma de compare-and-swap ou re-checagem pós-yield
na eleição atual (`TeamCreateElection.elect`, porte 1:1 do RojoCoop, nunca
exercitado contra essa condição de corrida específica no projeto original
porque lá a liderança era só "shadow", nunca bloqueava escrita de verdade).
`term=6`/`sequence=8` em vez de `1`/`0` no Studio1 indica que
`TestService.SyncTeam` já tinha histórico de uma sessão de teste anterior
(valores persistidos na place) — não é bug em si, só contexto.

**Não corrigido nesta sessão** — log capturado termina em ~12:43:23, sem
uma reconciliação visível (nenhum "líder atual: X" substituindo a auto-
declaração de nenhum dos dois lados nesse trecho). Pendente: (a) pedir mais
logs depois de mais alguns ciclos de pulso para ver se autocorrige sozinho
(a eleição reavalia `LeaderClientId` a cada tick, então pode convergir depois
que o Team Create sincronizar); (b) se não convergir sozinho, é bug real
bloqueante do M3.1 e precisa de fix (candidatos: reler `LeaderTerm` logo
antes de escrever e abortar se mudou — mesmo princípio de "reconfirmar após
yield" já usado em `TeamCreateLease`/`ScriptRegistry`; ou atrasar a primeira
eleição de cada sessão por um valor aleatório pequeno para reduzir chance de
corrida simultânea).

**Achado ambiental, não é bug do SyncTeam**: nenhum dos dois Studios
conseguiu manter conexão WS de verdade — `erro WS 400 HttpError:
ConnectFail` em loop nos dois lados, porque **não havia nenhum processo
escutando `127.0.0.1:34980`** (nem extensão VS Code, nem
`run-node-harness.ts`) no momento do teste — confirmado via `netstat`
(`SYN_SENT`, nunca completou o handshake) e checagem de processos Node
ativos (só processos de outro projeto, nenhum do SyncTeam). Isso significa
que só a eleição de líder pôde ser observada nesse teste — nada de
`writeSource`/lease foi exercitado (precisa da extensão ou do harness
rodando na porta 34980 antes de continuar o roteiro combinado do M3).

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
