-- SyncTeam — Sessions + heartbeat + eleição de líder (M3.1)
--
-- Porte DIRETO do algoritmo já validado em 2 Studios reais no RojoCoop
-- (TeamCreateElection.lua: elect/observeCandidate/assignJoinSequences — copiados
-- sem alterar a lógica nem as constantes de tempo) e do ciclo de
-- heartbeat/tick que os conecta ao schema (TeamCreateCoordinator.lua:
-- __tick/__readSessions/__assignJoinSequences/__cleanupStaleSessions),
-- simplificado para o escopo desta fatia: SEM leases/intents/SchemaVersion
-- (isso é M3.2/M3.3, docs/MILESTONES.md) e sem comparação com servidor Rust
-- (não existe servidor no SyncTeam).
--
-- Schema sob TestService.SyncTeam/ (container raiz compartilhado com
-- ScriptRegistry via TeamCreateSchema.luau, novo nesta fatia):
--   LeaderClientId: StringValue, LeaderTerm: IntValue, NextJoinSequence: IntValue
--   Sessions/<clientId>/ (ClientId, UserId, Username, JoinSequence, Pulse,
--     ObservedRole: StringValue "leader"|"follower")
--
-- Decisões tomadas nesta fatia (registradas também em
-- docs/PROJECT_STATUS.md/luau-dev.md, não 100% especificadas na tarefa):
--
-- 1. ClientId é gerado de NOVO a cada start() (HttpService:GenerateGUID(false)),
--    não persistido entre reloads do plugin. Motivo: stop() já remove a
--    própria entrada de Sessions/ de forma SÍNCRONA (item 6 da tarefa, mesmo
--    cuidado do fix de WebStreamClient do M2) — não há entrada órfã
--    acumulando por reload normal, então persistir clientId só ganharia
--    continuidade de JoinSequence/ObservedRole entre reloads, o que não tem
--    valor aqui (o modelo trata cada start() como uma nova sessão de
--    participante, igual ao RojoCoop: TeamCreateCoordinator.new recebe um
--    clientId novo por instância do coordinator, nunca persistido em disco).
-- 2. Username via Players:GetNameFromUserIdAsync (pcall, fallback
--    tostring(userId)) — MESMO padrão já usado e validado no RojoCoop
--    (TeamCreateCoordinator:__resolveUsername), portado sem alteração. Não é
--    pesquisa de API nova: é porte de componente já exercitado em 2 Studios
--    reais (tabela de componentes validados do CLAUDE.md).
-- 3. Log claro de liderança ("sou o líder agora (term N)" / "líder atual: X
--    (term N)") sugerido como opcional pela tarefa — implementado, ajuda a
--    validar visualmente com 2 Studios reais depois.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local TeamCreateSchema = require(script.Parent.TeamCreateSchema)

local TeamCreateElection = {}

-- Constantes validadas em 2 Studios reais no RojoCoop (incluindo failover
-- forçado) — NÃO alterar sem registro em docs/DECISIONS.md
-- (.claude/rules/luau.md).
TeamCreateElection.PULSE_INTERVAL_SECONDS = 2
TeamCreateElection.STALE_AFTER_SECONDS = 8
TeamCreateElection.CLEANUP_AFTER_SECONDS = 20
TeamCreateElection.PROMOTION_OBSERVATIONS = 2

local function log(...)
	print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), ...)
end

-- ------------------------------------------------- algoritmo de eleição
-- Porte 1:1 de RojoCoop/rojo-7.7.0-rc.1/plugin/src/TeamCreateElection.lua —
-- não redesenhar (docs/MILESTONES.md, M3.1).

local function isLive(session, staleAfter)
	return session.heartbeatAge <= staleAfter
end

local function compareAssigned(left, right)
	if left.joinSequence ~= right.joinSequence then
		return left.joinSequence < right.joinSequence
	end
	return left.clientId < right.clientId
end

