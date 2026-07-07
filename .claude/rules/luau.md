# Regras de código Luau (plugin Studio)

- **Escrita de Source**: sempre `ScriptEditorService:UpdateSourceAsync` com
  fallback para `.Source` em `pcall`, logando qual caminho foi usado.
- **Detecção de mudança de Source: nunca só o sinal.**
  `GetPropertyChangedSignal("Source")` não dispara de forma confiável após
  `UpdateSourceAsync` (confirmado em teste real, M0.5, 2026-07-03 — ver
  docs/DECISIONS.md). Todo observador de Source precisa de polling periódico
  (dedupe por último valor visto) como caminho garantido; o sinal pode ficar
  conectado como fast-path, nunca como único caminho. Para notificação entre
  Studios via Team Create, preferir contador/hash em `TestService.SyncTeam`
  em vez do `Changed` do próprio script.
- **APIs de plataforma** (WebStreamClient, DraftsService, ScriptEditorService,
  StudioService): toda chamada em `pcall`; falha degrada com log claro, nunca
  quebra o plugin inteiro.
- **WebSocket**: `HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = ... })`;
  eventos `MessageReceived`/`Closed`/`Error`; limite documentado de 6 clientes
  por Studio — o produto usa 1 conexão, spikes no máximo 2.
- **Identidade de script**: UUID (`HttpService:GenerateGUID(false)`) +
  `ObjectValue` apontando para a Instance. Proibido usar path ou attributes
  como identidade (decisão registrada).
- **`ObjectValue.Value` NÃO vira `nil` quando a Instance referenciada é
  destruída** (`:Destroy()`) — confirmado por staff da Roblox no DevForum
  (comportamento intencional, referência "morta" mantida), e `Changed` não
  dispara para esse caso. Nunca usar `ObjectValue.Value == nil` como
  detecção de delete — confirmado como bug real em teste ao vivo, 2026-07-04
  (ver docs/DECISIONS.md). Detecção robusta: `instance.Parent == nil` E
  confirmar com `pcall(function() instance.Parent = instance.Parent end)`
  falhando (Parent nil isolado também ocorre em desparentagem temporária,
  não só destruição real). `Instance.Destroying` existe mas tem disparo
  inconsistente relatado no DevForum — fast-path best-effort, nunca único
  caminho (mesmo padrão de `Source.Changed`: polling é a garantia).
- **Metadados**: apenas sob `TestService.SyncTeam`. Nunca podem vazar para o
  filesystem do usuário nem para o conteúdo do jogo.
- **Constantes de coordenação** (validadas no RojoCoop — não alterar sem
  registro em DECISIONS.md): pulso 2s, sessão obsoleta 8s, limpeza 20s,
  promoção de líder após 2 observações consecutivas.
- **Logs** com prefixo `[SyncTeam]` (spikes: `[SyncTeam <spike>]`) e horário.
- Threads de fundo: loops verificam flag de estado (`running`/`enabled`) e
  terminam sozinhos; conexões RBXScriptConnection sempre registradas e
  desconectadas em `stop`/`plugin.Unloading`.
- Antes de usar API nova, confira `.claude/research/`; sem confirmação lá,
  a tarefa volta para pesquisa.
