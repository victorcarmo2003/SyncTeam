# Memória do researcher

Fontes e atalhos úteis descobertos nas pesquisas. Atualize ao final de cada
tarefa; mantenha curto e acionável.

## Atalhos de fonte

- `create.roblox.com/docs/...` costuma ser renderizado por JS — WebFetch direto
  na página falha (só pega nav/metadata). **Solução**: buscar o `.yaml`/`.md`
  correspondente em `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/...`
  (mesmo caminho da URL, trocando `create.roblox.com/docs` por
  `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us`, e a
  extensão por `.yaml` para páginas de classe/`reference/engine/classes/*` ou
  `.md` para artigos em `scripting/...`). Funciona bem e traz o texto completo.
- `ScriptEditorService.yaml` nesse repo tem a doc completa de
  `UpdateSourceAsync`, `GetEditorSource`, `TextDocumentDidChange`.
- `Instance.yaml` tem a doc oficial de `Destroy()`/`Parent`/`Destroying` —
  útil como base para qualquer pergunta de "como detectar que uma Instance
  foi destruída".
- `scripting/events/deferred.md` explica Immediate vs Deferred
  (`Workspace.SignalBehavior`): Deferred só atrasa até o próximo resumption
  point (input/PreRender/PreAnimation/PreSimulation/PostSimulation/Heartbeat),
  nunca faz um evento deixar de disparar — útil para descartar Deferred como
  causa de timeouts longos (segundos) em sinais que não disparam.
- `reference/engine/classes/WebStreamClient.yaml` e
  `reference/engine/enums/WebStreamClientState.yaml` (mesmo atalho raw acima)
  têm a doc completa e verbatim dos eventos `Opened`/`MessageReceived`/
  `Error`/`Closed` de `HttpService:CreateWebStreamClient` — útil pra
  qualquer pergunta futura sobre esse objeto (retorno de `CreateWebStreamClient`
  é a classe `WebStreamClient`). Achado central (ver
  `.claude/research/2026-07-15-webstreamclient-close-code.md`): `Closed()`
  não tem NENHUM parâmetro (`parameters: []` no YAML) — sem close code, sem
  reason string; `Error(responseStatusCode: int, errorMessage: string)`
  existe mas `responseStatusCode` é documentado como **HTTP status code**
  (ex. 404, 500), não close code de protocolo WS (RFC 6455, ex. 1013) — API
  não expõe close code/reason de fechamento de WebSocket hoje, ponto
  reforçado por feature request aberto e sem resposta no DevForum
  (`t/send-and-receive-close-codes-for-websockets/4240741`, jan/2026, 0
  replies confirmado via `.json` do Discourse). `HttpService.yaml` (mesmo
  atalho) confirma limite oficial de "six total clients" para
  `CreateWebStreamClient` — bate com o que já está em `.claude/rules/luau.md`.
- DevForum: buscar por `"UpdateSourceAsync" site:devforum.roblox.com` via
  WebSearch encontra vários bugs conhecidos (Drafts mode + script recém-criado,
  Live Scripting + CRLF, strings grandes estourando Team Create). Padrão:
  `UpdateSourceAsync` é historicamente instável quando combinado com
  Team Create/Drafts/Live Scripting e scripts nunca abertos no editor.
