-- Debounce.luau
type AwaitResult = () -> ()

type DebounceResult = {
	Active: boolean,
	Await: () -> AwaitResult,
}

-- Estado global isolado por (owner, key, id)
-- owner = tostring(self) ou qualquer chave que o componente passe
local _cooldowns: { [string]: { [string]: number } } = {}

local function getCooldowns(owner: string): { [string]: number }
	if not _cooldowns[owner] then
		_cooldowns[owner] = {}
	end
	return _cooldowns[owner]
end

local function makeResult(active: boolean, waitTime: number?): DebounceResult
	return {
		Active = active,
		Await = function()
			if waitTime and waitTime > 0 then
				task.wait(waitTime)
			end
		end,
	}
end

local Debounce = {}

--[[
	Consulta debounce por jogador.
	
	@param owner   string  — identificador do componente (ex: tostring(self))
	@param key     string  — nome único dentro do componente (ex: "sprint")
	@param duration number — duração do cooldown em segundos
	@param player  Player  — jogador alvo
	@return DebounceResult
	
	Uso:
		local db = self.Tools.Debounce:Player(tostring(self), "sprint", 1, player)
		if db.Active then return end
		db.Await() -- opcional: aguarda cooldown acabar
]]
function Debounce:Player(owner: string, key: string, duration: number, player: Player): DebounceResult
	local cooldowns = getCooldowns(owner)
	local id = key .. "_" .. player.UserId
	local remaining = (cooldowns[id] or 0) - workspace.DistributedGameTime

	if remaining > 0 then
		return makeResult(true, remaining)
	end

	cooldowns[id] = workspace.DistributedGameTime + duration
	return makeResult(false)
end

--[[
	Consulta debounce global (sem jogador).
	
	@param owner   string  — identificador do componente
	@param key     string  — nome único dentro do componente
	@param duration number — duração do cooldown
	@return DebounceResult

	Uso:
		local db = self.Tools.Debounce:Event(tostring(self), "activate", 2)
		if db.Active then return end
]]
function Debounce:Event(owner: string, key: string, duration: number): DebounceResult
	local cooldowns = getCooldowns(owner)
	local remaining = (cooldowns[key] or 0) - workspace.DistributedGameTime

	if remaining > 0 then
		return makeResult(true, remaining)
	end

	cooldowns[key] = workspace.DistributedGameTime + duration
	return makeResult(false)
end

--[[
	Limpa todos os cooldowns de um owner.
	Chame no Destroy/cleanup do componente.
]]
function Debounce:Flush(owner: string)
	_cooldowns[owner] = nil
end

return Debounce
