--modux ignore file
local Modux = require(game.ReplicatedStorage.Shared.Modux)
local ZoneComponent = Modux.Component("ZoneComponent"):Tag("Zone"):ClassName("Instance")
ZoneComponent:Extend("PlayerZoneComponent"):Import("ZoneService")

export type ConfigType = { [string]: { [any]: any } }

ZoneComponent:OnStart(function(self)
	self:ObserverPlayersInPart({
		MinHeight = 8,
	})

	self:OnEnter(function(Player: Player, Zone)
		self.ZoneService:ChangePlayerZone(Player, self.Instance.Name)
	end)

	self:OnExit(function(Player: Player, Zone)
		self.ZoneService:ChangePlayerZone(Player, self.Instance.Name)
	end)
end)

ZoneComponent:OnDestroy(function(self) end)

return ZoneComponent
