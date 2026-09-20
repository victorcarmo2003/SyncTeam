#!/usr/bin/env bash
# Observador dos dois discos durante a digitacao humana.
#
# A lease so engata com pulse continuo do editor: uma intencao morre em 2s sem
# renovacao (`leaseStaleAfterSeconds = 2`), e escrita por script produz uma so.
# Por isso este teste nao pode ser automatizado — quem digita e uma pessoa, em
# cada janela, e aqui so se registra o que acontece nos dois lados.
#
# Registra uma linha sempre que QUALQUER um dos dois muda, com hora e um
# resumo do conteudo. O que se procura e texto que aparece de um lado e some
# sem nunca ter chegado no outro.
#
# Ctrl+C para parar.
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
FA="$AQUI/projeto/src/server/Disputa/init.luau"
FB="$AQUI/devB/src/server/Disputa/init.luau"
LOG="$AQUI/.lease-humano.log"

: > "$LOG"
resumo() { # so as linhas que a pessoa digitou, sem o esqueleto
	[ -f "$1" ] || { echo "(ausente)"; return; }
	grep -vE '^(--!strict|local Disputa = \{\}|return Disputa|\s*)$' "$1" | tr '\n' '/' | cut -c1-70
}

echo "monitorando. Ctrl+C para parar."
echo "  A: ${FA#$AQUI/}"
echo "  B: ${FB#$AQUI/}"
echo

ha=""; hb=""
while :; do
	na=$(md5sum "$FA" 2>/dev/null | cut -c1-8)
	nb=$(md5sum "$FB" 2>/dev/null | cut -c1-8)
	if [ "$na" != "$ha" ] || [ "$nb" != "$hb" ]; then
		quem=""
		[ "$na" != "$ha" ] && quem="A"
		[ "$nb" != "$hb" ] && quem="${quem}${quem:+ e }B"
		linha="[$(date '+%H:%M:%S')] mudou: $quem
    A: $(resumo "$FA")
    B: $(resumo "$FB")
    iguais: $([ "$na" = "$nb" ] && echo SIM || echo NAO)"
		echo "$linha" | tee -a "$LOG"
		ha=$na; hb=$nb
	fi
	sleep 0.5
done
