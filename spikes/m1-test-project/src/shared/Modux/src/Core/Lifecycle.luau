--!strict
local Promise = require(script.Parent.Parent.Promise)

local Lifecycle = {}
Lifecycle.Timeout = 30

local function trace(message: any): string
	return debug.traceback(tostring(message), 2)
end

local function runCallback(object: any, phase: string, callback: (self: any) -> any)
	local finished = false
	local event = Instance.new("BindableEvent")
	local pendingPromise: any = nil
	local worker: thread

	local function finish()
		if finished then
			return
		end
		finished = true
		event:Fire()
	end

	worker = task.spawn(function()
		local started = os.clock()
		local ok, result = xpcall(callback, trace, object)
		if ok and Promise.is(result) then
			pendingPromise = result
			local resolved, reason = result:timeout(Lifecycle.Timeout, `[Modux] {object.ID}:{phase} timed out.`):await()
			if not resolved then
				warn(`[Modux] {object.ID}:{phase} rejected: {reason}`)
			end
		elseif not ok then
			warn(`[Modux] {object.ID}:{phase} failed: {result}`)
		end

		local duration = os.clock() - started
		if duration > 0.05 then
			print(`[Modux Profiler] {object.ID}:{phase} took {string.format("%.4f", duration)}s`)
		end
		finish()
	end)

	task.delay(Lifecycle.Timeout, function()
		if finished then
			return
		end
		if pendingPromise and Promise.is(pendingPromise) then
			pendingPromise:cancel()
		end
		if coroutine.status(worker) ~= "dead" then
			task.cancel(worker)
		end
		warn(`[Modux] {object.ID}:{phase} exceeded {Lifecycle.Timeout}s and was cancelled.`)
		finish()
	end)

	if not finished then
		event.Event:Wait()
	end
	event:Destroy()
end

function Lifecycle.Run(object: any, phase: "_onInit" | "_onStart" | "_onDestroy")
	for _, callback in object[phase] or {} do
		runCallback(object, phase, callback)
	end
end

function Lifecycle.RunLayer(objects: { any }, phase: "_onInit" | "_onStart")
	local remaining = #objects
	if remaining == 0 then
		return
	end

	local event = Instance.new("BindableEvent")
	for _, object in objects do
		task.spawn(function()
			Lifecycle.Run(object, phase)
			remaining -= 1
			if remaining == 0 then
				event:Fire()
			end
		end)
	end

	if remaining > 0 then
		event.Event:Wait()
	end
	event:Destroy()
end

return Lifecycle
