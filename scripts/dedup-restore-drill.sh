#!/usr/bin/env bash
#
# dedup-restore-drill.sh — Sprint 15 DR validation for the pi-mega-compact store.
#
# Validates a local SQLite checkpoint store (better-sqlite3, PREVENT-PI-004: zero
# network) against its legacy gzipped-JSON DR snapshots and can rebuild the DB
# from those snapshots if it is missing or corrupt.
#
# Mirrors docs/RETENTION_POLICY.md §5 and docs/DEDUP_RUNBOOK.md §6.
#
# Usage:
#   scripts/dedup-restore-drill.sh [STATE_DIR]
#
# STATE_DIR defaults to $MEGACOMPACT_STATE_DIR or the install path
# ~/.pi/agent/extensions/pi-mega-compact. The DR snapshots
# (<sess>.checkpoints.json.gz) live in the same directory.
#
# Exit code is 0 only when every check passes (so it can gate another job).

set -o pipefail

STATE_DIR="${1:-${MEGACOMPACT_STATE_DIR:-$HOME/.pi/agent/extensions/pi-mega-compact}}"
DB="$STATE_DIR/sqlite.db"
FAIL=0

# Resolve the repo root from this script's own location (NOT the state dir), so
# `dist/` can be required regardless of where STATE_DIR points. ($0 always
# points at scripts/dedup-restore-drill.sh when invoked directly.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -d "$REPO_ROOT/dist/src" ]; then
  echo "[DR] ERROR: $REPO_ROOT/dist/src missing — run \`npm run build\` first." >&2
  exit 2
fi
DIST="$REPO_ROOT/dist"

# Locate a node interpreter (the one that built better-sqlite3 for this repo).
NODE="${NODE:-$(command -v node)}"
if [ -z "$NODE" ]; then
  echo "[DR] ERROR: node not found on PATH; set NODE=… explicitly." >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[DR] ERROR: sqlite3 CLI not found (needed for PRAGMA integrity_check)." >&2
  exit 2
fi

pass() { echo "[DR] PASS: $1"; }
fail() { echo "[DR] FAIL: $1"; FAIL=1; }
info() { echo "[DR]      $1"; }

echo "[DR] state dir: $STATE_DIR"

# --- 0. Preconditions ---------------------------------------------------------
if [ ! -d "$STATE_DIR" ]; then
  echo "[DR] INFO: state dir missing ($STATE_DIR). Nothing to drill; exit clean."
  exit 0
fi

# --- 1. PRAGMA integrity_check (assert ok) ------------------------------------
if [ -f "$DB" ]; then
  # Strip ALL whitespace so a trailing newline never falsifies the match.
  INTEGRITY="$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>&1 | tr -d '[:space:]')"
  if [ "$INTEGRITY" = "ok" ]; then
    pass "PRAGMA integrity_check = ok"
  else
    fail "PRAGMA integrity_check = '$INTEGRITY' (corrupt; rebuild in step 4)"
  fi
else
  info "sqlite.db absent — will rebuild from JSON snapshots in step 4."
fi

# --- 2+3. Count + region_hash drift, and 4. rebuild if missing/corrupt -------
# A single node helper does the JSON-side work and the rebuild so we only spawn
# node once. It prints lines we parse below.
HELPER_OUT="$("$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const stateDir = process.argv[1];
const dist = process.argv[2];
const db = path.join(stateDir, "sqlite.db");

// --- JSON snapshot side: total checkpoint count + region_hash set ------------
const jsonFiles = fs.readdirSync(stateDir).filter(f => f.endsWith(".checkpoints.json.gz"));
function readGzJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const buf = fs.readFileSync(p);
    // Decompress via the repo helper (handles versioned + legacy gzip magic).
    const dec = require(path.join(dist, "src", "store", "compression.js"));
    const out = dec.decompressSmart(buf);
    return JSON.parse(out.toString("utf-8"));
  } catch { return fallback; }
}
let jsonCount = 0;
const jsonRegionHashes = new Set();
for (const f of jsonFiles) {
  const sess = f.replace(/\.checkpoints\.json\.gz$/, "");
  const cps = readGzJson(path.join(stateDir, f), []);
  jsonCount += cps.length;
  for (const cp of cps) if (cp.regionHash) jsonRegionHashes.add(cp.regionHash);
}

