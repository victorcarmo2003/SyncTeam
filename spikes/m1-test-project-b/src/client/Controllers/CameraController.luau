local Players = game:GetService("Players")
local Modux = require(game.ReplicatedStorage.Shared.Modux)

local CameraController = Modux.Controller("CameraController")

const MAX_RANGE = 150
const BLACKLIST_RAYCAST = RaycastParams.new()
const BLACKLIST_OVERLAP = OverlapParams.new()

local function GetPlayerFromPart(part: BasePart): Player?
	local model = part.Parent
	local character: Model
	if model and model:IsA("Model") then
		character = model
	end
	local player = Players:GetPlayerFromCharacter(character)
	return player
	--return character
end

CameraController.GetLookPart = function(self): (BasePart?, Player?)
	local currentCamera = workspace.CurrentCamera
	local mouse = self.LocalPlayer:GetMouse()
	local screenRay = currentCamera:ScreenPointToRay(mouse.X, mouse.Y, 0)
	if not screenRay then
		return
	end
	local worldRay = workspace:Raycast(screenRay.Origin, screenRay.Direction * MAX_RANGE, BLACKLIST_RAYCAST)
	if worldRay and worldRay.Instance then
		return worldRay.Instance, GetPlayerFromPart(worldRay.Instance)
	end
	return nil
end

CameraController.GetLookAt = function(self): Vector3?
	local currentCamera = workspace.CurrentCamera
	local mouse = self.LocalPlayer:GetMouse()
	local screenRay = currentCamera:ScreenPointToRay(mouse.X, mouse.Y, 0)
	if not screenRay then
		return
	end
	return screenRay.Origin + screenRay.Direction * 20
end

CameraController.SetupFilters = function(self)
	BLACKLIST_RAYCAST.FilterType = Enum.RaycastFilterType.Exclude
	BLACKLIST_OVERLAP.FilterType = Enum.RaycastFilterType.Exclude

	local function applyLocalCharacter(character: Model)
		BLACKLIST_RAYCAST.FilterDescendantsInstances = { character }
		BLACKLIST_OVERLAP.FilterDescendantsInstances = { character }
	end

	if self.LocalCharacter then
		applyLocalCharacter(self.LocalCharacter)
	end

	self:Cleanup(self.LocalPlayer.CharacterAdded:Connect(function(character: Model)
		applyLocalCharacter(character)
	end))
end

CameraController:OnInit(function(self)
	self:SetupFilters()
end)

CameraController:OnStart(function(self) end)

return CameraController
