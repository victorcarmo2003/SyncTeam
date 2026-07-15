local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Types = require(ReplicatedStorage.Shared.Modux.Types)

local Import: Types.ImportFn = function(self: any, id: string, scopeKey: string?)
	if not self._imports then
		self._imports = {}
	end
	if scopeKey ~= nil then
		warn(`[Modux] Import scopeKey "{scopeKey}" for "{id}" is deprecated and ignored.`)
	end
	table.insert(self._imports, { id = id, scopeKey = scopeKey })
	return self
end

return Import
