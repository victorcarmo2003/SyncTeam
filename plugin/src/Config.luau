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

-- Chave de plugin:GetSetting/SetSetting para "Nome de exibição customizado"
-- (M4.5+, painel de configurações — antes um placeholder "em breve",
-- implementado de verdade em 2026-08-02). Quando não-vazio, substitui o nome
-- resolvido via Players:GetNameFromUserIdAsync como Username publicado em
-- Sessions/<clientId> (ver TeamCreateElection.luau) — é o que
-- TeamCreateLease.describeClient usa nas mensagens de lease negada e o que a
-- tabela de sessões do painel mostra na coluna USER. Default "" (string
-- vazia) = usar o nome do Roblox normalmente. GLOBAL à instalação do Studio,
-- mesmo grupo de NOTIFICATIONS_SETTING_KEY/AUTOSTART_SETTING_KEY acima — NÃO
-- confundir com o mecanismo por-place (PLACE_SETTINGS_KEY, mais abaixo),
-- outra fatia, não relacionada.
Config.CUSTOM_DISPLAY_NAME_SETTING_KEY = "SyncTeam_CustomDisplayName"

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

-- Lista dinâmica de watched roots recebida via mensagem espontânea
-- `watchedRoots` (extensão -> plugin, 2026-07-29, docs/DECISIONS.md — ver
-- também vscode-extension/src/protocol.ts WatchedRootsMessage e
-- SourceWatcher.applyWatchedRoots). `nil` até a 1ª mensagem chegar nesta
-- sessão do plugin. Module-level: sobrevive a SourceWatcher.stop()/start()
-- de propósito (mesmo padrão de estado persistente já usado por
-- ScriptRegistry, ver .claude/agent-memory/luau-dev.md) — uma troca de porta
-- ou reconexão não deveria esquecer a última lista dinâmica conhecida; a
-- próxima conexão aceita manda watchedRoots de novo e substitui isto,
-- normalmente.
local dynamicRoots = nil

-- Recebe `roots` (lista de nomes de Service, ex.
-- {"ReplicatedFirst", "ServerScriptService"}) da mensagem watchedRoots e
-- resolve cada nome via game:GetService, cada chamada em pcall (regra
-- .claude/rules/luau.md — nome de Service desconhecido/inválido não pode
-- derrubar o plugin). Substitui INTEIRAMENTE a lista dinâmica anterior (não
-- acumula entre chamadas — cada watchedRoots é o snapshot completo e atual
-- dos mount points do project.json no momento em que a extensão a montou).
-- Devolve a lista de nomes INVÁLIDOS/desconhecidos (pulados, nunca incluídos
-- em getWatchedRoots) para o chamador (SourceWatcher.applyWatchedRoots) logar
-- — esta função em si não loga nada (mantém Config livre de Logger).
function Config.setDynamicWatchedRoots(names)
	local resolved = {}
	local invalidNames = {}
	if type(names) == "table" then
		local seenNames = {}
		for _, name in names do
			if type(name) == "string" and not seenNames[name] then
				seenNames[name] = true
				local ok, service = pcall(function()
					return game:GetService(name)
				end)
				if ok and service ~= nil then
					table.insert(resolved, service)
				else
					table.insert(invalidNames, name)
				end
			end
		end
	end
	dynamicRoots = resolved
	return invalidNames
end

