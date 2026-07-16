local Modux = require(game.ReplicatedStorage.Shared.Modux)

local HitService = Modux.Service("HitService"):Import("IDService")

HitService.DealDamage = function(self, Target: Player, Shooter: Player)
    local targetVital = self:GetComponent(Target, "VitalComponent")
    targetVital:TakeDamage(10)
    print(targetVital.Health)
end

HitService.ValidateHit = function(self, Target: Player, Shooter: Player)
    local shooterID = self.IDService:GetPlayerID(Shooter)
    local targetID = self.IDService:GetPlayerID(Target)

    self:DealDamage(Target, Shooter)
end

HitService:OnInit(function(self) 
    self.Network.Packages.HitValidate:handle(function(request, player: Player?): { Accepted: boolean, Damage: number }?
        if not player then
            return nil
        end

        local targetPlayer = self.IDService:GetPlayerFromID(request.TargetID)
        warn(`difference = {workspace:GetServerTimeNow() - request.TimeStamp}`)
        
        self:ValidateHit(targetPlayer, player)
        return {
            Accepted = true,
            Damage = 50,
        }
    end)
end)

HitService:OnStart(function(self) end)

return HitService
