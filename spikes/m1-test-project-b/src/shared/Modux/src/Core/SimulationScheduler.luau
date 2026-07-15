--!strict
local RunService = game:GetService("RunService")
local SchedulerErrorReporter = require(script.Parent.SchedulerErrorReporter)

local SimulationScheduler = {}
local registrations = {}

function SimulationScheduler.Register(object: any, simulation: any): () -> ()
	local frequency = simulation.Frequency or Enum.StepFrequency.Hz30
	local priority = simulation.Priority or 2000
	local errorState = SchedulerErrorReporter.New(
		"OnSimulation",
		object,
		`frequency={tostring(frequency)}, priority={priority}`
	)

	local connection = RunService:BindToSimulation(function(deltaTime)
		local ok, err = xpcall(simulation.Callback, debug.traceback, object, deltaTime)
		if not ok then
			SchedulerErrorReporter.Report(errorState, err)
		else
			SchedulerErrorReporter.Recover(errorState)
		end
	end, frequency, priority)

	local registration = {
		Connection = connection,
	}
	table.insert(registrations, registration)
	return function()
		local index = table.find(registrations, registration)
		if index then
			table.remove(registrations, index)
		end
		registration.Connection:Disconnect()
	end
end

function SimulationScheduler.Stop()
	for _, registration in registrations do
		registration.Connection:Disconnect()
	end
	table.clear(registrations)
end

return SimulationScheduler
