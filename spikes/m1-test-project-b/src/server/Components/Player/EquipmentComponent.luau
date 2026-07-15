local Modux = require(game.ReplicatedStorage.Shared.Modux)

local EquipmentComponent = Modux.Component("EquipmentComponent"):Tag("EquipmentComponent"):ClassName("Player")

EquipmentComponent.EquipGun = function(self, gunComponent)
    self.EquippedGun = gunComponent :: {}
end

EquipmentComponent:OnStart(function(self)
	
end)

EquipmentComponent:OnDestroy(function(self) end)

return EquipmentComponent
