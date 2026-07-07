-- SyncTeam — Leases autoritativas por script (M3.2)
--
-- Porte do algoritmo de decisão já validado em 2 Studios reais no RojoCoop:
-- `TeamCreateShadowLease.lua` (chooseWinner/assignRequestSequences/
-- groupByScript — cópia direta da lógica de comparação, sem alterar) e
-- `TeamCreateCoordinator.lua` (ciclo __assignRequestSequences/
-- __reconcileShadowLeases/__tick — mesmo ciclo, ignorando tudo sobre
-- comparação com servidor Rust e SchemaVersion, que não existem aqui).
--
-- DIFERENÇA DELIBERADA em relação ao RojoCoop (docs/DECISIONS.md
-- 2026-07-02, docs/ARCHITECTURE.md): lá as leases eram "shadow" (só
-- observação, nunca bloqueavam escrita — quem bloqueava de verdade era o
-- servidor Rust). Aqui as leases são AUTORITATIVAS desde o início: o plugin
-- recusa `writeSource` de quem não é o dono. Ver `TeamCreateLease.canWrite`
-- e a integração em `init.server.luau` (`handleWriteSource`).
--
-- OUTRA DIFERENÇA: o RojoCoop arbitrava a própria identidade do script
-- (scriptKey) dentro do ciclo de leases (`__resolveScriptRegistry`), porque
-- não tinha registry de UUID prévio. O SyncTeam já resolve identidade desde
-- o M2 (`ScriptRegistry.luau`) — os intents aqui já chegam com um uuid
-- conhecido (chave da pasta `LeaseIntents/<uuid>`), então não existe
-- equivalente a `__resolveScriptRegistry` nesta fatia.
--
-- Schema (sob TestService.SyncTeam, container raiz de TeamCreateSchema.luau):
--   NextLeaseRequestSequence: IntValue (adicionado a TeamCreateSchema.ROOT_VALUES)
--   Sessions/<clientId>/LeaseIntents/<uuid>/ (IntentId: StringValue GUID,
--     Pulse: IntValue, RequestSequence: IntValue, ScriptRef: ObjectValue)
--     — subpasta de Sessions/<clientId>, que é OWNED por TeamCreateElection;
--     este módulo só lê/escreve dentro dela via
--     TeamCreateElection.getSessionFolder() (accessor novo desta fatia).
--   Leases/<uuid>/ (OwnerClientId: StringValue, LeaseId: StringValue GUID,
--     LeaderTerm: IntValue, RequestSequence: IntValue)
--
-- Decisões tomadas nesta fatia (registradas também em
-- docs/PROJECT_STATUS.md/luau-dev.md, não 100% especificadas na tarefa):
--
-- 1. A checagem "tenho a lease deste uuid?" e a recusa de writeSource NÃO
--    ficam dentro de SourceWatcher.luau — ficam em init.server.luau
--    (handleWriteSource), no mesmo lugar que já distingue modo
--    atualização/criação pela presença de `uuid`. Motivo: manter
--    SourceWatcher.luau focado só em I/O de Source + ScriptRegistry (como
--    já documentado no cabeçalho dele); TeamCreateElection/TeamCreateLease
--    já são requeridos em init.server.luau, que é quem orquestra semântica
--    de protocolo — evita criar uma dependência nova de SourceWatcher para
--    TeamCreateLease só para isso.
-- 2. Ciclo do líder roda em `task.spawn` PRÓPRIO deste módulo (não
--    acoplado ao tick interno de TeamCreateElection), checando
--    `TeamCreateElection.isLeader()` no início de cada iteração — opção
--    explicitamente sugerida como alternativa mais simples pela tarefa, e
--    que evita tocar no loop de heartbeat já validado do M3.1.
-- 3. "Vivo" para um intent é decidido só pela observação local de mudança
--    do próprio `Pulse` (mesmo princípio de Source.Changed/scriptRemoved/
--    heartbeat desde M0.5/M2/M3.1) — NÃO verifica adicionalmente se a
--    SESSÃO dona está viva (RojoCoop fazia essa checagem extra em
--    `__readLiveIntents`). Simplificação deliberada: como o Pulse do
--    intent só é incrementado por um writeSource local (não por um timer
--    de heartbeat independente), se a sessão dona morrer o Pulse do
--    intent também para de mudar e ele fica "morto" pela ótica desta
--    checagem, no mesmo prazo (STALE_AFTER_SECONDS). Revisitar se teste
--    real mostrar um cenário onde isso diverge.
-- 4. Pastas de intent NUNCA são destruídas por este módulo quando ficam
--    obsoletas (só as entradas em `Leases/<uuid>` são criadas/atualizadas/
--    destruídas). Diferente do RojoCoop (`__pulseLocalIntents` removia
--    intents locais inativos expirados). Consequência aceita: uma sessão
--    de Studio longa, editando muitos scripts diferentes, acumula uma
--    pasta `LeaseIntents/<uuid>` por script já tocado, nunca removida
--    enquanto a sessão estiver viva — só é limpa quando a sessão inteira
--    morre (Folder:Destroy() em `TeamCreateElection.stop()` ou
--    `cleanupStaleSessions`, que destrói `Sessions/<clientId>` inteiro,
--    levando `LeaseIntents` junto). Não é escopo desta fatia (não pedido
--    na tarefa); registrar como possível polish futuro se virar problema
--    real.
--
-- M3.3 (expor identidade + mudança de lease pra extensão) — decisão tomada
-- aqui, não em SourceWatcher.luau (opção (b) das duas oferecidas pela
-- tarefa): `checkLeaseDrift`, ciclo PRÓPRIO deste módulo (task.spawn a
-- Config.POLL_INTERVAL_SECONDS, ver start()), varre
-- ScriptRegistry.forEach comparando TeamCreateLease.getOwner(uuid) contra o
-- último dono visto (lastOwnerByUuid, dedupe) e emite `leaseChanged
-- {uuid, ownerClientId, ownerDisplayName}` via callback injetado por
-- TeamCreateLease.init(onMessage) (mesmo padrão de SourceWatcher.init).
-- Motivo de NÃO usar a opção (a): o cabeçalho deste arquivo já documenta
-- (decisão 1 acima) que a integração de lease foi mantida FORA de
-- SourceWatcher.luau de propósito; colocar checkLeaseDrift lá criaria
-- exatamente a dependência nova (SourceWatcher -> TeamCreateLease) que essa
-- decisão evitou. Rodar a Config.POLL_INTERVAL_SECONDS (0.5s), não
-- PULSE_INTERVAL_SECONDS (2s): leaseChanged é sinal de UX (arquivo virou
-- read-only ou foi liberado), então a responsividade alvo é a mesma do
-- resto da UI de sincronização (Source), não a cadência de heartbeat de
-- eleição. Primeira observação de um uuid nesta sessão só grava baseline
-- sem emitir (evita rajada de leaseChanged para leases já existentes no
-- momento em que este Studio conecta) — ver comentário em checkLeaseDrift.

