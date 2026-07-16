--!strict
local SchedulerErrorReporter = {}

local ERROR_THROTTLE_SECONDS = 5

export type ErrorState = {
	Kind: string,
	Object: any,
	Details: string,
	ConsecutiveFailures: number,
	SuppressedFailures: number,
	LastError: string?,
	LastWarnAt: number,
}

function SchedulerErrorReporter.New(kind: string, object: any, details: string): ErrorState
	return {
		Kind = kind,
		Object = object,
		Details = details,
		ConsecutiveFailures = 0,
		SuppressedFailures = 0,
		LastError = nil,
		LastWarnAt = 0,
	}
end

local function getObjectID(state: ErrorState): string
	if state.Object and state.Object.ID then
		return tostring(state.Object.ID)
	end

	return "<unknown>"
end

function SchedulerErrorReporter.Report(state: ErrorState, err: any)
	local message = tostring(err)
	local now = os.clock()
	state.ConsecutiveFailures += 1

	if state.LastError == message and now - state.LastWarnAt < ERROR_THROTTLE_SECONDS then
		state.SuppressedFailures += 1
		return
	end

	local suppressed = state.SuppressedFailures
	state.LastError = message
	state.LastWarnAt = now
	state.SuppressedFailures = 0

	local suffix = if suppressed > 0 then `; suppressed={suppressed}` else ""
	warn(
		`[Modux] {state.Kind} callback failed for "{getObjectID(state)}" ({state.Details}; consecutiveFailures={state.ConsecutiveFailures}{suffix}). Callback remains registered and will retry.\n{message}`
	)
end

function SchedulerErrorReporter.Recover(state: ErrorState)
	if state.ConsecutiveFailures == 0 then
		return
	end

	local suffix = if state.SuppressedFailures > 0 then `; suppressed={state.SuppressedFailures}` else ""
	warn(
		`[Modux] {state.Kind} callback recovered for "{getObjectID(state)}" after {state.ConsecutiveFailures} failure(s){suffix}.`
	)

	state.ConsecutiveFailures = 0
	state.SuppressedFailures = 0
	state.LastError = nil
	state.LastWarnAt = 0
end

return SchedulerErrorReporter
