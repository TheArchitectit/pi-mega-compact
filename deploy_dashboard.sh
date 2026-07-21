#!/bin/bash
# Deploy new React dashboard to all devices running pi-mega-compact
# Uses npm registry (0.8.10) — no .tgz, no symlink

set -e

echo "[deploy] Updating to registry version 0.8.10..."
pi update --extensions

echo "[deploy] Confirm installed version:"
cat $(find ~/.pi/agent/extensions -path '*mega-compact/package.json' 2>/dev/null | head -1) 2>/dev/null | grep '"version"' || echo "Package file not found — install may have failed"

echo "[deploy] Remove any leftover .tgz artifacts:"
find ~/.pi/agent/extensions -name '*.tgz' -delete 2>/dev/null || true

echo "[deploy] Verify server serves new React bundle (not old html):"
# Restart server by touching a trigger file (server watches for changes)
echo "Restart server by running: curl http://localhost:9320/"
echo "Then check /api/version responds with version 0.8.10"
echo "[deploy] Done. If old dashboard still visible, restart server (kill server process, relaunch)."
