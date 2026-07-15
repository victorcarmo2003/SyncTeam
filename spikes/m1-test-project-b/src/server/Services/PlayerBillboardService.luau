local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local PlayerBilboardService = Modux.Service("PlayerBilboardService"):Import("PlayerService")

PlayerBilboardService:OnInit(function(self)
	local billboard = ReplicatedStorage.Assets.PlayerBillboard
	self.PlayerService:OnCharacterAdded(function(Character, Player: Player)
		local cloned = billboard:Clone()
		cloned.TextLabel.Text = Player.DisplayName
		cloned.Parent = Character.PrimaryPart
	end)
end)

return PlayerBilboardService
