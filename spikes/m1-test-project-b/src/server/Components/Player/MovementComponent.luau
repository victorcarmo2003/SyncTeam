local ReplicatedStorage = game:GetService("ReplicatedStorage")
local FSM = require(ReplicatedStorage.Shared.Utils.FSM)

local Modux = require(game.ReplicatedStorage.Shared.Modux)
local MovementComponent = Modux.Component("MovementComponent"):Tag("MovementComponent"):ClassName("Instance")

export type MovementStates = "Walking" | "Running" | "Crouch" | "Jumping" | "Dead"
local transitions: FSM.Transitions<MovementStates> = {
	Walking = { "Running", "Crouch", "Jumping", "Dead" }, -- can do everything
	Running = { "Walking", "Crouch", "Jumping", "Dead" }, -- can do everything
	Crouch = { "Walking", "Running", "Jumping", "Dead" }, -- can do everything
	Jumping = { "Walking", "Running", "Dead" },
}

MovementComponent.State = FSM.new<<MovementStates>>("Walking", transitions)

MovementComponent.StartWalk = function(self, player)
	local result = self.State:Transition("Running")
	if result then
		self.Network.Packages.ChangeWalkSpeed:send({ WalkSpeed = 18 }, self.Instance)
	end
	return result
end

MovementComponent.StartRun = function(self, player)
	local result = self.State:Transition("Walking")
	if result then
		self.Network.Packages.ChangeWalkSpeed:send({ WalkSpeed = 28 }, self.Instance)
	end
	return result
end

MovementComponent.StartCrouch = function(self, player)
	if self.State:Is("Crouch") then
		self.Network.Packages.ChangeWalkSpeed:send({ WalkSpeed = 18 }, self.Instance)
	end
	local result = self.State:Transition("Crouch")
	if result then
		self.Network.Packages.ChangeWalkSpeed:send({ WalkSpeed = 10 }, self.Instance)
	end
	return result
end

MovementComponent:OnInit(function(self)
	self.Network.Packages.ChangeMovement:on(
		function(request: { ActionName: string }, player: Player?): { CanDo: boolean }?
			if player ~= self.Instance then
				return
			end
			if request.ActionName == "Sprint" then
				return { CanDo = self:StartRun() }
			end

			if request.ActionName == "Walk" then
				return { CanDo = self:StartWalk() }
			end

			if request.ActionName == "Crouch" then
				return { CanDo = self:StartCrouch(player) }
			end

			if request.ActionName == "Jump" then
				return { CanDo = true }
			end
			return { CanDo = false }
		end
	)
end)

return MovementComponent
