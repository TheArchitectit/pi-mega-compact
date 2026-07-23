#!/bin/bash
# deploy_dashboard.sh — DEVICE-SIDE updater helper (kept for backwards lookups).
#
# This is NOT the publish script. Publishing happens on the dev machine via
#   ./scripts/deploy.sh <new-version>
# which enforces the full gate, builds the React dashboard, and verifies the
# bundle is included in `npm pack --dry-run` BEFORE `npm publish` — preventing
# the 0.8.5 regression where the dashboard bundle was missing from the package.
#
# Run THIS script on each device AFTER a release has been published to npm.

set -euo pipefail

echo "[device] Updating to the latest registry version (npm only, no .tgz)..."
pi update --extensions

echo "[device] Installed version:"
cat $(find ~/.pi/agent/extensions -path '*mega-compact/package.json' 2>/dev/null | head -1) 2>/dev/null | grep '"version"' || echo "Package file not found — install may have failed"

echo "[device] Remove any leftover .tgz artifacts:"
find ~/.pi/agent/extensions -name '*.tgz' -delete 2>/dev/null || true

echo "[device] Verify the server serves the React bundle (not old static html):"
echo "  curl -sS http://localhost:9320/ | grep -E 'id=\"root\"|<div id=\"root\">'"
echo "  (expected: a match — the React #root mount point. If empty, the bundle did"
echo "   not ship; ask the publisher to re-run ./scripts/deploy.sh with a patch bump.)"
echo "[device] Done."
