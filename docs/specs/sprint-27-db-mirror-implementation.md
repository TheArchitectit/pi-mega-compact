# S27 Sprint Plan — DB-Mirror Tasks 5–9 + DB Maintenance

**Date:** 2026-07-17
**Branch:** `feat/cache-stability-db-mirror`
**Blocks on:** Tasks 1–4 (schema, helpers, epoch.ts, config flag) — ✅ merged
**Priority:** P0 (cache stability = direct $ savings)

**Status:** Tasks 5–9 ✅ implemented (v0.7.4). Task 10 (DB maintenance /commands) ✅ implemented (v0.7.5). S27 complete.

---

## 1. Database Design

### Current Schema (v2, Tasks 1–4)

```sql
-- raw_transcript: append-only mirror of every message before compaction
CREATE TABLE IF NOT EXISTS raw_transcript (
  content_hash    TEXT NOT NULL,        -- SHA-256 of canonicalized bytes (PK)
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,     -- monotonic per session
  role            TEXT NOT NULL,
  content_bytes   TEXT NOT NULL,        -- canonical JSON, stable key order
  tool_name       TEXT,
  message_timestamp INTEGER,            -- ORIGINAL msg timestamp at append
  checkpoint_epoch TEXT NOT NULL,       -- epoch nonce this append belongs to
  PRIMARY KEY (content_hash)
);
CREATE INDEX IF NOT EXISTS idx_rt_session_seq ON raw_transcript(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_rt_epoch ON raw_transcript(checkpoint_epoch);

-- checkpoint_epochs: registry of compaction epochs
CREATE TABLE IF NOT EXISTS checkpoint_epochs (
  epoch_id            TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  started_seq         INTEGER NOT NULL,
  committed_seq       INTEGER,
  summary_message_text TEXT,
  cut_index           INTEGER,
  checkpoint_id       TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpe_session ON checkpoint_epochs(session_id, created_at);
```

### Dedup Mirror Schema (NEW — Task 6)

Add to `src/store/sqlite.ts` (schema v3):

```sql
-- dedup_mirror: space-efficient deduplicated store of raw_transcript content
-- Each unique content_hash stores its bytes ONCE; raw_transcript rows reference
-- this table instead of storing duplicate content_bytes inline.
CREATE TABLE IF NOT EXISTS dedup_mirror (
  content_hash    TEXT PRIMARY KEY,     -- same SHA-256 as raw_transcript
  content_bytes   TEXT NOT NULL,        -- stored ONCE per unique content
  ref_count       INTEGER NOT NULL DEFAULT 1,  -- how many raw_transcript rows reference this
  first_seen_at   INTEGER NOT NULL,
  byte_length     INTEGER NOT NULL      -- pre-computed for fast size queries
);
```

**Migration path:** On first open after v3 upgrade:
1. `INSERT OR IGNORE INTO dedup_mirror SELECT content_hash, content_bytes, 1, strftime('%s','now')*1000, LENGTH(content_bytes) FROM raw_transcript`
2. `ALTER TABLE raw_transcript ADD COLUMN content_ref TEXT` (nullable FK to dedup_mirror)
3. Backfill: `UPDATE raw_transcript SET content_ref = content_hash WHERE content_ref IS NULL`
4. Future reads: prefer `content_ref → dedup_mirror.content_bytes`, fall back to inline `content_bytes` for legacy rows

**Dedup benefit:** Repeated system prompts, tool schemas, and recurring messages store bytes once, not N times. A session with 200 turns where the system prompt (4KB) repeats = 800KB saved → 4KB stored.

### Maintenance Operations

| Operation | Trigger | What it does |
|-----------|---------|--------------|
| **Retention prune** | Auto (startup) + `/mega-db-prune` | DELETE raw_transcript + dedup_mirror rows older than TTL (default 30d) |
| **VACUUM** | `/mega-db-vacuum` | Reclaim freed pages (run after prune) |
| **Stats** | `/mega-db-stats` | Show table sizes, row counts, disk usage, dedup ratio |
| **Integrity check** | `/mega-db-check` | `PRAGMA integrity_check` + orphan detection |
| **Ref-count reconcile** | `/mega-db-reconcile` | Fix dedup_mirror.ref_count drift from crashes |