local HttpService = game:GetService("HttpService")

local Config = require(script.Parent.Config)
local TeamCreateSchema = require(script.Parent.TeamCreateSchema)
local TeamCreateElection = require(script.Parent.TeamCreateElection)
local ScriptRegistry = require(script.Parent.ScriptRegistry)

local TeamCreateLease = {}

local function log(...)
	print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), ...)
end

-- M3.3: callback(message: table) injetado por TeamCreateLease.init, mesmo
-- padrão de SourceWatcher.init — usado só para emitir `leaseChanged`
-- espontâneo (checkLeaseDrift abaixo). Quem injeta (init.server.luau) decide
-- como/se enviar pela conexão WS ativa.
--
-- BUG CORRIGIDO (2026-07-04, code review): esta declaração `local` precisa
-- vir ANTES de `TeamCreateLease.init` abaixo. Na ordem original (init()
-- definida antes deste `local`), a atribuição `sendMessage = onMessage`
-- dentro de init() criava/escrevia uma variável GLOBAL solta em vez de
-- fechar sobre esta local — checkLeaseDrift (que fecha sobre a local
-- declarada aqui) nunca recebia o valor injetado, e nenhum `leaseChanged`
-- jamais era enviado. Ver docs/DECISIONS.md.
local sendMessage = nil

