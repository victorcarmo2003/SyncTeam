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
--
-- CORREÇÃO (2026-07-07, docs/DECISIONS.md — split-brain de liderança
-- confirmado em teste real com 2 Studios): o antigo `getOrCreate`
-- (`FindFirstChild` -> se nil, `Instance.new`+`.Parent`) é um clássico
-- "singleton preguiçoso" — se dois Studios chamam `ensureRoot()`/
-- `ensureFolder()` quase ao mesmo tempo, ANTES da réplica do Team Create de
-- um assentar no outro, os dois veem `FindFirstChild(...) == nil` e cada um
-- cria sua PRÓPRIA Instance (Roblox permite duas Instances irmãs com o mesmo
-- Name — não faz merge). Cada Studio então guarda a referência retornada
-- (cacheada por quem chama, ex. `TeamCreateElection.rootValues`) e passa a
-- ler/escrever SEMPRE nessa cópia local, mesmo depois que a réplica do outro
-- lado chegar como um segundo filho do mesmo Folder — dois "líderes"
-- genuinamente operando sobre Instances DIFERENTES, não um conflito de
-- escrita na mesma Instance. Reproduzido: `LeaderTerm` divergente (6 vs 1)
-- entre dois Studios no mesmo `tick()`.
--
-- Fix: `getOrCreate` agora RECONCILIA duplicatas sempre que é chamado (não só
-- na criação) — ver `getOrCreate` abaixo. Convergência determinística sem
-- depender de "quem viu o quê primeiro" (impossível garantir com replicação
-- assíncrona, só minimizar a janela): cada Instance criada por este módulo
-- ganha um atributo `SyncTeamOrigin` (GUID aleatório, gravado ANTES de
-- `.Parent` ser setado); se `getOrCreate` encontra mais de uma Instance com o
-- mesmo Name+ClassName sob o mesmo parent, a CANÔNICA é sempre a de menor
-- `SyncTeamOrigin` (ordem lexicográfica) — todo Studio que já tiver AMBAS as
-- duplicatas replicadas calcula a MESMA escolha, independente de qual viu
-- primeiro. As demais são MESCLADAS na canônica antes de destruídas (nunca
-- dropam estado):
--   - Folder: todo filho é reparentado pra dentro da canônica antes da casca
--     vazia ser destruída (cobre Scripts/Sessions/Leases e o próprio
--     SyncTeam) — se isso deixar netos com nomes repetidos sob a canônica
--     (ex.: duas sessões de clientId diferente por azar não colidem, mas dois
--     valores-filho tipo LeaderTerm duplicados sob a MESMA pasta raiz por uma
--     corrida separada, sim), a PRÓXIMA chamada de getOrCreate para aquele
--     nome específico reconcilia de novo — nunca perde dado, só pode levar
--     mais de um ciclo pra convergir de vez.
--   - Value numérica (IntValue): a canônica fica com o MAIOR valor entre
--     todas as duplicatas — os contadores deste projeto (LeaderTerm,
--     NextJoinSequence, NextLeaseRequestSequence) são estritamente
--     crescentes, "maior" nunca é retrocesso nem perde progresso real de
--     nenhum lado.
--   - Outras Values (StringValue como LeaderClientId): sem merge de
--     conteúdo — o ciclo de eleição já se autocorrige no tick seguinte (lê
--     Sessions/ já mesclado e reavalia liderança do zero); na pior hipótese
--     custa +1 incremento de term "desperdiçado" na convergência, nunca
--     viola exclusão mútua de líder.
-- Quem chama `ensureRoot()`/`ensureFolder()` UMA VEZ em `start()` e cacheia o
-- resultado (`TeamCreateElection.luau`) precisa continuar chamando de novo a
-- cada ciclo (`tick()`) para essa reconciliação ter efeito prático — só criar
-- a Instance duplicate-safe não helps se a referência local nunca for
-- atualizada depois de reconciliada (ver fix em TeamCreateElection.luau).

local HttpService = game:GetService("HttpService")
local TestService = game:GetService("TestService")

local Logger = require(script.Parent.Logger)

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

-- Atributo de desempate determinístico e REPLICADO (ver comentário de cabeçalho).
local ORIGIN_ATTRIBUTE = "SyncTeamOrigin"

local log = Logger.log

local function originOf(instance)
	return instance:GetAttribute(ORIGIN_ATTRIBUTE) or ""
end

-- Desempate primário: SyncTeamOrigin (determinístico/replicado). Se os dois
-- candidatos ainda não tiverem o atributo (Instance duplicada criada ANTES
-- desta correção — caso legado, só deve ocorrer uma vez na primeira
-- reconciliação de um schema pré-existente), cai para um desempate por
-- conteúdo replicado: `.Value` para Values (comparável, replicado de
-- verdade), contagem de filhos para Folder. `[Hipótese]`: nesse caso legado
-- (ambos sem atributo), dois Studios com visões parcialmente diferentes de
-- replicação PODEM escolher canônicos diferentes num único ciclo — não perde
-- dado (merge sempre roda antes de destruir), só pode custar 1-2 ciclos
-- extras de convergência; nunca exercitado contra Studio real, só deduzido
-- por leitura de código.
local function byOrigin(a, b)
	local originA, originB = originOf(a), originOf(b)
	if originA ~= originB then
		return originA < originB
	end
	if a:IsA("Folder") and b:IsA("Folder") then
		return #a:GetChildren() > #b:GetChildren() -- mais estado real = mais "estabelecido"
	end
	local va, vb = a.Value, b.Value
	if typeof(va) == "number" and typeof(vb) == "number" then
		return va < vb
	end
	return tostring(va) < tostring(vb)
