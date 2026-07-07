-- SyncTeam — Spike M0.5 (Lab de pipeline local)
-- Conecta o Studio a DOIS endpoints WebSocket locais (canais A e B) para que
-- o harness Node simule dois "VS Codes" e valide o pipeline
-- VS Code A -> Studio -> VS Code B numa única máquina.
--
-- O que este spike NÃO valida: replicação via Team Create entre máquinas
-- (isso é o M0, com dois Studios reais).
--
-- Instalação e roteiro: README.md na pasta do spike.

local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioService = game:GetService("StudioService")

local LAB_NAME = "SyncTeam_Lab"
local PORTS = { 34901, 34902 }
local RECONNECT_SECONDS = 3
local POLL_INTERVAL_SECONDS = 0.5

local enabled = false
local channels = {} -- port -> WebStreamClient conectado
local watched = {} -- LuaSourceContainer -> RBXScriptConnection
local lastSourceByInstance = {} -- LuaSourceContainer -> último Source visto (dedupe sinal+polling)
local labConnections = {} -- conexões do watcher da pasta sandbox
local recentRemoteWrites = {} -- LuaSourceContainer -> os.clock() da última escrita via WS

local function log(...)
	print(("[SyncTeam Lab %s]"):format(os.date("%H:%M:%S")), ...)
end

-- ------------------------------------------------------ sandbox e caminhos

local function ensureLab()
	local lab = ServerScriptService:FindFirstChild(LAB_NAME)
	if lab == nil then
		lab = Instance.new("Folder")
		lab.Name = LAB_NAME
		lab.Parent = ServerScriptService
		log("Pasta sandbox criada: ServerScriptService." .. LAB_NAME)
	end
	return lab
end

local function relativePath(instance, lab)
	local parts = {}
	local current = instance
	while current ~= nil and current ~= lab do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	if current ~= lab then
		return nil
	end
	return table.concat(parts, "/")
end

-- Resolve "Pasta/Sub/Script" a partir da sandbox. Se createClassName for
-- passado, cria Folders intermediários e o nó final com essa classe.
local function resolvePath(lab, path, createClassName)
	if type(path) ~= "string" or path == "" then
		return nil, "path vazio"
	end
	local parts = string.split(path, "/")
	local current = lab
	for index, name in parts do
		local child = current:FindFirstChild(name)
		if child == nil then
			if createClassName == nil then
				return nil, ("'%s' não encontrado em '%s'"):format(name, current:GetFullName())
			end
			if index == #parts then
				child = Instance.new(createClassName)
			else
				child = Instance.new("Folder")
			end
			child.Name = name
			child.Parent = current
		end
		current = child
	end
	return current
end

-- ------------------------------------------------------------------ envio

local function sendTo(port, message)
	local client = channels[port]
	if client == nil then
		return
	end
	local ok, err = pcall(function()
		client:Send(HttpService:JSONEncode(message))
	end)
	if not ok then
		log(("falha ao enviar na porta %d: %s"):format(port, tostring(err)))
	end
end

local function broadcast(message)
	for port in channels do
		sendTo(port, message)
	end
end

-- ------------------------------------------------------------- observação
--
-- Dupla detecção, igual ao spike M0 (spikes/m0-source-replication/SyncTeamM0.lua):
-- GetPropertyChangedSignal("Source") é conectado como fast-path, mas em teste
-- real ele NÃO é confiável sozinho — UpdateSourceAsync muda a Source de fato,
-- mas o callback do sinal às vezes nunca roda. O polling (POLL_INTERVAL_SECONDS)
-- é quem garante a detecção; sinal e polling chamam a mesma checkSourceChanged,
-- que faz dedupe pelo cache lastSourceByInstance (equivalente ao
-- lastSourceCounter do M0) para nunca fazer broadcast duplicado da mesma mudança.

local function checkSourceChanged(instance, lab, via)
	local current = instance.Source
	if current == lastSourceByInstance[instance] then
		return
	end
	lastSourceByInstance[instance] = current
	local wroteAt = recentRemoteWrites[instance]
	local origin = if wroteAt ~= nil and os.clock() - wroteAt < 1 then "remote-write" else "studio"
	local path = relativePath(instance, lab)
	broadcast({
		kind = "sourceChanged",
		path = path,
		source = current,
		origin = origin,
		className = instance.ClassName,
		via = via,
	})
	log(("sourceChanged '%s' via %s (origin=%s)"):format(tostring(path), via, origin))
end

