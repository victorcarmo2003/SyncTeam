local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Guns = require(ReplicatedStorage.Shared.Datas.Guns)

export type GunNames =
	"Shotgun"
	| "Sniperagus"
	| "Carrocket"
	| "Peavolver"
	| "Gromato Launcher"
	| "Chilli Thrower"
	| "M6Bean"
	| "WatermeLMG"
	| "Double Cob"

export type AmmoType = "Single" | "Multi" | "Area"

local GetGun = {}
GetGun.AllGuns = Guns

GetGun.GetAll = function(self) end

GetGun.GetByID = function(self, id: number) end

GetGun.GetByName = function(self, name: GunNames) end

return GetGun
