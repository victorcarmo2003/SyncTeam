local ReplicatedStorage = game:GetService("ReplicatedStorage")
local FSM = require(ReplicatedStorage.Shared.Utils.FSM)
local Modux = require(ReplicatedStorage.Shared.Modux)

type GameStates = "Begin" | "Normal" | "DarkMoon"
local GameService = Modux.Service("GameService"):Import("DayNightService")

GameService.CurrentState = "Begin" :: GameStates

GameService.OnBegin = GameService.Signal.new() :: Modux.Signal<>
GameService.OnNormal = GameService.Signal.new() :: Modux.Signal<>
GameService.OnDarkMoon = GameService.Signal.new() :: Modux.Signal<>

GameService.State = FSM.new<<GameStates>>("Begin", {
	Begin = { "Normal" },
	Normal = { "DarkMoon" },
	DarkMoon = { "Normal" },
})

GameService:OnInit(function(self)
	self.State:Transition("Begin")

	task.delay(5, function()
		self.State:Transition("Normal")
		self.DayNightService:StartCycle()
	end)

	local connection = self.DayNightService.OnCycleChanged:Connect(
		function(previous: "Day" | "Night" | "Idle", current: "Day" | "Night" | "Idle")
			if previous == "Night" then
			end
		end
	)

	self:Cleanup(connection)
end)

return GameService
