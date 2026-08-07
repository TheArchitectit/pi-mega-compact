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
# --all runs the full-tree scan (hard-limit + npm audit + settings + failure
# registry). --soft-as-hard --pre-commit promotes soft-limit violations on
# files CHANGED since the prior release tag to blocking: an agent (or this
# release's commits) cannot squeeze a src/ file past 300 (ext past 400) toward
# the 500 hard limit — it must split (delegate-shell + impl). The --soft-as-hard-base
# is the previous release tag, so only THIS release's grown files are gated;
# pre-existing violators stay non-blocking (tech debt, tracked separately).
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)
if [ -n "$PREV_TAG" ]; then
	python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base "$PREV_TAG" --pre-commit
else
	# First release (no prior tag): headroom gate over the working-tree diff.
	python3 scripts/regression_check.py --all --soft-as-hard --pre-commit
fi
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

# --- 4.6 VC2C encoder asset + package-listing gate ----------------------------
# MODEL_ASSET §qualification/packaging: require the qualified encoder manifest
# (asset paths + supported matrix covered by the committed manifest; the VC2A
# verification seam re-checks digests before load), and that the ENTIRE npm
# package dry-run listing is <= 80 MiB (the compressed shipping budget —
# re-baselined from 35 MiB by ENC-0b once the real 33.8 MB bge-small-en-v1.5
# opset-21 model replaced the 42-byte placeholder).
# Dry-run listing ONLY — never create a .tgz (PREVENT-DIST-001).
PACKAGE_BUDGET_BYTES=$((80*1024*1024))
VC2C_ASSET_DIR="assets/vector-cortex/encoder-v1"
echo "[deploy] VC2C asset gate: qualified manifest + package listing <= 80 MiB"
if [[ ! -f "$VC2C_ASSET_DIR/manifest.json" ]]; then
	echo "[deploy] ERROR: qualified encoder manifest missing ($VC2C_ASSET_DIR/manifest.json)." >&2
	exit 1
fi
for REQUIRED_ASSET in "model.onnx" "tokenizer.json"; do
	if [[ ! -f "$VC2C_ASSET_DIR/$REQUIRED_ASSET" ]]; then
		echo "[deploy] ERROR: qualified encoder asset $REQUIRED_ASSET missing under $VC2C_ASSET_DIR." >&2
		exit 1
	fi
done
PACKAGE_BYTES="$(npm pack --dry-run --json 2>/dev/null | python3 -c "
import json,sys
try:
    # npm pack --json -> object keyed by package name with a 'files' array of
    # {'path':..., 'size':...} entries. Sum every shipped file's size.
    data=json.load(sys.stdin)
    pack=next(iter(data.values()), {})
    print(sum(int(e.get('size',0)) for e in pack.get('files', [])))
except Exception:
    print('')
")"
if [[ -z "$PACKAGE_BYTES" || "$PACKAGE_BYTES" -gt "$PACKAGE_BUDGET_BYTES" ]]; then
	echo "[deploy] ERROR: total package listing ${PACKAGE_BYTES:-unknown} bytes exceeds the 80 MiB budget (re-baselined by ENC-0b from 35 → 80 MiB for the real bge-small-en-v1.5 opset-21 model)." >&2
	exit 1
fi
echo "[deploy] package listing ${PACKAGE_BYTES} bytes <= 80 MiB; VC2C asset gate green."

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

