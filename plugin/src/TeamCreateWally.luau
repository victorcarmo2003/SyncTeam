-- SyncTeam — avisa quando o colega mexeu nas dependências Wally.
--
-- O buraco que isto fecha: `Packages/`, `ServerPackages/` e `DevPackages/`
-- ficam DE FORA do live-edit-sync de propósito (ver
-- vscode-extension/src/mapping/wallyPackageFolders.ts, decisão de
-- 2026-07-16) — dois devs podem ter `Packages/` divergentes, e empurrar
-- Source de pacote vendorizado pelo Team Create mudaria a dependência de
-- todo mundo em silêncio.
--
-- A consequência é que uma dependência NOVA nunca atravessa. O dev A escreve
-- no `wally.toml`, roda `wally install`, e o código dele chega no Studio do
-- dev B requerendo `ReplicatedStorage.Packages.NovaLib` — que só existe na
-- máquina do A. B vê `NovaLib is not a valid member` e não tem como saber
-- que a causa foi uma linha num arquivo que nem sincroniza.
--
-- A saída NÃO é sincronizar o `wally.toml` nem os pacotes: continua valendo
-- que cada máquina resolve as próprias dependências. O que atravessa é uma
-- IMPRESSÃO DIGITAL — uma string curta que a extensão calcula do `wally.toml`
-- e publica na própria sessão. O outro lado compara com a dele e, quando
-- diferem, avisa. Ninguém instala nada por conta própria; o dev decide.
--
-- Mesmo caminho da presença (TeamCreatePresence.luau), e por isso o mesmo
-- formato: valor na pasta da própria sessão, Team Create replica, o outro
-- plugin lê e emite para a extensão dele.

local TeamCreateElection = require(script.Parent.TeamCreateElection)
local TeamCreateSchema = require(script.Parent.TeamCreateSchema)
local Config = require(script.Parent.Config)
local Logger = require(script.Parent.Logger)

local TeamCreateWally = {}

-- Nome do valor dentro de Sessions/<clientId>. Fica FORA de
-- `SESSION_VALUE_CLASSES` do TeamCreateElection de propósito: `readSessionEntry`
-- devolve nil se QUALQUER valor declarado lá faltar, então acrescentar a chave
-- naquela tabela faria a sessão de um plugin mais velho sumir inteira do
-- roster durante uma atualização escalonada. Aqui é lido como opcional.
local VALUE_NAME = "WallyFingerprint"

local sendMessage = nil
local ownFingerprint = ""
-- Lido, não é dono — TeamCreateElection é o dono. Reavaliado a cada uso pelo
-- mesmo motivo do resto do schema: a reconciliação de duplicatas do Team
-- Create pode trocar a Instance canônica debaixo de uma referência cacheada.
local sessionsFolder = nil
-- clientId -> última impressão digital pela qual já avisamos. Sem isto o
-- aviso sairia a cada tick enquanto a divergência durasse, e ela dura até
-- alguém rodar `wally install` — podem ser minutos.
local warnedByClientId = {}
local enabled = false
local currentToken = 0

function TeamCreateWally.init(onMessage)
	sendMessage = onMessage
end

local function ensureSessionsFolder()
	sessionsFolder = TeamCreateSchema.ensureFolder("Sessions")
	return sessionsFolder
end

-- Nome de exibição de uma sessão, com o clientId como fallback. Duplicado de
-- TeamCreatePresence.describeClient pelo mesmo motivo que ele duplica de
-- TeamCreateLease: são cinco linhas, e cruzar os módulos por elas criaria
-- dependência entre peças que hoje não se conhecem.
local function describeClient(folder, clientId)
	local username = folder:FindFirstChild("Username")
	if username ~= nil and username:IsA("StringValue") and username.Value ~= "" then
		return username.Value
	end
	return clientId
end

--- Publica a impressão digital local na própria sessão.
---
--- Chamado pela extensão via mensagem espontânea, no boot e sempre que o
--- `wally.toml` muda. Guarda o valor num módulo local também porque a sessão
--- pode ser recriada a qualquer momento pela auto-cura de
--- `TeamCreateElection` — quando isso acontece, o valor precisa voltar, e
--- quem o reescreve é o próximo `checkDrift`.
function TeamCreateWally.setOwnFingerprint(fingerprint)
	if type(fingerprint) ~= "string" then
		return
	end
	ownFingerprint = fingerprint
	TeamCreateWally.publish()
