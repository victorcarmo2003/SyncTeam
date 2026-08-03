-- SyncTeam — Árvore de componentes Vide do painel de status (M4.5)
--
-- Constrói o conteúdo do DockWidgetPluginGui (painel principal: barra de
-- título com indicador de status, INFO, campo de porta, botão CONNECT,
-- botão RESYNC, tabela USER | INFO) mais a tela de configurações (troca de
-- "tela" dentro do MESMO widget via um Vide source, nunca um segundo
-- DockWidgetPluginGui — spec da tarefa original).
--
-- 2026-08-02 (reskin "Modux Companion", 7ª rodada): visual inteiro portado
-- 1:1 do mockup já aprovado (`design-preview/index.html`/`styles.css`) —
-- ver `Theme.luau` pros tokens de cor/fonte novos e
-- `.claude/agent-memory/ui-dev.md` pro raciocínio completo de cada decisão
-- não-óbvia desta rodada. Mudanças estruturais (não só cor):
--   - Layout deixou de ser "posições Y acumuladas manualmente" e passou a
--     usar `UIListLayout(VerticalAlignment = Center)` dentro de um Frame de
--     conteúdo — é a técnica nativa do Roblox equivalente a
--     `justify-content: center` do CSS, permite ao bloco inteiro (INFO/
--     Porta/Connect/ReSync/tabela) centralizar verticalmente no espaço
--     disponível do painel, em vez de ficar grudado no topo.
--   - `UICorner` removido de TUDO (painel, botões, campos, chip, líder) —
--     o reskin não usa cantos arredondados em nenhum elemento.
--   - Indicador de status (quadrado 10x10, sem corner) novo na titlebar.
--   - Negrito real via `Theme.applyBold` (Nunito não tem variante Bold no
--     enum) em títulos/labels/botões/campos — texto de linha da tabela
--     (username/info) é a ÚNICA exceção deliberada (dado dinâmico truncado,
--     pior de escanear centralizado/negrito).
--
-- Recebe de PluginUI.luau (dono do ciclo de vida/estado):
--   state = {
--     connectionStatus: Source<"disconnected" | "connecting" | "connected">,
--     port: Source<number>,
--     view: Source<"main" | "settings">,
--     notificationsEnabled: Source<boolean>,
--     autoReconnectEnabled: Source<boolean>,
--     customDisplayName: Source<string>,
--       -- "Nome de exibição customizado" (implementado de verdade em
--       -- 2026-08-02, saiu da lista de placeholders "em breve"). "" = usar o
--       -- nome do Roblox normalmente (default). Espelha
--       -- Config.CUSTOM_DISPLAY_NAME_SETTING_KEY, mesmo padrão de
--       -- notificationsEnabled/autoReconnectEnabled.
--     sessionsMap: Source<{ [clientId]: RowData }>,
--       -- RowData = { clientId, username, joinSequence, isLeader, info }
--     infoText: Source<string>,
--       -- última mensagem IMPRESSA por Logger.log/Logger.notify (ver
--       -- Logger.getLastMessage()), sem o prefixo "[SyncTeam HH:MM:SS]".
--       -- Placeholder até a 1ª mensagem desta sessão do plugin.
--     infoElapsedSeconds: Source<number>,
--       -- segundos decorridos desde infoText mudar pela última vez;
--       -- PluginUI.luau recalcula a cada 1s (task.wait(1)) a partir de
--       -- Logger.getLastMessage()'s `updatedAt` (os.clock()) — só volta a 0
--       -- quando uma mensagem NOVA de fato chega, nunca por conta própria.
--     resyncState: Source<"idle" | "syncing" | "done">,
--       -- estado visual do botão RESYNC; PluginUI.luau/init.server.luau controlam
--       -- as transições (enviar resyncRequest -> "syncing"; resposta resyncResult
--       -- -> "done" ou volta "idle"). Ver contrato em docs/DECISIONS.md (5ª rodada).
--     leaseStaleAfterSeconds: Source<number>,
--       -- "handoff quase-instantâneo de lease" (2026-08-02, docs/DECISIONS.md
--       -- "8ª rodada"): segundos de inatividade de Pulse antes de um intent de
--       -- edição ser considerado morto e a lease do arquivo liberar para o
--       -- próximo candidato (TeamCreateLease.luau/readLiveIntents). Espelha
--       -- Config.getPlaceSetting(pluginObject, "leaseStaleAfterSeconds")
--       -- (setting POR-PLACE, não global — mesmo mecanismo de
--       -- sourcePollIntervalSeconds/presencePollIntervalSeconds, ver
--       -- Config.luau). Default 2.
--   }
--   callbacks = {
--     onConnect: () -> (),
--     onDisconnect: () -> (),
--     onPortSubmit: (newPort: number) -> (),
--     onNotificationsToggle: (enabled: boolean) -> (),
--     onAutoReconnectToggle: (enabled: boolean) -> (),
--     onCustomDisplayNameSubmit: (newName: string) -> (),
--       -- confirmado (Enter/perda de foco) no TextBox de "Nome de exibição
--       -- customizado" — persiste a setting E atualiza o Username já
--       -- publicado na sessão atual, se houver (ver TeamCreateElection.setLocalUsername,
--       -- chamado por PluginUI.luau; este módulo só invoca, nunca reimplementa).
--     onResyncRequest: () -> (),
--       -- dispara o pedido de ReSync (limpar+repuxar Source do VS Code). Ver
--       -- contrato completo em docs/DECISIONS.md (5ª rodada) — você só chama,
--       -- quem envia a mensagem de verdade é PluginUI.luau/init.server.luau.
--     onLeaseStaleAfterSecondsSubmit: (newValue: number) -> (),
--       -- confirmado (Enter/perda de foco) no TextBox de "Liberar lease após
--       -- (s)". SELF-CONTAINED em PluginUI.luau (Config.setPlaceSetting) —
--       -- diferente de onCustomDisplayNameSubmit, não precisa de nenhuma
--       -- republicação em runtime: TeamCreateLease.readLiveIntents já relê
--       -- Config.getPlaceSetting a cada ciclo do líder (até 0.5s), então
--       -- persistir a setting já é suficiente para o próximo ciclo refletir.
--       -- Este módulo já valida/rejeita não-positivo ANTES de chamar (mesmo
--       -- padrão de PortRow.FocusLost) — o callback nunca recebe <= 0.
--   }
--
-- `state` é uma tabela de Sources do Vide — cada campo É a própria função
-- fonte (chamável sem args para ler, com 1 arg para escrever), não um par
-- getter/setter separado; StatusPanel só LÊ (exceto `view`,
-- `notificationsEnabled`, `autoReconnectEnabled` e `customDisplayName`, que
-- este módulo também escreve diretamente ao reagir a clique/edição — trocar
-- de tela e ligar/desligar/editar essas preferências são estado 100% local
-- de UI, não precisam de callback de volta pra PluginUI/init.server.luau só
-- para o VALOR mudar; `onNotificationsToggle`/`onAutoReconnectToggle`/
-- `onCustomDisplayNameSubmit` existem à parte porque a PERSISTÊNCIA (e, no
-- caso de auto-reconectar/nome customizado, a AÇÃO de tentar conectar já ou
-- de atualizar o Username já publicado — ver PluginUI.luau) precisa de
-- código que só quem chamou PluginUI.init conhece, nunca duplicado aqui).
--
-- NOTA (gap consciente, fora de escopo desta rodada): o mockup também
-- colore o TEXTO da linha INFO conforme a severidade da última mensagem
-- (neutro/sucesso/aviso/erro, ver `#main-info-box[data-color]` no CSS) —
-- isso exigiria um `state.infoColor` novo que PluginUI.luau/init.server.luau
-- ainda não fornecem (mesma disciplina de contrato negociado do RESYNC, ver
-- `.claude/agent-memory/ui-dev.md`). Por ora o texto da caixa INFO fica
-- sempre em `Theme.Color.SubText` (neutro) — sinalizar ao `luau-dev` se essa
-- coloração virar pedido real.
--
-- Decisões de layout (pixels/cores) não especificadas 100% pelo mockup do
-- usuário: documentadas em detalhe em .claude/agent-memory/ui-dev.md.

