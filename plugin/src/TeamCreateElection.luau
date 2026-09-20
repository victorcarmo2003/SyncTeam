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
--
-- CORREÇÃO (2026-07-07, docs/DECISIONS.md): primeiro teste real com 2
-- Studios confirmou split-brain de liderança (termos divergentes, 6 vs 1,
-- no mesmo tick). Causa raiz: `TeamCreateSchema.ensureRoot()`/
-- `ensureFolder("Sessions")` eram chamados só 1x dentro de start() (`tick()`
-- rodava sincronamente logo depois, ANTES de qualquer garantia de que a
-- replicação do outro Studio já tinha assentado) e o RESULTADO era cacheado
-- em `rootValues`/`sessionsFolder` para o resto da sessão — se duas
-- Instances-singleton (Folder ou Value) chegassem a ser criadas em paralelo
-- por dois Studios (clássica corrida "FindFirstChild nil -> Instance.new"),
-- cada Studio ficava preso lendo/escrevendo pra sempre na SUA cópia local,
-- mesmo depois da réplica do outro lado chegar como Instance irmã. Fix em
-- duas partes: (a) `TeamCreateSchema.getOrCreate` agora reconcilia
-- duplicatas sempre que é chamado, com desempate determinístico/replicado
-- (atributo `SyncTeamOrigin`) e merge que nunca perde estado (reparent de
-- filhos de Folder; máximo de contadores IntValue) — ver comentário de
-- cabeçalho de TeamCreateSchema.luau; (b) `tick()` (não só start()) agora
-- CHAMA DE NOVO `ensureRoot()`/`ensureFolder("Sessions")` a cada pulso e
-- reatribui `rootValues`/`sessionsFolder`, para este Studio sempre convergir
-- pra Instance canônica atual em vez de ficar preso na referência capturada
-- 1x. Continua sendo best-effort (replicação assíncrona nunca dá garantia
-- 100%), mas agora AUTOCORRIGE em vez de divergir permanentemente.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local Config = require(script.Parent.Config)
local Logger = require(script.Parent.Logger)
local TeamCreateSchema = require(script.Parent.TeamCreateSchema)

local TeamCreateElection = {}

-- Constantes validadas em 2 Studios reais no RojoCoop (incluindo failover
-- forçado) — NÃO alterar sem registro em docs/DECISIONS.md
-- (.claude/rules/luau.md).
TeamCreateElection.PULSE_INTERVAL_SECONDS = 2
TeamCreateElection.STALE_AFTER_SECONDS = 8
TeamCreateElection.CLEANUP_AFTER_SECONDS = 20
TeamCreateElection.PROMOTION_OBSERVATIONS = 2

local log = Logger.log

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
-- Ultimo Username REALMENTE publicado nesta sessao de eleicao (nome do
-- Roblox resolvido por Players:GetNameFromUserIdAsync, ou o nome customizado
-- do dev). Existe por causa da auto-cura de 2026-09-19: quando
-- `ensureOwnSessionAlive` recria a pasta, os valores nascem zerados e o
-- Username NAO se republica sozinho — a resolucao acontece uma vez em
-- start(), num task.spawn que ja terminou ha muito. Sem este cache o colega
-- passa a ver a sessao recuperada com nome VAZIO (medido: "dev_Hakor" virou
-- "db8dc80c" depois da primeira recriacao). Nunca guarda string vazia, entao
-- a primeira chamada de ensureOwnSession (dentro de start(), antes de
-- qualquer resolucao) e no-op.
local publishedUsername = ""

local pulseObservations = {} -- clientId -> {pulse, observedAt}
local candidateObservation = nil -- {candidate, observations, leader}
local announcedLeader = nil

-- Item 2(b) da tarefa 2026-07-21 (toast de colaborador entrou/saiu): roster
-- local de OUTRAS sessões já vistas nesta sessão do plugin, p/ diff
-- tick-a-tick (ver checkSessionRoster abaixo). clientId -> displayName.
local knownOtherSessions = {}
-- Baseline (mesmo princípio de TeamCreatePresence.checkPresenceDrift): a 1ª
-- leitura de sessions nesta sessão do plugin nunca dispara toast (evita
-- rajada de "entrou" pra cada colaborador JÁ conectado quando ESTE Studio
-- conecta).
local rosterBaselined = false

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
	-- Mitigação de undo (2026-07-26, docs/DECISIONS.md): camada 1 (fast-path
	-- best-effort) — ver comentário equivalente em TeamCreateSchema.luau.
	value.Archivable = false
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
		-- Mitigação de undo (2026-07-26, docs/DECISIONS.md): camada 1
		-- (fast-path best-effort) — ver comentário em TeamCreateSchema.luau.
		folder.Archivable = false
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
	-- Ver `publishedUsername`: republica o nome numa pasta recriada pela
	-- auto-cura. No boot ainda esta vazio (a resolucao vem depois, em
	-- start()), entao aqui e no-op na primeira passada.
	if publishedUsername ~= "" then
		values.Username.Value = publishedUsername
	end

	sessionFolder = folder
	sessionValues = values