# --- 9. bounce stale local dashboard runners (best-effort) -------------------
# WHY: `pi update --extensions` replaces the on-disk package, but long-running
# _dashboard-runner.mjs processes keep serving the OLD in-memory bundle
# (observed after v0.20.25: :9320 still reporting v0.20.24). Two sources of
# truth are combined, mirroring extensions/mega-dashboard-cmds.ts:
#   - port.pid markers (written by the server into each repo's state dir), and
#   - an ORPHAN sweep of the full bind range (a live server with no marker).
# The npm publish is already done and must not be affected — every failure
# path below is swallowed by design.
bounce_stale_dashboards() {
	local NEW_V="$NEW_VERSION"
	local killed=0 marker info port pid ver
	# (a) marker-driven kills across all repo state dirs
	while IFS= read -r marker; do
		[[ -z "$marker" ]] && continue
		info="$(sed -n 's/.*"port":\([0-9]*\).*"pid":\([0-9]*\).*/\1 \2/p' "$marker" 2>/dev/null | head -1)"
		port="${info%% *}"
		pid="${info##* }"
		[[ "$port" =~ ^[0-9]+$ ]] || continue
		ver="$(curl -s --max-time 1 "http://localhost:${port}/api/version" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
		if [[ -n "$ver" && "$ver" != "$NEW_V" && "$pid" =~ ^[0-9]+$ ]]; then
			if kill -TERM "$pid" 2>/dev/null; then
				rm -f "$marker"
				echo "[deploy] bounced stale dashboard :$port (pid $pid, was v$ver)"
				killed=$((killed + 1))
			fi
		elif [[ -n "$ver" ]]; then
			echo "[deploy] dashboard :$port already current (v$ver) — leaving it"
		fi
	done < <(find "$HOME" -path '*/.pi/mega-compact/port.pid' -not -path '*/node_modules/*' 2>/dev/null || true)
	# (b) orphan sweep: a live dashboard on the bind range with NO marker keeps
	# serving its old in-memory bundle until killed (serverVersion stale rule).
	local BASE="${MEGACOMPACT_DASHBOARD_PORT:-9320}"
	local opid
	for ((port = BASE; port <= BASE + 9; port++)); do
		ver="$(curl -s --max-time 1 "http://localhost:${port}/api/version" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
		[[ -z "$ver" || "$ver" == "$NEW_V" ]] && continue
		opid="$(ss -ltnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)"
		if [[ "$opid" =~ ^[0-9]+$ ]] && kill -TERM "$opid" 2>/dev/null; then
			echo "[deploy] bounced orphan dashboard :$port (pid $opid, was v$ver)"
			killed=$((killed + 1))
		fi
	done
	[[ "$killed" -gt 0 ]] && echo "[deploy] $killed stale dashboard runner(s) stopped — next /dashboard launch serves v$NEW_VERSION"
	return 0
}
if ! bounce_stale_dashboards; then
	echo "[deploy] WARN: dashboard bounce step hit an error — continuing (publish unaffected)"
fi

# --- 8a. merge release branch into master -------------------------------------
# After a successful publish, merge the release branch into master so that
# master always tracks the latest published code. Non-fatal: if master is
# behind or has conflicts, warn and skip — the npm publish is already done.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "master" ]]; then
	echo "[deploy] merging $CURRENT_BRANCH → master"
	git fetch origin master 2>/dev/null || true
	git checkout master
	if git merge --no-edit "$CURRENT_BRANCH" 2>/dev/null; then
		git push origin master
		echo "[deploy] merged + pushed master."
	else
		echo "[deploy] WARN: merge conflicts on master — resolving with release branch versions."
		git checkout --theirs package.json package-lock.json 2>/dev/null || true
		git add package.json package-lock.json
		git commit --no-edit 2>/dev/null || true
		git push origin master
		echo "[deploy] merged (conflict-resolved) + pushed master."
	fi
	git checkout "$CURRENT_BRANCH"
else
	echo "[deploy] already on master — skipping merge."
fi

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
	gh release create "$TAG" \
		--title "v$NEW_VERSION" \
		--notes "$(printf '## What changed\n\n%s\n\n**Install:** \`pi update --extensions\`' "$RELEASE_NOTES")" \
		|| echo "[deploy] WARN: gh release create failed (gh not authenticated or release exists) — skipping"
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
echo "     NOTE: stale local dashboard runners (serving an older in-memory"
echo "     bundle) were already SIGTERMed by this deploy. On a *device* (not"
echo "     this host), after updating, run: curl -sS localhost:9320/api/version"
echo "     — if it shows an older version, /mega-dashboard-stop then /dashboard."
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