-- Containers observados recursivamente por Script/LocalScript/ModuleScript.
-- Decisão M1 original (docs/MILESTONES.md): plugin "burro"/genérico, lista
-- fixa; a extensão é quem mapeia contra o default.project.json do projeto do
-- usuário e ignora caminhos fora de qualquer ponto de montagem.
--
-- 2026-07-29 (docs/DECISIONS.md, mensagem watchedRoots): bug real — um mount
-- point novo (ex. ReplicatedFirst/First) apontando para um Service fora
-- desta lista fixa simplesmente não sincronizava. Esta função agora devolve a
-- UNIÃO da lista fixa com Config.setDynamicWatchedRoots(...) (quando já
-- recebida nesta sessão) — nunca REMOVE um container fixo, só adiciona os que
-- a extensão reportou e a lista fixa não cobria. A lista fixa em si vira o
-- FALLBACK/default: se watchedRoots nunca chegar (extensão mais velha, erro),
-- dynamicRoots continua nil e esta função devolve só a fixa, como sempre
-- devolveu. Decisão de UNIÃO (não substituição total), justificada em
-- SourceWatcher.applyWatchedRoots: nunca arriscar "esquecer" um container já
-- observado só porque a mensagem mais recente não o lista.
function Config.getWatchedRoots()
	local StarterPlayer = game:GetService("StarterPlayer")
	local fixed = {
		game:GetService("ServerScriptService"),
		StarterPlayer.StarterPlayerScripts,
		game:GetService("ReplicatedStorage"),
		game:GetService("ReplicatedFirst"),
		game:GetService("ServerStorage"),
		game:GetService("StarterGui"),
		game:GetService("Workspace"),
	}
	if dynamicRoots == nil then
		return fixed
	end
	local seen = {}
	local merged = {}
	for _, root in fixed do
		if not seen[root] then
			seen[root] = true
			table.insert(merged, root)
		end
	end
	for _, root in dynamicRoots do
		if not seen[root] then
			seen[root] = true
			table.insert(merged, root)
		end
	end
	return merged
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

-- Preferência efetiva de "Nome de exibição customizado" (M4.5+): setting do
-- plugin se presente e do tipo string, senão default "" (string vazia =
-- "usar o nome do Roblox resolvido normalmente"). Diferente de
-- resolveNotificationsEnabled/resolveAutoStartEnabled (booleanas): aqui
-- `type(value) == "boolean"` não se aplica — é `type(value) == "string"` —
-- mesmo esqueleto de validação (GetSetting em pcall; nunca setado ou tipo
-- errado caem no default), só o tipo esperado muda.
function Config.resolveCustomDisplayName(pluginObject)
	local ok, value = pcall(function()
		return pluginObject:GetSetting(Config.CUSTOM_DISPLAY_NAME_SETTING_KEY)
	end)
	if ok and type(value) == "string" then
		return value
	end
	return ""
end

-- ---------------------------------------------------- settings por-place (M4.5+)
--
-- docs/DECISIONS.md (2026-08-02, 3ª rodada, seção 4): usuário pediu novas
-- settings do painel (Studio) configuráveis "por espaço de trabalho" (por
-- lugar/place do Roblox) — mas `plugin:GetSetting`/`SetSetting` é GLOBAL à
-- INSTALAÇÃO do Studio, não por place (não existe API de setting por-place).
-- Contorno decidido: um ÚNICO slot GetSetting (PLACE_SETTINGS_KEY) guardando
-- um mapa `{[tostring(placeId)] = {chave -> valor}}`; toda leitura/escrita
-- passa por game.PlaceId do momento da chamada, nunca por um place
-- explicitamente passado — sempre "o place atual". As 3 settings GLOBAIS já
-- existentes (PORT_SETTING_KEY/NOTIFICATIONS_SETTING_KEY/
-- AUTOSTART_SETTING_KEY) NÃO são afetadas por isto — continuam globais, como
-- sempre foram; só as settings NOVAS desta rodada nascem por-place.
--
-- Escopo desta fatia (luau-dev): só a API de leitura/escrita abaixo. Consumir
-- de fato estes valores nos loops de runtime (SourceWatcher.pollLoop,
-- TeamCreatePresence — hoje ambos usam Config.POLL_INTERVAL_SECONDS fixo, ver
-- comentário de PLACE_SETTINGS_DEFAULTS abaixo) e construir a UI de settings
-- (StatusPanel.luau) ficam para tarefas separadas (ui-dev) — não tocados
-- aqui.
Config.PLACE_SETTINGS_KEY = "SyncTeam_PlaceSettings"