-- Injeta o callback usado por checkLeaseDrift para emitir `leaseChanged`
-- espontâneo (M3.3). Chamado por init.server.luau antes de
-- TeamCreateLease.start(), mesmo padrão de SourceWatcher.init.
function TeamCreateLease.init(onMessage)
	sendMessage = onMessage
end

-- ------------------------------------------------------------------ estado

local enabled = false
local currentToken = 0 -- token de geração (mesmo padrão de todos os outros módulos deste plugin)

local leasesFolder = nil -- TestService.SyncTeam.Leases
local sessionsFolder = nil -- TestService.SyncTeam.Sessions (lido, não é dono — TeamCreateElection é o dono)
local rootValues = nil -- {LeaderClientId, LeaderTerm, NextJoinSequence, NextLeaseRequestSequence}

local ownIntents = {} -- uuid -> { folder, values = {IntentId, Pulse, RequestSequence, ScriptRef} }
local intentPulseObservations = {} -- "clientId:uuid" -> {pulse, observedAt} (bookkeeping do ciclo do líder)

-- M3.3: uuid -> último OwnerClientId observado (dedupe), OU NO_OWNER_KEY
-- quando a última observação foi "sem lease". Mesmo princípio de dedupe por
-- último valor visto já usado para Source/registry/sessões desde
-- M0.5/M2/M3.1 (nunca reagir a estado, só a MUDANÇA de estado observada
-- localmente). Ausência de uma chave em lastOwnerByUuid significa "uuid
-- ainda não observado nesta sessão" — usado para não emitir leaseChanged na
-- primeira vez que um uuid é visto (baseline, evita rajada de mensagens para
-- leases já existentes no momento em que este Studio conecta/inicia).
local lastOwnerByUuid = {}
local NO_OWNER_KEY = "" -- sentinela: OwnerClientId real é sempre um GUID não-vazio

local INTENT_VALUE_CLASSES = {
	IntentId = "StringValue",
	Pulse = "IntValue",
	RequestSequence = "IntValue",
	ScriptRef = "ObjectValue",
}

