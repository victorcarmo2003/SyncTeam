--!strict
local RunService = game:GetService("RunService")
local Container = require(script.Parent.Core.Container)
local Composition = require(script.Parent.Core.Composition)
local Lifecycle = require(script.Parent.Core.Lifecycle)
local TickScheduler = require(script.Parent.Core.TickScheduler)
local SimulationScheduler = require(script.Parent.Core.SimulationScheduler)
local ComponentManager = require(script.Parent.Components.ComponentManager)

local Loader = {}
local isLoaded = false
local isLoading = false
local startedSingletons = {}

export type roots = {
	Shared: Instance,
	Server: Instance?,
	Client: Instance?,
}

export type manifest = {
	Shared: { string },
	Server: { string },
	Client: { string },
}

local function requireModule(root: Instance, dottedPath: string)
	local current = root
	for _, segment in string.split(dottedPath, ".") do
		local child = current:FindFirstChild(segment)
		if not child then
			error(`[Modux] Manifest module "{dottedPath}" is missing segment "{segment}" under {current:GetFullName()}.`)
		end
		current = child
	end
	if not current:IsA("ModuleScript") then
		error(`[Modux] Manifest entry "{dottedPath}" does not resolve to a ModuleScript.`)
	end

	local ok, result = pcall(require, current)
	if not ok then
		error(`[Modux Loader Error] {current:GetFullName()}\n{result}`)
	end
end

local function requireManifest(roots: roots, manifest: manifest)
	for _, dottedPath in manifest.Shared or {} do
		requireModule(roots.Shared, dottedPath)
	end

	local sideRoot = if RunService:IsServer() then roots.Server else roots.Client
	local sideEntries = if RunService:IsServer() then manifest.Server else manifest.Client
	if sideRoot then
		for _, dottedPath in sideEntries or {} do
			requireModule(sideRoot, dottedPath)
		end
	end
end

local function requireAllIn(roots: roots)
	warn("[Modux] Manifest.luau is missing. Falling back to broad descendant loading; regenerate types with Modux Tooling.")
	local directories = { roots.Shared }
	local sideRoot = if RunService:IsServer() then roots.Server else roots.Client
	if sideRoot then
		table.insert(directories, sideRoot)
	end

	for _, directory in directories do
		if not directory then
			continue
		end
		for _, descendant in directory:GetDescendants() do
			if descendant:IsA("ModuleScript") then
				local ok, result = pcall(require, descendant)
				if not ok then
					error(`[Modux Loader Error] {descendant:GetFullName()}\n{result}`)
				end
			end
		end
	end
end

local function collectObjects(scopeType: string?): { any }
	local objects = {}
	for _, registered in Container._all do
		if registered.Type ~= "Mixin" and (scopeType == nil or registered.ScopeType == scopeType) then
			table.insert(objects, registered.Object)
		end
	end
	return objects
end

local function validateImportCycles(objects: { any })
	local visited = {}
	local visiting = {}
	local stack = {}

	local function visit(object: any)
		if visited[object.ID] then
			return
		end
		if visiting[object.ID] then
			local start = table.find(stack, object.ID) or 1
			local cycle = {}
			for index = start, #stack do
				table.insert(cycle, stack[index])
			end
			table.insert(cycle, object.ID)
			error(`[Modux] Cyclic Import: {table.concat(cycle, " -> ")}.`)
		end

		visiting[object.ID] = true
		table.insert(stack, object.ID)
		for _, dependency in object._imports or {} do
			local registered = Container.Get(dependency.id)
			if not registered then
				error(`[Modux] "{object.ID}" imports unknown object "{dependency.id}".`)
			end
			if registered.Type == "Mixin" then
				error(`[Modux] "{object.ID}" imports Mixin "{dependency.id}". Use :Extend() for mixins.`)
			end
			visit(registered.Object)
		end
		table.remove(stack)
		visiting[object.ID] = nil
		visited[object.ID] = true
	end

	for _, object in objects do
		visit(object)
	end
end

local function topologicalLayers(singletons: { any }): { { any } }
	local byId = {}
	local dependents = {}
	local remainingDependencies = {}
	for _, object in singletons do
		byId[object.ID] = object
		dependents[object.ID] = {}
		remainingDependencies[object.ID] = 0
	end

	for _, object in singletons do
		for _, dependency in object._imports or {} do
			if byId[dependency.id] then
				remainingDependencies[object.ID] += 1
				table.insert(dependents[dependency.id], object)
			end
		end
	end

	local layers = {}
	local ready = {}
	for _, object in singletons do
		if remainingDependencies[object.ID] == 0 then
			table.insert(ready, object)
		end
	end

	local seen = 0
	while #ready > 0 do
		local layer = ready
		ready = {}
		table.insert(layers, layer)
		for _, dependency in layer do
			seen += 1
			for _, dependent in dependents[dependency.ID] do
				remainingDependencies[dependent.ID] -= 1
				if remainingDependencies[dependent.ID] == 0 then
					table.insert(ready, dependent)
				end
			end
		end
	end

	if seen ~= #singletons then
		error("[Modux] Could not sort lifecycle graph. Check Import cycles.")
	end
	return layers
end

local function registerSchedulers(object: any)
	for _, tick in object._onTick or {} do
		TickScheduler.Register(object, tick)
	end
	for _, simulation in object._onSimulation or {} do
		SimulationScheduler.Register(object, simulation)
	end
end

local function cleanupResources(object: any)
	for _, value in object do
		if type(value) ~= "table" then
			continue
		end
		if type(value.DisconnectAll) == "function" then
			pcall(function()
				value:DisconnectAll()
			end)
		elseif type(value.cancel) == "function" then
			pcall(function()
				value:cancel()
			end)
		end
	end
end

function Loader.Load(roots: roots, manifest: manifest?)
	if isLoaded or isLoading then
		return
	end
	isLoading = true

	local ok, result = xpcall(function()
		if manifest then
			requireManifest(roots, manifest)
		else
			requireAllIn(roots)
		end
		Container.Seal()

		local allObjects = collectObjects()
		Composition.ValidateMixins()
		for _, object in allObjects do
			Composition.Compose(object)
		end
		validateImportCycles(allObjects)

		local singletons = collectObjects("Singleton")
		for _, object in singletons do
			Composition.ResolveImports(object)
		end

		local layers = topologicalLayers(singletons)
		for _, layer in layers do
			Lifecycle.RunLayer(layer, "_onInit")
		end
		for _, layer in layers do
			Lifecycle.RunLayer(layer, "_onStart")
		end
		for _, object in singletons do
			registerSchedulers(object)
		end

		startedSingletons = {}
		for _, layer in layers do
			for _, object in layer do
				table.insert(startedSingletons, object)
			end
		end
		ComponentManager.Start()
		isLoaded = true
	end, debug.traceback)

	isLoading = false
	if not ok then
		Container.Unseal()
		error(result)
	end
end

function Loader.Stop()
	if not isLoaded and not isLoading then
		return
	end

	ComponentManager.Stop()
	TickScheduler.Stop()
	SimulationScheduler.Stop()
	for index = #startedSingletons, 1, -1 do
		local object = startedSingletons[index]
		Lifecycle.Run(object, "_onDestroy")
		if object._doCleanup then
			object:_doCleanup()
		end
		cleanupResources(object)
	end
	table.clear(startedSingletons)
	Container.Unseal()
	isLoaded = false
	isLoading = false
end

return Loader
