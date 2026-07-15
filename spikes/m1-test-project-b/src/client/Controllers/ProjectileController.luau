local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Modux = require(ReplicatedStorage.Shared.Modux)
local GetGun = require(ReplicatedStorage.Shared.Utils.GetGun)

export type BulletData = {
	instance: BasePart,
	startPos: Vector3,
	endPos: Vector3,
	ammoType: GetGun.AmmoType,
}

local ProjectileController = Modux.Controller("ProjectileController")
ProjectileController.AllBullets = {} :: {[number]: BulletData}

local getBulletFolder = function(): Folder
	local folder = workspace:FindFirstChild("Bullets")
		or (function()
			local folder = Instance.new("Folder")
			folder.Name = "Bullets"
			folder.Parent = workspace
		end)()
	return folder
end

ProjectileController.Shoot = function(self, bulletData: BulletData)
	local bulletTrail = ReplicatedStorage.Assets.bullet_trail
	local clonedBullet = bulletTrail:Clone()
	clonedBullet.Parent = getBulletFolder()

	local data: BulletData = {
		instance = clonedBullet,
		startPos = bulletData.startPos,
		endPos = bulletData.endPos,
		ammoType = bulletData.ammoType,
	}

	table.insert(self.AllBullets, data)
end

ProjectileController:OnSimulation(function(self, deltaTime: number) end, Enum.StepFrequency.Hz60)

return ProjectileController