local LEASE_VALUE_CLASSES = {
	OwnerClientId = "StringValue",
	LeaseId = "StringValue",
	LeaderTerm = "IntValue",
	RequestSequence = "IntValue",
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
	if leasesFolder ~= nil then
		return
	end
	local root = TeamCreateSchema.ensureRoot()
	rootValues = root.values
	leasesFolder = TeamCreateSchema.ensureFolder("Leases")
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")
end

-- ------------------------------------------------------- intent (todo Studio)

-- Cria/atualiza o próprio intent de edição para `uuid` sob
-- Sessions/<meuClientId>/LeaseIntents/<uuid>, incrementando Pulse. Chamado
-- ANTES de toda escrita em modo atualização (spec M3.2, item 1) — quem
-- decide QUANDO chamar é init.server.luau (handleWriteSource), não este
-- módulo. Degrada silenciosamente (sem erro) se a sessão local ainda não
-- estiver disponível (eleição não iniciada/reiniciando) — a checagem de
-- lease seguinte (canWrite) trata "sem intent registrado ainda" como
-- "sem lease" e permite otimisticamente (spec M3.2, item 2).
function TeamCreateLease.ensureIntent(uuid, instance)
	if not enabled or type(uuid) ~= "string" or uuid == "" then
		return
	end
	ensureContainers()

	local sessionFolder = TeamCreateElection.getSessionFolder()
	if sessionFolder == nil then
		return
	end

	local intentsFolder = sessionFolder:FindFirstChild("LeaseIntents")
	if intentsFolder == nil then
		intentsFolder = Instance.new("Folder")
		intentsFolder.Name = "LeaseIntents"
		intentsFolder.Parent = sessionFolder
	end

	local record = ownIntents[uuid]
	if record == nil or record.folder.Parent == nil then
		local folder = intentsFolder:FindFirstChild(uuid)
		if folder == nil then
			folder = Instance.new("Folder")
			folder.Name = uuid
			folder.Parent = intentsFolder
		end
		local values = {}
		for name, className in INTENT_VALUE_CLASSES do
			values[name] = getOrCreate(folder, className, name)
		end
		if values.IntentId.Value == "" then
			values.IntentId.Value = HttpService:GenerateGUID(false)
		end
		record = { folder = folder, values = values }
		ownIntents[uuid] = record
	end

	record.values.ScriptRef.Value = instance
	record.values.Pulse.Value += 1
end

-- ------------------------------------------------- checagem de lease (todo Studio)

-- OwnerClientId atual de Leases/<uuid>, ou nil se a entrada não existe
-- (ninguém foi arbitrado ainda) ou está malformada.
function TeamCreateLease.getOwner(uuid)
	ensureContainers()
	local folder = leasesFolder:FindFirstChild(uuid)
	if folder == nil then
		return nil
	end
	local ownerValue = folder:FindFirstChild("OwnerClientId")
	if ownerValue == nil or not ownerValue:IsA("StringValue") or ownerValue.Value == "" then
		return nil
	end
	return ownerValue.Value
end

-- true se o clientId local pode escrever em `uuid` agora. Spec M3.2 (item 2):
-- sem lease registrada ainda (ninguém arbitrado) OU dono == eu => permite
-- otimisticamente; dono == outro clientId => nega. Segundo valor de retorno
-- é o clientId do dono atual, só quando a escrita é negada (para a mensagem
-- de erro).
function TeamCreateLease.canWrite(uuid)
	local owner = TeamCreateLease.getOwner(uuid)
	if owner == nil then
		return true, nil
	end
	local myClientId = TeamCreateElection.getClientId()
	if owner == myClientId then
		return true, nil
	end
	return false, owner
end

-- Nome amigável para mensagens de erro: username da sessão do clientId, com
-- fallback pro próprio clientId se a sessão não tiver username resolvido
-- ainda (mesma corrida do M3.1: username é resolvido de forma assíncrona
-- via task.spawn separado, pode não estar pronto no primeiro tick).
function TeamCreateLease.describeClient(clientId)
	if clientId == nil then
		return "desconhecido"
	end
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

-- --------------------------------------------------- algoritmo de decisão
-- Porte 1:1 de RojoCoop/rojo-7.7.0-rc.1/plugin/src/TeamCreateShadowLease.lua
-- — não redesenhar (docs/MILESTONES.md, M3.2).

local function compareForSequencing(left, right)
	if left.joinSequence ~= right.joinSequence then
		return left.joinSequence < right.joinSequence
	end
	if left.clientId ~= right.clientId then
		return left.clientId < right.clientId
	end
	return left.intentId < right.intentId
end

local function assignRequestSequences(intents, nextSequence)
	local pending = {}
	for _, intent in ipairs(intents) do
		if intent.requestSequence <= 0 then
			table.insert(pending, intent)
		end
	end
	table.sort(pending, compareForSequencing)

	local assignments = {}
	for _, intent in ipairs(pending) do
		assignments[intent.intentId] = nextSequence
		nextSequence += 1
	end
	return assignments, nextSequence
end

local function compareIntent(left, right)
	if left.requestSequence ~= right.requestSequence then
		return left.requestSequence < right.requestSequence
	end
	if left.joinSequence ~= right.joinSequence then
		return left.joinSequence < right.joinSequence
	end
	if left.clientId ~= right.clientId then
		return left.clientId < right.clientId
	end
	return left.intentId < right.intentId
end

-- SEM PREEMPÇÃO: se o dono atual ainda tem intent vivo no grupo, continua
-- sendo o dono, independente de RequestSequence — só entra a comparação
-- completa quando o dono atual não está mais entre os candidatos vivos.
local function chooseWinner(currentOwnerClientId, intents)
	local ordered = table.clone(intents)
	table.sort(ordered, compareIntent)
	for _, intent in ipairs(ordered) do
		if intent.clientId == currentOwnerClientId then
			return intent
		end
	end
	return ordered[1]
end

local function groupByUuid(intents)
	local grouped = {}
	for _, intent in ipairs(intents) do
		grouped[intent.uuid] = grouped[intent.uuid] or {}
		table.insert(grouped[intent.uuid], intent)
	end
	return grouped
end

-- ------------------------------------------------------- ciclo do líder

-- Varre Sessions/*/LeaseIntents/* e devolve só os intents "vivos" (Pulse
-- mudou há menos de STALE_AFTER_SECONDS, observado localmente — ver decisão
-- 3 no cabeçalho). joinSequence vem da sessão dona (Sessions/<clientId>/
-- JoinSequence), lido diretamente (não precisa de aliveness própria da
-- sessão, ver decisão 3).
local function readLiveIntents(now)
	local intents = {}
	for _, sessionFolder in ipairs(sessionsFolder:GetChildren()) do
		if not sessionFolder:IsA("Folder") then
			continue
		end
		local ownerClientId = sessionFolder.Name
		local joinSequenceValue = sessionFolder:FindFirstChild("JoinSequence")
		local joinSequence = if joinSequenceValue ~= nil and joinSequenceValue:IsA("IntValue")
			then joinSequenceValue.Value
			else 0

		local intentsFolder = sessionFolder:FindFirstChild("LeaseIntents")
		if intentsFolder == nil then
			continue
		end

		for _, folder in ipairs(intentsFolder:GetChildren()) do
			if not folder:IsA("Folder") then
				continue
			end
			local uuid = folder.Name
			local values = {}
			local valid = true
			for name, className in INTENT_VALUE_CLASSES do
				local value = folder:FindFirstChild(name)
				if value == nil or not value:IsA(className) then
					valid = false
					break
				end
				values[name] = value
			end
			if not valid then
				continue
			end
			local scriptInstance = values.ScriptRef.Value
			if scriptInstance == nil then
				continue
			end

			local observationKey = ownerClientId .. ":" .. uuid
			local pulse = values.Pulse.Value
			local observation = intentPulseObservations[observationKey]
			if observation == nil or observation.pulse ~= pulse then
				observation = { pulse = pulse, observedAt = now }
				intentPulseObservations[observationKey] = observation
			end
			local heartbeatAge = math.max(0, now - observation.observedAt)
			if heartbeatAge > TeamCreateElection.STALE_AFTER_SECONDS then
				continue -- intent morto: dev parou de escrever nesse uuid
			end

			table.insert(intents, {
				uuid = uuid,
				clientId = ownerClientId,
				joinSequence = joinSequence,
				intentId = values.IntentId.Value,
				requestSequence = values.RequestSequence.Value,
				values = values,
				scriptInstance = scriptInstance,
			})
		end
	end
	return intents
end

-- Atribui RequestSequence (via NextLeaseRequestSequence) aos intents vivos
-- que ainda não têm um — porte de
-- TeamCreateCoordinator:__assignRequestSequences.
local function applyRequestSequenceAssignments(intents)
	local assignments, newNext = assignRequestSequences(intents, rootValues.NextLeaseRequestSequence.Value)
	for _, intent in ipairs(intents) do
		local assigned = assignments[intent.intentId]
		if assigned ~= nil and intent.values.RequestSequence.Value <= 0 then
			intent.values.RequestSequence.Value = assigned
			intent.requestSequence = assigned
			log(("lease intentSequenced intentId=%s sequence=%d"):format(intent.intentId, assigned))
		end
	end
	rootValues.NextLeaseRequestSequence.Value = newNext
end

local function readLease(folder)
	local values = {}
	for name, className in LEASE_VALUE_CLASSES do
		local value = folder:FindFirstChild(name)
		if value == nil or not value:IsA(className) then
			return nil
		end
		values[name] = value
	end
	return { folder = folder, values = values, ownerClientId = values.OwnerClientId.Value }
end

-- Cria/atualiza Leases/<uuid> pro vencedor de cada grupo (agrupado por
-- uuid), rotacionando LeaseId quando dono OU termo mudam; remove
-- Leases/<uuid> cujo grupo não tem mais nenhum intent vivo (spec M3.2, itens
-- 3-5) — porte de TeamCreateCoordinator:__reconcileShadowLeases, sem a
-- checagem de ObjectValueIdentityValidated (não existe no SyncTeam — a
-- identidade UUID+ObjectValue já é a base do projeto desde o M2, não uma
-- feature opcional a validar em runtime).
local function reconcileLeases(intents, leaderTerm)
	local grouped = groupByUuid(intents)

	local existing = {}
	for _, folder in ipairs(leasesFolder:GetChildren()) do
		if folder:IsA("Folder") then
			existing[folder.Name] = folder
		end
	end

	for uuid, scriptIntents in grouped do
		local leaseFolder = existing[uuid]
		local currentOwner = nil
		if leaseFolder ~= nil then
			local lease = readLease(leaseFolder)
			currentOwner = lease and lease.ownerClientId
		end

		local winner = chooseWinner(currentOwner, scriptIntents)
		if winner == nil then
			continue
		end

		if leaseFolder == nil then
			leaseFolder = Instance.new("Folder")
			leaseFolder.Name = uuid
			leaseFolder.Parent = leasesFolder
		end
		local values = {}
		for name, className in LEASE_VALUE_CLASSES do
			values[name] = getOrCreate(leaseFolder, className, name)
		end

		local ownerChanged = values.OwnerClientId.Value ~= winner.clientId
		local termChanged = values.LeaderTerm.Value ~= leaderTerm
		if ownerChanged or termChanged or values.LeaseId.Value == "" then
			values.LeaseId.Value = HttpService:GenerateGUID(false)
		end
		values.OwnerClientId.Value = winner.clientId
		values.LeaderTerm.Value = leaderTerm
		values.RequestSequence.Value = winner.requestSequence

		if ownerChanged or termChanged then
			log(("lease concedida uuid=%s owner=%s term=%d requestSequence=%d"):format(
				uuid,
				winner.clientId,
				leaderTerm,
				winner.requestSequence
			))
		end

		existing[uuid] = nil
	end

	-- Sobrou em `existing` = uuid sem NENHUM intent vivo neste ciclo: libera
	-- de verdade (spec M3.2, item 5).
	for uuid, folder in existing do
		log(("lease liberada uuid=%s (sem intents vivos)"):format(uuid))
		folder:Destroy()
	end
end

local function leaderTick()
	if not TeamCreateElection.isLeader() then
		return
	end
	local now = os.clock()
	local intents = readLiveIntents(now)
	applyRequestSequenceAssignments(intents)
	reconcileLeases(intents, rootValues.LeaderTerm.Value)
end

-- ------------------------------------------------------ leaseChanged (M3.3)

-- Roda em TODO Studio (não só o líder): para cada uuid CONHECIDO localmente
-- (ScriptRegistry.forEach — o mesmo registry de identidade do M2), compara o
-- dono atual (getOwner) com o último dono visto (dedupe, lastOwnerByUuid) e
-- emite `leaseChanged {uuid, ownerClientId, ownerDisplayName}` só quando
-- muda. Mesmo padrão exato de checkSourceChanged/checkRegistryDrift em
-- SourceWatcher.luau (cache do último valor visto por chave, dedupe).
--
-- Decisão desta fatia (não 100% especificada na tarefa): a PRIMEIRA vez que
-- um uuid aparece no registry nesta sessão só grava a baseline, sem emitir —
-- evita uma rajada de `leaseChanged` para todo script já com lease existente
-- no exato momento em que este Studio conecta/inicia (informação que a
-- extensão não pediu proativamente ainda nesta fatia; fica para um futuro
-- "estado inicial" se necessário). Consequência aceita, análoga à limitação
-- já documentada para LeaseIntents: se um uuid é removido do registry
-- (script deletado) a entrada correspondente em lastOwnerByUuid nunca é
-- limpa — lixo pequeno e inofensivo em memória, não em replicação.
local function checkLeaseDrift()
	ScriptRegistry.forEach(function(uuid, instance, storedPath)
		local owner = TeamCreateLease.getOwner(uuid)
		local ownerKey = owner or NO_OWNER_KEY
		local lastKey = lastOwnerByUuid[uuid]

		if lastKey == nil then
			-- Primeira observação deste uuid nesta sessão: só baseline.
			lastOwnerByUuid[uuid] = ownerKey
			return
		end
		if lastKey == ownerKey then
			return
		end
		lastOwnerByUuid[uuid] = ownerKey

		local ownerDisplayName = TeamCreateLease.describeClient(owner)
		if sendMessage ~= nil then
			sendMessage({
				kind = "leaseChanged",
				uuid = uuid,
				ownerClientId = owner,
				ownerDisplayName = ownerDisplayName,
			})
		end
		log(("leaseChanged uuid=%s owner=%s (%s)"):format(uuid, tostring(owner), ownerDisplayName))
	end)
end

-- ------------------------------------------------------------ start/stop

-- Roda seu PRÓPRIO task.spawn a cada PULSE_INTERVAL_SECONDS (decisão 2 do
-- cabeçalho) — não duplica o loop de heartbeat de TeamCreateElection, só
-- reusa a mesma constante de intervalo.
function TeamCreateLease.start()
	if enabled then
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken

	ensureContainers()
	ownIntents = {}
	intentPulseObservations = {}
	lastOwnerByUuid = {}

	task.spawn(function()
		while enabled and currentToken == myToken do
			task.wait(TeamCreateElection.PULSE_INTERVAL_SECONDS)
			if enabled and currentToken == myToken then
				leaderTick()
			end
		end
	end)

	-- Ciclo PRÓPRIO de checkLeaseDrift (M3.3), independente do leaderTick
	-- acima: roda em TODO Studio (não só líder) e usa
	-- Config.POLL_INTERVAL_SECONDS (0.5s, mesmo intervalo de
	-- checkSourceChanged/checkRegistryDrift em SourceWatcher.luau) em vez de
	-- PULSE_INTERVAL_SECONDS (2s) — leaseChanged é sinal de UX (arquivo
	-- ficou read-only/liberado), então vale a mesma responsividade já usada
	-- para o resto da UI de sincronização, não a cadência mais lenta de
	-- heartbeat/eleição.
	task.spawn(function()
		while enabled and currentToken == myToken do
			task.wait(Config.POLL_INTERVAL_SECONDS)
			if enabled and currentToken == myToken then
				checkLeaseDrift()
			end
		end
	end)

	log("leases: ciclo iniciado.")
end

-- Não precisa destruir LeaseIntents/Leases explicitamente: pastas de intent
-- vivem sob Sessions/<clientId>, destruídas em cascata quando
-- TeamCreateElection.stop() destrói a própria sessão (síncrono, já
-- acontece independentemente desta chamada). Só limpa estado em memória.
function TeamCreateLease.stop()
	if not enabled then
		return
	end
	enabled = false
	currentToken += 1
	ownIntents = {}
	intentPulseObservations = {}
	lastOwnerByUuid = {}
	log("leases: ciclo parado.")
end

return TeamCreateLease
