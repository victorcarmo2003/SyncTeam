-- SyncTeam — Registry de identidade de script (M2)
--
-- TestService.SyncTeam.Scripts.<uuid> = Folder { InstanceRef: ObjectValue,
-- CanonicalPath: StringValue (display-only) }. Porta da IDEIA validada em
-- dois Studios reais no RojoCoop (TeamCreateSchema.lua/createScript+readScript
-- e TeamCreateCoordinator:__resolveScriptRegistry) — sem eleição/leases/
-- schema versionado (SchemaVersion, sessões, leases), que ficam para o M3
-- (docs/MILESTONES.md). Aqui é só a estrutura mínima Scripts/<uuid>.
--
-- Identidade nunca é path nem attribute (decisão registrada,
-- docs/DECISIONS.md 2026-07-02): sempre UUID (HttpService:GenerateGUID(false))
-- + ObjectValue apontando para a Instance.
--
-- CORREÇÃO (docs/DECISIONS.md 2026-07-04, bug real confirmado em teste com 2
-- Studios): `InstanceRef.Value == nil` NUNCA é sinal de "instância
-- destruída" — `ObjectValue.Value` não zera automaticamente quando a
-- Instance referenciada é destruída (comportamento intencional confirmado
-- por staff da Roblox no DevForum, ver
-- .claude/research/2026-07-04-objectvalue-destroy-detection.md; o teste do
-- RojoCoop citado antes aqui só validou isso contra um MOCK, nunca contra o
-- engine real). Detecção de "destruído de verdade" usa
-- `ScriptRegistry.isInstanceDestroyed` (Parent == nil + confirmação por pcall
-- de reatribuição de Parent), nunca `InstanceRef.Value == nil` isolado.
-- `DescendantRemoving` continua não sendo usado para essa decisão porque
-- também dispara por reparent para fora da árvore observada, sem a
-- instância ter sido destruída de verdade.

local HttpService = game:GetService("HttpService")

local Logger = require(script.Parent.Logger)
local TeamCreateSchema = require(script.Parent.TeamCreateSchema)

local ScriptRegistry = {}

local scriptsFolder = nil -- TestService.SyncTeam.Scripts

-- Estado em memória (escopo de sessão do plugin, reconstruído por reconcile()
-- a cada start()). uuidByInstance é o inverso de recordByUuid[uuid].instance,
-- mantido separado só para lookup O(1) por Instance.
local uuidByInstance = {} -- Instance -> uuid
local recordByUuid = {} -- uuid -> { folder, instanceRef, canonicalPath (StringValue), instance }

local log = Logger.log

-- Container raiz (TestService.SyncTeam) extraído para TeamCreateSchema.luau
-- nesta fatia (M3.1) porque TeamCreateElection.luau também precisa dele
-- (Sessions/<clientId> + LeaderClientId/LeaderTerm/NextJoinSequence, mesmo
-- nível de Scripts) — evita duplicar "criar Folder SyncTeam sob TestService
-- se não existir" em dois módulos.
local function ensureContainers()
	if scriptsFolder ~= nil then
		return
	end
	scriptsFolder = TeamCreateSchema.ensureFolder("Scripts")
end

-- Detecta "removida da árvore observada" — nome documentado como
-- `isInstanceDestroyed` mas, na prática, é `Parent == nil`, sem
-- confirmação por pcall.
--
-- CORREÇÃO 2 (docs/DECISIONS.md 2026-07-04, teste ao vivo): a primeira
-- versão desta função exigia `pcall(function() instance.Parent = instance.Parent end)`
-- falhar (só falha quando `Destroy()` real trava a propriedade `Parent`).
-- Em teste real repetido, apagar um script pelo Explorer do Studio NUNCA
-- fez essa confirmação falhar — hipótese: o "Delete" do Explorer aparenta
-- fazer um soft-delete (só reparenta pra nil, mantendo a Instance viva e
-- editável) para suportar Ctrl+Z/undo, sem chamar Instance:Destroy() de
-- verdade nesse momento. Isso é `[Hipótese]`, não confirmado contra
-- documentação oficial (pesquisa anterior só confirmou o comportamento de
-- `ObjectValue.Value` em `Destroy()`, não o comportamento do Explorer
-- delete). Reparentar de verdade (`instance.Parent = novoPai`) é uma
-- atribuição atômica que nunca passa por um estado intermediário
-- observável com Parent nil — então, para os containers que este plugin
-- observa (Services/pastas reais manipuladas por humano via Explorer, não
-- reparenting programático via nil intermediário), `Parent == nil` sozinho
-- já é um sinal prático suficiente de "não está mais na árvore observada",
-- sem precisar da confirmação por pcall.
function ScriptRegistry.isInstanceDestroyed(instance)
	if instance == nil then
		return true
	end
	return instance.Parent == nil
