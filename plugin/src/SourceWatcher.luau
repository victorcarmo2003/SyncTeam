-- SyncTeam — Observação e escrita de Source (plugin de produção, M2)
--
-- Porta de spikes/m0_5-local-pipeline/plugin/SyncTeamLab.lua e
-- spikes/m0-source-replication/SyncTeamM0.lua para observação GENÉRICA dos
-- containers reais listados em Config.getWatchedRoots(), em vez de uma
-- única pasta sandbox.
--
-- Identidade de script (M2, docs/MILESTONES.md): UUID + ObjectValue via
-- ScriptRegistry (TestService.SyncTeam.Scripts/<uuid>), nunca mais só o
-- caminho no DataModel. `pathFor`/`resolvePath` continuam existindo — path é
-- usado para exibição (CanonicalPath, campo `path` nas mensagens) e para
-- resolver/criar Instances a partir do project.json do lado da extensão —
-- mas NUNCA mais como chave de endereçamento de leitura/escrita.
--
-- Detecção de mudança de Source: NUNCA só o sinal.
-- GetPropertyChangedSignal("Source") não dispara de forma confiável depois
-- de ScriptEditorService:UpdateSourceAsync (confirmado em teste real, M0.5,
-- 2026-07-03 — docs/DECISIONS.md, .claude/rules/luau.md). O sinal fica
-- conectado só como fast-path; o polling periódico (Config.POLL_INTERVAL_SECONDS)
-- é o caminho garantido. As duas vias chamam checkSourceChanged, que faz
-- dedupe por instância via lastSourceByInstance. O mesmo ciclo de polling
-- também detecta rename/move e delete via ScriptRegistry (checkRegistryDrift)
-- — ver comentário lá embaixo sobre por que delete não usa DescendantRemoving.

local ScriptEditorService = game:GetService("ScriptEditorService")

local Config = require(script.Parent.Config)
local Logger = require(script.Parent.Logger)
local ScriptRegistry = require(script.Parent.ScriptRegistry)

local SourceWatcher = {}

local sendMessage = nil -- callback(message: table), injetado por SourceWatcher.init
local enabled = false
local currentToken = 0 -- token de geração: invalida polling/observadores de uma geração anterior
-- (pegadinha real encontrada no M0: uma flag booleana sozinha não basta
-- quando start()/stop() pode ser chamado de novo antes de um task.wait
-- antigo acordar — ver .claude/agent-memory/luau-dev.md)

local watched = {} -- LuaSourceContainer -> RBXScriptConnection (sinal fast-path)
local lastSourceByInstance = {} -- LuaSourceContainer -> último Source visto (dedupe sinal+polling)
local recentWrites = {} -- LuaSourceContainer -> os.clock() da última escrita local via writeSource
local rootConnections = {} -- DescendantAdded/DescendantRemoving dos containers observados
-- Instance (Service) -> true para todo container já coberto por scanAndWatch
-- nesta geração (currentToken) — 2026-07-29 (mensagem watchedRoots,
-- docs/DECISIONS.md): permite SourceWatcher.applyWatchedRoots adicionar só os
-- containers NOVOS que a lista fixa ainda não cobria, sem re-escanear (e sem
-- duplicar conexões DescendantAdded/DescendantRemoving) os que start() já
-- tinha coberto.
local scannedRoots = {}

local log = Logger.log

-- ------------------------------------------------------------------ caminho

-- Caminho completo relativo a `game` (ex.: "ServerScriptService/Foo/Bar").
-- nil se a instância não estiver (mais) sob `game` (ex.: destruída antes do
-- Removing terminar de processar). Display-only a partir do M2 (ver cabeçalho).
-- Adicionado 2026-07-16 (consolidação de log de boot, ver init.server.luau/
-- Logger.luau): número de scripts atualmente observados, para compor a linha
-- única "conectado" exibida ao usuário quando a conexão estabiliza. Leitura
-- simples do tamanho de `watched` — sem custo além de percorrer a tabela (já
-- feito de igual forma dentro de SourceWatcher.start() para o log de debug
-- "observação iniciada").
function SourceWatcher.getWatchedCount()
	local count = 0
	for _ in watched do
		count += 1
	end
	return count
end

function SourceWatcher.pathFor(instance)
	local parts = {}
	local current = instance
	while current ~= nil and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	if current ~= game then
		return nil
	end
	return table.concat(parts, "/")