end

-- CORREÇÃO (2026-09-19, docs/DECISIONS.md — "o colaborador saiu" com os dois
-- Studios abertos e vivos, relatado em teste real com 2 Studios em Team
-- Create): a própria Sessions/<clientId> pode ser destruída POR OUTRO STUDIO
-- a qualquer momento, não só por um Ctrl+Z local. `cleanupStaleSessions` é o
-- caminho normal e esperado: o líder destrói toda sessão com heartbeatAge >=
-- CLEANUP_AFTER_SECONDS. Basta um falso positivo — Studio em segundo plano
-- (a Roblox estrangula `task.wait` na janela sem foco, e com 2 Studios na
-- mesma máquina UM SEMPRE está em segundo plano), ou replicação de Pulse
-- atrasada pelo Team Create — para o líder concluir que o colega morreu e
-- apagar a pasta dele.
--
-- Antes desta correção isso era PERMANENTE, não transitório: `sessionFolder`
-- era capturado 1x em `ensureOwnSession()` dentro de `start()` e nunca mais
-- reavaliado, e o guard do topo de `tick()` (`sessionFolder.Parent == nil`)
-- fazia early-return silencioso para sempre. O lado apagado seguia
-- incrementando `Pulse` numa Instance órfã (Parent nil, não replica), sumia
-- de `Sessions/` dos dois lados, e `getSessionFolder()` passava a devolver
-- nil — levando junto presença (cursor/seleção, TeamCreatePresence) e leases
-- (TeamCreateLease). Resultado observado: cada Studio se vê sozinho e cada
-- um avisa que o colaborador saiu.
--
-- O comentário de `checkIntegrity` (2026-07-26) já descrevia exatamente este
-- estado terminal, mas a recuperação só estava ligada a
-- ChangeHistoryService.OnUndo/OnRedo — a porta rara. A porta comum é o
-- cleanup do outro Studio, e ela não passava por lá.
--
-- Com a recriação por pulso, um cleanup indevido custa <= PULSE_INTERVAL
-- (2s) de invisibilidade em vez de a sessão inteira. Por isso
-- CLEANUP_AFTER_SECONDS continua em 20s: com auto-cura o falso positivo é
-- barato, e afrouxar o prazo só atrasaria a limpeza de sessão realmente
-- morta.
--
-- `Parent ~= sessionsFolder` (e não `Parent == nil`) de propósito: a
-- reconciliação de duplicatas do TeamCreateSchema pode deixar a pasta
-- pendurada numa casca de `Sessions` que perdeu o desempate e ainda não foi
-- destruída — Parent não-nil, mas invisível para quem lê a canônica. Mesmo
-- órfão, sintoma idêntico.
--
-- Presence/ e LeaseIntents/ NÃO são recriados aqui: ambos se refazem sozinhos
-- na próxima mensagem do editor (`TeamCreatePresence.updateOwnPresence`,
-- `TeamCreateLease.ensureIntent`), e recriá-los vazios aqui só publicaria um
-- estado falso de "sem script ativo / sem intent".
local function ensureOwnSessionAlive(motivo)
	if sessionFolder ~= nil and sessionFolder.Parent == sessionsFolder then
		return false
	end
	-- Logger.notify (toast), não Logger.log: perder a própria sessão nunca é
	-- rotina — é sempre ou um undo destrutivo ou um cleanup indevido do outro
	-- Studio, e nos dois casos o usuário viu (ou vai ver) um "colaborador
	-- saiu" errado. Mesmo critério da reconciliação de duplicatas em
	-- TeamCreateSchema.
	Logger.notify(("sessão local havia sumido de Sessions/ (%s) — recriada"):format(motivo))
	ensureOwnSession()
	return true
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
			-- 2026-07-20 (BUG 2, ruído de uso contínuo — docs/DECISIONS.md):
			-- rotineiro (dispara por sessão que entra, não só no boot) ->
			-- Logger.debug.
			Logger.debug(("joinSequence atribuído clientId=%s sequence=%d"):format(session.clientId, assigned))
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
			log(
				("removendo sessão obsoleta clientId=%s heartbeatAge=%.1fs"):format(
					session.clientId,
					session.heartbeatAge
				)
			)
			session.folder:Destroy()
			pulseObservations[session.clientId] = nil
		end
	end
