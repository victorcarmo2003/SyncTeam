--!strict
local RunService = game:GetService("RunService")
local Constructor = require(script.src.Core.Constructor)
local Container = require(script.src.Core.Container)
local Import = require(script.src.Core.Import)
local Types = require(script.Types)
local Loader = require(script.src.Loader)

export type Mode = "Singleton" | "Transient"
export type Type = "Service" | "Controller" | "Component" | "Mixin"
export type Signal<T...> = Types.Signal<T...>
export type SignalConnection = Types.SignalConnection
export type Promise<T> = Types.Promise<T>

local TickRate = table.freeze({
	Hz1 = 1,
	Hz5 = 5,
	Hz10 = 10,
	Hz15 = 15,
	Hz30 = 30,
	Hz60 = 60,
})

export type Modux = {
	Service: Types.ServiceFn,
	Controller: Types.ControllerFn,
	Component: Types.ComponentFn,
	Mixin: Types.MixinFn,
	TickRate: typeof(TickRate),
	Start: () -> (),
	Stop: () -> (),
}

local function createClass(id: string, mode: Mode, objectType: Type): any
	local newClass: any = Constructor.New(id, objectType)
	newClass.Import = Import
	Container.Register(id, newClass, mode, objectType)
	return newClass
end

local Service: any = function(id: string, mode: Mode?): any
	return createClass(id, mode or "Singleton", "Service")
end

local Controller: any = function(id: string, mode: Mode?): any
	return createClass(id, mode or "Singleton", "Controller")
end

local Component: any = function(id: string, mode: Mode?): any
	return createClass(id, mode or "Transient", "Component")
end

local Mixin: any = function(id: string): any
	return createClass(id, "Singleton", "Mixin")
end

local function loadManifest(): Loader.manifest?
	local manifestModule = script:FindFirstChild("Manifest")
	if not manifestModule or not manifestModule:IsA("ModuleScript") then
		return nil
	end
	local ok, manifest = pcall(require, manifestModule)
	if not ok then
		warn(`[Modux] Manifest.luau could not be loaded: {manifest}`)
		return nil
	end
	return manifest
end

local function Start()
	local roots: Loader.roots = {
		Shared = game.ReplicatedStorage:WaitForChild("Shared"),
	}
	if RunService:IsServer() then
		roots.Server = game.ServerScriptService:WaitForChild("Server")
	else
		local playerScripts = game.Players.LocalPlayer:WaitForChild("PlayerScripts")
		roots.Client = playerScripts:WaitForChild("Client")
	end

	Loader.Load(roots, loadManifest())
	print("[Modux] Started.")
end

local Modux: Modux = {
	Service = Service,
	Controller = Controller,
	Component = Component,
	Mixin = Mixin,
	TickRate = TickRate,
	Start = Start,
	Stop = Loader.Stop,
}

return Modux
