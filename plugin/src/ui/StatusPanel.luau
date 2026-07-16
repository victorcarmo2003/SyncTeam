-- SyncTeam — Árvore de componentes Vide do painel de status (M4.5)
--
-- Constrói o conteúdo do DockWidgetPluginGui (mockup do usuário: título no
-- topo escuro, campo de porta, botão CONNECT largo, tabela USER | INFO) mais
-- a tela de configurações (troca de "tela" dentro do MESMO widget via um
-- Vide source, nunca um segundo DockWidgetPluginGui — spec da tarefa).
--
-- Recebe de PluginUI.luau (dono do ciclo de vida/estado):
--   state = {
--     connectionStatus: Source<"disconnected" | "connecting" | "connected">,
--     port: Source<number>,
--     view: Source<"main" | "settings">,
--     notificationsEnabled: Source<boolean>,
--     sessionsMap: Source<{ [clientId]: RowData }>,
--       -- RowData = { clientId, username, joinSequence, isLeader, info }
--   }
--   callbacks = {
--     onConnect: () -> (),
--     onDisconnect: () -> (),
--     onPortSubmit: (newPort: number) -> (),
--     onNotificationsToggle: (enabled: boolean) -> (),
--   }
--
-- `state` é uma tabela de Sources do Vide — cada campo É a própria função
-- fonte (chamável sem args para ler, com 1 arg para escrever), não um par
-- getter/setter separado; StatusPanel só LÊ (exceto `view` e
-- `notificationsEnabled`, que este módulo também escreve diretamente ao
-- reagir a clique — trocar de tela e ligar/desligar notificações são
-- estado 100% local de UI, não precisam de callback de volta pra
-- PluginUI/init.server.luau; só onNotificationsToggle existe à parte porque
-- a PREFERÊNCIA precisa ser persistida via plugin:SetSetting, que só
-- PluginUI.luau sabe fazer).
--
-- Decisões de layout (pixels/cores) não especificadas 100% pelo mockup do
-- usuário: documentadas em detalhe em .claude/agent-memory/ui-dev.md.

local vide = require(script.Parent.Parent.Packages.Vide)
local Theme = require(script.Parent.Theme)

local StatusPanel = {}

-- ------------------------------------------------------------------ layout
-- Constantes de posição Y acumuladas (evita somar à mão em cada função e
-- arriscar um offset errado) — únicas usadas pelas linhas fixas do topo do
-- Main View (título/porta/connect/cabeçalho da tabela); a tabela em si
-- ocupa todo o espaço restante abaixo de TABLE_Y.
local TITLE_HEIGHT = Theme.Layout.TitleBarHeight
local ROW_GAP = 8
local PORT_ROW_HEIGHT = 30
local CONNECT_ROW_HEIGHT = Theme.Layout.ButtonHeight
local HEADER_HEIGHT = 22

local PORT_ROW_Y = TITLE_HEIGHT + ROW_GAP
local CONNECT_ROW_Y = PORT_ROW_Y + PORT_ROW_HEIGHT + ROW_GAP
local HEADER_Y = CONNECT_ROW_Y + CONNECT_ROW_HEIGHT + ROW_GAP
local TABLE_Y = HEADER_Y + HEADER_HEIGHT + 4

-- Split de colunas da tabela USER | INFO, em Scale (responsivo a
-- redimensionamento do painel/widget flutuante) — mesma fração usada pelo
-- cabeçalho e por cada linha, para colunas alinharem.
local USER_COLUMN_SCALE = 0.45
local ROW_LEADING_INSET = 24 -- espaço reservado pra bolinha de líder antes do nome

-- ------------------------------------------------------------- título (main)

