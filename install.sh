#!/usr/bin/env bash
# install.sh — install pi-mega-compact into pi's local extensions.
#
# Copies this extension into ~/.pi/agent/extensions/ and registers it in pi's
# extensions config. Symlink mode (-s) is handy for development (edits apply
# without reinstall).
#
# Usage:
#   ./install.sh                  # copy into ~/.pi/agent/extensions/pi-mega-compact
#   ./install.sh -s             # symlink instead of copy (dev mode)
#   ./install.sh -f             # overwrite if already installed
#   MEGACOMPACT_DIR=/path ./install.sh   # install into a custom dir

set -euo pipefail

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${MEGACOMPACT_DIR:-$HOME/.pi/agent/extensions/pi-mega-compact}"
LINK=0
FORCE=0

while getopts "sf" opt; do
  case "$opt" in
    s) LINK=1 ;;
    f) FORCE=1 ;;
    *) echo "Unknown flag: -$opt" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$TARGET_DIR")"

if [ -e "$TARGET_DIR" ] && [ "$FORCE" -eq 0 ]; then
  echo "[mega-compact] $TARGET_DIR already exists (use -f to overwrite)."
  exit 1
fi

if [ "$LINK" -eq 1 ]; then
  ln -sfn "$SCRIPT_SRC" "$TARGET_DIR"
  echo "[mega-compact] symlinked -> $TARGET_DIR"
else
  rm -rf "$TARGET_DIR"
  cp -r "$SCRIPT_SRC" "$TARGET_DIR"
  echo "[mega-compact] installed -> $TARGET_DIR"
fi

# Register in pi's extensions config (JSON array under "pi.extensions").
CONFIG="$HOME/.pi/agent/config.json"
ENTRY="./extensions/pi-mega-compact/extensions/mega-compact.ts"
if [ -f "$CONFIG" ]; then
  if command -v jq >/dev/null 2>&1; then
    if ! jq -e --arg e "$ENTRY" '.pi.extensions | index($e)' "$CONFIG" >/dev/null 2>&1; then
      jq --arg e "$ENTRY" '.pi.extensions += [$e] | .pi.extensions |= unique' "$CONFIG" >"$CONFIG.tmp" \
        && mv "$CONFIG.tmp" "$CONFIG"
      echo "[mega-compact] registered $ENTRY in $CONFIG"
    else
      echo "[mega-compact] already registered in $CONFIG"
    fi
  else
    echo "[mega-compact] jq not found — add this to your pi config manually:"
    echo "  \"pi\": { \"extensions\": [\"$ENTRY\"] }"
  fi
else
  echo "[mega-compact] no pi config at $CONFIG yet — register later:"
  echo "  \"pi\": { \"extensions\": [\"$ENTRY\"] }"
fi

echo "[mega-compact] done. Restart pi (or /reload) to load the extension."
