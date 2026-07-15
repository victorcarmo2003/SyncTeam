local springWrapper = require(script.SpringWrapper)
local debounce = require(script.Debounce)

local function WaitForChildOfClass<T>(parent, className): T
	local child = parent:FindFirstChildOfClass(className)
	while not child do
		child = parent.ChildAdded:Wait()
		if child.ClassName ~= className then
			child = nil
		end
	end
	return child
end

return {
	WaitForChildOfClass = WaitForChildOfClass,
	Spring = springWrapper,
	Debounce = debounce,
}
