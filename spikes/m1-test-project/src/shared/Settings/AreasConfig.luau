local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Aliens = require(ReplicatedStorage.Shared.Enums.Aliens)

type AlienType = Aliens.AlienType

export type SpawnType = "Base" | "Field" | "EnemyBase"

export type SpawnAreaConfig = {
	Enabled: boolean,
	MinDifficulty: number,
	MaxDifficulty: number,
	AlienWeights: { [AlienType]: number },
}

export type SpawnAreaType = {
	Base: SpawnAreaConfig,
	Field: SpawnAreaConfig,
	EnemyBase: SpawnAreaConfig,
}

return {
	Base = {
		Enabled = false,
		MinDifficulty = 1,
		MaxDifficulty = 10,
		AlienWeights = {
			Common = 0,
		},
	},

	Field = {
		Enabled = true,
		MinDifficulty = 1,
		MaxDifficulty = 10,
		AlienWeights = {
			Common = 70,
			Intermediate = 20,
			Runner = 10,
		},
	},

	EnemyBase = {
		Enabled = true,
		MinDifficulty = 1,
		MaxDifficulty = 10,
		AlienWeights = {
			Intermediate = 70,
			Runner = 30,
			Rage = 20,
			Screamer = 10
		},
	},
} :: SpawnAreaType