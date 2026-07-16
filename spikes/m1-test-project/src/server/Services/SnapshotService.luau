local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GameSettings = require(ReplicatedStorage.Shared.Settings.GameSettings)
local Modux = require(game.ReplicatedStorage.Shared.Modux)

export type SnapshotData = {
    Position: Vector3int16,
    LookAt: Vector3int16,
    State: number,
    MoveDir: Vector2,
    WeaponID: number,
    ExpirateAt: number,
}

local SnapshotService = Modux.Service("SnapshotService"):Import("IDService")
SnapshotService.AllSnapshots = {} :: {[number]: SnapshotData}

SnapshotService.RegisterSnapshot = function(self, Player:Player, snapshot)
    snapshot.ExpirateAt = workspace:GetServerTimeNow() + GameSettings.SnapshotExpiration
    local targetID = self.IDService:GetPlayerID(Player)
end

SnapshotService.ExpireSnapshot = function(self)
    
end

SnapshotService:OnInit(function(self)
    self.Network.Packages.PlayerSnapshot:on(function(   data, sender, timestamp)
        self:RegisterSnapshot(data)    
    end)
end)

SnapshotService:OnTick(function(self, deltaTime: number)
    
end, Modux.TickRate.Hz60)

return SnapshotService