end

-- Item 2(b) da tarefa 2026-07-21: diff tick-a-tick entre `knownOtherSessions`
-- (o que já vimos) e `sessions` (o que Sessions/ tem agora) — toast de
-- "colaborador entrou"/"colaborador saiu" por sessão de OUTRO Studio que
-- aparece/some. Chamado incondicionalmente a cada tick (não só pelo líder):
-- cada Studio conectado detecta joins/leaves de forma independente, sem
-- depender de quem é o líder no momento. Nunca notifica a própria sessão
-- (clientId == a própria). Baseline (rosterBaselined) evita rajada de
-- "entrou" na primeira leitura desta sessão do plugin, quando outras sessões
-- já estavam conectadas antes deste Studio entrar.
local function checkSessionRoster(sessions)
	local seenThisTick = {}
	for _, session in ipairs(sessions) do
		if session.clientId == clientId then
			continue -- nunca notifica a própria sessão
		end
		seenThisTick[session.clientId] = true
		if knownOtherSessions[session.clientId] == nil then
			local displayName = if session.username ~= "" then session.username else session.clientId
			knownOtherSessions[session.clientId] = displayName
			if rosterBaselined then
				Logger.notify(("colaborador entrou: %s"):format(displayName))
			end
		end
	end

	for otherClientId, displayName in knownOtherSessions do
		if not seenThisTick[otherClientId] then
			knownOtherSessions[otherClientId] = nil
			if rosterBaselined then
				Logger.notify(("colaborador saiu: %s"):format(displayName))
			end
		end
	end

	rosterBaselined = true
end

-- ------------------------------------------------------------------- tick

local function tick()
	if not enabled then
		return
	end

	-- CORREÇÃO (2026-07-07, docs/DECISIONS.md — split-brain de liderança
	-- confirmado em teste real com 2 Studios): `rootValues`/`sessionsFolder`
	-- eram capturados 1x em start() e nunca mais reavaliados — se uma
	-- duplicata (ver TeamCreateSchema.luau) só fosse reconciliada DEPOIS
	-- desse instante (replicação do Team Create ainda assentando), este
	-- Studio continuava lendo/escrevendo pra sempre numa cópia local que
	-- podia já ter sido esvaziada/destruída pela reconciliação de outro
	-- Studio. `TeamCreateSchema.ensureRoot()`/`ensureFolder()` já reconciliam
	-- duplicatas sozinhos a cada chamada (idempotente e barato — poucos
	-- filhos) — chamar de novo AQUI, a cada pulso, é o que garante que este
	-- Studio sempre aponta pra Instance CANÔNICA mais recente antes de ler ou
	-- escrever `LeaderTerm`/`LeaderClientId`/`NextJoinSequence`/Sessions.
	local root = TeamCreateSchema.ensureRoot()
	rootValues = root.values
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")

	-- Ver ensureOwnSessionAlive (2026-09-19): tem de vir DEPOIS do refresh
	-- acima (precisa da `sessionsFolder` canônica para comparar o Parent) e
	-- ANTES do Pulse (senão o incremento vai para a Instance órfã e some).
	ensureOwnSessionAlive("cleanup de outro Studio, ou reconciliação")

	local now = os.clock()
	sessionValues.Pulse.Value += 1

	local sessions = readSessions(now)
	checkSessionRoster(sessions)
	local candidate = TeamCreateElection.elect(sessions, TeamCreateElection.STALE_AFTER_SECONDS)
	candidateObservation =
		TeamCreateElection.observeCandidate(candidateObservation, candidate, TeamCreateElection.PROMOTION_OBSERVATIONS)
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