end

-- Varre scriptsFolder procurando uma entrada JÁ EXISTENTE (possivelmente
-- replicada de outro Studio via Team Create) cujo InstanceRef aponte pra essa
-- MESMA Instance. Usado por resolveOrAllocate para não gerar um uuid novo
-- quando outro Studio já alocou um para essa Instance — bug real confirmado
-- em teste com 2 Studios (docs/DECISIONS.md 2026-07-04): sem essa varredura,
-- dois Studios acabavam alocando uuids diferentes para o mesmo script
-- replicado. Entradas cuja Instance já foi destruída de verdade
-- (isInstanceDestroyed) são ignoradas — não fazem sentido reaproveitar.
local function findRegistryEntryFor(instance)
	for _, folder in ipairs(scriptsFolder:GetChildren()) do
		if not folder:IsA("Folder") then
			continue
		end
		local instanceRef = folder:FindFirstChild("InstanceRef")
		local canonicalPath = folder:FindFirstChild("CanonicalPath")
		if
			instanceRef == nil
			or not instanceRef:IsA("ObjectValue")
			or canonicalPath == nil
			or not canonicalPath:IsA("StringValue")
		then
			continue
		end
		local candidate = instanceRef.Value
		if candidate == instance and not ScriptRegistry.isInstanceDestroyed(candidate) then
			return folder.Name, instanceRef, canonicalPath
		end
	end
	return nil
end

-- Cria (ou reaproveita, se já existir sob o mesmo nome) a estrutura
-- Folder/InstanceRef/CanonicalPath para um uuid já decidido, e popula os
-- mapas em memória. Uso interno de resolveOrAllocate() e reconcile().
local function createOrAdoptRecord(uuid, instance, canonicalPathStr)
	local folder = scriptsFolder:FindFirstChild(uuid)
	if folder == nil then
		folder = Instance.new("Folder")
		folder.Name = uuid
		folder.Parent = scriptsFolder
	end
	local instanceRef = folder:FindFirstChild("InstanceRef")
	if instanceRef == nil then
		instanceRef = Instance.new("ObjectValue")
		instanceRef.Name = "InstanceRef"
		instanceRef.Parent = folder
	end
	instanceRef.Value = instance
	local canonicalPath = folder:FindFirstChild("CanonicalPath")
	if canonicalPath == nil then
		canonicalPath = Instance.new("StringValue")
		canonicalPath.Name = "CanonicalPath"
		canonicalPath.Parent = folder
	end
	canonicalPath.Value = canonicalPathStr or ""

	local record = { folder = folder, instanceRef = instanceRef, canonicalPath = canonicalPath, instance = instance }
	recordByUuid[uuid] = record
	uuidByInstance[instance] = uuid
	return record
end

function ScriptRegistry.init()
	ensureContainers()
end

-- Reconciliação: chamar 1x no início de cada SourceWatcher.start(), ANTES de
-- escanear/observar qualquer Instance. Percorre Scripts:GetChildren() e, para
-- cada entrada cuja Instance referenciada ainda for válida (não destruída de
-- verdade, ver isInstanceDestroyed) e observada (isWatched(instance) ==
-- true), reaproveita o uuid em memória — identidade sobrevive a reload do
-- plugin dentro da mesma sessão de place. Entradas cuja Instance já foi
-- destruída de verdade ou que não são mais observadas (fora dos containers de
-- Config.getWatchedRoots()) são destruídas na hora: mesma regra de "delete"
-- do steady-state, só que aplicada retroativamente ao que aconteceu enquanto
-- o plugin estava parado/recarregando.
function ScriptRegistry.reconcile(isWatched)
	ensureContainers()
	local reused, stale = 0, 0
	for _, folder in ipairs(scriptsFolder:GetChildren()) do
		if not folder:IsA("Folder") then
			continue
		end
		local instanceRef = folder:FindFirstChild("InstanceRef")
		local canonicalPath = folder:FindFirstChild("CanonicalPath")
		if
			instanceRef == nil
			or not instanceRef:IsA("ObjectValue")
			or canonicalPath == nil
			or not canonicalPath:IsA("StringValue")
		then
			-- Entrada corrompida/incompleta (schema versionado/validação é M3);
			-- não é escopo desta fatia decidir o que fazer com lixo malformado.
			continue
		end
		local instance = instanceRef.Value
		if ScriptRegistry.isInstanceDestroyed(instance) or not isWatched(instance) then
			folder:Destroy()
			stale += 1
			continue
		end
		recordByUuid[folder.Name] =
			{ folder = folder, instanceRef = instanceRef, canonicalPath = canonicalPath, instance = instance }
		uuidByInstance[instance] = folder.Name
		reused += 1
	end
	log(("registry reconciliado: %d reaproveitados, %d removidos (obsoletos)."):format(reused, stale))