local function watchScript(instance, lab)
	if watched[instance] ~= nil or not instance:IsA("LuaSourceContainer") then
		return
	end
	-- Baseline capturada NA HORA de começar a observar (não espera o próximo
	-- poll): para script recém-criado isso normalmente é "" (default),
	-- então a escrita que popular o conteúdo já conta como mudança real.
	lastSourceByInstance[instance] = instance.Source
	watched[instance] = instance:GetPropertyChangedSignal("Source"):Connect(function()
		checkSourceChanged(instance, lab, "sinal")
	end)
end

local function startWatching(lab)
	for _, descendant in lab:GetDescendants() do
		watchScript(descendant, lab)
	end
	table.insert(labConnections, lab.DescendantAdded:Connect(function(descendant)
		if descendant:IsA("LuaSourceContainer") then
			watchScript(descendant, lab)
			broadcast({
				kind = "scriptAdded",
				path = relativePath(descendant, lab),
				className = descendant.ClassName,
			})
		end
	end))
	table.insert(labConnections, lab.DescendantRemoving:Connect(function(descendant)
		local connection = watched[descendant]
		if connection ~= nil then
			connection:Disconnect()
			watched[descendant] = nil
			lastSourceByInstance[descendant] = nil
			recentRemoteWrites[descendant] = nil
			broadcast({ kind = "scriptRemoved", path = relativePath(descendant, lab) })
		end
	end))
end

-- Loop de polling: varre todos os scripts observados e compara com o cache.
-- É o caminho garantido de detecção (o sinal é só um atalho quando funciona).
local function pollLoop(lab)
	while enabled do
		task.wait(POLL_INTERVAL_SECONDS)
		if not enabled then
			break
		end
		for instance in watched do
			checkSourceChanged(instance, lab, "polling")
		end
	end
end

-- ---------------------------------------------------------------- escrita

local function writeSource(instance, newSource)
	recentRemoteWrites[instance] = os.clock()
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(instance, function()
			return newSource
		end)
	end)
	if ok then
		return true, "UpdateSourceAsync"
	end
	local okDirect, errDirect = pcall(function()
		instance.Source = newSource
	end)
	if okDirect then
		return true, ".Source"
	end
	return false, tostring(errDirect)
end

-- ------------------------------------------------------------- mensagens

local function handleMessage(port, raw)
	local ok, message = pcall(function()
		return HttpService:JSONDecode(raw)
	end)
	if not ok or type(message) ~= "table" or message.kind == nil then
		log(("mensagem inválida na porta %d: %s"):format(port, tostring(raw)))
		return
	end

	local lab = ensureLab()

	if message.kind == "ping" then
		sendTo(port, { kind = "pong", requestId = message.requestId })
	elseif message.kind == "writeSource" then
		local instance, err = resolvePath(lab, message.path, message.className or "Script")
		if instance == nil or not instance:IsA("LuaSourceContainer") then
			sendTo(port, {
				kind = "writeAck",
				requestId = message.requestId,
				ok = false,
				error = err or ("alvo não é um script: " .. tostring(message.path)),
			})
			return
		end
		-- Registra a observação ANTES de escrever, ainda de forma síncrona
		-- (sem yield desde a criação em resolvePath): se a instância acabou
		-- de ser criada, a baseline fica "" (default), garantindo que esta
		-- própria escrita seja detectada como mudança pelo polling/sinal.
		-- Sem isso, o DescendantAdded (evento adiado) podia rodar DEPOIS do
		-- write e mascarar a mudança — era a causa do timeout observado nos
		-- cenários de escrita cruzada.
		watchScript(instance, lab)
		local okWrite, detail = writeSource(instance, message.source or "")
		sendTo(port, {
			kind = "writeAck",
			requestId = message.requestId,
			ok = okWrite,
			api = if okWrite then detail else nil,
			error = if okWrite then nil else detail,
		})
		log(("writeSource '%s' via porta %d → %s"):format(
			tostring(message.path),
			port,
			if okWrite then detail else "ERRO: " .. tostring(detail)
		))
	elseif message.kind == "readSource" then
		local instance = resolvePath(lab, message.path, nil)
		if instance == nil or not instance:IsA("LuaSourceContainer") then
			sendTo(port, {
				kind = "sourceContent",
				requestId = message.requestId,
				ok = false,
				error = "script não encontrado: " .. tostring(message.path),
			})
			return
		end
		sendTo(port, {
			kind = "sourceContent",
			requestId = message.requestId,
			ok = true,
			path = message.path,
			source = instance.Source,
		})
	elseif message.kind == "listScripts" then
		local lab2 = ensureLab()
		local paths = {}
		local scripts = {}
		for instance in watched do
			local path = relativePath(instance, lab2)
			if path ~= nil then
				table.insert(paths, path)
				table.insert(scripts, { path = path, className = instance.ClassName })
			end
		end
		sendTo(port, { kind = "scriptList", requestId = message.requestId, paths = paths, scripts = scripts })
	else
		log(("kind desconhecido na porta %d: %s"):format(port, tostring(message.kind)))
	end
