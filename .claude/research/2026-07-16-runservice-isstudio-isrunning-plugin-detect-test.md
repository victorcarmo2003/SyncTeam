# RunService:IsStudio() vs IsRunning()/IsEdit() — detectar F8 Run / Play dentro do Studio

## Pergunta

O plugin SyncTeam (`plugin/src/init.server.luau`) precisa parar sua lógica de
sync quando o dev inicia um teste (F8 Run ou F5 Play) dentro do Studio, e só
ficar ativo durante edição normal do Team Create. `RunService:IsStudio()`
serve para essa distinção, como o usuário sugeriu? Ou existe API diferente?

## Resposta objetiva

**`RunService:IsStudio()` NÃO serve para essa distinção — é true tanto em
Edição quanto durante Play/Run dentro do Studio** (a suspeita do usuário
estava correta: ele fica `true` o tempo todo dentro do processo do Studio).
A API certa é **`RunService:IsRunning()`** (ou seu inverso, `IsEdit()`):
edição normal = `IsRunning() == false` (`IsEdit() == true`); F8 Run e F5 Play
= `IsRunning() == true` (`IsEdit() == false`). Ambas documentadas oficialmente
como inversas entre si (exceto quando a simulação está pausada, caso em que
as duas retornam `false`). Padrão recomendado e usado na prática por devs:
`local emEdicaoNormal = RunService:IsStudio() and not RunService:IsRunning()`.

## Detalhes e ressalvas

- **`IsStudio()`** (doc oficial, `RunService.yaml`): "This method returns
  whether the current environment is running in Studio. It can be used to
  wrap code that should only execute when testing in Studio." Não distingue
  Edição de Play/Run — é `true` em ambos, contanto que rodando dentro do
  processo do Studio.
  - Confirmado por relato de dev no DevForum (thread sobre bug do
    `IsRunMode`, ver fontes): `IsStudio() == true` apareceu nos três cenários
    testados (Run, Play Here, Play).
  - **Único caso em que `IsStudio()` retorna `false` dentro de um fluxo
    iniciado do Studio: o SERVIDOR de Team Test** (Test tab > Clients/
    Servers). Staff da Roblox (`tnavarts`) confirmou que isso não é bug:
    "The test server you connect to when using Team Test is in no way a
    Studio session. It's a normal live server running the place, and does
    not have any of the Studio-only functionality that a Studio session
    would." O CLIENTE de Team Test, porém, continua com `IsStudio() == true`.
    Não é o caso relevante para o SyncTeam (plugin roda em contexto de
    plugin/Studio, não em servidor de Team Test), mas vale saber que existe
    essa exceção documentada de comportamento.

- **`IsRunning()`** (doc oficial): "Returns whether the experience is
  currently running. `IsRunning()` will always return the inverse of
  `IsEdit()` except when the simulation has been paused, in which case both
  methods will return `false`."
- **`IsEdit()`** (doc oficial): "This method returns whether the current
  environment is in 'edit' mode, for example in Studio when the experience
  is not running. `IsEdit()` will return the inverse of `IsRunning()`."
  - Nota de descoberta de outro dev no DevForum: `IsEdit()` não aparece na
    lista padrão de membros da doc/wiki sem clicar em "Show Hidden Members" —
    checar se a IDE/linter do projeto reconhece `IsEdit` sem reclamar; se
    houver dúvida, usar `not RunService:IsRunning()` (equivalente, sem essa
    pegadinha de visibilidade).
  - Ressalva: as duas só divergem quando a simulação está PAUSADA (botão de
    pause durante um Run/Play) — nesse caso ambas retornam `false`
    simultaneamente. Para o caso de uso do SyncTeam (decidir se deve ligar
    sync), isso significa: se quiser tratar "pausado" como "ainda em teste,
    não voltar a sincronizar", prefira checar `IsRunning()` (fica `false` no
    pause, então sozinho não bastaria) — se precisar tratar pause como
    "ainda em teste", é mais seguro também monitorar os eventos de
    `Selection`/`Plugin` de início/fim de sessão de teste
    (`Plugin:GetStudioUserId` não relevante aqui; considerar
    `game:GetService("RunService").Stepped`/eventos de plugin como
    `Plugin.Unloading` não cobrem isso — se pausar for um caso real a
    tratar, validar com teste manual: apertar Pause durante Play e ver se
    `IsRunning()` cai para `false` enquanto o teste ainda está "ativo" na
    tela).
  - Padrão comprovado usado por devs em plugins reais (thread "Plugin How Do
    I Prevent it running, when Testing a game in studio", resposta aceita de
    `Corecii`): usar `IsEdit()` diretamente para decidir se o plugin deve
    rodar; `IsRunning()` é equivalente com sinal invertido.

