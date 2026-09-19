#!/usr/bin/env bash
# Bancada de gestos do SyncTeam.
#
# Duas licoes desta sessao estao embutidas aqui.
#
# A primeira: medindo o Rojo eu testei so com `rm -rf` e conclui "apagar uma
# pasta derruba o watcher". Errado — o Delete do VS Code manda para a LIXEIRA,
# que no Windows e um move, e move sobrevive. A fronteira real era mover
# contra desvincular. Entao aqui cada operacao e feita das DUAS formas.
#
# A segunda: a primeira versao deste arnez criava `Foo/init.luau` e depois
# mexia nesse caminho. So que a extensao NORMALIZA um init.luau sem irmaos
# para `Foo.luau` (em Rojo sao a mesma instancia), e todos os gestos seguintes
# batiam em caminho inexistente — metade da matriz nao rodou e eu nem percebi
# ate ler os erros. Agora nada assume forma: `alvo` le o disco antes de cada
# gesto.
#
# O `plugin-falso.mjs` ocupa o lugar do plugin do Studio e registra o que a
# extensao emite, entao nao e preciso Studio aberto.
#
# Uso:  bash gestos.sh [porta]
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
PORTA="${1:-${SYNCTEAM_PORT:-1400}}"
PROJ="$AQUI/projeto"
OBS="$AQUI/observado.jsonl"
ESPERA="${ESPERA:-5}"

# --- utilidades --------------------------------------------------------------

# Onde o modulo esta AGORA: pasta com init.luau, ou arquivo solto. Nunca
# assumir — foi assim que a rodada anterior se perdeu.
alvo() {
	local lado="$1" nome="$2"
	if [ -d "$PROJ/src/$lado/$nome" ]; then echo "$PROJ/src/$lado/$nome"
	elif [ -f "$PROJ/src/$lado/$nome.luau" ]; then echo "$PROJ/src/$lado/$nome.luau"
	else echo ""; fi
}

forma() {
	local p="$1"
	if [ -z "$p" ]; then echo "(sumiu)"
	elif [ -d "$p" ]; then echo "pasta/init.luau"
	else echo "arquivo solto"; fi
}

# Apagar por MOVE, que e o que a lixeira faz: mesma syscall, sem depender da
# lixeira de verdade.
por_move() { [ -n "$1" ] && mv "$1" "$AQUI/.lixeira/$(basename "$1").$RANDOM"; }
por_unlink() { [ -n "$1" ] && rm -rf "$1"; }

emitido_desde() {
	python - "$OBS" "$1" <<'PY'
import json, io, sys
corte = int(sys.argv[2]); vistos = []
for l in io.open(sys.argv[1], encoding="utf-8"):
    d = json.loads(l)
    if d["t"] >= corte and d["direcao"] == "<-":
        k = (d["msg"] or {}).get("kind")
        if k and k not in ("ping", "presenceUpdate"):
            vistos.append(k)
print(",".join(vistos) if vistos else "(nada)")
PY
}

agora_ms() { date +%s%3N; }

# gesto <rotulo> <comando...>
gesto() {
	local rotulo="$1"; shift
	local marca=$(agora_ms)
	"$@" 2>/dev/null
	sleep "$ESPERA"
	printf "  %-44s %s\n" "$rotulo" "$(emitido_desde "$marca")"
}

# Modulo no formato Modux: pasta + init.luau + a folha Type.luau ao lado.
# Com filho, a extensao preserva a pasta — medido.
modulo_modux() {
	local lado="$1" nome="$2"
	mkdir -p "$PROJ/src/$lado/$nome"
	cat > "$PROJ/src/$lado/$nome/init.luau" <<LUAU
--!strict
local $nome = {}
function $nome:Eco(n: number) return n end
return $nome
LUAU
	cat > "$PROJ/src/$lado/$nome/Type.luau" <<LUAU
--!strict
export type Public = { Eco: (self: Public, n: number) -> number }
return {}
LUAU
}

# Modulo simples, sem filho — a extensao acha para arquivo solto.
modulo_simples() {
	local lado="$1" nome="$2"
	mkdir -p "$PROJ/src/$lado"
	printf -- '--!strict\nreturn {}\n' > "$PROJ/src/$lado/$nome.luau"
}

# --- preparo -----------------------------------------------------------------

echo "== bancada de gestos, porta $PORTA =="
if ! (netstat -ano 2>/dev/null | grep -q ":$PORTA .*LISTENING"); then
	echo "  A extensao nao esta escutando na $PORTA."
	echo "  Abra $PROJ no VS Code e rode de novo."
	exit 1
fi

rm -rf "$PROJ/src/server" "$PROJ/src/client" "$AQUI/.lixeira"
mkdir -p "$PROJ/src/server" "$PROJ/src/client" "$AQUI/.lixeira"
sleep 2

