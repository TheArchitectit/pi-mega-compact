#!/usr/bin/env bash
#
# scripts/deploy.sh — Authoritative publish pipeline for pi-mega-compact.
#
# WHY THIS EXISTS (the 0.8.5 regression):
#   v0.8.5 shipped to npm WITHOUT the React dashboard bundle. The cause: a release
#   was cut by hand without enforcing that `extensions/dashboard-client/dist` had
#   been built AND was actually included in the published tarball. The result was
#   a broken `/dashboard` (no #root / no React cards) on every device after
#   `pi update --extensions`.
#
#   This script is the gate that was missing. It is the ONLY path to publish and
#   MUST be run for every release:
#
#       ./scripts/deploy.sh <new-version>
#
#   It enforces (in order):
#     1. Clean git tree (no uncommitted changes).
#     2. Full gate: build + test + lint + regression_check + guardrails-scan.
#     3. Build the React dashboard (npm run build:dashboard).
#     4. CRITICAL VERIFY: confirm extensions/dashboard-client/dist/index.html
#        exists AND is listed by `npm pack --dry-run` — fail with exit 1 if
#        missing (this is exactly the 0.8.5 regression we are preventing).
#     5. Bump package.json version to <new-version>.
#     6. Commit the version bump (+ dist if changed).
#     7. npm publish (the ONLY valid distribution path — PREVENT-DIST-001).
#     8. git tag v<version> + git push --follow-tags.
#     9. Print post-publish device instructions.
#
#   Distribution is npm-only. NEVER produce or rely on a .tgz tarball
#   (`npm pack`) for shipping, and NEVER symlink into
#   ~/.pi/agent/extensions/ as a release path — both bypass pi's package
#   manager and do not propagate to other devices. (PREVENT-DIST-001)
#
# Usage:
#   ./scripts/deploy.sh 0.8.15
#
# Exit codes: non-zero on any failure (set -euo pipefail). Nothing is published
# if any step fails.

set -euo pipefail

# --- args --------------------------------------------------------------------
if [[ $# -ne 1 ]]; then
  echo "usage: $0 <new-version>" >&2
  echo "  e.g. $0 0.8.15" >&2
  exit 2
fi

NEW_VERSION="$1"

# Accept v-prefixed input by stripping the leading 'v'.
NEW_VERSION="${NEW_VERSION#v}"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "[deploy] ERROR: '$NEW_VERSION' is not a valid semver." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[deploy] pi-mega-compact publish pipeline → v$NEW_VERSION"
echo "[deploy] working dir: $ROOT"

# --- 1. clean git tree --------------------------------------------------------
if ! git diff --quiet; then
  echo "[deploy] ERROR: working tree has unstaged changes. Commit or stash first." >&2
  git diff --stat >&2 || true
  exit 1
fi
if ! git diff --cached --quiet; then
  echo "[deploy] ERROR: index has staged but uncommitted changes. Commit first." >&2
  exit 1
fi
echo "[deploy] git tree clean."

# --- 2. full gate -------------------------------------------------------------
echo "[deploy] running gate: build + test + lint + regression + guardrails"
npm run build
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
echo "[deploy] gate green."

# --- 3. build the React dashboard --------------------------------------------
echo "[deploy] building React dashboard (npm run build:dashboard)"
npm run build:dashboard

# --- 4. CRITICAL VERIFY: dashboard bundle is present AND in the tarball -------
DASHBOARD_INDEX="extensions/dashboard-client/dist/index.html"
if [[ ! -f "$DASHBOARD_INDEX" ]]; then
  echo "[deploy] ERROR: $DASHBOARD_INDEX missing after build:dashboard." >&2
  echo "[deploy]        This is the 0.8.5 regression — ABORTING before publish." >&2
  exit 1
fi
echo "[deploy] $DASHBOARD_INDEX exists."

# Verify npm pack actually lists the dashboard bundle.
# `npm pack --dry-run` prints the packed file list to stdout; we grep for the
# index.html path. (We do NOT write a .tgz — --dry-run only lists.)
if ! npm pack --dry-run --json 2>/dev/null \
    | grep -q "extensions/dashboard-client/dist/index.html"; then
  echo "[deploy] ERROR: 'npm pack --dry-run' does NOT list" >&2
  echo "[deploy]        extensions/dashboard-client/dist/index.html." >&2
  echo "[deploy]        Check package.json#files. ABORTING before publish (0.8.5 regression)." >&2
  exit 1
fi
echo "[deploy] dashboard bundle verified in npm pack output."

# --- 5. bump version ----------------------------------------------------------
CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo "[deploy] package.json already at v$NEW_VERSION."
else
  echo "[deploy] bumping package.json $CURRENT_VERSION → $NEW_VERSION"
  # Use npm version (no commit/tag yet — we commit explicitly below with dist).
  npm version "$NEW_VERSION" --no-git-tag-version
fi

# --- 6. commit version bump + dashboard dist if changed ----------------------
if git diff --quiet -- package.json extensions/dashboard-client/dist; then
  echo "[deploy] nothing to commit (version already set, dist unchanged)."
else
  echo "[deploy] committing version bump + dashboard dist"
  git add package.json extensions/dashboard-client/dist
  git commit -m "chore(release): v$NEW_VERSION

Release v$NEW_VERSION published via scripts/deploy.sh.

Co-Authored-By: pi-mega-compact deploy.sh <noreply@pi-mega-compact>"
fi

# --- 7. publish (npm only — PREVENT-DIST-001) --------------------------------
echo "[deploy] publishing to npm (npm publish — the only valid distribution path)"
npm publish

echo "[deploy] published v$NEW_VERSION to npm."

# --- 8. tag + push -----------------------------------------------------------
TAG="v$NEW_VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "[deploy] tag $TAG already exists; skipping tag creation."
else
  echo "[deploy] creating tag $TAG"
  git tag "$TAG"
fi
echo "[deploy] pushing commits + tags (git push --follow-tags)"
git push --follow-tags

# --- 9. post-publish device instructions -------------------------------------
echo
echo "============================================================"
echo " PUBLISHED v$NEW_VERSION — post-publish device steps"
echo "============================================================"
echo "On EACH device running pi-mega-compact:"
echo
echo "  1. Update the extension from the registry (npm-only, no .tgz):"
echo "       pi update --extensions"
echo
echo "  2. Confirm the installed version is v$NEW_VERSION:"
echo "       find ~/.pi/agent/extensions -path '*mega-compact/package.json' \
           -exec grep -m1 '\"version\"' {} \;"
echo
echo "  3. Verify the dashboard server serves the React bundle (NOT the"
echo "     old static HTML — this is the 0.8.5 regression check):"
echo "       curl -sS http://localhost:9320/ | grep -E 'id=\"root\"|<div id="root">'"
echo "       # expected: a match containing id=\"root\" (React mount point)"
echo
echo "     If no match: the bundle did not ship. Re-run ./scripts/deploy.sh"
echo "     with a patch bump; do NOT hot-patch via .tgz or symlink."
echo
echo "  4. (Optional) Confirm cards render: /api/version should report"
echo "     v$NEW_VERSION and /#metrics, /#overview cards should load."
echo "============================================================"
echo "[deploy] done."
