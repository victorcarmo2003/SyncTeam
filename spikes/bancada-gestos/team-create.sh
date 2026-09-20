#!/usr/bin/env bash
# Bancada de Team Create: dois devs de verdade.
#
# As outras baterias usaram plugin falso e um lado so. Esta usa dois Studios
# reais, dois plugins reais e duas extensoes, cada uma no seu workspace e na
# sua porta — o caminho inteiro:
#
#   disco A -> extensao A -> Studio A -> Team Create -> Studio B -> extensao B -> disco B
#
# Os mesmos cenarios que eu medi no Azul, na mesma ordem, para os numeros
# serem comparaveis. La o resultado foi: 1s de propagacao, arquivos diferentes
# convergem, e o MESMO arquivo diverge em silencio em 2 de 3 tentativas, sem
# nenhum aviso em log nenhum.
#
# O quarto cenario e a razao de existir do SyncTeam: a lease deveria dar o
# arquivo a um e recusar o outro, em vez de deixar os dois escreverem.
#
# Pre-requisito: as duas janelas abertas, `SyncTeam: Iniciar` em cada, um
# Studio conectado em cada porta, e os DOIS Studios na MESMA place com Team
# Create ligado.
#
# Uso:  bash team-create.sh [portaA] [portaB]
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
PA="${1:-1400}"; PB="${2:-1401}"
A="$AQUI/projeto"; B="$AQUI/devB"
LIMITE="${LIMITE:-40}"

passou=0; falhou=0
ok()    { printf "  ok    %-46s %s\n" "$1" "${2:-}"; passou=$((passou+1)); }
falha() { printf "  FALHA %-46s %s\n" "$1" "${2:-}"; falhou=$((falhou+1)); }

# Onde o modulo esta: pasta com init, ou arquivo solto (a extensao normaliza
# um init.luau sem irmaos). Nunca assumir a forma — ja custou uma bateria.
onde() { # onde <raiz> <lado> <nome>
	if [ -f "$1/src/$2/$3/init.luau" ]; then echo "$1/src/$2/$3/init.luau"
	elif [ -f "$1/src/$2/$3.luau" ]; then echo "$1/src/$2/$3.luau"
	else echo ""; fi
}

esperar_em() { # esperar_em <raiz> <lado> <nome> -> segundos, ou vazio
	for i in $(seq 1 $LIMITE); do
		sleep 1
		[ -n "$(onde "$1" "$2" "$3")" ] && { echo "$i"; return; }
	done
	echo ""
}

modulo() { # modulo <raiz> <lado> <nome> <marca>
	mkdir -p "$1/src/$2/$3"
	printf -- '--!strict\nreturn { marca = "%s" }\n' "$4" > "$1/src/$2/$3/init.luau"
	printf -- '--!strict\nexport type Public = {}\nreturn {}\n' > "$1/src/$2/$3/Type.luau"
}

marca_de() { # marca_de <arquivo>
	[ -f "$1" ] && grep -o 'marca = "[^"]*"' "$1" | head -1 | cut -d'"' -f2 || echo "(sem arquivo)"
}

echo "== Team Create, A=$PA  B=$PB =="
for p in $PA $PB; do
	netstat -ano 2>/dev/null | grep -q "127.0.0.1:$p .*LISTENING" || { echo "  extensao fora da $p"; exit 1; }
	n=$(netstat -ano 2>/dev/null | grep ":$p " | grep -c ESTABLISHED)
	[ "$n" -gt 0 ] || { echo "  nenhum plugin conectado na $p"; exit 1; }
done
echo "  as duas extensoes com plugin conectado"
echo

rm -rf "$A/src/server"/* "$A/src/client"/* "$B/src/server"/* "$B/src/client"/* 2>/dev/null
sleep 8
echo "  disco A: $(find "$A/src" -name '*.luau' | wc -l) arquivo(s)   disco B: $(find "$B/src" -name '*.luau' | wc -l)"
echo

# --- 1. A -> B ---------------------------------------------------------------

echo "1. propagacao A -> B"
modulo "$A" server Ida ida-de-A
t=$(esperar_em "$B" server Ida)
if [ -n "$t" ]; then ok "chegou em B" "${t}s"; else falha "nao chegou em B" ">${LIMITE}s"; fi
echo "     forma em B: $(onde "$B" server Ida | sed "s|$B/src/||")"

# --- 2. B -> A ---------------------------------------------------------------

echo
echo "2. propagacao B -> A (sentido inverso)"
modulo "$B" server Volta volta-de-B
t=$(esperar_em "$A" server Volta)
if [ -n "$t" ]; then ok "chegou em A" "${t}s"; else falha "nao chegou em A" ">${LIMITE}s"; fi

# --- 3. arquivos diferentes ao mesmo tempo -----------------------------------

echo
echo "3. os dois editando ARQUIVOS DIFERENTES ao mesmo tempo"
( modulo "$A" server SoDoA a-trabalhando ) &
( modulo "$B" server SoDoB b-trabalhando ) &
wait
sleep 15
fa=$(onde "$B" server SoDoA); fb=$(onde "$A" server SoDoB)
[ -n "$fa" ] && ok "o de A chegou em B" || falha "o de A nao chegou em B"
[ -n "$fb" ] && ok "o de B chegou em A" || falha "o de B nao chegou em A"

# --- 4. o MESMO arquivo ao mesmo tempo (a lease) -----------------------------

echo
echo "4. os dois no MESMO arquivo ao mesmo tempo"
echo "   (no Azul: divergiu em silencio 2 de 3 vezes)"
modulo "$A" server Disputa inicial
esperar_em "$B" server Disputa >/dev/null
sleep 5
for volta in 1 2 3; do
	fA=$(onde "$A" server Disputa); fB=$(onde "$B" server Disputa)
	if [ -z "$fA" ] || [ -z "$fB" ]; then echo "     volta $volta: arquivo ausente de um dos lados, pulando"; continue; fi
	( printf -- '--!strict\nreturn { marca = "A-volta%s" }\n' "$volta" > "$fA" ) &
	( printf -- '--!strict\nreturn { marca = "B-volta%s" }\n' "$volta" > "$fB" ) &
	wait
	sleep 18
	va=$(marca_de "$(onde "$A" server Disputa)")
	vb=$(marca_de "$(onde "$B" server Disputa)")
	if [ "$va" = "$vb" ]; then ok "volta $volta convergiu" "$va"; else falha "volta $volta DIVERGIU" "A=$va B=$vb"; fi
done

# --- 5. apagar pasta ---------------------------------------------------------

echo
echo "5. apagar a pasta de um modulo em A"
rm -rf "$A/src/server/Ida"
for i in $(seq 1 $LIMITE); do
	sleep 1
	[ -z "$(onde "$B" server Ida)" ] && break
done
[ -z "$(onde "$B" server Ida)" ] && ok "sumiu de B tambem" "${i}s" || falha "continua em B" ">${LIMITE}s"

echo
echo "== resumo =="
echo "  disco A: $(find "$A/src" -name '*.luau' | sed "s|$A/src/||" | sort | tr '\n' ' ')"
echo "  disco B: $(find "$B/src" -name '*.luau' | sed "s|$B/src/||" | sort | tr '\n' ' ')"
echo "  passou: $passou   falhou: $falhou"
