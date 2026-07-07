-- SyncTeam — Config do plugin de produção (M1)
--
-- Constantes centralizadas: porta WS, timings de polling/reconexão, versão
-- de protocolo, versão do plugin, e a lista fixa de containers observados.
--
-- Fora de escopo aqui: constantes de coordenação do TestService.SyncTeam
-- (pulso 2s / stale 8s / cleanup 20s) — isso é M3, ver .claude/rules/luau.md
-- e docs/MILESTONES.md.

local Config = {}

-- Porta padrão do servidor WebSocket local hospedado pela extensão VS Code.
-- Escolhida nova (não reutiliza 34901/34902, usadas pelos spikes M0/M0.5) só
-- para não colidir se algum spike antigo ainda estiver instalado/rodando ao
-- mesmo tempo que o plugin de produto.
Config.DEFAULT_PORT = 34980

-- Chave de plugin:GetSetting/SetSetting para permitir porta configurável sem
-- reescrever código (regra de "porta configurável com default fixo" de
-- .claude/rules/typescript.md, que vale também do lado do plugin). Ainda sem
-- UI para setar isso — usuário avançado pode chamar
-- plugin:SetSetting("SyncTeam_WsPort", <porta>) pelo Command Bar do Studio.
Config.PORT_SETTING_KEY = "SyncTeam_WsPort"

-- Caminho garantido de detecção de mudança de Source (ver DECISIONS.md
-- 2026-07-03): sinal é só fast-path, nunca a única via.
Config.POLL_INTERVAL_SECONDS = 0.5

Config.RECONNECT_SECONDS = 3

-- Handshake versionado (M1: começou em 1). Bump para 2 no M2 (breaking change
-- deliberado, docs/MILESTONES.md): readSource/writeSource passam a endereçar
-- por UUID (ScriptRegistry) em vez de path; writeSource sem `uuid` continua
-- significando criação (agora aloca um uuid novo); nova mensagem espontânea
-- scriptMoved. Extensão decide o que fazer em mismatch de versão.
Config.PROTOCOL_VERSION = 2
Config.PLUGIN_VERSION = "0.2.0"

-- Containers observados recursivamente por Script/LocalScript/ModuleScript.
-- Decisão M1 (docs/MILESTONES.md): plugin "burro"/genérico, lista fixa; a
-- extensão é quem mapeia contra o default.project.json do projeto do
-- usuário e ignora caminhos fora de qualquer ponto de montagem.
function Config.getWatchedRoots()
	local StarterPlayer = game:GetService("StarterPlayer")
	return {
		game:GetService("ServerScriptService"),
		StarterPlayer.StarterPlayerScripts,
		game:GetService("ReplicatedStorage"),
		game:GetService("ServerStorage"),
		game:GetService("StarterGui"),
		game:GetService("Workspace"),
	}
end

-- Porta efetiva: setting do plugin se presente e válida, senão o default.
function Config.resolvePort(pluginObject)
	local ok, value = pcall(function()
		return pluginObject:GetSetting(Config.PORT_SETTING_KEY)
	end)
	if ok and type(value) == "number" and value > 0 then
		return math.floor(value)
	end
	return Config.DEFAULT_PORT
end

return Config