-- Resolve o nome real do Roblox via Players:GetNameFromUserIdAsync (yield) e
-- publica em sessionValues.Username.Value. Extraído de dentro de start()
-- (M4.5+, "Nome de exibição customizado" — ver Config.resolveCustomDisplayName)
-- para ser reusado também por TeamCreateElection.setLocalUsername quando o
-- dev LIMPA o campo de nome customizado com uma sessão já conectada
-- (precisa voltar a resolver o nome do Roblox, não só publicar string
-- vazia). Roda em task.spawn próprio (a chamada em si dá yield) — reconfere
-- token/enabled/sessionValues antes de escrever de volta, mesmo cuidado de
-- todo yield neste projeto (start()/stop() pode ter rodado de novo enquanto
-- isso resolvia).
local function resolveAndPublishRobloxUsername(myToken)
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
			publishedUsername = username
		end
	end)
end

-- userIdParam: resultado de StudioService:GetUserId() (já resolvido pelo
-- chamador, init.server.luau — este módulo não chama StudioService
-- diretamente para não duplicar o pcall que init.server.luau já faz para o
-- `hello`).
-- pluginObject (M4.5+, novo parâmetro): só usado para resolver
-- Config.resolveCustomDisplayName no boot desta sessão — nenhum outro uso
-- neste módulo (não guardado module-level; TeamCreateElection.setLocalUsername,
-- abaixo, recebe o nome já resolvido pelo chamador, não o pluginObject).
function TeamCreateElection.start(userIdParam, pluginObject)
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
	publishedUsername = ""
	pulseObservations = {}
	candidateObservation = nil
	announcedLeader = nil
	-- Item 2(b) da tarefa 2026-07-21: reconexão (troca de porta, F8/F5, reload
	-- do plugin) re-baseline o roster em vez de disparar "saiu" pra sessões
	-- antigas (que não existem mais neste processo) e "entrou" em rajada pras
	-- sessões que já estavam lá.
	knownOtherSessions = {}
	rosterBaselined = false

	ensureOwnSession()
	-- 2026-07-16: Logger.debug (ruído rotineiro de boot, ver Logger.luau) —
	-- continua encaminhado por WS, só não polui o Output a cada conexão.
	Logger.debug(("sessão criada clientId=%s userId=%d"):format(clientId, userId))

	-- Nome de exibição customizado (M4.5+, implementado de verdade em
	-- 2026-08-02 — antes um placeholder "em breve" no painel): resolvido 1x
	-- aqui no boot desta sessão de eleição. Quando presente (string
	-- não-vazia), PULA POR COMPLETO a resolução assíncrona do nome real do
	-- Roblox (Players:GetNameFromUserIdAsync) e publica o nome customizado
	-- direto, de forma síncrona — decisão deliberada (documentada também na
	-- tarefa original): menos uma yield/chamada de rede que o resultado nem
	-- seria usado, já que o dev escolheu explicitamente um nome fixo.
	-- pluginObject pode ser nil (chamador antigo/defensivo) —
	-- Config.resolveCustomDisplayName já degrada para "" nesse caso (pcall
	-- interno falha ao indexar nil, cai no default).
	local customDisplayName = Config.resolveCustomDisplayName(pluginObject)
	if customDisplayName ~= "" then
		sessionValues.Username.Value = customDisplayName
		publishedUsername = customDisplayName
	else
		-- Username via Players:GetNameFromUserIdAsync (yield), então roda em
		-- task.spawn separado — decisão 2 do cabeçalho.
		resolveAndPublishRobloxUsername(myToken)
	end

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
	publishedUsername = ""
	clientId = nil
	candidateObservation = nil
	announcedLeader = nil
	pulseObservations = {}
	-- Item 2(b) da tarefa 2026-07-21: mesma simetria/higiene do reset em
	-- start() acima — evita que um start() seguinte reveja este roster velho.
	knownOtherSessions = {}
	rosterBaselined = false
end

-- Atualiza o Username publicado da PRÓPRIA sessão em runtime, sem exigir
-- reconectar (M4.5+, "Nome de exibição customizado" — chamado pelo callback
-- do TextBox correspondente em plugin/src/ui/StatusPanel.luau, via
-- PluginUI.luau, assim que o dev confirma um novo valor com a sessão já
-- conectada). `customName` não-vazio: publica direto. `customName` vazio
-- (dev limpou o campo, "voltar a usar o nome do Roblox"): dispara de novo a
-- resolução assíncrona via Players:GetNameFromUserIdAsync (mesmo caminho de
-- start(), extraído em resolveAndPublishRobloxUsername acima) — nunca
-- publica uma string vazia como Username. No-op silencioso se a eleição não
-- estiver rodando ainda (sessionValues == nil, ex.: dev editou a setting
-- antes de conectar pela 1ª vez nesta sessão do plugin) — Config já
-- persistiu o valor por conta do chamador; o próximo start() aplica o nome
-- customizado do zero, lendo a setting de novo.
function TeamCreateElection.setLocalUsername(customName)
	if sessionValues == nil then
		return
	end
	if type(customName) == "string" and customName ~= "" then
		sessionValues.Username.Value = customName
		publishedUsername = customName
		return
	end
	resolveAndPublishRobloxUsername(currentToken)
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