---

## 2. Sprint Tasks

### Task 5 — Context Hook Rewrite (P0, `extensions/mega-events.ts`)

**File:** `extensions/mega-events.ts`, lines ~257–356 (the `context` event handler)

**Current flow:**
1. `before_agent_start`: splice summary + trimmed messages into context
2. `session_before_compact`: compute drop range, compress, build summary
3. `context`: fast-gate → tiered-pressure → `runCompact()` if threshold met

**New flow (behind `config.dbMirror`):**

```
┌─────────────────────────────────────────────────────┐
│ context event fires                                  │
│   ├─ dbMirror OFF → existing path (unchanged)        │
│   └─ dbMirror ON:                                    │
│       1. Append ALL incoming messages to              │
│          raw_transcript (appendRawTranscript)         │
│       2. Bump monotonic seq counter                   │
│       3. Fast-gate check (same as before)             │
│       4. If compacting:                                │
│          a. Write checkpoint_epoch (writeCheckpointEpoch) │
│          b. Fork: read raw_transcript [0..cut]        │
│          c. Compress fork → summary                   │
│          d. Build served window:                      │
│             [summary, ...messages.slice(cut)]         │
│          e. Stamp with epoch nonce (from epoch.ts)    │
│       5. Serve to pi                                  │
└─────────────────────────────────────────────────────┘
```

**Key invariants:**
- `appendRawTranscript` runs BEFORE any compaction check (every message is captured)
- `content_hash` is SHA-256 of `JSON.stringify(msg, Object.keys(msg).sort())` (canonical key order)
- `seq` is monotonic per session (read `MAX(seq)` on init, increment)
- `checkpoint_epoch.epochId = "epoch:" + checkpointId`
- Served window uses `epoch.nonce` instead of `Date.now()` in cache key
- `firstKeptId` stays `messages[cut].id` (unchanged — anchor floor inherited)

**Estimated:** ~120 lines of new conditional logic in mega-events.ts

---

### Task 6 — Fork Snapshot → Compress/Dedupe Pipeline (P1)

**File:** `extensions/mega-events.ts` (post-serve), new `src/mirror/dedup.ts`

**What:** After the served window is handed to pi, asynchronously:
1. Read raw_transcript rows `[0..cut_index]` for the epoch
2. For each row, compute content_hash
3. `INSERT OR IGNORE INTO dedup_mirror ...` (stores bytes once per unique hash)
4. Update `raw_transcript.content_ref` to point to dedup_mirror
5. Increment `dedup_mirror.ref_count` for existing hashes

**New file:** `src/mirror/dedup.ts`
- `dedupTranscript(db, sessionId, fromSeq, toSeq)` — runs the dedup pipeline
- `getDedupRatio(db, sessionId)` — returns `{ totalBytes, uniqueBytes, ratio }`

**Guard:** Only runs when `config.dbMirror === true`. Fire-and-forget (non-blocking, errors logged not thrown).

**Estimated:** ~60 lines in src/mirror/dedup.ts, ~30 lines wiring in mega-events.ts

---

### Task 7 — Recall Demotion (P2, `src/recall.ts`)

**What:** Document the contract that when `dbMirror` is ON, recall prefers the dedup mirror over the legacy JSON checkpoint for reconstructing context. No structural code change — just a contract comment + one conditional:

```ts
// In recallAndInline, before reading from checkpoint:
if (config.dbMirror) {
  // Prefer raw_transcript + dedup_mirror for byte-stable reconstruction.
  // Falls back to legacy checkpoint if mirror is empty (pre-migration sessions).
}
```

**Estimated:** ~20 lines (comments + one if-guard)

---

### Task 8 — Tests (P0, new `src/mirror/mirror.test.ts`)

**Test matrix:**

