local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Spring = require(ReplicatedStorage.Packages.spring) :: any

export type SpringableValue =
	number
	| Vector2
	| Vector3
	| Color3
	| UDim
	| UDim2
	| CFrame
	| Rect

export type SpringGoals = { [string]: SpringableValue }

export type SpringInfo = {
	-- Spring damping. Lower values overshoot more; 1 is critically damped.
	Damping: number?,
	-- Spring frequency in cycles per second. Higher values settle faster.
	Frequency: number?,
	-- Distance and velocity threshold used to mark the spring as completed.
	Epsilon: number?,
	-- RunService signal used to update the spring.
	Clock: ("Heartbeat" | "RenderStepped")?,
	-- Called every frame after properties are applied.
	Step: ((target: Instance, values: SpringGoals, alpha: number) -> ())?,
	-- Called once when the spring reaches every goal.
	Done: (() -> ())?,
}

export type SpringTween = {
	Completed: RBXScriptSignal,
	Play: (self: SpringTween) -> SpringTween,
	Stop: (self: SpringTween, finish: boolean?) -> SpringTween,
	SetGoals: (self: SpringTween, goals: SpringGoals) -> SpringTween,
	SetInfo: (self: SpringTween, info: SpringInfo) -> SpringTween,
	GetCurrentValues: (self: SpringTween) -> SpringGoals,
	Destroy: (self: SpringTween) -> SpringTween,
}

type Codec = {
	Encode: (value: any) -> { number },
	Decode: (values: { number }) -> any,
	Measure: (values: { number }) -> number,
}

type PropertySpring = {
	Name: string,
	Codec: Codec,
	Springs: { any },
	Goal: { number },
	Start: { number },
}

local DEFAULT_DAMPING = 0.82
local DEFAULT_FREQUENCY = 6
local DEFAULT_EPSILON = 0.001

local SpringWrapper = {}

local function magnitude(values: { number }): number
	local sum = 0
	for _, value in values do
		sum += value * value
	end

	return math.sqrt(sum)
end

local function numberCodec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value }
		end,
		Decode = function(values: { number }): number
			return values[1]
		end,
		Measure = magnitude,
	}
end

local function vector2Codec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.X, value.Y }
		end,
		Decode = function(values: { number }): Vector2
			return Vector2.new(values[1], values[2])
		end,
		Measure = magnitude,
	}
end

local function vector3Codec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.X, value.Y, value.Z }
		end,
		Decode = function(values: { number }): Vector3
			return Vector3.new(values[1], values[2], values[3])
		end,
		Measure = magnitude,
	}
end

local function color3Codec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.R, value.G, value.B }
		end,
		Decode = function(values: { number }): Color3
			return Color3.new(values[1], values[2], values[3])
		end,
		Measure = magnitude,
	}
end

local function udimCodec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.Scale, value.Offset }
		end,
		Decode = function(values: { number }): UDim
			return UDim.new(values[1], values[2])
		end,
		Measure = magnitude,
	}
end

local function udim2Codec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset }
		end,
		Decode = function(values: { number }): UDim2
			return UDim2.new(values[1], values[2], values[3], values[4])
		end,
		Measure = magnitude,
	}
end

local function rectCodec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value.Min.X, value.Min.Y, value.Max.X, value.Max.Y }
		end,
		Decode = function(values: { number }): Rect
			return Rect.new(values[1], values[2], values[3], values[4])
		end,
		Measure = magnitude,
	}
end

local function cframeCodec(): Codec
	return {
		Encode = function(value: any): { number }
			return { value:GetComponents() }
		end,
		Decode = function(values: { number }): CFrame
			return CFrame.new(table.unpack(values))
		end,
		Measure = magnitude,
	}
end

