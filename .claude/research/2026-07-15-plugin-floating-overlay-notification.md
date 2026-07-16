# Popup/overlay flutuante livre em plugin de Roblox Studio (CoreGui vs DockWidgetPluginGui) — 2026-07-15

## Pergunta

O toast de notificação do SyncTeam foi implementado como um Frame dentro do
mesmo `DockWidgetPluginGui` do painel de status, sob a premissa de que
"plugin de Roblox Studio só tem DockWidgetPluginGui como superfície de UI".
O usuário questionou citando o plugin real do Rojo, que mostra um popup
flutuante com botão de fechar que some sozinho. Perguntas:

1. É possível, de dentro de um plugin (Luau, categoria igual à nossa),
   criar UI que flutue LIVREMENTE sobre a janela inteira do Studio (não
   confinada a um `DockWidgetPluginGui` docked/float)?
2. Se sim: qual o mecanismo exato (serviço/classe/propriedade)? Limitações
   (preview/beta, capability restrita)?
3. Como o Rojo real implementa isso — overlay livre de verdade, ou
   `DockWidgetPluginGui` bem estilizado (parecendo popup solto)?
4. `DockWidgetPluginGuiInfo` com `Enum.InitialDockState.Float` é alternativa
   realista para um popup pequeno que soma sozinho?

## Resposta objetiva

