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
-- gargalo para testes autônomos. Este módulo centraliza log() e, ADICIONAL ao
-- print() de sempre (comportamento inalterado, continua aparecendo no Output
-- do Studio normalmente, com a MESMA chamada `print(prefix, ...)` de antes),
-- encaminha o texto renderizado pela conexão WS já existente (mesmo
-- `sendMessage` injetado por SourceWatcher.init/TeamCreateLease.init) como
-- `{kind = "log", text = "<string>"}`. O lado da extensão/harness (tarefa
-- paralela de outro agente, extension-dev) grava isso em arquivo — permite ler
-- o log via Read sem depender do usuário nem do Studio Output.
--
-- Formato do PREFIXO mantido IDÊNTICO ao anterior de propósito
-- ("[SyncTeam HH:MM:SS]") — docs/PROJECT_STATUS.md e docs/DECISIONS.md citam
-- esse prefixo literalmente em várias entradas, e o `print(prefix, ...)`
-- continua sendo a MESMA chamada de antes (não foi reescrito/reformatado) —
-- só passou a viver aqui em vez de duplicado em 6 arquivos.
--
-- Reconstrução do campo `text` enviado por WS: `prefix .. " " .. tostring(a1)
-- .. " " .. tostring(a2) ...` (espaço como separador). Isso é uma
-- RECONSTRUÇÃO best-effort do conteúdo, não uma cópia byte-a-byte do que o
-- Output do Studio renderiza internamente para múltiplos argumentos de
-- `print` (separador exato do Output não documentado/verificado nesta tarefa,
-- `[Hipótese]`) — irrelevante para o objetivo (observabilidade de teste), já
-- que o `print(...)` em si (o que aparece no Output) não foi alterado nem
-- reformatado.
--
-- Sem fila/buffer: mensagens de log perdidas enquanto desconectado não são um
-- problema (objetivo é só observabilidade em tempo real durante teste, não
-- log persistente garantido) — mesmo espírito de `sendMessage` em
-- init.server.luau, que também descarta silenciosamente sem conexão.
--
-- CUIDADO DE RECURSÃO (ver init.server.luau): `sendMessage` (a função que
-- efetivamente envia pela conexão WS, definida em init.server.luau) loga
-- internamente quando descarta uma mensagem (sem conexão) ou falha ao
-- enviar. Esses dois logs internos usam `print` PURO ali, NUNCA
-- `Logger.log`/`log` — se usassem, uma falha de envio disparia: Logger.log
-- -> sendMessage -> (falha) -> log da falha via Logger.log -> sendMessage de
-- novo -> ciclo sem saída natural (a cada tentativa gera uma nova mensagem de
-- log sobre a tentativa anterior). Ver comentário em init.server.luau.
--
-- M4.5 (painel de status, plugin/src/ui/): adicionado `Logger.notify(...)`,
-- uma segunda via de injeção (`Logger.initNotify`) paralela a `Logger.init`.
-- Motivo de não reusar o mesmo callback de `sendMessage`/`Logger.init`: aquele
-- é especificamente "encaminhar como {kind='log'} pela conexão WS" (canal de
-- observabilidade de teste, ver cabeçalho acima); este é "isto é
-- toast-worthy" (canal de UX dentro do próprio Studio, sem relação com WS).
-- `Logger.notify(...)` SEMPRE faz exatamente o que `Logger.log(...)` já
-- fazia (print + forward por WS, incondicional — spec da tarefa: "o log no
-- Output NUNCA é condicionado" à preferência de notificação) e, ADICIONALMENTE,
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
-- (e sempre que a conexão cair), Logger.log só faz o print — sem erro.
local sendMessage = nil

-- callback(text: string), injetado por Logger.initNotify (M4.5) — nil até
-- init.server.luau chamar Logger.initNotify(PluginUI.notify), dentro de
-- start() (mesmo lugar/ordem de Logger.init). Nesse intervalo, Logger.notify
-- se comporta exatamente como Logger.log (só não há ninguém para avisar).
local onNotify = nil

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
-- prefixo, imprime CONDICIONALMENTE (`shouldPrint`, ver Logger.debug abaixo),
-- encaminha por WS se houver sendMessage injetado (SEMPRE, print ou não — a
-- observabilidade de teste automatizado nunca depende do que aparece no
-- Output do Studio, ver Tools/README.md), e devolve o texto renderizado (para
-- Logger.notify repassar ao callback de notify sem reconstruir a string).
local function render(shouldPrint, ...)
	local prefix = ("[SyncTeam %s]"):format(os.date("%H:%M:%S"))
	if shouldPrint then
		print(prefix, ...)
	end

	local count = select("#", ...)
	local text = prefix
	for index = 1, count do
		local value = select(index, ...)
		text = text .. " " .. tostring(value)
	end

	if sendMessage ~= nil then
		sendMessage({ kind = "log", text = text })
	end

	return text
end

-- Mesma assinatura/comportamento de todo `log(...)` que existia espalhado
-- pelos 6 arquivos: aceita qualquer número de argumentos, formata com o
-- mesmo prefixo de sempre e imprime. Adicionalmente, se houver um
-- `sendMessage` injetado, encaminha o texto renderizado como mensagem
-- espontânea `{kind = "log", text = ...}` — melhor esforço, nunca lança erro
-- nem enfileira nada.
function Logger.log(...)
	render(true, ...)
end

-- 2026-07-16 (consolidação de ruído de boot, pedido do usuário após teste
-- real: rajada de ~7 linhas de subsistema a cada conexão). Mesmo forward por
-- WS de Logger.log (Tools/README.md continua enxergando tudo, observabilidade
-- de teste automatizado intacta), mas SEM `print()` — não aparece no Output
-- do Studio. Uso: eventos de inicialização de subsistema que são informação
-- ROTINEIRA (reconciliação de registry, ciclos internos iniciados/parados,
-- tentativa otimista de conexão antes de estabilizar) — nunca para eventos
-- que o usuário precisa perceber sem abrir um log externo (erro real, mudança
-- de liderança, lease negada — esses continuam Logger.log/Logger.notify).
function Logger.debug(...)
	render(false, ...)
end

-- Igual a Logger.log (mesmo print, mesmo forward por WS, SEMPRE — nunca
-- condicionado a preferência nenhuma), e ADICIONALMENTE chama o callback de
-- notify injetado (se houver) com o texto renderizado — melhor esforço,
-- protegido por pcall (a UI pode falhar por qualquer motivo de Instance/
-- Tween; uma falha ali nunca pode derrubar quem chamou Logger.notify no meio
-- de lógica de coordenação real). Usar SÓ nos poucos pontos já identificados
-- como "merece toast" (ver cabeçalho do arquivo) — todo o resto continua
-- `Logger.log`.
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
