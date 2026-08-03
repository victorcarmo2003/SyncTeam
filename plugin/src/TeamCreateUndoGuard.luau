-- SyncTeam — Self-healing pós Ctrl+Z/Ctrl+Y (undo/redo), 2026-07-26
--
-- Contexto (bug real reportado pelo usuário; pesquisa completa em
-- .claude/research/2026-07-26-changehistoryservice-undo-exclusion.md,
-- decisão registrada em docs/DECISIONS.md): toda mudança no DataModel feita
-- por um plugin (Instance.new + .Parent = ...) entra no ChangeHistoryService
-- do usuário como qualquer edição manual — não existe API oficial pra excluir
-- uma Instance do histórico de undo/redo. `ChangeHistoryService:SetEnabled(false)`
-- existe mas desliga GLOBALMENTE e LIMPA todo o histórico do usuário
-- (inviável). `TryBeginRecording`/`FinishRecording` fazem o OPOSTO: tornam
-- uma mudança deliberadamente undo-ável (é o que o Rojo real usa para os
-- próprios patches, ver ServeSession.lua citado na pesquisa) — não servem
-- aqui. Resultado: um Ctrl+Z do usuário pode reverter/destruir as instances
-- de coordenação (sessões/heartbeats/leases/presença) sob
-- TestService.SyncTeam, quebrando o plugin e desconectando o usuário.
--
-- Achado colateral da pesquisa que REDUZ o escopo real do bug: mudanças em
-- Script/LocalScript/ModuleScript.Source são confirmadas por staff da Roblox
-- (abr/2026, "Working as Designed") como NUNCA capturadas pelo
-- ChangeHistoryService — o Ctrl+Z do usuário NUNCA reverte código
-- sincronizado. O risco é exclusivamente sobre a árvore de metadados.
--
-- Mitigação de 2 camadas, NENHUMA delas garantida sozinha — mesmo padrão já
-- usado no projeto para Source.Changed/detecção de delete
-- (.claude/rules/luau.md, "fast-path opcional + caminho garantido"):
--   1. Fast-path best-effort: `instance.Archivable = false` gravado ANTES de
--      `.Parent` em toda Instance criada sob TestService.SyncTeam
--      (TeamCreateSchema, TeamCreateElection, TeamCreateLease,
--      TeamCreatePresence, ScriptRegistry) — relato de comunidade NÃO
--      confirmado por staff, cobertura parcial (thread de 2015 citada na
--      pesquisa sugere que mudanças de PROPRIEDADE em cascata podem não ser
--      cobertas, só a criação).
--   2. Caminho garantido (ESTE MÓDULO): `ChangeHistoryService.OnUndo`/
--      `OnRedo` são eventos OFICIAIS e documentados (só entregam o NOME da
--      ação desfeita/refeita como string, nunca quais instances foram
--      afetadas — não dá pra ser seletivo). A cada disparo, roda uma
--      checagem de integridade dos módulos de coordenação, recriando o que
--      estiver faltando — "self-healing reativo", não prevenção.
--
-- Onde centralizar (decisão desta tarefa, deixada em aberto pelo
-- orquestrador): módulo pequeno dedicado, chamado 1x no boot de
-- init.server.luau (fora de start()/stop() — precisa escutar independente do
-- plugin estar conectado, já que Ctrl+Z pode acontecer a qualquer momento com
-- a place aberta). Cada módulo de coordenação expõe seu próprio
-- checkIntegrity() (TeamCreateElection/TeamCreateLease/TeamCreatePresence),
-- reaproveitando a lógica "criar se não existir" que cada um já tinha para o
-- próprio uso normal — nada duplicado aqui, este módulo só ORQUESTRA a
-- chamada dos três em resposta ao evento.
--
-- Escopo desta fatia: só os três módulos com checkIntegrity() dedicado
-- (Sessions/heartbeat, Leases, Presence — os citados explicitamente na
-- tarefa). ScriptRegistry.luau (Scripts/<uuid>) e TeamCreateSchema.luau
-- (root/ROOT_VALUES) ganharam só a camada 1 (Archivable=false); não há
-- checkIntegrity() dedicado pra eles nesta fatia — ver comentário em
-- ScriptRegistry.createOrAdoptRecord sobre o risco residual aceito.
--
-- Debounce: OnUndo/OnRedo podem disparar em rajada numa sequência de vários
-- Ctrl+Z seguidos. Sem fila/prioridade: só um `task.defer` por disparo (cede
-- um resumption point, suficiente pra coalescer disparos síncronos da mesma
-- rajada) — cada checkIntegrity() já é barata e idempotente (na maioria das
-- vezes só um FindFirstChild/checagem de Parent que não faz nada), então
-- disparos redundantes são inofensivos, não precisa de debounce por tempo.
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Logger = require(script.Parent.Logger)
local TeamCreateElection = require(script.Parent.TeamCreateElection)
local TeamCreateLease = require(script.Parent.TeamCreateLease)
local TeamCreatePresence = require(script.Parent.TeamCreatePresence)