end

--- Grava `ownFingerprint` na pasta da própria sessão, criando o valor se
--- preciso. Silencioso quando não há sessão (eleição parada, ou pasta ainda
--- sendo recriada) — quem chama trata como melhor esforço, nunca erro.
function TeamCreateWally.publish()
	if ownFingerprint == "" then
		return
	end
	local sessionFolder = TeamCreateElection.getSessionFolder()
	if sessionFolder == nil then
		return
	end
	local value = sessionFolder:FindFirstChild(VALUE_NAME)
	if value == nil then
		value = Instance.new("StringValue")
		value.Name = VALUE_NAME
		-- Mesma mitigação de undo do resto do schema (ver TeamCreateSchema).
		value.Archivable = false
		value.Parent = sessionFolder
	end
	if value.Value ~= ownFingerprint then
		value.Value = ownFingerprint
	end
end

--- Compara a impressão digital local com a das outras sessões e avisa quando
--- alguma diverge. Chamado a cada tick da eleição.
---
--- Só avisa uma vez por par (clientId, impressão digital do outro): a
--- divergência persiste até alguém rodar `wally install`, e repetir o toast a
--- cada dois segundos seria ruído, não informação.
function TeamCreateWally.checkDrift()
	-- Republica antes de comparar: se a sessão foi recriada pela auto-cura, o
	-- valor não está mais lá, e sem isto o outro lado passaria a ver a NOSSA
	-- impressão como ausente e nós nunca a reporíamos.
	TeamCreateWally.publish()

	if ownFingerprint == "" then
		return
	end

	local ownClientId = TeamCreateElection.getClientId()
	local vistos = {}
	for _, folder in ipairs(ensureSessionsFolder():GetChildren()) do
		if not folder:IsA("Folder") or folder.Name == ownClientId then
			continue
		end
		local clientId = folder.Name
		local value = folder:FindFirstChild(VALUE_NAME)
		-- Ausente não é divergente: o colega pode estar num plugin mais velho,
		-- ou a sessão dele acabou de nascer e a extensão ainda não publicou.
		-- Avisar nesse caso seria alarme falso na conexão de todo mundo.
		if value == nil or not value:IsA("StringValue") or value.Value == "" then
			continue
		end

		vistos[clientId] = true
		if value.Value == ownFingerprint then
			-- Voltaram a bater: esquecer para que uma divergência FUTURA avise
			-- de novo.
			warnedByClientId[clientId] = nil
			continue
		end
		if warnedByClientId[clientId] == value.Value then
			continue
		end
		warnedByClientId[clientId] = value.Value

		local quem = describeClient(folder, clientId)
		Logger.notify(("%s está com dependências Wally diferentes das suas — rode `wally install`"):format(quem))
		if sendMessage ~= nil then
			sendMessage({
				kind = "wallyDrift",
				clientId = clientId,
				displayName = quem,
			})
		end
	end

	-- Sessão que saiu para de ser lembrada, senão o aviso nunca mais sairia
	-- para aquele clientId se ele voltasse com a mesma divergência.
	for clientId in warnedByClientId do
		if not vistos[clientId] then
			warnedByClientId[clientId] = nil
		end
	end
end

--- Sobe o ciclo que compara as impressões digitais.
---
--- Cadência própria em vez de pendurar no tick da eleição: divergência de
--- dependência muda em escala de minutos (alguém edita o wally.toml e roda
--- `wally install`), não de segundos, e o ciclo da eleição já carrega pulso,
--- liderança e limpeza. Mesmo intervalo da presença por simplicidade.
function TeamCreateWally.start()
	if enabled then
		return
	end
	enabled = true
	currentToken += 1
	local myToken = currentToken
	warnedByClientId = {}

	task.spawn(function()
		while enabled and currentToken == myToken do
			task.wait(Config.POLL_INTERVAL_SECONDS)
			if enabled and currentToken == myToken then
				TeamCreateWally.checkDrift()
			end
		end
	end)

	Logger.debug("wally: ciclo de comparação iniciado.")
end

function TeamCreateWally.stop()
	enabled = false
	currentToken += 1
	ownFingerprint = ""
	warnedByClientId = {}
	sessionsFolder = nil
end

return TeamCreateWally
