local ContextActionService = game:GetService("ContextActionService")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

export type Context = "Gameplay" | "Menu" | "Cutscene"

export type HandlerType = {
	OnPress: (() -> ()) -> (),
	OnRelease: (() -> ()) -> (),
	_onPressCallbacks: { [number]: () -> () },
	_onReleaseCallbacks: { [number]: () -> () },
}

local InputController = Modux.Controller("InputController")
InputController.allHandlers = {} :: { [string]: HandlerType }

local function processInput(ActionName: string, InputState: Enum.UserInputState, inputObject: InputObject)
	for name, data in InputController.allHandlers do
		if ActionName ~= name then
			continue
		end

		if InputState == Enum.UserInputState.Begin and data._onPressCallbacks then
			for _, func in data._onPressCallbacks do
				func()
			end
		end

		if InputState == Enum.UserInputState.End and data._onReleaseCallbacks then
			for _, func in data._onReleaseCallbacks do
				func()
			end
		end

		return Enum.ContextActionResult.Sink
	end

	warn(`[InputController - ProcessInput] Error {ActionName} not founded in registered!`, InputController.allHandlers)
	return Enum.ContextActionResult.Pass
end

InputController.UnbindAction = function(self, ActionName: string)
	ContextActionService:UnbindAction(ActionName)
end

InputController.BindAction = function(
	self,
	ActionName: string,
	ActionKey: Enum.KeyCode | Enum.UserInputType,
	TouchButton: boolean?,
	ActionPriority: number?,
	Context: Context?
): HandlerType
	local handler = {
		_onPressCallbacks = {},
		_onReleaseCallbacks = {},
	} :: any

	handler.OnPress = function(callback: () -> ())
		table.insert(handler._onPressCallbacks, callback)
	end

	handler.OnRelease = function(callback: () -> ())
		table.insert(handler._onReleaseCallbacks, callback)
	end

	InputController.allHandlers[ActionName] = handler

	ContextActionService:BindActionAtPriority(
		ActionName,
		processInput,
		TouchButton or false,
		ActionPriority or 0,
		ActionKey
	)

	return handler :: HandlerType
end

InputController.ChangeContext = function(self, newContext: Context)
	self.Context = newContext
end

InputController:OnInit(function(self)
	self.Context = "Gameplay" :: Context
end)

return InputController