end

-- ---------------------------------------------------------------- canais

local function runChannel(port)
	while enabled do
		local ok, client = pcall(HttpService.CreateWebStreamClient, HttpService, Enum.WebStreamClientType.WebSocket, {
			Url = ("ws://127.0.0.1:%d"):format(port),
		})
		if not ok then
			log(("porta %d: falha ao criar cliente (%s); nova tentativa em %ds"):format(
				port, tostring(client), RECONNECT_SECONDS))
			task.wait(RECONNECT_SECONDS)
			continue
		end

		local closed = false
		local connections = {}
		table.insert(connections, client.MessageReceived:Connect(function(raw)
			handleMessage(port, raw)
		end))
		table.insert(connections, client.Closed:Connect(function()
			closed = true
		end))
		table.insert(connections, client.Error:Connect(function(code, errorMessage)
			log(("porta %d: erro WS %s %s"):format(port, tostring(code), tostring(errorMessage)))
			closed = true
		end))

		-- Dá um instante para a conexão abrir antes do handshake
		task.wait(0.5)
		local okHello = pcall(function()
			client:Send(HttpService:JSONEncode({
				kind = "hello",
				role = "studio",
				port = port,
				userId = StudioService:GetUserId(),
				placeName = game.Name,
			}))
		end)

		if okHello and not closed then
			channels[port] = client
			log(("porta %d conectada"):format(port))
			while enabled and not closed do
				task.wait(0.5)
			end
		else
			log(("porta %d: conexão não abriu (o harness está rodando?)"):format(port))
		end

		channels[port] = nil
		for _, connection in connections do
			connection:Disconnect()
		end
		pcall(function()
			client:Close()
		end)

		if enabled then
			log(("porta %d desconectada; reconectando em %ds"):format(port, RECONNECT_SECONDS))
			task.wait(RECONNECT_SECONDS)
		end
	end
end

-- ------------------------------------------------------------ start/stop

local function stop()
	if not enabled then
		return
	end
	enabled = false
	for _, connection in labConnections do
		connection:Disconnect()
	end
	table.clear(labConnections)
	for _, connection in watched do
		connection:Disconnect()
	end
	table.clear(watched)
	table.clear(lastSourceByInstance)
	table.clear(recentRemoteWrites)
	log("Lab parado.")
end

local function start()
	if enabled then
		log("Lab já está rodando.")
		return
	end
	enabled = true
	local lab = ensureLab()
	startWatching(lab)
	task.spawn(pollLoop, lab)
	for _, port in PORTS do
		task.spawn(runChannel, port)
	end
	log(("Lab iniciado. Conectando às portas %d (canal A) e %d (canal B)..."):format(PORTS[1], PORTS[2]))
end

-- ---------------------------------------------------------------- toolbar

local toolbar = plugin:CreateToolbar("SyncTeam Lab")

local startButton = toolbar:CreateButton(
	"syncteam-lab-start",
	"Reconecta aos dois canais locais do harness (no-op se já ativo; use após reinstalar sem reload automático)",
	"",
	"Lab: Conectar"
)
local stopButton = toolbar:CreateButton("syncteam-lab-stop", "Desconecta e para o Lab", "", "Lab: Parar")

startButton.ClickableWhenViewportHidden = true
stopButton.ClickableWhenViewportHidden = true

startButton.Click:Connect(function()
	task.spawn(start)
end)
stopButton.Click:Connect(stop)

plugin.Unloading:Connect(stop)

log("Spike M0.5 carregado. Auto-start ao carregar o arquivo; toolbar 'SyncTeam Lab': Conectar (no-op se já ativo) / Parar.")

-- ------------------------------------------------------------ auto-start
--
-- O Studio auto-executa o código do plugin quando o arquivo é (re)adicionado
-- à pasta de Plugins (arquivo solto, sem clique necessário). Chama start()
-- incondicionalmente aqui fora de qualquer handler; start() já tem guard
-- (`if enabled then return end`), então um reload duplicado é seguro. O
-- botão "Lab: Conectar" continua existindo apenas para reconexão manual caso
-- o usuário precise (ex.: reinstalar sem reload automático do Studio).
task.spawn(start)
