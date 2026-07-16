--!strict
local Container = require(script.Parent.Container)

local Composition = {}

local SKIP_FIELDS = {
	ID = true,
	Type = true,
	Import = true,
	Extend = true,
	Network = true,
	Promise = true,
	GlobalClock = true,
	Signal = true,
	Attributes = true,
}

local function appendAll(target: { any }, source: { any }?)
	for _, value in source or {} do
		table.insert(target, value)
	end
end

local function flattenMixins(id: string, output: { any }, visiting: { [string]: boolean })
	if visiting[id] then
		error(`[Modux] Cyclic mixin Extend detected at "{id}".`)
	end

	local registered = Container.Get(id)
	if not registered then
		error(`[Modux] Unknown mixin "{id}".`)
	end
	if registered.Type ~= "Mixin" then
		error(`[Modux] "{id}" is a {registered.Type}, not a Mixin. Use :Import("{id}") for shared dependencies.`)
	end

	visiting[id] = true
	for _, nestedId in registered.Object._mixins or {} do
		flattenMixins(nestedId, output, visiting)
	end
	visiting[id] = nil
	table.insert(output, registered.Object)
end

function Composition.Compose(object: any)
	if object._composed then
		return
	end

	local ownFields = {}
	for key in object do
		ownFields[key] = true
	end

	local ownImports = table.clone(object._imports or {})
	local ownInit = table.clone(object._onInit or {})
	local ownStart = table.clone(object._onStart or {})
	local ownTick = table.clone(object._onTick or {})
	local ownSimulation = table.clone(object._onSimulation or {})
	local ownDestroy = table.clone(object._onDestroy or {})
	local flattened = {}
	for _, id in object._mixins or {} do
		flattenMixins(id, flattened, {})
	end

	local mixedFields = {}
	object._imports = {}
	object._onInit = {}
	object._onStart = {}
	object._onTick = {}
	object._onSimulation = {}
	object._onDestroy = {}

	for _, mixin in flattened do
		for key, value in mixin do
			if type(key) == "string" and string.sub(key, 1, 1) ~= "_" and not SKIP_FIELDS[key] and not ownFields[key] then
				if mixedFields[key] then
					warn(`[Modux] Mixin field conflict for "{object.ID}.{key}". The last :Extend() wins.`)
				end
				object[key] = Container.CloneValue(value)
				mixedFields[key] = true
			end
		end
		appendAll(object._imports, mixin._imports)
		appendAll(object._onInit, mixin._onInit)
		appendAll(object._onStart, mixin._onStart)
		appendAll(object._onTick, mixin._onTick)
		appendAll(object._onSimulation, mixin._onSimulation)
		appendAll(object._onDestroy, mixin._onDestroy)
	end

	appendAll(object._imports, ownImports)
	appendAll(object._onInit, ownInit)
	appendAll(object._onStart, ownStart)
	appendAll(object._onTick, ownTick)
	appendAll(object._onSimulation, ownSimulation)
	appendAll(object._onDestroy, ownDestroy)
	object._composed = true
end

function Composition.ValidateMixins()
	for _, registered in Container._all do
		if registered.Type == "Mixin" then
			flattenMixins(registered.Object.ID, {}, {})
		end
	end
end

function Composition.ResolveImports(object: any)
	for _, dependency in object._imports or {} do
		object[dependency.id] = Container.Resolve(object, dependency.id, dependency.scopeKey)
	end
end

return Composition
