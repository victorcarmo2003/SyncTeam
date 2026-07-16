# DockWidgetPluginGui API + Require-by-String (Vide) — 2026-07-15

Pesquisado para a tarefa do painel de status do plugin (M4.5, `ui-dev`),
antes de codar `plugin/src/ui/PluginUI.luau`.

## 1. `DockWidgetPluginGuiInfo.new` / `Plugin:CreateDockWidgetPluginGui`

Nunca usado antes neste projeto (diferente de `plugin:CreateToolbar`/
`CreateButton`, já validados em Studio real desde o M1) — API nova para o
SyncTeam, confirmada contra a documentação oficial antes de depender dela
(`.claude/rules/luau.md`).

- `DockWidgetPluginGuiInfo.new(initialDockState, initialEnabled,
  initialEnabledShouldOverrideRestore, floatingXSize, floatingYSize,
  minWidth, minHeight)` — ordem de parâmetros confirmada via
  https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo:
  1. `Enum.InitialDockState` (ex.: `Right`, `Float`)
  2. `initialEnabled: boolean` — estado inicial a valer SÓ na primeiríssima
     vez que o plugin roda nessa instalação do Studio; depois disso o Studio
     persiste sozinho o último estado enabled/disabled do widget entre
     sessões, independente do que for passado aqui.
  3. `initialEnabledShouldOverrideRestore: boolean` — se true, força o valor
     de `initialEnabled` mesmo em runs subsequentes (ignora a persistência).
     Usado como `false` no SyncTeam (deixa o Studio lembrar se o usuário
     fechou/abriu o painel).
  4. `floatingXSize`/`floatingYSize: number` — tamanho usado quando
     `InitialDockState` é `Float` (ou quando o widget está undocked).
  5. `minWidth`/`minHeight: number`.
- `plugin:CreateDockWidgetPluginGui(pluginGuiId: string, info:
  DockWidgetPluginGuiInfo): DockWidgetPluginGui` — `pluginGuiId` precisa ser
  estável entre versões do plugin (é a chave de persistência do Studio para
  lembrar posição/estado do widget).
- `DockWidgetPluginGui.Enabled: boolean` é uma propriedade normal — aceita
  `GetPropertyChangedSignal("Enabled")` como qualquer outra (não documentado
  explicitamente como exceção em nenhuma fonte consultada; tratado como
  comportamento padrão de propriedade, mesma categoria de confiança que
  `plugin:CreateToolbar`/`CreateButton`, que este projeto já usa sem citar
  pesquisa dedicada).

Fontes:
- https://create.roblox.com/docs/reference/engine/classes/Plugin/CreateDockWidgetPluginGui
- https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo
- https://create.roblox.com/docs/reference/engine/classes/DockWidgetPluginGui

## 2. Require-by-string (relative paths, `@self`) — necessário para a lib Vide

Vide 0.4.1 (`plugin/Packages/_Index/centau_vide@0.4.1/vide/src/*.luau`) usa
`require "./graph"`, `require "@self/src/lib"` etc. internamente (só o
`src/init.luau`, entry point real quando rodando em Roblox, usa
`require(script.lib)`, instance-require tradicional). Precisava confirmar que
o require-by-string com paths relativos e o alias `@self` são suportados em
Studio de produção antes de depender da lib — não só em preview/beta.

- **Confirmado**: "Require-by-String" é feature lançada (não beta) da
  Roblox/Luau, com suporte a paths relativos. O alias `@self` foi habilitado
  "platform-wide" (anúncio de maio de 2025) e continua em manutenção/
  refinamento (menções a atualizações até janeiro de 2026 nos tópicos do
  DevForum) — API estável o suficiente para depender em produto.
- Verificado na prática também via `rojo build`: o `.rbxmx` gerado mantém os
  `require "./graph"` etc. como texto dentro dos `ModuleScript`s (não são
  reescritos pelo Rojo) — é o runtime do Roblox que resolve isso ao executar,
  não o Rojo em build-time.

Fontes:
- https://devforum.roblox.com/t/introducing-require-by-string/3405078
- https://rfcs.luau.org/new-require-by-string-semantics.html
- https://rfcs.luau.org/abstract-module-paths-and-init-dot-luau.html

## Conclusão prática

Seguro depender de Vide 0.4.1 via Wally (`plugin/wally.toml`) e criar o
painel com `DockWidgetPluginGuiInfo`/`CreateDockWidgetPluginGui` — nenhuma das
duas é hipótese não confirmada. Teste real em Studio (abrir o painel de
verdade, ver o require de Vide resolver em runtime) continua pendente — esta
pesquisa só cobre "a API existe e é suportada", não "funciona neste projeto
específico", que é o próximo passo (`rojo build` limpo já confirmado; Studio
real fica para quando o orquestrador testar, mesmo padrão de todo o resto do
M3/M4).
