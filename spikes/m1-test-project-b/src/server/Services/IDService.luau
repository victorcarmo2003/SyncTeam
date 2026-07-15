local Modux = require(game.ReplicatedStorage.Shared.Modux)
local IDService = Modux.Service("IDService"):Import("PlayerService")
IDService.nextID = 0
IDService.allPlayers = {} :: { [Player]: number }

IDService.GetNextID = function(self): number
	self.nextID += 1
	return self.nextID
end

IDService.GetPlayerFromID = function(self, ID: number): Player?
	for player, id in self.allPlayers do
		if id == ID then
			return player
		end
	end
	return nil
end

IDService.GetPlayerID = function(self, Player: Player)
	for player, id in self.allPlayers do
		if player == Player then
			return id
		end
	end
	return self:RegisterPlayer(Player)
end

IDService.RegisterPlayer = function(self, Player: Player): number
	local id = self:GetNextID()
	self.allPlayers[Player] = id
	Player:SetAttribute("GameID", id)
	return id
end

IDService:OnInit(function(self)
	self.allPlayers = setmetatable(self.allPlayers, { __mode = "k" })
	self.PlayerService:OnPlayerAdded(function(Player: Player)
		warn(Player)
		self:RegisterPlayer(Player)
	end)
end)

-- --> WATCHDOG
-- IDService:OnTick(function(self, deltaTime: number)
-- 	for _, Player in game.Players:GetPlayers() do
-- 		if not Player:GetAttribute("GameID") and Player then
-- 			self:RegisterPlayer(Player)
-- 			warn(`[IDSERVICE] - Watchdog caught a player`)
-- 		end
-- 	end
-- end, Modux.TickRate.Hz1)

return IDService
