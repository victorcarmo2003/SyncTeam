-- SyncTeam — Notificação flutuante (ScreenGui em CoreGui) do plugin (M4.5+)
--
-- Substitui o toast antigo, que vivia DENTRO do DockWidgetPluginGui do painel
-- sob a premissa (confirmada ERRADA por pesquisa) de que plugin de Studio só
-- tem DockWidgetPluginGui como superfície de UI. A pesquisa
-- (.claude/research/2026-07-15-plugin-floating-overlay-notification.md)
-- confirmou — inclusive no código-fonte público do Rojo — que um plugin PODE
-- criar um `ScreenGui` parentado direto em `game:GetService("CoreGui")`,
-- flutuando LIVREMENTE sobre o Studio (mesma técnica do popup do Rojo). Este
-- módulo cria esse ScreenGui + um Frame de aviso com botão de fechar ("X",
-- canto superior direito — ver item 3 da tarefa 2026-07-21 mais abaixo) que
-- some sozinho depois de HOLD_SECONDS (5s, item 2 da tarefa; era 4.5s no
-- toast antigo).
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
-- imperativamente em `show()`, o hover do botão de fechar idem, e a animação é
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
--
-- 2026-08-02 (5ª rodada, aprovado no mockup design-preview/): redesenho
-- visual — antes o frame era UMA faixa (fundo único + aba/"Accent" de 4px
-- colorida à esquerda + botão X FLUTUANDO por cima do texto via
-- `Position = UDim2.new(1,-6,0,6)` sem reservar espaço no layout). Agora são
-- DUAS faixas verticais empilhadas, reproduzindo a mesma estrutura de
-- título+corpo do próprio painel (`Theme.Color.TitleBar` + fundo, ver
-- StatusPanel.TitleBar): a faixa de cima ("SYNC TEAM" + X, dentro do fluxo
-- normal — nenhum dos dois flutua por cima do outro) muda de cor conforme a
-- SEVERIDADE (`Toast.show(text, severity)`, novo 2º parâmetro OPCIONAL,
-- default `"info"` — chamadores existentes que só passam `text` continuam
-- funcionando sem editar nada); a faixa de baixo é o corpo da mensagem, fundo
-- neutro. Cores reaproveitadas das MESMAS 3 já usadas por ConnectRow
-- (`Theme.Color.ConnectIdle`/`ConnectConnecting`/`ConnectActive` — nenhuma
-- cor nova) e `Theme.Color.FieldBackground` do corpo (mesmo do portBox) — ver
-- `Theme.luau` para o comentário atualizado. Cantos retos (sem `UICorner`),
-- igual ao `.st-titlebar` do painel principal — o frame do toast antes tinha
-- `UICorner`, removido. O Frame "Accent" também foi removido (a cor de
-- severidade agora vive inteira na faixa de cima, sem precisar de uma aba
-- lateral separada).
--
-- 2026-08-02 (7ª rodada — reskin "Modux Companion", ver Theme.luau):
-- paleta/tokens do parágrafo acima foram SUBSTITUÍDOS (`ConnectIdle`/
-- `ConnectConnecting`/`ConnectActive`/`FieldBackground`/`ToastText`/
-- `Font.Title`/`Font.Body` não existem mais no Theme) — ver SEVERITY_STYLE
-- abaixo para o mapeamento atual (4 severidades: sucesso/aviso/erro em
-- `*Strong` + texto branco, "info" com fundo `SubText` + texto PRETO,
-- única exceção). Texto de título e corpo também passaram a centralizado +
-- negrito (princípio 3 do reskin).
--
-- Item 1 da tarefa 2026-07-21 (causa raiz de "o som nunca toca"): confirmado
-- contra a documentação oficial do Studio que, em modo Edit (fora de Play/Run
-- testing), o Studio só reproduz `Sound` quando a Instance é descendente do
-- `DockWidgetPluginGui` do PRÓPRIO plugin — um `Sound` parentado num
-- `ScreenGui` de `CoreGui` (o mesmo usado pelo toast visual acima) é
-- silenciosamente ignorado fora de Play/Run. Por isso `Toast.mount(pluginObject)`
-- passou a receber `pluginObject` (mesmo parâmetro que `PluginUI.init` já
-- recebe) e cria, 1x, um `DockWidgetPluginGui` "dummy" — sempre
-- `Enabled = false`, dimensões triviais, nunca aberto pelo usuário — que serve
-- SÓ como parent legal para o `Sound` de notificação (ver `soundWidget` e
-- `playNotificationSound` abaixo). Nada na UI visível do toast muda; é só o
-- destino do `Sound.Parent`.

