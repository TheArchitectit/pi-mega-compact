#!/usr/bin/env bash
#
# global-index-drill.sh — Sprint S23.2 DR validation for the machine-wide
# global index (the cross-repo registry + injected-set), distinct from the
# per-repo sqlite.db covered by dedup-restore-drill.sh.
#
# Validates the global index can be DESTROYED and REBUILT:
#   1. seed a known-good baseline (repo_registry + injected_global rows)
#   2. delete index.sqlite (simulate DR / corruption)
#   3. re-run the same upsert/inject calls the extension makes at runtime
#   4. assert both tables + row counts are restored and integrity = ok
#
# Mirrors docs/RETENTION_POLICY.md + docs/DEDUP_RUNBOOK.md. Local only
# (PREVENT-PI-004: zero network — node:sqlite, no remote calls).
#
# Usage:
#   scripts/global-index-drill.sh [INDEX_DIR]
#
# INDEX_DIR defaults to $MEGACOMPACT_INDEX_DIR or ~/.mega-compact-index.
# The drill writes into a TEMP subdirectory of INDEX_DIR (never your live
# index) unless you pass an explicit INDEX_DIR you want to test.
#
# Exit code is 0 only when every check passes (so it can gate a job).

set -o pipefail

INDEX_DIR="${1:-${MEGACOMPACT_INDEX_DIR:-$HOME/.mega-compact-index}}"
# Isolate the drill from any live index so we can delete safely: work under
# <INDEX_DIR>/drill-<pid> and clean it up at the end.
DRILL_DIR="$INDEX_DIR/drill-$$"
DB="$DRILL_DIR/index.sqlite"
FAIL=0

# Resolve the repo root from this script's own location ($0 always points
# at scripts/global-index-drill.sh when invoked directly).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -d "$REPO_ROOT/dist/src" ]; then
  echo "[GIDR] ERROR: $REPO_ROOT/dist/src missing — run \`npm run build\` first." >&2
  exit 2
fi
DIST="$REPO_ROOT/dist"

NODE="${NODE:-$(command -v node)}"
if [ -z "$NODE" ]; then
  echo "[GIDR] ERROR: node not found on PATH; set NODE=… explicitly." >&2
  exit 2
fi

pass() { echo "[GIDR] PASS: $1"; }
fail() { echo "[GIDR] FAIL: $1"; FAIL=1; }
info() { echo "[GIDR]      $1"; }

mkdir -p "$DRILL_DIR"
echo "[GIDR] drill dir: $DRILL_DIR"

# ---------------------------------------------------------------------------
# A single node helper does all the SQLite-side work (seed → delete → rebuild
# → assert) so we only spawn node once. It prints KEY=value lines.
# ---------------------------------------------------------------------------
HELPER_OUT="$("$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const sqlite = require(path.join(process.argv[1], "src", "store", "sqlite.js"));

const dir = process.argv[2];
const dbPath = path.join(dir, "index.sqlite");

// Wipe any prior drill state so the run is deterministic.
for (const f of fs.readdirSync(dir).filter(f => f.startsWith("index.sqlite"))) {
  fs.rmSync(path.join(dir, f), { force: true });
}

const now = Math.floor(Date.now() / 1000);

// 1. Seed a known-good baseline — exactly the calls the extension makes
// at runtime (mega-runtime.bindRepo → upsertRepoRegistry; cross-repo
// recall → markInjectedGlobal).
sqlite.upsertRepoRegistry(
  { repoRoot: "/home/u/repoA", displayName: "repoA", stateDir: "/home/u/repoA/.pi/mega-compact",
    firstSeen: now, lastSeen: now, checkpointCount: 3, tokensSaved: 1000,
    compressedOriginalBytes: 5000, provider: "anthropic", providerName: "Anthropic",
    modelName: "claude-x", inputRate: 5, outputRate: 20, modelCapturedAt: now },
  dir,
);
sqlite.upsertRepoRegistry(
  { repoRoot: "/home/u/repoB", displayName: "repoB", stateDir: "/home/u/repoB/.pi/mega-compact",
    firstSeen: now, lastSeen: now, checkpointCount: 5, tokensSaved: 2000,
    compressedOriginalBytes: 8000, provider: "openai", providerName: "OpenAI",
    modelName: "gpt-x", inputRate: 10, outputRate: 30, modelCapturedAt: now },
  dir,
);
sqlite.markInjectedGlobal("chkpt_foreign", "/home/u/repoA", "sess_a", dir);
sqlite.markInjectedGlobal("chkpt_other", "/home/u/repoB", "sess_b", dir);