-- Chaves reconhecidas + default sensato de cada uma, usado sempre que a
-- chave nunca foi setada para o place atual (ou o valor salvo é de tipo
-- errado — schema corrompido/versão antiga da setting). Mínimo e extensível
-- por pedido explícito da tarefa: hoje só as 2 settings pedidas pelo usuário
-- além do toggle de autostart (que já existia antes desta tarefa, GLOBAL, não
-- por-place, ver AUTOSTART_SETTING_KEY acima). "Preferência sobre posse de
-- porta" (3ª setting mencionada no pedido original) FICA DE FORA desta lista
-- de propósito: docs/DECISIONS.md 2026-08-02 seção 4 decide explicitamente
-- que aquele diálogo roda do lado da EXTENSÃO (é ela quem faz o bind da
-- porta), não é uma setting persistente do painel do Studio — a extensão
-- pode guardar sua própria preferência local (ExtensionContext.globalState),
-- fora do escopo deste arquivo.
--
-- `sourcePollIntervalSeconds` ("intervalo de atualização de arquivo") e
-- `presencePollIntervalSeconds` ("intervalo de cursor") espelham hoje o MESMO
-- default de Config.POLL_INTERVAL_SECONDS porque, na implementação atual, as
-- duas cadências (SourceWatcher.pollLoop e
-- TeamCreatePresence.checkPresenceDrift) COMPARTILHAM essa mesma constante
-- fixa — esta tarefa não separa os dois loops nem faz nenhum dos dois ler
-- estas settings novas (ver nota de escopo acima); são expostas já agora
-- para a UI (ui-dev) e o wiring de runtime (futuro) terem uma chave estável
-- para desenhar/consumir.
--
-- `leaseStaleAfterSeconds` (2026-08-02, docs/DECISIONS.md "8ª rodada" —
-- handoff quase-instantâneo de lease): substitui, só para
-- TeamCreateLease.luau (arbitragem de lease por arquivo), o antigo valor
-- fixo `TeamCreateElection.STALE_AFTER_SECONDS = 8`. Default escolhido = 2
-- (não 3): o gatilho de detecção de edição do lado extensão passa a incluir
-- `onDidChangeTextDocument` throttled ~150ms (além do watcher de disco),
-- então o Pulse do intent de quem está digitando ativamente é renovado bem
-- mais rápido que antes — 2s já dá ~4 ciclos de folga sobre a nova cadência
-- de checagem de 0.5s (ver leaderTick em TeamCreateLease.luau) antes de
-- considerar o intent morto, sem exigir tanta margem quanto 3s pediria.
-- DELIBERADAMENTE não aplicado a TeamCreateElection.STALE_AFTER_SECONDS (elect/
-- applyJoinSequenceAssignments/tick) — aquele valor continua fixo em 8s: é
-- uma constante de SEGURANÇA de coordenação (detecção de sessão/líder morto,
-- valida o split-brain já corrigido em 2026-07-07), não uma constante de UX
-- de latência de arquivo; a decisão registrada fala especificamente de LEASE,
-- não de eleição — ver TeamCreateLease.luau para o ponto de leitura real.
Config.PLACE_SETTINGS_DEFAULTS = {
	sourcePollIntervalSeconds = Config.POLL_INTERVAL_SECONDS,
	presencePollIntervalSeconds = Config.POLL_INTERVAL_SECONDS,
	leaseStaleAfterSeconds = 2,
}