local TweenService = game:GetService("TweenService")
local CoreGui = game:GetService("CoreGui")
local Debris = game:GetService("Debris")

local vide = require(script.Parent.Parent.Packages.Vide)
local Theme = require(script.Parent.Theme)
local Logger = require(script.Parent.Parent.Logger)
local log = Logger.log

local Toast = {}

local WIDTH = 300
-- 2026-08-02 (5ª rodada): duas faixas empilhadas — TITLE_BAND_HEIGHT reusa a
-- MESMA constante da barra de título do painel principal (Theme.Layout.
-- TitleBarHeight), para o toast ler como a mesma linguagem visual do resto
-- do produto; BODY_HEIGHT é decisão de layout desta tarefa (espaço suficiente
-- pra 2-3 linhas de mensagem curta, mesma leitura de antes).
local TITLE_BAND_HEIGHT = Theme.Layout.TitleBarHeight
local BODY_HEIGHT = 48
local HEIGHT = TITLE_BAND_HEIGHT + BODY_HEIGHT
local MARGIN = 16
local ENTER_SECONDS = 0.28
local EXIT_SECONDS = 0.22
local HOLD_SECONDS = 5 -- item 2 da tarefa: era 4.5 no toast antigo, agora 5

local SCREEN_GUI_NAME = "SyncTeamNotifications"

-- Severidade do toast (2026-08-02, 7ª rodada — reskin "Modux Companion",
-- substitui o esquema de 3 cores da 5ª rodada) — decide a cor de FUNDO e de
-- TEXTO da faixa de título; `Toast.show(text, severity)` tem `severity`
-- OPCIONAL, default "info". 4 severidades agora (fonte de verdade:
-- design-preview/styles.css, `.st-toast__titlebar[data-severity=...]`):
-- "sucesso"/"aviso"/"erro" usam a cor `*Strong` correspondente + texto branco
-- (Theme.Color.ButtonText); "info" é a ÚNICA exceção à regra de texto
-- branco — fundo claro neutro (Theme.Color.SubText) + texto PRETO
-- (Theme.Color.ToastInfoText), reservada pro caso genérico/sem severidade
-- reconhecida. `resolveSeverityStyle` cai para "info" tanto quando
-- `severity` é `nil` (chamador antigo, só passou `text`) quanto quando é uma
-- string desconhecida (defensivo).
local DEFAULT_SEVERITY = "info"
local SEVERITY_STYLE = {
	info = { background = Theme.Color.SubText, text = Theme.Color.ToastInfoText },
	sucesso = { background = Theme.Color.GreenStrong, text = Theme.Color.ButtonText },
	aviso = { background = Theme.Color.YellowStrong, text = Theme.Color.ButtonText },
	erro = { background = Theme.Color.RedStrong, text = Theme.Color.ButtonText },
}

local function resolveSeverityStyle(severity)
	return SEVERITY_STYLE[severity] or SEVERITY_STYLE[DEFAULT_SEVERITY]
end

-- Item 2 da tarefa 2026-07-21: nenhum código de Sound existia neste plugin
-- (grep em plugin/src inteiro sem resultado) — som nunca tocava porque nunca
-- foi implementado, não por um bug de wiring. Continua 1 som só, tocado em
-- TODA chamada de show() independente da severidade (2026-08-02, 5ª rodada,
-- introduziu variação de COR por severidade, não de som) — sem tabela por
-- nível como o ModuxWatcher tem hoje (id reaproveitado de lá,
-- ModuxWatcher/studio-plugin/src/Companion/Toast.luau linha 11, já
-- vetted pelo mesmo autor para esse mesmo uso "notification genérica").
local NOTIFICATION_SOUND_ID = "rbxassetid://131039887376992"

-- Ancorado no canto inferior-direito da tela (AnchorPoint 1,1). "Escondido" =
-- empurrado além da borda direita pela própria largura + margem; como a
-- posição é relativa à borda (Scale X = 1), o ScreenGui de tela cheia recorta
-- a parte fora e o slide-in funciona sem precisar de ClipsDescendants.
local HIDDEN_POSITION = UDim2.new(1, WIDTH + MARGIN + 40, 1, -MARGIN)
local VISIBLE_POSITION = UDim2.new(1, -MARGIN, 1, -MARGIN)

