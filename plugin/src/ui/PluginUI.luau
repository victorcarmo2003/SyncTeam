-- SyncTeam — Orquestração do painel de status do plugin (M4.5)
--
-- Único ponto de contato entre init.server.luau (dono da lógica de
-- conexão/sessão/lease) e a UI (toolbar, DockWidgetPluginGui, Vide). Cria o
-- botão único de toolbar (toggle mostrar/esconder o painel — substitui os 3
-- botões antigos "Conectar"/"Parar"/"Alternar porta", spec da tarefa), o
-- DockWidgetPluginGui, monta a árvore Vide (StatusPanel.luau) dentro dele, e
-- expõe um API pequeno para init.server.luau empurrar mudanças de estado
-- (conectado/porta) e para Logger.notify acionar toasts.
--
-- Ciclo de vida DELIBERADAMENTE separado do start()/stop() de
-- init.server.luau: o painel (toolbar+widget) é criado 1x, no carregamento
-- do plugin, e sobrevive a reconexões/troca de porta (mesmo padrão que a
-- toolbar antiga já tinha — os botões não desapareciam a cada stop()+start()).
-- Só `PluginUI.stop()` (chamado em plugin.Unloading, separado da função
-- `stop()` de init.server.luau) desliga o refresh em segundo plano da
-- tabela de sessões.
--
-- Getters read-only usados (adicionados nesta mesma tarefa, ver
-- .claude/agent-memory/ui-dev.md para o raciocínio de cada um):
--   TeamCreateElection.getLeaderClientId() / .listSessions()
--   TeamCreateLease.forEachLease(callback)
--   TeamCreatePresence.getActiveUuid(clientId)
--   ScriptRegistry.getCanonicalPath(uuid) (já existia desde o M2)

local Config = require(script.Parent.Parent.Config)
local Logger = require(script.Parent.Parent.Logger)
local ScriptRegistry = require(script.Parent.Parent.ScriptRegistry)
local TeamCreateElection = require(script.Parent.Parent.TeamCreateElection)
local TeamCreateLease = require(script.Parent.Parent.TeamCreateLease)
local TeamCreatePresence = require(script.Parent.Parent.TeamCreatePresence)

local vide = require(script.Parent.Parent.Packages.Vide)
local StatusPanel = require(script.Parent.StatusPanel)
local Toast = require(script.Parent.Toast)

local PluginUI = {}

local log = Logger.log

-- ------------------------------------------------------------------ estado

local running = false
local currentToken = 0 -- mesmo idioma de token de geração do resto do plugin

local toastHandle = nil -- { show, destroy }, de Toast.mount() (ScreenGui em CoreGui)
local widget = nil -- DockWidgetPluginGui

-- Sources do Vide (estado reativo do painel). `connectionStatus`/`port` são
-- empurrados de fora (init.server.luau, via setConnectionStatus/setPort);
-- `view`/`notificationsEnabled`/`sessionsMap` são geridos aqui dentro.
-- connectionStatus tem 3 valores (item 1 da tarefa): "disconnected" (parado),
-- "connecting" (tentando/reconectando), "connected" (conexão confirmada).
local connectionStatusSource = vide.source("disconnected")
local portSource = vide.source(Config.DEFAULT_PORT)
local viewSource = vide.source("main")
local notificationsEnabledSource = vide.source(true)
local sessionsMapSource = vide.source({})

-- --------------------------------------------------------- tabela de sessões

