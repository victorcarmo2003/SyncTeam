-- SyncTeam — Notificação flutuante (ScreenGui em CoreGui) do plugin (M4.5+)
--
-- Substitui o toast antigo, que vivia DENTRO do DockWidgetPluginGui do painel
-- sob a premissa (confirmada ERRADA por pesquisa) de que plugin de Studio só
-- tem DockWidgetPluginGui como superfície de UI. A pesquisa
-- (.claude/research/2026-07-15-plugin-floating-overlay-notification.md)
-- confirmou — inclusive no código-fonte público do Rojo — que um plugin PODE
-- criar um `ScreenGui` parentado direto em `game:GetService("CoreGui")`,
-- flutuando LIVREMENTE sobre o Studio (mesma técnica do popup do Rojo). Este
-- módulo cria esse ScreenGui + um Frame de aviso com botão de fechar (✕, canto
-- superior direito) que some sozinho depois de HOLD_SECONDS (5s, item 2 da
-- tarefa; era 4.5s no toast antigo).
--
-- Independente do painel: aparece por conta própria, sem precisar mais forçar o
-- DockWidgetPluginGui a abrir (ver PluginUI.notify). Ressalva registrada na
-- pesquisa (a validar em teste real): o overlay via CoreGui provavelmente só
-- cobre a área do viewport 3D, não os painéis nativos (Explorer/Properties/
-- Output). O log no Output (Logger.notify, incondicional) continua sendo o
-- registro GARANTIDO de todo evento notificável.
--
-- SEM reatividade Vide: `vide.create` é usado só para montar Instances com
-- props ESTÁTICAS (estilo consistente via Theme) — o texto é setado
-- imperativamente em `show()`, o hover do ✕ idem, e a animação é
-- TweenService + task.delay. Assim este módulo NÃO depende de um escopo
-- `vide.root()`/`vide.mount` ativo (é criado direto por PluginUI.init, FORA do
-- vide.mount do painel), evitando o erro "effect() outside stable scope" que
-- confinava a versão anterior à árvore reativa do painel. (Eventos como
-- MouseEnter/Activated são apenas conexões de sinal — não criam effect, não
-- exigem escopo; só props com VALOR-função exigiriam.)
--
-- Só 1 notificação por vez (sem fila): uma nova chamada de `show()` reinicia
-- texto/tween/timer. Token de geração garante que um auto-dismiss antigo não
-- feche por cima de um `show()` mais novo, e que o botão fechar cancele o
-- auto-dismiss pendente.
--
-- Ciclo de vida: CoreGui persiste entre reloads do plugin (NÃO é auto-limpo
-- como o DockWidgetPluginGui) — por isso `mount()` faz self-heal (destrói um
-- ScreenGui vazado de um load anterior) e devolve `destroy()` para
-- PluginUI.stop() chamar em plugin.Unloading (mesma disciplina do vazamento de
-- WebStreamClient documentado em docs/DECISIONS.md).

local TweenService = game:GetService("TweenService")
local CoreGui = game:GetService("CoreGui")

local vide = require(script.Parent.Parent.Packages.Vide)
local Theme = require(script.Parent.Theme)

local Toast = {}

local WIDTH = 300
local HEIGHT = 64
local MARGIN = 16
local ENTER_SECONDS = 0.28
local EXIT_SECONDS = 0.22
local HOLD_SECONDS = 5 -- item 2 da tarefa: era 4.5 no toast antigo, agora 5

local SCREEN_GUI_NAME = "SyncTeamNotifications"

-- Ancorado no canto inferior-direito da tela (AnchorPoint 1,1). "Escondido" =
-- empurrado além da borda direita pela própria largura + margem; como a
-- posição é relativa à borda (Scale X = 1), o ScreenGui de tela cheia recorta
-- a parte fora e o slide-in funciona sem precisar de ClipsDescendants.
local HIDDEN_POSITION = UDim2.new(1, WIDTH + MARGIN + 40, 1, -MARGIN)
local VISIBLE_POSITION = UDim2.new(1, -MARGIN, 1, -MARGIN)

