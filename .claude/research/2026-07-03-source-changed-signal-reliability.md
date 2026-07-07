# GetPropertyChangedSignal("Source") após UpdateSourceAsync: confiável para detectar mudanças de script?

## Pergunta

1. `ScriptEditorService:UpdateSourceAsync` dispara `Changed`/`GetPropertyChangedSignal("Source")` de forma confiável? Há condição documentada (script nunca aberto no editor vs aberto; Drafts/Collaborative Editing) que mude isso?
2. `Workspace.SignalBehavior` (Immediate vs Deferred) explica um timeout de 15s sem o sinal disparar?
3. Existe API mais apropriada que `GetPropertyChangedSignal("Source")` para observar mudanças de código feitas por plugin (`ScriptEditorService`, `DraftsService`, `ChangeHistoryService`, `ScriptDocument`)?
4. Como o Rojo (upstream/RojoCoop) resolve isso — sinal direto, outro evento, ou polling?

Motivada por achado empírico do dia (`spikes/m0_5-local-pipeline/harness/session.log`): `UpdateSourceAsync` retornou sucesso e o conteúdo foi confirmado atualizado por leitura direta, mas `GetPropertyChangedSignal("Source")`/`Changed` nunca disparou no Studio remoto em 15s+, em dois cenários de pipeline (A→B e B→A).

## Resposta objetiva

**Não há nenhuma confirmação oficial de que `UpdateSourceAsync` dispare `Changed`/`GetPropertyChangedSignal("Source")` de forma confiável — e não é esse o mecanismo que o Rojo usa para esse fim.** A documentação oficial só garante que, para script fechado no editor, `UpdateSourceAsync` "aplica a atualização diretamente à propriedade Source" — mas não faz nenhuma promessa sobre o sinal de mudança disparar, nem em Studio local nem, principalmente, no Studio remoto após replicação via Team Create. Múltiplos bugs reportados no DevForum mostram que `UpdateSourceAsync` tem comportamento instável especificamente na combinação "script recém-criado / nunca aberto no editor" + Team Create/Drafts/Live Scripting (a mesma combinação do teste feito hoje), incluindo casos de fonte esvaziada, timeout de sessão e falha silenciosa. **Signal Behavior (Deferred) não explica o caso**: a documentação oficial diz explicitamente que Deferred atrasa a execução até o próximo "resumption point" do engine (input, PreRender, PreAnimation, PreSimulation, PostSimulation, Heartbeat) — nunca "nunca dispara". Um gap de 15s sem disparo nenhum é incompatível com Deferred e aponta para uma falha real de propagação do sinal nesse cenário, não para atraso. **A API "correta" mais próxima é `ScriptEditorService.TextDocumentDidChange`**, mas ela é ligada a `ScriptDocument` (documento do editor) e não há confirmação de que exista/dispare para um script nunca aberto localmente — ou seja, provavelmente não resolve o caso remoto também. **O Rojo (RojoCoop, validado em 2 Studios) evita esse problema por completo: nunca usa `UpdateSourceAsync` para escrever, e nunca depende de `GetPropertyChangedSignal("Source")` isolado para detectar.** Ele escreve `Source` via atribuição direta de propriedade (`descriptor:write(instance, value)`, equivalente a `instance.Source = value`) em `Reconciler/setProperty.lua`, e observa mudanças conectando o evento genérico `instance.Changed` (não `GetPropertyChangedSignal` por-propriedade) em `InstanceMap.lua` — mecanismo idêntico em confiabilidade ao `GetPropertyChangedSignal("Source")`, mas aplicado sobre uma escrita de propriedade "crua", não sobre uma chamada de API assíncrona de editor.

## Detalhes e ressalvas

### 1. `UpdateSourceAsync` — o que a doc oficial garante (e o que não garante)

Fonte: `ScriptEditorService.yaml` (creator-docs), refletindo `create.roblox.com/docs/reference/engine/classes/ScriptEditorService/UpdateSourceAsync`.

- Descrição oficial: a função chama o `callback` passado com o conteúdo antigo do script para calcular o novo conteúdo. **Se o script está aberto no Script Editor**, ela emite um pedido ao editor para atualizar sua fonte (podendo ser rejeitado/reexecutado se `Script.Source` estava desatualizado). **Se o script está fechado**, "a atualização se aplica diretamente à propriedade source".
- `callback` não pode dar yield; se retornar `nil`, a operação é cancelada.
- **Nada na doc oficial menciona `Changed`, `GetPropertyChangedSignal`, replicação via Team Create, ou o caso "script nunca teve editor/`ScriptDocument` aberto em nenhuma máquina"**. É uma lacuna de documentação, não uma garantia.
- A página de `Script.Source` reforça que a propriedade é "protected and discouraged for editing directly" e recomenda `ScriptEditorService:UpdateSourceAsync`/`GetEditorSource` — mas de novo, sem falar do sinal de mudança.

