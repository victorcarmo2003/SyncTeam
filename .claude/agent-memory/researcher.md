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
- DevForum: buscar por `"UpdateSourceAsync" site:devforum.roblox.com` via
  WebSearch encontra vários bugs conhecidos (Drafts mode + script recém-criado,
  Live Scripting + CRLF, strings grandes estourando Team Create). Padrão:
  `UpdateSourceAsync` é historicamente instável quando combinado com
  Team Create/Drafts/Live Scripting e scripts nunca abertos no editor.
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