-- Monta { [clientId] = RowData } a partir do estado já mantido por
-- TeamCreateElection/TeamCreateLease/TeamCreatePresence/ScriptRegistry — só
-- LEITURA, nenhum destes módulos é mutado aqui. RowData = { clientId,
-- username, joinSequence, isLeader, info }.
--
-- Decisão desta fatia (não 100% especificada na tarefa): inclui a PRÓPRIA
-- sessão na tabela (não só as remotas) — "quem mais está na sessão" também
-- se beneficia de mostrar o próprio status (sou eu o líder? o que eu estou
-- editando?) num relance só, sem precisar de uma seção separada "eu".
--
-- Prioridade INFO (spec da tarefa, em ordem): lease ativa no uuid ("editando
-- <path>") > presença sem lease ("vendo <path>") > "ocioso". Se uma sessão
-- tiver leases em MAIS de um uuid (extremo raro, ver TeamCreateLease.luau —
-- leases não expiram por troca de arquivo, só por inatividade), mostra a
-- PRIMEIRA encontrada por TeamCreateLease.forEachLease (ordem de iteração de
-- Leases/*, não garantida) — simplificação aceita: a tabela mostra "editando
-- algo", não necessariamente TUDO que a sessão está editando; sem essa
-- limitação a coluna INFO precisaria virar lista, fora do escopo desta v1
-- (spec: "texto único").
local function buildSessionsMap()
	local leaderClientId = TeamCreateElection.getLeaderClientId()
	local sessions = TeamCreateElection.listSessions()

	local editingUuidByClient = {}
	TeamCreateLease.forEachLease(function(uuid, ownerClientId)
		if editingUuidByClient[ownerClientId] == nil then
			editingUuidByClient[ownerClientId] = uuid
		end
	end)

	local map = {}
	for _, session in ipairs(sessions) do
		local info
		local editingUuid = editingUuidByClient[session.clientId]
		if editingUuid ~= nil then
			local path = ScriptRegistry.getCanonicalPath(editingUuid)
			info = ("editando %s"):format(path or editingUuid)
		else
			local viewingUuid = TeamCreatePresence.getActiveUuid(session.clientId)
			if viewingUuid ~= nil then
				local path = ScriptRegistry.getCanonicalPath(viewingUuid)
				info = ("vendo %s"):format(path or viewingUuid)
			else
				info = "ocioso"
			end
		end

		map[session.clientId] = {
			clientId = session.clientId,
			username = session.username,
			joinSequence = session.joinSequence,
			isLeader = leaderClientId ~= nil and session.clientId == leaderClientId,
			info = info,
		}
	end

	return map
end

local function refreshSessionsMap()
	local ok, result = pcall(buildSessionsMap)
	if ok then
		sessionsMapSource(result)
	else
		-- Nunca deixa uma leitura malformada (schema em transição de
		-- replicação, por exemplo) derrubar o loop de refresh inteiro —
		-- mesma disciplina de pcall em torno de leitura de estado
		-- compartilhado já usada no resto do plugin.
		log("painel: falha ao atualizar tabela de sessões:", tostring(result))
	end
end

-- ------------------------------------------------------------------ notify

-- Injetado em Logger.initNotify por init.server.luau (dentro de start()) —
-- chamado por Logger.notify(...) para os poucos eventos "toast-worthy"
-- (lease negada, reconciliação de duplicata do schema, falha de reconexão
-- WS). O log no Output já aconteceu (Logger.notify faz isso incondicionalmente,
-- ANTES de chamar este callback) — aqui só decide se anima o toast visível,
-- olhando a preferência "Mostrar notificações".
--
-- Não força mais o painel (DockWidgetPluginGui) a abrir: desde que o toast
-- virou um ScreenGui flutuante independente em CoreGui (ver Toast.luau), ele
-- aparece sozinho sobre o Studio, sem depender do painel estar aberto — abrir
-- o painel à força seria intrusivo (o usuário pode tê-lo fechado de
-- propósito). Ressalva: a pesquisa indica que o overlay via CoreGui talvez só
-- cubra o viewport 3D; o log no Output continua sendo o registro garantido.
function PluginUI.notify(text)
	if not notificationsEnabledSource() then
		return
	end
	if toastHandle ~= nil then
		toastHandle.show(text)
	end
end

-- --------------------------------------------------------- setters (init.server.luau)

-- Empurrado por init.server.luau nas transições de conexão dentro de
-- runConnection/start/stop — puramente refletir estado, nenhuma lógica de
-- conexão mora aqui. `status` ∈ {"disconnected","connecting","connected"};
-- valores inválidos são ignorados (defensivo). Dedupe: só escreve a Source se
-- o valor mudou de verdade — runConnection chama "connecting" repetidamente a
-- cada volta do loop, e escrever o mesmo valor reexecutaria os effects do
-- botão à toa.
local VALID_STATUSES = { disconnected = true, connecting = true, connected = true }
function PluginUI.setConnectionStatus(status)
	if VALID_STATUSES[status] and status ~= connectionStatusSource() then
		connectionStatusSource(status)
	end
end

-- Empurrado por init.server.luau sempre que uma porta é tentada/confirmada/
-- persistida (auto-descoberta ou manual) — o campo de porta do painel
-- reflete isso ao vivo.
function PluginUI.setPort(port)
	if type(port) == "number" then
		portSource(math.floor(port))
	end
end

-- ------------------------------------------------------------------ init/stop

-- Chamado 1x por init.server.luau, fora do ciclo start()/stop() (mesmo
-- lugar/momento em que a toolbar antiga era criada) — cria toolbar+widget,
-- monta a árvore Vide, e inicia o refresh em segundo plano da tabela de
-- sessões. `callbacks` = { onConnect, onDisconnect, onPortChange(newPort) }
-- (mesma nomenclatura/contrato de start()/stop()/troca de porta já
-- existentes em init.server.luau — este módulo só invoca, nunca reimplementa
-- a lógica de conexão).
function PluginUI.init(pluginObject, callbacks)
	if running then
		return
	end

	-- API de Studio nunca antes usada neste projeto (DockWidgetPluginGuiInfo/
	-- CreateDockWidgetPluginGui, ver .claude/research/2026-07-15-*)
	-- protegida por pcall — uma falha aqui degrada para "sem painel visível"
	-- em vez de derrubar o restante do plugin (conexão/sync continuam
	-- funcionando via init.server.luau independente disso).
	local ok, err = pcall(function()
		notificationsEnabledSource(Config.resolveNotificationsEnabled(pluginObject))

		local toolbar = pluginObject:CreateToolbar("SyncTeam")
		local toggleButton = toolbar:CreateButton(
			"syncteam-toggle-panel",
			"Mostra/esconde o painel de status do SyncTeam",
			"",
			"SyncTeam"
		)
		toggleButton.ClickableWhenViewportHidden = true

		local widgetInfo = DockWidgetPluginGuiInfo.new(
			Enum.InitialDockState.Right,
			false, -- initialEnabled: só vale na primeiríssima instalação; Studio persiste o resto
			false, -- não força esse valor por cima do estado persistido em runs futuros
			300, -- floatingXSize
			400, -- floatingYSize
			260, -- minWidth
			320 -- minHeight
		)
		widget = pluginObject:CreateDockWidgetPluginGui("SyncTeamPanel", widgetInfo)
		widget.Title = "SyncTeam"
		widget.Name = "SyncTeamPanel"

		toggleButton.Click:Connect(function()
			widget.Enabled = not widget.Enabled
		end)
		local function syncToggleButtonActiveState()
			pcall(function()
				toggleButton:SetActive(widget.Enabled)
			end)
		end
		syncToggleButtonActiveState()
		widget:GetPropertyChangedSignal("Enabled"):Connect(syncToggleButtonActiveState)

		local statusPanelCallbacks = {
			onConnect = callbacks.onConnect,
			onDisconnect = callbacks.onDisconnect,
			onPortSubmit = callbacks.onPortChange,
			-- Persistência da preferência é responsabilidade da UI (não de
			-- init.server.luau) — só afeta exibição de toast, nada de
			-- conexão/protocolo.
			onNotificationsToggle = function(newValue)
				local okSet, errSet = pcall(function()
					pluginObject:SetSetting(Config.NOTIFICATIONS_SETTING_KEY, newValue)
				end)
				if not okSet then
					log("falha ao salvar preferência de notificações:", tostring(errSet))
				end
			end,
		}

		local state = {
			connectionStatus = connectionStatusSource,
			port = portSource,
			view = viewSource,
			notificationsEnabled = notificationsEnabledSource,
			sessionsMap = sessionsMapSource,
		}

		-- `StatusPanel.build` (e tudo que ele cria por dentro — `vide.create`
		-- com propriedades reativas, `vide.indexes`, `vide.switch`) precisa
		-- rodar DENTRO do escopo de `vide.root()` que `vide.mount` empurra —
		-- essas funções chamam `assert_stable_scope()` internamente e lançam
		-- erro fora de um root/effect ativo (bug real corrigido nesta sessão:
		-- construir a árvore ANTES de `vide.mount` deixava o widget vazio).
		vide.mount(function()
			return StatusPanel.build(state, statusPanelCallbacks)
		end, widget)
	end)

	if not ok then
		log("painel: falha ao inicializar UI (toolbar/widget):", tostring(err))
		return
	end

	-- Toast flutuante (ScreenGui em CoreGui, ver Toast.luau) criado FORA do
	-- vide.mount do painel (é independente dele) e em pcall ISOLADO: uma falha
	-- de acesso a CoreGui degrada para "sem toast visível" sem impedir o
	-- refresh da tabela de sessões abaixo (o painel já montou com sucesso).
	local okToast, errToast = pcall(function()
		toastHandle = Toast.mount()
	end)
	if not okToast then
		log("painel: falha ao criar overlay de notificação (CoreGui):", tostring(errToast))
	end

	running = true
	currentToken += 1
	local myToken = currentToken

	refreshSessionsMap()
	task.spawn(function()
		while running and currentToken == myToken do
			task.wait(Config.POLL_INTERVAL_SECONDS)
			if running and currentToken == myToken then
				refreshSessionsMap()
			end
		end
	end)

	log("painel: inicializado.")
end

-- Chamado em plugin.Unloading (init.server.luau) — separado do stop() da
-- lógica de conexão/sessão, já que o painel deve sobreviver a
-- reconexões/troca de porta ao longo da vida do plugin.
function PluginUI.stop()
	if not running then
		return
	end
	running = false
	currentToken += 1
	-- Destrói o ScreenGui do toast em CoreGui — não é auto-limpo no unload do
	-- plugin (ao contrário do DockWidgetPluginGui), então sem isso cada reload
	-- vazaria um ScreenGui em CoreGui (mesma classe de vazamento do
	-- WebStreamClient documentada em docs/DECISIONS.md).
	if toastHandle ~= nil then
		pcall(function()
			toastHandle.destroy()
		end)
		toastHandle = nil
	end
end

return PluginUI