// --- SQLite side: count + region_hash set -------------------------------------
function haveDb() {
  if (!fs.existsSync(db)) return false;
  try {
    const r = execFileSync("sqlite3", [db, "PRAGMA integrity_check;"], { encoding: "utf8" });
    return r.trim() === "ok";
  } catch { return false; }
}
let sqliteCount = -1;
const sqliteRegionHashes = new Set();
if (haveDb()) {
  sqliteCount = Number(execFileSync("sqlite3", [db, "SELECT COUNT(*) FROM context_chunks;"], { encoding: "utf8" }).trim());
  const rows = execFileSync("sqlite3", [db, "SELECT region_hash FROM context_chunks WHERE region_hash IS NOT NULL;"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const h of rows) sqliteRegionHashes.add(h);
}

console.log("JSON_COUNT=" + jsonCount);
console.log("JSON_RHASHES=" + jsonRegionHashes.size);
console.log("SQLITE_COUNT=" + sqliteCount);
console.log("SQLITE_RHASHES=" + sqliteRegionHashes.size);

// Drift = region hashes present in JSON but absent from SQLite.
const missing = [...jsonRegionHashes].filter(h => !sqliteRegionHashes.has(h));
console.log("MISSING_RHASHES=" + missing.length);

// --- Rebuild if DB missing or corrupt ----------------------------------------
if (!haveDb()) {
  try {
    const migrate = require(path.join(dist, "src", "store", "migrate.js"));
    const res = migrate.migrateJsonToSqlite(stateDir);
    console.log("REBUILT=" + JSON.stringify(res));
    // Re-read sqlite stats so the comparison below reflects the rebuilt DB.
    if (haveDb()) {
      sqliteCount = Number(execFileSync("sqlite3", [db, "SELECT COUNT(*) FROM context_chunks;"], { encoding: "utf8" }).trim());
      const rows2 = execFileSync("sqlite3", [db, "SELECT region_hash FROM context_chunks WHERE region_hash IS NOT NULL;"], { encoding: "utf8" }).split("\n").filter(Boolean);
      sqliteRegionHashes.clear();
      for (const h of rows2) sqliteRegionHashes.add(h);
      const missing2 = [...jsonRegionHashes].filter(h => !sqliteRegionHashes.has(h));
      // Re-emit so the shell parses the rebuilt figures, not the stale -1.
      console.log("SQLITE_COUNT=" + sqliteCount);
      console.log("SQLITE_RHASHES=" + sqliteRegionHashes.size);
      console.log("MISSING_RHASHES=" + missing2.length);
    }
  } catch (e) {
    console.log("REBUILD_ERROR=" + e.message);
  }
} else {
  console.log("REBUILT=skipped");
}
' "$STATE_DIR" "$DIST" 2>&1)" || {
  echo "[DR] ERROR: node helper failed." >&2
  echo "$HELPER_OUT" >&2
  exit 2
}

# Parse the helper output. Take the LAST occurrence of each key so a value
# re-emitted after a rebuild (e.g. SQLITE_COUNT) supersedes the stale pre-rebuild.
last_value() { echo "$HELPER_OUT" | grep "^$1=" | tail -1 | sed "s/^$1=//"; }
JSON_COUNT=$(last_value JSON_COUNT)
JSON_RHASHES=$(last_value JSON_RHASHES)
SQLITE_COUNT=$(last_value SQLITE_COUNT)
SQLITE_RHASHES=$(last_value SQLITE_RHASHES)
MISSING_RHASHES=$(last_value MISSING_RHASHES)
REBUILT=$(last_value REBUILT)
REBUILD_ERROR=$(last_value REBUILD_ERROR)

if [ -n "$REBUILD_ERROR" ]; then
  fail "rebuild raised: $REBUILD_ERROR"
elif [ "$REBUILT" != "skipped" ]; then
  info "rebuilt sqlite.db from JSON snapshots: $REBUILT"
  pass "DB rebuilt from legacy snapshots"
fi

# Step 2: count comparison. Only meaningful when JSON DR snapshots exist — a
# fresh v0.2.0 store has none (it is the source of truth), so skip the check.
if [ "${JSON_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  if [ "$SQLITE_COUNT" -eq "$JSON_COUNT" ]; then
    pass "context_chunks count ($SQLITE_COUNT) == JSON snapshot count ($JSON_COUNT)"
  else
    fail "context_chunks=$SQLITE_COUNT but JSON snapshots total=$JSON_COUNT (drift!)"
  fi
else
  info "no legacy JSON snapshots present — count check skipped (sqlite.db is the source of truth)"
fi

# Step 3: region_hash set comparison.
if [ "${JSON_RHASHES:-0}" -gt 0 ] 2>/dev/null; then
  if [ "$MISSING_RHASHES" = "0" ]; then
    pass "all $JSON_RHASHES JSON region_hashes present in sqlite ($SQLITE_RHASHES)"
  else
    fail "$MISSING_RHASHES JSON region_hash(es) missing from sqlite (state drift)"
  fi
else
  info "no JSON region_hashes to compare — drift check skipped"
fi

# --- Summary -----------------------------------------------------------------
if [ "$FAIL" -eq 0 ]; then
  echo "[DR] OK: DR drill passed for $STATE_DIR"
  exit 0
else
  echo "[DR] RESULT: DR drill FAILED — see FAIL lines above." >&2
  exit 1
fi
