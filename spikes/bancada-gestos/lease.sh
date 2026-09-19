#!/usr/bin/env bash
# Bancada de lease.
#
# A lease e o que separa o SyncTeam do Azul: la, dois editando o mesmo arquivo
# divergem em silencio (medido, 2 de 3 tentativas). Aqui existe um dono
# temporario por arquivo.
#
# A aplicacao mora no PLUGIN, nao na extensao — `TeamCreateLease.canWrite` no
# handleWriteSource, que responde `writeAck ok=false, "lease negada"`. A
# extensao manda otimista e trata a recusa. Entao, do lado da extensao, uma
# lease negada e so um ack de falha, e e isso que esta bancada reproduz: sem
# dois Studios em Team Create, sem eleicao de lease, so o efeito que a
# extensao enxerga.
#
# O que se quer saber: depois de uma recusa, aquela edicao ainda consegue
# chegar ao Studio quando a lease libera? Ate 2026-09-19 a resposta era NAO —
# o contentCache era gravado antes do envio, entao a recusa deixava o cache
# afirmando "ja sincronizei" e toda tentativa seguinte com o mesmo conteudo
# batia no early-return de eco. O colega soltava o arquivo e a sua edicao
# continuava perdida, sem nada avisar.
#
# ATENCAO: recarregue a janela do VS Code antes de rodar.
#
# Uso:  bash lease.sh [porta]
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
PORTA="${1:-1400}"
PROJ="$AQUI/projeto"
CMD="$AQUI/.cmd-lease.jsonl"
OBS="$AQUI/.lease.jsonl"
EST="$AQUI/.lease-estado.json"
ESPERA="${ESPERA:-5}"

passou=0; falhou=0
marca() { date +%s%3N; }

negar() { echo "{\"kind\":\"__negar\",\"valor\":$1}" >> "$CMD"; sleep 1; }

enviados_desde() {
	python - "$OBS" "$1" <<'PY'
import json, io, sys
corte = int(sys.argv[2]); out = []
for l in io.open(sys.argv[1], encoding="utf-8"):
    d = json.loads(l)
    if d["t"] < corte or d["direcao"] != "<-": continue
    m = d["msg"] or {}
    if m.get("kind") == "writeSource":
        out.append("criar" if not m.get("uuid") else "atualizar")
print(",".join(out) if out else "(nenhum)")
PY
}

confere() { # confere <rotulo> <esperado> <obtido>
	if [ "$2" = "$3" ]; then
		printf "  ok    %-44s %s\n" "$1" "$3"; passou=$((passou+1))
	else
		printf "  FALHA %-44s esperado=%s obtido=%s\n" "$1" "$2" "$3"; falhou=$((falhou+1))
	fi
}

echo "== lease, porta $PORTA =="
netstat -ano 2>/dev/null | grep -q "127.0.0.1:$PORTA .*LISTENING" || { echo "  extensao fora da $PORTA"; exit 1; }

rm -rf "$PROJ/src/server" "$PROJ/src/client" "$EST" "$OBS" "$CMD"
mkdir -p "$PROJ/src/server"; sleep 2

node "$AQUI/plugin-falso.mjs" "$PORTA" "$OBS" "$EST" "$CMD" >"$AQUI/.plugin.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait 2>/dev/null' EXIT
sleep 4
kill -0 $PID 2>/dev/null || { echo "  plugin falso nao conectou"; exit 1; }
echo

# --- 1. baseline: com a lease livre, a criacao passa ------------------------

echo "1. lease livre"
t=$(marca)
mkdir -p "$PROJ/src/server/Disputado"
printf -- '--!strict\nreturn { v = 1 }\n' > "$PROJ/src/server/Disputado/init.luau"
printf -- '--!strict\nreturn {}\n' > "$PROJ/src/server/Disputado/Type.luau"
sleep "$ESPERA"
confere "criacao chega no Studio" "criar,criar" "$(enviados_desde $t)"

# --- 2. o colega pega a lease -----------------------------------------------

echo
echo "2. o colega pegou o arquivo (writeAck ok=false)"
negar true
t=$(marca)
printf -- '--!strict\nreturn { v = 2, meu = "trabalho" }\n' > "$PROJ/src/server/Disputado/init.luau"
sleep "$ESPERA"
confere "a extensao tenta mandar mesmo assim" "atualizar" "$(enviados_desde $t)"
echo "     (otimista de proposito: quem recusa e o plugin, nao ela)"

# --- 3. a lease libera e eu salvo o MESMO conteudo --------------------------

echo
echo "3. a lease liberou; salvo de novo o MESMO conteudo"
negar false
t=$(marca)
# `touch` nao basta: o watcher so dispara com mudanca de conteudo. Reescrever
# o mesmo texto e o que um save real faz depois de o editor ja ter o buffer.
printf -- '--!strict\nreturn { v = 2, meu = "trabalho" }\n' > "$PROJ/src/server/Disputado/init.luau"
sleep "$ESPERA"
obtido="$(enviados_desde $t)"
confere "a edicao recusada consegue ir embora" "atualizar" "$obtido"
if [ "$obtido" = "(nenhum)" ]; then
	echo "     >> e o cache envenenado: a edicao ficou presa para sempre"
fi

# --- 4. e uma edicao NOVA depois da recusa ----------------------------------

echo
echo "4. edicao nova depois da recusa"
t=$(marca)
printf -- '--!strict\nreturn { v = 3 }\n' > "$PROJ/src/server/Disputado/init.luau"
sleep "$ESPERA"
confere "conteudo novo chega" "atualizar" "$(enviados_desde $t)"

# --- 5. o Studio ficou com o que? -------------------------------------------

echo
echo "== resumo =="
echo "  o 'Studio' guardou:"
python - "$EST" <<'PY'
import json, io, sys
d = json.load(io.open(sys.argv[1], encoding="utf-8"))
for s in sorted(d["scripts"].values(), key=lambda x: x["path"]):
    corpo = (s.get("source") or "").strip().replace("\n", " | ")
    print(f"    {s['path']}: {corpo[:60]}")
PY
echo "  disco: $(grep -o 'v = [0-9]' "$PROJ/src/server/Disputado/init.luau" 2>/dev/null)"
echo
echo "  passou: $passou   falhou: $falhou"
