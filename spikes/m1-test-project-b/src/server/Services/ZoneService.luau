--modux ignore file
local Modux = require(game.ReplicatedStorage.Shared.Modux)
local ZoneService = Modux.Service("ZoneService")
ZoneService:Import("ProfileService")

ZoneService.zonePlayers = {} :: { [Player]: string }
ZoneService.safezonePlayers = {} :: { [Player]: string }

ZoneService.ChangePlayerZone = function(self, Player: Player, Zone)
	local playerZone = self.zonePlayers[Player]

	if not playerZone or playerZone ~= Zone then
		self.zonePlayers[Player] = Zone
		self.ProfileService:Set(Player, "CurrentZone", Zone)
	end
end

ZoneService.ChangePlayerSafeZone = function(self, Player: Player, Zone)
	local playerSafezone = self.safezonePlayers[Player]

	if not playerSafezone or playerSafezone ~= Zone then
		self.safezonePlayers[Player] = Zone
		self.ProfileService:Set(Player, "CurrentZone", Zone)
	end
end

ZoneService:OnInit(function(self) end)

ZoneService:OnStart(function(self) end)

return ZoneService
