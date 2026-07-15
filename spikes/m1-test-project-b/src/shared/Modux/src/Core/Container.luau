--!strict
local Container = {}
Container._all = {} :: { [string]: Registered }
Container._sealed = false

export type Mode = "Singleton" | "Transient"
export type Type = "Service" | "Controller" | "Component" | "Mixin"
export type Registered = {
	Object: any,
	ScopeType: Mode,
	Type: Type,
}

local function cloneValue(value: any, seen: { [any]: any }?): any
	if type(value) ~= "table" or getmetatable(value) ~= nil then
		return value
	end

	local visited = seen or {}
	if visited[value] then
		return visited[value]
	end

	local copy = {}
	visited[value] = copy
	for key, child in value do
		copy[cloneValue(key, visited)] = cloneValue(child, visited)
	end
	return copy
end

function Container.CloneValue(value: any): any
	return cloneValue(value)
end

function Container.Register(id: string, object: any, mode: Mode, objectType: Type)
	if Container._sealed then
		error(`[Modux] Cannot register "{id}" because the container is sealed.`)
	end
	if Container._all[id] then
		error(`[Modux] Object with ID "{id}" is already registered.`)
	end

	Container._all[id] = {
		Object = object,
		ScopeType = mode,
		Type = objectType,
	}
end

function Container.Get(id: string): Registered?
	return Container._all[id]
end

function Container.Resolve(_self: any, id: string, scopeKey: string?)
	local registered = Container._all[id]
	if not registered then
		error(`[Modux] Object with ID "{id}" is not registered.`)
	end
	if registered.Type == "Mixin" then
		error(`[Modux] Mixin "{id}" cannot be resolved directly. Use :Extend("{id}").`)
	end

	if registered.ScopeType == "Transient" then
		local template = registered.Object
		local copy = table.clone(template)
		for key, value in template do
			if type(value) == "table" and getmetatable(value) == nil then
				copy[key] = cloneValue(value)
			end
		end
		copy._cleanupTasks = {}
		copy._localCharacterConnection = nil
		copy._localCharacterRemovingConnection = nil
		copy._localHumanoidConnection = nil
		setmetatable(copy, getmetatable(template))
		return copy
	end

	return registered.Object
end

function Container.Has(id: string): boolean
	return Container._all[id] ~= nil
end

function Container.Seal()
	Container._sealed = true
end

function Container.Unseal()
	Container._sealed = false
end

function Container.Clear()
	table.clear(Container._all)
	Container._sealed = false
end

return Container
