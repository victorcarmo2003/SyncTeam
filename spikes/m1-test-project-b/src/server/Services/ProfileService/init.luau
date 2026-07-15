-- modux ignore file
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Modux = require(ReplicatedStorage.Shared.Modux)
local Types = require(ReplicatedStorage.Shared.Modux.Types)
local ProfileTemplate = require(ReplicatedStorage.Shared.Templates.Profile)
local ProfileStorePackage = require(script.Profile)
local PlayerStore = ProfileStorePackage.New("Data_001", ProfileTemplate.Template)

export type DataTemplate = typeof(ProfileTemplate.Template)
type DataTemplateKey = Types.DataTemplateKey

local ProfileService = Modux.Service("ProfileService")
ProfileService:Import("PlayerService")

ProfileService.PrintData = true
ProfileService.Profiles = {} :: { [Player]: any }
ProfileService.OnUpdateData = ProfileService.Signal.new() :: Types.Signal<Player, DataTemplate>
ProfileService.OnUpdateKey = ProfileService.Signal.new() :: Types.Signal<Player, DataTemplateKey, any>
ProfileService._profileLoadedSignal = ProfileService.Signal.new() :: Types.Signal<Player, DataTemplate>
ProfileService._replicateCooldown = {}
ProfileService._replicatePending = {}
ProfileService._replicateKeyCooldown = {} :: { [Player]: { [string]: boolean } }
ProfileService._replicateKeyPending = {} :: { [Player]: { [string]: boolean } }

ProfileService._setupProfile = function(self, Player)
	local Players = game:GetService("Players")
	local profile = PlayerStore:StartSessionAsync(`{Player.UserId}`, {
		Cancel = function()
			return Player.Parent ~= Players
		end,
	})

	-- Handling new profile session or failure to start it:
	if profile ~= nil then
		profile:AddUserId(Player.UserId)
		profile:Reconcile() --modux ignore line
		profile.OnSessionEnd:Connect(function()
			ProfileService.Profiles[Player] = nil
			Player:Kick(`Profile session end - Please rejoin`)
			if self.PrintData then
				print(`{Player.Name} has left:`, profile.Data)
			end
		end)

		if Player.Parent == Players then
			ProfileService.Profiles[Player] = profile
			Player:SetAttribute("Loaded", true)
			ProfileService._profileLoadedSignal:Fire(Player, profile.Data)
			if self.PrintData then
				print(`{Player.Name} has joined:`, profile.Data)
			end
			return profile
		else
			-- The Player has left before the profile session started
			profile:EndSession()
			return profile
		end
	else
		-- This condition should only happen when the Roblox server is shutting down
		Player:Kick(`Profile load fail - Please rejoin`)
		return nil
	end
end

ProfileService.Set = function(self, Player: Player, Key: DataTemplateKey, value: any)
	local profile = self:GetData(Player)
	if profile[Key] == nil then
		return warn(`[ProfileService] Key not founded:`, Key)
	end
	profile[Key] = value
	self:ReplicateKey(Player, Key)
	return
end

-- Replica apenas uma key específica do perfil para o player.
ProfileService.ReplicateKey = function(self, Player: Player, Key: DataTemplateKey)
	assert(Player, "[ProfileService] Player ausente no ReplicateKey")

	if not ProfileService._replicateKeyCooldown[Player] then
		ProfileService._replicateKeyCooldown[Player] = {}
	end
	if not ProfileService._replicateKeyPending[Player] then
		ProfileService._replicateKeyPending[Player] = {}
	end

	local keyCooldown = ProfileService._replicateKeyCooldown[Player]
	local keyPending = ProfileService._replicateKeyPending[Player]

	-- Se ainda está em cooldown para esta key, agenda uma única tentativa pendente
	if keyCooldown[Key] then
		if not keyPending[Key] then
			keyPending[Key] = true
			task.delay(0.5, function()
				keyPending[Key] = nil
				if Player and Player.Parent then
					ProfileService.ReplicateKey(self, Player, Key)
				end
			end)
		end
		return
	end

	-- Aplica cooldown somente para esta key
	keyCooldown[Key] = true
	task.delay(0.5, function()
		keyCooldown[Key] = nil
		-- Limpa a tabela do player se ficou vazia
		if next(keyCooldown) == nil then
			ProfileService._replicateKeyCooldown[Player] = nil
			ProfileService._replicateKeyPending[Player] = nil
		end
	end)

	local data = ProfileService:GetData(Player)
	if not data then
		return
	end

	local value = data[Key]
	if type(value) == "number" or type(value) == "string" then
		Player:SetAttribute(Key, value)
	end

	self.Network.Packages.DataKey:sendKey(Key, value, Player)
end

ProfileService.Replicate = function(self, Player: Player)
	assert(Player, "[ProfileWrapper] Player ausente no Replicate")

	if ProfileService._replicateCooldown[Player] then
		if not ProfileService._replicatePending[Player] then
			ProfileService._replicatePending[Player] = true
			task.delay(0.5, function()
				ProfileService._replicatePending[Player] = nil
				if Player and Player.Parent then
					ProfileService.Replicate(self, Player)
				end
			end)
		end
		return
	end
	ProfileService._replicateCooldown[Player] = true
	task.delay(0.5, function()
		ProfileService._replicateCooldown[Player] = nil
	end)

	local profile = ProfileService:GetData(Player)
	if not profile then
		return
	end

	-- Sincroniza atributos numéricos e string no Player
	for name, value in profile do
		if type(value) == "number" or type(value) == "string" then
			Player:SetAttribute(name, value)
		end
	end
	self.Network.Packages.Data:send(profile, Player)
end
-- Retorna uma Promise que resolve com os dados do player.
-- Se o dado já existir, resolve instantaneamente.
ProfileService.GetData = function(self, Player: Player): DataTemplate?
	local profile = ProfileService.Profiles[Player]
	if profile then
		return profile.Data
	end

	-- Se não existe, cria Promise e faz await internamente
	local promise = self.Promise.new(function(resolve, reject)
		local connection
		connection = ProfileService._profileLoadedSignal:Connect(function(loadedPlayer, data)
			if loadedPlayer == Player then
				connection:Disconnect()
				resolve(data)
			end
		end)

		task.delay(10, function()
			if connection.Connected then
				connection:Disconnect()
				reject(`Timeout: Profile for {Player.Name} failed to load.`)
			end
		end)
	end)

	local success, data = promise:await()
	if not success then
		warn(`[ProfileService] ${data}`)
		return nil
	end

	return data
end

ProfileService:OnInit(function(self)
	self.PlayerService:OnPlayerAdded(function(Player: Player)
		self:_setupProfile(Player)
		self:Replicate(Player)
		self:ReplicateKey(Player, "Gems")
	end)

	self.PlayerService:OnPlayerRemoved(function(Player: Player)
		local profile = ProfileService.Profiles[Player]
		if profile ~= nil then
			profile:EndSession()
		end

		-- AutoClean: Evita Memory Leak
		ProfileService.Profiles[Player] = nil
		ProfileService._replicateCooldown[Player] = nil
		ProfileService._replicatePending[Player] = nil
		ProfileService._replicateKeyCooldown[Player] = nil
		ProfileService._replicateKeyPending[Player] = nil
	end)
end)

return ProfileService
