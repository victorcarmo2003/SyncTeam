-- SyncTeam — Logger centralizado (observabilidade de teste automatizado)
--
-- Motivação (pedido do orquestrador, 2026-07-07): antes desta tarefa, 6
-- módulos do plugin (init.server.luau, TeamCreateElection.luau,
-- TeamCreateSchema.luau, TeamCreateLease.luau, ScriptRegistry.luau,
-- SourceWatcher.luau) tinham cada um sua PRÓPRIA função local `log(...)`,
-- todas idênticas:
--   local function log(...)
--       print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), ...)
--   end
-- Isso obrigava o orquestrador/IA a depender do usuário colar manualmente o
-- painel Output do Studio para saber o que acontece durante um teste — um
-- gargalo para testes autônomos. Este módulo centraliza log() e encaminha o
-- texto renderizado pela conexão WS já existente (mesmo `sendMessage`
-- injetado por SourceWatcher.init/TeamCreateLease.init) como
-- `{kind = "log", text = "<string>"}`. O lado da extensão/harness (tarefa
-- paralela de outro agente, extension-dev) grava isso em arquivo — permite ler
-- o log via Read sem depender do usuário nem do Studio Output.
--
-- 2026-08-02 (pedido do usuário: "limpar os prints do Output, pode retirar
-- todos"): `render()` (abaixo) PAROU de chamar `print()` para QUALQUER
-- caminho (log/notify/debug) — até esta data, só Logger.debug (ver histórico
-- mais abaixo) deixava de imprimir; agora NENHUM dos três imprime no Output
-- do Studio. O encaminhamento por WS (parágrafo acima) e o toast de
-- Logger.notify (ver mais abaixo) estão INTOCADOS — a observabilidade de
-- teste automatizado e a UX de notificação continuam idênticas, só o Output
-- cru ficou quieto. Ver docs/DECISIONS.md 2026-08-02 para a decisão
-- completa, incluindo o que foi feito com os dois `print()` crus de
-- init.server.luau (sendMessage) que NÃO passam por este módulo.
--
-- Formato do PREFIXO mantido IDÊNTICO ao original de propósito
-- ("[SyncTeam HH:MM:SS]") — docs/PROJECT_STATUS.md e docs/DECISIONS.md citam
-- esse prefixo literalmente em várias entradas. Até 2026-08-02, `render()`
-- também fazia `print(prefix, ...)` com essa MESMA chamada (não reescrita/
-- reformatada) — removida nesta data (ver histórico acima), mas o formato do
-- prefixo em si não mudou, já que o texto continua sendo enviado por WS e
-- reaproveitado por `Logger.notify`/`lastMessageText`.
--
-- Reconstrução do campo `text` enviado por WS: `prefix .. " " .. tostring(a1)
-- .. " " .. tostring(a2) ...` (espaço como separador). Isso é uma
-- RECONSTRUÇÃO best-effort do conteúdo, não uma cópia byte-a-byte do que o
-- Output do Studio renderizava internamente para múltiplos argumentos de
-- `print` (separador exato do Output não documentado/verificado nesta tarefa,
-- `[Hipótese]`) — irrelevante para o objetivo (observabilidade de teste), já
-- que hoje não há mais nenhum `print(...)` para comparar.
--
-- Sem fila/buffer: mensagens de log perdidas enquanto desconectado não são um
-- problema (objetivo é só observabilidade em tempo real durante teste, não
-- log persistente garantido) — mesmo espírito de `sendMessage` em
-- init.server.luau, que também descarta silenciosamente sem conexão.
--
-- CUIDADO DE RECURSÃO (ver init.server.luau): `sendMessage` (a função que
-- efetivamente envia pela conexão WS, definida em init.server.luau) loga
-- internamente quando a chamada real de `:Send()` lança erro (WS parecia
-- vivo mas quebrou). Esse log usa `print` PURO ali, NUNCA `Logger.log`/`log`
-- — se usasse, uma falha de envio disparia: Logger.log -> sendMessage ->
-- (a MESMA falha de novo, ainda quebrada) -> log da falha via Logger.log ->
-- sendMessage de novo -> ciclo sem saída natural (este branch não tem
-- nenhum guard por `kind` para interromper, ao contrário do branch de "sem
-- conexão" logo acima dele).
-- 2026-08-02: o OUTRO print cru que existia ali (mensagem descartada porque
-- `client == nil`) foi REMOVIDO por completo, não só mantido puro — ver
-- init.server.luau e docs/DECISIONS.md para a distinção entre os dois casos
-- (aquele era ruído de alta frequência sem perda real de observabilidade,
-- já que sem conexão o encaminhamento por WS também está indisponível por
-- definição; este continua sendo o único canal restante quando o próprio
-- envio falha).
--
-- M4.5 (painel de status, plugin/src/ui/): adicionado `Logger.notify(...)`,
-- uma segunda via de injeção (`Logger.initNotify`) paralela a `Logger.init`.
-- Motivo de não reusar o mesmo callback de `sendMessage`/`Logger.init`: aquele
-- é especificamente "encaminhar como {kind='log'} pela conexão WS" (canal de
-- observabilidade de teste, ver cabeçalho acima); este é "isto é
-- toast-worthy" (canal de UX dentro do próprio Studio, sem relação com WS).
-- `Logger.notify(...)` SEMPRE faz exatamente o que `Logger.log(...)` já
-- fazia (forward por WS + tracking da linha INFO do painel, incondicional —
-- spec da tarefa original: "o log NUNCA é condicionado" à preferência de
-- notificação; até 2026-08-02 isso incluía também o print no Output, ver
-- histórico no topo do arquivo) e, ADICIONALMENTE,
-- chama o callback de notify (se injetado) com o texto renderizado — quem
-- injeta (PluginUI.notify, ver plugin/src/ui/PluginUI.luau) decide se anima
-- um toast visível, olhando a preferência "Mostrar notificações"
-- (Config.NOTIFICATIONS_SETTING_KEY) — essa decisão fica INTEIRAMENTE do lado
-- de UI, nunca aqui. Só os poucos call-sites já identificados como "erro
-- genuíno" (não evento rotineiro) foram trocados de `log(...)` para
-- `notify(...)`: ver TeamCreateSchema.luau (reconciliação de duplicata) e
-- init.server.luau (lease negada, falha de reconexão WS).

local Logger = {}

-- callback(message: table), injetado por Logger.init — mesmo padrão já usado
-- em SourceWatcher.init(sendMessage)/TeamCreateLease.init(sendMessage). nil
-- até init.server.luau chamar Logger.init dentro de start(); nesse intervalo
-- (e sempre que a conexão cair), Logger.log só monta o texto e (se
-- `trackPanel`) atualiza a linha INFO do painel — sem erro, mesmo sem ter
-- para onde encaminhar.
local sendMessage = nil

-- callback(text: string), injetado por Logger.initNotify (M4.5) — nil até
-- init.server.luau chamar Logger.initNotify(PluginUI.notify), dentro de
-- start() (mesmo lugar/ordem de Logger.init). Nesse intervalo, Logger.notify
-- se comporta exatamente como Logger.log (só não há ninguém para avisar).
local onNotify = nil

-- Item 1 da tarefa 2026-07-21 (linha INFO do painel, no gap entre o título e
-- o campo Porta — ver StatusPanel.luau/PluginUI.luau): guarda a ÚLTIMA
-- mensagem de Logger.log/Logger.notify (parâmetro `trackPanel == true`
-- dentro de render() abaixo — exclui Logger.debug de propósito, já que
-- aquele nunca deveria alimentar a linha que o usuário vê no painel) e o
-- instante (os.clock()) em que foi registrada. 2026-08-02: até esta data o
-- mesmo parâmetro também controlava o `print()` no Output ("mensagem
-- IMPRESSA"); agora nenhuma das três funções imprime, então o parâmetro só
-- decide se a mensagem alimenta esta linha do painel — renomeado de
-- `shouldPrint` para `trackPanel` para não sugerir mais nenhuma relação com
-- o Output. Exposto só por getter (Logger.getLastMessage(), abaixo) em vez
-- de mais um callback injetado — quem consome (PluginUI.luau) faz POLLING
-- periódico (task.wait(1)), mesma disciplina de ".claude/rules/luau.md"
-- ("polling periódico... como caminho garantido") em vez de depender de um
-- push que precisaria de mais uma camada de wiring em start()/
-- init.server.luau. `lastMessageText` guarda só o texto da mensagem (SEM o
-- prefixo "[SyncTeam HH:MM:SS]") — o prefixo já é um timestamp absoluto,
-- redundante com o contador de segundos decorridos que a UI deriva de
-- `lastMessageAt`.
local lastMessageText = nil
local lastMessageAt = nil

-- Injeta o callback de envio espontâneo. Chamado por init.server.luau, no
-- mesmo lugar/ordem em que já chama SourceWatcher.init(sendMessage)/
-- TeamCreateLease.init(sendMessage), dentro de start().
function Logger.init(onMessage)
	sendMessage = onMessage
end

-- Injeta o callback de notificação visual (M4.5). Chamado por
-- init.server.luau dentro de start(), ao lado de Logger.init.
function Logger.initNotify(callback)
	onNotify = callback
end

-- Núcleo compartilhado de Logger.log/Logger.debug/Logger.notify: monta o
-- prefixo, NUNCA imprime no Output do Studio (2026-08-02 — antes desta data
-- só Logger.debug pulava o print(); ver histórico no topo do arquivo),
-- encaminha por WS se houver sendMessage injetado (SEMPRE, incondicional — a
-- observabilidade de teste automatizado nunca dependeu do Output do Studio,
-- ver Tools/README.md, e continua não dependendo), e devolve o texto
-- renderizado (para Logger.notify repassar ao callback de notify sem
-- reconstruir a string).
local function render(trackPanel, ...)
	local prefix = ("[SyncTeam %s]"):format(os.date("%H:%M:%S"))

	local count = select("#", ...)
	local text = prefix
	-- `messageOnly` é a MESMA concatenação que monta `text`, só sem o
	-- prefixo — ver comentário de `lastMessageText` acima sobre o porquê de
	-- guardar as duas formas separadas.
	local messageOnly = ""
	for index = 1, count do
		local value = select(index, ...)
		text = text .. " " .. tostring(value)
		messageOnly = messageOnly .. (if index > 1 then " " else "") .. tostring(value)
	end

	if sendMessage ~= nil then
		sendMessage({ kind = "log", text = text })
	end

	-- Só Logger.log/Logger.notify (`trackPanel == true`) alimentam a linha
	-- INFO do painel — Logger.debug nunca deveria aparecer pro usuário, nem
	-- aqui.
	if trackPanel then
		lastMessageText = messageOnly
		lastMessageAt = os.clock()
	end

	return text
end

-- Getter read-only (poll-based, ver comentário de `lastMessageText` acima)
-- usado por PluginUI.luau para alimentar a linha INFO do painel de status
-- (item 1 da tarefa 2026-07-21). Devolve `nil, nil` se nenhuma chamada de
-- Logger.log/Logger.notify (`trackPanel == true`) ainda ocorreu nesta sessão
-- do plugin — StatusPanel/PluginUI tratam isso com um placeholder (ver
-- PluginUI.luau).
function Logger.getLastMessage()
	return lastMessageText, lastMessageAt
end

-- Mesma assinatura/comportamento de todo `log(...)` que existia espalhado
-- pelos 6 arquivos originalmente, MENOS o print() no Output (removido
-- 2026-08-02, ver histórico no topo do arquivo): aceita qualquer número de
-- argumentos, formata com o mesmo prefixo de sempre, alimenta a linha INFO
-- do painel (`trackPanel = true`) e, se houver um `sendMessage` injetado,
-- encaminha o texto renderizado como mensagem espontânea `{kind = "log",
-- text = ...}` — melhor esforço, nunca lança erro nem enfileira nada.
function Logger.log(...)
	render(true, ...)
end

-- 2026-07-16 (consolidação de ruído de boot, pedido do usuário após teste
-- real: rajada de ~7 linhas de subsistema a cada conexão). Mesmo forward por
-- WS de Logger.log (Tools/README.md continua enxergando tudo, observabilidade
-- de teste automatizado intacta). Uso: eventos de inicialização de
-- subsistema que são informação ROTINEIRA (reconciliação de registry, ciclos
-- internos iniciados/parados, tentativa otimista de conexão antes de
-- estabilizar) — nunca para eventos que o usuário precisa perceber (erro
-- real, mudança de liderança, lease negada — esses continuam
-- Logger.log/Logger.notify).
-- 2026-08-02: até esta data, esta era a ÚNICA das três funções que não
-- imprimia no Output do Studio (Logger.log/Logger.notify imprimiam) — a
-- distinção agora é só `trackPanel` (`false` aqui, `true` em log/notify): se
-- a mensagem alimenta ou não a linha INFO do painel (ver StatusPanel.luau/
-- PluginUI.luau). Nenhuma das três imprime mais no Output — ver histórico no
-- topo do arquivo e docs/DECISIONS.md.
function Logger.debug(...)
	render(false, ...)
end

-- Igual a Logger.log (mesmo forward por WS, SEMPRE — nunca condicionado a
-- preferência nenhuma; até 2026-08-02 também imprimia, ver histórico no topo
-- do arquivo), e ADICIONALMENTE chama o callback de notify injetado (se
-- houver) com o texto renderizado — melhor esforço, protegido por pcall (a
-- UI pode falhar por qualquer motivo de Instance/Tween; uma falha ali nunca
-- pode derrubar quem chamou Logger.notify no meio de lógica de coordenação
-- real). Usar SÓ nos poucos pontos já identificados como "merece toast" (ver
-- cabeçalho do arquivo) — todo o resto continua `Logger.log`.
function Logger.notify(...)
	local text = render(true, ...)
	if onNotify ~= nil then
		local ok, err = pcall(onNotify, text)
		if not ok then
			print(("[SyncTeam %s]"):format(os.date("%H:%M:%S")), "falha ao notificar UI:", tostring(err))
		end
	end
end

return Logger
