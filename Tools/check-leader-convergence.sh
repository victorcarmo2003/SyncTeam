#!/usr/bin/env bash
# Lê os dois arquivos de log (Tools/logs/studio-<porta>.log, um por Studio,
# ver Tools/README.md) e reporta se os dois convergiram para o mesmo líder.
# Não substitui análise manual — é um atalho para não precisar reler o log
# inteiro toda vez que eu (a IA) quiser checar convergência depois de um
# teste. Ajuste os nomes de arquivo se as portas usadas forem outras.
#
# Uso: Tools/check-leader-convergence.sh [log1] [log2]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_ROOT/Tools/logs"

LOG1="${1:-$LOG_DIR/studio-34980.log}"
LOG2="${2:-$LOG_DIR/studio-34981.log}"

for f in "$LOG1" "$LOG2"; do
	if [ ! -f "$f" ]; then
		echo "erro: arquivo não encontrado: $f" >&2
		exit 1
	fi
done

# Última linha de cada log que anuncia liderança (própria ou observada),
# extraindo o clientId/term com grep -oE. Formato esperado das linhas (texto
# encaminhado do plugin, ver plugin/src/Logger.luau e
# vscode-extension/src/sync/SyncTeamService.ts):
#   sou o líder agora (term N)          -> auto-anúncio, clientId não aparece na própria linha
#   líder atual: <clientId> (term N)    -> observação de líder remoto
echo "== $LOG1 =="
tail -n 5 <(grep -E "líder agora|líder atual" "$LOG1" || echo "(nenhuma linha de liderança encontrada ainda)")
echo
echo "== $LOG2 =="
tail -n 5 <(grep -E "líder agora|líder atual" "$LOG2" || echo "(nenhuma linha de liderança encontrada ainda)")
echo
echo "Compare manualmente o term e o clientId das últimas linhas de cada lado."
echo "Convergência = mesmo clientId sendo tratado como líder (um dos dois anuncia"
echo "'sou o líder agora', o outro reporta 'líder atual: <o mesmo clientId>'), mesmo term."
