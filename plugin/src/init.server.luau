-- SyncTeam — Plugin de produção (M2 + M3.1 + M3.2)
--
-- Ponte local mínima para 1 desenvolvedor: cliente WebSocket único da
-- extensão VS Code (a extensão hospeda o servidor; o plugin é sempre
-- cliente — decisão registrada em docs/DECISIONS.md), observação genérica
-- de Source nos containers fixos (SourceWatcher/Config) e handlers do
-- protocolo v2 (writeSource/readSource/listScripts endereçados por
-- UUID+ObjectValue via ScriptRegistry, não mais por path — ver
-- docs/MILESTONES.md seção M2) com handshake versionado. A partir do M3.1,
-- também inicia/para TeamCreateElection (Sessions + heartbeat + eleição de
-- líder sob TestService.SyncTeam) junto com SourceWatcher. A partir do
-- M3.2, também inicia/para TeamCreateLease (leases autoritativas por
-- script) e `handleWriteSource` em modo atualização passa a checar a lease
-- antes de escrever (ver TeamCreateLease.luau).
--
-- Fora de escopo aqui (ver docs/MILESTONES.md): UX de lease no VS Code
-- (M3.3, delegado a ui-dev); presença/cursores (M4); schema versionado
-- (SchemaVersion, nunca existiu no SyncTeam); propriedades de instâncias
-- não-script (decisão fixa do projeto, v1 só scripts).
--
-- Porta do padrão de spikes/m0_5-local-pipeline/plugin/SyncTeamLab.lua
-- (checkSourceChanged polling+sinal) e spikes/m0-source-replication/
-- SyncTeamM0.lua (token de geração para start/stop seguro).

local HttpService = game:GetService("HttpService")
local StudioService = game:GetService("StudioService")

local Config = require(script.Config)
local SourceWatcher = require(script.SourceWatcher)
local TeamCreateElection = require(script.TeamCreateElection)
local TeamCreateLease = require(script.TeamCreateLease)

local enabled = false
local currentToken = 0
local client = nil -- WebStreamClient conectado no momento (nil se desconectado)

local function log(...)
	print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), ...)
end

local function sendMessage(message)
	if client == nil then
		log("descartado (sem conexão):", tostring(message.kind))
		return
	end
	local ok, err = pcall(function()
		client:Send(HttpService:JSONEncode(message))
	end)
	if not ok then
		log("falha ao enviar:", tostring(err))
	end
end

-- --------------------------------------------------------------- handlers

-- Protocolo v2 (docs/MILESTONES.md, M2): writeSource tem dois modos,
-- distinguidos pela presença do campo `uuid` na mensagem recebida.
--
-- M3.2 (docs/MILESTONES.md): modo ATUALIZAÇÃO agora passa por checagem de
-- lease ANTES de qualquer escrita — registra/refresca o próprio intent
-- (TeamCreateLease.ensureIntent) e só prossegue se TeamCreateLease.canWrite
-- permitir (dono == eu, ou nenhuma lease arbitrada ainda: decisão explícita
-- de permitir otimisticamente, ver TeamCreateLease.luau e MILESTONES.md).
-- Modo CRIAÇÃO (sem uuid) NÃO passa por essa checagem nesta fatia (spec
-- M3.2, item 3 — fora de escopo).
local function handleWriteSource(message)
	if message.uuid ~= nil then
		-- Modo ATUALIZAÇÃO: {uuid, source, requestId} — script já conhecido.
		local instance = SourceWatcher.resolveByUuid(message.uuid)
		if instance == nil then
			sendMessage({
				kind = "writeAck",
				requestId = message.requestId,
				ok = false,
				error = "uuid desconhecido ou script inválido: " .. tostring(message.uuid),
			})
			log(("writeSource (update) uuid=%s -> ERRO: desconhecido"):format(tostring(message.uuid)))
			return
		end

		TeamCreateLease.ensureIntent(message.uuid, instance)
		local canWrite, ownerClientId = TeamCreateLease.canWrite(message.uuid)
		if not canWrite then
			local ownerDisplay = TeamCreateLease.describeClient(ownerClientId)
			sendMessage({
				kind = "writeAck",
				requestId = message.requestId,
				ok = false,
				uuid = message.uuid,
				error = ("lease negada — script sendo editado por %s"):format(ownerDisplay),
			})
			log(("writeSource (update) uuid=%s -> ERRO: lease negada (owner=%s)"):format(
				tostring(message.uuid),
				ownerDisplay
			))
			return
		end

		local ok, detail = SourceWatcher.writeSource(instance, message.source or "")
		sendMessage({
			kind = "writeAck",
			requestId = message.requestId,
			ok = ok,
			uuid = if ok then message.uuid else nil,
			api = if ok then detail else nil,
			error = if ok then nil else detail,
		})
		log(("writeSource (update) uuid=%s -> %s"):format(
			tostring(message.uuid),
			if ok then detail else "ERRO: " .. tostring(detail)
		))
		return
	end

	-- Modo CRIAÇÃO: {path, source, className, requestId} — sem uuid, o
	-- plugin resolve/cria a Instance a partir de `game` e aloca um uuid novo.
	local instance, err = SourceWatcher.resolvePath(message.path, message.className or "Script")
	if instance == nil or not instance:IsA("LuaSourceContainer") then
		sendMessage({
			kind = "writeAck",
			requestId = message.requestId,
			ok = false,
			error = err or ("alvo não é um script: " .. tostring(message.path)),
		})
		return
	end
	-- writeSource já chama watchScript() de forma síncrona antes de escrever,
	-- o que já resolve/aloca o uuid no ScriptRegistry — getUuid abaixo lê o
	-- resultado dessa alocação. Se a Instance for genuinamente nova, o
	-- DescendantAdded (deferred) do container correspondente vai emitir
	-- também um scriptAdded espontâneo com o mesmo uuid — a extensão recebe
	-- os dois (writeAck + scriptAdded); é esperado, não é bug (spec M2).
	local ok, detail = SourceWatcher.writeSource(instance, message.source or "")
	local uuid = SourceWatcher.getUuid(instance)
	sendMessage({
		kind = "writeAck",
		requestId = message.requestId,
		ok = ok,
		uuid = if ok then uuid else nil,
		api = if ok then detail else nil,
		error = if ok then nil else detail,
	})
	log(("writeSource (create) '%s' -> uuid=%s %s"):format(
		tostring(message.path),
		tostring(uuid),
		if ok then detail else "ERRO: " .. tostring(detail)
	))