local function TitleBar(text)
	return vide.create "Frame" {
		Name = "TitleBar",
		Size = UDim2.new(1, 0, 0, TITLE_HEIGHT),
		BackgroundColor3 = Theme.Color.TitleBar,
		BorderSizePixel = 0,

		vide.create "TextLabel" {
			Size = UDim2.fromScale(1, 1),
			BackgroundTransparency = 1,
			Font = Theme.Font.Title,
			TextSize = 16,
			TextColor3 = Theme.Color.TitleText,
			Text = text,
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
		Size = UDim2.new(1, -60, 1, -10),
		Position = UDim2.new(0, 50, 0, 5),
		BackgroundColor3 = Theme.Color.FieldBackground,
		BorderSizePixel = 0,
		Font = Theme.Font.Body,
		TextSize = 14,
		TextColor3 = Theme.Color.FieldText,
		PlaceholderText = "porta",
		ClearTextOnFocus = false,
		Text = function()
			return tostring(state.port())
		end,

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },

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
	}

	return vide.create "Frame" {
		Name = "PortRow",
		Size = UDim2.new(1, -2 * Theme.Layout.Padding, 0, PORT_ROW_HEIGHT),
		Position = UDim2.new(0, Theme.Layout.Padding, 0, PORT_ROW_Y),
		BackgroundTransparency = 1,

		vide.create "TextLabel" {
			Size = UDim2.new(0, 44, 1, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Body,
			TextSize = 13,
			TextColor3 = Theme.Color.LabelMuted,
			TextXAlignment = Enum.TextXAlignment.Left,
			Text = "Porta",
		},
		portBox,
	}
end

-- ----------------------------------------------------- CONNECT/DISCONNECT + engrenagem

local function ConnectRow(state, callbacks)
	-- Botão de 3 estados (item 1 da tarefa), cor+texto reativos a
	-- state.connectionStatus():
	--   "disconnected" -> azul  "CONNECT"       (ação: conectar)
	--   "connecting"   -> laranja "CONECTANDO..." (tentando/reconectando em loop)
	--   "connected"    -> vermelho "DISCONNECT"  (ação: desconectar)
	-- O estado laranja cobre o INTERVALO em que runConnection está tentando
	-- conectar mas ainda não confirmou (ou perdeu e está reconectando) — antes
	-- disso o botão piscava azul/vermelho a cada ciclo do loop de reconexão
	-- (bug reportado pelo usuário); agora fica laranja estável.
	local connectHovered = vide.source(false)
	local connectButton = vide.create "TextButton" {
		Name = "ConnectButton",
		Size = UDim2.new(1, -(Theme.Layout.IconButtonSize + 8), 1, 0),
		BackgroundColor3 = function()
			local status = state.connectionStatus()
			if status == "connected" then
				return if connectHovered() then Theme.Color.ConnectActiveHover else Theme.Color.ConnectActive
			elseif status == "connecting" then
				return if connectHovered() then Theme.Color.ConnectConnectingHover else Theme.Color.ConnectConnecting
			end
			return if connectHovered() then Theme.Color.ConnectIdleHover else Theme.Color.ConnectIdle
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Bold,
		TextSize = 14,
		TextColor3 = Theme.Color.ButtonText,
		Text = function()
			local status = state.connectionStatus()
			if status == "connected" then
				return "DISCONNECT"
			elseif status == "connecting" then
				return "CONECTANDO..."
			end
			return "CONNECT"
		end,

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },

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

	local gearHovered = vide.source(false)
	local gearButton = vide.create "TextButton" {
		Name = "SettingsGear",
		Size = UDim2.fromOffset(Theme.Layout.IconButtonSize, Theme.Layout.IconButtonSize),
		Position = UDim2.new(1, -Theme.Layout.IconButtonSize, 0.5, -Theme.Layout.IconButtonSize / 2),
		BackgroundColor3 = function()
			return if gearHovered() then Theme.Color.IconButtonHover else Theme.Color.IconButton
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Body,
		TextSize = 15,
		TextColor3 = Theme.Color.ButtonText,
		Text = "\u{2699}", -- engrenagem (⚙) — abre a tela de configurações
		TextYAlignment = Enum.TextYAlignment.Center,

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },

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
		Size = UDim2.new(1, -2 * Theme.Layout.Padding, 0, CONNECT_ROW_HEIGHT),
		Position = UDim2.new(0, Theme.Layout.Padding, 0, CONNECT_ROW_Y),
		BackgroundTransparency = 1,

		connectButton,
		gearButton,
	}
end

-- --------------------------------------------------------- cabeçalho da tabela