node "$AQUI/plugin-falso.mjs" "$PORTA" "$OBS" &
PID=$!
trap 'kill $PID 2>/dev/null; wait 2>/dev/null' EXIT
sleep 3
kill -0 $PID 2>/dev/null || { echo "  o plugin falso nao conectou"; exit 1; }
echo

# --- criar -------------------------------------------------------------------

echo "criar"
gesto "modulo Modux (pasta + init + Type)"   modulo_modux server Alfa
gesto "modulo simples (arquivo solto)"       modulo_simples server Beta
echo "     forma de Alfa: $(forma "$(alvo server Alfa)")   Beta: $(forma "$(alvo server Beta)")"
echo

# --- editar ------------------------------------------------------------------

echo "editar"
A=$(alvo server Alfa)
[ -d "$A" ] && ARQ="$A/init.luau" || ARQ="$A"
gesto "mudar o corpo"                        bash -c "printf -- '\n-- toque\n' >> '$ARQ'"
echo

# --- apagar, o coracao da matriz ---------------------------------------------

echo "apagar"
gesto "modulo Modux por MOVE (lixeira)"      por_move "$(alvo server Alfa)"
gesto "modulo simples por UNLINK"            por_unlink "$(alvo server Beta)"
echo "     restou no disco: $(find "$PROJ/src/server" -name '*.luau' | wc -l) arquivo(s)"
echo

echo "apagar, invertendo o metodo"
gesto "criar Gama (Modux)"                   modulo_modux server Gama
gesto "criar Delta (simples)"                modulo_simples server Delta
gesto "Gama por UNLINK"                      por_unlink "$(alvo server Gama)"
gesto "Delta por MOVE"                       por_move "$(alvo server Delta)"
echo "     restou no disco: $(find "$PROJ/src/server" -name '*.luau' | wc -l) arquivo(s)"
echo

# --- renomear e mover --------------------------------------------------------

echo "renomear e mover"
gesto "criar Epsilon"                        modulo_modux server Epsilon
E=$(alvo server Epsilon)
gesto "renomear"                             bash -c "mv '$E' '$(dirname "$E")/EpsilonNovo$( [ -d "$E" ] || echo .luau )'"
E2=$(alvo server EpsilonNovo)
gesto "mover de server para client"          bash -c "mv '$E2' '$PROJ/src/client/$(basename "$E2")'"
echo "     agora em client: $(forma "$(alvo client EpsilonNovo)")"
echo

# --- feature inteira ---------------------------------------------------------

echo "feature inteira"
feature_dois_lados() { modulo_modux server Inv; modulo_modux client Inv; }
gesto "criar feature nos dois lados"         feature_dois_lados
gesto "apagar os dois lados por UNLINK"      bash -c "rm -rf '$(alvo server Inv)' '$(alvo client Inv)'"
echo

# --- lote --------------------------------------------------------------------

echo "em lote (onde o Azul duplicou)"
gesto "cinco modulos de uma vez"             bash -c "
  for n in 1 2 3 4 5; do
    mkdir -p '$PROJ/src/server/Lote'\$n
    printf -- '--!strict\nreturn {}\n' > '$PROJ/src/server/Lote'\$n'/init.luau'
    printf -- '--!strict\nreturn {}\n' > '$PROJ/src/server/Lote'\$n'/Type.luau'
  done"
gesto "apagar os cinco por UNLINK"           bash -c "rm -rf '$PROJ'/src/server/Lote*"
echo

# --- relatorio ---------------------------------------------------------------

echo "== resumo =="
echo "  sobrou no disco:"
find "$PROJ/src" -name '*.luau' 2>/dev/null | sed "s|$PROJ/src/|    |" | sort || echo "    (nada)"
echo
python - "$OBS" <<'PY'
import json, io, sys, collections
criados = collections.Counter(); apagados = 0; kinds = collections.Counter()
for l in io.open(sys.argv[1], encoding="utf-8"):
    d = json.loads(l)
    if d["direcao"] != "<-": continue
    m = d["msg"] or {}; k = m.get("kind")
    if not k or k in ("ping",): continue
    kinds[k] += 1
    if k == "writeSource" and not m.get("uuid"): criados[m.get("path")] += 1
    if k == "deleteScript": apagados += 1
print("  mensagens emitidas pela extensao:")
for k, n in kinds.most_common(): print(f"    {k:18s} {n}")
print(f"\n  criacoes: {sum(criados.values())}   delecoes: {apagados}")
dup = {p: n for p, n in criados.items() if n > 1}
print("  MESMO path criado mais de uma vez: " + (json.dumps(dup) if dup else "nenhum"))
PY
echo
echo "  registro completo: $OBS"
