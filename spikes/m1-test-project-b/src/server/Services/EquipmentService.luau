local CollectionService = game:GetService("CollectionService")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local EquipmentService = Modux.Service("EquipmentService"):Import("PlayerService")

EquipmentService:OnInit(function(self)
	self.PlayerService:OnPlayerAdded(function(Player: Player)
		CollectionService:AddTag(Player, "EquipmentComponent")
	end)
end)

return EquipmentService