local function TableHeader()
	return vide.create "Frame" {
		Name = "TableHeader",
		Position = UDim2.new(0, Theme.Layout.Padding, 0, HEADER_Y),
		Size = UDim2.new(1, -2 * Theme.Layout.Padding, 0, HEADER_HEIGHT),
		BackgroundTransparency = 1,

		vide.create "TextLabel" {
			Size = UDim2.new(USER_COLUMN_SCALE, -ROW_LEADING_INSET, 1, 0),
			Position = UDim2.new(0, ROW_LEADING_INSET, 0, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Bold,
			TextSize = 12,
			TextColor3 = Theme.Color.TableHeaderText,
			TextXAlignment = Enum.TextXAlignment.Left,
			Text = "USER",
		},
		vide.create "TextLabel" {
			Size = UDim2.new(1 - USER_COLUMN_SCALE, -8, 1, 0),
			Position = UDim2.new(USER_COLUMN_SCALE, 0, 0, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Bold,
			TextSize = 12,
			TextColor3 = Theme.Color.TableHeaderText,
			TextXAlignment = Enum.TextXAlignment.Left,
			Text = "INFO",
		},
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
	return vide.create "Frame" {
		Name = "Row",
		Size = UDim2.new(1, 0, 0, Theme.Layout.RowHeight),
		LayoutOrder = function()
			return rowSource().joinSequence
		end,
		BackgroundColor3 = function()
			return if rowSource().joinSequence % 2 == 0
				then Theme.Color.RowBackgroundEven
				else Theme.Color.RowBackgroundOdd
		end,
		BorderSizePixel = 0,

		-- Bolinha de líder: SEMPRE criada (mesmo espaço reservado em toda
		-- linha, líder ou não — alinhamento consistente do nome entre
		-- linhas), só a visibilidade é reativa (spec: "bolinha... só quando
		-- aquela sessão é a líder atual; sem bolinha nas demais linhas").
		vide.create "Frame" {
			Name = "LeaderDot",
			Size = UDim2.fromOffset(8, 8),
			Position = UDim2.new(0, 8, 0.5, -4),
			BackgroundColor3 = Theme.Color.LeaderDot,
			BorderSizePixel = 0,
			Visible = function()
				return rowSource().isLeader
			end,

			vide.create "UICorner" { CornerRadius = UDim.new(1, 0) },
		},
		vide.create "TextLabel" {
			Name = "Username",
			Size = UDim2.new(USER_COLUMN_SCALE, -ROW_LEADING_INSET, 1, 0),
			Position = UDim2.new(0, ROW_LEADING_INSET, 0, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Body,
			TextSize = 13,
			TextColor3 = Theme.Color.RowText,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = function()
				return rowSource().username
			end,
		},
		vide.create "TextLabel" {
			Name = "Info",
			Size = UDim2.new(1 - USER_COLUMN_SCALE, -8, 1, 0),
			Position = UDim2.new(USER_COLUMN_SCALE, 0, 0, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Body,
			TextSize = 13,
			TextColor3 = Theme.Color.RowInfoText,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextTruncate = Enum.TextTruncate.AtEnd,
			Text = function()
				return rowSource().info
			end,
		},
	}
end

local function SessionsTable(state)
	return vide.create "ScrollingFrame" {
		Name = "SessionsTable",
		Position = UDim2.new(0, Theme.Layout.Padding, 0, TABLE_Y),
		Size = UDim2.new(1, -2 * Theme.Layout.Padding, 1, -TABLE_Y - Theme.Layout.Padding),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.Color.LabelMuted,
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

local function MainView(state, callbacks)
	return vide.create "Frame" {
		Name = "MainView",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,

		TitleBar("SYNC TEAM"),
		PortRow(state, callbacks),
		ConnectRow(state, callbacks),
		TableHeader(),
		SessionsTable(state),
	}
end

-- -------------------------------------------------------------- settings view

local function SettingsRow(labelText, control, isDisabled)
	return vide.create "Frame" {
		Size = UDim2.new(1, 0, 0, 30),
		BackgroundTransparency = 1,

		vide.create "TextLabel" {
			Size = UDim2.new(0.62, 0, 1, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Body,
			TextSize = 13,
			TextColor3 = if isDisabled then Theme.Color.DisabledText else Theme.Color.FieldText,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextWrapped = true,
			Text = labelText,
		},
		control,
	}
end

-- Única opção real desta fatia (spec da tarefa): liga/desliga o toast; o log
-- no Output NUNCA é condicionado a isso (Logger.notify sempre loga, ver
-- Logger.luau) — só a exibição visual passa por aqui.
local function NotificationsToggle(state, callbacks)
	local hovered = vide.source(false)
	return vide.create "TextButton" {
		Name = "NotificationsToggle",
		Size = UDim2.new(0.38, 0, 1, -6),
		Position = UDim2.new(0.62, 0, 0, 3),
		BackgroundColor3 = function()
			return if hovered() then Theme.Color.IconButtonHover else Theme.Color.IconButton
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Body,
		TextSize = 12,
		TextColor3 = Theme.Color.ButtonText,
		Text = function()
			return if state.notificationsEnabled() then "Ativado" else "Desativado"
		end,

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },

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
end

-- Itens "em breve" (spec da tarefa: desabilitados, sem funcionalidade real
-- nesta fatia) — texto estático à direita, sem controle nenhum.
local DISABLED_SETTINGS = {
	"Nome de exibição customizado",
	"Containers observados",
	"Nível de log",
}

local function DisabledSettingRow(labelText)
	return SettingsRow(
		labelText,
		vide.create "TextLabel" {
			Size = UDim2.new(0.38, 0, 1, 0),
			Position = UDim2.new(0.62, 0, 0, 0),
			BackgroundTransparency = 1,
			Font = Theme.Font.Body,
			TextSize = 12,
			TextColor3 = Theme.Color.DisabledText,
			TextXAlignment = Enum.TextXAlignment.Right,
			Text = "em breve",
		},
		true
	)
end

local function SettingsView(state, callbacks)
	local backHovered = vide.source(false)
	local backButton = vide.create "TextButton" {
		Name = "BackButton",
		Size = UDim2.fromOffset(Theme.Layout.IconButtonSize, Theme.Layout.IconButtonSize),
		Position = UDim2.new(0, Theme.Layout.Padding, 0.5, -Theme.Layout.IconButtonSize / 2),
		BackgroundColor3 = function()
			return if backHovered() then Theme.Color.IconButtonHover else Theme.Color.IconButton
		end,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.Font.Body,
		TextSize = 14,
		TextColor3 = Theme.Color.ButtonText,
		Text = "\u{2190}", -- seta pra esquerda (←) — volta pra tela principal

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },

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

	local titleBar = vide.create "Frame" {
		Name = "TitleBar",
		Size = UDim2.new(1, 0, 0, TITLE_HEIGHT),
		BackgroundColor3 = Theme.Color.TitleBar,
		BorderSizePixel = 0,

		vide.create "TextLabel" {
			Size = UDim2.fromScale(1, 1),
			BackgroundTransparency = 1,
			Font = Theme.Font.Title,
			TextSize = 16,
			TextColor3 = Theme.Color.TitleText,
			Text = "CONFIGURAÇÕES",
		},
		backButton,
	}

	return vide.create "Frame" {
		Name = "SettingsView",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,

		titleBar,
		vide.create "Frame" {
			Name = "SettingsBody",
			Position = UDim2.new(0, Theme.Layout.Padding, 0, TITLE_HEIGHT + ROW_GAP),
			Size = UDim2.new(1, -2 * Theme.Layout.Padding, 1, -(TITLE_HEIGHT + ROW_GAP + Theme.Layout.Padding)),
			BackgroundTransparency = 1,

			vide.create "UIListLayout" {
				SortOrder = Enum.SortOrder.LayoutOrder,
				Padding = UDim.new(0, 4),
			},

			SettingsRow("Mostrar notificações", NotificationsToggle(state, callbacks), false),
			DisabledSettingRow(DISABLED_SETTINGS[1]),
			DisabledSettingRow(DISABLED_SETTINGS[2]),
			DisabledSettingRow(DISABLED_SETTINGS[3]),
		},
	}
end

-- ------------------------------------------------------------------- root

-- Constrói a árvore inteira (main view + settings view, trocadas por
-- vide.switch olhando state.view — NUNCA um segundo DockWidgetPluginGui,
-- spec da tarefa) e devolve o rootFrame. Quem chama (PluginUI.luau) parenta
-- rootFrame dentro do DockWidgetPluginGui. O toast de notificação NÃO é mais
-- criado aqui: virou um ScreenGui flutuante independente em CoreGui (ver
-- Toast.luau), montado por PluginUI.init fora deste vide.mount.
function StatusPanel.build(state, callbacks)
	return vide.create "Frame" {
		Name = "SyncTeamRoot",
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		-- Higiene de painel: nada deve desenhar fora dos limites do widget.
		-- (Antes este clip também servia ao truque de slide-in do toast, que
		-- vivia aqui dentro; o toast agora é um ScreenGui livre em CoreGui e o
		-- clip só permanece por bom senso de layout.)
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
