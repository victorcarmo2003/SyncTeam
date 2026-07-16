-- SyncTeam — Plugin de produção (M2 + M3.1 + M3.2 + M4 + M4.5)
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
-- antes de escrever (ver TeamCreateLease.luau). A partir do M4, também
-- inicia/para TeamCreatePresence (passthrough de cursor/seleção/arquivo ativo
-- vindo da extensão para Sessions/<clientId>/Presence) e despacha a mensagem
-- espontânea `presenceUpdate` para `TeamCreatePresence.updateOwnPresence`
-- (ver TeamCreatePresence.luau). A partir do M4.5, a antiga toolbar de 3
-- botões (Conectar/Parar/Alternar porta) foi substituída por 1 botão só que
-- alterna um DockWidgetPluginGui (painel de status construído com Vide, ver
-- plugin/src/ui/PluginUI.luau) — este arquivo continua sendo o ÚNICO dono da
-- lógica de conexão/sessão; PluginUI só invoca callbacks (onConnect/
-- onDisconnect/onPortChange) e reflete estado (setConnectionStatus/setPort),
-- nunca reimplementa nada de start()/stop()/troca de porta.
--
-- Fora de escopo aqui (ver docs/MILESTONES.md): UX de lease no VS Code
-- (M3.3, delegado a ui-dev); renderização de cursores/seleções na extensão
-- (M4, delegado a ui-dev — este arquivo só faz o passthrough de dados
-- opacos); schema versionado (SchemaVersion, nunca existiu no SyncTeam);
-- propriedades de instâncias não-script (decisão fixa do projeto, v1 só
-- scripts).
--
-- Porta do padrão de spikes/m0_5-local-pipeline/plugin/SyncTeamLab.lua
-- (checkSourceChanged polling+sinal) e spikes/m0-source-replication/
-- SyncTeamM0.lua (token de geração para start/stop seguro).
--
-- 2026-07-07: auto-descoberta de porta em runConnection (ver comentário na
-- própria função) — estopgap para o cenário de teste com 2 Studios na mesma
-- máquina/mesma pasta de Plugins, que hoje colidem na mesma porta sem isso.
-- O campo de porta do painel (M4.5, PluginUI.luau/onPortChange abaixo)
-- continua funcionando como fallback manual: uma porta setada
-- explicitamente é sempre a única tentada, nunca cicla pelas candidatas (ver
-- Config.resolveCandidatePorts).

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioService = game:GetService("StudioService")

local Config = require(script.Config)
local Logger = require(script.Logger)
local SourceWatcher = require(script.SourceWatcher)
local TeamCreateElection = require(script.TeamCreateElection)
local TeamCreateLease = require(script.TeamCreateLease)
local TeamCreatePresence = require(script.TeamCreatePresence)
local PluginUI = require(script.ui.PluginUI)

local enabled = false
local currentToken = 0
local client = nil -- WebStreamClient conectado no momento (nil se desconectado)

-- Guarda de modo Run/Play (F8 Run / F5 Play), 2026-07-16 — pesquisa em
-- .claude/research/2026-07-16-runservice-isstudio-isrunning-plugin-detect-test.md.
-- `RunService:IsStudio()` sozinho NÃO distingue edição normal do Team Create de
-- um teste rodando dentro do próprio Studio (fica `true` nos dois casos) — a
-- condição correta de "devo sincronizar" é `IsStudio() and not IsRunning()`.
-- Checagem só no boot não basta: o dev pode apertar F8/F5 DEPOIS do plugin já
-- estar conectado, então isso precisa de polling contínuo detectando a
-- TRANSIÇÃO edição->teste (chama stop()) e teste->edição (chama start() de
-- novo, só se este guard foi quem parou). Reaproveita
-- Config.POLL_INTERVAL_SECONDS (mesmo intervalo já usado para o polling de
-- Source) em vez de um timer novo dedicado — loop próprio, module-level,
-- independente de `enabled`/`currentToken` (precisa rodar mesmo desconectado,
-- para detectar o retorno à edição e poder chamar start() de novo).
--
-- Limitação conhecida, não resolvida (documentada na pesquisa e em
-- docs/DECISIONS.md 2026-07-16): quando o teste é PAUSADO, a doc oficial
-- afirma que `IsRunning()` (e `IsEdit()`) ficam ambos `false` — ou seja, este
-- guard pode falso-negativo e achar que voltou para edição normal enquanto o
-- teste só está pausado, retomando o sync indevidamente. Não há solução limpa
-- documentada para isso; tratado como limitação aceita, não um hack.
local wasInRunOrPlayMode = RunService:IsStudio() and RunService:IsRunning()
local runGuardStoppedSync = false -- true quando ESTE guard (não o usuário) chamou stop() por causa do Run/Play

