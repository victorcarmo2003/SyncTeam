--!strict

export type Disconnect = () -> ()
export type TransitionCallback<State> = (previousState: State, nextState: State) -> ()
export type StateCallback<State> = (state: State, otherState: State) -> ()
export type Transitions<State> = { [State]: { State } }

export type FSM<State> = {
	State: State,

	GetState: (self: FSM<State>) -> State,
	Is: (self: FSM<State>, state: State) -> boolean,
	CanTransition: (self: FSM<State>, nextState: State) -> boolean,
	Transition: (self: FSM<State>, nextState: State) -> boolean,
	OnEnter: (self: FSM<State>, state: State, callback: StateCallback<State>) -> Disconnect,
	OnLeave: (self: FSM<State>, state: State, callback: StateCallback<State>) -> Disconnect,
	OnTransition: (self: FSM<State>, callback: TransitionCallback<State>) -> Disconnect,
	Destroy: (self: FSM<State>) -> (),

	_transitions: Transitions<State>?,
	_enterListeners: { [State]: { StateCallback<State> } },
	_leaveListeners: { [State]: { StateCallback<State> } },
	_transitionListeners: { TransitionCallback<State> },
	_destroyed: boolean,
}

local FSM = {}
FSM.__index = FSM

local function disconnectListener<T>(listeners: { T }, callback: T)
	local index = table.find(listeners, callback)
	if index then
		table.remove(listeners, index)
	end
end

local function addStateListener<State>(
	listeners: { [State]: { StateCallback<State> } },
	state: State,
	callback: StateCallback<State>
): Disconnect
	local stateListeners = listeners[state]
	if not stateListeners then
		stateListeners = {}
		listeners[state] = stateListeners
	end

	table.insert(stateListeners, callback)

	return function()
		disconnectListener(stateListeners, callback)
	end
end

local function fireListeners<T>(listeners: { T }, callback: (listener: T) -> ())
	for _, listener in table.clone(listeners) do
		callback(listener)
	end
end

function FSM.new<State>(initialState: State, transitions: Transitions<State>?): FSM<State>
	assert(initialState ~= nil, "[FSM] Initial state cannot be nil")

	return setmetatable({
		State = initialState,
		_transitions = transitions,
		_enterListeners = {},
		_leaveListeners = {},
		_transitionListeners = {},
		_destroyed = false,
	}, FSM) :: any
end

function FSM.GetState<State>(self: FSM<State>): State
	return self.State
end

function FSM.Is<State>(self: FSM<State>, state: State): boolean
	return self.State == state
end

function FSM.CanTransition<State>(self: FSM<State>, nextState: State): boolean
	if self._destroyed or self.State == nextState then
		return false
	end

	if not self._transitions then
		return true
	end

	local allowedStates = self._transitions[self.State]
	return allowedStates ~= nil and table.find(allowedStates, nextState) ~= nil
end

function FSM.Transition<State>(self: FSM<State>, nextState: State): boolean
	if not self:CanTransition(nextState) then
		return false
	end

	local previousState = self.State
	self.State = nextState

	local leaveListeners = self._leaveListeners[previousState]
	if leaveListeners then
		fireListeners(leaveListeners, function(listener)
			listener(previousState, nextState)
		end)
	end

	local enterListeners = self._enterListeners[nextState]
	if enterListeners then
		fireListeners(enterListeners, function(listener)
			listener(nextState, previousState)
		end)
	end

	fireListeners(self._transitionListeners, function(listener)
		listener(previousState, nextState)
	end)

	return true
end

function FSM.OnEnter<State>(self: FSM<State>, state: State, callback: StateCallback<State>): Disconnect
	assert(not self._destroyed, "[FSM] Cannot add a listener to a destroyed FSM")
	return addStateListener(self._enterListeners, state, callback)
end

function FSM.OnLeave<State>(self: FSM<State>, state: State, callback: StateCallback<State>): Disconnect
	assert(not self._destroyed, "[FSM] Cannot add a listener to a destroyed FSM")
	return addStateListener(self._leaveListeners, state, callback)
end

function FSM.OnTransition<State>(self: FSM<State>, callback: TransitionCallback<State>): Disconnect
	assert(not self._destroyed, "[FSM] Cannot add a listener to a destroyed FSM")
	table.insert(self._transitionListeners, callback)

	return function()
		disconnectListener(self._transitionListeners, callback)
	end
end

function FSM.Destroy<State>(self: FSM<State>)
	if self._destroyed then
		return
	end

	self._destroyed = true
	table.clear(self._enterListeners)
	table.clear(self._leaveListeners)
	table.clear(self._transitionListeners)
end

return FSM
