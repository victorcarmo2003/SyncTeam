#!/usr/bin/env bash
# Builda plugin/ (rojo build) e implanta em %LOCALAPPDATA%\Roblox\Plugins,
# forçando o auto-refresh do Studio (delete + copy, não só overwrite — o
# Studio detecta "remoção + adição" de forma mais confiável do que um
# overwrite in-place). Ver Tools/README.md para o fluxo completo de teste.
#
# Uso: Tools/build-and-deploy-plugin.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugin"
PLUGINS_FOLDER="/c/Users/hakor/AppData/Local/Roblox/Plugins"
PLUGIN_NAME="SyncTeam.rbxm"

ROJO_BIN="$(ls "$HOME"/.rokit/tool-storage/rojo-rbx/rojo/*/rojo.exe 2>/dev/null | sort -V | tail -n1)"
if [ -z "$ROJO_BIN" ]; then
	echo "erro: rojo.exe não encontrado em ~/.rokit/tool-storage/rojo-rbx/rojo/*/ — ajuste ROJO_BIN manualmente" >&2
	exit 1
fi

echo "== rojo build ($ROJO_BIN) =="
(cd "$PLUGIN_DIR" && "$ROJO_BIN" build -o "$PLUGIN_NAME")

echo "== implantando em $PLUGINS_FOLDER =="
rm -f "$PLUGINS_FOLDER/$PLUGIN_NAME"
cp "$PLUGIN_DIR/$PLUGIN_NAME" "$PLUGINS_FOLDER/$PLUGIN_NAME"

echo "OK — plugin implantado. Studios abertos devem detectar o refresh automaticamente (auto-start já embutido no plugin)."
