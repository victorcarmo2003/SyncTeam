#!/usr/bin/env bash
# Builda a extensão (esbuild) e sobe UM harness Node (motor real da extensão,
# SyncServer+SyncTeamService+SyncBridge, sem precisar de VS Code aberto)
# apontado para um projeto Rojo de teste, numa porta escolhida. Fica em
# foreground de propósito — invoque via Bash com run_in_background:true para
# rodar em background e continuar trabalhando.
#
# Uso: Tools/start-harness.sh <porta> <pasta-do-projeto-relativa-ao-repo>
# Exemplo (Studio "A"): Tools/start-harness.sh 34980 spikes/m1-test-project
# Exemplo (Studio "B"): Tools/start-harness.sh 34981 spikes/m1-test-project-b
#
# Grava o log combinado (harness + Studio encaminhado via WS, ver
# Tools/README.md) em Tools/logs/studio-<porta>.log
set -euo pipefail

if [ $# -ne 2 ]; then
	echo "uso: $0 <porta> <pasta-do-projeto-relativa-ao-repo>" >&2
	exit 1
fi

PORT="$1"
PROJECT_DIR="$2"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_ROOT/vscode-extension"
LOG_DIR="$REPO_ROOT/Tools/logs"
mkdir -p "$LOG_DIR"

echo "== build da extensão (esbuild) =="
(cd "$EXT_DIR" && npm run build)

echo "== subindo harness na porta $PORT, projeto $PROJECT_DIR =="
echo "== log combinado (harness + Studio): $LOG_DIR/studio-$PORT.log =="
cd "$EXT_DIR"
SYNCTEAM_PORT="$PORT" SYNCTEAM_LOG_FILE="$LOG_DIR/studio-$PORT.log" node dist/run-node-harness.js "$REPO_ROOT/$PROJECT_DIR"