- **Threads do DevForum (Discourse) têm endpoint JSON**: adicionar `.json` à
  URL do tópico (ex.: `devforum.roblox.com/t/<slug>/<id>.json`) e dar
  WebFetch nele retorna todos os posts/replies estruturados (autor, data,
  texto), o que ajuda a confirmar rápido se um post tem resposta de staff ou
  ficou sem resposta nenhuma (sinal de "lacuna real", não só "não achei a
  thread certa") — usado em
  `.claude/research/2026-07-15-webstreamclient-close-code.md` pra confirmar
  que um feature request de jan/2026 sobre close codes segue com 0 replies.
- `RojoCoop/rojo-7.7.0-rc.1/plugin/src/` é útil como "código de referência
  validado" para comparar com o que a doc oficial promete. Ex.: grep por
  `UpdateSourceAsync|ScriptEditorService|GetPropertyChangedSignal` mostrou que
  o Rojo **nunca usa `UpdateSourceAsync`** — escreve `Source` via
  `Reconciler/setProperty.lua` (atribuição direta de propriedade) e observa
  mudanças via `instance.Changed` genérico em `InstanceMap.lua` (não
  `GetPropertyChangedSignal` por-propriedade, exceto para `ValueBase`).
  **Cuidado**: os testes desse repo usam MOCK de Roblox — não confiar em
  comportamento de mock (ex.: `TeamCreateCoordinator.spec.lua:374-381` mocka
  `ObjectValue.Value` virando `nil` em Destroy, o que o engine real **não**
  faz — ver seção abaixo). Testes com mock validam lógica interna do plugin,
  nunca a premissa sobre comportamento da API real.
- **Para navegar em repositório PÚBLICO no GitHub (ex.: Rojo real,
  `rojo-rbx/rojo`, ou Wally `UpliftGames/wally`), a página HTML normal
  (`github.com/.../tree/...` ou `blob/...`) é resumida/truncada pelo WebFetch
  — não dá pra confiar em listagem completa.** Atalho confiável:
  `api.github.com/repos/<owner>/<repo>/contents/<path>` (JSON com lista de
  arquivos/pastas e campo `download_url` de cada arquivo, que aponta pro
  `raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` correspondente).
  Fluxo: listar diretório via Contents API → pegar `download_url` do arquivo
  desejado → WebFetch nesse raw URL para o conteúdo completo (funciona bem
  até para ler literalmente uma função Rust específica, pedindo no prompt do
  WebFetch pra citar o trecho verbatim). Usado para achar como o Rojo real
  implementa seus popups de notificação (ver
  `.claude/research/2026-07-15-plugin-floating-overlay-notification.md`) e
  para confirmar o comportamento de `wally install` lendo
  `src/installation.rs`/`src/commands/install.rs` direto do repo
  (`.claude/research/2026-07-16-wally-packages-manual-module.md`).

## Roblox Studio: contas, Team Create e testes solo

- `en.help.roblox.com/...` bloqueia WebFetch direto (HTTP 403), diferente de
  `create.roblox.com/docs`. Não existe atalho tipo raw.githubusercontent para
  esse domínio (não é um repo público). Único jeito que funcionou: WebSearch
  com trecho entre aspas do título do artigo + termo específico — os
  resultados de busca do Claude costumam trazer resumo/citações literais do
  conteúdo mesmo sem conseguir abrir a página.
- **Studio suporta múltiplas contas simultâneas nativamente**: clicar no nome
  de usuário (canto superior direito) > "Add Account" abre uma NOVA
  instância/processo de Studio já logada com outra conta, mantendo a janela
  antiga aberta com a conta original — tudo sob o MESMO perfil de usuário do
  Windows (não precisa Fast User Switching nem VM). Fonte oficial: anúncio
  "Introducing Seamless Account Switching on Roblox"
  (devforum.roblox.com/t/2703821) + thread "Switch Users in Studio"
  (devforum.roblox.com/t/1159640, staff confirmou implementação). O cookie de
  login fica em `HKEY_CURRENT_USER\SOFTWARE\Roblox\RobloxStudioBrowser\roblox.com`
  (por perfil de Windows, não por processo) — mas isso não impede múltiplas
  contas simultâneas porque cada instância parece autenticar/guardar a sessão
  em memória no momento em que abre. Ver
  `.claude/research/2026-07-03-dois-studios-mesma-maquina.md` para o
  passo a passo completo.
- **A MESMA conta não pode entrar 2x na mesma sessão de Team Create** — uma
  das duas é bloqueada/expulsa. Confirmado por relatos no DevForum; existe
  feature request em aberto (não implementado) pedindo suporte a isso
  (devforum.roblox.com/t/allow-multiple-team-create-sessions-from-the-same-account/3408211).
- **Mudança recente e importante (rollout maio-jun/2026, ainda válida em
  jul/2026)**: Team Create agora exige Age Check (estimativa facial ou ID) do
  DONO e de CADA colaborador antes de colaborar juntos, e as contas precisam
  estar em "grupos de idade" compatíveis (ou virar "Trusted Friends"/ter
  permissão parental se não). Isso vale até para uma conta nova criada só
  pra teste — sem Age Check nela, ela é barrada ao tentar entrar no Team
  Create, o que pode parecer bug de plugin/rede sem ser. Fonte oficial:
  devforum.roblox.com/t/age-requirements-for-team-create-in-studio/4539725 e
  en.help.roblox.com/hc/en-us/articles/45500519296532 (datas: age check
  obrigatório a partir de 11/jun/2026, restrição de grupo de idade cruzada a
  partir de 25/jun/2026).
- "Team Test" (Test tab > Clients/Servers) é para testar GAMEPLAY com
  `Player`s simulados, não serve para testar colaboração de EDIÇÃO via Team
  Create entre duas identidades reais — são features diferentes, não
  confundir ao responder perguntas sobre "testar Team Create sozinho".

## Achados que podem ser reaproveitados

- `GetPropertyChangedSignal("Source")`/`Changed` após
  `ScriptEditorService:UpdateSourceAsync` **não tem garantia documentada** de
  disparar, especialmente para script nunca aberto no editor + replicado via
  Team Create. Ver `.claude/research/2026-07-03-source-changed-signal-reliability.md`.
  Recomendação registrada lá: usar contador/hash em `TestService.SyncTeam`
  (`IntValue`/`StringValue`, sinal comprovadamente confiável) como notificação
  de "algo mudou, vá ler", em vez de confiar no `Changed` da instância do
  script em si.
- **`ObjectValue.Value` NÃO vira `nil` automaticamente quando a Instance
  referenciada é destruída via `:Destroy()`** — confirmado como "intended
  behavior" por staff em múltiplos threads do DevForum (não documentado
  explicitamente na doc oficial, mas consistente com a recomendação oficial
  de `Instance.Destroy()` de zerar variáveis manualmente). `ObjectValue.Changed`
  **também não dispara** quando o valor referenciado é destruído (só dispara
  ao reatribuir `Value` para outra coisa). Detecção robusta de "destruído":
  `instance.Parent == nil` (necessário, não suficiente — Parent nil também
  ocorre em Instance só temporariamente desparentada) **+** `pcall` tentando
  reatribuir `instance.Parent = instance.Parent` (falha = destruída de
  verdade, porque `Destroy()` trava `Parent` — essa trava é documentada
  oficialmente). `Instance.Destroying` existe e é documentado mas tem
  múltiplos relatos de disparo inconsistente no DevForum (cascata de
  destruição, timing) — nunca usar como único caminho, só fast-path, igual ao
  padrão já adotado para `Source.Changed`. Comportamento sob replicação
  remota via Team Create (dois Studios) **não encontrado** em doc nem
  DevForum — é lacuna, tratar como hipótese e testar com dois Studios reais.
  Detalhe completo, threads e tabela de pegadinhas em
  `.claude/research/2026-07-04-objectvalue-destroy-detection.md`.