local vide = require(script.Parent.Parent.Packages.Vide)
local Theme = require(script.Parent.Theme)

local StatusPanel = {}

-- ------------------------------------------------------------------ layout
local TITLE_HEIGHT = Theme.Layout.TitleBarHeight
local ROW_GAP = 8 -- gap vertical entre linhas do bloco de conteúdo (mockup mistura 8/10px conforme a linha; uniformizado em 8, diferença de 2px aceita — ver memória do agente)
local ROW_INNER_GAP = 10 -- mockup: gap:10px entre label e campo dentro de InfoRow/PortRow
-- 2026-08-02: alturas das caixas (não mais iguais) bater com o Modux
-- Companion real — `portInput` = 28px (`UI.luau`), `infoBox` = 34px. A caixa
-- em si é `altura da linha - 10` (5px de margem fixa em cima/embaixo, ver
-- InfoRow/PortRow — `Position` y=5, `Size` "1,-10" relativo à própria linha),
-- então a linha precisa ser caixa+10.
local PORT_ROW_HEIGHT = 38 -- caixa de 28px (era 20px, linha de 30)
local INFO_ROW_HEIGHT = 44 -- caixa de 34px (era 20px, linha de 30 — desacoplada de PORT_ROW_HEIGHT)
-- 2026-08-02: reduzido de Theme.Layout.ButtonHeight (34, não usado em mais
-- nenhum lugar do plugin) pra bater com a altura dos botões de ação do
-- Modux Companion real (`actionRow` em UI.luau: Connect/Disconnect a 30px) —
-- pedido do usuário ("Connect... em tamanho menor").
local CONNECT_ROW_HEIGHT = 30
local RESYNC_ROW_HEIGHT = 28
local HEADER_HEIGHT = 22
-- Altura FIXA da tabela de sessões (era flex:1/preenchia o painel inteiro).
-- Mockup: `.st-table { flex: none; max-height: 150px; overflow-y: auto; }`
-- — Roblox não tem "AutomaticSize com teto", então a aproximação prática é
-- uma altura fixa (não cresce além disso, e o `ScrollingFrame` já rola
-- sozinho se o conteúdo passar). Só com uma altura FIXA (não "preenche o
-- resto") o bloco inteiro consegue centralizar como grupo dentro do
-- ContentWrapper — do contrário a tabela absorveria todo o espaço livre e
-- anularia o `VerticalAlignment = Center`.
local TABLE_HEIGHT = 150

local LABEL_COLUMN_WIDTH = 48 -- mockup: .st-inforow label / .st-portrow label { width: 48px } (era 44)
local STATUS_SQUARE_SIZE = 10 -- mockup: .st-status-square (10x10px, sem corner)
local INFO_SECONDS_CHIP_WIDTH = 40
-- 34 (era 18) — mesma altura da InfoBox agora, batendo com `infoTimestamp`
-- do Modux Companion real (mesma altura de `infoBox`, já que lá o
-- timestamp mora DENTRO da caixa de info, não numa caixa separada como aqui).
local INFO_SECONDS_CHIP_HEIGHT = 34

-- Split de colunas da tabela USER | INFO, em Scale (responsivo a
-- redimensionamento do painel/widget flutuante) — mesma fração usada pelo
-- cabeçalho e por cada linha, para colunas alinharem.
local USER_COLUMN_SCALE = 0.45
local ROW_LEADING_INSET = 24 -- espaço reservado pra bolinha/quadrado de líder antes do nome

-- ------------------------------------------------------- divisória (Divider)

-- Linha divisória sutil (mockup `.st-divider`, reusada em 2 lugares: topo do
-- bloco de conteúdo da tela principal, topo do corpo de Configurações) — 1px
-- na cor do texto com transparência alta, equivalente a
-- `rgba(242,242,242,0.12)` do CSS (Color3 não tem canal alpha).
-- Contorno fino das "caixas" (InfoBox/SecondsChip/PortInput) — 2026-08-02,
-- pedido do usuário: mesma transparência do Modux Companion real
-- (`infoBoxStroke`/`portInputStroke` em UI.luau: `Color = colors.text,
-- Transparency = 0.88, Thickness = 1`). Roblox NÃO tem transparência nativa
-- em `BorderSizePixel`/`BorderColor3` (só cor sólida) — por isso é preciso um
-- `UIStroke` de verdade, igual ao que o Modux já usa, em vez do
-- `BorderSizePixel=1`/`BorderColor3=Theme.Color.Border` de antes. Reaproveita
-- `Theme.Layout.DividerTransparency` (já 0.88, mesmo valor, mesmo usado no
-- `Divider`) em vez de um token novo.
--
-- `ApplyStrokeMode = Border` explícito (bug real reportado pelo usuário: a
-- borda do campo de Porta sumiu) — o padrão de `UIStroke.ApplyStrokeMode` é
-- `Contextual`, que fica praticamente invisível num `TextBox` (o Modux real
-- só seta `Border` explícito em `portInputStroke`, não em `infoBoxStroke` —
-- mas fixar `Border` sempre é seguro/idêntico visualmente num `Frame` também,
-- então usar num helper único evita o mesmo bug se este helper for reusado
-- em outro `TextBox`/`TextButton` no futuro).
local function BorderStroke()
	return vide.create "UIStroke" {
		Color = Theme.Color.Text,
		Transparency = Theme.Layout.DividerTransparency,
		Thickness = 1,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	}
end

local function Divider()
	return vide.create "Frame" {
		Name = "Divider",
		Size = UDim2.new(1, 0, 0, 1),
		BackgroundColor3 = Theme.Color.Text,
		BackgroundTransparency = Theme.Layout.DividerTransparency,
		BorderSizePixel = 0,
	}
end

-- ------------------------------------------------------- indicador de status

-- Quadrado 10x10, SEM corner, na barra de título — cor reflete a SAÚDE da
-- conexão (state.connectionStatus()), DELIBERADAMENTE com paleta diferente
-- do botão CONNECT logo abaixo (que reflete "ação disponível", não "saúde
-- da conexão"): disconnected=cinza/neutro, connecting=amarelo,
-- connected=verde; vermelho reservado para um futuro estado de erro
-- genuíno, ainda não modelado nos 3 valores atuais de connectionStatus. Ver
-- raciocínio completo em .claude/agent-memory/ui-dev.md.
local function StatusSquare(state)
	return vide.create "Frame" {
		Name = "StatusSquare",
		Size = UDim2.fromOffset(STATUS_SQUARE_SIZE, STATUS_SQUARE_SIZE),
		BackgroundColor3 = function()
			local status = state.connectionStatus()
			if status == "connected" then
				return Theme.Color.Green
			elseif status == "connecting" then
				return Theme.Color.Yellow
			end
			return Theme.Color.Muted
		end,
		BorderSizePixel = 0,
	}
end

-- ------------------------------------------------------------- título (main)

-- Barra de título: fundo é AGORA a MESMA cor do resto do painel (era um tom
-- mais escuro que destacava a barra como "card" — princípio do reskin: sem
-- blocos internos mais claros/escuros).
--
-- 2026-08-02: corrigido pra bater com o `UI.luau` REAL do Modux Companion
-- (apontado pelo usuário) — o indicador e o título NÃO formam um grupo
-- centralizado junto (era assim antes, via `UIListLayout(HorizontalAlignment
-- = Center)`, replicando uma leitura literal do CSS do mockup que também
-- estava errada nesse detalhe, já corrigida em design-preview/styles.css).
-- Na fonte real, `indicator` fica em posição FIXA no canto esquerdo
-- (`Position = UDim2.fromOffset(14, 17)`, independente do título) e `title`
-- ocupa a LARGURA INTEIRA do header com `TextXAlignment = Center` — ou seja,
-- o texto fica centralizado na barra TODA, ignorando a largura do quadrado,
-- em vez de "grupo quadrado+texto" centralizado como bloco (o que desloca o
-- texto pra direita do centro verdadeiro). `StatusSquare` recebe posição
-- fixa aqui em vez de participar de um layout horizontal.
-- 2026-08-02: header ganhou uma 2ª linha (resumo de status, igual ao
-- `status` TextLabel do UI.luau real — "Disconnected"/"Connected"/etc, ali
-- posicionado logo abaixo do título dentro do MESMO `header`) — por isso
-- este bloco cresceu de 1 linha (TITLE_HEIGHT=36, ainda usado por
-- SettingsView, que continua com só 1 linha) pra uma altura própria maior,
-- só pra este título. Ver `MAIN_HEADER_HEIGHT` abaixo.
local MAIN_HEADER_HEIGHT = 58

local function TitleBar(text, state)
	local titleLabel = vide.create "TextLabel" {
		Name = "Title",
		Size = UDim2.new(1, 0, 0, 24),
		Position = UDim2.new(0, 0, 0, 6),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 20,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = text,
	}
	Theme.applyBold(titleLabel)

	-- Resumo de status (novo, pedido do usuário 2026-08-02) — mesma ideia do
	-- `status`/`setConnectionState` do UI.luau real: 1 linha central resumindo
	-- conexão + porta-alvo, fonte menor e cor mais acizentada que o título
	-- (Theme.Color.SubText, mesmo tom "secundário" já usado em outros labels
	-- do painel — não FieldText/Text, que são pro texto principal).
	local statusSummary = vide.create "TextLabel" {
		Name = "StatusSummary",
		Size = UDim2.new(1, 0, 0, 20),
		Position = UDim2.new(0, 0, 0, 32),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 16,
		TextColor3 = Theme.Color.SubText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			local status = state.connectionStatus()
			local port = state.port()
			if status == "connected" then
				return `Connected - target port {port}`
			elseif status == "connecting" then
				return `Reconnecting - target port {port}`
			end
			return `Disconnected - target port {port}`
		end,
	}
	Theme.applyBold(statusSummary)

	-- Indicador fica alinhado com a linha do TÍTULO especificamente (não mais
	-- centralizado no header inteiro, que agora tem 2 linhas) — mesmo
	-- y aproximado do `indicator` real (`UDim2.fromOffset(14,17)` relativo ao
	-- header, que também é medido a partir do título, não do header todo).
	local statusSquare = StatusSquare(state)
	statusSquare.AnchorPoint = Vector2.new(0, 0)
	statusSquare.Position = UDim2.new(0, 12, 0, 13)

	return vide.create "Frame" {
		Name = "TitleBar",
		Size = UDim2.new(1, 0, 0, MAIN_HEADER_HEIGHT),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,

		titleLabel,
		statusSummary,
		statusSquare,
	}
end

-- ------------------------------------------------------------- linha de info

-- Label fixo "INFO:" (mesma largura/estilo do label "Porta" de PortRow, para
-- as duas colunas alinharem) + uma CAIXA somente-exibição (Frame+TextLabel,
-- NUNCA um TextBox — o usuário só vê a última mensagem, não digita ali) +
-- um selo ("chip") de segundos à direita da caixa. Campo/caixa usam o
-- MESMO fundo do painel (Theme.Color.Background) + borda fina padrão
-- (Theme.Color.Border) — nunca um tom de fundo diferente do resto
-- (princípio 1 do reskin).
local function InfoRow(state)
	local label = vide.create "TextLabel" {
		Name = "Label",
		Size = UDim2.new(0, LABEL_COLUMN_WIDTH, 1, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 16,
		TextColor3 = Theme.Color.SubText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "Info",
	}
	Theme.applyBold(label)

	-- Cor sempre neutra (SubText) — ver NOTA no cabeçalho do arquivo sobre o
	-- gap consciente de `state.infoColor` (coloração por severidade do
	-- mockup, fora de escopo desta rodada).
	local boxText = vide.create "TextLabel" {
		Name = "Text",
		Size = UDim2.new(1, -16, 1, 0),
		Position = UDim2.new(0, 8, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 14,
		TextColor3 = Theme.Color.SubText,
		TextXAlignment = Enum.TextXAlignment.Center,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = function()
			return state.infoText()
		end,
	}
	Theme.applyBold(boxText)

	local secondsText = vide.create "TextLabel" {
		Name = "Text",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 12,
		TextColor3 = Theme.Color.Muted,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			return ("%ds"):format(state.infoElapsedSeconds())
		end,
	}
	Theme.applyBold(secondsText)

	return vide.create "Frame" {
		Name = "InfoRow",
		Size = UDim2.new(1, 0, 0, INFO_ROW_HEIGHT),
		BackgroundTransparency = 1,

		label,

		vide.create "Frame" {
			Name = "InfoBox",
			Position = UDim2.new(0, LABEL_COLUMN_WIDTH + ROW_INNER_GAP, 0, 5),
			Size = UDim2.new(
				1,
				-(LABEL_COLUMN_WIDTH + ROW_INNER_GAP) - ROW_INNER_GAP - INFO_SECONDS_CHIP_WIDTH,
				1,
				-10
			),
			BackgroundColor3 = Theme.Color.Background,
			BorderSizePixel = 0,

			BorderStroke(),
			boxText,
		},

		vide.create "Frame" {
			Name = "SecondsChip",
			Position = UDim2.new(1, -INFO_SECONDS_CHIP_WIDTH, 0.5, -INFO_SECONDS_CHIP_HEIGHT / 2),
			Size = UDim2.new(0, INFO_SECONDS_CHIP_WIDTH, 0, INFO_SECONDS_CHIP_HEIGHT),
			BackgroundColor3 = Theme.Color.Background,
			BorderSizePixel = 0,

			BorderStroke(),
			secondsText,
		},
	}
end

-- --------------------------------------------------------------- campo de porta

local function PortRow(state, callbacks)
	-- Forward-declarado: o handler de FocusLost precisa ler `portBox.Text`
	-- (o valor JÁ EDITADO pelo usuário) depois que o evento dispara — closure
	-- captura o upvalue `portBox`, que já estará atribuído pelo momento em
	-- que o evento realmente for disparado (nunca antes: FocusLost só ocorre
	-- depois que este `vide.create` inteiro já retornou).
	local portBox
	portBox = vide.create "TextBox" {
		Name = "PortInput",
		Position = UDim2.new(0, LABEL_COLUMN_WIDTH + ROW_INNER_GAP, 0, 5),
		Size = UDim2.new(1, -(LABEL_COLUMN_WIDTH + ROW_INNER_GAP), 1, -10),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		-- Único campo monoespaçado do painel (mockup: "campos técnicos:
		-- porta, endereço") — `Enum.Font.Code` já era usado no projeto antes
		-- deste reskin, não é API nova.
		Font = Theme.Font.Mono,
		TextSize = 15,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		PlaceholderText = "porta",
		PlaceholderColor3 = Theme.Color.Muted,
		ClearTextOnFocus = false,
		Text = function()
			return tostring(state.port())
		end,

		-- Confirma em Enter OU perda de foco (os dois disparam FocusLost no
		-- Roblox; spec da tarefa pede os dois, sem distinguir motivo) —
		-- reusa a MESMA lógica de troca de porta já existente
		-- (onPortSubmit -> Config.PORT_SETTING_KEY + stop()+start(), ver
		-- PluginUI.luau/init.server.luau), nunca um mecanismo paralelo.
		FocusLost = function()
			local parsed = tonumber(portBox.Text)
			if parsed ~= nil and parsed > 0 and parsed == math.floor(parsed) then
				local newPort = math.floor(parsed)
				if newPort ~= state.port() then
					callbacks.onPortSubmit(newPort)
				end
			end
			-- Sempre volta a refletir o valor CONFIRMADO (não o texto cru
			-- digitado) — só muda de verdade quando PluginUI.setPort for
			-- chamado de volta, depois da reconexão de fato acontecer.
			-- Também corrige texto inválido (não-numérico, negativo etc.)
			-- sem travar o campo num estado ruim.
			portBox.Text = tostring(state.port())
		end,

		BorderStroke(),
	}
	Theme.applyBold(portBox) -- mockup: .st-textbox { font-weight: 700 } vale pro portBox E pro infoBox

	local label = vide.create "TextLabel" {
		Name = "Label",
		Size = UDim2.new(0, LABEL_COLUMN_WIDTH, 1, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 16,
		TextColor3 = Theme.Color.SubText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "Porta",
	}
	Theme.applyBold(label)

	return vide.create "Frame" {
		Name = "PortRow",
		Size = UDim2.new(1, 0, 0, PORT_ROW_HEIGHT),
		BackgroundTransparency = 1,

		label,
		portBox,
	}
end

-- ----------------------------------------------------- CONNECT/DISCONNECT + engrenagem

local function ConnectRow(state, callbacks)
	-- Botão de 3 estados, cor+texto reativos a state.connectionStatus():
	--   "disconnected" -> verde-forte "Connect" (ação: conectar — call-to-action positiva)
	--   "connecting"   -> amarelo-forte "Conectando..." (tentando/reconectando em loop)
	--   "connected"    -> vermelho-forte "Disconnect" (ação: desconectar)
	-- Texto em Title Case (era ALL CAPS) — pedido do usuário 2026-08-02, mesmo
	-- estilo do UI.luau real ("Connect"/"Disconnect", nunca maiúsculo).
	-- Cores *Strong (nunca as claras, que são só texto/indicador — ver
	-- Theme.luau princípio 3) + texto branco PURO (ButtonText), regra nova
	-- do reskin sem exceção.
	local connectHovered = vide.source(false)
	local connectButton = vide.create "TextButton" {
		Name = "ConnectButton",
		Size = UDim2.new(1, -(Theme.Layout.IconButtonSize + 8), 1, 0),
		BackgroundColor3 = function()
			local status = state.connectionStatus()
			if status == "connected" then
				return if connectHovered() then Theme.Color.RedStrongHover else Theme.Color.RedStrong
			elseif status == "connecting" then
				return if connectHovered() then Theme.Color.YellowStrongHover else Theme.Color.YellowStrong
			end
			return if connectHovered() then Theme.Color.GreenStrongHover else Theme.Color.GreenStrong
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Rounded,
		TextSize = 16,
		TextColor3 = Theme.Color.ButtonText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			local status = state.connectionStatus()
			if status == "connected" then
				return "Disconnect"
			elseif status == "connecting" then
				return "Conectando..."
			end
			return "Connect"
		end,

		MouseEnter = function()
			connectHovered(true)
		end,
		MouseLeave = function()
			connectHovered(false)
		end,
		Activated = function()
			-- "disconnected" (parado) é o único estado cuja ação é CONECTAR;
			-- "connecting" e "connected" ambos oferecem PARAR — onDisconnect
			-- chama stop(), que zera o loop de runConnection (cancela a
			-- tentativa em voo ou encerra a conexão viva).
			if state.connectionStatus() == "disconnected" then
				callbacks.onConnect()
			else
				callbacks.onDisconnect()
			end
		end,
	}
	Theme.applyBold(connectButton)

	-- Engrenagem: virou botão-ícone TRANSPARENTE com borda fina (era fundo
	-- sólido cinza) — mockup `.st-icon-btn`: fundo transparente, borda
	-- padrão, hover = overlay claro sutil (rgba(242,242,242,0.08)). Sem
	-- negrito (mockup não define font-weight pra `.st-icon-btn`, diferente
	-- do `.st-back-btn` das Configurações, que É negrito — ver SettingsView).
	local gearHovered = vide.source(false)
	local gearButton = vide.create "TextButton" {
		Name = "SettingsGear",
		Size = UDim2.fromOffset(Theme.Layout.IconButtonSize, Theme.Layout.IconButtonSize),
		Position = UDim2.new(1, -Theme.Layout.IconButtonSize, 0.5, -Theme.Layout.IconButtonSize / 2),
		BackgroundColor3 = Theme.Color.Text,
		BackgroundTransparency = function()
			return if gearHovered() then Theme.Layout.HoverOverlayTransparency else 1
		end,
		BorderSizePixel = 1,
		BorderColor3 = Theme.Color.Border,
		Font = Theme.Font.Rounded,
		TextSize = 15,
		TextColor3 = Theme.Color.Text,
		Text = "\u{2699}", -- engrenagem (⚙) — abre a tela de configurações
		TextYAlignment = Enum.TextYAlignment.Center,

		MouseEnter = function()
			gearHovered(true)
		end,
		MouseLeave = function()
			gearHovered(false)
		end,
		Activated = function()
			state.view("settings")
		end,
	}

	return vide.create "Frame" {
		Name = "ConnectRow",
		Size = UDim2.new(1, 0, 0, CONNECT_ROW_HEIGHT),
		BackgroundTransparency = 1,

		connectButton,
		gearButton,
	}
end

-- ------------------------------------------------------------------ ReSync

-- Botão largura-cheia abaixo de ConnectRow, 3 estados visuais em
-- state.resyncState() ("idle"/"syncing"/"done" — este módulo só LÊ, mesma
-- disciplina do resto do StatusPanel). SEM lógica de envio de mensagem aqui
-- — Activated só chama callbacks.onResyncRequest(), passthrough puro
-- (contrato completo no cabeçalho do arquivo e em docs/DECISIONS.md).
--
-- Cores: "idle" = Theme.Color.Purple/PurpleHover (2026-08-02: era
-- Theme.Color.Border/cinza — pedido do usuário pra bater com o botão "Refresh
-- Snapshots" do Modux Companion real, que usa `colors.purple` — mesma leitura
-- semântica, ReSync É o "refresh" do SyncTeam). "syncing" = Theme.Color.
-- YellowStrong, "done" = Theme.Color.GreenStrong (nenhuma cor nova pra esses
-- dois — mesmas usadas pelo ConnectRow). SEM variação de hover em
-- "syncing"/"done" — mockup aprovado trata os dois como não-interativos
-- enquanto duram (clique só dispara callback no estado "idle").
local function ResyncRow(state, callbacks)
	local hovered = vide.source(false)

	local resyncButton = vide.create "TextButton" {
		Name = "ResyncButton",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = function()
			local resyncState = state.resyncState()
			if resyncState == "syncing" then
				return Theme.Color.YellowStrong
			elseif resyncState == "done" then
				return Theme.Color.GreenStrong
			end
			return if hovered() then Theme.Color.PurpleHover else Theme.Color.Purple
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Rounded,
		-- 16 (era 15) — bate com Connect/Info/Porta/resumo de status, todos a
		-- 16px (pedido do usuário 2026-08-02: conferir consistência de fonte).
		TextSize = 16,
		TextColor3 = Theme.Color.ButtonText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			local resyncState = state.resyncState()
			if resyncState == "syncing" then
				return "Syncing...."
			elseif resyncState == "done" then
				return "Done"
			end
			return "Resync"
		end,

		MouseEnter = function()
			hovered(true)
		end,
		MouseLeave = function()
			hovered(false)
		end,
		Activated = function()
			-- Só dispara em "idle" — "syncing"/"done" são estados transitórios
			-- não-clicáveis (mesmo espírito de CONNECT enquanto "connecting",
			-- que também não tem um terceiro clique paralelo escondido).
			if state.resyncState() == "idle" then
				callbacks.onResyncRequest()
			end
		end,
	}
	Theme.applyBold(resyncButton)

	return vide.create "Frame" {
		Name = "ResyncRow",
		Size = UDim2.new(1, 0, 0, RESYNC_ROW_HEIGHT),
		BackgroundTransparency = 1,

		resyncButton,
	}
end

-- --------------------------------------------------------- cabeçalho da tabela

-- Centralizado + negrito (era alinhado à esquerda) — mockup `.st-tableheader`.
local function TableHeader()
	local userLabel = vide.create "TextLabel" {
		Name = "User",
		Size = UDim2.new(USER_COLUMN_SCALE, -ROW_LEADING_INSET, 1, 0),
		Position = UDim2.new(0, ROW_LEADING_INSET, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 12,
		TextColor3 = Theme.Color.Muted,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "USER",
	}
	Theme.applyBold(userLabel)

	local infoLabel = vide.create "TextLabel" {
		Name = "Info",
		Size = UDim2.new(1 - USER_COLUMN_SCALE, -8, 1, 0),
		Position = UDim2.new(USER_COLUMN_SCALE, 0, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 12,
		TextColor3 = Theme.Color.Muted,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "INFO",
	}
	Theme.applyBold(infoLabel)

	return vide.create "Frame" {
		Name = "TableHeader",
		Size = UDim2.new(1, 0, 0, HEADER_HEIGHT),
		BackgroundTransparency = 1,

		userLabel,
		infoLabel,
	}
end

-- ------------------------------------------------------------- linha da tabela

-- rowSource: Source<RowData>, RowData = { clientId, username, joinSequence,
-- isLeader, info }. LayoutOrder = joinSequence garante ordem visual estável
-- via UIListLayout(SortOrder=LayoutOrder) — a ordem em que vide.indexes()
-- entrega os Instances (baseado em iteração de tabela/Map em Lua) NÃO é
-- garantida, então a ordem visual correta depende inteiramente do
-- LayoutOrder, nunca da ordem de criação/parenting.
local function SessionRow(rowSource)
	-- Alinhado à ESQUERDA (dado dinâmico truncado escaneia pior centralizado)
	-- mas NEGRITO como todo o resto — pedido explícito do usuário 2026-08-02
	-- ("negrito em todas as letras"), substitui a exceção antiga que deixava
	-- só estas 2 labels em peso normal (raciocínio anterior documentado em
	-- .claude/agent-memory/ui-dev.md, mantido só como histórico).
	local username = vide.create "TextLabel" {
		Name = "Username",
		Size = UDim2.new(USER_COLUMN_SCALE, -ROW_LEADING_INSET, 1, 0),
		Position = UDim2.new(0, ROW_LEADING_INSET, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 13,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = function()
			return rowSource().username
		end,
	}
	Theme.applyBold(username)

	local info = vide.create "TextLabel" {
		Name = "Info",
		Size = UDim2.new(1 - USER_COLUMN_SCALE, -8, 1, 0),
		Position = UDim2.new(USER_COLUMN_SCALE, 0, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 13,
		TextColor3 = Theme.Color.SubText,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Text = function()
			return rowSource().info
		end,
	}
	Theme.applyBold(info)

	return vide.create "Frame" {
		Name = "Row",
		Size = UDim2.new(1, 0, 0, Theme.Layout.RowHeight),
		LayoutOrder = function()
			return rowSource().joinSequence
		end,
		-- MESMA cor em toda linha agora, sem alternância par/ímpar (era um
		-- tom mais claro nas linhas pares) — princípio 1 do reskin; a
		-- separação vem só da linha divisória abaixo.
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,

		-- Quadrado de líder (era CÍRCULO/UICorner) — mesma linguagem "sem
		-- corner" do indicador de status da titlebar. Sempre criado (mesmo
		-- espaço reservado em toda linha, líder ou não — alinhamento
		-- consistente do nome entre linhas), só a visibilidade é reativa.
		vide.create "Frame" {
			Name = "LeaderDot",
			Size = UDim2.fromOffset(8, 8),
			Position = UDim2.new(0, 8, 0.5, -4),
			BackgroundColor3 = Theme.Color.Green,
			BorderSizePixel = 0,
			Visible = function()
				return rowSource().isLeader
			end,
		},

		username,
		info,

		-- Linha divisória sutil entre linhas (mockup: border-bottom
		-- rgba(242,242,242,0.08) em toda linha, exceto a última). Aplicada
		-- em TODA linha aqui, inclusive a última — simplificação deliberada:
		-- replicar o ":last-child" exigiria que cada linha soubesse sua
		-- posição relativa dentro do Map de vide.indexes (não é informação
		-- naturalmente disponível), complexidade desproporcional ao ganho
		-- visual de 1px — ver .claude/agent-memory/ui-dev.md.
		vide.create "Frame" {
			Name = "Divider",
			Position = UDim2.new(0, 0, 1, -1),
			Size = UDim2.new(1, 0, 0, 1),
			BackgroundColor3 = Theme.Color.Text,
			BackgroundTransparency = Theme.Layout.RowDividerTransparency,
			BorderSizePixel = 0,
		},
	}
end

-- Bug real reportado pelo usuário (screenshot, 2026-08-02): com a tabela
-- vazia (0 sessões, caso mais comum ao abrir o painel), os 150px fixos de
-- `TABLE_HEIGHT` viravam espaço morto ocupando quase metade do painel — o
-- bloco de conteúdo inteiro (Divider..TableHeader..Table) ficava ~367px
-- contra ~364px disponíveis no widget default (400 - TITLE_HEIGHT), ou seja,
-- SEM folga nenhuma pra `UIListLayout(VerticalAlignment=Center)` centralizar
-- de verdade — visualmente parecia "grudado no topo" com um vazio enorme
-- embaixo, exatamente o oposto do princípio do reskin ("tabela encolhe com
-- pouco conteúdo, cresce/rola só quando precisa" — mesma decisão já tomada
-- no mockup, `flex:none + max-height` em vez de `flex:1`). Fix: altura
-- REATIVA (função Vide, mesmo padrão de `BackgroundColor3` reativo já usado
-- em todo o arquivo) — cresce conforme o número real de sessões
-- (`Theme.Layout.RowHeight` + o gap de 2px do UIListLayout interno por
-- linha), até o teto de `TABLE_HEIGHT` (150px), onde passa a rolar
-- internamente (`AutomaticCanvasSize` já cobre isso). Com 0 sessões, altura
-- 0 — nenhum espaço morto, o resto do bloco fica livre pra centralizar de
-- verdade no espaço disponível.
local ROW_STRIDE = Theme.Layout.RowHeight + 2 -- +2 = UIListLayout Padding interno da tabela

local function SessionsTable(state)
	return vide.create "ScrollingFrame" {
		Name = "SessionsTable",
		Size = function()
			local rowCount = 0
			for _ in pairs(state.sessionsMap()) do
				rowCount += 1
			end
			return UDim2.new(1, 0, 0, math.min(rowCount * ROW_STRIDE, TABLE_HEIGHT))
		end,
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.Color.Muted,
		CanvasSize = UDim2.fromOffset(0, 0),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,

		vide.create "UIListLayout" {
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, 2),
		},

		-- Uma linha por sessão viva (vide.indexes: chave = clientId, mantém
		-- a MESMA Instance de linha entre refreshes em vez de recriar tudo
		-- do zero a cada poll — só linhas que entram/saem de Sessions/
		-- criam/destroem Instance).
		vide.indexes(state.sessionsMap, function(rowSource)
			return SessionRow(rowSource)
		end),
	}
end

-- ------------------------------------------------------------------ main view

-- Bug real reportado pelo usuário (screenshot, 2026-08-02, 2ª rodada de
-- correção): mesmo depois da tabela encolher, o título ficava "preso ao
-- topo" com um vão vazio grande antes da divisória — porque `TitleBar` era
-- um irmão FIXO no topo do widget inteiro, FORA do bloco que centraliza;
-- só `contentWrapper` (divisória pra baixo) centralizava. Isso diverge da
-- fonte real do Modux Companion (`UI.luau`, apontada pelo usuário): lá,
-- `header` (título) é o PRIMEIRO filho DENTRO do `panel` — o mesmo bloco de
-- altura fixa que centraliza inteiro via `AnchorPoint=(0,0.5)` +
-- `Position=(0, 0.5, 0)`. Corrigido: título agora é só mais um item dentro
-- do MESMO `UIListLayout`/`Panel`, que centraliza como bloco ÚNICO (título +
-- divisória + linhas + tabela) — técnica trocada de
-- `UIListLayout(VerticalAlignment=Center)` num frame de tamanho FIXO pra
-- `AutomaticSize.Y` + `AnchorPoint(0,0.5)`/`Position(0,0.5,0)` num frame de
-- altura VARIÁVEL (mesma técnica de `AnchorPoint`/`Position` que o
-- `UI.luau` real usa pro `panel`, só que com altura automática em vez de
-- fixa, já que a tabela de sessões deste painel pode crescer/encolher).
local function MainView(state, callbacks)
	local panel = vide.create "Frame" {
		Name = "Panel",
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		AnchorPoint = Vector2.new(0, 0.5),
		Position = UDim2.new(0, 0, 0.5, 0),
		BackgroundTransparency = 1,

		vide.create "UIListLayout" {
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, ROW_GAP),
		},

		TitleBar("Sync Team", state),
		Divider(),
		InfoRow(state),
		PortRow(state, callbacks),
		ConnectRow(state, callbacks),
		ResyncRow(state, callbacks),
		TableHeader(),
		SessionsTable(state),
	}

	return vide.create "Frame" {
		Name = "MainView",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		ClipsDescendants = true,

		vide.create "UIPadding" {
			PaddingLeft = UDim.new(0, Theme.Layout.Padding),
			PaddingRight = UDim.new(0, Theme.Layout.Padding),
			PaddingTop = UDim.new(0, Theme.Layout.Padding),
			PaddingBottom = UDim.new(0, Theme.Layout.Padding),
		},

		panel,
	}
end

-- -------------------------------------------------------------- settings view

local function SettingsRow(labelText, control, isDisabled)
	local label = vide.create "TextLabel" {
		Name = "Label",
		Size = UDim2.new(0.62, 0, 1, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 15,
		TextColor3 = if isDisabled then Theme.Color.Muted else Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextWrapped = true,
		Text = labelText,
	}
	Theme.applyBold(label)

	return vide.create "Frame" {
		Name = "SettingsRow",
		Size = UDim2.new(1, 0, 0, 34), -- mockup: .st-settings-row { min-height: 34px }
		BackgroundTransparency = 1,

		label,
		control,
	}
end

-- Única opção real desta fatia: liga/desliga o toast; o encaminhamento por
-- WS NUNCA é condicionado a isso (Logger.notify sempre encaminha, ver
-- Logger.luau) — só a exibição visual passa por aqui. Fundo = Theme.Color.Border
-- (sólido, sem borda própria — mockup `.st-toggle { border: none; }`) +
-- texto branco puro negrito, hover = BorderHover.
local function NotificationsToggle(state, callbacks)
	local hovered = vide.source(false)
	local toggle = vide.create "TextButton" {
		Name = "NotificationsToggle",
		Size = UDim2.new(0.38, 0, 1, -6),
		Position = UDim2.new(0.62, 0, 0, 3),
		BackgroundColor3 = function()
			return if hovered() then Theme.Color.BorderHover else Theme.Color.Border
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Rounded,
		TextSize = 13,
		TextColor3 = Theme.Color.ButtonText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			return if state.notificationsEnabled() then "Ativado" else "Desativado"
		end,

		MouseEnter = function()
			hovered(true)
		end,
		MouseLeave = function()
			hovered(false)
		end,
		Activated = function()
			local newValue = not state.notificationsEnabled()
			state.notificationsEnabled(newValue)
			callbacks.onNotificationsToggle(newValue)
		end,
	}
	Theme.applyBold(toggle)
	return toggle
end

-- Segunda opção real desta fatia: liga/desliga Config.AUTOSTART_SETTING_KEY
-- — "conectar sozinho ao abrir a place/recarregar o plugin", sem relação
-- com reconexão após queda de sessão já viva (automática/incondicional, ver
-- Config.RECONNECT_SECONDS). Mesmo mirror visual de NotificationsToggle —
-- única diferença é que `callbacks.onAutoReconnectToggle` também pode AGIR
-- na hora (tentar conectar já, se ligado e desconectado — ver
-- init.server.luau, PluginUI.init).
local function AutoReconnectToggle(state, callbacks)
	local hovered = vide.source(false)
	local toggle = vide.create "TextButton" {
		Name = "AutoReconnectToggle",
		Size = UDim2.new(0.38, 0, 1, -6),
		Position = UDim2.new(0.62, 0, 0, 3),
		BackgroundColor3 = function()
			return if hovered() then Theme.Color.BorderHover else Theme.Color.Border
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Rounded,
		TextSize = 13,
		TextColor3 = Theme.Color.ButtonText,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = function()
			return if state.autoReconnectEnabled() then "Ativado" else "Desativado"
		end,

		MouseEnter = function()
			hovered(true)
		end,
		MouseLeave = function()
			hovered(false)
		end,
		Activated = function()
			local newValue = not state.autoReconnectEnabled()
			state.autoReconnectEnabled(newValue)
			callbacks.onAutoReconnectToggle(newValue)
		end,
	}
	Theme.applyBold(toggle)
	return toggle
end

-- Terceira opção real desta fatia (2026-08-02, saiu da lista "em breve"):
-- TextBox editável — substitui, quando não-vazio, o nome resolvido via
-- Players:GetNameFromUserIdAsync como Username publicado em
-- Sessions/<clientId> (ver TeamCreateElection.luau/Config.resolveCustomDisplayName).
-- Mesmo visual/hover pattern dos 2 toggles booleanos acima (SettingsRow com
-- controle na coluna direita, 0.62/0.38, altura 34px da linha), adaptado
-- para um campo de TEXTO em vez de um TextButton binário — MESMA técnica de
-- FocusLost/forward-declaration já usada em PortRow acima (confirma em Enter
-- OU perda de foco, os dois disparam FocusLost no Roblox).
--
-- Fundo/borda seguem o padrão de "caixa somente-exibição vira editável"
-- (Theme.Color.Background + BorderStroke, mesmo do portBox) em vez do fundo
-- sólido Theme.Color.Border dos toggles — decisão: um TextBox editável já se
-- distingue visualmente de um TextButton de toggle só pelo cursor de texto/
-- caret, mas reforçar com a MESMA linguagem visual dos outros campos de
-- entrada do painel (PortRow) deixa claro "isto é um campo, não um botão" à
-- primeira vista.
local function CustomDisplayNameField(state, callbacks)
	local fieldBox
	fieldBox = vide.create "TextBox" {
		Name = "CustomDisplayNameField",
		Size = UDim2.new(0.38, 0, 1, -6),
		Position = UDim2.new(0.62, 0, 0, 3),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		Font = Theme.Font.Rounded,
		TextSize = 13,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		PlaceholderText = "nome do Roblox",
		PlaceholderColor3 = Theme.Color.Muted,
		ClearTextOnFocus = false,
		Text = function()
			return state.customDisplayName()
		end,

		-- Confirma em Enter OU perda de foco (mesmo padrão de PortRow.FocusLost
		-- acima) — grava a preferência E atualiza o Username já publicado na
		-- sessão atual sem exigir reconectar (callbacks.onCustomDisplayNameSubmit,
		-- contrato no cabeçalho do arquivo; quem executa de fato é
		-- PluginUI.luau/TeamCreateElection.setLocalUsername, este módulo só
		-- invoca). Campo vazio é um valor válido e INTENCIONAL (volta a usar o
		-- nome do Roblox) — só ignora se o texto não mudou de verdade, para não
		-- disparar o callback à toa a cada FocusLost sem edição real.
		FocusLost = function()
			local newValue = fieldBox.Text
			if newValue ~= state.customDisplayName() then
				state.customDisplayName(newValue)
				callbacks.onCustomDisplayNameSubmit(newValue)
			end
		end,

		BorderStroke(),
	}
	Theme.applyBold(fieldBox) -- mockup: .st-textbox { font-weight: 700 } — mesma regra do portBox/infoBox
	return fieldBox
end

-- Quarta opção real desta fatia (2026-08-02, "8ª rodada" — handoff
-- quase-instantâneo de lease, docs/DECISIONS.md): TextBox NUMÉRICO, mesmo
-- esqueleto visual/hover/FocusLost de CustomDisplayNameField acima (campo de
-- texto na SettingsRow, não toggle) — mas parse+validação de número seguem
-- PortRow (`tonumber` + rejeita não-positivo), já que aqui o valor é
-- segundos, não uma string livre. Diferente de PortRow: aceita fração
-- (2.5s é um valor razoável para este campo, ao contrário de porta) — não
-- força `math.floor`.
local function LeaseStaleAfterSecondsField(state, callbacks)
	local fieldBox
	fieldBox = vide.create "TextBox" {
		Name = "LeaseStaleAfterSecondsField",
		Size = UDim2.new(0.38, 0, 1, -6),
		Position = UDim2.new(0.62, 0, 0, 3),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		Font = Theme.Font.Mono, -- mesmo tratamento de PortRow: campo numérico/técnico
		TextSize = 13,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		PlaceholderText = "segundos",
		PlaceholderColor3 = Theme.Color.Muted,
		ClearTextOnFocus = false,
		Text = function()
			return tostring(state.leaseStaleAfterSeconds())
		end,

		-- Confirma em Enter OU perda de foco (mesmo padrão de
		-- PortRow/CustomDisplayNameField). Valida/rejeita não-positivo ANTES de
		-- chamar o callback (mesmo padrão de validação que
		-- Config.setPlaceSetting já aplica do lado do Config — checar aqui
		-- também evita mandar um valor claramente inválido pela ponte de
		-- callback só para ser rejeitado do outro lado). Texto inválido
		-- (não-numérico, <= 0) é descartado e o campo sempre volta a refletir
		-- o valor CONFIRMADO, nunca o texto cru digitado — mesma disciplina de
		-- PortRow.FocusLost.
		FocusLost = function()
			local parsed = tonumber(fieldBox.Text)
			if parsed ~= nil and parsed > 0 then
				if parsed ~= state.leaseStaleAfterSeconds() then
					state.leaseStaleAfterSeconds(parsed)
					callbacks.onLeaseStaleAfterSecondsSubmit(parsed)
				end
			end
			fieldBox.Text = tostring(state.leaseStaleAfterSeconds())
		end,

		BorderStroke(),
	}
	Theme.applyBold(fieldBox)
	return fieldBox
end

-- Itens "em breve" restantes (spec original tinha 3; "Nome de exibição
-- customizado" saiu desta lista em 2026-08-02, ver CustomDisplayNameField
-- acima — os outros 2 continuam sem funcionalidade real nesta fatia) —
-- texto estático à direita, sem controle nenhum.
local DISABLED_SETTINGS = {
	"Containers observados",
	"Nível de log",
}

local function DisabledSettingRow(labelText)
	local tag = vide.create "TextLabel" {
		Name = "Tag",
		Size = UDim2.new(0.38, 0, 1, 0),
		Position = UDim2.new(0.62, 0, 0, 0),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 12,
		TextColor3 = Theme.Color.Muted,
		TextXAlignment = Enum.TextXAlignment.Right,
		Text = "em breve",
	}
	Theme.applyBold(tag)
	return SettingsRow(labelText, tag, true)
end

local function SettingsView(state, callbacks)
	-- Botão-ícone transparente com borda fina, igual à engrenagem (mockup
	-- `.st-back-btn`) — ao contrário da engrenagem, ESTE é negrito (mockup:
	-- `.st-back-btn { font-weight: 700; }`).
	local backHovered = vide.source(false)
	local backButton = vide.create "TextButton" {
		Name = "BackButton",
		Size = UDim2.fromOffset(Theme.Layout.IconButtonSize, Theme.Layout.IconButtonSize),
		Position = UDim2.new(0, Theme.Layout.Padding, 0.5, -Theme.Layout.IconButtonSize / 2),
		BackgroundColor3 = Theme.Color.Text,
		BackgroundTransparency = function()
			return if backHovered() then Theme.Layout.HoverOverlayTransparency else 1
		end,
		BorderSizePixel = 1,
		BorderColor3 = Theme.Color.Border,
		Font = Theme.Font.Rounded,
		TextSize = 14,
		TextColor3 = Theme.Color.Text,
		Text = "\u{2190}", -- seta pra esquerda (←) — volta pra tela principal

		MouseEnter = function()
			backHovered(true)
		end,
		MouseLeave = function()
			backHovered(false)
		end,
		Activated = function()
			state.view("main")
		end,
	}
	Theme.applyBold(backButton)

	local titleLabel = vide.create "TextLabel" {
		Name = "Title",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 20,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "CONFIGURAÇÕES",
	}
	Theme.applyBold(titleLabel)

	local titleBar = vide.create "Frame" {
		Name = "TitleBar",
		Size = UDim2.new(1, 0, 0, TITLE_HEIGHT),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,

		titleLabel,
		backButton,
	}

	-- Mesma correção de MainView (ver comentário lá) — título deixa de ser
	-- irmão fixo no topo e vira o primeiro item do MESMO bloco centralizado
	-- (`AutomaticSize.Y` + `AnchorPoint`/`Position` 0.5), igual ao `panel` do
	-- `UI.luau` real.
	local panel = vide.create "Frame" {
		Name = "Panel",
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		AnchorPoint = Vector2.new(0, 0.5),
		Position = UDim2.new(0, 0, 0.5, 0),
		BackgroundTransparency = 1,

		vide.create "UIListLayout" {
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, 4),
		},

		titleBar,
		Divider(),
		SettingsRow("Mostrar notificações", NotificationsToggle(state, callbacks), false),
		SettingsRow("Reconectar automaticamente ao abrir a place", AutoReconnectToggle(state, callbacks), false),
		SettingsRow("Nome de exibição customizado", CustomDisplayNameField(state, callbacks), false),
		SettingsRow("Liberar lease após (s)", LeaseStaleAfterSecondsField(state, callbacks), false),
		DisabledSettingRow(DISABLED_SETTINGS[1]),
		DisabledSettingRow(DISABLED_SETTINGS[2]),
	}

	return vide.create "Frame" {
		Name = "SettingsView",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		ClipsDescendants = true,

		vide.create "UIPadding" {
			PaddingLeft = UDim.new(0, Theme.Layout.Padding),
			PaddingRight = UDim.new(0, Theme.Layout.Padding),
			PaddingTop = UDim.new(0, Theme.Layout.Padding),
			PaddingBottom = UDim.new(0, Theme.Layout.Padding),
		},

		panel,
	}
end

-- ------------------------------------------------------------------- root

-- Constrói a árvore inteira (main view + settings view, trocadas por
-- vide.switch olhando state.view — NUNCA um segundo DockWidgetPluginGui,
-- spec da tarefa original) e devolve o rootFrame. Quem chama (PluginUI.luau)
-- parenta rootFrame dentro do DockWidgetPluginGui. O toast de notificação
-- NÃO é criado aqui: é um ScreenGui flutuante independente em CoreGui (ver
-- Toast.luau), montado por PluginUI.init fora deste vide.mount.
function StatusPanel.build(state, callbacks)
	return vide.create "Frame" {
		Name = "SyncTeamRoot",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		-- Higiene de painel: nada deve desenhar fora dos limites do widget.
		ClipsDescendants = true,

		vide.switch(state.view) {
			main = function()
				return MainView(state, callbacks)
			end,
			settings = function()
				return SettingsView(state, callbacks)
			end,
		},
	}
end

return StatusPanel