end

local function handleReadSource(message)
	local instance = SourceWatcher.resolveByUuid(message.uuid)
	if instance == nil then
		sendMessage({
			kind = "sourceContent",
			requestId = message.requestId,
			ok = false,
			error = "uuid desconhecido ou script inválido: " .. tostring(message.uuid),
		})
		return
	end
	sendMessage({
		kind = "sourceContent",
		requestId = message.requestId,
		ok = true,
		source = instance.Source,
	})
end

local function handleListScripts(message)
	sendMessage({
		kind = "scriptList",
		requestId = message.requestId,
		scripts = SourceWatcher.listScripts(),
	})
end

local function handleMessage(raw)
	local ok, message = pcall(function()
		return HttpService:JSONDecode(raw)
	end)
	if not ok or type(message) ~= "table" or type(message.kind) ~= "string" then
		log("mensagem inválida:", tostring(raw))
		return
	end

	if message.kind == "writeSource" then
		handleWriteSource(message)
	elseif message.kind == "readSource" then
		handleReadSource(message)
	elseif message.kind == "listScripts" then
		handleListScripts(message)
	else
		log("kind desconhecido/ignorado:", tostring(message.kind))
	end
end

-- ------------------------------------------------------------- conexão ws

local function sendHello()
	local okUserId, userId = pcall(function()
		return StudioService:GetUserId()
	end)
	sendMessage({
		kind = "hello",
		protocolVersion = Config.PROTOCOL_VERSION,
		role = "studio",
		placeName = game.Name,
		userId = if okUserId then userId else nil,
		pluginVersion = Config.PLUGIN_VERSION,
		-- M3.3: clientId da eleição (TeamCreateElection.luau), para a extensão
		-- comparar contra o dono de uma lease. nil se a eleição ainda não
		-- rodou (start() chamado antes de TeamCreateElection.start() concluir
		-- o primeiro tick? não é o caso aqui — TeamCreateElection.start() já
		-- gera o clientId de forma síncrona antes de retornar; nil só seria
		-- possível se sendHello rodasse antes de start(), o que não acontece
		-- neste fluxo) — enviado como nil mesmo, sem erro, nesse caso.
		clientId = TeamCreateElection.getClientId(),
	})
end

-- Uma única conexão (o produto usa 1 conexão; spikes é que usavam até 2 —
-- ver .claude/rules/luau.md). Loop de reconexão guardado pelo token de
-- geração: stop()/start() repetidos não deixam loops antigos sobrepostos
-- (pegadinha real do M0, ver .claude/agent-memory/luau-dev.md).
local function runConnection(myToken, port)
	while enabled and currentToken == myToken do
		local url = ("ws://127.0.0.1:%d"):format(port)
		local ok, newClient = pcall(function()
			return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = url })
		end)
		if not ok then
			log(("falha ao criar cliente WS (%s); nova tentativa em %ds"):format(
				tostring(newClient),
				Config.RECONNECT_SECONDS
			))
			task.wait(Config.RECONNECT_SECONDS)
			continue
		end

		local closed = false
		local connections = {}
		table.insert(connections, newClient.MessageReceived:Connect(handleMessage))
		table.insert(connections, newClient.Closed:Connect(function()
			closed = true
		end))
		table.insert(connections, newClient.Error:Connect(function(code, errorMessage)
			log(("erro WS %s %s"):format(tostring(code), tostring(errorMessage)))
			closed = true
		end))

		client = newClient
		sendHello()
		log(("conectado em %s"):format(url))

		while enabled and currentToken == myToken and not closed do
			task.wait(0.5)
		end

		client = nil
		for _, connection in connections do
			connection:Disconnect()
		end
		pcall(function()
			newClient:Close()
		end)

		if enabled and currentToken == myToken then
			log(("desconectado; reconectando em %ds"):format(Config.RECONNECT_SECONDS))
			task.wait(Config.RECONNECT_SECONDS)
		end
	end