- **UI de plugin NÃO é limitada a `DockWidgetPluginGui`.** `CoreGui`
  (`game:GetService("CoreGui")`) é oficialmente utilizável por plugins
  ("It can also be used by Plugins in Roblox Studio", doc oficial da classe
  `CoreGui`) — dá pra parentar um `ScreenGui` direto nele pra um overlay
  livre de verdade (sem chrome de widget docked/float), sem precisar de
  permissão de manifest extra (capability `Plugin` já vem de graça em código
  de plugin). **Confirmado no código-fonte público do Rojo real**
  (`rojo-rbx/rojo`, `plugin/src/init.server.lua`:
  `Roact.mount(app, game:GetService("CoreGui"), "Rojo UI")`) que é assim que
  ele implementa o popup de notificação: painel principal continua
  `DockWidgetPluginGui` (via `StudioPluginGui`), mas o toast é um `ScreenGui`
  **irmão** dele na árvore, parentado em `CoreGui` — não é widget disfarçado.
  Ressalva sem confirmação oficial explícita: overlay via CoreGui em Studio
  provavelmente só cobre a área do viewport 3D, não os painéis nativos
  (Explorer/Properties/Output) — inferência, não fonte única confirmando,
  validar com teste real. `DockWidgetPluginGuiInfo`/`InitialDockState.Float`
  sempre tem cabeçalho/bordas nativos mesmo flutuando (bug reconhecido por
  staff Roblox: FloatingXSize/FloatingYSize incluem chrome do widget no
  cálculo) — não serve pra popup borderless. Detalhe completo em
  `.claude/research/2026-07-15-plugin-floating-overlay-notification.md`.
- **`HttpService:CreateWebStreamClient` (`WebStreamClient`) não expõe close
  code nem reason string de WebSocket em NENHUM evento documentado.**
  `Closed()` não tem parâmetro nenhum; `Error(responseStatusCode: int,
  errorMessage: string)` existe, mas `responseStatusCode` é status HTTP
  (404/500), não close code de protocolo WS (1000-1015, ou 1013 do caso do
  SyncTeam). Feature request pedindo isso está aberto no DevForum desde
  jan/2026 sem resposta. Portanto: heurística por comportamento (tempo +
  ausência de mensagem antes de cair), não parsing de close code, é o único
  caminho hoje para o plugin inferir "rejeitado de propósito" vs "erro
  genérico". Detalhe completo em
  `.claude/research/2026-07-15-webstreamclient-close-code.md`.
- **`wally install` apaga a pasta de destino INTEIRA (`Packages/`,
  `ServerPackages/`, `DevPackages/`) via `fs::remove_dir_all` a cada
  execução, incondicionalmente** — sem diff seletivo, sem preservar arquivos
  manuais/não gerenciados. Confirmado lendo o código-fonte real
  (`src/installation.rs`, função `clean()`, chamada em
  `src/commands/install.rs` antes de `install()`). O campo `exclude` do
  `wally.toml` é para outra coisa (controla o que entra no pacote quando
  VOCÊ publica, não protege `Packages/` local). Não existe flag de CLI nem
  opção de manifesto para excluir um subcaminho desse apagamento; Wally
  também não documenta dependência tipo "path"/local (só registry e git).
  Conclusão: qualquer módulo manual precisa ficar FORA de
  `Packages/`/`ServerPackages/`/`DevPackages/` (pasta irmã própria, mapeada
  separadamente no `default.project.json` do Rojo) — colocá-lo dentro é
  destruído na próxima `wally install`. Detalhe completo em
  `.claude/research/2026-07-16-wally-packages-manual-module.md`.