local function getCodec(value: any): Codec
	local valueType = typeof(value)
	if valueType == "number" then
		return numberCodec()
	elseif valueType == "Vector2" then
		return vector2Codec()
	elseif valueType == "Vector3" then
		return vector3Codec()
	elseif valueType == "Color3" then
		return color3Codec()
	elseif valueType == "UDim" then
		return udimCodec()
	elseif valueType == "UDim2" then
		return udim2Codec()
	elseif valueType == "CFrame" then
		return cframeCodec()
	elseif valueType == "Rect" then
		return rectCodec()
	end

	error(`[SpringWrapper] Unsupported value type "{valueType}".`, 3)
end

local function assertSameType(propertyName: string, currentValue: any, goalValue: any)
	assert(
		typeof(currentValue) == typeof(goalValue),
		`[SpringWrapper] Property "{propertyName}" has type "{typeof(currentValue)}", but goal has type "{typeof(goalValue)}".`
	)
end

local function makePropertySpring(target: Instance, propertyName: string, goalValue: any, damping: number, frequency: number): PropertySpring
	local currentValue = (target :: any)[propertyName]
	assertSameType(propertyName, currentValue, goalValue)

	local codec = getCodec(goalValue)
	local start = codec.Encode(currentValue)
	local goal = codec.Encode(goalValue)
	local springs = table.create(#goal)

	for index, value in start do
		local spring = Spring.new(value)
		spring.Damping = damping
		spring.Frequency = frequency
		spring:SetTarget(goal[index])
		springs[index] = spring
	end

	return {
		Name = propertyName,
		Codec = codec,
		Springs = springs,
		Goal = goal,
		Start = start,
	}
end

local function readSpringValues(propertySpring: PropertySpring): { number }
	local values = table.create(#propertySpring.Springs)
	for index, spring in propertySpring.Springs do
		values[index] = spring.Position
	end

	return values
end

local function readSpringVelocities(propertySpring: PropertySpring): { number }
	local values = table.create(#propertySpring.Springs)
	for index, spring in propertySpring.Springs do
		values[index] = spring.Velocity
	end

	return values
end

local function alphaFrom(start: { number }, goal: { number }, current: { number }, epsilon: number): number
	local totalSpan = 0
	local totalProgress = 0

	for index, startValue in start do
		local span = goal[index] - startValue
		if math.abs(span) > epsilon then
			totalSpan += math.abs(span)
			totalProgress += math.abs(current[index] - startValue)
		end
	end

	if totalSpan <= epsilon then
		return 1
	end

	return math.clamp(totalProgress / totalSpan, 0, 1)
end

local function disconnect(connection: RBXScriptConnection?)
	if connection then
		connection:Disconnect()
	end
end

function SpringWrapper:Create(target: Instance, goals: SpringGoals, info: SpringInfo): SpringTween
	local springInfo = info
	local damping = springInfo.Damping or DEFAULT_DAMPING
	local frequency = springInfo.Frequency or DEFAULT_FREQUENCY
	local epsilon = springInfo.Epsilon or DEFAULT_EPSILON
	local clock = springInfo.Clock or "Heartbeat"
	local step = springInfo.Step
	local done = springInfo.Done

	local completedEvent = Instance.new("BindableEvent")
	local handle = {
		Completed = completedEvent.Event,
	} :: any

	local propertySprings = {} :: { PropertySpring }
	local connection: RBXScriptConnection? = nil
	local playing = false
	local destroyed = false

	local function rebuildSprings(nextGoals: SpringGoals)
		table.clear(propertySprings)
		for propertyName, goalValue in nextGoals do
			table.insert(propertySprings, makePropertySpring(target, propertyName, goalValue, damping, frequency))
		end
	end

	local function getCurrentValues(): SpringGoals
		local values = {} :: { [string]: SpringableValue }
		for _, propertySpring in propertySprings do
			values[propertySpring.Name] = propertySpring.Codec.Decode(readSpringValues(propertySpring))
		end

		return values :: SpringGoals
	end

	local function applyCurrent(): number
		local alphaSum = 0
		for _, propertySpring in propertySprings do
			local values = readSpringValues(propertySpring)
			target[propertySpring.Name] = propertySpring.Codec.Decode(values)
			alphaSum += alphaFrom(propertySpring.Start, propertySpring.Goal, values, epsilon)
		end

		local alpha = if #propertySprings > 0 then alphaSum / #propertySprings else 1
		if step then
			step(target, getCurrentValues(), alpha)
		end

		return alpha
	end

	local function stopConnection()
		disconnect(connection)
		connection = nil
		playing = false
	end

	local function setFinishValues()
		for _, propertySpring in propertySprings do
			for index, spring in propertySpring.Springs do
				spring.Position = propertySpring.Goal[index]
				spring.Velocity = 0
			end
		end

		applyCurrent()
	end

	rebuildSprings(goals)

	function handle:Play(): SpringTween
		if destroyed then
			return self
		end

		stopConnection()
		for _, propertySpring in propertySprings do
			propertySpring.Start = readSpringValues(propertySpring)
			for index, spring in propertySpring.Springs do
				spring.Damping = damping
				spring.Frequency = frequency
				spring:SetTarget(propertySpring.Goal[index])
			end
		end

		playing = true
		local signal = if clock == "RenderStepped" and RunService:IsClient() then RunService.RenderStepped else RunService.Heartbeat
		connection = signal:Connect(function(deltaTime)
			local completed = true

			for _, propertySpring in propertySprings do
				for _, spring in propertySpring.Springs do
					spring:Update(deltaTime)
				end

				local values = readSpringValues(propertySpring)
				local velocities = readSpringVelocities(propertySpring)
				local offsets = table.create(#values)
				for index, value in values do
					offsets[index] = value - propertySpring.Goal[index]
				end

				if propertySpring.Codec.Measure(offsets) > epsilon or propertySpring.Codec.Measure(velocities) > epsilon then
					completed = false
				end
			end

			applyCurrent()

			if completed then
				stopConnection()
				setFinishValues()
				if done then
					done()
				end

				completedEvent:Fire(Enum.PlaybackState.Completed)
			end
		end)

		return self
	end

	function handle:Stop(finish: boolean?): SpringTween
		local wasPlaying = playing
		stopConnection()

		if finish then
			setFinishValues()
		end

		if wasPlaying then
			completedEvent:Fire(if finish then Enum.PlaybackState.Completed else Enum.PlaybackState.Cancelled)
		end

		return self
	end

	function handle:SetGoals(nextGoals: SpringGoals): SpringTween
		for propertyName, goalValue in nextGoals do
			local matched = false
			for _, propertySpring in propertySprings do
				if propertySpring.Name == propertyName then
					local currentValue = propertySpring.Codec.Decode(readSpringValues(propertySpring))
					assertSameType(propertyName, currentValue, goalValue)

					local nextGoal = propertySpring.Codec.Encode(goalValue)
					propertySpring.Start = readSpringValues(propertySpring)
					propertySpring.Goal = nextGoal
					for index, spring in propertySpring.Springs do
						spring:SetTarget(nextGoal[index])
					end

					matched = true
					break
				end
			end

			if not matched then
				table.insert(propertySprings, makePropertySpring(target, propertyName, goalValue, damping, frequency))
			end
		end

		return self
	end

	function handle:SetInfo(nextInfo: SpringInfo): SpringTween
		damping = nextInfo.Damping or damping
		frequency = nextInfo.Frequency or frequency
		epsilon = nextInfo.Epsilon or epsilon
		clock = nextInfo.Clock or clock
		step = nextInfo.Step or step
		done = nextInfo.Done or done

		for _, propertySpring in propertySprings do
			for _, spring in propertySpring.Springs do
				spring.Damping = damping
				spring.Frequency = frequency
			end
		end

		return self
	end

	function handle:GetCurrentValues(): SpringGoals
		return getCurrentValues()
	end

	function handle:Destroy(): SpringTween
		destroyed = true
		stopConnection()
		completedEvent:Destroy()
		return self
	end

	return handle :: SpringTween
end

return SpringWrapper
