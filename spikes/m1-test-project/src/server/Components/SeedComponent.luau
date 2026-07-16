local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local SeedSettings = require(ReplicatedStorage.Shared.Settings.SeedSettings)
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local SeedComponent = Modux.Component("SeedComponent"):Tag("SeedComponent"):ClassName("Model")

SeedComponent.Harvest = function(self)
    self:Cleanup(self.Proximity.Triggered:Connect(function(Player: Player)
        
    end))
end

SeedComponent.Setup = function(self)
	local ProximityPrompt = Instance.new("ProximityPrompt")
	ProximityPrompt.RequiresLineOfSight = false
	ProximityPrompt.Parent = self.Instance.PrimaryPart
	ProximityPrompt.ActionText = "COLLECT"
	ProximityPrompt.ObjectText = "ammo"
	ProximityPrompt.HoldDuration = 0.5
	ProximityPrompt.Enabled = false
	self.Proximity = ProximityPrompt
end

SeedComponent.StartAnimations = function(self)
	local center = self.Instance.Center
	local dirt1 = self.Instance.Dirt1
	local dirt2 = self.Instance.Dirt2
	local pop = self.Instance.Pop
	local info = TweenInfo.new(1, Enum.EasingStyle.Exponential, Enum.EasingDirection.Out)
	TweenService:Create(center, info, { Transparency = 0 }):Play()
	task.wait(1)
	TweenService:Create(dirt1, info, { Transparency = 0 }):Play()
	task.wait(1)
	TweenService:Create(dirt2, info, { Transparency = 0 }):Play()
	task.wait(1)
	TweenService:Create(pop, info, { Transparency = 0 }):Play()
	task.wait(1)
end

SeedComponent:OnStart(function(self)
	self.HarvestTime = SeedSettings.HARVEST_TIME :: number
	self.PlantTime = workspace:GetServerTimeNow() :: number
	self:StartAnimations()
	self:Setup()
end)

SeedComponent:OnTick(function(self, deltaTime: number)
	if (workspace:GetServerTimeNow() - self.HarvestTime) >= self.HarvestTime then
		self.Proximity.Enabled = true
	end
end, Modux.TickRate.Hz10)

return SeedComponent
