local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local GunMixin = Modux.Mixin("GunMixin")

export type SeedProp = {
	Pop: Part,
	Center: Part,
	Dirt2: Part,
	Dirt1: Part,
} & Model

GunMixin.Shoot = function(self, target: Vector3)
	print(`[shoot]`)
end

GunMixin.CanShoot = function(self)
	local canShoot = false
	if self.Bullets >= 0 then
		canShoot = true
	else
		canShoot = false
	end
	if (workspace:GetServerTimeNow() - self.lastshoot) >= self.FireRate then
		canShoot = true
	else
		canShoot = false
	end
	return canShoot
end

GunMixin.GetBullets = function(self, Amount: number)
	self.Bullets += Amount
end

GunMixin.PlantAt = function(self, Position: Vector3)
	local seedProp = ReplicatedStorage.Assets.SeedProp:Clone()
	seedProp:PivotTo(CFrame.new(Position))
	CollectionService:AddTag(seedProp, "SeedComponent")
end

GunMixin.GetOrigin = function(self): Vector3
	local muzzle = self.Instance.Muzzle
	if not muzzle then
		return self.Instance.PrimaryPart.Position
	end
	return muzzle.WorldPosition
end

GunMixin:OnStart(function(self)
	self.Bullets = 0
	self.Damage = 0
	self.ShootAmount = 1
	self.Spread = 0
	self.FireRate = 0
	self.lastshoot = workspace:GetServerTimeNow() :: number
end)

GunMixin:OnDestroy(function(self) end)

return GunMixin
