--!strict
local ComponentRegistry = {}
ComponentRegistry._active = {}
ComponentRegistry._byType = {} -- Novo índice: ID -> {Componente}

function ComponentRegistry.Add(instance: Instance, id: string, component: any)
	-- Índice por Instância
	if not ComponentRegistry._active[instance] then
		ComponentRegistry._active[instance] = {}
	end
	ComponentRegistry._active[instance][id] = component

	-- Índice por Tipo
	if not ComponentRegistry._byType[id] then
		ComponentRegistry._byType[id] = {}
	end
	table.insert(ComponentRegistry._byType[id], component)
end

function ComponentRegistry.Remove(instance: Instance, id: string)
	if ComponentRegistry._active[instance] then
		local component = ComponentRegistry._active[instance][id]
		
		-- Limpar índice por Tipo
		if component and ComponentRegistry._byType[id] then
			local pos = table.find(ComponentRegistry._byType[id], component)
			if pos then
				table.remove(ComponentRegistry._byType[id], pos)
			end
		end

		-- Limpar índice por Instância
		ComponentRegistry._active[instance][id] = nil
		if next(ComponentRegistry._active[instance]) == nil then
			ComponentRegistry._active[instance] = nil
		end
	end
end

function ComponentRegistry.Get(instance: Instance, id: string)
	local components = ComponentRegistry._active[instance]
	return components and components[id]
end

function ComponentRegistry.GetAll(id: string)
	return ComponentRegistry._byType[id] or {}
end

function ComponentRegistry.Snapshot()
	local entries = {}
	for instance, byId in ComponentRegistry._active do
		for id in byId do
			table.insert(entries, { instance = instance, id = id })
		end
	end
	return entries
end

function ComponentRegistry.Clear()
	table.clear(ComponentRegistry._active)
	table.clear(ComponentRegistry._byType)
end

return ComponentRegistry
