--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Modux = require(ReplicatedStorage.Shared.Modux)

local VitalComponent = Modux.Component("VitalComponent"):Tag("VitalComponent"):ClassName("Player")

export type VitalAttributes = "Armor" | "Health"

VitalComponent.OnDie = VitalComponent.Signal.new() :: Modux.Signal<Player>

VitalComponent.ReplicateAll = function(self)
	self.Package:sendKey("Armor", self.Armor, self.Instance)
	self.Package:sendKey("Health", self.Health, self.Instance)
end

VitalComponent.ReplicateKey = function(self, Key: VitalAttributes)
	self.Package:sendKey(Key, self[Key], self.Instance)
end

VitalComponent.TakeDamage = function(self, Amount: number)
	local targetHealth = self.Health - Amount
	if targetHealth <= 0 then
		self.Health = 0
		self.Package:sendKey("Health", self.Health, self.Instance)
		warn(`[{self.Instance} Died!]`)
		return false
	end
	targetHealth = math.clamp(targetHealth, 0, 100)
	self.Health = targetHealth
	self.Package:sendKey("Health", self.Health, self.Instance)
	return true
end


VitalComponent.SetArmor = function(self, Amount: number)
	self.Armor = Amount
	self.Package:sendKey("Armor", self.Armor, self.Instance)
	return true
end

VitalComponent.Heal = function(self, Amount: number)
	local targetHealth = self.Health + Amount
	targetHealth = math.clamp(targetHealth, 0, 100)
	self.Health = targetHealth
	self.Package:sendKey("Health", self.Health, self.Instance)
	return true
end

VitalComponent:OnInit(function(self)
	self.Armor = 0
	self.Health = 100
	self.Stamina = 100

	self.Package = self.Network.Packages.VitalKey
end)

VitalComponent:OnTick(function(self, deltaTime: number)
	self:Heal(0.5)
end, Modux.TickRate.Hz1)

return VitalComponent