end

-- ------------------------------------------------------------ start/stop

local function stop()
	if not enabled then
		return
	end
	enabled = false
	currentToken += 1
	SourceWatcher.stop()
	-- TeamCreateLease.stop() antes de TeamCreateElection.stop(): só limpa
	-- estado em memória (pastas de intent morrem em cascata quando
	-- TeamCreateElection.stop() destrói a própria sessão a seguir) — ordem
	-- não é estritamente necessária, mas segue a mesma disciplina "parar o
	-- que depende antes do que é dependido" já usada neste arquivo.
	TeamCreateLease.stop()
	-- TeamCreateElection.stop() remove a própria entrada de Sessions/ de forma
	-- SÍNCRONA (M3.1) — mesmo cuidado do fix de WebStreamClient abaixo:
	-- plugin.Unloading pode não dar chance de uma coroutine assíncrona notar
	-- isso depois.
	TeamCreateElection.stop()
	-- Fecha o WebStreamClient de forma SÍNCRONA aqui, em vez de confiar no
	-- cleanup do loop runConnection (task.spawn): plugin.Unloading provavelmente
	-- mata a coroutine antes dela acordar do task.wait e rodar seu próprio
	-- newClient:Close(). Bug real confirmado em teste ao vivo, 2026-07-04
	-- (docs/DECISIONS.md): reloads repetidos do plugin vazavam um
	-- WebStreamClient cada, até atingir o limite de 6 por Studio
	-- (.claude/rules/luau.md) e travar toda nova conexão.
	if client ~= nil then
		pcall(function()
			client:Close()
		end)
	end
	client = nil
	log("parado.")
end

local function start(pluginObject)
	if enabled then
		log("já está rodando.")
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken
	local port = Config.resolvePort(pluginObject)
	local okUserId, resolvedUserId = pcall(function()
		return StudioService:GetUserId()
	end)
	SourceWatcher.init(sendMessage)
	SourceWatcher.start()
	TeamCreateElection.start(if okUserId then resolvedUserId else 0)
	-- TeamCreateLease depois de TeamCreateElection: ensureIntent (chamado só
	-- durante handleWriteSource, não aqui) depende de
	-- TeamCreateElection.getSessionFolder() já existir. init() (M3.3) injeta o
	-- mesmo callback sendMessage que SourceWatcher já usa, para o ciclo de
	-- checkLeaseDrift poder emitir `leaseChanged` espontâneo.
	TeamCreateLease.init(sendMessage)
	TeamCreateLease.start()
	task.spawn(runConnection, myToken, port)
	log(("iniciado. Conectando à porta %d..."):format(port))
end

-- ---------------------------------------------------------------- toolbar

local toolbar = plugin:CreateToolbar("SyncTeam")

local startButton = toolbar:CreateButton(
	"syncteam-start",
	"Conecta à extensão VS Code local (no-op se já ativo; use após reinstalar sem reload automático)",
	"",
	"SyncTeam: Conectar"
)
local stopButton = toolbar:CreateButton("syncteam-stop", "Desconecta e para a observação", "", "SyncTeam: Parar")

startButton.ClickableWhenViewportHidden = true
stopButton.ClickableWhenViewportHidden = true

startButton.Click:Connect(function()
	task.spawn(start, plugin)
end)
stopButton.Click:Connect(stop)

plugin.Unloading:Connect(stop)

log("plugin carregado. Auto-start ao carregar; toolbar 'SyncTeam': Conectar (no-op se já ativo) / Parar.")

-- ------------------------------------------------------------ auto-start
--
-- Mesmo padrão validado no M0.5 (.claude/agent-memory/luau-dev.md): o
-- Studio auto-executa o Script raiz do plugin ao (re)carregar — seja como
-- arquivo .lua solto na pasta de Plugins, seja como .rbxm buildado via
-- `rojo build` (o resultado final é sempre um Script normal na pasta de
-- Plugins, executado no load). start() tem guard de idempotência
-- (`if enabled then return end`) para tolerar reload/reinstalação duplicada.
task.spawn(start, plugin)
