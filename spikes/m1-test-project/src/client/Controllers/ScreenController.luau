local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Modux = require(ReplicatedStorage.Shared.Modux)
local Types = require(ReplicatedStorage.Shared.Modux.Types)

type MainGui = Types.ScreenGuiRoot
type WindowId = Types.UIWindowId

local WINDOW_TAG = "ModuxUI.Window"
local OPEN_BUTTON_TAG = "ModuxUI.OpenButton"
local CLOSE_BUTTON_TAG = "ModuxUI.CloseButton"
local WINDOW_ID_ATTRIBUTE = "WindowId"

local ScreenController = Modux.Controller("ScreenController"):Import("UIAnimationsController")

ScreenController.Gui = nil :: MainGui
ScreenController.Windows = {} :: { [WindowId]: GuiObject }
ScreenController.CurrentWindow = nil :: WindowId?
ScreenController.BoundButtons = {} :: { [Instance]: boolean }
ScreenController.ButtonConnections = {} :: { [Instance]: RBXScriptConnection }
ScreenController.OnOpenCallbacks = {} :: { [WindowId]: { (window: GuiObject) -> () } }
ScreenController.OnCloseCallbacks = {} :: { [WindowId]: { (window: GuiObject) -> () } }

ScreenController.GetGui = function(self): MainGui
	assert(self.Gui, "[ScreenController] ScreenGui ainda nao foi carregada.")
	return self.Gui :: MainGui
end

ScreenController.GetWindowId = function(self, window: GuiObject): WindowId
	local configuredId = window:GetAttribute(WINDOW_ID_ATTRIBUTE)
	if typeof(configuredId) == "string" and configuredId ~= "" then
		return configuredId :: WindowId
	end

	return window.Name :: WindowId
end

ScreenController.IsInsideGui = function(self, instance: Instance): boolean
	local gui = self.Gui
	return gui == nil or instance == gui or instance:IsDescendantOf(gui)
end

ScreenController.RegisterWindow = function(self, window: GuiObject, id: WindowId?): GuiObject
	local windowId = id or self:GetWindowId(window)

	self.Windows[windowId] = window
	window.Visible = false
	self.UIAnimationsController:EnsureScale(window)

	return window
end

ScreenController.TryRegisterWindow = function(self, instance: Instance)
	if not self:IsInsideGui(instance) then
		return
	end

	if not instance:IsA("GuiObject") then
		warn(`[ScreenController] "{instance:GetFullName()}" usa {WINDOW_TAG}, mas nao e GuiObject.`)
		return
	end

	self:RegisterWindow(instance :: GuiObject, nil)
	return
end

ScreenController.RegisterTaggedWindows = function(self)
	for _, instance in CollectionService:GetTagged(WINDOW_TAG) do
		self:TryRegisterWindow(instance)
	end

	local connection = CollectionService:GetInstanceAddedSignal(WINDOW_TAG):Connect(function(instance)
		self:TryRegisterWindow(instance)
	end)
	self:Cleanup(connection)
end

ScreenController.OnOpen = function(self, id: WindowId, callback: (window: GuiObject) -> ())
	if not self.OnOpenCallbacks[id] then
		self.OnOpenCallbacks[id] = {}
	end

	table.insert(self.OnOpenCallbacks[id], callback)
end

ScreenController.OnClose = function(self, id: WindowId, callback: (window: GuiObject) -> ())
	if not self.OnCloseCallbacks[id] then
		self.OnCloseCallbacks[id] = {}
	end

	table.insert(self.OnCloseCallbacks[id], callback)
end

ScreenController.GetWindow = function(self, id: WindowId): GuiObject?
	return self.Windows[id]
end

ScreenController.GetCurrentWindow = function(self): WindowId?
	return self.CurrentWindow
end

ScreenController.FireWindowCallbacks = function(
	self,
	callbacks: { [WindowId]: { (window: GuiObject) -> () } },
	id: WindowId,
	window: GuiObject
)
	local list = callbacks[id]
	if not list then
		return
	end

	for _, callback in list do
		local ok, err = xpcall(callback, debug.traceback, window)
		if not ok then
			warn(`[ScreenController] Window callback failed for "{id}": {err}`)
		end
	end
end

