local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GetBodyPart = require(ReplicatedStorage.Shared.Utils.GetBodyPart)
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local HitController =
	Modux.Controller("HitController"):Import("MovementController"):Import("CameraController"):Import("InputController")

HitController.TryHit = function(self): boolean
	local basepart, Player = self.CameraController:GetLookPart()
    print(basepart)
	if not Player then
		print(`[HitController - TryHit] Player not identified`)
		return false
	end
	local ID = Player:GetAttribute("GameID")
	local moveDirection = self.MovementController:GetMoveDirection()
	local lookAtPosition = self.CameraController:GetLookAt()
	local originPosition = self.LocalCharacter.PrimaryPart.Position
	local bodyPartID = GetBodyPart.Get(basepart.Name)
	if not lookAtPosition or not moveDirection or not ID then
		print(`[HitController - TryHit] missing data {lookAtPosition}, {moveDirection}, {ID}`)
		return false
	end


	local isValid = self.Network.Packages.HitValidate:request({
		TargetID = ID,
		HitPart = bodyPartID,
		Origin = originPosition,
		Direction = lookAtPosition,
		TimeStamp = workspace:GetServerTimeNow()
	})

	return isValid
end

HitController:OnStart(function(self)
	
	local handler = self.InputController:BindAction("TryHit", Enum.UserInputType.MouseButton1)
	
	handler.OnPress(function()
		warn(`[button pressed]`)
		self:TryHit()
	end)
end)

return HitController