- **Fórum não documenta explicitamente comportamento durante "pause" com
  exemplo de plugin real** — é derivado só da doc oficial da API
  (`IsRunning`/`IsEdit` ambos `false` quando pausado). Se o SyncTeam decidir
  que pause também deve manter o sync desligado, vale um teste manual rápido
  (apertar Play, depois Pause, logar `IsRunning()`/`IsEdit()` no Output) antes
  de assumir.

- Recomendação prática para o plugin: condição de "deve rodar sync" =
  `RunService:IsStudio() and not RunService:IsRunning()` (ou equivalente
  `RunService:IsStudio() and RunService:IsEdit()`). Ligar/desligar reagindo
  a mudanças chamando essa checagem periodicamente ou observando os eventos
  runtime relevantes (não há sinal `Changed` para essas funções, pois não são
  properties — precisa polling ou os eventos padrão do RunService,
  ex. `Heartbeat`, e conferir a cada N segundos/ao detectar transição, já que
  não existe evento dedicado documentado tipo "PlayModeChanged" acessível a
  plugins de forma oficial).

## Fontes

- [RunService:IsStudio() — create.roblox.com/docs (via raw YAML, acesso 2026-07-16)](https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/RunService.yaml)
- [RunService:IsStudio() — página renderizada](https://create.roblox.com/docs/reference/engine/classes/RunService#IsStudio) (acesso 2026-07-16)
- [RunService:IsRunning() — página renderizada](https://create.roblox.com/docs/reference/engine/classes/RunService#IsRunning) (acesso 2026-07-16)
- [RunService page should clarify that IsStudio returns false for Team Test servers (staff `tnavarts` confirma comportamento intencional) — devforum.roblox.com/t/2640912](https://devforum.roblox.com/t/runservice-page-should-clarify-that-isstudio-returns-false-for-team-test-servers/2640912) (acesso 2026-07-16)
- [RunService:IsStudio() returns false on the server in Team Create Test — devforum.roblox.com/t/1246704](https://devforum.roblox.com/t/runserviceisstudio-returns-false-on-the-server-in-team-create-test/1246704) (acesso 2026-07-16)
- [RunService:IsRunMode() always returns 'true'... (confirma IsStudio=true em Run/Play Here/Play; staff `ExtraBreakfast` sobre fix de IsRunMode) — devforum.roblox.com/t/534992](https://devforum.roblox.com/t/runserviceisrunmode-always-returns-true-even-when-using-play-hereplay-in-roblox-studio/534992) (acesso 2026-07-16)
- [Plugin: How Do I Prevent it running, when Testing a game in studio (padrão IsEdit()/IsRunning() recomendado por `Corecii`) — devforum.roblox.com/t/154621](https://devforum.roblox.com/t/plugin-how-do-i-prevent-it-running-when-testing-a-game-in-studio/154621) (acesso 2026-07-16)

## Confiança

**Alta** para a distinção central (`IsStudio()` true em Edição E em Play/Run
dentro do Studio; `IsRunning()`/`IsEdit()` são a API correta para distinguir
os dois) — baseada em doc oficial (`RunService.yaml`, texto verbatim) mais
múltiplos relatos de fórum consistentes entre si e com confirmação de staff
da Roblox no ponto da exceção do Team Test server. **Média/baixa** para o
comportamento no caso de "pause durante Play" (`IsRunning()`/`IsEdit()` ambos
`false`) — isso vem só da doc oficial, sem confirmação de teste real de
plugin encontrada; recomendo validar manualmente se o SyncTeam precisar
tratar esse caso específico.
