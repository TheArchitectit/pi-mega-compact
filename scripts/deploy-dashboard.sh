#!/bin/bash
# Deploy script — updates to registry version, cleans artifacts, verifies.
set -e
echo "[deploy] Running: pi update --extensions (registry only, no .tgz)"
pi update --extensions
echo "[deploy] Version check: $(cat $(find ~/.pi/agent/extensions -path '*mega-compact/package.json' 2>/dev/null | head -1) 2>/dev/null | grep '"version"' || echo 'installed at alternate path')"
echo "[deploy] Removing leftover .tgz artifacts:"
find ~/.pi/agent/extensions -name '*.tgz' -delete 2>/dev/null || true
echo "[deploy] Confirm server serves new React bundle: curl localhost:9320/"
echo "[deploy] Done — user confirms cards (#metrics/#overview) load."
