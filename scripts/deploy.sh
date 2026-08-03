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
#     1.5. Pre-flight: verify @mongodb-js/zstd native binding loads (fail fast
#          with the rebuild command instead of a mysterious mid-gate crash).
#     2. Full gate: build + test + lint + regression_check (incl. npm audit for
#        runtime HIGH/CRITICAL vulns) + guardrails-scan.
#     3. Build the React dashboard (npm run build:dashboard).
#     4. CRITICAL VERIFY: confirm extensions/dashboard-client/dist/index.html
#        exists AND is listed by `npm pack --dry-run` — fail with exit 1 if
#        missing (this is exactly the 0.8.5 regression we are preventing).
#     4.5 Dashboard tab smoke (Playwright): headless-chromium drive of the
#         built bundle — click every tab, assert non-empty content. Catches
#         missing-render-branch regressions (v0.12.7 Turns-blank bug class).
#     5. Bump package.json + package-lock.json version to <new-version>.
#     6. Commit the version bump (package.json + package-lock.json + dist).
#     7. Tag (annotated) + push BEFORE publish — a push failure aborts
#        before an irreversible npm publish.
#     8. npm publish (the ONLY valid distribution path — PREVENT-DIST-001).
#     9. Create GitHub release with notes from commit log.
#     10. Print post-publish device instructions.
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

# --- 1.5 pre-flight: native deps loadable ------------------------------------
# Friction fix: @mongodb-js/zstd's native binding can fail to build when npm's
# allowScripts blocks it. That surfaces as a mysterious compression-test failure
# mid-gate (after several minutes). Fail fast with the fix instead.
if ! node -e "require('@mongodb-js/zstd')" 2>/dev/null; then
	echo "[deploy] ERROR: @mongodb-js/zstd native binding not loadable." >&2
	echo "[deploy]        The compression tests would fail mid-gate. Rebuild it:" >&2
	echo "[deploy]          npm install-scripts approve @mongodb-js/zstd && npm rebuild @mongodb-js/zstd" >&2
	echo "[deploy]        Then re-run: ./scripts/deploy.sh $NEW_VERSION" >&2
	exit 1
fi
echo "[deploy] @mongodb-js/zstd loadable."

# --- 2. full gate -------------------------------------------------------------
# regression_check.py --all now includes the npm audit gate: it runs
# `npm audit --json`, classifies findings by severity × scope, and exits
# non-zero on RUNTIME HIGH/CRITICAL vulnerabilities (reachable from
# package.json `dependencies` — i.e. shipped to users). Dev-only / moderate
# warnings (e.g. the openclaw peer host + transitive deps) are non-blocking.
echo "[deploy] running gate: build + test + lint + regression (incl. npm audit) + guardrails"
npm run build
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
echo "[deploy] gate green."

# --- 2.5 schema-health validation (S49B) ------------------------------------
echo "[deploy] validating schema health (S49B gate)"
node scripts/schema-health-check.mjs
echo "[deploy] schema health OK."

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

# --- 4.5 dashboard tab smoke (Playwright) -----------------------------------
# Drive the built bundle with headless chromium, click every tab, and assert
# each renders non-empty content. Catches the missing-render-branch regression
# class (the v0.12.7 Turns-tab-100%-blank bug: a tab registered in the tab bar
# but with no {activeTab === "x" && <XTab/>} render branch in App.tsx → <main>
# renders nothing). Structural check — no dashboard server needed.
echo "[deploy] running dashboard tab smoke (Playwright)"
if ! node scripts/dashboard-tab-smoke.mjs; then
	echo "[deploy] ERROR: dashboard tab smoke failed — a tab rendered blank." >&2
	echo "[deploy]        This means a tab is registered but has no render branch" >&2
	echo "[deploy]        in App.tsx. Fix before publishing." >&2
	exit 1
fi
echo "[deploy] dashboard tab smoke green."

# Verify npm pack actually lists the dashboard bundle.
# `npm pack --dry-run` prints the packed file list to stdout; we grep for the
# index.html path. (We do NOT write a .tgz — --dry-run only lists.)
if ! npm pack --dry-run --json 2>/dev/null |
	grep -q "extensions/dashboard-client/dist/index.html"; then
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
# Stage package-lock.json alongside package.json: `npm version` bumps BOTH,
# and leaving the lockfile uncommitted was a recurring friction point — the
# next deploy's clean-tree check (step 1) failed on the stale lockfile.
if git diff --quiet -- package.json package-lock.json extensions/dashboard-client/dist; then
	echo "[deploy] nothing to commit (version already set, dist unchanged)."