end

-- Devolve a Instance canônica dentre TODAS as crianças de `parent` com o
-- Name+ClassName dados, criando se não existir nenhuma e RECONCILIANDO se
-- houver mais de uma (ver comentário de cabeçalho do arquivo para a
-- justificativa completa do algoritmo). Chamado a cada tick (não só 1x) por
-- quem usa este módulo — é isso que garante autocorreção contínua enquanto a
-- replicação do Team Create ainda estiver assentando.
local function getOrCreate(parent, className, name)
	local candidates = {}
	for _, child in ipairs(parent:GetChildren()) do
		if child.Name == name and child.ClassName == className then
			table.insert(candidates, child)
		end
	end

	if #candidates == 0 then
		local value = Instance.new(className)
		value.Name = name
		-- Atributo gravado ANTES de .Parent: melhor esforço para replicar
		-- junto com a criação (mesmo princípio de "registrar antes de agir"
		-- já usado no projeto para baseline de Source/uuid) — não é garantia
		-- atômica de rede, só reduz a janela em que a Instance existe sem o
		-- atributo.
		value:SetAttribute(ORIGIN_ATTRIBUTE, HttpService:GenerateGUID(false))
		value.Parent = parent
		return value
	end

	if #candidates == 1 then
		local only = candidates[1]
		if only:GetAttribute(ORIGIN_ATTRIBUTE) == nil then
			only:SetAttribute(ORIGIN_ATTRIBUTE, HttpService:GenerateGUID(false))
		end
		return only
	end

	table.sort(candidates, byOrigin)
	local canonical = candidates[1]
	if canonical:GetAttribute(ORIGIN_ATTRIBUTE) == nil then
		canonical:SetAttribute(ORIGIN_ATTRIBUTE, HttpService:GenerateGUID(false))
	end

	local isFolder = canonical:IsA("Folder")
	local maxNumeric = nil
	if not isFolder and typeof(canonical.Value) == "number" then
		maxNumeric = canonical.Value
	end

	for i = 2, #candidates do
		local duplicate = candidates[i]
		if isFolder then
			-- Reparenta TODOS os filhos antes de destruir a casca — nunca
			-- perde estado aninhado (sessões/scripts/leases que nasceram por
			-- azar sob a pasta "perdedora"). Se algum nome colidir com um
			-- filho já existente sob `canonical`, fica temporariamente
			-- duplicado um nível abaixo — resolvido pela PRÓXIMA chamada de
			-- getOrCreate sobre aquele nome específico (mesma reconciliação,
			-- aplicada de novo a cada ciclo).
			for _, grandchild in ipairs(duplicate:GetChildren()) do
				grandchild.Parent = canonical
			end
		elseif maxNumeric ~= nil and typeof(duplicate.Value) == "number" then
			maxNumeric = math.max(maxNumeric, duplicate.Value)
		end
		pcall(function()
			duplicate:Destroy()
		end)
	end

	if maxNumeric ~= nil and canonical.Value ~= maxNumeric then
		canonical.Value = maxNumeric
	end

	log(("reconciliada(s) %d duplicata(s) de %s '%s' sob %s"):format(
		#candidates - 1,
		className,
		name,
		parent:GetFullName()
	))

	return canonical
end

-- Idempotente: cria (ou reaproveita/reconcilia) TestService.SyncTeam e os
-- valores de coordenação (eleição + leases). Retorna { folder, values =
-- {LeaderClientId, LeaderTerm, NextJoinSequence, NextLeaseRequestSequence} }
-- (as próprias Instances de valor, não .Value já lido — quem chama decide
-- ler/escrever). Sem cache module-level: sempre reavalia contra
-- TestService:GetChildren() — barato (poucos filhos), e é isso que permite
-- reconciliar duplicatas criadas DEPOIS da primeira chamada (ver cabeçalho).
function TeamCreateSchema.ensureRoot()
	local rootFolder = getOrCreate(TestService, "Folder", "SyncTeam")

	local values = {}
	for name, className in ROOT_VALUES do
		values[name] = getOrCreate(rootFolder, className, name)
	end

	return { folder = rootFolder, values = values }
end

-- Cria (ou reaproveita/reconcilia) uma pasta filha direta de
-- TestService.SyncTeam — usado para "Scripts" (ScriptRegistry), "Sessions"
-- (TeamCreateElection) e "Leases" (TeamCreateLease), evitando duplicar a
-- chamada a ensureRoot() em cada módulo.
function TeamCreateSchema.ensureFolder(name)
	local root = TeamCreateSchema.ensureRoot()
	return getOrCreate(root.folder, "Folder", name)
end

return TeamCreateSchema
