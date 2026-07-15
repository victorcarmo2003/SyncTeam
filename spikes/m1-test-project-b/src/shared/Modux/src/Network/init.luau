--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Types = require(ReplicatedStorage.Shared.Modux.Types)
local lync = require(script.lync)

type Packet<T> = lync.Packet<T>
type DataTemplate = Types.DataTemplate
type DataTemplateKey = Types.DataTemplateKey
type DataKeyPayload = Types.DataKeyPayload
type KeyedPacket<K, V> = Packet<{ key: K, value: V }> & {
	sendKey: (self: KeyedPacket<K, V>, key: K, value: V, target: any?) -> (),
	onKey: (
		self: KeyedPacket<K, V>,
		fn: (key: K, value: V, sender: Player?, timestamp: number?) -> ()
	) -> lync.Connection,
}

local Network = {}
setmetatable(Network, { __index = lync })
Network.__index = Network

function Network.keyPacket(name: string, valueCodecs: { [string]: any }, options: any?): any
	local variants = {}
	for key, codec in valueCodecs do
		variants[key] = Network.struct({ value = codec })
	end

	local packet = Network.packet(name, Network.tagged("key", variants), options)
	local keyedPacket = {}

	keyedPacket.send = function(_self, data, target)
		packet:send(data, target)
	end

	keyedPacket.on = function(_self, fn)
		return packet:on(fn)
	end

	keyedPacket.once = function(_self, fn)
		return packet:once(fn)
	end

	keyedPacket.wait = function(_self)
		return packet:wait()
	end

	keyedPacket.name = function(_self)
		return packet:name()
	end

	keyedPacket.stats = function(_self)
		return packet:stats()
	end

	keyedPacket.sendKey = function(_self, key, value, target)
		packet:send({
			key = key,
			value = value,
		}, target)
	end

	keyedPacket.onKey = function(_self, fn)
		return packet:on(function(payload, sender, timestamp)
			fn(payload.key, payload.value, sender, timestamp)
		end)
	end

	return table.freeze(keyedPacket)
end

-- Codec compartilhado para as keys individuais (reutilizado em Packages e Types)
Network.Packages = {
	ZoneNotification = Network.packet("ZoneNotification", Network.struct({ Message = Network.string(20) })),
	TransitionCycle = Network.packet("TransitionCycle", Network.struct({ DayTime = Network.string(5) })),
	SecondsCycle = Network.packet("SecondsCycle", Network.struct({ Seconds = Network.int(0, 420) })),
	DayCycle = Network.packet("DayCycle", Network.struct({ CurrentDay = Network.int(0, 10000) })),
	ChangeMovement = Network.packet("ChangeMovement", Network.struct({ ActionName = Network.string(10) })),
	ChangeWalkSpeed = Network.packet("ChangeWalkSpeed", Network.struct({ WalkSpeed = Network.int(0, 48) })),

	Data = Network.packet(
		"Data",
		Network.struct({
			Gems = Network.int(0, 4294967295),
			Gamepasses = Network.map(Network.string(10), Network.bool),

			Item = Network.map(Network.string(32), Network.int(0, 65535)),
			UnlockedItems = Network.map(Network.int(0, 65535), Network.bool),
			UnlockedClasses = Network.map(Network.int(0, 65535), Network.bool),
			Badgets = Network.map(Network.int(0, 65535), Network.bool),

			FirstLogin = Network.bool,

			Wins = Network.int(0, 65536),
			DayCount = Network.int(0, 65536),
			CurrentZone = Network.string(15),
			CurrentClass = Network.string(32),
			TimeSpent = Network.f32,

			RobuxSpent = Network.int(0, 1000000),
			GemsSpent = Network.int(0, 1000000),
			ChestOpen = Network.int(0, 100000),
			SpinWheel = Network.int(0, 100000),

			MusicVolume = Network.int(0, 1),
			SoundVolume = Network.int(0, 1),
			SoundEnabled = Network.bool,
			MusicEnabled = Network.bool,
		})
	) :: Packet<DataTemplate>,

	DataKey = Network.keyPacket("DataKey", {
		Gems = Network.int(0, 4294967295),
		Gamepasses = Network.map(Network.string(10), Network.bool),

		Item = Network.map(Network.string(32), Network.int(0, 65535)),
		UnlockedItems = Network.map(Network.int(0, 65535), Network.bool),
		UnlockedClasses = Network.map(Network.int(0, 65535), Network.bool),
		Badgets = Network.map(Network.int(0, 65535), Network.bool),

		FirstLogin = Network.bool,

		Wins = Network.int(0, 65536),
		DayCount = Network.int(0, 65536),
		CurrentZone = Network.string(15),
		CurrentClass = Network.string(32),

		TimeSpent = Network.f32,

		RobuxSpent = Network.int(0, 1000000),
		GemsSpent = Network.int(0, 1000000),
		ChestOpen = Network.int(0, 100000),
		SpinWheel = Network.int(0, 100000),

		MusicVolume = Network.int(0, 1),
		SoundVolume = Network.int(0, 1),
		SoundEnabled = Network.bool,
		MusicEnabled = Network.bool,
	}) :: KeyedPacket<DataTemplateKey, any> & Packet<DataKeyPayload>,

	VitalKey = Network.keyPacket("VitalKey", {
		Armor = Network.int(0, 100),
		Health = Network.int(0, 100),
		Stamina = Network.int(0, 100),
	}),

	GetVitals = Network.query(
		"GetVitals",
		Network.nothing,
		Network.struct({
			Armor = Network.int(0, 100),
			Health = Network.int(0, 100),
			Stamina = Network.int(0, 100),
		})
	),

	PlayerSnapshot = Network.packet(
		"PlayerSnapshot",
		Network.struct({
			Position = Network.vec3int16,
			LookAt = Network.vec3int16,
			State = Network.int(0, 7),
			MoveDir = Network.vec2(-1, 1, 0.001),
			WeaponID = Network.int(0, 255),
		}),
		{ unreliable = true, timestamp = "full" }
	),

	HitValidate = Network.query(
		"HitValidation",
		Network.struct({
			TargetID = Network.int(0, 255),
			HitPart = Network.int(0, 15),
			Origin = Network.vec3int16,
			Direction = Network.vec3int16,
			TimeStamp = Network.f64,
		}),
		Network.struct({
			Accepted = Network.bool,
			Damage = Network.int(0, 255),
		}),
		{
			rateLimit = { maxPerSecond = 15, burst = 10 },
			validate = function(data, Player: Player)
				-- to be implemented
				return true
			end,
		}
	),
}

Network.flushRate(60)
Network.start()

return Network