else
	echo "[deploy] committing version bump + dashboard dist"
	git add package.json package-lock.json extensions/dashboard-client/dist
	git commit -m "chore(release): v$NEW_VERSION

Release v$NEW_VERSION published via scripts/deploy.sh.

Co-Authored-By: pi-mega-compact deploy.sh <noreply@pi-mega-compact>"
fi

# --- 7. tag + push BEFORE publish --------------------------------------------
# Order matters: push the commit + tag BEFORE npm publish so a push failure
# (e.g. no upstream branch) aborts the script before an irreversible npm
# publish. v0.13.7 hit this exact bug — published to npm but the push failed
# because the worktree branch had no upstream, and the GitHub release step
# was skipped.
TAG="v$NEW_VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	echo "[deploy] tag $TAG already exists; skipping tag creation."
else
	echo "[deploy] creating tag $TAG"
	# Annotated tag (-a): `git push --follow-tags` only pushes annotated tags,
	# so this makes the push on the next line the real mechanism (not a no-op).
	git tag -a "$TAG" -m "Release v$NEW_VERSION"
fi
echo "[deploy] pushing commits + tags (git push --follow-tags)"
# Handle branches with no upstream (e.g. worktree branches): fall back to
# --set-upstream so the push succeeds rather than failing with exit 128.
if ! git push --follow-tags 2>/dev/null; then
	echo "[deploy] git push --follow-tags failed; setting upstream and retrying"
	CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
	git push --set-upstream origin "$CURRENT_BRANCH" --follow-tags
fi

# --- 7b. verify the tag reached origin ----------------------------------------
if ! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
	echo "[deploy] pushing tag $TAG explicitly (not found on origin after --follow-tags)"
	git push origin "$TAG"
fi

# --- 8. publish (npm only — PREVENT-DIST-001) --------------------------------
echo "[deploy] publishing to npm (npm publish — the only valid distribution path)"
npm publish

echo "[deploy] published v$NEW_VERSION to npm."

# --- 8b. create GitHub release with notes ------------------------------------
# Now runs AFTER npm publish (the release announces the published version).
# The tag is already pushed in step 7 — this just creates the GitHub release
# object with auto-generated notes from the commit log.
#
# NOTE on the SIGPIPE bug this block used to have: the pipeline
#   git log | grep | head -15
# under `set -o pipefail` aborts the whole script with exit 141 AFTER npm
# publish has already succeeded — `head -15` closes the pipe early after
# emitting its 15 lines, SIGPIPE propagates up to `git log`/`grep`, and
# pipefail treats that as a failure. We now use `sed -n '1,15p'` (which reads
# its full stdin and so does not close the pipe early) and the whole notes
# extraction is wrapped in `|| true` so any failure there cannot abort the
# deploy after the package is already shipped.
PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
if [ -n "$PREV_TAG" ]; then
	RELEASE_NOTES=$(git log --pretty=format:"- %s" "$PREV_TAG..$TAG" 2>/dev/null | grep -vE "^- chore\(release\)|^- chore: (sync|clean|rebuild)" | sed -n '1,15p' || true)
else
	RELEASE_NOTES=$(git log --pretty=format:"- %s" "$TAG" 2>/dev/null | sed -n '1,15p' || true)
fi
RELEASE_NOTES="${RELEASE_NOTES:-(no commit notes extracted)}"
if command -v gh >/dev/null 2>&1; then
	echo "[deploy] creating GitHub release $TAG with notes"
	gh release create "$TAG" --target "$(git rev-list -n 1 "$TAG")" \
		--title "v$NEW_VERSION" \
		--notes "$(printf '## What changed\n\n%s\n\n**Install:** \`pi update --extensions\`' "$RELEASE_NOTES")" \
		2>/dev/null || echo "[deploy] WARN: gh release create failed (gh not authenticated or release exists) — skipping"
else
	echo "[deploy] WARN: gh CLI not installed — skipping GitHub release creation. Tag $TAG is pushed."
fi

# --- 10. post-publish device instructions ------------------------------------
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
