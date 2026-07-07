-- SyncTeam — Container raiz compartilhado de TestService.SyncTeam (M3.1)
--
-- Extraído nesta fatia porque dois módulos agora precisam de
-- "criar Folder SyncTeam sob TestService se não existir": ScriptRegistry.luau
-- (Scripts/<uuid>, desde o M2) e TeamCreateElection.luau (Sessions/<clientId>,
-- LeaderClientId/LeaderTerm/NextJoinSequence, desta fatia M3.1). Antes desta
-- tarefa essa lógica só existia duplicada dentro de
-- ScriptRegistry.ensureContainers — TODO cumprido (ver comentário lá).
--
-- Escopo estritamente mínimo: só o container raiz e os valores de
-- coordenação de eleição (LeaderClientId/LeaderTerm/NextJoinSequence) que
-- MILESTONES.md (M3.1) pede no mesmo nível de TestService.SyncTeam.Scripts.
-- Nada de SchemaVersion/intents versionados aqui.
--
-- M3.2 (leases por script, ver plugin/src/TeamCreateLease.luau) adicionou
-- NextLeaseRequestSequence ao mesmo nível — reusa o padrão já existente de
-- "valor de coordenação direto sob a raiz", não um container próprio.

local TestService = game:GetService("TestService")

local TeamCreateSchema = {}

-- Valores de coordenação, direto sob TestService.SyncTeam (mesmo nível de
-- TestService.SyncTeam.Scripts). LeaderClientId/LeaderTerm/NextJoinSequence
-- são da eleição (M3.1); NextLeaseRequestSequence é das leases (M3.2).
local ROOT_VALUES = {
	LeaderClientId = "StringValue",
	LeaderTerm = "IntValue",
	NextJoinSequence = "IntValue",
	NextLeaseRequestSequence = "IntValue",
}

local rootFolder = nil -- TestService.SyncTeam

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

-- Idempotente: cria (ou reaproveita) TestService.SyncTeam e os valores de
-- coordenação (eleição + leases). Retorna { folder, values = {LeaderClientId,
-- LeaderTerm, NextJoinSequence, NextLeaseRequestSequence} } (as próprias
-- Instances de valor, não .Value já lido — quem chama decide ler/escrever).
function TeamCreateSchema.ensureRoot()
	if rootFolder == nil then
		rootFolder = TestService:FindFirstChild("SyncTeam")
		if rootFolder == nil then
			rootFolder = Instance.new("Folder")
			rootFolder.Name = "SyncTeam"
			rootFolder.Parent = TestService
		end
	end

	local values = {}
	for name, className in ROOT_VALUES do
		values[name] = getOrCreate(rootFolder, className, name)
	end

	return { folder = rootFolder, values = values }
end

-- Cria (ou reaproveita) uma pasta filha direta de TestService.SyncTeam —
-- usado para "Scripts" (ScriptRegistry) e "Sessions" (TeamCreateElection),
-- evitando duplicar a chamada a ensureRoot() em cada módulo.
function TeamCreateSchema.ensureFolder(name)
	local root = TeamCreateSchema.ensureRoot()
	return getOrCreate(root.folder, "Folder", name)
end

return TeamCreateSchema
