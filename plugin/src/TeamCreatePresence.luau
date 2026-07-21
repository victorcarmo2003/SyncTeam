-- SyncTeam — Presença: cursor/seleção/arquivo ativo (M4)
--
-- PASSTHROUGH PURO de dados opacos vindos da extensão VS Code — decisão já
-- fechada na tarefa (docs/MILESTONES.md, M4): a origem do cursor/seleção é o
-- VS Code, nunca o editor de script do Studio. Este módulo NUNCA lê cursor de
-- uma Instance de Script; só grava o que a extensão manda na PRÓPRIA
-- Sessions/<clientId>/Presence (Team Create replica pro Studio remoto) e
-- observa as entradas Presence de OUTRAS sessões pra notificar a própria
-- extensão. Mesmo padrão exato de TeamCreateLease.luau: schema/ensure, ciclo
-- de poll a Config.POLL_INTERVAL_SECONDS, dedupe por último valor visto,
-- callback injetado via init() para emitir mensagem espontânea.
--
-- Schema (sob Sessions/<clientId>, dono é TeamCreateElection — este módulo só
-- lê/escreve dentro dela via TeamCreateElection.getSessionFolder() para a
-- PRÓPRIA sessão, e via sessionsFolder:GetChildren() [lido, não é dono] para
-- as demais — mesmo princípio de TeamCreateLease.ensureIntent/checkLeaseDrift):
--   Presence/ (ActiveScriptUuid: StringValue [""=nenhum script ativo],
--     CursorLine: IntValue [-1=null], CursorColumn: IntValue [-1=null],
--     SelectionStartLine: IntValue [-1=null], SelectionStartColumn: IntValue
--     [-1=null])
--
-- Contrato de protocolo fechado com ui-dev (não mudar nomes/tipos sem
-- registrar em docs/DECISIONS.md e avisar o outro lado):
--   1. `presenceUpdate` (extensão -> plugin, espontânea, sem requestId, sem
--      ack): grava a PRÓPRIA Presence (TeamCreatePresence.updateOwnPresence).
--      `uuid = null` (que chega como `message.uuid == nil` depois do
--      JSONDecode — Lua não distingui campo ausente de null, mesma limitação
--      já documentada em docs/DECISIONS.md 2026-07-04 para o sentido inverso)
--      significa "nenhum editor ativo correspondendo a um script sincronizado
--      — limpar minha presença".
--   2. `presenceChanged`/`presenceLeft` (plugin -> extensão, espontânea):
--      emitidas pelo MESMO ciclo de poll que já observa leases
--      (checkPresenceDrift, Config.POLL_INTERVAL_SECONDS), convertendo os
--      sentinelas -1/"" de volta para `null` no JSON — o lado JS nunca vê
--      sentinela.
--
-- Decisões desta fatia, não 100% especificadas na tarefa (ver também
-- .claude/agent-memory/luau-dev.md):
--
-- 1. **`updateOwnPresence` escreve IMEDIATAMENTE ao receber a mensagem**, não
--    é enfileirada para o ciclo de poll — só o LADO DE OBSERVAÇÃO (outras
--    sessões) usa o ciclo de Config.POLL_INTERVAL_SECONDS. Isso é simétrico ao
--    padrão já usado para writeSource (escreve na hora que a mensagem chega),
--    não ao padrão de ensureIntent+leaderTick (que tem um ciclo de decisão
--    separado porque envolve arbitragem entre Studios) — aqui não há
--    arbitragem nenhuma, é só "gravar o que me mandaram".
-- 2. **Dedupe por chave composta (string concatenada dos 5 campos), não por
--    tabela**: como Presence tem 5 campos (não 1 só, como o OwnerClientId de
--    TeamCreateLease), comparar tabelas por igualdade não funciona em Lua
--    (identidade de referência, não de valor) — a chave é
--    `uuid|cursorLine|cursorColumn|selStartLine|selStartCol` (sentinelas
--    crus, antes de converter pra null), mesmo princípio do NO_OWNER_KEY de
--    TeamCreateLease.checkLeaseDrift, só que estendido a múltiplos campos.
-- 3. **Baseline na primeira observação de um clientId nesta sessão**: só
--    grava, nunca emite — mesmo princípio (e mesmo motivo: evitar rajada de
--    mensagens para presença já existente no momento em que este Studio
--    conecta) já documentado e decidido em TeamCreateLease.checkLeaseDrift
--    para leaseChanged. Aplica-se tanto a presenceChanged quanto a
--    presenceLeft.
-- 4. **`presenceLeft` tem DOIS gatilhos distintos**: (a) a sessão observada
--    ZEROU a própria presença (ActiveScriptUuid virou "" — extensão limpou/
--    fechou o arquivo) — detectado dentro do loop principal de
--    checkPresenceDrift, mesma passada que detectaria um presenceChanged; (b)
--    a sessão SUMIU inteira de Sessions/ (Folder destruído — via stop()
--    síncrono do dev remoto, mesmo comportamento medido no M3.1 de ~3s em
--    shutdown gracioso, ou via cleanupStaleSessions do líder após 20s) —
--    detectado numa segunda passada comparando o snapshot desta rodada
--    (seenThisCycle) contra lastPresenceByClientId. Não foi necessário
--    duplicar nenhuma lógica de staleness própria (Pulse/heartbeatAge): o
--    módulo confia inteiramente no ciclo de vida já existente da sessão
--    (TeamCreateElection) para o Folder eventualmente desaparecer — mesmo
--    espírito de checkLeaseDrift, que também não reimplementa staleness de
--    sessão (RojoCoop fazia essa checagem dupla em __readLiveIntents; aqui,
--    como lá, decisão deliberada de não duplicar).
-- 5. **`describeClient` duplicado aqui** (não reusa
--    TeamCreateLease.describeClient) para não criar uma dependência cruzada
--    entre TeamCreatePresence e TeamCreateLease só por causa de ~5 linhas de
--    lookup de Username — mesmo raciocínio já registrado em docs/DECISIONS.md
--    (2026-07-04) para ScriptRegistry.reconcile/findRegistryEntryFor: duplicar
--    é mais legível que forçar uma abstração compartilhada entre dois módulos
--    que hoje não têm nenhuma outra razão para se conhecer.
-- 6. **Escrita de `updateOwnPresence` protegida por pcall**: diferente da
--    maioria das escritas internas deste plugin (que só manipulam dados já
--    conhecidos/gerados localmente), os 4 campos numéricos aqui vêm de uma
--    mensagie JSON EXTERNA e não confiável — `IntValue.Value` exige um número
--    íntegro; um valor malformado do lado JS lançaria erro em vez de
--    degradar. Seguindo `.claude/rules/luau.md` ("toda chamada em pcall;
--    falha degrada com log claro, nunca quebra o plugin inteiro"), a escrita
--    dos 5 valores é feita dentro de um pcall só, logando e descartando a
--    atualização inteira em caso de falha (nunca deixa a Presence num estado
--    parcialmente escrito).
-- 7. **Deletar a chave ATUAL de `lastPresenceByClientId` durante a própria
--    iteração de `pairs` é seguro em Lua** (documentado no manual da
--    linguagem: só inserir chaves NOVAS durante a travessia é
--    comportamento indefinido) — usado no loop de "sessão sumiu" abaixo.
--    Diferente do cuidado de snapshot em ScriptRegistry.forEach, que existe
--    porque ali o callback do CHAMADOR podia remover uma chave DIFERENTE da
--    que estava sendo iterada; aqui só removemos a própria chave da iteração
--    corrente, então não precisa de snapshot.

local Config = require(script.Parent.Config)
local Logger = require(script.Parent.Logger)
local TeamCreateSchema = require(script.Parent.TeamCreateSchema)
local TeamCreateElection = require(script.Parent.TeamCreateElection)

local TeamCreatePresence = {}

local log = Logger.log

-- callback(message: table) injetado por TeamCreatePresence.init, mesmo padrão
-- de SourceWatcher.init/TeamCreateLease.init — usado só para emitir
-- `presenceChanged`/`presenceLeft` espontâneos (checkPresenceDrift abaixo).
local sendMessage = nil

function TeamCreatePresence.init(onMessage)
	sendMessage = onMessage
end

-- ------------------------------------------------------------------ estado

local enabled = false
local currentToken = 0 -- token de geração (mesmo padrão de todos os outros módulos deste plugin)

local sessionsFolder = nil -- TestService.SyncTeam.Sessions (lido, não é dono — TeamCreateElection é o dono)

-- clientId -> chave composta do último valor visto (dedupe, ver decisão 2 no
-- cabeçalho). Chave ausente == "clientId ainda não observado nesta sessão"
-- (baseline, decisão 3).
local lastPresenceByClientId = {}

local PRESENCE_VALUE_CLASSES = {
	ActiveScriptUuid = "StringValue",
	CursorLine = "IntValue",
	CursorColumn = "IntValue",
	SelectionStartLine = "IntValue",
	SelectionStartColumn = "IntValue",
}

-- "Nenhuma presença" — mesmos sentinelas usados quando a extensão manda
-- uuid=null (ActiveScriptUuid="") e quando a Presence de outra sessão ainda
-- não existe/está incompleta.
local NONE_PRESENCE = {
	uuid = "",
	cursorLine = -1,
	cursorColumn = -1,
	selectionStartLine = -1,
	selectionStartColumn = -1,
}

local function getOrCreate(parent, className, name)
	local existing = parent:FindFirstChild(name)
	if existing ~= nil then
		return existing
	end
	local value = Instance.new(className)
	value.Name = name
	value.Parent = parent
	return value
end

local function ensureContainers()
	if sessionsFolder ~= nil then
		return
	end
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")
end

-- --------------------------------------------------- própria presença (write)

-- Grava a PRÓPRIA Presence a partir de uma mensagem `presenceUpdate` recebida
-- da extensão (chamado por init.server.luau, sem ack — spec M4, item 1).
-- Degrada sem erro se a sessão local ainda não estiver disponível (eleição
-- não iniciada/reiniciando), mesmo princípio de TeamCreateLease.ensureIntent.
function TeamCreatePresence.updateOwnPresence(message)
	if not enabled then
		return
	end

	local sessionFolder = TeamCreateElection.getSessionFolder()
	if sessionFolder == nil then
		return
	end

	local presenceFolder = sessionFolder:FindFirstChild("Presence")
	if presenceFolder == nil then
		presenceFolder = Instance.new("Folder")
		presenceFolder.Name = "Presence"
		presenceFolder.Parent = sessionFolder
	end

	local values = {}
	for name, className in PRESENCE_VALUE_CLASSES do
		values[name] = getOrCreate(presenceFolder, className, name)
	end

	-- Decisão 6 (cabeçalho): dado numérico vem de mensagem externa não
	-- confiável — IntValue.Value exige inteiro, protegido por pcall.
	local ok, err = pcall(function()
		values.ActiveScriptUuid.Value = if type(message.uuid) == "string" then message.uuid else ""
		values.CursorLine.Value = if type(message.cursorLine) == "number" then message.cursorLine else -1
		values.CursorColumn.Value = if type(message.cursorColumn) == "number" then message.cursorColumn else -1
		values.SelectionStartLine.Value = if type(message.selectionStartLine) == "number"
			then message.selectionStartLine
			else -1
		values.SelectionStartColumn.Value = if type(message.selectionStartColumn) == "number"
			then message.selectionStartColumn
			else -1
	end)
	if not ok then
		log(("presenceUpdate: falha ao gravar (dado malformado?): %s"):format(tostring(err)))
	end
end

-- --------------------------------------------------- outras sessões (observação)

-- Nome amigável para presenceChanged: username da sessão do clientId, com
-- fallback pro próprio clientId (mesmo padrão de
-- TeamCreateLease.describeClient, duplicado aqui — decisão 5 no cabeçalho).
local function describeClient(clientId)
	ensureContainers()
	local folder = sessionsFolder:FindFirstChild(clientId)
	if folder ~= nil then
		local username = folder:FindFirstChild("Username")
		if username ~= nil and username:IsA("StringValue") and username.Value ~= "" then
			return username.Value
		end
	end
	return clientId
end

-- Lê a Presence de outra sessão, ou nil se ausente/incompleta (schema
-- malformado/em processo de criação — tratado como NONE_PRESENCE por quem
-- chama, mesmo espírito de readSessionEntry/readLease retornando nil).
local function readPresenceValues(presenceFolder)
	local values = {}
	for name, className in PRESENCE_VALUE_CLASSES do
		local value = presenceFolder:FindFirstChild(name)
		if value == nil or not value:IsA(className) then
			return nil
		end
		values[name] = value
	end
	return {
		uuid = values.ActiveScriptUuid.Value,
		cursorLine = values.CursorLine.Value,
		cursorColumn = values.CursorColumn.Value,
		selectionStartLine = values.SelectionStartLine.Value,
		selectionStartColumn = values.SelectionStartColumn.Value,
	}
end

local function presenceKey(presence)
	return table.concat({
		presence.uuid,
		tostring(presence.cursorLine),
		tostring(presence.cursorColumn),
		tostring(presence.selectionStartLine),
		tostring(presence.selectionStartColumn),
	}, "|")
end

-- Converte sentinelas (-1/"") de volta para null e emite presenceChanged, OU
-- emite presenceLeft se a presença zerou pra "nenhum" (decisão 4a do
-- cabeçalho) — chamado só quando a chave de dedupe mudou em relação à última
-- observada para este clientId.
local function emitPresence(clientId, presence)
	if presence.uuid == "" then
		if sendMessage ~= nil then
			sendMessage({ kind = "presenceLeft", clientId = clientId })
		end
		-- 2026-07-20 (BUG 2, ruído de uso contínuo — docs/DECISIONS.md):
		-- rotineiro/alta frequência (zera a cada troca/fechamento de arquivo no
		-- VS Code, não só saída real da sessão) -> Logger.debug.
		Logger.debug(("presenceLeft clientId=%s (presença zerada)"):format(clientId))
		return
	end

	local displayName = describeClient(clientId)
	if sendMessage ~= nil then
		sendMessage({
			kind = "presenceChanged",
			clientId = clientId,
			displayName = displayName,
			uuid = presence.uuid,
			cursorLine = if presence.cursorLine == -1 then nil else presence.cursorLine,
			cursorColumn = if presence.cursorColumn == -1 then nil else presence.cursorColumn,
			selectionStartLine = if presence.selectionStartLine == -1 then nil else presence.selectionStartLine,
			selectionStartColumn = if presence.selectionStartColumn == -1 then nil else presence.selectionStartColumn,
		})
	end
	-- 2026-07-20 (BUG 2, ruído de uso contínuo — docs/DECISIONS.md): rotineiro/
	-- alta frequência (dispara a cada movimento de cursor/seleção) -> Logger.debug.
	Logger.debug(("presenceChanged clientId=%s (%s) uuid=%s cursor=%d,%d"):format(
		clientId,
		displayName,
		presence.uuid,
		presence.cursorLine,
		presence.cursorColumn
	))
end

-- Ciclo de observação (M4): para cada sessão viva que não seja a própria,
-- compara a Presence atual contra o último valor visto (dedupe) e emite
-- presenceChanged/presenceLeft na mudança; para sessões que tinham presença
-- conhecida e SUMIRAM desta varredura (Folder destruído), emite presenceLeft
-- (decisão 4b do cabeçalho). Roda no mesmo ciclo/cadência de
-- TeamCreateLease.checkLeaseDrift (Config.POLL_INTERVAL_SECONDS).
local function checkPresenceDrift()
	ensureContainers()
	local myClientId = TeamCreateElection.getClientId()
	local seenThisCycle = {}

	for _, folder in ipairs(sessionsFolder:GetChildren()) do
		if not folder:IsA("Folder") then
			continue
		end
		local clientId = folder.Name
		if clientId == myClientId then
			continue -- spec M4, item 3: nunca a própria sessão
		end
		seenThisCycle[clientId] = true

		local presence = NONE_PRESENCE
		local presenceFolder = folder:FindFirstChild("Presence")
		if presenceFolder ~= nil then
			local read = readPresenceValues(presenceFolder)
			if read ~= nil then
				presence = read
			end
		end

		local key = presenceKey(presence)
		local lastKey = lastPresenceByClientId[clientId]

		if lastKey == nil then
			-- Primeira observação deste clientId nesta sessão: só baseline
			-- (decisão 3 do cabeçalho, mesmo princípio de checkLeaseDrift).
			lastPresenceByClientId[clientId] = key
			continue
		end
		if lastKey == key then
			continue
		end
		lastPresenceByClientId[clientId] = key
		emitPresence(clientId, presence)
	end

	-- Sobrou em lastPresenceByClientId sem aparecer nesta varredura = sessão
	-- removida de Sessions/ (decisão 4b). Deletar a chave ATUAL durante esta
	-- iteração é seguro em Lua (decisão 7 do cabeçalho).
	for clientId in lastPresenceByClientId do
		if clientId ~= myClientId and not seenThisCycle[clientId] then
			lastPresenceByClientId[clientId] = nil
			if sendMessage ~= nil then
				sendMessage({ kind = "presenceLeft", clientId = clientId })
			end
			-- 2026-07-20 (BUG 2, mesmo critério do presenceLeft acima): sessão
			-- some de Sessions/ também por timeout/cleanupStaleSessions (20s),
			-- não só saída real -> Logger.debug.
			Logger.debug(("presenceLeft clientId=%s (sessão removida)"):format(clientId))
		end
	end
end

-- ---------------------------------------------------------- leitura p/ UI (M4.5)
--
-- Read-only, pedido pelo painel de status do plugin (plugin/src/ui/): "essa
-- sessão está vendo algum script agora (sem lease de escrita)?" — reusa
-- readPresenceValues, mesmo parser de checkPresenceDrift. Não participa do
-- ciclo de observação/dedupe acima (não mexe em lastPresenceByClientId).
-- nil se a sessão não existe, não tem Presence ainda, ou zerou (uuid == "").
function TeamCreatePresence.getActiveUuid(clientId)
	ensureContainers()
	local folder = sessionsFolder:FindFirstChild(clientId)
	if folder == nil then
		return nil
	end
	local presenceFolder = folder:FindFirstChild("Presence")
	if presenceFolder == nil then
		return nil
	end
	local values = readPresenceValues(presenceFolder)
	if values == nil or values.uuid == "" then
		return nil
	end
	return values.uuid
end

-- ------------------------------------------------------------ start/stop

-- Ciclo PRÓPRIO deste módulo (mesmo padrão de checkLeaseDrift em
-- TeamCreateLease.luau): task.spawn a Config.POLL_INTERVAL_SECONDS, guardado
-- por token de geração.
function TeamCreatePresence.start()
	if enabled then
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken

	ensureContainers()
	lastPresenceByClientId = {}

	task.spawn(function()
		while enabled and currentToken == myToken do
			task.wait(Config.POLL_INTERVAL_SECONDS)
			if enabled and currentToken == myToken then
				checkPresenceDrift()
			end
		end
	end)

	-- 2026-07-16: Logger.debug (ruído rotineiro de boot, ver Logger.luau) —
	-- continua encaminhado por WS, só não polui o Output a cada conexão.
	Logger.debug("presença: ciclo iniciado.")
end

-- Não precisa destruir a própria Presence explicitamente: vive sob
-- Sessions/<clientId>, destruída em cascata quando TeamCreateElection.stop()
-- destrói a própria sessão de forma síncrona (mesmo raciocínio já registrado
-- em TeamCreateLease.stop() para LeaseIntents). Só limpa estado em memória.
function TeamCreatePresence.stop()
	if not enabled then
		return
	end
	enabled = false
	currentToken += 1
	lastPresenceByClientId = {}
	log("presença: ciclo parado.")
end

return TeamCreatePresence
