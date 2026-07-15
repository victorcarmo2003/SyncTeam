export type EnemyType = {
	ModelName: string,
	ComponentTag: string?,
	BaseHealth: number,
	BaseDamage: number,
	WalkSpeed: number,
	SpawnCost: number,
	MinDifficulty: number,
}

return {
	Common = {
		ModelName = "Common",
		ComponentTag = "CommonAlien",
		BaseHealth = 100,
		BaseDamage = 10,
		WalkSpeed = 10,
		SpawnCost = 10,
		MinDifficulty = 1,
	},
	
	Intermediate = {
		ModelName = "Intermediate",
		ComponentTag = "IntermediateAlien",
		BaseHealth = 200,
		BaseDamage = 20,
		WalkSpeed = 15,
		SpawnCost = 20,
		MinDifficulty = 2,
	},
	
	Runner = {
		ModelName = "Runner",
		ComponentTag = "RunnerAlien",
		BaseHealth = 150,
		BaseDamage = 15,
		WalkSpeed = 20,
		SpawnCost = 15,
		MinDifficulty = 3,
	},
	
	Rage = {
		ModelName = "Rage",
		ComponentTag = "Aliens",
		BaseHealth = 300,
		BaseDamage = 30,
		WalkSpeed = 10,
		SpawnCost = 30,
		MinDifficulty = 4,
	},
	
	Telekinesis = {
		ModelName = "Telekinesis",
		ComponentTag = "Aliens",
		BaseHealth = 400,
		BaseDamage = 40,
		WalkSpeed = 10,
		SpawnCost = 40,
		MinDifficulty = 5,
	},
	
	Screamer = {
		ModelName = "Screamer",
		ComponentTag = "Aliens",
		BaseHealth = 500,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	Shooter = {
		ModelName = "Shooter",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	Knifer = {
		ModelName = "Knifer",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	Sniper = {
		ModelName = "Sniper",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	Tanker = {
		ModelName = "Tanker",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	Brutus = {
		ModelName = "Brutus",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
	
	AlienAnimal = {
		ModelName = "AlienAnimal",
		ComponentTag = "Aliens",
		BaseHealth = 200,
		BaseDamage = 50,
		WalkSpeed = 10,
		SpawnCost = 50,
		MinDifficulty = 6,
	},
} :: { [string]: EnemyType }
