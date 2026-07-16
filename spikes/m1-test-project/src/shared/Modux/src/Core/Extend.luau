local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Types = require(ReplicatedStorage.Shared.Modux.Types)

local Extend: (self: any, id: string) -> any = function(self: any, id: string)
    if not self._mixins then
        self._mixins = {}
    end
    table.insert(self._mixins, id)
    return self
end

return Extend
