#!/usr/bin/env bash
# Bancada de reconexao do SyncTeam.
#
# A pergunta: o que acontece com o disco e com o Studio quando o plugin cai,
# alguma coisa muda enquanto ele esta fora, e ele volta?
#
# E onde eu aposto que mora a duplicata relatada (DECISIONS.md: "modulos/pastas
# duplicados aparecendo no VS Code de outro dev"). Na bancada de gestos nao
# apareceu nenhuma, mas la nunca houve reconexao nem estado divergente — o
# plugin conectava uma vez e ficava.
#
# Dois tipos de volta, e eles nao sao a mesma coisa:
#
#   LEMBRANDO   o Studio volta com os mesmos uuids. E o caso comum: o plugin
#               caiu, a place continua aberta, nada se perdeu la.
#   ESQUECENDO  o Studio volta sem saber de nada, uuids novos. Place reaberta,
#               Studio reiniciado, outro dev entrando pela primeira vez.
#
# O segundo e o suspeito: se a extensao ve "script desconhecido com path X" e
# o disco JA tem X registrado sob outro uuid, ou ela reaproveita, ou duplica.
#
# Uso:  bash reconexao.sh [porta]
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
PORTA="${1:-1400}"
PROJ="$AQUI/projeto"
ESPERA="${ESPERA:-6}"

PID=""
subir() { # subir <saida.jsonl> [estado.json]
	node "$AQUI/plugin-falso.mjs" "$PORTA" "$1" ${2:+"$2"} >"$AQUI/.plugin.log" 2>&1 &
	PID=$!
	sleep 4
	kill -0 $PID 2>/dev/null || { echo "  !! plugin falso nao conectou: $(tail -1 "$AQUI/.plugin.log")"; exit 1; }
}
descer() { kill $PID 2>/dev/null; wait 2>/dev/null; sleep 2; PID=""; }
trap 'descer' EXIT

resumo() { # resumo <saida.jsonl> <rotulo>
	python - "$1" "$2" <<'PY'
import json, io, sys, collections
kinds = collections.Counter(); criados = collections.Counter(); apagados = []
for l in io.open(sys.argv[1], encoding="utf-8"):
    d = json.loads(l)
    if d["direcao"] != "<-": continue
    m = d["msg"] or {}; k = m.get("kind")
    if not k or k in ("ping",): continue
    kinds[k] += 1
    if k == "writeSource" and not m.get("uuid"): criados[m.get("path")] += 1
    if k == "deleteScript": apagados.append(m.get("uuid"))
print(f"  [{sys.argv[2]}] " + (", ".join(f"{k}={n}" for k, n in kinds.most_common()) or "nada"))
dup = {p: n for p, n in criados.items() if n > 1}
if dup:
    print(f"    DUPLICATA: mesmo path criado mais de uma vez -> {json.dumps(dup)}")
PY
}

no_disco() { find "$PROJ/src" -name '*.luau' 2>/dev/null | sed "s|$PROJ/src/||" | sort | tr '\n' ' '; }

modulo() {
	mkdir -p "$PROJ/src/$1/$2"
	printf -- '--!strict\nlocal M = {}\nfunction M:Eco(n: number) return n end\nreturn M\n' > "$PROJ/src/$1/$2/init.luau"
	printf -- '--!strict\nexport type Public = {}\nreturn {}\n' > "$PROJ/src/$1/$2/Type.luau"
}

echo "== bancada de reconexao, porta $PORTA =="
netstat -ano 2>/dev/null | grep -q "127.0.0.1:$PORTA .*LISTENING" || {
	echo "  extensao nao esta na $PORTA — abra $PROJ no VS Code"; exit 1; }

rm -rf "$PROJ/src/server" "$PROJ/src/client" "$AQUI"/.estado*.json "$AQUI"/.rec*.jsonl
mkdir -p "$PROJ/src/server" "$PROJ/src/client"
sleep 2
echo

# --------------------------------------------------------------------------
echo "1. primeira conexao: cria dois modulos"
subir "$AQUI/.rec1.jsonl" "$AQUI/.estado.json"
modulo server Alfa
modulo server Beta
sleep "$ESPERA"
resumo "$AQUI/.rec1.jsonl" "conexao 1"
echo "    disco: $(no_disco)"
descer
echo

# --------------------------------------------------------------------------
echo "2. volta LEMBRANDO, sem nada ter mudado (deveria ser no-op)"
subir "$AQUI/.rec2.jsonl" "$AQUI/.estado.json"
sleep "$ESPERA"
resumo "$AQUI/.rec2.jsonl" "conexao 2"
echo "    disco: $(no_disco)"
descer
echo

# --------------------------------------------------------------------------
echo "3. offline: some um modulo, nasce outro, um terceiro e editado"
rm -rf "$PROJ/src/server/Alfa"
modulo server Gama
printf -- '\n-- editado offline\n' >> "$PROJ/src/server/Beta/init.luau"
echo "    disco antes de reconectar: $(no_disco)"
echo "    volta LEMBRANDO"
subir "$AQUI/.rec3.jsonl" "$AQUI/.estado.json"
sleep "$ESPERA"
resumo "$AQUI/.rec3.jsonl" "conexao 3"
echo "    disco: $(no_disco)"
descer
echo

# --------------------------------------------------------------------------
echo "4. volta ESQUECENDO (uuids novos, como Studio reaberto)"
subir "$AQUI/.rec4.jsonl"
sleep "$ESPERA"
resumo "$AQUI/.rec4.jsonl" "conexao 4"
echo "    disco: $(no_disco)"
descer
echo

# --------------------------------------------------------------------------
echo "5. duas reconexoes seguidas, rapidas"
subir "$AQUI/.rec5a.jsonl" "$AQUI/.estado.json"
sleep 2
descer
subir "$AQUI/.rec5b.jsonl" "$AQUI/.estado.json"
sleep "$ESPERA"
resumo "$AQUI/.rec5a.jsonl" "conexao 5a (2s)"
resumo "$AQUI/.rec5b.jsonl" "conexao 5b"
echo "    disco: $(no_disco)"
descer
echo

echo "== estado final =="
echo "  disco: $(no_disco)"
echo "  arquivos duplicados por nome (mesmo modulo em dois lugares):"
find "$PROJ/src" -name 'init.luau' 2>/dev/null | sed "s|.*/src/||" | awk -F/ '{print $NF" "$0}' | sort | uniq -d -w20 | sed 's/^/    /' || true
python - "$AQUI"/.rec*.jsonl <<'PY'
import json, io, sys, collections
tot = collections.Counter()
for p in sys.argv[1:]:
    for l in io.open(p, encoding="utf-8"):
        d = json.loads(l)
        if d["direcao"] != "<-": continue
        m = d["msg"] or {}; k = m.get("kind")
        if k and k != "ping": tot[k] += 1
print("  total em todas as conexoes: " + ", ".join(f"{k}={n}" for k, n in tot.most_common()))
PY
