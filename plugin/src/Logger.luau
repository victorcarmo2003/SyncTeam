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

local Logger = {}

-- callback(message: table), injetado por Logger.init — mesmo padrão já usado
-- em SourceWatcher.init(sendMessage)/TeamCreateLease.init(sendMessage). nil
-- até init.server.luau chamar Logger.init dentro de start(); nesse intervalo
-- (e sempre que a conexão cair), Logger.log só faz o print — sem erro.
local sendMessage = nil

-- Injeta o callback de envio espontâneo. Chamado por init.server.luau, no
-- mesmo lugar/ordem em que já chama SourceWatcher.init(sendMessage)/
-- TeamCreateLease.init(sendMessage), dentro de start().
function Logger.init(onMessage)
	sendMessage = onMessage
end

-- Mesma assinatura/comportamento de todo `log(...)` que existia espalhado
-- pelos 6 arquivos: aceita qualquer número de argumentos, formata com o
-- mesmo prefixo de sempre e imprime. Adicionalmente, se houver um
-- `sendMessage` injetado, encaminha o texto renderizado como mensagem
-- espontânea `{kind = "log", text = ...}` — melhor esforço, nunca lança erro
-- nem enfileira nada.
function Logger.log(...)
	local prefix = ("[SyncTeam %s]"):format(os.date("%H:%M:%S"))

	-- Chamada IDÊNTICA à que já existia em cada arquivo (print(prefix, ...)) —
	-- garante que o Output do Studio continua exatamente igual a antes desta
	-- tarefa.
	print(prefix, ...)

	if sendMessage ~= nil then
		local count = select("#", ...)
		local text = prefix
		for index = 1, count do
			local value = select(index, ...)
			text = text .. " " .. tostring(value)
		end
		sendMessage({ kind = "log", text = text })
	end
end

return Logger