**Existe um caminho real, documentado oficialmente e usado pelo Rojo de
verdade: parentar um `ScreenGui` direto em `game:GetService("CoreGui")` a
partir do código do plugin.** Não é hack — a doc oficial da classe `CoreGui`
diz explicitamente que o serviço "pode também ser usado por Plugins no
Roblox Studio". Confirmei no código-fonte público do Rojo
(`rojo-rbx/rojo`, branch `master`) que é exatamente isso que ele faz: o
painel principal (docked) continua sendo um `DockWidgetPluginGui" de
verdade, mas as notificações/toasts são um `ScreenGui` **separado, irmão**
desse widget na árvore de componentes, e a árvore inteira (painel +
ScreenGui de notificação) é montada com
`Roact.mount(app, game:GetService("CoreGui"), "Rojo UI")`. Ou seja: **não é
DockWidgetPluginGui disfarçado — é overlay livre de verdade**, via CoreGui.

`DockWidgetPluginGuiInfo` com `InitialDockState.Float` é real e documentado,
mas **não produz um popup sem bordas**: o widget flutuante sempre tem
cabeçalho/bordas nativos do Studio (confirmado por bug relatado e
reconhecido por staff Roblox), e sua posição só é livre na primeiríssima
vez — depois o Studio persiste posição/estado entre sessões. Não é o
caminho usado pelo Rojo para o popup, e não serve para replicar o efeito
"toast que desliza e some sozinho, sem chrome de janela".

## Detalhes e ressalvas

### 1) CoreGui é oficialmente suportado por plugins

Doc oficial (`CoreGui.yaml` do repo `Roblox/creator-docs`, espelho de
`create.roblox.com/docs/reference/engine/classes/CoreGui`), citação
literal:

> "The CoreGui is a service used to store Guis created in-game by Roblox
> for the core user interface found in every game (such as the game menu,
> the playerlist, the backpack, etc.). It can also be used by
> `Class.Plugin|Plugins` in Roblox Studio."

Mecanismo: `game:GetService("CoreGui")` a partir de um script de plugin
(mesmo `plugin/src/init.server.luau`/módulos requeridos por ele), depois
`someScreenGui.Parent = coreGui` (ou `Instance.new("ScreenGui", coreGui)`).
`CoreGui` é `RobloxLocked` (só aceita reparent/set de propriedades de
threads com capability `Plugin`), mas **scripts de plugin já rodam com essa
capability automaticamente** — não é preciso nenhum opt-in de manifest
extra além de ser mesmo um plugin instalado/carregado (mesma categoria de
capability que já usamos para `plugin:CreateToolbar`/`CreateButton`).
Confirmado via threads do DevForum sobre o erro "lacking capability Plugin"
ao tentar indexar/parentar em objetos `RobloxLocked` de fora de um plugin.

### 2) Como o Rojo real faz (confirmado no código-fonte público)

Acessei o repositório `rojo-rbx/rojo` via GitHub Contents API
(`api.github.com/repos/rojo-rbx/rojo/contents/<path>`, que retorna
`download_url` para o `raw.githubusercontent.com` correspondente — a
página HTML normal do GitHub é resumida/truncada pelo WebFetch, a API de
conteúdo não).

- `plugin/src/App/init.lua` — trecho relevante da árvore de render:

  ```lua
  e(Theme.StudioProvider, nil, {
      tooltip = e(Tooltip.Provider, nil, {
          gui = e(StudioPluginGui, {
              -- ...título, ícone, initDockState = Enum.InitialDockState.Right...
          }, { --[[ páginas do painel principal ]] }),

          RojoNotifications = e("ScreenGui", {
              ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
              ResetOnSpawn = false,
              DisplayOrder = 100,
          }, {
              Notifications = e(Notifications, { --[[ ... ]] }),
          }),
      }),
  })
  ```

  `gui` (o `StudioPluginGui`, que por baixo dos panos chama
  `plugin:CreateDockWidgetPluginGui`) e `RojoNotifications` (o `ScreenGui`
  de toasts) são **irmãos** na árvore — o `ScreenGui` de notificação não é
  filho do widget docked.

- `plugin/src/init.server.lua` — onde a árvore inteira é efetivamente
  parentada:

  ```lua
  local tree = Roact.mount(app, game:GetService("CoreGui"), "Rojo UI")
  ```

  Ou seja, tanto o painel docked quanto o `ScreenGui` de notificações são
  montados dentro de `CoreGui`; é o próprio componente `StudioPluginGui`
  que, internamente, cria a Instance `DockWidgetPluginGui` de verdade via
  `plugin:CreateDockWidgetPluginGui` (não é `CoreGui` criando o widget
  docked — CoreGui é só o "root" da árvore Roact/React; o widget docked
  em si é uma Instance separada gerenciada pelo Studio). O `ScreenGui` de
  notificação, ao contrário, fica direto dentro de `CoreGui`, sem passar
  por nenhum widget.

- `plugin/src/App/Components/Notifications/` existe como diretório
  dedicado (listado via Contents API) — os toasts individuais (texto,
  timeout, botão de ação, callback) são renderizados dentro desse
  `ScreenGui`, com `addNotification` guardando estado com timeout
  configurável.

**Conclusão do item 3 da pergunta original**: o popup do Rojo NÃO é um
`DockWidgetPluginGui` estilizado para parecer solto — é um `ScreenGui`
solto de verdade, parentado em `CoreGui`, que é a mesma técnica antiga
usada por plugins antes do `DockWidgetPluginGui` existir (`f3x` e outros
plugins clássicos usavam só `CoreGui`).

### 3) Ressalva importante: escopo visual do overlay via CoreGui

Não encontrei uma frase oficial única e explícita dizendo "CoreGui no
Studio só renderiza sobre o viewport 3D, não sobre os painéis nativos
(Explorer/Properties/Output/barra de menu)". Isso **não está confirmado
como documentado** — é inferência consistente entre fontes, não fonte
única confirmando:

- A arquitetura conhecida do Studio: Explorer/Properties/Output/menu são
  painéis nativos Qt fora da superfície onde o DataModel (Workspace +
  PlayerGui/CoreGui) é renderizado; CoreGui só compõe sobre essa
  superfície de render (o "viewport"/aba de jogo), não sobre o restante da
  janela do Studio (mesmo raciocínio que explica por que um
  `DockWidgetPluginGui` continua existindo como conceito — para UI que
  precisa aparecer fora do viewport).
- O próprio comportamento relatado do Rojo: sua notificação de
  "sync reminder" é descrita, no uso real relatado pela comunidade, como
  aparecendo posicionada dentro do viewport (não flutuando sobre o
  Explorer ou outros painéis).

**Recomendação**: tratar como `[Hipótese]` até teste real — abrir o plugin
Rojo de verdade (ou nosso protótipo) e verificar visualmente se o toast
aparece por cima do Explorer/Properties quando esses estão focados/lado a
lado, ou só dentro da área do viewport 3D. Isso não muda a resposta central
(CoreGui é overlay livre de verdade, não confinado a bordas de widget), só
o alcance exato da área coberta.

### 4) `DockWidgetPluginGuiInfo` / `InitialDockState.Float` — não é a mesma coisa

Real e documentado
(`create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo`,
já registrado em
`.claude/research/2026-07-15-dockwidgetplugingui-and-require-by-string.md`),
mas tem limitações que o desqualificam para "popup pequeno que aparece e
some sozinho, sem chrome de janela":

- **Sempre tem cabeçalho/bordas nativos**, mesmo flutuando — confirmado
  por bug relatado e reconhecido por staff Roblox
  (`thirdtakeonit`, DevForum, ago/2023): o bug original era
  `FloatingXSize`/`FloatingYSize` não fazerem efeito nenhum; depois de
  "corrigido" (out/2023), o efeito colateral relatado é que esses valores
  **incluem cabeçalho e bordas do widget** no cálculo de tamanho (ex.:
  pedido (300,400), `AbsoluteSize` real (298,276)) — ou seja, mesmo
  corrigido, o resultado sempre tem chrome nativo, nunca é borderless.
- **Posição só é livre na primeira vez**: `initialEnabled` e o estado geral
  do widget (incluindo, presumivelmente, posição ao flutuar) são
  persistidos pelo Studio entre sessões via o `pluginGuiId` estável passado
  a `CreateDockWidgetPluginGui` — não dá para forçar sempre a mesma posição
  "flutuando no canto" a cada notificação, é o Studio quem manda depois da
  primeira vez.
- Rojo usa `Float`/`Right` só para o **painel principal** (docked por
  padrão, `Enum.InitialDockState.Right` no código-fonte real), nunca para
  as notificações — reforça que Float não é o mecanismo usado para o efeito
  "popup solto".

## Conclusão prática (recomendação para o SyncTeam)

Trocar a implementação atual (Frame dentro do `DockWidgetPluginGui`) por um
`ScreenGui` próprio, criado pelo plugin e parentado direto em
`game:GetService("CoreGui")`, contendo o Frame do toast (desliza da
direita, botão fechar, timeout) — replicando exatamente o padrão do Rojo:
painel de status continua `DockWidgetPluginGui` (sem mudança), toast vira
`ScreenGui` irmão em `CoreGui`. Não precisa de nenhuma API nova/beta, nem
permissão de manifest adicional (capability `Plugin` já é automática em
código de plugin). Ressalva a validar com teste real: confirmar se o toast
aparece só sobre o viewport 3D ou também sobre outros painéis quando
maximizados/lado a lado (ponto 3 acima, sem fonte oficial explícita).

## Fontes (acesso 2026-07-15)

- https://create.roblox.com/docs/reference/engine/classes/CoreGui (espelho
  usado: `raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/CoreGui.yaml`)
  — doc oficial, confirma uso de CoreGui por Plugins.
- https://github.com/rojo-rbx/rojo/blob/master/plugin/src/App/init.lua
  (via `api.github.com/repos/rojo-rbx/rojo/contents/plugin/src/App/init.lua`
  → `raw.githubusercontent.com/rojo-rbx/rojo/master/plugin/src/App/init.lua`)
  — código-fonte real mostrando `ScreenGui` de notificações como irmão do
  `StudioPluginGui`.
- https://github.com/rojo-rbx/rojo/blob/master/plugin/src/init.server.lua
  — `Roact.mount(app, game:GetService("CoreGui"), "Rojo UI")`.
- https://github.com/rojo-rbx/rojo/tree/master/plugin/src/App/Components
  (Contents API) — confirma diretório `Notifications` dedicado.
- https://create.roblox.com/docs/reference/engine/datatypes/DockWidgetPluginGuiInfo
  — parâmetros de `Float`, `FloatingXSize`/`FloatingYSize`.
- https://devforum.roblox.com/t/floatingxsize-and-floatingysize-from-dockwidgetpluginguiinfo-do-not-work/2508304
  — bug reconhecido por staff Roblox: tamanho floating inclui
  cabeçalho/bordas nativos.
- https://devforum.roblox.com/t/should-i-use-coregui-or-dockwidgetplugingui-for-my-plugins/3081028
  — discussão de comunidade CoreGui vs DockWidgetPluginGui (cita Rojo como
  usuário de DockWidgetPluginGui para o painel principal).
- https://devforum.roblox.com/t/the-current-thread-cannot-access-lacking-capability-plugin/2768839
  e
  https://devforum.roblox.com/t/new-facial-tracking-causing-the-current-thread-cannot-access-instance-lacking-capability-plugin/2499007
  — confirmam que `CoreGui`/objetos `RobloxLocked` exigem capability
  `Plugin`, presente automaticamente em scripts de plugin.
- https://devforum.roblox.com/t/how-do-i-make-a-plugins-ui-pop-out-ex-rojo-plugin-interface/881605
  — thread de comunidade sobre o mesmo problema, sem resposta staff
  definitiva (só contexto de que a dúvida é comum; não usada como fonte de
  confirmação técnica).

## Confiança

- **Alta** — CoreGui é utilizável por plugins (doc oficial) e é o mecanismo
  real usado pelo Rojo para seu popup (código-fonte público confirmado
  diretamente).
- **Alta** — `DockWidgetPluginGui`/`Float` sempre tem chrome nativo
  (cabeçalho/bordas), não é borderless (bug + reconhecimento de staff).
- **Média** — escopo exato do overlay via CoreGui em Studio (só sobre o
  viewport 3D, não sobre outros painéis nativos): inferência consistente,
  sem fonte oficial única e explícita; recomendo validar com teste real
  antes de assumir como garantido.