local TeamCreateUndoGuard = {}

local log = Logger.log

local connections = {}

-- Ordem igual à de init.server.luau start(): Election antes de Lease/
-- Presence, porque getSessionFolder() (usado pelos outros dois) depende da
-- sessão já ter sido recriada. Cada checkIntegrity() já é no-op se o módulo
-- correspondente não estiver `enabled` (plugin desconectado) — protegido por
-- pcall individual: uma falha inesperada em um módulo não pode impedir os
-- outros dois de rodar (.claude/rules/luau.md, "falha degrada, nunca quebra
-- o plugin inteiro").
local function checkIntegrity()
	local ok1, err1 = pcall(TeamCreateElection.checkIntegrity)
	if not ok1 then
		log("undoGuard: falha checkIntegrity (Election):", tostring(err1))
	end
	local ok2, err2 = pcall(TeamCreateLease.checkIntegrity)
	if not ok2 then
		log("undoGuard: falha checkIntegrity (Lease):", tostring(err2))
	end
	local ok3, err3 = pcall(TeamCreatePresence.checkIntegrity)
	if not ok3 then
		log("undoGuard: falha checkIntegrity (Presence):", tostring(err3))
	end
end

local function onHistoryEvent(kindLabel)
	return function(waypointName)
		-- Rotineiro/alta frequência potencial (rajada de Ctrl+Z) e não
		-- necessariamente acionável (a grande maioria dos undos do usuário não
		-- tem nada a ver com o SyncTeam) -> Logger.debug, mesmo critério já
		-- usado no projeto (docs/DECISIONS.md 2026-07-20). O log VISÍVEL
		-- (Logger.log) só acontece dentro de cada checkIntegrity() quando algo
		-- de fato precisou ser recriado.
		Logger.debug(
			("undoGuard: %s detectado (%s) — verificando integridade de TestService.SyncTeam"):format(
				kindLabel,
				tostring(waypointName)
			)
		)
		task.defer(checkIntegrity)
	end
end

-- Chamado 1x no boot do plugin (init.server.luau), fora de start()/stop().
-- Idempotente: chamadas repetidas não duplicam conexões.
function TeamCreateUndoGuard.start()
	if #connections > 0 then
		return
	end

	-- Toda API de plataforma nova em pcall (.claude/rules/luau.md) — mesmo
	-- ChangeHistoryService sendo um serviço central do Studio, uma falha aqui
	-- (ambiente inesperado, versão antiga) degrada para "sem self-healing
	-- reativo", nunca quebra o resto do plugin.
	local okUndo, connOrErr = pcall(function()
		return ChangeHistoryService.OnUndo:Connect(onHistoryEvent("undo"))
	end)
	if okUndo then
		table.insert(connections, connOrErr)
	else
		log("undoGuard: falha ao conectar OnUndo:", tostring(connOrErr))
	end

	local okRedo, connOrErr2 = pcall(function()
		return ChangeHistoryService.OnRedo:Connect(onHistoryEvent("redo"))
	end)
	if okRedo then
		table.insert(connections, connOrErr2)
	else
		log("undoGuard: falha ao conectar OnRedo:", tostring(connOrErr2))
	end

	if #connections > 0 then
		Logger.debug("undoGuard: escutando ChangeHistoryService.OnUndo/OnRedo.")
	end
end

-- Chamado em plugin.Unloading, junto do resto do cleanup de ciclo de vida.
function TeamCreateUndoGuard.stop()
	for _, connection in connections do
		connection:Disconnect()
	end
	connections = {}
end

return TeamCreateUndoGuard