Achados de bugs no DevForum relevantes à combinação "script novo/nunca aberto + Team Create/Drafts", todos **relatado por usuários, com confirmação de reprodução por staff Roblox** (nível de confiança: médio, fórum consistente + staff confirma bug):

- **Drafts mode + script recém-instanciado**: "When Drafts mode is enabled, instantiating a script, setting its source with UpdateSourceAsync, then setting its parent fails" — a fonte fica vazia e a CPU dispara com a propriedade Source "oscilando" rapidamente logo após a chamada. Staff da Roblox (swmaniac) confirmou reprodução e corrigiu em maio/2024, mas só para a ordem "Parent depois de UpdateSourceAsync"; o próprio thread nota que isso quebrava a sincronização do Rojo com Drafts ligado. https://devforum.roblox.com/t/when-drafts-mode-is-enabled-instantiating-a-script-setting-its-source-with-scripteditorserviceupdatesourceasync-then-setting-its-parent-fails/2941974 (acesso 2026-07-03)
- **Live Scripting (evolução de Drafts/Collaborative Editing, baseado em Team Create) + `\r\n`**: `UpdateSourceAsync` falha com "Kicked from Live Scripting Session: Server received illegal atomic operation" quando o callback retorna string com `\r\n`. Staff confirmou e corrigiu. https://devforum.roblox.com/t/when-live-scripting-is-enabled-updatesourceasync-errors-and-fails-to-set-scriptsource-when-callback-returns-string-containing-carriage-returns/2711772 (acesso 2026-07-03)
- **`UpdateSourceAsync` não atualiza quando só a terminação de linha muda** (CRLF↔LF). https://devforum.roblox.com/t/scripteditorserviceupdatesourceasync-does-not-work-when-only-line-ending-changes/3622477 (acesso 2026-07-03, não aprofundado)
- **Strings grandes (~10MB+) em `UpdateSourceAsync` estouram/derrubam a sessão de Team Create** (timeout ~60s); staff confirma limite prático de propriedade de 20MB e recomenda inserir via UI de arquivo Lua em vez de `UpdateSourceAsync` para conteúdo grande. Não é o caso do SyncTeam (scripts normais), mas confirma que `UpdateSourceAsync` tem comportamento frágil especificamente quando combinado com replicação de Team Create. https://devforum.roblox.com/t/long-strings-in-updatesourceasync-times-out-team-create-session/2860252 (acesso 2026-07-03)

**Conclusão da pergunta 1**: não documentado, e o padrão de bugs conhecidos é consistente com "`UpdateSourceAsync` + Team Create + script sem `ScriptDocument` ativo em algum lado é uma combinação sabidamente instável". Isso é compatível com — mas não prova sozinho — o achado empírico do dia.

### 2. Signal Behavior (Immediate vs Deferred) não explica 15s de silêncio total

Fonte: `create.roblox.com/docs/scripting/events/deferred` (creator-docs, `deferred.md`).

- Deferred enfileira o handler para rodar no próximo "resumption point" do engine (entrada de input, `PreRender`, `PreAnimation`, `PreSimulation`, `PostSimulation`, `Heartbeat`) — ou seja, no máximo um frame (~tipicamente <100ms), nunca segundos.
- A doc é explícita: o efeito de Deferred é o handler **rodar depois do esperado, não deixar de rodar**. Não existe caso documentado de Deferred fazer um evento nunca disparar.
- `Workspace.SignalBehavior.Default` hoje equivale a Immediate, mas está migrando para Deferred; templates novos já vêm com Deferred.
- **Conclusão da pergunta 2**: Deferred pode ser descartado como explicação para um timeout de 15s+; se fosse só Deferred, o sinal teria disparado dentro de um frame. O silêncio total aponta para o sinal simplesmente não ter sido emitido pelo engine nesse caminho (script nunca aberto + write via `UpdateSourceAsync` + replicação Team Create), não para atraso de agendamento.

### 3. Alternativas a `GetPropertyChangedSignal("Source")`

Fonte: `ScriptEditorService.yaml` (creator-docs).