-- Sinal EXPLÍCITO de rejeição de porta (2026-07-15): a extensão VS Code rejeita
-- um 2º cliente na mesma porta mandando uma mensagem de aplicação
-- {kind="connectionRejected", reason="port_in_use"} ANTES de fechar o WS. Como
-- WebStreamClient.Closed não expõe close code nem motivo
-- (.claude/research/2026-07-15-webstreamclient-close-code.md), essa mensagem é o
-- único jeito CONFIÁVEL de o plugin saber que o motivo real da queda é "porta
-- ocupada por outro Studio" — a heurística de tempo em runConnection só INFERE
-- isso. handleMessage seta `connectionRejected`; runConnection lê a flag para
-- tratar como rejeição confirmada sem esperar a janela de tempo. É module-level
-- porque handleMessage (dispatch genérico) não enxerga os locals de
-- runConnection — por isso runConnection reseta a flag a cada tentativa.
-- `activePort` = porta da tentativa em curso, usada só para o texto do toast em
-- handleMessage. `lastRejectedPortToasted` deduplica o toast: o Toast é
-- single-instance e re-show reinicia o timer (ver ui/Toast.luau), então sem
-- dedup reconectar numa porta explícita ocupada a cada RECONNECT_SECONDS
-- deixaria um toast permanente/indispensável — mesma disciplina anti-spam de
-- outageToasted/hasStabilizedOnce abaixo.
local connectionRejected = false
local activePort = nil
local lastRejectedPortToasted = nil

-- Guarda de reentrância da troca de porta pelo painel (2026-07-16, bug real
-- com log). FocusLost do campo de porta (ui/StatusPanel.luau, PortRow) pode
-- disparar MAIS DE UMA VEZ para o mesmo Enter/perda de foco (quirk conhecido de
-- TextBox no Roblox). O único guard contra repetição que existia é
-- `newPort ~= state.port()` DENTRO do PortRow, mas ele NÃO é seguro contra
-- reentrância: `state.port()` (portSource) só é atualizado de forma ASSÍNCRONA
-- por PluginUI.setPort, chamado lá dentro de runConnection (já no novo start()).
-- Existe portanto uma janela em que um 2º FocusLost lê o state.port() AINDA
-- ANTIGO contra o portBox.Text já NOVO, passa pelo guard e dispara um 2º
-- onPortChange. Esse 2º onPortChange roda stop()+start() de novo e o stop() mata
-- a sessão/conexão que o 1º start() acabou de criar (sintoma observado no log:
-- conecta em ws://127.0.0.1:1405 e ~40ms depois um stop() completo do MESMO
-- clientId recém-criado). Duas camadas de proteção, complementares:
--   (a) portChangeInFlight: enquanto o stop()+start() de uma troca ainda está
--       rodando (start() pode yieldar internamente), uma 2ª chamada é ignorada
--       — protege o caso de reentrância por yield.
--   (b) dedupe por VALOR+TEMPO: uma 2ª chamada com o MESMO newPort dentro de
--       PORT_CHANGE_DEDUPE_SECONDS é ignorada mesmo depois que a flag baixou —
--       cobre a janela entre start() retornar (flag=false) e o runConnection de
--       fato atualizar state.port(), que é EXATAMENTE quando o guard do PortRow
--       falha.
local PORT_CHANGE_DEDUPE_SECONDS = 1
local portChangeInFlight = false
local lastPortChangeValue = nil
local lastPortChangeAt = 0

local log = Logger.log
local notify = Logger.notify

