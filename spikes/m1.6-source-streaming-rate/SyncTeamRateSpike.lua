-- SyncTeam — Spike M1.6: taxa de streaming de Source (handoff quase-instantâneo)
-- Pergunta: dá pra substituir o lease exclusivo por "handoff quase-instantâneo"
-- com streaming em tempo real do Source via ScriptEditorService:UpdateSourceAsync
-- em taxa fixa (2/5/15/30/60Hz)? Mede latência/perda de replicação via Team
-- Create em cada taxa.
--
-- Contexto já levantado (não repetir pesquisa):
-- .claude/research/2026-08-02-realtime-source-streaming-team-create.md — sem
-- rate-limit numérico documentado pela Roblox, mas o Rojo (rojo-rbx/rojo#1273)
-- já tentou sync automático "enquanto digita" e reverteu por causar
-- "repeated writes/server echoes" e cursor pulando no Script Editor.
--
-- Desenho DELIBERADO para não depender de nenhuma API nova não confirmada em
-- .claude/research/ (regra do projeto): a latência NÃO é medida com um
-- timestamp Roblox (DateTime.now()/UnixTimestampMillis nunca confirmados em
-- pesquisa) embutido na Source — cada Studio só manda um número de sequência
-- (n) + a taxa (rate) via WebSocket para um servidor Node local
-- (control-server.mjs, ver README.md), e é O SERVIDOR NODE (relógio único,
-- comparável entre os 2 Studios porque ambos rodam na MESMA máquina e falam
-- com o MESMO processo) quem carimba o instante de RECEBIMENTO de cada
-- evento "write"/"observed". A latência calculada inclui portanto o hop
-- WS Studio->servidor dos dois lados (viés pequeno e aproximadamente
-- constante) — não é a latência pura do Team Create, mas é o bastante para
-- COMPARAR entre taxas, que é o objetivo real deste spike. Ver README.md.
--
-- Papéis (mesmo padrão de spikes/m0-source-replication/SyncTeamM0.lua —
-- porte do padrão, não reinvenção): toolbar com 3 botões, um clique por
-- Studio. Studio A clica "RateSpike: Escritor", Studio B clica
-- "RateSpike: Observador". O escritor cicla SOZINHO pelas 5 taxas depois do
-- clique (sem mais interação); o observador só fica escutando/logando até
-- "RateSpike: Parar" ou o plugin descarregar.
--
-- Código descartável de validação — não é o produto (não colocar em
-- plugin/src). Instalação e roteiro completo: README.md ao lado deste
-- arquivo.

local HttpService = game:GetService("HttpService")
local TestService = game:GetService("TestService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local FOLDER_NAME = "SyncTeamRateSpike"
local TARGET_NAME = "Target"
local WS_URL = "ws://127.0.0.1:35990"

-- Taxas pedidas pelo usuário (Hz) e duração de cada fase. 12s por fase é
-- suficiente para várias centenas de writes mesmo na taxa mais baixa (2Hz =
-- 24 writes) e não estoura muito o pedido original de "~10-15s".
local RATE_PHASES = { 2, 5, 15, 30, 60 }
local PHASE_DURATION_SECONDS = 12
local PHASE_GAP_SECONDS = 1

-- Polling do observador: deliberadamente mais fino que
-- Config.POLL_INTERVAL_SECONDS (0.5s, produção) — aqui o objetivo é
-- justamente caracterizar coalescing/perda até 60Hz (período de ~16ms), e
-- 0.5s seria grosso demais para dizer algo útil sobre isso. NÃO é uma
-- proposta de mudar o polling de produção, é só o instrumento de medição
-- deste spike.
local POLL_INTERVAL_SECONDS = 0.05

local running = nil -- "writer" | "observer" | nil (só UI/estado; nunca única condição de saída de loop)
local currentToken = 0 -- invalida loops antigos da mesma família, mesmo padrão do M0
local connections = {}
local wsClient = nil

local function log(...)
	print(("[SyncTeam RateSpike %s]"):format(os.date("%H:%M:%S")), ...)
end

local function sendEvent(payload)
	if wsClient == nil then
		return
	end
	local ok, err = pcall(function()
		wsClient:Send(HttpService:JSONEncode(payload))
	end)
	if not ok then
		log("falha ao enviar evento ao control-server:", tostring(err))
	end
end

local function closeWs()
	if wsClient ~= nil then
		local ok, err = pcall(function()
			wsClient:Close()
		end)
		if not ok then
			log("falha ao fechar WS (ignorado):", tostring(err))
		end
		wsClient = nil
	end
end

local function stopAll()
	currentToken += 1 -- invalida imediatamente qualquer loop antigo ainda em task.wait
	if running ~= nil then
		log("Parado (papel anterior: " .. tostring(running) .. ")")
		sendEvent({ kind = "stopped", role = running })
	end
	running = nil
	for _, connection in connections do
		connection:Disconnect()
	end
	table.clear(connections)
	closeWs()
end

-- ------------------------------------------------------------------ infra

local function connectWs()
	local ok, client = pcall(function()
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = WS_URL })
	end)
	if not ok then
		log("ERRO ao criar WebStreamClient (control-server.mjs está rodando?):", tostring(client))
		return false
	end
	wsClient = client
	return true
