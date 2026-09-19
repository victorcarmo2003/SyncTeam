#!/usr/bin/env bash
# Bancada do sentido Studio -> disco.
#
# A direcao que ainda nao tinha nenhuma medicao. As outras duas baterias
# (gestos, reconexao) mexem no disco e olham o que a extensao manda; aqui e o
# contrario: o plugin falso EMITE os eventos que o Studio emitiria e o teste
# olha o que aparece no disco.
#
# Nao precisa de Studio aberto nem de ninguem digitando: os quatro eventos
# espontaneos do protocolo (scriptAdded, sourceChanged, scriptMoved,
# scriptRemoved) sao mandados pelo canal de comandos do plugin falso.
#
# ATENCAO: recarregue a janela do VS Code antes de rodar. A extensao guarda
# path->uuid entre sessoes do plugin; sem recarregar ela chega com mapeamento
# velho e os cenarios mentem (ja aconteceu, ver reconexao.sh).
#
# Uso:  bash studio-para-disco.sh [porta]
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
PORTA="${1:-1400}"
PROJ="$AQUI/projeto"
CMD="$AQUI/.comandos.jsonl"
OBS="$AQUI/.sd.jsonl"
EST="$AQUI/.sd-estado.json"
ESPERA="${ESPERA:-5}"

passou=0; falhou=0

mandar() { echo "$1" >> "$CMD"; sleep "$ESPERA"; }

no_disco() { find "$PROJ/src" -name '*.luau' 2>/dev/null | sed "s|$PROJ/src/||" | sort | tr '\n' ' '; }

conferir() { # conferir <rotulo> <caminho relativo a src> <existe|sumiu> [conteudo esperado]
	local rotulo="$1" alvo="$PROJ/src/$2" esperado="$3" texto="${4:-}"
	local ok=1 detalhe=""
	if [ "$esperado" = "existe" ]; then
		if [ ! -f "$alvo" ]; then ok=0; detalhe="nao existe"
		elif [ -n "$texto" ] && ! grep -qF "$texto" "$alvo"; then ok=0; detalhe="conteudo diferente"; fi
	else
		[ -e "$alvo" ] && { ok=0; detalhe="continua no disco"; }
	fi
	if [ "$ok" = "1" ]; then
		printf "  ok    %-46s\n" "$rotulo"; passou=$((passou+1))
	else
		printf "  FALHA %-46s (%s)\n" "$rotulo" "$detalhe"; falhou=$((falhou+1))
	fi
}

echo "== Studio -> disco, porta $PORTA =="
netstat -ano 2>/dev/null | grep -q "127.0.0.1:$PORTA .*LISTENING" || {
	echo "  extensao nao esta na $PORTA"; exit 1; }

rm -rf "$PROJ/src/server" "$PROJ/src/client" "$EST" "$OBS" "$CMD"
mkdir -p "$PROJ/src/server" "$PROJ/src/client"
sleep 2

node "$AQUI/plugin-falso.mjs" "$PORTA" "$OBS" "$EST" "$CMD" >"$AQUI/.plugin.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait 2>/dev/null' EXIT
sleep 4
kill -0 $PID 2>/dev/null || { echo "  plugin falso nao conectou: $(tail -1 "$AQUI/.plugin.log")"; exit 1; }
echo

# --- nasce no Studio ---------------------------------------------------------

echo "1. script criado no Studio"
mandar '{"kind":"scriptAdded","uuid":"sd-1","path":"ServerScriptService/server/Novo","className":"ModuleScript","source":"--!strict\nreturn { v = 1 }\n"}'
conferir "arquivo aparece no disco" "server/Novo.luau" existe

echo
echo "2. script com filho (o caso do Modux)"
mandar '{"kind":"scriptAdded","uuid":"sd-2","path":"ServerScriptService/server/Mod","className":"ModuleScript","source":"--!strict\nreturn {}\n"}'
mandar '{"kind":"scriptAdded","uuid":"sd-3","path":"ServerScriptService/server/Mod/Type","className":"ModuleScript","source":"--!strict\nexport type Public = {}\nreturn {}\n"}'
conferir "o pai virou pasta/init.luau" "server/Mod/init.luau" existe
conferir "a folha entrou ao lado" "server/Mod/Type.luau" existe

# --- muda no Studio ----------------------------------------------------------

echo
echo "3. edicao no Studio"
mandar '{"kind":"sourceChanged","uuid":"sd-1","path":"ServerScriptService/server/Novo","className":"ModuleScript","source":"--!strict\nreturn { v = 2, editado = true }\n"}'
conferir "o disco recebeu a edicao" "server/Novo.luau" existe "editado = true"

# --- move no Studio ----------------------------------------------------------

echo
echo "4. rename no Studio"
mandar '{"kind":"scriptMoved","uuid":"sd-1","oldPath":"ServerScriptService/server/Novo","newPath":"ServerScriptService/server/Renomeado","className":"ModuleScript"}'
conferir "o arquivo novo existe" "server/Renomeado.luau" existe
conferir "o antigo sumiu" "server/Novo.luau" sumiu

echo
echo "5. move entre lados no Studio"
mandar '{"kind":"scriptMoved","uuid":"sd-1","oldPath":"ServerScriptService/server/Renomeado","newPath":"StarterPlayer/StarterPlayerScripts/client/Renomeado","className":"ModuleScript"}'
conferir "apareceu no client" "client/Renomeado.luau" existe
conferir "saiu do server" "server/Renomeado.luau" sumiu

# --- some no Studio ----------------------------------------------------------

echo
echo "6. script apagado no Studio"
mandar '{"kind":"scriptRemoved","uuid":"sd-1","path":"StarterPlayer/StarterPlayerScripts/client/Renomeado"}'
conferir "sumiu do disco" "client/Renomeado.luau" sumiu

echo
echo "7. apagar o pai de uma pasta (o modulo Modux)"
mandar '{"kind":"scriptRemoved","uuid":"sd-2","path":"ServerScriptService/server/Mod"}'
conferir "o init sumiu" "server/Mod/init.luau" sumiu
conferir "a folha ainda esta la (filho nao foi apagado)" "server/Mod/Type.luau" existe

echo
echo "== resumo =="
echo "  disco final: $(no_disco)"
echo "  passou: $passou   falhou: $falhou"
echo
echo "  mensagens que a extensao MANDOU de volta (nao deveria haver eco):"
python - "$OBS" <<'PY'
import json, io, sys, collections
c = collections.Counter()
for l in io.open(sys.argv[1], encoding="utf-8"):
    d = json.loads(l)
    if d["direcao"] != "<-": continue
    k = (d["msg"] or {}).get("kind")
    if k and k not in ("ping", "watchedRoots", "listScripts", "presenceUpdate"):
        c[k] += 1
print("    " + (", ".join(f"{k}={n}" for k, n in c.most_common()) or "nenhuma"))
PY
