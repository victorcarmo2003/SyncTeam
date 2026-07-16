local Modux = require(game.ReplicatedStorage.Shared.Modux)
local VitalController =	Modux.Controller("VitalController"):Import("ScreenController"):Import("ColorCorrectionController")

local clampSaturation = function(health: number, maxHealth: number): number
	maxHealth = math.max(maxHealth, 1)
	local percent = math.clamp(health / maxHealth, 0, 1)
	if percent >= 0.5 then
		return 0.5
	end
	local t = percent / 0.5
	return -1 + (1.5 * t)
end

VitalController.OnUpdateHealth = function(self, Amount: number)
	local clamped = clampSaturation(self.Health, self.MaxHealth)
	self.ColorCorrectionController:SetSaturation(clamped)
end

VitalController.UpdateHealth = function(self, number: number)
	local healthConteiner = self.PlayerStatus.Health
	local text = healthConteiner.TextLabel
	text.Text = `HEALTH: {number}%`
	VitalController:OnUpdateHealth(number)
end

VitalController:OnInit(function(self)
	self.Health = 100
	self.MaxHealth = 100
	self.Network.Packages.VitalKey:onKey(function(key, value)
		if key == "Health" then
			self.Health = value
			self:UpdateHealth(value)
		end
	end)
end)

VitalController:OnStart(function(self)
	local screenGui = self.ScreenController:GetGui()
	self.PlayerStatus = screenGui.Conteiner.Player
	task.spawn(function()
		local Vitals = self.Network.Packages.GetVitals:request()

		if Vitals then
			self.Armor = Vitals.Armor
			self.Health = Vitals.Health
			self.Stamina = Vitals.Stamina
			self.MaxHealth = (Vitals.MaxHealth :: number) or 100
			self.MaxStamina = (Vitals.MaxStamina :: number) or 100

			self:UpdateHealth(self.Health)
		end
	end)
end)

return VitalController