- `ScriptEditorService:GetEditorSource(script)` — lê o texto "que o editor mostraria se aberto"; **não é notificação, é polling sob demanda**. Documentado: "não é sempre consistente com `Script.Source`".
- `ScriptEditorService.TextDocumentDidChange(document, changesArray)` — "dispara logo depois que um `ScriptDocument` muda", com PluginSecurity. **Problema para nosso caso**: um `ScriptDocument` normalmente só existe/é populado quando o script está (ou esteve) aberto no editor daquela instância de Studio — a própria doc de `GetEditorSource` distingue "aberto" vs "fechado" precisamente porque no caso fechado não há um documento vivo para consultar. Não encontramos confirmação oficial nem no fórum de que `TextDocumentDidChange` dispare para scripts fechados/nunca abertos, e muito menos para mudanças replicadas de outra máquina via Team Create — ou seja, é provável que essa API sofra da mesma limitação, mas isso é **não verificado**, não descartado.
- `DraftsService` — existe como classe legada (`robloxapi.github.io/ref/class/DraftsService.html`), mas não achamos menção ativa em anúncios recentes; toda a comunicação oficial de 2023-2024 em diante ("Important Script Source Update and New ScriptEditorService APIs", "Script Editor API - Full Release!", "Live Scripting Beta") trata `ScriptEditorService`/`ScriptDocument` como o caminho atual, sugerindo que `DraftsService` foi superado na prática — mas não achamos um aviso formal de depreciação.
- `ChangeHistoryService` — é serviço de undo/redo e waypoints, não de notificação de propriedade; não há indício de que exponha eventos para mudanças replicadas de outros clientes de Team Create. Não recomendado para este caso de uso.
- **Conclusão da pergunta 3**: não existe, na documentação encontrada, uma API claramente desenhada e confirmada para "me avise quando o Source de um script mudou, veio de onde vier (outro plugin, outro Studio via Team Create, script nunca aberto)". `TextDocumentDidChange` é a mais próxima em intenção, mas amarrada ao conceito de documento de editor aberto, o que é exatamente a característica que falta no cenário problemático.

### 4. Como o Rojo/RojoCoop resolve isso (evidência de código)

Arquivos inspecionados: `RojoCoop/rojo-7.7.0-rc.1/plugin/src/InstanceMap.lua`, `ServeSession.lua`, `Reconciler/setProperty.lua`, `ChangeBatcher/`.

- **Escrita**: `Reconciler/setProperty.lua` escreve propriedades — incluindo `Source` — via `descriptor:write(instance, value)` do `RbxDom`, isto é, **atribuição direta de propriedade**, não `ScriptEditorService:UpdateSourceAsync`. Não há nenhuma referência a `ScriptEditorService`, `UpdateSourceAsync` ou `DraftsService` em todo `plugin/src/` (confirmado por grep — zero ocorrências).
- **Observação**: `InstanceMap.lua` conecta, para instâncias genéricas (inclusive `Script`/`LocalScript`/`ModuleScript`), o evento **`instance.Changed:Connect(function(propertyName) ... end)`** (linha 196) — o evento agregado clássico, não `GetPropertyChangedSignal` por propriedade (esse último só é usado para `ValueBase`, onde `Changed` tem semântica diferente). Funcionalmente, `instance.Changed` e `GetPropertyChangedSignal("Source")` compartilham o mesmo mecanismo interno do engine — a diferença de confiabilidade entre eles não é o ponto; o ponto é que **o Rojo nunca testa esse mecanismo contra uma escrita feita via `UpdateSourceAsync`**, porque ele mesmo nunca escreve por ali.
- `ServeSession.lua` usa esse `onInstanceChanged` só para push local→disco (two-way sync opcional, guardado por `TeamCreateCoordinator:observeSourceWrite`) — ou seja, é para captar edição feita pelo usuário no editor do Studio local, não para captar replicação remota de Team Create.
- **Conclusão da pergunta 4**: o Rojo **não faz polling** para Source — usa evento direto (`Changed`) — mas evita o ponto exato onde o SyncTeam tropeçou ao nunca escrever com `UpdateSourceAsync`. Isso é evidência indireta forte de que a rota "escrita crua de propriedade + `Changed`/`GetPropertyChangedSignal`" é o caminho validado (2 Studios reais) e que `UpdateSourceAsync` é a variável nova/não testada nessa equação.

### Recomendação prática para o SyncTeam (síntese própria, não é doc/fórum)

Dado que:
- a escrita de `Source` continua precisando de `UpdateSourceAsync` no caso de coexistir com o editor aberto (evitar corromper a edição do usuário — risco já registrado em `docs/ARCHITECTURE.md`);
- mas o sinal de mudança pós-`UpdateSourceAsync` **não é confiável para replicação remota via Team Create** (achado empírico + ausência de garantia documentada + histórico de bugs correlatos);

