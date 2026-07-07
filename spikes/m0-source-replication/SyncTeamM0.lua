-- SyncTeam — Spike M0
-- Valida a hipótese central: Source escrito por plugin em um Studio replica
-- para outro Studio via Team Create, de forma observável e em tempo útil.
-- Também testa o transporte WebSocket local (WebStreamClient -> Node ws).
--
-- Instalação e roteiro de teste: README.md ao lado deste arquivo.
-- Código descartável de validação — não é o produto.

local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")
local TestService = game:GetService("TestService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioService = game:GetService("StudioService")

local TARGET_NAME = "SyncTeam_M0_Target"
local META_NAME = "SyncTeam_M0"
local WRITE_INTERVAL_SECONDS = 3
local POLL_INTERVAL_SECONDS = 0.5
local WS_URL = "ws://127.0.0.1:34901"

local running = nil -- "writer" | "observer" | nil (só para UI/estado do botão; NUNCA usar como única condição de saída de loop)
local currentToken = 0 -- incrementado a cada start de qualquer papel; invalida loops antigos da mesma família
local connections = {}

local function log(...)
	print(("[SyncTeam M0 %s]"):format(os.date("%H:%M:%S")), ...)
end

local function stopAll()
	currentToken += 1 -- invalida imediatamente qualquer loop antigo (writer ou observer) ainda em task.wait
	if running ~= nil then
		log("Parado (papel anterior: " .. tostring(running) .. ")")
	end
	running = nil
	for _, connection in connections do
		connection:Disconnect()
	end
	table.clear(connections)
end

-- ------------------------------------------------------------------ infra

local function ensureMeta()
	local folder = TestService:FindFirstChild(META_NAME)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = META_NAME
		folder.Parent = TestService
	end
	local function ensureValue(className, name)
		local value = folder:FindFirstChild(name)
		if value == nil then
			value = Instance.new(className)
			value.Name = name
			value.Parent = folder
		end
		return value
	end
	return {
		counter = ensureValue("IntValue", "Counter"),
		writer = ensureValue("StringValue", "Writer"),
		writtenAtIso = ensureValue("StringValue", "WrittenAtIso"),
	}
end

local function ensureTarget()
	local existing = ServerScriptService:FindFirstChild(TARGET_NAME)
	if existing ~= nil and existing:IsA("Script") then
		return existing
	end
	local target = Instance.new("Script")
	target.Name = TARGET_NAME
	target.Source = "-- SyncTeam M0 spike\n-- counter: 0\nreturn 0\n"
	target.Parent = ServerScriptService
	log("Alvo criado em ServerScriptService." .. TARGET_NAME)
	return target
end

local function parseCounter(source)
	local text = string.match(source or "", "%-%- counter: (%d+)")
	if text ~= nil then
		return tonumber(text)
	end
	return nil
end

local function reportDraftsState()
	local ok, result = pcall(function()
		return game:GetService("DraftsService"):GetDrafts()
	end)
	if ok then
		log(("DraftsService respondeu com %d draft(s) locais."):format(#result))
	else
		log("DraftsService indisponível/erro:", tostring(result))
	end
	log("Anote o estado real de Game Settings > Options > Enable Drafts Mode na tabela do README.")
end

-- ---------------------------------------------------------------- escritor

local function runWriter()
	stopAll()
	local myToken = currentToken -- stopAll() acima já incrementou; este loop só continua enquanto for o mais recente
	running = "writer"
	local target = ensureTarget()
	local meta = ensureMeta()
	local userId = StudioService:GetUserId()
	meta.writer.Value = tostring(userId)
	reportDraftsState()
	log(("ESCRITOR iniciado (userId=%d). Escrevendo counter a cada %ds."):format(userId, WRITE_INTERVAL_SECONDS))

	local counter = meta.counter.Value
	while running == "writer" and currentToken == myToken do
		counter += 1
		local newSource = ("-- SyncTeam M0 spike\n-- counter: %d\n-- writer: %d\n-- writtenAtIso: %s\nreturn %d\n"):format(
			counter,
			userId,
			DateTime.now():ToIsoDate(),
			counter
		)

		local usedApi = "UpdateSourceAsync"
		local ok, err = pcall(function()
			ScriptEditorService:UpdateSourceAsync(target, function()
				return newSource
			end)
		end)
		if not ok then
			usedApi = ".Source"
			log("UpdateSourceAsync falhou (" .. tostring(err) .. "); tentando .Source direto")
			local okDirect, errDirect = pcall(function()
				target.Source = newSource
			end)
			if not okDirect then
				log("ERRO: escrita direta de .Source também falhou:", tostring(errDirect))
				usedApi = "nenhuma (falhou)"
			end
		end

		meta.counter.Value = counter
		meta.writtenAtIso.Value = DateTime.now():ToIsoDate()
		log(("escreveu counter=%d via %s + metadados"):format(counter, usedApi))
		task.wait(WRITE_INTERVAL_SECONDS)
	end
end

-- -------------------------------------------------------------- observador

local function runObserver()
	stopAll()
	local myToken = currentToken -- stopAll() acima já incrementou; este loop só continua enquanto for o mais recente
	running = "observer"
	reportDraftsState()

	local target = ServerScriptService:FindFirstChild(TARGET_NAME)
	if target == nil then
		log("Alvo ainda não replicou; aguardando até 60s (inicie o ESCRITOR no outro Studio)...")
		local deadline = os.clock() + 60
		while target == nil and os.clock() < deadline and running == "observer" and currentToken == myToken do
			task.wait(1)
			target = ServerScriptService:FindFirstChild(TARGET_NAME)
		end
	end
	if running ~= "observer" or currentToken ~= myToken then
		return
	end
	if target == nil then
		log("ERRO: alvo não apareceu em 60s. Inicie o ESCRITOR no outro Studio primeiro.")
		running = nil
		return
	end

	local meta = ensureMeta()
	local metaArrivalByCounter = {}
	local lastSourceCounter = parseCounter(target.Source) or -1

	log(("OBSERVADOR iniciado. counter atual na Source local: %d"):format(lastSourceCounter))
	log("Esperado (go): 'SOURCE ... via sinal' poucos segundos após cada 'METADADOS ...'.")
	log("Problema: SOURCE só via polling (sinal não dispara) ou SOURCE nunca chega (drafts retendo).")

	local function onSourceObserved(counter, via)
		if counter == nil or counter == lastSourceCounter then
			return
		end
		lastSourceCounter = counter
		local metaAt = metaArrivalByCounter[counter]
		if metaAt ~= nil then
			log(("SOURCE counter=%d chegou via %s, %.2fs após os metadados"):format(counter, via, os.clock() - metaAt))
		else
			log(("SOURCE counter=%d chegou via %s (antes dos metadados)"):format(counter, via))
		end
		-- Se o alvo estiver aberto no editor local, confere se o editor acompanhou
		local okEditor, editorSource = pcall(function()
			return ScriptEditorService:GetEditorSource(target)
		end)
		if okEditor then
			local editorCounter = parseCounter(editorSource)
			if editorCounter ~= counter then
				log(("  atenção: GetEditorSource ainda mostra counter=%s"):format(tostring(editorCounter)))
			end
		end
	end

	table.insert(connections, target:GetPropertyChangedSignal("Source"):Connect(function()
		onSourceObserved(parseCounter(target.Source), "sinal")
	end))

	table.insert(connections, meta.counter.Changed:Connect(function(newCounter)
		metaArrivalByCounter[newCounter] = os.clock()
		log(("METADADOS counter=%d chegaram"):format(newCounter))
	end))

	-- Polling de fallback: detecta a Source replicada mesmo se o sinal não disparar
	while running == "observer" and currentToken == myToken do
		onSourceObserved(parseCounter(target.Source), "polling")
		task.wait(POLL_INTERVAL_SECONDS)
	end
end

-- ------------------------------------------------------------ ws localhost

local function runWsTest()
	log("Testando WebSocket local em " .. WS_URL .. " (antes, rode: node ws-echo-server.mjs)")
	local ok, client = pcall(HttpService.CreateWebStreamClient, HttpService, Enum.WebStreamClientType.WebSocket, {
		Url = WS_URL,
	})
	if not ok then
		log("ERRO ao criar WebStreamClient:", tostring(client))
		return
	end

	local received, closed, errored
	local function cleanup()
		received:Disconnect()
		closed:Disconnect()
		errored:Disconnect()
	end

	received = client.MessageReceived:Connect(function(message)
		log("WS recebeu eco:", message)
		log("Transporte local OK — pode fechar o servidor Node.")
	end)
	closed = client.Closed:Connect(function()
		log("WS fechado.")
		cleanup()
	end)
	errored = client.Error:Connect(function(code, message)
		log("WS erro:", tostring(code), tostring(message))
		cleanup()
	end)

	-- Dá um instante para a conexão abrir antes do primeiro Send
	task.wait(1)
	local okSend, errSend = pcall(function()
		client:Send('{"kind":"transportProbe","from":"SyncTeamM0"}')
	end)
	if okSend then
		log("WS probe enviado; aguardando eco...")
	else
		log("ERRO ao enviar probe (conexão pode não ter aberto ainda; clique de novo):", tostring(errSend))
	end
end

-- ---------------------------------------------------------------- toolbar

local toolbar = plugin:CreateToolbar("SyncTeam M0")

local writerButton = toolbar:CreateButton("syncteam-m0-writer", "Escreve Source no alvo a cada 3s", "", "M0: Escritor")
local observerButton = toolbar:CreateButton("syncteam-m0-observer", "Observa a replicação do alvo", "", "M0: Observador")
local wsButton = toolbar:CreateButton("syncteam-m0-ws", "Testa WebSocket local (ws-echo-server.mjs)", "", "M0: WS local")
local stopButton = toolbar:CreateButton("syncteam-m0-stop", "Para o papel ativo", "", "M0: Parar")

writerButton.ClickableWhenViewportHidden = true
observerButton.ClickableWhenViewportHidden = true
wsButton.ClickableWhenViewportHidden = true
stopButton.ClickableWhenViewportHidden = true

writerButton.Click:Connect(function()
	task.spawn(runWriter)
end)
observerButton.Click:Connect(function()
	task.spawn(runObserver)
end)
wsButton.Click:Connect(function()
	task.spawn(runWsTest)
end)
stopButton.Click:Connect(stopAll)

plugin.Unloading:Connect(stopAll)

log("Spike M0 carregado. Botões na toolbar 'SyncTeam M0'.")