-- ------------------------------------------------------- undo guard (2026-07-26)
--
-- Self-healing reativo (camada 2 da mitigação de undo, ver
-- TeamCreateUndoGuard.luau/docs/DECISIONS.md): chamado após
-- ChangeHistoryService.OnUndo/OnRedo dispararem (não sabemos QUAIS instances
-- foram afetadas, só que ALGUM undo/redo aconteceu — checagem de integridade
-- é a única opção). Sem isto, um Ctrl+Z que destrua a PRÓPRIA
-- Sessions/<clientId> deixaria tick() preso para sempre no guard
-- `sessionFolder.Parent == nil` do topo (early return silencioso) —
-- heartbeat/eleição param, e getSessionFolder() (usado por
-- TeamCreateLease/TeamCreatePresence) passa a devolver nil pra sempre,
-- quebrando leases/presença junto. Reaproveita ensureOwnSession() (já
-- idempotente, mesma função usada em start()) em vez de duplicar lógica de
-- criação. No-op se a eleição não estiver rodando (enabled == false).
function TeamCreateElection.checkIntegrity()
	if not enabled then
		return
	end
	-- Mesmo refresh que tick() já faz a cada pulso (docs/DECISIONS.md
	-- 2026-07-07, split-brain de liderança): reconsulta TeamCreateSchema para
	-- convergir na Instance canônica atual antes de checar/recriar a sessão.
	local root = TeamCreateSchema.ensureRoot()
	rootValues = root.values
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")

	-- Mesma recuperação que tick() faz a cada pulso desde 2026-09-19 (ver
	-- ensureOwnSessionAlive): aqui continua valendo a pena chamar na hora,
	-- sem esperar até PULSE_INTERVAL_SECONDS, porque o undo já aconteceu e
	-- ChangeHistoryService nos deu o gancho síncrono.
	ensureOwnSessionAlive("undo/redo")
end

-- ---------------------------------------------------------- leitura p/ UI (M4.5)
--
-- Getters read-only adicionados para o painel de status do plugin
-- (plugin/src/ui/), pedido explícito da tarefa ("se já existir algo assim,
-- use; se faltar, adicione um getter pequeno e read-only, não mude a lógica
-- interna"). Nenhuma das duas funções abaixo cria/muta Instance nenhuma nem
-- participa do ciclo de eleição — só leem o estado já mantido por tick().

-- ClientId do líder atual, ou nil se a eleição ainda não convergiu nenhuma
-- vez nesta sessão (rootValues ainda não lido) ou se LeaderClientId está
-- vazio (bootstrap, nenhum term concedido ainda).
function TeamCreateElection.getLeaderClientId()
	if rootValues == nil then
		return nil
	end
	local value = rootValues.LeaderClientId.Value
	return if value ~= "" then value else nil
end

-- Snapshot de todas as sessões atualmente em Sessions/ (própria incluída —
-- decisão desta fatia: a UI mostra "quem mais está na sessão" incluindo o
-- próprio Studio, já que ele também pode ser o líder ou estar editando algo).
-- Array de { clientId, username, userId, joinSequence }, em nenhuma ordem
-- garantida (quem chama decide como ordenar) — mesmo formato de campo de
-- readSessionEntry, só que sem heartbeatAge (a UI não filtra por liveness
-- nesta fatia: uma sessão que já saiu de Sessions/ simplesmente não aparece
-- mais no próximo refresh, não precisa de um terceiro estado "stale" na
-- tabela). nil-safe: devolve {} se a eleição não estiver rodando ainda.
function TeamCreateElection.listSessions()
	if sessionsFolder == nil then
		return {}
	end
	local sessions = {}
	for _, folder in ipairs(sessionsFolder:GetChildren()) do
		if not folder:IsA("Folder") then
			continue
		end
		local entry = readSessionEntry(folder)
		if entry ~= nil and entry.clientId ~= "" then
			table.insert(sessions, {
				clientId = entry.clientId,
				username = entry.username,
				userId = entry.userId,
				joinSequence = entry.joinSequence,
			})
		end
	end
	return sessions
end

return TeamCreateElection
