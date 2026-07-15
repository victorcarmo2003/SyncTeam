--modux ignore file
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local RegionComponent = Modux.Component("RegionComponent")
RegionComponent:Tag("Region")
RegionComponent:ClassName("Instance")
RegionComponent:Extend("PlayerZoneComponent")

RegionComponent:OnStart(function(self)
	self:ObserverPlayersInPart({
		MinHeight = 15,

		OnEnter = function(Player, Zone) end,

		OnExit = function(Player, Zone) end,
	})
end)

return RegionComponent