-- sendMessage é a própria função que o Logger usa para encaminhar logs pela
-- conexão WS (injetada em Logger.init(sendMessage) dentro de start()) — os
-- dois logs internos abaixo usam `print` PURO, nunca `log`/`Logger.log`.
-- Motivo (evitar recursão, ver Logger.luau): se usassem `log`, uma falha de
-- envio disparia Logger.log -> sendMessage -> (falha de novo) -> log da
-- falha via Logger.log -> sendMessage de novo, sem saída natural do ciclo.
-- Formato do print mantido idêntico ao de antes desta tarefa.
local function sendMessage(message)
	if client == nil then
		-- kind == "log" é o próprio Logger.log tentando se auto-encaminhar
		-- pela conexão WS (ver Logger.luau) — o conteúdo já apareceu no
		-- Output via print() dentro de Logger.log; avisar "descartado" aqui
		-- é só ruído duplicado, não uma falha real. Mensagens de protocolo de
		-- verdade (scriptAdded, presenceUpdate, etc.) continuam avisando,
		-- porque isso é informação útil para depurar por que algo não
		-- chegou na extensão.
		if message.kind ~= "log" then
			print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), "descartado (sem conexão):", tostring(message.kind))
		end
		return
	end
	local ok, err = pcall(function()
		client:Send(HttpService:JSONEncode(message))
	end)
	if not ok then
		print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), "falha ao enviar:", tostring(err))
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

		-- Pastas vendorizadas (Packages/ServerPackages/DevPackages, ver
		-- Config.luau/docs/DECISIONS.md 2026-07-16): edição normal (modo
		-- ATUALIZAÇÃO, script já existente) é bloqueada/ignorada — nunca
		-- arbitra lease nem escreve Source para esses scripts, para não
		-- empurrar ao Team Create compartilhado uma versão vendorizada
		-- divergente entre devs. Modo CRIAÇÃO (path abaixo, sem uuid) não é
		-- afetado por esta checagem — é assim que um pacote novo chega ao
		-- Studio pela 1ª vez.
		if Config.isInsideExcludedPackageFolder(instance) then
			local blockedMessage = "edição bloqueada: script dentro de pasta de pacote vendorizado (Packages/ServerPackages/DevPackages) — não sincronizado ao vivo"
			sendMessage({
				kind = "writeAck",
				requestId = message.requestId,
				ok = false,
				uuid = message.uuid,
				error = blockedMessage,
			})
			log(("writeSource (update) uuid=%s -> BLOQUEADO (pasta vendorizada): %s"):format(
				tostring(message.uuid),
				instance:GetFullName()
			))
			return
		end

		TeamCreateLease.ensureIntent(message.uuid, instance)
		local canWrite, ownerClientId = TeamCreateLease.canWrite(message.uuid)
		if not canWrite then
			local ownerDisplay = TeamCreateLease.describeClient(ownerClientId)
			local leaseDeniedMessage = ("lease negada — script sendo editado por %s"):format(ownerDisplay)
			sendMessage({
				kind = "writeAck",
				requestId = message.requestId,
				ok = false,
				uuid = message.uuid,
				error = leaseDeniedMessage,
			})
			-- M4.5: toast-worthy (Logger.notify, não Logger.log) — recusa de
			-- escrita é um evento que o usuário precisa perceber sem precisar
			-- olhar o Output (spec da tarefa: writeAck ok=false/lease negada é
			-- um dos gatilhos sugeridos). Log incondicional continua
			-- acontecendo (Logger.notify sempre loga, ver Logger.luau) — só a
			-- exibição do toast depende da preferência "Mostrar notificações".
			notify(("%s (uuid=%s)"):format(leaseDeniedMessage, tostring(message.uuid)))
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
	elseif message.kind == "presenceUpdate" then
		-- M4: espontânea, sem requestId, sem ack (spec docs/MILESTONES.md) —
		-- só grava a própria Presence; TeamCreatePresence.updateOwnPresence já
		-- degrada sem erro se a sessão local ainda não estiver pronta.
		TeamCreatePresence.updateOwnPresence(message)
	elseif message.kind == "ping" then
		-- Heartbeat da extensão (vscode-extension HeartbeatMonitor.ts): a
		-- extensão manda {kind:"ping"} a cada 5s enquanto conectada e responde-se
		-- pong imediatamente. Mensagem ADITIVA — não bumpa PROTOCOL_VERSION. Sem
		-- requestId, sem estado: é só liveness. O plugin NÃO origina ping próprio;
		-- só RECEBER este ping já conta como atividade (o handler de
		-- MessageReceived em runConnection atualiza lastMessageAt para QUALQUER
		-- mensagem, inclusive esta — a ausência dele é o que detecta a queda).
		sendMessage({ kind = "pong" })
	elseif message.kind == "connectionRejected" then
		-- A extensão rejeitou explicitamente esta conexão (2º cliente na mesma
		-- porta) e fechará o WS logo em seguida. Sinal DEFINITIVO de "porta
		-- ocupada por outro Studio" — runConnection lê a flag e trata como
		-- rejeição confirmada na hora (sem depender da heurística de tempo
		-- Config.PROBABLE_REJECTION_WINDOW_SECONDS, que passa a ser só o fallback
		-- para quando este sinal NÃO chega, ex.: extensão antiga sem este fix).
		-- Toast (Logger.notify, não Logger.log) só na 1ª vez por porta ocupada;
		-- rejeições repetidas na mesma porta só logam (ver dedupe no topo do
		-- arquivo). `reason` hoje é sempre "port_in_use" (único definido) — a
		-- flag/aviso assumem esse motivo.
		connectionRejected = true
		if lastRejectedPortToasted ~= activePort then
			lastRejectedPortToasted = activePort
			notify(("porta %d já está em uso por outro Studio"):format(activePort or 0))
		else
			log(("porta %d já está em uso por outro Studio (rejeição repetida; toast já exibido)"):format(activePort or 0))
		end
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
--
-- Auto-descoberta de porta (2026-07-07, pedido do orquestrador): `ports` é
-- ou uma lista de 1 item (porta já explicitamente setada — manual via botão
-- "Alternar porta" ou persistida por uma descoberta automática anterior) ou
-- `Config.CANDIDATE_PORTS` inteiro (sem nenhuma setting ainda). O harness
-- (SyncServer.ts) rejeita uma 2ª conexão simultânea com
-- `socket.close(1013, "SyncTeam: já existe um plugin conectado")` — mas NÃO
-- há confirmação salva em .claude/research/ sobre o que
-- CreateWebStreamClient expõe desse close code/motivo através dos
-- parâmetros do evento Error, então o critério de "rejeição provável" abaixo
-- deliberadamente NÃO tenta interpretar `code`/`errorMessage` (só loga eles,
-- como antes) — usa só observação local: a conexão caiu SEM NUNCA ter
-- recebido nenhuma mensagem do harness E dentro de uma janela curta
-- (Config.PROBABLE_REJECTION_WINDOW_SECONDS) desde que foi aberta. Uma queda
-- que ficou de pé mais que essa janela, ou que já recebeu qualquer mensagem,
-- é tratada como queda normal (reconecta na MESMA porta, como antes desta
-- mudança).
local function runConnection(myToken, ports, explicitAtStart, pluginObject)
	local index = 1
	local attemptsInLap = 0
	-- Já explícita = nunca persistir (item 4 da tarefa: nunca sobrescrever
	-- uma porta que o usuário já escolheu, seja manual seja de uma sessão
	-- anterior). Só descobertas automáticas desta sessão chegam a persistir.
	local persistedAutoPort = explicitAtStart

	-- Estado visual do botão CONNECT/DISCONNECT (item 1 da tarefa): a cada
	-- volta deste loop o estado vai para "connecting" (laranja) e só passa a
	-- "connected" (vermelho) quando a conexão estabiliza (abaixo). O estado
	-- "disconnected" (azul) é setado SÓ por stop(), nunca aqui — assim um loop
	-- de ConnectFail fica laranja estável em vez de piscar azul/vermelho, que
	-- era o que o usuário via como confuso.
	--
	-- M4.5 (toast de "reconexão falhando"): `hasStabilizedOnce` vira true na
	-- primeira vez que esta runConnection (mesmo myToken, ou seja, mesmo
	-- ciclo start()/stop()) recebe de verdade qualquer mensagem do harness —
	-- só a partir daí uma queda é tratada como "algo que estava funcionando
	-- parou", digno de toast. Sem isso, o cenário normal "extensão VS Code
	-- ainda não foi aberta" (loop de reconexão tentando a cada
	-- RECONNECT_SECONDS sem nunca ter recebido nada) dispararia toast
	-- repetido desde o primeiro segundo — exatamente o "evento rotineiro"
	-- que a spec pede pra NÃO notificar. Isto é MAIS forte que o critério
	-- visual acima (que também aceita "ficou de pé além da janela") de
	-- propósito: um ConnectFail nunca recebe mensagem NEM fica de pé, então
	-- não vira nem laranja-confirmado nem toast — é o cenário "nunca conectou
	-- de verdade", corretamente silencioso. `outageToasted` garante só 1 toast
	-- por "episódio" de queda (reseta pra false assim que uma nova conexão
	-- estabiliza de novo, permitindo um novo toast se cair de novo depois).
	local hasStabilizedOnce = false
	local outageToasted = false

	while enabled and currentToken == myToken do
		local port = ports[index]
		activePort = port
		-- Reset por tentativa: `connectionRejected` é module-level (setado por
		-- handleMessage), então precisa nascer false a cada nova conexão para
		-- não vazar uma rejeição de uma tentativa anterior para a lógica de
		-- decisão abaixo.
		connectionRejected = false
		PluginUI.setPort(port)
		-- Cada volta do loop = uma tentativa de conexão → estado "connecting"
		-- (botão laranja). Dedupe no setter evita reexecutar effects quando já
		-- está "connecting" (o caso comum no loop de reconexão). Só vira
		-- "connected" (vermelho) quando a conexão estabiliza de fato, abaixo.
		PluginUI.setConnectionStatus("connecting")
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
		local receivedAnyMessage = false
		local connectedAt = os.clock()
		-- Timestamp local da ÚLTIMA mensagem recebida de QUALQUER tipo (estende o
		-- rastreamento que `receivedAnyMessage` já fazia como booleano — agora
		-- também guardamos QUANDO, para detectar silêncio prolongado). Inicia em
		-- connectedAt: se nada chegar desde a abertura, o silêncio conta a partir
		-- daqui. Atualizado no handler de MessageReceived abaixo, para ping
		-- (heartbeat da extensão a cada 5s) e para toda outra mensagem por igual.
		local lastMessageAt = connectedAt
		local connections = {}
		table.insert(connections, newClient.MessageReceived:Connect(function(raw)
			receivedAnyMessage = true
			lastMessageAt = os.clock()
			handleMessage(raw)
		end))
		table.insert(connections, newClient.Closed:Connect(function()
			closed = true
		end))
		table.insert(connections, newClient.Error:Connect(function(code, errorMessage)
			-- 2026-07-16: Logger.debug (ver Logger.luau) — um ConnectFail isolado
			-- é ruído rotineiro do loop de reconexão (a linha visível de verdade
			-- é "desconectado; reconectando em Xs" logo abaixo, categoria
			-- "reconectando"); continua encaminhado por WS para diagnóstico.
			Logger.debug(("erro WS %s %s"):format(tostring(code), tostring(errorMessage)))
			closed = true
		end))

		client = newClient
		sendHello()
		-- NÃO vira "connected" (vermelho) aqui: criar o WebStreamClient e
		-- mandar o hello é otimista (a conexão pode falhar logo em seguida com
		-- ConnectFail). O botão só passa a vermelho quando a conexão
		-- ESTABILIZA de fato (abaixo) — até lá fica laranja ("connecting").
		-- 2026-07-16: rebaixado para Logger.debug — esta tentativa ainda não é
		-- a categoria visível "conectado" (spec da tarefa: só 3 categorias de
		-- status, uma linha por MUDANÇA real); a linha Logger.log de verdade
		-- fica no ponto de estabilização abaixo (`shownConnected`).
		Logger.debug(("conectado em %s"):format(url))

		-- Vira "connected" (vermelho) só na 1ª vez que esta tentativa
		-- estabiliza — não repete o setter a cada 0.5s.
		local shownConnected = false

		while enabled and currentToken == myToken and not closed do
			task.wait(0.5)

			-- Garantia independente de Closed/Error: se ficamos silenciosos por
			-- mais de DEAD_CONNECTION_TIMEOUT_SECONDS (nenhuma mensagem de nenhum
			-- tipo — nem o ping periódico da extensão a cada 5s, nem qualquer
			-- outra), a extensão provavelmente caiu sem fechar o WS (ex.: "Reload
			-- Window" do VS Code) — cenário em que Closed/Error do WebStreamClient
			-- podem NÃO disparar (o bug que esta detecção existe para cobrir).
			-- Só setamos `closed = true`: EXATAMENTE o que os handlers de
			-- Closed/Error já fazem (o restante da iteração corrente termina
			-- inócuo e a condição do `while` encerra o loop na próxima checagem —
			-- mesmíssimo timing de quando um Closed dispara durante o task.wait),
			-- então caímos no MESMO teardown + ciclo de reconexão logo abaixo (que
			-- por sua vez repõe o painel em "connecting" sozinho — não duplicamos
			-- setConnectionStatus aqui).
			if os.clock() - lastMessageAt >= Config.DEAD_CONNECTION_TIMEOUT_SECONDS then
				log(("sem mensagens da extensão há %ds (provável queda sem close do WS); forçando reconexão"):format(
					Config.DEAD_CONNECTION_TIMEOUT_SECONDS
				))
				closed = true
			end

			-- "Estabilizou" (item 4): recebeu qualquer mensagem do harness
			-- depois do hello (a extensão dispara um listScripts inicial em
			-- runInitialSync assim que valida o hello — ver vscode-extension/
			-- src/sync/SyncTeamService.ts), OU já ficou conectada além da
			-- janela curta de rejeição provável sem cair.
			-- `not connectionRejected` suprime "estabilizou": uma conexão
			-- rejeitada RECEBE sim uma mensagem (o próprio connectionRejected),
			-- então sem esta guarda ela contaria como estável e o plugin (a)
			-- piscaria o botão em "connected" e (b) PERSISTIRIA a porta ocupada
			-- como porta descoberta (SetSetting abaixo) — os dois errados. Ver
			-- handleMessage/connectionRejected.
			local stabilized = not connectionRejected
				and (receivedAnyMessage
					or (os.clock() - connectedAt) >= Config.PROBABLE_REJECTION_WINDOW_SECONDS)

			-- Estado visual (item 1 da tarefa): só vira "connected" (vermelho)
			-- ao estabilizar. Um ConnectFail nunca estabiliza (cai em
			-- <PROBABLE_REJECTION_WINDOW_SECONDS sem receber nada), então o
			-- botão fica laranja o loop inteiro em vez de piscar azul/vermelho.
			-- Nota: usa o critério FRACO (recebeu msg OU ficou de pé além da
			-- janela), igual à persistência de porta — mais permissivo que o
			-- critério de toast (hasStabilizedOnce, só recebeu msg). Ver
			-- .claude/agent-memory/ui-dev.md para o porquê da diferença.
			if stabilized and not shownConnected then
				shownConnected = true
				-- Conexão real estabeleceu: zera o dedupe de toast de rejeição,
				-- para que uma futura ocupação DESTA mesma porta (outro Studio a
				-- toma depois) volte a notificar.
				lastRejectedPortToasted = nil
				PluginUI.setConnectionStatus("connected")
				-- 2026-07-16 (consolidação de log de boot, item 3 da tarefa): ÚNICA
				-- linha visível (Logger.log) da categoria "conectado" — substitui a
				-- antiga rajada de ~7 linhas de subsistema (agora Logger.debug, ver
				-- acima e nos módulos SourceWatcher/TeamCreateElection/
				-- TeamCreateLease/TeamCreatePresence). Contagem de scripts vem de
				-- SourceWatcher.getWatchedCount() (novo, mesmo dado que a antiga
				-- linha "observação iniciada" já expunha, só lido sob demanda aqui
				-- em vez de guardado). Não inclui líder/term aqui de propósito: a
				-- eleição é assíncrona e pode não ter convergido ainda no instante
				-- em que a conexão WS estabiliza — "sou o líder agora (term N)"
				-- continua sendo logado separadamente por TeamCreateElection quando
				-- de fato acontecer.
				log(("conectado em %s (%d scripts observados)"):format(url, SourceWatcher.getWatchedCount()))
			end

			-- Persistir assim que estabilizar (não espera a conexão cair) para
			-- reloads futuros já reconectarem direto nesta porta.
			if not persistedAutoPort and stabilized then
				local okSet, errSet = pcall(function()
					pluginObject:SetSetting(Config.PORT_SETTING_KEY, port)
				end)
				if okSet then
					log(("porta %d confirmada e salva"):format(port))
				else
					log(("falha ao salvar porta descoberta automaticamente (%d): %s"):format(port, tostring(errSet)))
				end
				persistedAutoPort = true
			end
			-- M4.5: ver comentário no topo de runConnection — só o recebimento
			-- REAL de uma mensagem do harness conta como "estabilizou" para
			-- fins de toast (mais forte que o critério visual/porta acima, que
			-- também aceita só "ficou de pé um tempo").
			-- `and not connectionRejected`: um connectionRejected É uma mensagem
			-- recebida, mas NÃO é "a conexão funcionou" — não deve armar o toast
			-- genérico de "conexão perdida" (já existe o toast específico de
			-- porta ocupada em handleMessage).
			if not hasStabilizedOnce and receivedAnyMessage and not connectionRejected then
				hasStabilizedOnce = true
				outageToasted = false
			end
		end

		local aliveSeconds = os.clock() - connectedAt
		client = nil
		for _, connection in connections do
			connection:Disconnect()
		end
		pcall(function()
			newClient:Close()
		end)

		if not (enabled and currentToken == myToken) then
			-- stop() já colocou o estado em "disconnected" (botão azul) — não
			-- sobrescreve com "connecting" aqui.
			return
		end

		-- Ainda habilitado: vamos tentar de novo → volta a "connecting"
		-- (laranja). Cobre a espera até a próxima tentativa (RECONNECT_SECONDS
		-- ou CANDIDATE_RETRY_DELAY_SECONDS) sem deixar o botão preso em
		-- "connected" (vermelho) depois de uma queda.
		PluginUI.setConnectionStatus("connecting")

		-- Rejeição CONFIRMADA pelo sinal explícito (connectionRejected) OU
		-- inferida pela heurística de tempo (fallback quando o sinal não chega:
		-- extensão antiga — "caiu cedo sem nunca receber mensagem"). O sinal
		-- explícito dispensa tanto a janela de tempo quanto o "não recebeu
		-- mensagem" (o próprio connectionRejected É uma mensagem). Só cicla
		-- candidatas se houver >1 porta; porta explícita (#ports==1) sempre
		-- reconecta na mesma — o toast de handleMessage já avisou o motivo e o
		-- usuário decide trocar de porta no painel (item 2 da tarefa).
		local rejected = connectionRejected
			or ((not receivedAnyMessage) and aliveSeconds < Config.PROBABLE_REJECTION_WINDOW_SECONDS)
		local probablyRejected = rejected and #ports > 1

		-- M4.5: toast só quando uma conexão que JÁ FUNCIONOU cai de um jeito
		-- que não é a rotina de "ciclar candidatas de porta" — evita o ruído
		-- de notificar o cenário normal "extensão ainda não foi aberta" (ver
		-- comentário no topo da função).
		if not probablyRejected and hasStabilizedOnce and not outageToasted then
			outageToasted = true
			notify("conexão com a extensão VS Code perdida; tentando reconectar...")
		end

		if probablyRejected then
			attemptsInLap += 1
			local nextIndex = (index % #ports) + 1
			if attemptsInLap >= #ports then
				-- Esgotou todas as candidatas nesta volta sem sucesso: volta
				-- pro início da lista, mas com o RECONNECT_SECONDS normal (evita
				-- busy-loop se nenhum harness estiver de pé em porta nenhuma).
				log(("porta %d parece ocupada; todas as %d candidatas falharam, aguardando %ds antes de recomeçar"):format(
					port,
					#ports,
					Config.RECONNECT_SECONDS
				))
				attemptsInLap = 0
				index = nextIndex
				task.wait(Config.RECONNECT_SECONDS)
			else
				log(("porta %d parece ocupada, tentando %d..."):format(port, ports[nextIndex]))
				index = nextIndex
				task.wait(Config.CANDIDATE_RETRY_DELAY_SECONDS)
			end
		else
			attemptsInLap = 0
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
	-- TeamCreateLease.stop()/TeamCreatePresence.stop() antes de
	-- TeamCreateElection.stop(): ambos só limpam estado em memória (a própria
	-- Presence e as pastas de intent morrem em cascata quando
	-- TeamCreateElection.stop() destrói a própria sessão a seguir) — ordem
	-- não é estritamente necessária, mas segue a mesma disciplina "parar o
	-- que depende antes do que é dependido" já usada neste arquivo.
	TeamCreateLease.stop()
	TeamCreatePresence.stop()
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
	-- Zera o dedupe de toast de rejeição de porta: um novo start() deve poder
	-- notificar de novo se reencontrar uma porta ocupada.
	lastRejectedPortToasted = nil
	-- Estado visual: "disconnected" (botão azul, ação = conectar) — o loop de
	-- runConnection já não vai sobrescrever porque enabled == false (ele volta
	-- cedo ao notar isso). runConnection NUNCA seta "disconnected" sozinho:
	-- esse estado parado é responsabilidade exclusiva do stop().
	PluginUI.setConnectionStatus("disconnected")
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
	-- Estado visual imediato: o clique em CONNECT (ou o auto-start) já coloca o
	-- botão em "connecting" (laranja) antes mesmo da 1ª tentativa de WS em
	-- runConnection, sem esperar o loop começar.
	PluginUI.setConnectionStatus("connecting")
	local ports, explicitPort = Config.resolveCandidatePorts(pluginObject)
	local okUserId, resolvedUserId = pcall(function()
		return StudioService:GetUserId()
	end)
	-- Logger.init ANTES de SourceWatcher.start()/TeamCreateElection.start()/
	-- TeamCreateLease.start(): esses três já podem logar (via `log`/Logger.log)
	-- durante a própria inicialização (ex.: "observação iniciada", "sessão
	-- criada"), então o encaminhamento por WS precisa estar disponível o quanto
	-- antes — mesmo cuidado de ordem já seguido para SourceWatcher.init/
	-- TeamCreateLease.init abaixo.
	Logger.init(sendMessage)
	-- M4.5: injeta o callback de toast do painel — Logger.notify(...) (usado
	-- pelos poucos pontos "toast-worthy" deste arquivo e de
	-- TeamCreateSchema.luau) passa a acionar PluginUI.notify a partir de
	-- agora. Antes deste ponto (e se PluginUI.init tiver falhado, ver
	-- PluginUI.luau), Logger.notify se comporta como Logger.log.
	Logger.initNotify(PluginUI.notify)
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
	-- TeamCreatePresence depois de TeamCreateElection, mesmo motivo de
	-- TeamCreateLease acima: updateOwnPresence/checkPresenceDrift dependem de
	-- TeamCreateElection.getSessionFolder()/getClientId() já existirem.
	TeamCreatePresence.init(sendMessage)
	TeamCreatePresence.start()
	task.spawn(runConnection, myToken, ports, explicitPort, pluginObject)
	-- 2026-07-16: Logger.debug (ruído rotineiro de boot, ver Logger.luau) —
	-- continua encaminhado por WS, só não polui o Output a cada conexão. O
	-- status visível de verdade ("conectado"/"reconectando"/"falha") é o
	-- consolidado dentro de runConnection (ver comentários lá).
	if explicitPort then
		Logger.debug(("iniciado. Conectando à porta %d..."):format(ports[1]))
	else
		Logger.debug(("iniciado. Sem porta salva ainda; testando candidatas (%s)..."):format(table.concat(ports, ", ")))
	end
end

-- --------------------------------------------------- guarda de Run/Play (F8/F5)
--
-- Checa a transição de RunService:IsRunning() a cada Config.POLL_INTERVAL_SECONDS
-- (ver comentário de wasInRunOrPlayMode acima). Loop próprio, roda pela vida
-- inteira do plugin (desconectado por plugin.Unloading abaixo, junto dos
-- outros).
local runModeMonitorEnabled = true

local function checkRunModeTransition()
	local isInRunOrPlayMode = RunService:IsStudio() and RunService:IsRunning()

	if isInRunOrPlayMode and not wasInRunOrPlayMode then
		-- Transição edição -> Run/Play: suspende o sync se estava rodando.
		wasInRunOrPlayMode = true
		if enabled then
			runGuardStoppedSync = true
			log("F8/F5 (Run/Play) detectado; sync suspenso durante o teste.")
			stop()
		end
	elseif not isInRunOrPlayMode and wasInRunOrPlayMode then
		-- Transição Run/Play -> edição (ressalva: também dispara em falso se o
		-- teste só foi PAUSADO, ver comentário de wasInRunOrPlayMode acima —
		-- limitação conhecida, não resolvida).
		wasInRunOrPlayMode = false
		if runGuardStoppedSync then
			runGuardStoppedSync = false
			log("retorno ao modo de edição detectado; retomando sync.")
			task.spawn(start, plugin)
		end
	end
end

task.spawn(function()
	while runModeMonitorEnabled do
		task.wait(Config.POLL_INTERVAL_SECONDS)
		if not runModeMonitorEnabled then
			break
		end
		checkRunModeTransition()
	end
end)

-- ------------------------------------------------------------------- UI (M4.5)
--
-- Substitui a antiga toolbar de 3 botões (Conectar/Parar/Alternar porta) por
-- 1 botão só que alterna o painel (PluginUI.luau cria toolbar+
-- DockWidgetPluginGui+monta a árvore Vide) — este arquivo continua sendo o
-- ÚNICO dono de start()/stop()/troca de porta; PluginUI só invoca os
-- callbacks abaixo e reflete estado via setConnectionStatus/setPort (chamados
-- dentro de runConnection/start/stop, ver acima).
--
-- onPortChange reusa EXATAMENTE a mesma sequência que o antigo botão
-- "Alternar porta" fazia (SetSetting + stop() + start(plugin)) — só
-- generalizada para um valor arbitrário digitado no painel em vez de
-- alternar entre 2 constantes fixas (34980/34981, que eram só uma
-- ferramenta de teste para 2 Studios na mesma máquina — o campo de porta do
-- painel substitui essa necessidade sem precisar de nenhum botão dedicado).
PluginUI.init(plugin, {
	onConnect = function()
		task.spawn(start, plugin)
	end,
	onDisconnect = stop,
	onPortChange = function(newPort)
		-- Guarda de reentrância/dedupe (ver comentário no topo do arquivo):
		-- ignora uma 2ª chamada de FocusLost residual que dispararia um
		-- stop()+start() concorrente, matando a conexão recém-criada.
		if portChangeInFlight then
			log(("troca de porta para %d ignorada: outra troca ainda em andamento"):format(newPort))
			return
		end
		if lastPortChangeValue == newPort and (os.clock() - lastPortChangeAt) < PORT_CHANGE_DEDUPE_SECONDS then
			log(("troca de porta para %d ignorada: repetição do mesmo valor em <%ds"):format(
				newPort,
				PORT_CHANGE_DEDUPE_SECONDS
			))
			return
		end
		portChangeInFlight = true
		lastPortChangeValue = newPort
		lastPortChangeAt = os.clock()
		task.spawn(function()
			local currentPort = Config.resolvePort(plugin)
			local okSet, errSet = pcall(function()
				plugin:SetSetting(Config.PORT_SETTING_KEY, newPort)
			end)
			if not okSet then
				log("falha ao mudar porta pelo painel:", tostring(errSet))
				-- Libera a guarda ANTES de sair: sem isso, uma falha de SetSetting
				-- deixaria portChangeInFlight travado em true para sempre,
				-- bloqueando toda troca de porta futura (bug pior que o que estamos
				-- corrigindo).
				portChangeInFlight = false
				return
			end
			log(("porta alterada pelo painel %d -> %d; reconectando..."):format(currentPort, newPort))
			-- stop()+start() em pcall só para GARANTIR que a guarda sempre baixa
			-- (um erro aqui deixaria portChangeInFlight travado, ver acima) — o
			-- erro, se houver, continua sendo logado, não engolido silenciosamente.
			local okCycle, errCycle = pcall(function()
				stop()
				start(plugin)
			end)
			-- Reinicia a janela de dedupe a partir do FIM do stop()+start() (que
			-- pode ter yieldado): é a partir daqui que o PortRow fica vulnerável de
			-- novo, até runConnection atualizar state.port(). Só então libera a
			-- flag de reentrância.
			lastPortChangeAt = os.clock()
			portChangeInFlight = false
			if not okCycle then
				log("erro ao reconectar após troca de porta:", tostring(errCycle))
			end
		end)
	end,
})
PluginUI.setPort(Config.resolvePort(plugin))

plugin.Unloading:Connect(stop)
-- PluginUI.stop() é um ciclo de vida SEPARADO do stop() de conexão acima
-- (ver PluginUI.luau): só desliga o refresh em segundo plano da tabela de
-- sessões; o painel em si (toolbar+widget) não precisa ser destruído, o
-- Studio cuida disso ao descarregar o plugin.
plugin.Unloading:Connect(PluginUI.stop)
-- Encerra o loop do guard de Run/Play (acima) junto com o resto do ciclo de
-- vida do plugin.
plugin.Unloading:Connect(function()
	runModeMonitorEnabled = false
end)

log("plugin carregado. Toolbar 'SyncTeam' alterna o painel de status; use o botão CONNECT para conectar.")

-- ------------------------------------------------------------ auto-start
--
-- 2026-07-16 (pedido do usuário): autostart passou a ser OPT-IN, default
-- DESLIGADO (Config.AUTOSTART_SETTING_KEY/resolveAutoStartEnabled, default
-- false — oposto do padrão de NOTIFICATIONS_SETTING_KEY). Antes desta
-- mudança, `start(plugin)` era chamado incondicionalmente aqui (só sujeito ao
-- guard de Run/Play abaixo) — o dev não tinha como optar por conectar
-- manualmente. Agora o dev decide quando conectar clicando em CONNECT no
-- painel (onConnect acima já chama `task.spawn(start, plugin)`, mesmo
-- caminho); só quem ligar Config.AUTOSTART_SETTING_KEY explicitamente (ainda
-- sem UI dedicada nesta fatia, mesmo padrão de PORT_SETTING_KEY quando foi
-- introduzida — usuário avançado via plugin:SetSetting(...) no Command Bar)
-- volta a ter o comportamento antigo.
--
-- Mesmo padrão de carregamento validado no M0.5
-- (.claude/agent-memory/luau-dev.md): o Studio auto-executa o Script raiz do
-- plugin ao (re)carregar — seja como arquivo .lua solto na pasta de Plugins,
-- seja como .rbxm buildado via `rojo build`. start() tem guard de
-- idempotência (`if enabled then return end`) para tolerar reload/
-- reinstalação duplicada, o que segue relevante mesmo com autostart opt-in
-- (ex.: reload com a setting ligada).
--
-- Guarda de Run/Play (ver comentário de wasInRunOrPlayMode acima): só se
-- aplica quando autostart está de fato ligado — se autostart estiver
-- desligado (o novo default), não há nada para o guard fazer aqui; o dev usa
-- o painel manualmente independente do modo Run/Play (o botão CONNECT em si
-- não tem guard de Run/Play — fora de escopo desta tarefa).
if not Config.resolveAutoStartEnabled(plugin) then
	log("autostart desligado; use o painel (toggle na toolbar) pra conectar manualmente.")
elseif RunService:IsStudio() and RunService:IsRunning() then
	log("Studio em modo Run/Play (RunService:IsRunning()==true) no carregamento; sync não iniciado automaticamente.")
else
	task.spawn(start, plugin)
end
