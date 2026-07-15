local CollectionService = game:GetService("CollectionService")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local WeaponService = Modux.Service("WeaponService"):Import("PlayerService")

WeaponService:OnInit(function(self)
	self.PlayerService:OnPlayerAdded(function(Player: Player)
		CollectionService:AddTag(Player, "EquipmentComponent")
	end)
end)

WeaponService:OnStart(function(self) end)

return WeaponService