-- Lê a sub-tabela de settings do PLACE ATUAL (tostring(game.PlaceId)) dentro
-- do slot único GetSetting(PLACE_SETTINGS_KEY), já mesclada com
-- PLACE_SETTINGS_DEFAULTS para qualquer chave ausente. Toda a leitura em
-- pcall (regra .claude/rules/luau.md) — setting nunca setada, tipo errado, ou
-- qualquer falha de GetSetting degrada silenciosamente para os defaults,
-- nunca propaga erro nem derruba o plugin.
function Config.getPlaceSettings(pluginObject)
	local result = table.clone(Config.PLACE_SETTINGS_DEFAULTS)
	local ok, allPlaces = pcall(function()
		return pluginObject:GetSetting(Config.PLACE_SETTINGS_KEY)
	end)
	if not ok or type(allPlaces) ~= "table" then
		return result
	end
	local placeSettings = allPlaces[tostring(game.PlaceId)]
	if type(placeSettings) ~= "table" then
		return result
	end
	for key in Config.PLACE_SETTINGS_DEFAULTS do
		local value = placeSettings[key]
		if value ~= nil then
			result[key] = value
		end
	end
	return result
end

-- Getter de UMA chave só (conveniência para chamadores que só precisam de um
-- valor, sem montar a tabela inteira) — mesma resolução de default de
-- getPlaceSettings. Chave desconhecida (fora de PLACE_SETTINGS_DEFAULTS)
-- devolve nil sempre, nunca inventa um default para chave não registrada.
function Config.getPlaceSetting(pluginObject, key)
	if Config.PLACE_SETTINGS_DEFAULTS[key] == nil then
		return nil
	end
	return Config.getPlaceSettings(pluginObject)[key]
end

-- Escreve UMA chave na sub-tabela do place ATUAL, preservando (a) as outras
-- chaves do MESMO place já salvas e (b) as sub-tabelas de QUALQUER OUTRO
-- place já salvas no mesmo slot único — read-modify-write completo do mapa
-- inteiro, porque GetSetting/SetSetting não oferece update parcial (é tudo
-- ou nada por chamada). `value == nil` REMOVE a chave da sub-tabela do place
-- (a próxima leitura volta a usar o default) em vez de gravar nil
-- explicitamente. Validação leve e genérica (não hardcoded por nome de
-- chave, para continuar extensível a settings futuras de qualquer tipo):
-- chave fora de PLACE_SETTINGS_DEFAULTS é rejeitada (não deixa o slot
-- acumular lixo de nome errado); valor não-nil precisa bater o MESMO tipo Lua
-- do default, e se o default for number, precisa ser > 0 (todas as settings
-- numéricas hoje são intervalos em segundos — 0/negativo não faz sentido).
-- Toda a operação em pcall (regra .claude/rules/luau.md); retorna ok, err.
function Config.setPlaceSetting(pluginObject, key, value)
	local default = Config.PLACE_SETTINGS_DEFAULTS[key]
	if default == nil then
		return false, ("chave de setting desconhecida: %s"):format(tostring(key))
	end
	if value ~= nil then
		local defaultType = type(default)
		if type(value) ~= defaultType then
			return false, ("valor inválido para '%s': esperado %s, recebido %s"):format(key, defaultType, type(value))
		end
		if defaultType == "number" and value <= 0 then
			return false, ("valor inválido para '%s': precisa ser um número positivo"):format(key)
		end
	end

	local okRead, allPlaces = pcall(function()
		return pluginObject:GetSetting(Config.PLACE_SETTINGS_KEY)
	end)
	if not okRead or type(allPlaces) ~= "table" then
		allPlaces = {}
	end
	local placeKey = tostring(game.PlaceId)
	local placeSettings = allPlaces[placeKey]
	if type(placeSettings) ~= "table" then
		placeSettings = {}
	end
	placeSettings[key] = value -- value == nil aqui remove a chave (tabela Lua padrão)
	allPlaces[placeKey] = placeSettings

	local okWrite, errWrite = pcall(function()
		pluginObject:SetSetting(Config.PLACE_SETTINGS_KEY, allPlaces)
	end)
	if not okWrite then
		return false, tostring(errWrite)
	end
	return true, nil
end

return Config