-- Bootstrap (nenhuma sessão viva tem JoinSequence > 0 ainda): menor clientId
-- assume. Eleição normal: menor JoinSequence vivo, clientId como desempate.
function TeamCreateElection.elect(sessions, staleAfter)
	staleAfter = staleAfter or TeamCreateElection.STALE_AFTER_SECONDS

	local assigned = {}
	local unassigned = {}

	for _, session in ipairs(sessions) do
		if isLive(session, staleAfter) then
			if session.joinSequence > 0 then
				table.insert(assigned, session)
			else
				table.insert(unassigned, session)
			end
		end
	end

	if #assigned > 0 then
		table.sort(assigned, compareAssigned)
		return assigned[1].clientId
	end

	table.sort(unassigned, function(left, right)
		return left.clientId < right.clientId
	end)

	return if unassigned[1] then unassigned[1].clientId else nil
end

-- Promoção de líder só depois de N (PROMOTION_OBSERVATIONS) observações
-- consecutivas do MESMO candidato — evita flapping de líder por uma leitura
-- instável isolada de sessions.
function TeamCreateElection.observeCandidate(previous, candidate, requiredObservations)
	requiredObservations = requiredObservations or TeamCreateElection.PROMOTION_OBSERVATIONS

	if candidate == nil then
		return { candidate = nil, observations = 0, leader = nil }
	end

	local observations = 1
	if previous ~= nil and previous.candidate == candidate then
		observations = previous.observations + 1
	end

	return {
		candidate = candidate,
		observations = observations,
		leader = if observations >= requiredObservations then candidate else nil,
	}
end

function TeamCreateElection.assignJoinSequences(sessions, nextJoinSequence)
	local unassigned = {}
	for _, session in ipairs(sessions) do
		if session.joinSequence <= 0 then
			table.insert(unassigned, session)
		end
	end

	table.sort(unassigned, function(left, right)
		return left.clientId < right.clientId
	end)

	local assignments = {}
	for _, session in ipairs(unassigned) do
		assignments[session.clientId] = nextJoinSequence
		nextJoinSequence += 1
	end

	return assignments, nextJoinSequence
end

-- ------------------------------------------------------------- estado

local enabled = false
local currentToken = 0 -- token de geração (mesmo padrão de SourceWatcher/init.server.luau)

local sessionsFolder = nil -- TestService.SyncTeam.Sessions
local rootValues = nil -- {LeaderClientId, LeaderTerm, NextJoinSequence} (Instances de valor)

local clientId = nil
local userId = 0
local sessionFolder = nil -- TestService.SyncTeam.Sessions.<clientId>
local sessionValues = nil -- {ClientId, UserId, Username, JoinSequence, Pulse, ObservedRole}

local pulseObservations = {} -- clientId -> {pulse, observedAt}
local candidateObservation = nil -- {candidate, observations, leader}
local announcedLeader = nil

-- ------------------------------------------------------------- schema (Sessions/<clientId>)