-- Cria o ScreenGui em CoreGui + o Frame de toast (oculto, fora da borda
-- direita) e devolve { show = function(text: string), destroy = function() }.
-- Chamado 1x por PluginUI.init, fora do vide.mount do painel.
function Toast.mount()
	-- Self-heal: remove um ScreenGui vazado de um load anterior do plugin
	-- (CoreGui não é limpo automaticamente ao recarregar o plugin — ao
	-- contrário do DockWidgetPluginGui, que o Studio gerencia).
	local existing = CoreGui:FindFirstChild(SCREEN_GUI_NAME)
	if existing then
		existing:Destroy()
	end

	-- Forward-declaradas: os handlers (tween/dismiss/hover) capturam estes
	-- upvalues, que já estarão atribuídos quando qualquer evento disparar (só
	-- ocorrem depois que este mount() inteiro já retornou).
	local frame
	local screenGui
	local currentToken = 0

	local function tweenTo(position, seconds, direction)
		TweenService:Create(
			frame,
			TweenInfo.new(seconds, Enum.EasingStyle.Quad, direction),
			{ Position = position }
		):Play()
	end

	-- Fecha imediatamente e invalida qualquer auto-dismiss pendente (bump de
	-- token, mesmo mecanismo do timer de show) — usado pelo botão ✕.
	local function dismiss()
		currentToken += 1
		tweenTo(HIDDEN_POSITION, EXIT_SECONDS, Enum.EasingDirection.In)
	end

	local textLabel = vide.create "TextLabel" {
		Name = "Text",
		Size = UDim2.new(1, -44, 1, -16), -- -44: deixa folga à direita pro botão ✕
		Position = UDim2.new(0, 14, 0, 8),
		BackgroundTransparency = 1,
		Font = Theme.Font.Body,
		TextSize = 14,
		TextColor3 = Theme.Color.ToastText,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
		TextWrapped = true,
		Text = "",
	}

	local closeButton
	closeButton = vide.create "TextButton" {
		Name = "Close",
		Size = UDim2.fromOffset(20, 20),
		Position = UDim2.new(1, -6, 0, 6),
		AnchorPoint = Vector2.new(1, 0),
		BackgroundTransparency = 1,
		AutoButtonColor = false,
		Font = Theme.Font.Bold,
		TextSize = 16,
		TextColor3 = Theme.Color.ToastCloseIdle,
		Text = "\u{2715}", -- ✕ (fechar)

		-- Hover imperativo (sem vide.source, para não exigir escopo reativo).
		MouseEnter = function()
			closeButton.TextColor3 = Theme.Color.ToastCloseHover
		end,
		MouseLeave = function()
			closeButton.TextColor3 = Theme.Color.ToastCloseIdle
		end,
		Activated = function()
			dismiss()
		end,
	}

	frame = vide.create "Frame" {
		Name = "SyncTeamToast",
		Size = UDim2.fromOffset(WIDTH, HEIGHT),
		AnchorPoint = Vector2.new(1, 1),
		Position = HIDDEN_POSITION,
		BackgroundColor3 = Theme.Color.ToastBackground,
		BorderSizePixel = 0,
		ZIndex = 100,

		vide.create "UICorner" { CornerRadius = Theme.Layout.CornerRadius },
		vide.create "Frame" {
			Name = "Accent",
			Size = UDim2.new(0, 4, 1, 0),
			BackgroundColor3 = Theme.Color.ToastAccent,
			BorderSizePixel = 0,
		},
		textLabel,
		closeButton,
	}

	screenGui = vide.create "ScreenGui" {
		Name = SCREEN_GUI_NAME,
		ResetOnSpawn = false,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
		DisplayOrder = 100, -- por cima de outros ScreenGuis (mesmo valor do Rojo)
		IgnoreGuiInset = true,

		frame,
	}
	screenGui.Parent = CoreGui

	local function show(text)
		currentToken += 1
		local myToken = currentToken
		textLabel.Text = text

		TweenService:Create(
			frame,
			TweenInfo.new(ENTER_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
			{ Position = VISIBLE_POSITION }
		):Play()

		task.delay(HOLD_SECONDS, function()
			if currentToken ~= myToken then
				return -- um show()/dismiss() mais novo já assumiu; deixa o dele terminar
			end
			TweenService:Create(
				frame,
				TweenInfo.new(EXIT_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
				{ Position = HIDDEN_POSITION }
			):Play()
		end)
	end

	-- Chamado por PluginUI.stop() em plugin.Unloading — destrói o ScreenGui de
	-- CoreGui (que não seria limpo sozinho). Bump de token para não deixar um
	-- auto-dismiss pendente tocar tween num Frame já destruído.
	local function destroy()
		currentToken += 1
		pcall(function()
			screenGui:Destroy()
		end)
	end

	return { show = show, destroy = destroy }
end

return Toast
