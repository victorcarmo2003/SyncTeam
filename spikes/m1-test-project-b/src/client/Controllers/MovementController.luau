local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Modux = require(ReplicatedStorage.Shared.Modux)
local MovementController = Modux.Controller("MovementController"):Import("InputController")

MovementController.GetCurrentPosition = function(self)
	local primaryPart = self.LocalCharacter.PrimaryPart
	local origin = primaryPart.Position
	return origin
end

MovementController.GetMoveDirection = function(self)
	local moveDirection = self.LocalHumanoid.MoveDirection
	return moveDirection
end

MovementController.BindKeys = function(self)
	local ShiftHandler = self.InputController:BindAction("Sprint", Enum.KeyCode.LeftShift, true, 10)
	ShiftHandler.OnPress(function()
		self.Network.Packages.ChangeMovement:send({ ActionName = "Sprint" })
	end)

	ShiftHandler.OnRelease(function()
		self.Network.Packages.ChangeMovement:send({ ActionName = "Walk" })
	end)

	local CHandler = self.InputController:BindAction("Crouch", Enum.KeyCode.C, true, 10)

	CHandler.OnPress(function()
		self.Network.Packages.ChangeMovement:send({ ActionName = "Crouch" })
	end)
end

MovementController:OnInit(function(self)
	self.Network.Packages.ChangeWalkSpeed:on(function(data: { WalkSpeed: number })
		self.LocalHumanoid.WalkSpeed = data.WalkSpeed
	end)
end)

MovementController:OnStart(function(self)
	self:BindKeys()
end)

return MovementController
