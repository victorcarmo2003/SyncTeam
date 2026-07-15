--!strict
local CollectionService = game:GetService("CollectionService")
local Container = require(script.Parent.Parent.Core.Container)
local Composition = require(script.Parent.Parent.Core.Composition)
local Lifecycle = require(script.Parent.Parent.Core.Lifecycle)
local TickScheduler = require(script.Parent.Parent.Core.TickScheduler)
local SimulationScheduler = require(script.Parent.Parent.Core.SimulationScheduler)
local Registry = require(script.Parent.ComponentRegistry)

local ComponentManager = {}
local connections = {}
local destroying: { [Instance]: { [string]: boolean } } = {}

local function requiresComponent(template: any, id: string): boolean
	for _, requiredId in template._requiredComponents or {} do
		if requiredId == id then
			return true
		end
	end
	return false
end

local function hasRequiredComponents(template: any, instance: Instance): boolean
	for _, requiredId in template._requiredComponents or {} do
		if not Registry.Get(instance, requiredId) then
			return false
		end
	end
	return true
end

local function createTaggedComponents(instance: Instance)
	for id, registered in Container._all do
		if registered.Type ~= "Component" then
			continue
		end

		local template = registered.Object
		if template._tag and CollectionService:HasTag(instance, template._tag) then
			ComponentManager.Create(id, instance)
		end
	end
end

local function markDestroying(instance: Instance, id: string): boolean
	destroying[instance] = destroying[instance] or {}
	if destroying[instance][id] then
		return false
	end
	destroying[instance][id] = true
	return true
end

local function unmarkDestroying(instance: Instance, id: string)
	local byId = destroying[instance]
	if not byId then
		return
	end

	byId[id] = nil
	if next(byId) == nil then
		destroying[instance] = nil
	end
end

function ComponentManager.Start()
	for id, registered in Container._all do
		if registered.Type ~= "Component" then
			continue
		end
		local template = registered.Object
		if not template._tag then
			continue
		end

		table.insert(connections, CollectionService:GetInstanceAddedSignal(template._tag):Connect(function(instance)
			ComponentManager.Create(id, instance)
		end))
		table.insert(connections, CollectionService:GetInstanceRemovedSignal(template._tag):Connect(function(instance)
			ComponentManager.Destroy(id, instance)
		end))
		for _, instance in CollectionService:GetTagged(template._tag) do
			task.spawn(ComponentManager.Create, id, instance)
		end
	end
end

function ComponentManager.Create(id: string, instance: Instance)
	local registered = Container.Get(id)
	if not registered or registered.Type ~= "Component" then
		return
	end

	local template = registered.Object
	if template._className and not instance:IsA(template._className) then
		return
	end
	for _, childName in template._requiredChildren or {} do
		if not instance:FindFirstChild(childName) then
			return
		end
	end
	if not hasRequiredComponents(template, instance) then
		return
	end
	if Registry.Get(instance, id) then
		return
	end

	local component = Container.Resolve(nil, id)
	component.Instance = instance
	if component._attachClientPlayerReferences then
		component:_attachClientPlayerReferences()
	end
	Registry.Add(instance, id, component)
	Composition.ResolveImports(component)

	if template._attributeSchema then
		component.Attributes = {}
		for attributeName, defaultValue in template._attributeSchema do
			local currentValue = instance:GetAttribute(attributeName)
			component.Attributes[attributeName] = if currentValue ~= nil then currentValue else defaultValue
			component:Cleanup(instance:GetAttributeChangedSignal(attributeName):Connect(function()
				component.Attributes[attributeName] = instance:GetAttribute(attributeName)
			end))
		end
	end

	Lifecycle.Run(component, "_onInit")
	Lifecycle.Run(component, "_onStart")
	for _, tick in component._onTick or {} do
		component:Cleanup(TickScheduler.Register(component, tick))
	end
	for _, simulation in component._onSimulation or {} do
		component:Cleanup(SimulationScheduler.Register(component, simulation))
	end

	createTaggedComponents(instance)
end

function ComponentManager.Destroy(id: string, instance: Instance)
	local component = Registry.Get(instance, id)
	if not component then
		return
	end
	if not markDestroying(instance, id) then
		return
	end

	for dependentId, registered in Container._all do
		if registered.Type ~= "Component" or dependentId == id then
			continue
		end
		if requiresComponent(registered.Object, id) then
			ComponentManager.Destroy(dependentId, instance)
		end
	end

	Lifecycle.Run(component, "_onDestroy")
	if component._doCleanup then
		component:_doCleanup()
	end
	Registry.Remove(instance, id)
	unmarkDestroying(instance, id)
end

function ComponentManager.Stop()
	for _, connection in connections do
		connection:Disconnect()
	end
	table.clear(connections)
	table.clear(destroying)
	for _, entry in Registry.Snapshot() do
		ComponentManager.Destroy(entry.id, entry.instance)
	end
	Registry.Clear()
end

return ComponentManager