o "Plano B" já cogitado em `docs/ARCHITECTURE.md` ("trafegar conteúdo em `StringValue` nos metadados") deveria ser promovido a caminho principal para o **sinal de notificação** (não necessariamente para o conteúdo inteiro, que pode ter limite de tamanho): usar um contador/hash em `TestService.SyncTeam` (ex.: `WriteGeneration` por script, padrão já usado no `TeamCreateCoordinator` do RojoCoop) via `IntValue`/`StringValue`, cujo `GetPropertyChangedSignal("Value")` **é o mecanismo comprovadamente confiável em 2 Studios reais** (linhas 180-192 de `InstanceMap.lua`, e toda a infraestrutura de heartbeat/lease do RojoCoop depende disso). O plugin remoto reagiria ao contador mudando e então leria `Source`/`GetEditorSource` diretamente (pull), em vez de depender do `Changed`/`GetPropertyChangedSignal("Source")` da própria instância do script para saber *que* algo mudou.

## Fontes

- https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService/UpdateSourceAsync (via `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/ScriptEditorService.yaml`, acesso 2026-07-03) — confiança alta (doc oficial)
- https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService (idem, acesso 2026-07-03) — confiança alta
- https://create.roblox.com/docs/scripting/events/deferred (via `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/scripting/events/deferred.md`, acesso 2026-07-03) — confiança alta
- https://create.roblox.com/docs/reference/engine/classes/Script (Source property, via yaml do creator-docs, acesso 2026-07-03) — confiança alta
- https://devforum.roblox.com/t/when-drafts-mode-is-enabled-instantiating-a-script-setting-its-source-with-scripteditorserviceupdatesourceasync-then-setting-its-parent-fails/2941974 (acesso 2026-07-03) — confiança média (bug confirmado por staff Roblox)
- https://devforum.roblox.com/t/when-live-scripting-is-enabled-updatesourceasync-errors-and-fails-to-set-scriptsource-when-callback-returns-string-containing-carriage-returns/2711772 (acesso 2026-07-03) — confiança média
- https://devforum.roblox.com/t/scripteditorserviceupdatesourceasync-does-not-work-when-only-line-ending-changes/3622477 (acesso 2026-07-03, não aprofundado) — confiança baixa/média
- https://devforum.roblox.com/t/long-strings-in-updatesourceasync-times-out-team-create-session/2860252 (acesso 2026-07-03) — confiança média (staff confirma limite de 20MB)
- https://devforum.roblox.com/t/important-script-source-update-and-new-scripteditorservice-apis/2628171 (acesso 2026-07-03) — confiança alta (anúncio oficial Roblox)
- https://devforum.roblox.com/t/live-scripting-beta/2640607 (acesso 2026-07-03) — confiança alta (anúncio oficial Roblox)
- https://devforum.roblox.com/t/script-editor-api-full-release/2032451 (acesso 2026-07-03) — confiança alta (anúncio oficial), mas não cobre detecção de mudança
- https://devforum.roblox.com/t/how-to-edit-script-code-with-plugin/3127421 (acesso 2026-07-03) — confiança baixa (thread de suporte, respostas de usuários)
- https://devforum.roblox.com/t/feedback-on-scripteditorserviceupdatesourceasync/4581021 (acesso 2026-07-03) — irrelevante ao problema (só feedback de doc), citado para registro
- Código-fonte local: `c:/Users/hakor/Documents/GitHub/RojoCoop/rojo-7.7.0-rc.1/plugin/src/InstanceMap.lua`, `ServeSession.lua`, `Reconciler/setProperty.lua` (acesso 2026-07-03) — confiança alta (evidência direta de código, validado em 2 Studios reais por decisão de projeto registrada em `CLAUDE.md`)
- Log empírico próprio: `c:/Users/hakor/Documents/GitHub/SyncTeam/spikes/m0_5-local-pipeline/harness/session.log` (2026-07-03, linhas 464-473 e 489-490) — confiança alta (teste real, reproduzido 2x na mesma sessão)

## Confiança geral

**Média-alta**: as garantias oficiais sobre o que `UpdateSourceAsync` faz são claras e de fonte primária, mas a ausência de garantia sobre o sinal de mudança é uma lacuna documental, não uma negação explícita. A conclusão de que o sinal é pouco confiável nesse cenário combina doc oficial (o que não é garantido) + padrão consistente de bugs de terceiros na mesma combinação de fatores (script novo/fechado + Team Create/Drafts/Live Scripting) + evidência direta de código do Rojo evitando o problema por completo + teste empírico próprio reproduzido 2x. Nenhuma fonte nega diretamente a possibilidade de o sinal disparar em outras condições (ex.: script já aberto no editor remoto) — isso continua sendo `[Hipótese]` a testar separadamente.
