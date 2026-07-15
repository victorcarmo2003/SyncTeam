local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")

local Modux = require(ReplicatedStorage.Shared.Modux)
local MovementService = Modux.Service("MovementService"):Import("PlayerService")

MovementService:OnStart(function(self) 
	self.PlayerService:OnPlayerAdded(function(Player: Player)
		CollectionService:AddTag(Player, "MovementComponent")
	end)
end)

return MovementService