function counts() {
  return {
    repos: sqlite.listRepoRegistry(dir).length,
    injected: sqlite.countInjectedGlobal(dir),
  };
}
const seeded = counts();
console.log("SEEDED_REPOS=" + seeded.repos);
console.log("SEEDED_INJECTED=" + seeded.injected);

// 2. Delete the index — simulate DR / corruption.
for (const f of fs.readdirSync(dir).filter(f => f.startsWith("index.sqlite"))) {
  fs.rmSync(path.join(dir, f), { force: true });
}
console.log("DELETED=true");

// 3. Rebuild from the SAME calls (the extension re-upserts on repo-switch
// and re-marks on each cross-repo injection).
sqlite.upsertRepoRegistry(
  { repoRoot: "/home/u/repoA", displayName: "repoA", stateDir: "/home/u/repoA/.pi/mega-compact",
    firstSeen: now, lastSeen: now, checkpointCount: 3, tokensSaved: 1000,
    compressedOriginalBytes: 5000, provider: "anthropic", providerName: "Anthropic",
    modelName: "claude-x", inputRate: 5, outputRate: 20, modelCapturedAt: now },
  dir,
);
sqlite.upsertRepoRegistry(
  { repoRoot: "/home/u/repoB", displayName: "repoB", stateDir: "/home/u/repoB/.pi/mega-compact",
    firstSeen: now, lastSeen: now, checkpointCount: 5, tokensSaved: 2000,
    compressedOriginalBytes: 8000, provider: "openai", providerName: "OpenAI",
    modelName: "gpt-x", inputRate: 10, outputRate: 30, modelCapturedAt: now },
  dir,
);
sqlite.markInjectedGlobal("chkpt_foreign", "/home/u/repoA", "sess_a", dir);
sqlite.markInjectedGlobal("chkpt_other", "/home/u/repoB", "sess_b", dir);

const rebuilt = counts();
console.log("REBUILT_REPOS=" + rebuilt.repos);
console.log("REBUILT_INJECTED=" + rebuilt.injected);
' "$DIST" "$DRILL_DIR" 2>&1)" || {
  echo "[GIDR] ERROR: node helper failed." >&2
  echo "$HELPER_OUT" >&2
  rm -rf "$DRILL_DIR"
  exit 2
}

last_value() { echo "$HELPER_OUT" | grep "^$1=" | tail -1 | sed "s/^$1=//"; }

SEEDED_REPOS=$(last_value SEEDED_REPOS)
SEEDED_INJECTED=$(last_value SEEDED_INJECTED)
REBUILT_REPOS=$(last_value REBUILT_REPOS)
REBUILT_INJECTED=$(last_value REBUILT_INJECTED)

# --- 4. Assertions ------------------------------------------------------
if [ "$SEEDED_REPOS" = "2" ] && [ "$SEEDED_INJECTED" = "2" ]; then
  pass "baseline seeded (2 repos, 2 injected)"
else
  fail "baseline seed wrong (repos=$SEEDED_REPOS injected=$SEEDED_INJECTED, expected 2/2)"
fi

if [ "$REBUILT_REPOS" = "2" ] && [ "$REBUILT_INJECTED" = "2" ]; then
  pass "global index rebuilt after delete (2 repos, 2 injected restored)"
else
  fail "rebuild lost data (repos=$REBUILT_REPOS injected=$REBUILT_INJECTED, expected 2/2)"
fi

# Tables present + integrity ok via the sqlite3 CLI if available; otherwise
# assert the DB file exists and is non-empty (node:sqlite created it).
if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY="$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>&1 | tr -d '[:space:]')"
  if [ "$INTEGRITY" = "ok" ]; then
    pass "PRAGMA integrity_check = ok"
  else
    fail "PRAGMA integrity_check = '$INTEGRITY' after rebuild"
  fi
else
  if [ -s "$DB" ]; then
    info "sqlite3 CLI absent — asserting DB file exists + non-empty (skipped integrity_check)"
    pass "rebuilt index.sqlite present + non-empty"
  else
    fail "rebuilt index.sqlite missing/empty"
  fi
fi

# --- Summary -----------------------------------------------------------------
rm -rf "$DRILL_DIR"
if [ "$FAIL" -eq 0 ]; then
  echo "[GIDR] OK: global-index DR drill passed ($DRILL_DIR cleaned)."
  exit 0
else
  echo "[GIDR] RESULT: global-index DR drill FAILED — see FAIL lines above." >&2
  exit 1
fi