local SESSION_VALUE_CLASSES = {
	ClientId = "StringValue",
	UserId = "IntValue",
	Username = "StringValue",
	JoinSequence = "IntValue",
	Pulse = "IntValue",
	ObservedRole = "StringValue",
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

-- Cria (ou reaproveita, se já existisse por algum motivo) a própria entrada
-- de sessão e popula os campos iniciais. Chamado 1x em start().
local function ensureOwnSession()
	local folder = sessionsFolder:FindFirstChild(clientId)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = clientId
		folder.Parent = sessionsFolder
	end

	local values = {}
	for name, className in SESSION_VALUE_CLASSES do
		values[name] = getOrCreate(folder, className, name)
	end

	values.ClientId.Value = clientId
	values.UserId.Value = userId
	if values.ObservedRole.Value == "" then
		values.ObservedRole.Value = "follower"
	end

	sessionFolder = folder
	sessionValues = values
end

-- Lê uma entrada de Sessions/<clientId> já existente (própria ou de outro
-- Studio, replicada via Team Create). nil se a entrada estiver incompleta
-- (schema versionado/validação é M3.2/M3.3, fora de escopo desta fatia).
local function readSessionEntry(folder)
	local values = {}
	for name, className in SESSION_VALUE_CLASSES do
		local value = folder:FindFirstChild(name)
		if value == nil or not value:IsA(className) then
			return nil
		end
		values[name] = value
	end
	return {
		folder = folder,
		values = values,
		clientId = values.ClientId.Value,
		joinSequence = values.JoinSequence.Value,
		pulse = values.Pulse.Value,
		userId = values.UserId.Value,
		username = values.Username.Value,
	}
end

-- Varre Sessions/ e devolve as entradas válidas com heartbeatAge calculado
-- por OBSERVAÇÃO local de mudança de Pulse (mesmo princípio já usado para
-- Source.Changed/scriptRemoved desde o M0.5/M2: nunca confiar só num
-- timestamp remoto, medir localmente desde a última vez que o Pulse mudou).
local function readSessions(now)
	local sessions = {}
	for _, folder in ipairs(sessionsFolder:GetChildren()) do
		if not folder:IsA("Folder") then
			continue
		end
		local entry = readSessionEntry(folder)
		if entry == nil or entry.clientId == "" then
			continue
		end

		local observation = pulseObservations[entry.clientId]
		if observation == nil or observation.pulse ~= entry.pulse then
			observation = { pulse = entry.pulse, observedAt = now }
			pulseObservations[entry.clientId] = observation
		end
		entry.heartbeatAge = math.max(0, now - observation.observedAt)

		table.insert(sessions, entry)
	end
	return sessions
end

-- Atribui JoinSequence a sessões vivas ainda sem uma (chamado só pelo líder).
local function applyJoinSequenceAssignments(sessions)
	local liveSessions = {}
	for _, session in ipairs(sessions) do
		if session.heartbeatAge <= TeamCreateElection.STALE_AFTER_SECONDS then
			table.insert(liveSessions, session)
		end
	end

	local assignments, newNext = TeamCreateElection.assignJoinSequences(liveSessions, rootValues.NextJoinSequence.Value)
	for _, session in ipairs(liveSessions) do
		local assigned = assignments[session.clientId]
		if assigned ~= nil and session.values.JoinSequence.Value <= 0 then
			session.values.JoinSequence.Value = assigned
			log(("joinSequence atribuído clientId=%s sequence=%d"):format(session.clientId, assigned))
		end
	end
	rootValues.NextJoinSequence.Value = newNext
end

-- Remove (Folder:Destroy()) sessões (que não a própria) obsoletas há mais de
-- CLEANUP_AFTER_SECONDS — só o líder faz isso (item 5 da tarefa). A própria
-- sessão nunca é limpa por aqui: sai de Sessions/ só via stop() síncrono
-- (item 6) ou porque outro Studio a considera obsoleta se este Studio caiu
-- sem chamar stop() (plugin.Unloading cobre o caso normal).
local function cleanupStaleSessions(sessions)
	for _, session in ipairs(sessions) do
		if
			session.clientId ~= clientId
			and session.heartbeatAge >= TeamCreateElection.CLEANUP_AFTER_SECONDS
			and session.folder.Parent == sessionsFolder
		then
			log(("removendo sessão obsoleta clientId=%s heartbeatAge=%.1fs"):format(session.clientId, session.heartbeatAge))
			session.folder:Destroy()
			pulseObservations[session.clientId] = nil
		end
	end
end

-- ------------------------------------------------------------------- tick

local function tick()
	if not enabled or sessionFolder == nil or sessionFolder.Parent == nil then
		return
	end

	local now = os.clock()
	sessionValues.Pulse.Value += 1

	local sessions = readSessions(now)
	local candidate = TeamCreateElection.elect(sessions, TeamCreateElection.STALE_AFTER_SECONDS)
	candidateObservation = TeamCreateElection.observeCandidate(
		candidateObservation,
		candidate,
		TeamCreateElection.PROMOTION_OBSERVATIONS
	)
	local leaderClientId = candidateObservation.leader

	if leaderClientId == clientId then
		if rootValues.LeaderClientId.Value ~= clientId then
			rootValues.LeaderTerm.Value += 1
			rootValues.LeaderClientId.Value = clientId
			log(("sou o líder agora (term %d)"):format(rootValues.LeaderTerm.Value))
		end
		applyJoinSequenceAssignments(sessions)
		cleanupStaleSessions(sessions)
	end

	local localRole = if leaderClientId == clientId then "leader" else "follower"
	sessionValues.ObservedRole.Value = localRole

	if leaderClientId ~= nil and leaderClientId ~= announcedLeader then
		announcedLeader = leaderClientId
		if leaderClientId ~= clientId then
			log(("líder atual: %s (term %d)"):format(leaderClientId, rootValues.LeaderTerm.Value))
		end
	end
end

-- ------------------------------------------------------------ start/stop

-- userIdParam: resultado de StudioService:GetUserId() (já resolvido pelo
-- chamador, init.server.luau — este módulo não chama StudioService
-- diretamente para não duplicar o pcall que init.server.luau já faz para o
-- `hello`).
function TeamCreateElection.start(userIdParam)
	if enabled then
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken

	local root = TeamCreateSchema.ensureRoot()
	rootValues = root.values
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")

	-- Decisão 1 (ver cabeçalho do arquivo): clientId novo a cada start(), não
	-- persistido entre reloads — stop() remove a própria entrada de forma
	-- síncrona, então não há acúmulo de lixo por reload normal.
	clientId = HttpService:GenerateGUID(false)
	userId = userIdParam or 0
	pulseObservations = {}
	candidateObservation = nil
	announcedLeader = nil

	ensureOwnSession()
	log(("sessão criada clientId=%s userId=%d"):format(clientId, userId))

	-- Username via Players:GetNameFromUserIdAsync (yield), então roda em
	-- task.spawn separado — decisão 2 do cabeçalho. Reconfere token/enabled
	-- antes de escrever de volta (mesmo cuidado de todo yield neste projeto:
	-- start()/stop() pode ter rodado de novo enquanto isso resolvia).
	task.spawn(function()
		local fallback = tostring(userId)
		local username = fallback
		if userId > 0 then
			local ok, resolved = pcall(Players.GetNameFromUserIdAsync, Players, userId)
			if ok and type(resolved) == "string" and resolved ~= "" then
				username = resolved
			end
		end
		if enabled and currentToken == myToken and sessionValues ~= nil then
			sessionValues.Username.Value = username
		end
	end)

	tick()
	task.spawn(function()
		while enabled and currentToken == myToken do
			task.wait(TeamCreateElection.PULSE_INTERVAL_SECONDS)
			if enabled and currentToken == myToken then
				tick()
			end
		end
	end)
end

-- Remove a própria entrada de Sessions/ de forma SÍNCRONA (item 6 da
-- tarefa) — não depende do loop de heartbeat (task.spawn) notar isso depois.
-- Mesmo cuidado já tomado com WebStreamClient:Close() no fix do M2
-- (docs/DECISIONS.md 2026-07-04): plugin.Unloading pode não dar chance de
-- uma coroutine assíncrona rodar cleanup.
function TeamCreateElection.stop()
	if not enabled then
		return
	end
	enabled = false
	currentToken += 1

	if sessionFolder ~= nil and sessionFolder.Parent ~= nil then
		sessionFolder:Destroy()
	end

	log(("sessão removida clientId=%s"):format(tostring(clientId)))

	sessionFolder = nil
	sessionValues = nil
	clientId = nil
	candidateObservation = nil
	announcedLeader = nil
	pulseObservations = {}
end

-- Exposto só para eventual UI/diagnóstico futuro (não usado nesta fatia).
function TeamCreateElection.getClientId()
	return clientId
end

-- Exposto para TeamCreateLease.luau (M3.2): o Folder
-- TestService.SyncTeam.Sessions.<clientId> da PRÓPRIA sessão, onde
-- TeamCreateLease cria a subpasta LeaseIntents/<uuid> ao registrar um
-- intent de edição. nil se a eleição não estiver rodando (start() não
-- chamado ainda, ou stop() já rodou) OU se a sessão tiver sido destruída —
-- quem chama trata nil como "degradar sem lease" (ver
-- TeamCreateLease.ensureIntent), nunca como erro fatal.
function TeamCreateElection.getSessionFolder()
	if sessionFolder == nil or sessionFolder.Parent == nil then
		return nil
	end
	return sessionFolder
end

function TeamCreateElection.isLeader()
	return rootValues ~= nil and clientId ~= nil and rootValues.LeaderClientId.Value == clientId
end

return TeamCreateElection