| Test | What it proves |
|------|---------------|
| `append + list round-trip` | appendRawTranscript → listRawTranscriptRange returns same rows |
| `epoch nonce determinism` | same checkpointId → same epochId + nonce, every time |
| `epoch idempotency ON CONFLICT` | re-running writeCheckpointEpoch with same epochId updates, not duplicates |
| `dedup ratio` | 3 rows with same content_hash → ref_count=3, uniqueBytes=1x |
| `dedup migration` | pre-v3 rows without content_ref still readable |
| `context hook dbMirror=ON` | messages appear in raw_transcript after context event |
| `served window stability` | two consecutive context events with same messages → identical cache key |
| `retention prune` | rows older than TTL are deleted |
| `db-vacuum command` | runs without error, reports reclaimed space |
| `db-stats command` | reports correct row counts and sizes |
| `db-check command` | integrity_check passes |
| `db-reconcile command` | fixes ref_count drift |

**Estimated:** ~200 lines in src/mirror/mirror.test.ts

---

### Task 9 — Maps + Guardrails (P3)

**What:**
- Update `docs/INDEX_MAP.md` with S27 DB-mirror tasks 5–9 entries
- Update `docs/HEADER_MAP.md` with new file:line refs
- Add `PREVENT-PI-004` annotation to any new code paths (all local, no network)
- Run `python3 scripts/regression_check.py --all`
- Run `npm run lint`
- Verify `scripts/guardrails-scan.mjs` passes

**Estimated:** ~30 min

---

### Task 10 — DB Maintenance /Commands (NEW)

**File:** `extensions/mega-commands.ts` (add to existing `registerCommands`)

**Commands:**

| Command | Description |
|---------|-------------|
| `/mega-db-stats` | Table row counts, page counts, disk size, dedup ratio, WAL size |
| `/mega-db-prune` | DELETE rows older than TTL (default 30d), report deleted count |
| `/mega-db-vacuum` | `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM`, report reclaimed bytes |
| `/mega-db-check` | `PRAGMA integrity_check` + orphan detection (dedup_mirror rows with no raw_transcript refs) |
| `/mega-db-reconcile` | Fix `dedup_mirror.ref_count` drift: `UPDATE dedup_mirror SET ref_count = (SELECT COUNT(*) FROM raw_transcript WHERE content_ref = dedup_mirror.content_hash)` |

**Auto-maintenance:** On extension init (startup), if `dbMirror` is ON:
1. Run retention prune silently (DELETE old rows)
2. If WAL > 10MB, auto-checkpoint: `PRAGMA wal_checkpoint(TRUNCATE)`
3. Log result to events.log

**Estimated:** ~120 lines in mega-commands.ts, ~40 lines in mega-events.ts (startup hook)

---

## 3. Execution Order

```
Task 5 (context hook)     ──┐
                             ├──→ Task 8 (tests) ──→ Task 9 (maps/guardrails)
Task 6 (dedup pipeline)  ──┘         ↑
Task 7 (recall demotion) ────────────┘
Task 10 (DB maintenance) ──→ (independent, can run in parallel)
```

**Critical path:** Task 5 → Task 8 → Task 9

---

## 4. Acceptance Criteria

- [ ] `MEGACOMPACT_DB_MIRROR=true` + existing tests pass (no regressions)
- [ ] `MEGACOMPACT_DB_MIRROR=false` → zero behavior change (existing tests unchanged)
- [ ] Raw transcript captures ALL messages (including tool results)
- [ ] Two identical compactions → same epoch nonce (cache-stable)
- [ ] Dedup ratio > 2x on a 50-turn session with repeated system prompt
- [ ] `/mega-db-stats` reports accurate counts
- [ ] `/mega-db-prune` deletes old rows, `/mega-db-vacuum` reclaims space
- [ ] `PRAGMA integrity_check` passes
- [ ] `npm run lint` passes
- [ ] `python3 scripts/regression_check.py --all` passes
- [ ] `scripts/guardrails-scan.mjs` passes (zero new violations)

---

## 5. Rollback

Set `MEGACOMPACT_DB_MIRROR=false` (default). Tables exist but are empty/unqueried. Schema v3 is additive (no column drops). Zero behavior change when flag is OFF.