end

-- Resolve "ServerScriptService/Foo/Bar" a partir de `game`. Se
-- createClassName for passado, cria Folders intermediários e o nó final com
-- essa classe quando não existirem — mesma lógica do resolvePath dos
-- spikes, agora operando a partir de `game` em vez de uma pasta sandbox.
-- Usado só no modo criação do writeSource (sem uuid) — leitura/atualização
-- resolvem por uuid via resolveByUuid.
function SourceWatcher.resolvePath(path, createClassName)
	if type(path) ~= "string" or path == "" then
		return nil, "path vazio"
	end
	local parts = string.split(path, "/")
	local current = game
	for index, name in parts do
		local isFinal = index == #parts
		local child = current:FindFirstChild(name)
		if child == nil and index == 1 then
			-- Primeiro segmento deveria ser um serviço padrão (ServerScriptService,
			-- Workspace, etc.), sempre presente — GetService como fallback
			-- defensivo caso o serviço ainda não tenha sido tocado no DataModel.
			local ok, service = pcall(game.GetService, game, name)
			if ok then
				child = service
			end
		end
		if child == nil then
			if createClassName == nil then
				return nil, ("'%s' não encontrado em '%s'"):format(name, current:GetFullName())
			end
			local ok, created = pcall(Instance.new, if isFinal then createClassName else "Folder")
			if not ok then
				return nil, ("falha ao criar '%s': %s"):format(name, tostring(created))
			end
			created.Name = name
			created.Parent = current
			child = created
		elseif
			isFinal
			and index > 1 -- nunca converter o 1º segmento (sempre um Service do DataModel, ver fallback acima)
			and createClassName ~= nil
			and child.ClassName ~= createClassName
			and not child:IsA("LuaSourceContainer")
		then
			-- Bug real reportado pelo usuário (2026-07-26, docs/DECISIONS.md):
			-- convenção Rojo — uma pasta que já existia agrupando filhos (ex.:
			-- Folder "Interface" com scripts dentro, criada só pra agrupar) ganha
			-- um init.luau e a PRÓPRIA pasta vira o script (ModuleScript/Script/
			-- LocalScript com Source), mantendo os filhos dentro dela. Sem esta
			-- conversão, o segmento final resolvia sempre para a Folder já
			-- existente (o código nunca comparava classe do child reusado), e o
			-- chamador (init.server.luau handleWriteSource, modo criação) rejeitava
			-- com "alvo não é um script" — uma Folder nunca vira LuaSourceContainer
			-- sozinha, então IsA("LuaSourceContainer") sempre falhava.
			--
			-- CONVERTE preservando Name e Parent e reparentando TODOS os filhos
			-- atuais da Folder para a nova Instance, só então destrói a casca
			-- antiga — nunca perde os scripts que já viviam dentro dela. Os
			-- filhos preservam a MESMA Instance (não são recriados), então
			-- ScriptRegistry/watched (chaveados pela Instance, não pelo path)
			-- continuam válidos sem nenhuma limpeza extra — e como Name/Parent da
			-- Folder→script não mudam, o caminho canônico dos filhos nem muda de
			-- string (SourceWatcher.pathFor deles fica idêntico), então o próximo
			-- checkRegistryDrift não confunde isso com um scriptMoved.
			--
			-- ORDEM DAS OPERAÇÕES (corrigida 2026-08-02, continuação 3ª rodada
			-- §2 — bug confirmado pelo researcher em
			-- .claude/research/2026-08-02-reparent-descendantremoving-semantics.md,
			-- fonte oficial Roblox/creator-docs Instance.yaml): `newInstance` é
			-- parentado em `current` ANTES de mover os filhos pra dentro dela —
			-- nunca depois. A ordem antiga (montar newInstance inteira, órfã,
			-- fora da árvore, e só parentar no final) fazia cada `oldChild`
			-- deixar de ser descendente da raiz observada no instante em que
			-- virava filho de uma `newInstance` ainda sem Parent — a definição
			-- oficial de `DescendantRemoving` ("fires immediately before the
			-- parent Instance changes such that a descendant instance will no
			-- longer be a descendant") cobre exatamente esse caso, então o
			-- handler de `scanAndWatch` disparava `unwatchScript` incorretamente
			-- pra cada filho, e a reconexão via `DescendantAdded` quando
			-- `newInstance.Parent = current` rodava depois NÃO tinha garantia
			-- documentada de refire individual por descendente pré-existente de
			-- uma subárvore movida de uma vez (só relato de fórum, não-oficial,
			-- com ressalva explícita de "não garantido"). Com `newInstance` já
			-- dentro da árvore observada ANTES do loop, cada `oldChild.Parent =
			-- newInstance` é um reparent DIRETO dentro da mesma árvore já
			-- observada (nunca deixa de ser descendente da raiz) — não dispara
			-- `DescendantRemoving` nem depende de nenhum `DescendantAdded` de
			-- reconexão: a conexão de sinal (`watched[oldChild]`) e o registro
			-- em `ScriptRegistry` de cada filho nunca são tocados, sobrevivem
			-- intactos à conversão. Trade-off aceito: mais eventos de
			-- replicação Team Create (newInstance entra vazia primeiro, depois
			-- cada filho reparenta individualmente) em troca de nunca perder o
			-- watch de Source dos filhos — a ordem antiga era mais econômica em
			-- replicação, mas incorreta.
			--
			-- Só entra aqui quando a classe existente NÃO é LuaSourceContainer
			-- (ex.: Folder) — um LuaSourceContainer de OUTRA classe já existente
			-- ali (ex.: Script onde se queria ModuleScript) não é convertido por
			-- esta correção; mantém o comportamento herdado (reusa como está),
			-- fora do escopo deste bug. `index > 1` protege os Services do
			-- DataModel (1º segmento, resolvidos via GetService acima) de serem
			-- convertidos/destruídos por engano — nunca deveria acontecer na
			-- prática (Config.getWatchedRoots() nunca aponta pra um path de 1
			-- segmento só), mas o guard custa nada e evita um acidente catastrófico
			-- se algum dia acontecer.
			-- Preservação de identidade (docs/DECISIONS.md 2026-08-02, 3ª rodada,
			-- seção 2): captura o uuid da Folder ANTES de destruí-la — ver
			-- ScriptRegistry.reassignInstance para o porquê (no caminho comum de
			-- hoje isto é sempre nil, já que uma Folder pura nunca é registrada;
			-- a checagem é defensiva/futuro-prova, não corrige um caso hoje
			-- observável).
			local existingUuid = ScriptRegistry.getUuid(child)
			local ok, convertedOrErr = pcall(function()
				local newInstance = Instance.new(createClassName)
				newInstance.Name = child.Name
				-- Parenteia ANTES de mover os filhos (ver comentário acima) —
				-- newInstance nunca fica órfã enquanto os filhos entram nela.
				newInstance.Parent = current
				for _, oldChild in child:GetChildren() do
					oldChild.Parent = newInstance
				end
				child:Destroy()
				return newInstance
			end)
			if not ok then
				return nil,
					("falha ao converter '%s' de %s para %s: %s"):format(
						name,
						child.ClassName,
						createClassName,
						tostring(convertedOrErr)
					)
			end
			if existingUuid ~= nil then
				-- A Folder já tinha uuid registrado (ver nota de honestidade acima —
				-- hoje não deveria acontecer, mas se acontecer, o uuid antigo passa a
				-- apontar para a Instance nova em vez de ser varrido como "destruído"
				-- pelo próximo checkRegistryDrift + um uuid novo sem relação ser
				-- alocado por resolveOrAllocate (chamado logo em seguida por
				-- SourceWatcher.writeSource, via watchScript). Isso garante que
				-- watchScript/resolveOrAllocate reutilizem o MESMO uuid para a
				-- Instance nova (primeiro check de resolveOrAllocate é justamente
				-- `uuidByInstance[instance]`, já populado aqui).
				-- Nota sobre a reordenação acima: `newInstance.Parent = current` agora
				-- roda ANTES do loop de filhos (não depois) — mas isso não muda esta
				-- interação. Sob SignalBehavior Immediate, `DescendantAdded` do root já
				-- podia disparar `watchScript(newInstance)`/`resolveOrAllocate` de forma
				-- síncrona DENTRO do pcall mesmo na ordem antiga (só que no final, em vez
				-- de agora, no início) — se isso alocasse um uuid novo pra newInstance
				-- antes deste reassignInstance rodar, o registro desse uuid novo ficaria
				-- órfão (dormant hoje, porque existingUuid é sempre nil na prática — ver
				-- nota de honestidade acima). Pré-existente à reordenação, não introduzido
				-- por ela; não corrigido aqui (fora do escopo desta tarefa).
				ScriptRegistry.reassignInstance(existingUuid, convertedOrErr)
				log(
					("resolvePath: uuid=%s preservado na conversão de '%s' (Folder já registrada)."):format(
						existingUuid,
						name
					)
				)
			end
			log(
				("resolvePath: convertido '%s' de Folder para %s (pasta com filhos virando script via init.*, convenção Rojo)."):format(
					name,
					createClassName
				)
			)
			child = convertedOrErr
		end
		current = child
	end
	return current
end

-- Instance atual para um uuid, validada como LuaSourceContainer vivo. nil se
-- o uuid é desconhecido ou a Instance já foi destruída (delete detectado no
-- próximo ciclo de poll, se ainda não tiver sido).
function SourceWatcher.resolveByUuid(uuid)
	local instance = ScriptRegistry.getInstance(uuid)
	if instance == nil or not instance:IsA("LuaSourceContainer") then
		return nil
	end
	return instance
end

function SourceWatcher.getUuid(instance)
	return ScriptRegistry.getUuid(instance)
end

-- ------------------------------------------------------------- detecção

local function checkSourceChanged(instance, via)
	-- Pastas vendorizadas (Packages/ServerPackages/DevPackages, ver Config.luau
	-- 2026-07-16): nunca puxar Studio->disco uma edição nelas. Retorna ANTES de
	-- tocar lastSourceByInstance (nenhum estado de dedupe é criado para essas
	-- instâncias) — discovery/identidade (ScriptRegistry, watchScript) continua
	-- normal, só a detecção de mudança de Source é pulada aqui.
	if Config.isInsideExcludedPackageFolder(instance) then
		return
	end
	local current = instance.Source
	if current == lastSourceByInstance[instance] then
		return
	end
	lastSourceByInstance[instance] = current
	local wroteAt = recentWrites[instance]
	local origin = if wroteAt ~= nil and os.clock() - wroteAt < 1 then "plugin" else "studio"
	local path = SourceWatcher.pathFor(instance)
	if path == nil then
		return
	end
	local uuid = ScriptRegistry.getUuid(instance)
	-- Bug real reportado pelo usuário (2026-08-03, docs/DECISIONS.md): digitar
	-- rápido no VS Code + Ctrl+S fazia o arquivo "desfazer e reconstruir" ao
	-- longo de vários segundos. Causa raiz: `sendMessage` não tem roteamento
	-- por conexão (produto usa 1 conexão só) — toda escrita que o PRÓPRIO
	-- plugin faz por causa de um writeSource vindo da extensão (inclusive o
	-- pulse de buffer a cada ~150ms) ecoava de volta pro MESMO cliente que
	-- causou a escrita. A extensão não distingue esse eco de uma mudança
	-- genuína vinda de outro Studio via Team Create, e sua fila FIFO podia
	-- processar o eco DEPOIS que o contentCache já tinha avançado para um
	-- pulso mais novo, reescrevendo disco/buffer com conteúdo velho — repetido
	-- a cada eco atrasado, dando exatamente a aparência de revert/replay.
	-- origin=="plugin" (writeSource desta MESMA instância há <1s) é
	-- exatamente esse eco: suprime só o envio, nunca o dedupe acima
	-- (lastSourceByInstance já foi atualizado) nem o Logger.debug abaixo.
	-- writeAck (init.server.luau) já confirma a escrita para quem pediu, e
	-- refreshSync (reconciliação 3-way) continua como rede de segurança para
	-- qualquer deriva de normalização que UpdateSourceAsync introduza sem eco.
	if origin ~= "plugin" and sendMessage ~= nil then
		sendMessage({
			kind = "sourceChanged",
			uuid = uuid,
			path = path,
			source = current,
			className = instance.ClassName,
			origin = origin,
			via = via,
		})
	end
	-- 2026-07-20 (BUG 2, ruído de uso contínuo — docs/DECISIONS.md): rotineiro/
	-- alta frequência (dispara a cada edição de Source, tanto via sinal quanto
	-- polling, não só no boot) -> Logger.debug.
	Logger.debug(("sourceChanged uuid=%s '%s' via %s (origin=%s)"):format(tostring(uuid), path, via, origin))
end

-- Registra a observação de Source E resolve/aloca o uuid da Instance no
-- ScriptRegistry, nessa ordem, de forma síncrona. Retorna o uuid (nunca nil
-- para uma Instance que passa o IsA abaixo). Idempotente: se já observada,
-- só devolve o uuid já conhecido (sem reallocar nada).
local function watchScript(instance)
	if watched[instance] ~= nil then
		return ScriptRegistry.getUuid(instance)
	end
	if not instance:IsA("LuaSourceContainer") then
		return nil
	end
	-- Baseline capturada NA HORA de começar a observar, nunca esperando o
	-- próximo poll nem o DescendantAdded (evento adiado). Pegadinha real do
	-- M0.5: se a baseline só é capturada depois, uma escrita imediata
	-- seguinte pode já estar refletida nela, mascarando a própria mudança
	-- que se queria detectar. Ver .claude/agent-memory/luau-dev.md.
	lastSourceByInstance[instance] = instance.Source
	watched[instance] = instance:GetPropertyChangedSignal("Source"):Connect(function()
		checkSourceChanged(instance, "sinal")
	end)
	local uuid = ScriptRegistry.resolveOrAllocate(instance, SourceWatcher.pathFor(instance))
	return uuid
end

-- Só cuida da bookkeeping local (conexão de sinal, caches de dedupe). NÃO
-- toca no ScriptRegistry nem emite scriptRemoved: DescendantRemoving dispara
-- tanto para delete real (Instance:Destroy()) quanto para reparent para fora
-- da árvore observada (Instance ainda existe, só saiu dos containers de
-- Config.getWatchedRoots()) — os dois casos parecem idênticos daqui. A
-- decisão "isso foi delete de verdade" cabe só a checkRegistryDrift, que usa
-- ScriptRegistry.isInstanceDestroyed (Parent == nil + confirmação por pcall)
-- no próprio registry, no ciclo de poll — ver docs/MILESTONES.md (M2) e
-- ScriptRegistry.luau. NUNCA `InstanceRef.Value == nil`: correção registrada
-- em docs/DECISIONS.md 2026-07-04 (bug real confirmado em teste com 2
-- Studios) — `ObjectValue.Value` não zera quando a Instance referenciada é
-- destruída.
local function unwatchScript(instance)
	local connection = watched[instance]
	if connection ~= nil then
		connection:Disconnect()
	end
	watched[instance] = nil
	lastSourceByInstance[instance] = nil
	recentWrites[instance] = nil
end

-- Processa uma entrada JÁ CONFIRMADA como destruída de verdade
-- (ScriptRegistry.isInstanceDestroyed já checado por quem chama): remove do
-- registry e emite scriptRemoved. Compartilhado entre checkRegistryDrift
-- (ciclo de poll, caminho GARANTIDO) e checkDeadFastPath (fast-path opcional
-- via DescendantRemoving, ver scanAndWatch) — extraído para não duplicar o
-- trio remove+sendMessage+log em dois lugares, já que a mesma entrada pode
-- ser detectada como morta por qualquer um dos dois caminhos.
local function emitScriptRemoved(uuid, storedPath)
	ScriptRegistry.remove(uuid)
	if sendMessage ~= nil then
		sendMessage({ kind = "scriptRemoved", uuid = uuid, path = storedPath })
	end
	log(("scriptRemoved uuid=%s path='%s'"):format(uuid, tostring(storedPath)))
end

-- Detecção de rename/move e delete, no mesmo ciclo que já detecta mudança de
-- Source (spec M2). Para cada entrada viva do registry: se a Instance foi
-- destruída de verdade (ScriptRegistry.isInstanceDestroyed — NUNCA
-- `instance == nil`, que não é o sinal correto, ver docs/DECISIONS.md
-- 2026-07-04), emite scriptRemoved e destrói a entrada; senão, recomputa o
-- caminho canônico atual e compara com o guardado — se mudou, emite
-- scriptMoved e atualiza CanonicalPath.
--
-- CAMINHO GARANTIDO: roda a cada Config.POLL_INTERVAL_SECONDS
-- independentemente de qualquer sinal/evento ter disparado ou não — ver
-- checkDeadFastPath abaixo para o atalho opcional de latência.
local function checkRegistryDrift()
	ScriptRegistry.forEach(function(uuid, instance, storedPath)
		if ScriptRegistry.isInstanceDestroyed(instance) then
			emitScriptRemoved(uuid, storedPath)
			return
		end
		local currentPath = SourceWatcher.pathFor(instance)
		if currentPath == nil or currentPath == storedPath then
			return
		end
		ScriptRegistry.updateCanonicalPath(uuid, currentPath)
		if sendMessage ~= nil then
			sendMessage({
				kind = "scriptMoved",
				uuid = uuid,
				oldPath = storedPath,
				newPath = currentPath,
				className = instance.ClassName,
			})
		end
		log(("scriptMoved uuid=%s '%s' -> '%s'"):format(uuid, tostring(storedPath), currentPath))
	end)
end

-- Fast-path OPCIONAL de latência para delete, acionado por DescendantRemoving
-- (ver conexão em scanAndWatch). NUNCA é o caminho garantido — isso continua
-- sendo checkRegistryDrift, a cada ciclo de poll; se este fast-path nunca
-- disparar scriptRemoved na prática, não é regressão, só significa que essa
-- otimização de latência não está rendendo nada (o próximo poll cobre).
--
-- Cuidado de timing (registrado em .claude/agent-memory/luau-dev.md):
-- DescendantRemoving dispara ANTES da remoção terminar — é "Removing", não
-- "Removed". No momento exato do handler, `instance.Parent` ainda pode ser o
-- Parent ANTIGO (não nil), inclusive para um Destroy() real — então checar
-- ScriptRegistry.isInstanceDestroyed SINCRONAMENTE aqui tenderia a sempre
-- devolver falso, mesmo pra delete de verdade. O task.defer() abaixo cede um
-- resumption point pra dar chance da destruição real terminar de travar o
-- Parent antes da checagem. **[Hipótese, não confirmada em Studio real nesta
-- tarefa]**: não há como testar o timing exato (defer vs SignalBehavior
-- Immediate/Deferred) sem um Studio real — ver roteiro manual no
-- PROJECT_STATUS.md. Se a suposição estiver errada e o defer não for
-- suficiente, o fast-path simplesmente não emite nada e o polling entrega o
-- scriptRemoved no ciclo seguinte, exatamente como antes desta mudança.
--
-- Dedupe: reconfere ScriptRegistry.getUuid(instance) == uuid depois do defer,
-- porque enquanto o defer esperava, checkRegistryDrift (ciclo de poll) ou
-- outro disparo deste mesmo fast-path pode já ter processado e removido essa
-- entrada (ScriptRegistry.remove limpa uuidByInstance[instance]) — sem essa
-- reconfirmação, poderíamos emitir scriptRemoved duplicado para o mesmo uuid.
local function checkDeadFastPath(uuid, instance, storedPath)
	task.defer(function()
		if ScriptRegistry.getUuid(instance) ~= uuid then
			return -- já processado por checkRegistryDrift ou outro disparo enquanto o defer esperava
		end
		if ScriptRegistry.isInstanceDestroyed(instance) then
			emitScriptRemoved(uuid, storedPath)
		end
	end)
end

-- Escaneia um container observado (Service) recursivamente, registra a
-- observação de cada script já existente e conecta DescendantAdded/
-- DescendantRemoving para o resto da vida desta geração (myToken). Extraído
-- de dentro de start() (2026-07-29, mensagem watchedRoots, docs/DECISIONS.md)
-- para poder ser chamado tanto pelo scan inicial (start(), com a lista fixa
-- ou uma lista dinâmica já conhecida de uma conexão anterior) quanto por
-- SourceWatcher.applyWatchedRoots quando a extensão manda containers novos NO
-- MEIO de uma conexão já em andamento. Idempotente por root: se `root` já
-- estiver em scannedRoots (mesma geração), não re-escaneia nem duplica
-- conexões.
local function scanAndWatch(root, myToken)
	if scannedRoots[root] then
		return
	end
	scannedRoots[root] = true
	for _, descendant in root:GetDescendants() do
		watchScript(descendant)
	end
	table.insert(
		rootConnections,
		root.DescendantAdded:Connect(function(descendant)
			if currentToken ~= myToken then
				return
			end
			if descendant:IsA("LuaSourceContainer") then
				local uuid = watchScript(descendant)
				local path = SourceWatcher.pathFor(descendant)
				if path ~= nil and uuid ~= nil and sendMessage ~= nil then
					sendMessage({ kind = "scriptAdded", uuid = uuid, path = path, className = descendant.ClassName })
				end
			end
		end)
	)
	table.insert(
		rootConnections,
		root.DescendantRemoving:Connect(function(descendant)
			if currentToken ~= myToken then
				return
			end
			if watched[descendant] ~= nil then
				-- Fast-path opcional (ver checkDeadFastPath acima): captura
				-- uuid/storedPath ANTES de unwatchScript, que só faz
				-- bookkeeping local e nunca toca o ScriptRegistry.
				local uuid = ScriptRegistry.getUuid(descendant)
				if uuid ~= nil then
					checkDeadFastPath(uuid, descendant, ScriptRegistry.getCanonicalPath(uuid))
				end
				unwatchScript(descendant)
			end
		end)
	)
end

local function pollLoop(myToken)
	while enabled and currentToken == myToken do
		task.wait(Config.POLL_INTERVAL_SECONDS)
		if not enabled or currentToken ~= myToken then
			break
		end
		for instance in watched do
			checkSourceChanged(instance, "polling")
		end
		checkRegistryDrift()
	end
end

-- --------------------------------------------------------------- escrita

-- Escreve a Source garantindo que a instância já esteja observada (e com
-- uuid alocado) ANTES da escrita, de forma síncrona e na mesma pilha de
-- chamada (mesma pegadinha do M0.5 citada em watchScript acima).
function SourceWatcher.writeSource(instance, newSource)
	watchScript(instance)
	recentWrites[instance] = os.clock()
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(instance, function()
			return newSource
		end)
	end)
	if ok then
		lastSourceByInstance[instance] = instance.Source
		return true, "UpdateSourceAsync"
	end
	local okDirect, errDirect = pcall(function()
		instance.Source = newSource
	end)
	if okDirect then
		lastSourceByInstance[instance] = instance.Source
		return true, ".Source"
	end
	return false, tostring(errDirect)
end

-- --------------------------------------------------------------- listagem

function SourceWatcher.listScripts()
	local scripts = {}
	for instance in watched do
		local path = SourceWatcher.pathFor(instance)
		local uuid = ScriptRegistry.getUuid(instance)
		if path ~= nil and uuid ~= nil then
			table.insert(scripts, { uuid = uuid, path = path, className = instance.ClassName })
		end
	end
	return scripts
end

-- ------------------------------------------------------------ start/stop

-- onMessage(message: table) é chamado para eventos espontâneos
-- (sourceChanged/scriptAdded/scriptRemoved/scriptMoved); quem injeta decide
-- como/se enviar pela conexão WS ativa.
function SourceWatcher.init(onMessage)
	sendMessage = onMessage
end

local function isInstanceWatchable(instance)
	if not instance:IsA("LuaSourceContainer") then
		return false
	end
	for _, root in Config.getWatchedRoots() do
		if instance:IsDescendantOf(root) then
			return true
		end
	end
	return false
end

function SourceWatcher.start()
	if enabled then
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken

	-- Reconciliação (item 2 do M2): reaproveita uuids do registry existente
	-- para Instances ainda observadas ANTES de qualquer scan tratar algo como
	-- "novo" — identidade sobrevive a reload do plugin na mesma sessão de
	-- place. ScriptRegistry.reconcile também já limpa entradas obsoletas
	-- (Instance destruída ou fora dos containers observados).
	ScriptRegistry.init()
	ScriptRegistry.reconcile(isInstanceWatchable)

	for _, root in Config.getWatchedRoots() do
		scanAndWatch(root, myToken)
	end

	task.spawn(pollLoop, myToken)

	local count = 0
	for _ in watched do
		count += 1
	end
	-- 2026-07-16: Logger.debug (ruído rotineiro de boot, ver Logger.luau) —
	-- continua encaminhado por WS, só não polui o Output a cada conexão.
	Logger.debug(("observação iniciada (%d scripts encontrados nos containers observados)."):format(count))
end

function SourceWatcher.stop()
	if not enabled then
		return
	end
	enabled = false
	currentToken += 1
	for _, connection in rootConnections do
		connection:Disconnect()
	end
	table.clear(rootConnections)
	table.clear(scannedRoots)
	for _, connection in watched do
		connection:Disconnect()
	end
	table.clear(watched)
	table.clear(lastSourceByInstance)
	table.clear(recentWrites)
	log("observação parada.")
end

-- ------------------------------------------------------- watchedRoots (extensão -> plugin)
--
-- Contrato completo em docs/DECISIONS.md (2026-07-29) e
-- vscode-extension/src/protocol.ts (WatchedRootsMessage): a extensão manda
-- {kind="watchedRoots", roots={"ReplicatedFirst", ...}} uma vez por conexão
-- aceita, logo após validar o hello e ANTES do primeiro listScripts. `roots`
-- são nomes de Service (primeiro segmento de cada mount point do
-- default.project.json do usuário) — em vez da lista fixa hardcoded de
-- Config.getWatchedRoots().
--
-- Timing escolhido (opção "b" das duas avaliadas na tarefa, ver
-- docs/DECISIONS.md para a justificativa completa): NÃO atrasamos o scan
-- inicial esperando esta mensagem. start() já escaneia com
-- Config.getWatchedRoots() (fixa, ou a dinâmica de uma conexão anterior desta
-- mesma sessão de plugin) de forma síncrona e imediata, exatamente como antes
-- desta tarefa — sem introduzir timeout/espera nova que poderia travar a
-- conexão inicial caso a extensão nunca mande watchedRoots (extensão mais
-- velha, erro). Quando/se watchedRoots chegar (via handleMessage em
-- init.server.luau, sincronamente, sem nenhum yield no caminho — GetDescendants/
-- Instance.new/Connect são todos síncronos), esta função só ADICIONA os
-- containers que a lista fixa ainda não cobria — scanAndWatch é idempotente
-- por root (scannedRoots), então containers já escaneados nunca são
-- reprocessados/duplicados. Isso termina de aplicar a lista nova ANTES do
-- handler retornar, e como cada mensagem WS é processada até o fim antes da
-- próxima (mesma premissa de ordering já usada por todo o resto do
-- dispatch de handleMessage), o listScripts que a extensão manda link
-- LOGO DEPOIS já reflete os containers novos.
--
-- Decisão de UNIÃO (fixa ∪ dinâmica), não substituição total: Config.
-- getWatchedRoots() nunca REMOVE um container da lista fixa quando a
-- dinâmica chega — só adiciona os que faltam. Motivo: remover um container
-- que já estava sendo observado arriscaria "perder de vista" scripts já
-- conhecidos (uuid alocado, possivelmente com lease ativa) só porque o
-- default.project.json do usuário não referencia mais aquele Service no
-- momento exato da mensagem — um risco desnecessário para o problema real
-- reportado (containers FALTANDO, nunca containers sobrando). Escanear um
-- Service fixo a mais que o necessário é barato (mesmo custo de hoje); nunca
-- vimos indicação de que isso seja um problema.
function SourceWatcher.applyWatchedRoots(names)
	local invalidNames = Config.setDynamicWatchedRoots(names)
	for _, name in invalidNames do
		-- Nome de Service desconhecido/inválido (game:GetService falhou dentro
		-- de Config.setDynamicWatchedRoots) — nunca derruba o plugin, só pula
		-- esse nome específico e loga (regra .claude/rules/luau.md).
		log(("watchedRoots: serviço desconhecido/inválido '%s' ignorado."):format(tostring(name)))
	end

	if not enabled then
		-- SourceWatcher ainda não iniciado (ou já parado) quando esta mensagem
		-- chegou — não deveria acontecer na prática (ver ordering acima), mas
		-- se acontecer: a lista dinâmica já ficou registrada em Config e será
		-- usada na união completa (fixa+dinâmica) na próxima vez que start()
		-- rodar. Nada mais a fazer aqui.
		Logger.debug(
			"watchedRoots recebido com SourceWatcher parado; lista dinâmica guardada para o próximo start()."
		)
		return
	end

	local myToken = currentToken
	local addedCount = 0
	for _, root in Config.getWatchedRoots() do
		if currentToken ~= myToken then
			return
		end
		if not scannedRoots[root] then
			scanAndWatch(root, myToken)
			addedCount += 1
		end
	end

	if addedCount > 0 then
		log(
			("watchedRoots aplicado: +%d container(es) novo(s) (%d scripts observados no total)."):format(
				addedCount,
				SourceWatcher.getWatchedCount()
			)
		)
	else
		Logger.debug("watchedRoots aplicado: nenhum container novo (já cobertos pela lista fixa).")
	end
end

return SourceWatcher
