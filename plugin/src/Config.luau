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
Config.DEFAULT_PORT = 1400

-- Chave de plugin:GetSetting/SetSetting para permitir porta configurável sem
-- reescrever código (regra de "porta configurável com default fixo" de
-- .claude/rules/typescript.md, que vale também do lado do plugin). Ainda sem
-- UI para setar isso — usuário avançado pode chamar
-- plugin:SetSetting("SyncTeam_WsPort", <porta>) pelo Command Bar do Studio.
Config.PORT_SETTING_KEY = "SyncTeam_WsPort"

-- Chave de plugin:GetSetting/SetSetting para a única opção real das
-- configurações do painel de status (M4.5, plugin/src/ui/): "Mostrar
-- notificações" — controla só se o TOAST aparece (Toast.luau); o log no
-- Output nunca é condicionado a isso (Logger.notify sempre loga, ver
-- Logger.luau). Default true (ligado) quando a setting nunca foi tocada.
Config.NOTIFICATIONS_SETTING_KEY = "SyncTeam_ShowNotifications"

-- Chave de plugin:GetSetting/SetSetting para autostart (2026-07-16, pedido do
-- usuário após teste real). Ao contrário de NOTIFICATIONS_SETTING_KEY
-- (default true/ligado), o default AQUI é false/DESLIGADO — decisão
-- deliberada: o comportamento anterior (auto-start incondicional ao carregar
-- o plugin, ver init.server.luau) conectava sem o dev pedir; a partir de
-- agora o dev decide quando conectar clicando em CONNECT no painel, e só quem
-- ligar esta setting (2026-07-20: toggle real "Reconectar automaticamente ao
-- abrir a place" na tela de configurações do painel, ver
-- plugin/src/ui/StatusPanel.luau — antes disso só via
-- plugin:SetSetting(...) no Command Bar) volta a ter auto-start.
Config.AUTOSTART_SETTING_KEY = "SyncTeam_AutoStart"

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
Config.CANDIDATE_PORTS = { 1400, 1401 }

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

-- Detecção de conexão morta por AUSÊNCIA de mensagens (init.server.luau,
-- runConnection). Garantia independente dos eventos Closed/Error do
-- WebStreamClient, que podem NÃO disparar quando o servidor WS da extensão
-- morre sem enviar frame de close (ex.: "Reload Window" do VS Code mata o
-- processo da extensão). A extensão manda `{kind:"ping"}` a cada 5s enquanto
-- conectada (vscode-extension HeartbeatMonitor.ts) e ela mesma derruba a
-- conexão se ficar 15s sem receber NENHUMA mensagem do plugin. Do lado do
-- plugin: se passar este intervalo sem receber NENHUMA mensagem (nem o ping
-- periódico, nem qualquer outra), a conexão é tratada como morta e forçamos
-- reconexão. Escolhido 20s (4 intervalos de ping) em vez de 15s: dá 1 ping de
-- folga sobre o timeout da extensão, evitando um teardown falso por um único
-- ping atrasado/perdido, ao custo de no máximo ~5s a mais exibindo "conectado"
-- após uma queda real — aceitável (o bug original era ficar "conectado" por
-- MUITO mais que isso). Só o plugin RESPONDE ao ping (pong); nunca origina
-- ping próprio — a ausência do ping da extensão é o único sinal usado aqui.
Config.DEAD_CONNECTION_TIMEOUT_SECONDS = 20

-- Handshake versionado (M1: começou em 1). Bump para 2 no M2 (breaking change
-- deliberado, docs/MILESTONES.md): readSource/writeSource passam a endereçar
-- por UUID (ScriptRegistry) em vez de path; writeSource sem `uuid` continua
-- significando criação (agora aloca um uuid novo); nova mensagem espontânea
-- scriptMoved. Extensão decide o que fazer em mismatch de versão.
Config.PROTOCOL_VERSION = 2
Config.PLUGIN_VERSION = "0.2.0"

-- Nomes de pasta que marcam árvore de dependências vendorizadas por Wally
-- (https://wally.sh) — convenção padrão: `Packages/` é a mais comum, mas
-- projetos com dependências separadas por lado (server/client/dev) também
-- usam `ServerPackages`/`DevPackages`. Risco de arquitetura (2026-07-16,
-- aprovado pelo usuário, ver docs/DECISIONS.md): dois devs podem ter
-- `wally.lock`/pastas `Packages/` locais divergentes (versão desatualizada
-- de um lado); se o SyncTeam tratasse esses ModuleScripts como qualquer
-- outro, o Source do pacote vendorizado desatualizado de um dev poderia ser
-- empurrado ao Team Create compartilhado, alterando silenciosamente a
-- dependência de TODOS os devs. Usado por Config.isInsideExcludedPackageFolder
-- para excluir esses scripts do LIVE EDIT SYNC (watch de mudança de Source +
-- arbitragem de lease) nos dois sentidos — mas NÃO do discovery/identidade
-- (ScriptRegistry/listScripts continuam normais, para o "Refresh Sync" da
-- extensão poder detectar "esse pacote já existe, não duplicar"; criação de
-- instância nova continua funcionando igual, só depois de criada é que ela
-- entra em "modo vendorizado").
Config.SYNC_EXCLUDED_FOLDER_NAMES = {
	Packages = true,
	ServerPackages = true,
	DevPackages = true,
}

-- true se `instance` estiver, em qualquer profundidade, dentro de uma pasta
-- cujo Name é exatamente um dos SYNC_EXCLUDED_FOLDER_NAMES (sobe
-- instance.Parent até a raiz observada/game). Usado para pular a instância
-- APENAS do polling de mudança de Source e da arbitragem de lease — nunca do
-- registro de identidade/listScripts/criação (ver comentário acima e
-- docs/DECISIONS.md 2026-07-16).
function Config.isInsideExcludedPackageFolder(instance)
	local current = instance and instance.Parent
	while current ~= nil do
		if Config.SYNC_EXCLUDED_FOLDER_NAMES[current.Name] then
			return true
		end
		current = current.Parent
	end
	return false
end

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

-- Preferência efetiva de "Mostrar notificações" (M4.5): setting do plugin se
-- presente e booleana, senão default true. Só GetSetting pode devolver nil
-- (nunca setado) ou um valor de tipo errado (schema corrompido/versão
-- antiga) — os dois caem no default, nunca erram.
function Config.resolveNotificationsEnabled(pluginObject)
	local ok, value = pcall(function()
		return pluginObject:GetSetting(Config.NOTIFICATIONS_SETTING_KEY)
	end)
	if ok and type(value) == "boolean" then
		return value
	end
	return true
end

-- Preferência efetiva de autostart (2026-07-16): setting do plugin se
-- presente e booleana, senão default FALSE (oposto de
-- resolveNotificationsEnabled — ver comentário de AUTOSTART_SETTING_KEY
-- acima). GetSetting pode devolver nil (nunca setado, o caso normal para
-- quem nunca abriu o toggle de "Reconectar automaticamente ao abrir a
-- place" nas configurações do painel — que também nasce desligado) ou um
-- valor de tipo errado — ambos caem no default desligado, nunca erram para
-- o lado de conectar sozinho sem o dev pedir.
function Config.resolveAutoStartEnabled(pluginObject)
	local ok, value = pcall(function()
		return pluginObject:GetSetting(Config.AUTOSTART_SETTING_KEY)
	end)
	if ok and type(value) == "boolean" then
		return value
	end
	return false
end

return Config
