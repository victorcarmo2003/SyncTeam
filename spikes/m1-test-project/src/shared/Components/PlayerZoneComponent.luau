local ReplicatedStorage = game:GetService("ReplicatedStorage")
local quickzone = require(ReplicatedStorage.Packages.quickzone)
local Zone, Observer, Groups = quickzone.Zone, quickzone.Observer, quickzone.Group
local Modux = require(game.ReplicatedStorage.Shared.Modux)

export type PlayerZoneConfig = {
	MinHeight: number,
	Padding: Vector3?,
	Shape: "Block" | "Ball" | "Cylinder" | "Wedge" | "CornerWedge",
}

export type callbackZone = (Player: Player, Zone: PlayerZoneConfig) -> ()

local PlayerZoneComponent = Modux.Mixin("PlayerZoneComponent")

PlayerZoneComponent:OnInit(function(self)
	self._onEnter = {}
	self._onExit = {}
end)

local PlayerGroup = Groups.players()

PlayerZoneComponent.OnEnter = function(self, callback: callbackZone)
	if not self._onEnter then
		self._onEnter = {}
	end
	table.insert(self._onEnter, callback)
end

PlayerZoneComponent.OnExit = function(self, callback: callbackZone)
	if not self._onExit then
		self._onExit = {}
	end
	table.insert(self._onExit, callback)
end

PlayerZoneComponent.ObserverPlayersInPart = function(self, config: PlayerZoneConfig)
	local part = self.Instance

	local minHeight = config.MinHeight or part.Size.Y
	local padding = config.Padding or Vector3.zero

	local TargetSize =
		Vector3.new(part.Size.X + padding.X, math.max(part.Size.Y, minHeight) + padding.Y, part.Size.Z + padding.Z)

	local TargetCFrame = part.CFrame * CFrame.new(0, (TargetSize.Y - part.Size.Y) / 2, 0)

	local newObserver = Observer.new({
		groups = { PlayerGroup },
	})

	local zone = Zone.new({
		cframe = TargetCFrame,
		size = TargetSize,
		shape = config.Shape or "Block",
		observers = { newObserver },
		instance = self.Instance,
	})

	local disconnect = newObserver:observePlayer(function(Player: Player, Zone): (() -> ())?
		if self._onEnter and #self._onEnter > 0 then
			for _, func in self._onEnter do
				func(Player, Zone)
			end
		end

		return function()
			if self._onExit and #self._onExit > 0 then
				for _, func in self._onExit do
					func(Player, Zone)
				end
			end
		end
	end)

	self:Cleanup(function()
		disconnect()
		zone:destroy()
		newObserver:destroy()
		if self._onExit then
			table.remove(self._onExit)
		end
		if self._onEnter then
			table.remove(self._onEnter)
		end
	end)

	return zone, Observer
end

return PlayerZoneComponent
