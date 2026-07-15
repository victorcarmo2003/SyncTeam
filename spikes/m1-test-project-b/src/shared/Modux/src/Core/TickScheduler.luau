--!strict
local RunService = game:GetService("RunService")
local SchedulerErrorReporter = require(script.Parent.SchedulerErrorReporter)

local TickScheduler = {}
local MAX_CATCH_UP = 3
local registrations = {}
local heartbeat: RBXScriptConnection? = nil

local function sortRegistrations()
	table.sort(registrations, function(a, b)
		return a.Priority < b.Priority
	end)
end

local function step(deltaTime: number)
	for _, registration in registrations do
		registration.Accumulator += deltaTime
		local interval = 1 / registration.Rate
		local due = math.floor(registration.Accumulator / interval)
		if due > 0 then
			local runs = math.min(due, MAX_CATCH_UP)
			registration.Accumulator -= due * interval
			for _ = 1, runs do
				local ok, err = xpcall(registration.Callback, debug.traceback, registration.Object, interval)
				if not ok then
					SchedulerErrorReporter.Report(registration.ErrorState, err)
				else
					SchedulerErrorReporter.Recover(registration.ErrorState)
				end
			end
		end
	end
end

function TickScheduler.Register(object: any, tick: any): () -> ()
	local registration = {
		Object = object,
		Callback = tick.Callback,
		Rate = tick.Rate,
		Priority = tick.Priority or 2000,
		Accumulator = 0,
		ErrorState = SchedulerErrorReporter.New(
			"OnTick",
			object,
			`rate={tick.Rate}Hz, priority={tick.Priority or 2000}`
		),
	}
	table.insert(registrations, registration)
	sortRegistrations()
	if heartbeat == nil then
		heartbeat = RunService.Heartbeat:Connect(step)
	end

	return function()
		local index = table.find(registrations, registration)
		if index then
			table.remove(registrations, index)
		end
	end
end

function TickScheduler.Stop()
	if heartbeat then
		heartbeat:Disconnect()
		heartbeat = nil
	end
	table.clear(registrations)
end

return TickScheduler
