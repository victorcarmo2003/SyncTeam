local Shared = game:GetService("ReplicatedStorage").Shared
local Settings = require(Shared.Settings.DayCycle)

local Modux = require(Shared.Modux)

export type DayCycle = "Day" | "Night" | "Idle" | "Transition"

local DayNightService = Modux.Service("DayNightService")

DayNightService.CurrentClock = 0 :: number
DayNightService.CurrentDay = 0 :: number
DayNightService.OnCycleChanged = DayNightService.Signal.new() :: Modux.Signal<DayCycle, DayCycle>
DayNightService.CurrentCycle = "Day" :: DayCycle

local TRANSITION_INFO = {
	Damping = 1,
	Frequency = 0.2,
	Epsilon = 0.01,
}

local function getNightClockTarget(currentClock: number): number
	if Settings.NightClock <= currentClock then
		return Settings.NightClock + 24
	end

	return Settings.NightClock
end

DayNightService.StartTransition = function(self, DayTime: "Night" | "Day")
	local lightning = game.Lighting
	local Spring = self.Tools.Spring

	local changeToNight = Spring:Create(lightning, {
		ClockTime = getNightClockTarget(lightning.ClockTime),
		Brightness = Settings.NightBrightness,
	}, {
		Damping = TRANSITION_INFO.Damping,
		Frequency = TRANSITION_INFO.Frequency,
		Epsilon = TRANSITION_INFO.Epsilon,
		Done = function()
			lightning.ClockTime = Settings.NightClock
			self.CurrentClock = Settings.NightDuration
		end,
	})
	local changeToDay = Spring:Create(lightning, {
		ClockTime = Settings.DayClock,
		Brightness = Settings.DayBrightness,
	}, {
		Damping = TRANSITION_INFO.Damping,
		Frequency = TRANSITION_INFO.Frequency,
		Epsilon = TRANSITION_INFO.Epsilon,
		Done = function()
			self.CurrentClock = Settings.DayDuration
		end,
	})

	self:SetCycle("Transition")
	if DayTime == "Night" then
		changeToNight:Play()
		changeToNight.Completed:Wait()
		self:SetCycle("Night")
	else
		changeToDay:Play()
		changeToDay.Completed:Wait()
		self:SetCycle("Day")
	end
	self:ReplicateClock()
end

DayNightService.ReplicateClock = function(self)
	self.Network.Packages.SecondsCycle:send({ Seconds = self.CurrentClock }, self.Network.all)
end

DayNightService.ObserverCycle = function(self, callback: (currentState: DayCycle) -> ())
	callback(self.CurrentCycle)

	return self.OnCycleChanged:Connect(function(_, currentCycle)
		callback(currentCycle)
	end)
end

DayNightService.IncreaseDay = function(self)
	self.CurrentDay += 1
	self.Network.Packages.DayCycle:send({ CurrentDay = self.CurrentDay }, self.Network.all)
end

DayNightService.GetDay = function(self)
	return self.CurrentDay
end

DayNightService.GetCycle = function(self)
	return self.CurrentCycle
end

DayNightService.SetCycle = function(self, cycle: DayCycle)
	local previousCycle = self.CurrentCycle

	self.CurrentCycle = cycle
	if previousCycle ~= cycle then
		self.OnCycleChanged:Fire(previousCycle, cycle)
	end

	if previousCycle == "Night" then
		self:IncreaseDay()
	end
end

DayNightService.ToggleCycle = function(self)
	if self.CurrentCycle == "Day" then
		self.Network.Packages.TransitionCycle:send({ DayTime = "Night" }, self.Network.all)
		self:StartTransition("Night")
	elseif self.CurrentCycle == "Night" then
		self.Network.Packages.TransitionCycle:send({ DayTime = "Day" }, self.Network.all)
		self:StartTransition("Day")
	end
end

DayNightService.StartCycle = function(self)
	self.CurrentClock = Settings.DayDuration
	self:SetCycle("Day")
	self:ReplicateClock()
end

DayNightService:OnStart(function(self)
	self:SetCycle("Idle")
end)

-- DayNightService:OnTick(function(self)
-- 	if self.CurrentCycle == "Idle" or self.CurrentCycle == "Transition" then
-- 		return
-- 	end
-- 	if self.CurrentClock <= 0 then
-- 		self:ToggleCycle()
-- 		return
-- 	end

-- 	self.CurrentClock -= 1
-- 	self:ReplicateClock()
-- end, Modux.TickRate.Hz1)

return DayNightService