end

local function attachWsConnections()
	table.insert(
		connections,
		wsClient.Closed:Connect(function()
			log("WS do control-server fechado")
		end)
	)
	table.insert(
		connections,
		wsClient.Error:Connect(function(code, message)
			log("WS erro:", tostring(code), tostring(message))
		end)
	)
	table.insert(
		connections,
		wsClient.MessageReceived:Connect(function(message)
			log("control-server disse:", message)
		end)
	)
end

local function ensureTarget()
	local folder = TestService:FindFirstChild(FOLDER_NAME)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = FOLDER_NAME
		folder.Parent = TestService
	end
	local target = folder:FindFirstChild(TARGET_NAME)
	if target == nil or not target:IsA("Script") then
		if target ~= nil then
			target:Destroy()
		end
		target = Instance.new("Script")
		target.Name = TARGET_NAME
		target.Source = "-- SyncTeam RateSpike\n-- n=0 rate=0\nreturn 0\n"
		target.Parent = folder
		log("Alvo criado em TestService." .. FOLDER_NAME .. "." .. TARGET_NAME)
	end
	return target
end

local function parseSource(source)
	local nText, rateText = string.match(source or "", "n=(%d+) rate=(%d+)")
	if nText == nil then
		return nil, nil
	end
	return tonumber(nText), tonumber(rateText)
end

local function writeSourceForN(target, n, rateHz)
	local newSource = ("-- SyncTeam RateSpike\n-- n=%d rate=%d\nreturn %d\n"):format(n, rateHz, n)
	local usedApi = "UpdateSourceAsync"
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(target, function()
			return newSource
		end)
	end)
	if not ok then
		usedApi = ".Source"
		local okDirect, errDirect = pcall(function()
			target.Source = newSource
		end)
		if not okDirect then
			usedApi = "nenhuma (falhou)"
			log("ERRO: escrita falhou (UpdateSourceAsync e .Source):", tostring(err), tostring(errDirect))
		end
	end
	return usedApi
end

-- ---------------------------------------------------------------- escritor

local function runWriter()
	stopAll()
	local myToken = currentToken
	running = "writer"
	if not connectWs() then
		running = nil
		return
	end
	attachWsConnections()
	sendEvent({ kind = "hello", role = "writer" })

	local target = ensureTarget()
	log("ESCRITOR iniciado. Vai ciclar sozinho pelas taxas: " .. table.concat(RATE_PHASES, ", ") .. " Hz.")

	local n = 0
	for _, rateHz in RATE_PHASES do
		if running ~= "writer" or currentToken ~= myToken then
			return
		end
		log(("fase iniciada: %dHz por %ds"):format(rateHz, PHASE_DURATION_SECONDS))
		sendEvent({ kind = "phaseStart", rateHz = rateHz })

		local sentThisPhase = 0
		local phaseDeadline = os.clock() + PHASE_DURATION_SECONDS
		while os.clock() < phaseDeadline and running == "writer" and currentToken == myToken do
			n += 1
			local usedApi = writeSourceForN(target, n, rateHz)
			sendEvent({ kind = "write", n = n, rateHz = rateHz, usedApi = usedApi })
			sentThisPhase += 1
			task.wait(1 / rateHz)
		end

		log(("fase concluída: %dHz, %d writes enviados"):format(rateHz, sentThisPhase))
		sendEvent({ kind = "phaseEnd", rateHz = rateHz, sent = sentThisPhase })
		if running == "writer" and currentToken == myToken then
			task.wait(PHASE_GAP_SECONDS)
		end
	end

	if running == "writer" and currentToken == myToken then
		log("todas as fases concluídas — total de " .. n .. " writes")
		sendEvent({ kind = "allDone", totalWrites = n })
	end
	stopAll()
