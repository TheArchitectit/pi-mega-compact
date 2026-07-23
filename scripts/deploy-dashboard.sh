#!/bin/bash
# scripts/deploy-dashboard.sh — DEVICE-SIDE updater helper.
#
# This is NOT the publish script. Publishing is done on the dev machine via
#   ./scripts/deploy.sh <new-version>
# which builds + gates + verifies the React bundle is in the npm tarball BEFORE
# `npm publish` (prevents the 0.8.5 regression where the dashboard bundle was
# missing from the published package).
#
# Run THIS script on each device AFTER a release has been published to npm.
# It pulls the registry version and verifies the dashboard bundle is served.

set -euo pipefail

echo "[device] Updating to the latest registry version (npm only, no .tgz):"
pi update --extensions

echo "[device] Installed version:"
cat $(find ~/.pi/agent/extensions -path '*mega-compact/package.json' 2>/dev/null | head -1) 2>/dev/null | grep '"version"' || echo 'installed at alternate path'

echo "[device] Removing leftover .tgz artifacts (never used for shipping):"
find ~/.pi/agent/extensions -name '*.tgz' -delete 2>/dev/null || true

echo "[device] Verify the dashboard server serves the React bundle:"
echo "  curl -sS http://localhost:9320/ | grep -E 'id=\"root\"|<div id=\"root\">'"
echo "  (expected: a match — the React mount point. If empty, the bundle did not ship;"
echo "   ask the publisher to re-run ./scripts/deploy.sh with a patch bump.)"
echo "[device] Done."
