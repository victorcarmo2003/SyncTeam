--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Registry = require(ReplicatedStorage.Shared.Modux.src.Components.ComponentRegistry)
local Constructor = {}
Constructor.__index = Constructor
Constructor._imports = {}
Constructor._mixins = {}
Constructor._onInit = {}
Constructor._onStart = {}
Constructor._onTick = {}
Constructor._onSimulation = {}
Constructor._onDestroy = {}
Constructor._tag = nil
Constructor._className = nil
Constructor._attributeSchema = nil
Constructor._requiredChildren = nil
Constructor._requiredComponents = nil
Constructor._cleanupTasks = {}

export type Type = "Service" | "Controller" | "Component" | "Mixin"

export type Constructor = typeof(setmetatable({}, Constructor))

function Constructor:OnInit(cb: (self: any) -> ())
	table.insert(self._onInit, cb)
	return self
end

function Constructor:OnStart(cb: (self: any) -> ())
	table.insert(self._onStart, cb)
	return self
end

function Constructor:OnTick(cb: (self: any, deltaTime: number) -> (), rate: number, priority: number?)
	assert(type(rate) == "number" and rate > 0, "[Modux] OnTick rate must be greater than zero.")
	table.insert(self._onTick, {
		Callback = cb,
		Rate = rate,
		Priority = priority,
	})
	return self
end

function Constructor:OnSimulation(
	cb: (self: any, deltaTime: number) -> (),
	frequency: Enum.StepFrequency?,
	priority: number?
)
	table.insert(self._onSimulation, {
		Callback = cb,
		Frequency = frequency,
		Priority = priority,
	})
	return self
end

function Constructor:OnDestroy(cb: (self: any) -> ())
	table.insert(self._onDestroy, cb)
	return self
end

function Constructor:Tag(tag: string)
	self._tag = tag
	return self
end

function Constructor:ClassName(className: string)
	self._className = className
	return self
end

function Constructor:AttributeDefaults(schema: { [string]: any })
	self._attributeSchema = schema
	return self
end

function Constructor:Children(children: { string })
	self._requiredChildren = children
	return self
end

function Constructor:RequireComponent(id: string)
	self._requiredComponents = self._requiredComponents or {}
	if not table.find(self._requiredComponents, id) then
		table.insert(self._requiredComponents, id)
	end
	return self
end

-- Retorna todos os componentes ativos de um determinado ID (ex: "Zombie")
function Constructor:GetAllComponents(id: string)
	return Registry.GetAll(id)
end

-- Retorna o componente específico de uma instância
function Constructor:GetComponent(instance: Instance, id: string)
	return Registry.Get(instance, id)
end

function Constructor:GetRequiredComponent(instance: Instance, id: string)
	local component = Registry.Get(instance, id)
	assert(component, `[Modux] Required component "{id}" is not active on {instance:GetFullName()}.`)
	return component
end

function Constructor:Cleanup(task: any)
	table.insert(self._cleanupTasks, task)
	return task
end

function Constructor:_doCleanup()
	for _, task in self._cleanupTasks do
		if typeof(task) == "RBXScriptConnection" then
			task:Disconnect()
		elseif typeof(task) == "Instance" then
			task:Destroy()
		elseif typeof(task) == "function" then
			task()
		elseif typeof(task) == "table" then
			if typeof(task.Destroy) == "function" then
				task:Destroy()
			elseif typeof(task.Disconnect) == "function" then
				task:Disconnect()
			elseif typeof(task.cancel) == "function" then
				task:cancel()
			end
		end
	end
	table.clear(self._cleanupTasks)
end

function Constructor:_attachClientPlayerReferences()
	if not RunService:IsClient() or (self.Type ~= "Controller" and self.Type ~= "Component") then
		return
	end

	local localPlayer = Players.LocalPlayer
	self.LocalPlayer = localPlayer

	local function setCharacter(character: Model?)
		if self._localHumanoidConnection then
			self._localHumanoidConnection:Disconnect()
		end

		self.LocalCharacter = character
		self.LocalHumanoid = nil :: Humanoid?

		if not character then
			return
		end

		self.LocalHumanoid = character:FindFirstChildOfClass("Humanoid")
		self._localHumanoidConnection = self:Cleanup(character.ChildAdded:Connect(function(child)
			if child:IsA("Humanoid") then
				self.LocalHumanoid = child
			end
		end))
	end

	setCharacter(localPlayer.Character)

	if self._localCharacterConnection then
		self._localCharacterConnection:Disconnect()
	end
	if self._localCharacterRemovingConnection then
		self._localCharacterRemovingConnection:Disconnect()
	end

	self._localCharacterConnection = self:Cleanup(localPlayer.CharacterAdded:Connect(function(character)
		setCharacter(character)
	end))
	self._localCharacterRemovingConnection = self:Cleanup(localPlayer.CharacterRemoving:Connect(function(character)
		if self.LocalCharacter == character then
			setCharacter(nil)
		end
	end))
end

function Constructor.New(ID: string, Type: Type)
	local SRC = ReplicatedStorage.Shared.Modux.src
	local Network = require(SRC.Network)
	local Promise = require(SRC.Promise)
	local Signal = require(SRC.Signal)
	local GlobalClock = require(script.Parent.GlobalClock)
	local Import = require(script.Parent.Import)
	local Extend = require(script.Parent.Extend)
	local tools = require(script.Parent.Parent.Tools)

	local self = setmetatable({}, Constructor)
	self.ID = ID
	self.Type = Type
	self.Import = Import
	self.Extend = Extend
	self.Network = Network
	self.Promise = Promise
	self.Signal = Signal
	self.GlobalClock = GlobalClock
	self.Attributes = {}
	self.Tools = tools
	self._imports = {}
	self._mixins = {}
	self._onInit = {}
	self._onStart = {}
	self._onTick = {}
	self._onSimulation = {}
	self._onDestroy = {}
	self._tag = nil
	self._className = nil
	self._attributeSchema = nil
	self._requiredChildren = nil
	self._requiredComponents = nil
	self._cleanupTasks = {}
	self._composed = false
	if Type == "Controller" then
		self:_attachClientPlayerReferences()
	end
	return self
end

return Constructor