end

-- -------------------------------------------------------------- observador

local function runObserver()
	stopAll()
	local myToken = currentToken
	running = "observer"
	if not connectWs() then
		running = nil
		return
	end
	attachWsConnections()
	sendEvent({ kind = "hello", role = "observer" })

	local target = TestService:FindFirstChild(FOLDER_NAME)
	target = target and target:FindFirstChild(TARGET_NAME) or nil
	if target == nil then
		log("Alvo ainda não replicou; aguardando até 60s (clique ESCRITOR no outro Studio)...")
		sendEvent({ kind = "waitingForTarget" })
		local deadline = os.clock() + 60
		while target == nil and os.clock() < deadline and running == "observer" and currentToken == myToken do
			task.wait(1)
			local folder = TestService:FindFirstChild(FOLDER_NAME)
			target = folder and folder:FindFirstChild(TARGET_NAME) or nil
		end
	end
	if running ~= "observer" or currentToken ~= myToken then
		return
	end
	if target == nil then
		log("ERRO: alvo não apareceu em 60s. Clique ESCRITOR no outro Studio primeiro.")
		sendEvent({ kind = "stopped", reason = "target_not_found" })
		running = nil
		return
	end

	sendEvent({ kind = "targetFound" })
	log("OBSERVADOR iniciado. Escutando via sinal + polling a cada " .. POLL_INTERVAL_SECONDS .. "s.")

	local lastSignalN = nil
	local lastPollN = nil

	table.insert(
		connections,
		target:GetPropertyChangedSignal("Source"):Connect(function()
			local n, rateHz = parseSource(target.Source)
			if n ~= nil and n ~= lastSignalN then
				lastSignalN = n
				sendEvent({ kind = "observed", n = n, rateHz = rateHz, via = "signal" })
			end
		end)
	)

	while running == "observer" and currentToken == myToken do
		local n, rateHz = parseSource(target.Source)
		if n ~= nil and n ~= lastPollN then
			lastPollN = n
			sendEvent({ kind = "observed", n = n, rateHz = rateHz, via = "poll" })
		end
		task.wait(POLL_INTERVAL_SECONDS)
	end
end

-- ---------------------------------------------------------------- toolbar

local toolbar = plugin:CreateToolbar("SyncTeam RateSpike")

local writerButton = toolbar:CreateButton(
	"syncteam-ratespike-writer",
	"Cicla escrita de Source em 2/5/15/30/60Hz",
	"",
	"RateSpike: Escritor"
)
local observerButton = toolbar:CreateButton(
	"syncteam-ratespike-observer",
	"Observa a replicação e mede latência/perda",
	"",
	"RateSpike: Observador"
)
local stopButton = toolbar:CreateButton("syncteam-ratespike-stop", "Para o papel ativo", "", "RateSpike: Parar")

writerButton.ClickableWhenViewportHidden = true
observerButton.ClickableWhenViewportHidden = true
stopButton.ClickableWhenViewportHidden = true

writerButton.Click:Connect(function()
	task.spawn(runWriter)
end)
observerButton.Click:Connect(function()
	task.spawn(runObserver)
end)
stopButton.Click:Connect(stopAll)

plugin.Unloading:Connect(stopAll)

log("Spike M1.6 carregado. Botões na toolbar 'SyncTeam RateSpike'. Suba control-server.mjs antes de clicar.")
