local Spring = {}

local RunService = game:GetService("RunService")
local autoUpdateSprings = {}

local sqrt, exp, cos, sin, abs, tick = math.sqrt, math.exp, math.cos, math.sin, math.abs, tick
local setmetatable, typeof, rawget, rawset = setmetatable, typeof, rawget, rawset
local dot = Vector3.new().Dot
local EPSILON = 1e-8

Spring.__index = Spring

function Spring.new(initial)
	local self = setmetatable({
		Position = initial or 0,
		Velocity = (typeof(initial) == "Vector3") and Vector3.zero or 0,
		Target = initial or 0,
		Damping = 1,
		Frequency = 1,
		LastTick = tick(),
		AutoUpdate = false,
		FixedDeltaTime = nil,
	}, Spring)

	return self
end

function Spring:SetAutoUpdate(flag)
	self.AutoUpdate = flag
	if flag then
		autoUpdateSprings[self] = true
	else
		autoUpdateSprings[self] = nil
	end
end

function Spring:Update(dt)
	local d, f = self.Damping, self.Frequency * 2 * math.pi
	local offset = self.Position - self.Target
	local decay = exp(-d * f * dt)

	if d == 1 then
		self.Position = (offset + (self.Velocity + offset * f) * dt) * decay + self.Target
		self.Velocity = (self.Velocity - (self.Velocity + offset * f) * f * dt) * decay
	elseif d < 1 then
		local c, i, j = sqrt(1 - d * d), cos(sqrt(1 - d * d) * f * dt), sin(sqrt(1 - d * d) * f * dt)
		local z = j / sqrt(1 - d * d)
		self.Position = (offset * (i + d * z) + self.Velocity * z / f) * decay + self.Target
		self.Velocity = (self.Velocity * (i - z * d) - offset * (z * f)) * decay
	else
		local c = sqrt(d * d - 1)
		local r1, r2 = -f * (d - c), -f * (d + c)
		local co2 = (self.Velocity - offset * r1) / (r2 - r1)
		local co1 = offset - co2
		self.Position = co1 * exp(r1 * dt) + co2 * exp(r2 * dt) + self.Target
		self.Velocity = co1 * r1 * exp(r1 * dt) + co2 * r2 * exp(r2 * dt)
	end
end

function Spring:Get()
	local now = tick()
	local dt = now - self.LastTick
	if dt > 0 then
		self:Update(dt)
		self.LastTick = now
	end
	return self.Position, self.Velocity
end

function Spring:Accelerate(a)
	local now, dt = tick(), tick() - self.LastTick
	if dt > 0 then
		self:Update(dt)
		self.LastTick = now
	end

	if typeof(self.Velocity) == "number" then
		self.Velocity += a
	elseif typeof(self.Velocity) == "Vector3" then
		self.Velocity = self.Velocity + a
	end
end

function Spring:SetTarget(target)
	assert(typeof(target) == typeof(self.Position), "Target type mismatch")
	self.Target = target
end

function Spring:Drive(target, gain)
	assert(typeof(target) == typeof(self.Position), "Target type mismatch")
	self.Target = target
	local err = target - self.Position
	self:Accelerate((gain or 1) * err)
end

function Spring:__newindex(key, value)
	if key == "Position" or key == "Velocity" or key == "Target" or key == "Damping" or key == "Frequency" then
		rawset(self, key, value)
	else
		rawset(self, key, value)
	end
end

RunService.Heartbeat:Connect(function(dt)
	for spring in pairs(autoUpdateSprings) do
		local step = spring.FixedDeltaTime or dt
		spring:Update(step)
		spring.LastTick += step
	end
end)

return Spring
