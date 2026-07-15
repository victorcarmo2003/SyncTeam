--!strict

local GlobalClock = {}
local startTime = os.clock()

-- Retorna o tempo decorrido desde a inicialização do Modux
function GlobalClock.GetTime(): number
	return os.clock() - startTime
end

-- Utilitário para oscilações (Seno), muito usado em componentes visuais
function GlobalClock.GetSine(speed: number?, amplitude: number?, offset: number?): number
	local t = GlobalClock.GetTime() * (speed or 1) + (offset or 0)
	return math.sin(t) * (amplitude or 1)
end

-- Utilitário para interpolação linear baseada no tempo
function GlobalClock.Lerp(a: number, b: number, t: number): number
	return a + (b - a) * t
end

return GlobalClock