end

-- Resolve o uuid de uma Instance observada, alocando um novo (e criando a
-- entrada no registry) se ela ainda não tiver um — nem reconciliado do
-- registry existente, nem alocado antes nesta sessão. Retorna uuid, isNew.
--
-- CORREÇÃO (docs/DECISIONS.md 2026-07-04, bug real confirmado em teste com 2
-- Studios): antes de gerar um uuid novo, também busca no registry
-- COMPARTILHADO (findRegistryEntryFor) por uma entrada que já aponte pra essa
-- Instance — não só no mapa em memória local (uuidByInstance). Cobre o caso
-- de uma Instance replicada de outro Studio (que já alocou uuid pra ela)
-- aparecer via DescendantAdded DEPOIS que o reconcile() inicial já rodou;
-- sem essa varredura, os dois Studios alocavam uuids diferentes para o mesmo
-- script.
function ScriptRegistry.resolveOrAllocate(instance, canonicalPathStr)
	ensureContainers()
	local existing = uuidByInstance[instance]
	if existing ~= nil then
		return existing, false
	end
	local existingUuid, instanceRef, canonicalPath = findRegistryEntryFor(instance)
	if existingUuid ~= nil then
		local folder = scriptsFolder:FindFirstChild(existingUuid)
		recordByUuid[existingUuid] = { folder = folder, instanceRef = instanceRef, canonicalPath = canonicalPath, instance = instance }
		uuidByInstance[instance] = existingUuid
		log(("resolveOrAllocate: reaproveitado uuid=%s já existente no registry compartilhado."):format(existingUuid))
		return existingUuid, false
	end
	local uuid = HttpService:GenerateGUID(false)
	createOrAdoptRecord(uuid, instance, canonicalPathStr)
	return uuid, true
end

-- Instance atual para um uuid, ou nil se desconhecido OU se a Instance já foi
-- destruída de verdade (ver isInstanceDestroyed — InstanceRef.Value sozinho
-- NÃO detecta isso, ver cabeçalho do arquivo).
function ScriptRegistry.getInstance(uuid)
	local record = recordByUuid[uuid]
	if record == nil then
		return nil
	end
	local instance = record.instanceRef.Value
	if ScriptRegistry.isInstanceDestroyed(instance) then
		return nil
	end
	return instance
end

function ScriptRegistry.getUuid(instance)
	return uuidByInstance[instance]
end

function ScriptRegistry.getCanonicalPath(uuid)
	local record = recordByUuid[uuid]
	if record == nil then
		return nil
	end
	return record.canonicalPath.Value
end

function ScriptRegistry.updateCanonicalPath(uuid, newPath)
	local record = recordByUuid[uuid]
	if record ~= nil then
		record.canonicalPath.Value = newPath
	end
end

-- Destrói a entrada do registry (Folder inteiro) e limpa os mapas em memória.
-- Não decide sozinho SE deve remover — quem chama (SourceWatcher, ciclo de
-- poll) já decidiu que a Instance foi destruída.
function ScriptRegistry.remove(uuid)
	local record = recordByUuid[uuid]
	if record == nil then
		return
	end
	uuidByInstance[record.instance] = nil
	recordByUuid[uuid] = nil
	record.folder:Destroy()
end

-- Itera um SNAPSHOT (tirado antes de qualquer callback rodar) de todas as
-- entradas vivas do registry, chamando callback(uuid, instance,
-- storedCanonicalPath). `instance` vem direto de InstanceRef.Value — pode ser
-- uma referência "morta" (Instance já destruída de verdade, ver cabeçalho do
-- arquivo); quem chama decide isso com ScriptRegistry.isInstanceDestroyed,
-- não `instance == nil` (nunca acontece por essa via). Snapshot é necessário
-- porque o callback do chamador (checkRegistryDrift em SourceWatcher) pode
-- chamar ScriptRegistry.remove() para o próprio uuid em processamento —
-- mutar recordByUuid durante a iteração de `pairs` sobre ele mesmo não é
-- seguro em Luau.
function ScriptRegistry.forEach(callback)
	local snapshot = {}
	for uuid, record in recordByUuid do
		table.insert(snapshot, { uuid = uuid, instance = record.instanceRef.Value, storedPath = record.canonicalPath.Value })
	end
	for _, entry in snapshot do
		callback(entry.uuid, entry.instance, entry.storedPath)
	end
end

return ScriptRegistry
