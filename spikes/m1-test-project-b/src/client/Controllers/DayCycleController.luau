--!strict
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local DayCycleController = Modux.Controller("DayCycleController")

DayCycleController:OnInit(function(self)
	self.Network.Packages.SecondsCycle:on(function(payload)
		--
	end)

	self.Network.Packages.DayCycle:on(function(payload)
		--
	end)

	self.Network.Packages.TransitionCycle:on(function(data: { DayTime: string })
		--print(`[CLIENT-SIDE] Daytime:`, data.DayTime)
	end)
end)

return DayCycleController
