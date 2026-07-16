local Modux = require(game.ReplicatedStorage.Shared.Modux)

local CharacterService = Modux.Service("CharacterService"):Import("PlayerService")

CharacterService:OnInit(function(self)
	self.PlayerService:OnCharacterAdded(function(Character, Player: Player)
		for _, inst: Instance in Character:GetDescendants() do
			if not inst:IsA("Accessory") then
				continue
			end
			for _, basepart in inst:GetDescendants() do
				if basepart:IsA("BasePart") then
					basepart.CanQuery = false
				end
			end
		end

		local conn = Character.DescendantAdded:Connect(function(a0: Instance)
			if a0:IsA("BasePart") and a0:FindFirstAncestorWhichIsA("Accessory") then
				a0.CanQuery = false
			end
		end)

		Character.Destroying:Once(function()
			conn:Disconnect()
		end)
	end)
end)

CharacterService:OnStart(function(self) end)

return CharacterService
