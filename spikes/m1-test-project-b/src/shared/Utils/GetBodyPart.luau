local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Body = require(ReplicatedStorage.Shared.Templates.Body)

export type BodyPart =
	"Head"
	| "HumanoidRootPart"
	| "Left Arm"
	| "Left Leg"
	| "Right Arm"
	| "Right Leg"
	| "Torso"
	| "Other"

local GetBodyPart = {}

GetBodyPart.Get = function(name: BodyPart):number
    local targetBody = Body[name]
    if not targetBody then
        return Body["Other"]
    end
    return targetBody
end

return GetBodyPart