local Modux = require(game.ReplicatedStorage.Shared.Modux)

local ColorCorrectionController = Modux.Controller("ColorCorrectionController")

const DEFAULT_SATURATION = 0.5

ColorCorrectionController.SetSaturation = function(self, Value: number)
	self.Instance.Saturation = math.clamp(Value, (-1), DEFAULT_SATURATION)
end

ColorCorrectionController:OnInit(function(self)
	local correction = Instance.new("ColorCorrectionEffect")
	self.Instance = correction :: ColorCorrectionEffect
	correction.Parent = game.Lighting
end)

ColorCorrectionController:OnStart(function(self) end)

return ColorCorrectionController