-- Cria o ScreenGui em CoreGui + o Frame de toast (oculto, fora da borda
-- direita) e devolve
-- { show = function(text: string, severity: ("info"|"aviso"|"erro")?), destroy = function() }.
-- `severity` é OPCIONAL (default "info", ver resolveSeverityColor acima) —
-- chamadas existentes que só passam `text` continuam funcionando sem editar
-- nada. Chamado 1x por PluginUI.init, fora do vide.mount do painel. `pluginObject` é
-- o mesmo parâmetro recebido por PluginUI.init — usado aqui SÓ para criar o
-- DockWidgetPluginGui dummy exigido pelo Studio como parent legal de `Sound`
-- em modo Edit (ver comentário no cabeçalho do arquivo, item 1 da tarefa
-- 2026-07-21).
-- Handle do ÚLTIMO Toast.mount() bem-sucedido — permite `Toast.show(...)`
-- ESTÁTICO (2026-08-02, 5ª rodada: init.server.luau chama Toast.show direto
-- na resposta de erro do ReSync, deliberadamente por FORA de PluginUI.notify/
-- toastHandle, pra sempre aparecer independente da preferência "Mostrar
-- notificações" — ver handleResyncResult) sem cada chamador precisar guardar/
-- repassar o handle retornado por mount(). Mesmo padrão já usado por Logger
-- (Logger.init guarda estado interno; chamadas estáticas subsequentes usam
-- esse estado) — só 1 instância montada por vez faz sentido aqui (o próprio
-- ScreenGui em CoreGui já é single-instance, ver self-heal abaixo).
local activeToast = nil -- { show, destroy }

function Toast.mount(pluginObject)
	-- Self-heal: remove um ScreenGui vazado de um load anterior do plugin
	-- (CoreGui não é limpo automaticamente ao recarregar o plugin — ao
	-- contrário do DockWidgetPluginGui, que o Studio gerencia).
	local existing = CoreGui:FindFirstChild(SCREEN_GUI_NAME)
	if existing then
		existing:Destroy()
	end

	-- Forward-declaradas: os handlers (tween/dismiss/hover) capturam estes
	-- upvalues, que já estarão atribuídos quando qualquer evento disparar (só
	-- ocorrem depois que este mount() inteiro já retornou). `titleBarFrame`/
	-- `titleText` (2026-08-02): `show()` precisa mudar fundo E cor do texto
	-- da faixa de título conforme a severidade a cada chamada (4 severidades,
	-- "info" é a única com texto preto — ver SEVERITY_STYLE acima).
	local frame
	local titleBarFrame
	local titleText
	local screenGui
	local currentToken = 0
	local soundWidget = nil

	local function tweenTo(position, seconds, direction)
		TweenService:Create(frame, TweenInfo.new(seconds, Enum.EasingStyle.Quad, direction), { Position = position })
			:Play()
	end

	-- Fecha imediatamente e invalida qualquer auto-dismiss pendente (bump de
	-- token, mesmo mecanismo do timer de show) — usado pelo botão de fechar.
	local function dismiss()
		currentToken += 1
		tweenTo(HIDDEN_POSITION, EXIT_SECONDS, Enum.EasingDirection.In)
	end

	-- Item 2 da tarefa 2026-07-21: toca o som de notificação toda vez que um
	-- toast é exibido (show(), abaixo). API de plataforma nova (Sound/Debris)
	-- em pcall (.claude/rules/luau.md) — uma falha aqui (asset removido,
	-- SoundService desabilitado etc.) nunca pode impedir o toast visual de
	-- aparecer. `Debris:AddItem(sound, 6)` garante o cleanup da Instance sem
	-- precisar de um handle/lista própria (mesmo padrão do ModuxWatcher).
	local function playNotificationSound()
		if soundWidget == nil then
			return
		end
		pcall(function()
			local sound = Instance.new("Sound")
			sound.SoundId = NOTIFICATION_SOUND_ID
			sound.Volume = 0.55
			sound.Parent = soundWidget
			sound:Play()
			Debris:AddItem(sound, 6)
		end)
	end

	-- Corpo da mensagem (faixa de baixo) — mesmo TextLabel de sempre, só
	-- reposicionado abaixo da faixa de título (2026-08-02, 5ª rodada): antes
	-- ocupava o frame inteiro (menos a folga do X flutuante), agora ocupa só
	-- BODY_HEIGHT, abaixo de TITLE_BAND_HEIGHT. Sem folga extra à direita —
	-- o X não flutua mais por cima do texto, mora na faixa de cima.
	-- 2026-08-02 (7ª rodada): texto centralizado + negrito (princípio 3 do
	-- reskin), fonte Rounded (era Body, removida do Theme), cor Text (era
	-- ToastText, removida do Theme) — mockup: `.st-toast__body` é
	-- `text-align:center; font-weight:700`.
	local textLabel = vide.create "TextLabel" {
		Name = "Text",
		Size = UDim2.new(1, -28, 0, BODY_HEIGHT - 20),
		Position = UDim2.new(0, 14, 0, TITLE_BAND_HEIGHT + 10),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 14,
		TextColor3 = Theme.Color.Text,
		TextXAlignment = Enum.TextXAlignment.Center,
		TextYAlignment = Enum.TextYAlignment.Center,
		TextWrapped = true,
		Text = "",
	}
	Theme.applyBold(textLabel)

	-- Botão de fechar — agora DENTRO do fluxo da faixa de título (não mais
	-- floating por cima do texto). Cor segue `resolveSeverityStyle(...).text`
	-- (branco nas 3 severidades coloridas, preto no fallback "info") —
	-- ToastCloseIdle/Hover (cinza sobre cinza) não faziam mais sentido aqui e
	-- foram removidos do Theme. Hover vira leve transparência (opacity ~0.75
	-- do mockup) em vez de troca de cor.
	local closeButton
	closeButton = vide.create "TextButton" {
		Name = "Close",
		Size = UDim2.fromOffset(22, 22),
		Position = UDim2.new(1, -6, 0, (TITLE_BAND_HEIGHT - 22) / 2),
		AnchorPoint = Vector2.new(1, 0),
		BackgroundTransparency = 1,
		AutoButtonColor = false,
		-- Item 3 da tarefa 2026-07-21: "\u{2715}" (✕ Unicode) renderizava como
		-- tofu/glifo quebrado no Studio — trocado por um "X" ASCII literal,
		-- que qualquer fonte do Studio sabe desenhar. Enum.Font.FredokaOne
		-- confirmado como nome exato do item no Font enum atual (consulta à
		-- documentação oficial, 2026-07-21: create.roblox.com/docs/reference/
		-- engine/enums/Font lista "FredokaOne" entre os itens válidos) — já é
		-- visualmente bold por design, sem precisar de Theme.Font.Bold aqui.
		Font = Enum.Font.FredokaOne,
		TextSize = 16,
		-- Segue a cor de texto da severidade ATUAL (branco nas 3 coloridas,
		-- preto no fallback "info") — valor inicial aqui é só o default antes
		-- da 1ª chamada de show(); show() atualiza a cada exibição.
		TextColor3 = resolveSeverityStyle(DEFAULT_SEVERITY).text,
		TextTransparency = 0,
		Text = "X", -- fechar

		-- Hover imperativo (sem vide.source, para não exigir escopo reativo).
		MouseEnter = function()
			closeButton.TextTransparency = 0.25
		end,
		MouseLeave = function()
			closeButton.TextTransparency = 0
		end,
		Activated = function()
			dismiss()
		end,
	}

	-- Faixa de cima ("SYNC TEAM" + X) — fundo e cor de texto são setados por
	-- severidade dentro de show() (resolveSeverityStyle); valores iniciais
	-- aqui são só o default "info" antes da primeira chamada de show().
	-- 2026-08-02 (7ª rodada): texto centralizado (era Left) + negrito, fonte
	-- Rounded (era Font.Title, removida do Theme) — mockup:
	-- `.st-toast__titlebar { justify-content:center; text-align:center;
	-- font-weight:700 }`. `Size` volta a ocupar a largura toda (era `-34` de
	-- folga fixa pro X) porque o X agora é posicionado ABSOLUTO por cima via
	-- AnchorPoint/Position (mesmo truque do CSS `position:absolute` +
	-- `justify-content:center` no pai) — center de verdade precisa considerar
	-- a largura inteira do frame, não só o espaço "sobrando" à esquerda do X.
	titleText = vide.create "TextLabel" {
		Name = "Title",
		Size = UDim2.fromScale(1, 1),
		BackgroundTransparency = 1,
		Font = Theme.Font.Rounded,
		TextSize = 15,
		TextColor3 = resolveSeverityStyle(DEFAULT_SEVERITY).text,
		TextXAlignment = Enum.TextXAlignment.Center,
		Text = "SYNC TEAM",
	}
	Theme.applyBold(titleText)

	titleBarFrame = vide.create "Frame" {
		Name = "TitleBar",
		Size = UDim2.new(1, 0, 0, TITLE_BAND_HEIGHT),
		Position = UDim2.fromOffset(0, 0),
		BackgroundColor3 = resolveSeverityStyle(DEFAULT_SEVERITY).background,
		BorderSizePixel = 0,

		titleText,
		closeButton,
	}

	-- Frame raiz — cantos RETOS (sem UICorner, igual ao .st-titlebar/
	-- .st-panel do painel principal); fundo é Theme.Color.Background (fundo
	-- ÚNICO do reskin, era Theme.Color.FieldBackground, removida — a faixa de
	-- cima cobre a área de cima com a cor de severidade, então o fundo do
	-- frame raiz só aparece mesmo na faixa de baixo/corpo). "Accent" removido
	-- — a cor de severidade vive inteira na faixa de título.
	frame = vide.create "Frame" {
		Name = "SyncTeamToast",
		Size = UDim2.fromOffset(WIDTH, HEIGHT),
		AnchorPoint = Vector2.new(1, 1),
		Position = HIDDEN_POSITION,
		BackgroundColor3 = Theme.Color.Background,
		BorderSizePixel = 0,
		ZIndex = 100,

		titleBarFrame,
		textLabel,
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

	-- Item 1 da tarefa 2026-07-21 (ver cabeçalho do arquivo): DockWidgetPluginGui
	-- dummy, único propósito é ser parent legal de `Sound` em modo Edit — nunca
	-- deve abrir/ficar visível. API de plataforma nova (DockWidgetPluginGuiInfo/
	-- CreateDockWidgetPluginGui) em pcall (.claude/rules/luau.md); falha aqui
	-- degrada para "toast visual funciona, som fica mudo" (ver guard em
	-- playNotificationSound abaixo), nunca derruba o toast inteiro.
	local okSoundWidget, errSoundWidget = pcall(function()
		local widgetInfo = DockWidgetPluginGuiInfo.new(
			Enum.InitialDockState.Float,
			false, -- initialEnabled: nunca deve abrir sozinho
			true, -- overrideEnabledRestore: força fechado TODA sessão, mesmo se
			-- o Studio tiver persistido um estado diferente (ao contrário
			-- do widget do painel em PluginUI.luau, que respeita o estado
			-- salvo do usuário de propósito)
			10,
			10,
			10,
			10 -- dimensões triviais: nunca deve ficar visível de verdade
		)
		soundWidget = pluginObject:CreateDockWidgetPluginGui("SyncTeamSoundPlayer", widgetInfo)
		soundWidget.Name = "SyncTeamSoundPlayer"
		soundWidget.Title = "SyncTeam Sound" -- distinto do título do painel ("SyncTeam")
		soundWidget.Enabled = false -- defensivo/redundante com override acima
	end)
	if not okSoundWidget then
		log(
			"toast: falha ao criar widget dummy p/ Sound (Edit mode); som de notificação ficará mudo:",
			tostring(errSoundWidget)
		)
	end

	-- `severity` OPCIONAL (2026-08-02) — default "info" via
	-- resolveSeverityStyle, então chamadas antigas que só passam `text`
	-- continuam funcionando sem qualquer ajuste no chamador. 4 severidades
	-- agora (7ª rodada): atualiza fundo E cor de texto da faixa (título +
	-- close), já que "info" é a exceção com texto preto.
	local function show(text, severity)
		currentToken += 1
		local myToken = currentToken
		textLabel.Text = text
		local style = resolveSeverityStyle(severity)
		titleBarFrame.BackgroundColor3 = style.background
		titleText.TextColor3 = style.text
		closeButton.TextColor3 = style.text
		playNotificationSound()

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

	local handle = { show = show, destroy = destroy }
	activeToast = handle
	return handle
end

-- Chamada ESTÁTICA de conveniência (2026-08-02, 5ª rodada) — ver comentário de
-- `activeToast` acima. Encaminha direto para o `show` da instância montada,
-- SEM nenhum gate de preferência (isso é responsabilidade de quem chama:
-- PluginUI.notify já checa notificationsEnabledSource ANTES de usar
-- toastHandle.show; init.server.luau usa Toast.show deliberadamente por fora
-- desse caminho quando quer uma notificação sempre visível). Nunca lança se
-- ainda não montado (ex.: PluginUI.init falhou/ainda não rodou) — só loga e
-- descarta, mesma disciplina defensiva do resto da UI do plugin.
function Toast.show(text, severity)
	if activeToast == nil then
		log("Toast.show chamado antes de Toast.mount(); notificação descartada:", tostring(text))
		return
	end
	activeToast.show(text, severity)
end

return Toast
