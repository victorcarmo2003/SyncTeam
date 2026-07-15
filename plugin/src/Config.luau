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

-- Lista de portas candidatas usada SÓ quando não há nenhuma porta
-- explicitamente persistida em plugin:GetSetting(PORT_SETTING_KEY) (nem por
-- SetSetting manual, nem por uma descoberta automática de sessão anterior —
-- ver Config.resolveCandidatePorts). ESTOPGAP para o cenário de teste de 2
-- Studios na mesma máquina compartilhando a MESMA pasta de Plugins (2 contas
-- via "Add Account" carregam o mesmo arquivo de plugin, então cada Studio
-- precisa descobrir sozinho qual harness/porta ainda está livre — ver
-- docs/PROJECT_STATUS.md). Em uso normal de produção (1 dev, 1 extensão) só
-- a primeira porta desta lista chega a importar; a segunda nunca é
-- alcançada porque a primeira tentativa já conecta.
Config.CANDIDATE_PORTS = { 34980, 34981 }

-- Janela curta (segundos) usada só para o heurístico de "rejeição
-- provável" da auto-descoberta de porta (init.server.luau, runConnection):
-- se a conexão cair SEM nunca ter recebido nenhuma mensagem do harness
-- dentro desta janela, é tratada como "porta provavelmente ocupada por
-- outro Studio" e o plugin avança para a próxima candidata em vez de
-- esperar RECONNECT_SECONDS. Deliberadamente NÃO depende de interpretar o
-- `code`/`errorMessage` do evento Error do WebStreamClient (não há
-- confirmação salva em .claude/research/ sobre o que CreateWebStreamClient
-- expõe para o close code 1013 do harness — ver SyncServer.ts) — só de
-- observação local (tempo decorrido + mensagens recebidas), que não exige
-- pesquisa de API nova.
Config.PROBABLE_REJECTION_WINDOW_SECONDS = 3

-- Atraso entre tentar uma candidata rejeitada e a próxima da lista —
-- deliberadamente bem menor que RECONNECT_SECONDS (não faz sentido esperar
-- muito antes de tentar a alternativa se a porta atual está ocupada por
-- OUTRO Studio), mas não é zero para não virar busy-loop se todas as
-- portas candidatas estiverem ocupadas ao mesmo tempo.
Config.CANDIDATE_RETRY_DELAY_SECONDS = 0.75

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

-- Lista de portas a tentar + se ela veio de uma porta JÁ EXPLICITAMENTE
-- setada (manual via botão "Alternar porta", ou persistida por uma
-- descoberta automática de sessão anterior via runConnection). Quando
-- explícita, a lista tem 1 item só e é a ÚNICA tentada (nunca cicla) —
-- CANDIDATE_PORTS só entra em jogo quando NÃO há nenhuma setting ainda.
function Config.resolveCandidatePorts(pluginObject)
	local ok, value = pcall(function()
		return pluginObject:GetSetting(Config.PORT_SETTING_KEY)
	end)
	if ok and type(value) == "number" and value > 0 then
		return { math.floor(value) }, true
	end
	return Config.CANDIDATE_PORTS, false
end

return Config