ScreenController.CloseWindow = function(self)
	local currentId = self.CurrentWindow
	if not currentId then
		return
	end

	local window = self.Windows[currentId]
	self.CurrentWindow = nil :: WindowId?

	if not window then
		return
	end

	self:FireWindowCallbacks(self.OnCloseCallbacks, currentId, window)
	self.UIAnimationsController:Close(window, nil)
	return
end

ScreenController.OpenWindow = function(self, id: WindowId)
	local target = self.Windows[id]
	if not target then
		warn(
			`[ScreenController] Janela nao encontrada: "{id}". Marque a janela com {WINDOW_TAG} ou registre manualmente.`
		)
		return
	end

	if self.CurrentWindow == id and target.Visible then
		self:CloseWindow()
		return
	end

	if self.CurrentWindow and self.CurrentWindow ~= id then
		self:CloseWindow()
	end

	self.CurrentWindow = id
	self.UIAnimationsController:Open(target)
	self:FireWindowCallbacks(self.OnOpenCallbacks, id, target)
	return
end

ScreenController.BindButton = function(self, button: GuiButton, id: WindowId): RBXScriptConnection
	local existingConnection = self.ButtonConnections[button]
	if existingConnection then
		return existingConnection
	end

	self.BoundButtons[button] = true
	local connection = button.Activated:Connect(function()
		self:OpenWindow(id)
	end)
	self.ButtonConnections[button] = connection
	self:Cleanup(connection)

	return connection
end

ScreenController.TryBindOpenButton = function(self, instance: Instance)
	if not self:IsInsideGui(instance) or self.BoundButtons[instance] then
		return
	end

	if not instance:IsA("GuiButton") then
		warn(`[ScreenController] "{instance:GetFullName()}" usa {OPEN_BUTTON_TAG}, mas nao e GuiButton.`)
		return
	end

	local target = instance:GetAttribute(WINDOW_ID_ATTRIBUTE)
	if typeof(target) ~= "string" or target == "" then
		warn(
			`[ScreenController] "{instance:GetFullName()}" precisa do attribute {WINDOW_ID_ATTRIBUTE} para abrir uma janela.`
		)
		return
	end

	self:BindButton(instance :: GuiButton, target :: WindowId)
	return
end

ScreenController.TryBindCloseButton = function(self, instance: Instance)
	if not self:IsInsideGui(instance) or self.BoundButtons[instance] then
		return
	end

	if not instance:IsA("GuiButton") then
		warn(`[ScreenController] "{instance:GetFullName()}" usa {CLOSE_BUTTON_TAG}, mas nao e GuiButton.`)
		return
	end

	self.BoundButtons[instance] = true

	local connection = (instance :: GuiButton).Activated:Connect(function()
		self:CloseWindow()
	end)
	self.ButtonConnections[instance] = connection
	self:Cleanup(connection)
	return
end

ScreenController.BindTaggedButtons = function(self)
	for _, instance in CollectionService:GetTagged(OPEN_BUTTON_TAG) do
		self:TryBindOpenButton(instance)
	end

	for _, instance in CollectionService:GetTagged(CLOSE_BUTTON_TAG) do
		self:TryBindCloseButton(instance)
	end

	local openConnection = CollectionService:GetInstanceAddedSignal(OPEN_BUTTON_TAG):Connect(function(instance)
		self:TryBindOpenButton(instance)
	end)
	self:Cleanup(openConnection)

	local closeConnection = CollectionService:GetInstanceAddedSignal(CLOSE_BUTTON_TAG):Connect(function(instance)
		self:TryBindCloseButton(instance)
	end)
	self:Cleanup(closeConnection)
end

ScreenController:OnInit(function(self)
	local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui") :: PlayerGui
	self.Gui = playerGui:WaitForChild("ScreenGui") :: MainGui
end)

ScreenController:OnStart(function(self)
	self:RegisterTaggedWindows()
	self:BindTaggedButtons()
end)

ScreenController:OnDestroy(function(self)
	for instance, connection in self.ButtonConnections do
		connection:Disconnect()
		self.ButtonConnections[instance] = nil
		self.BoundButtons[instance] = nil
	end

	table.clear(self.Windows)
	table.clear(self.OnOpenCallbacks)
	table.clear(self.OnCloseCallbacks)
	self.CurrentWindow = nil :: WindowId?
	self.Gui = nil :: MainGui?
end)

return ScreenController
