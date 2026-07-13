# Tester Guide — pi-mega-compact v0.2.0

This guide is for QA testers and contributors validating pi-mega-compact before
a release or after a change. It covers environment setup, the automated test
suite, a manual testing checklist, bug-report expectations, and known
limitations.

---

## Prerequisites

- **Node >= 18** — check with `node -v`.
- **npm** — ships with Node; used to install the `better-sqlite3` native module.
- **A pi coding agent install** that loads extensions from
  `~/.pi/agent/extensions/` — see the
  [pi repo](https://github.com/earendil-works/pi).
- **`jq`** — used by `install.sh` and useful for reading `events.log` and
  `dashboard.json` during manual testing.
- **`sqlite3` CLI** (optional) — handy for inspecting `sqlite.db` directly
  during DR drills and debugging.

### Install the extension

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git \
  ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install      # builds the better-sqlite3 native module
npm run build    # tsc → dist/
```

Or use the bundled helper:

```bash
./install.sh          # copy into ~/.pi/agent/extensions/pi-mega-compact
./install.sh -s       # symlink instead of copy (dev mode)
```

### Register with pi

Add the extension path to your pi config's `pi.extensions` list:

```jsonc
{
  "pi": {
    "extensions": ["~/.pi/agent/extensions/pi-mega-compact/extensions/mega-compact.ts"]
  }
}
```

---

## Test Environment Setup

1. **Clone and build:**

   ```bash
   git clone https://github.com/TheArchitectit/pi-mega-compact.git
   cd pi-mega-compact
   npm install
   npm run build
   ```

2. **Verify the test suite passes:**

   ```bash
   npm test
   ```

   This runs `tsc` then `node --test` on `dist/**/*.test.js`. All 192 tests
   should pass. If any fail, stop and file a bug (see
   [What to Include in a Bug Report](#what-to-include-in-a-bug-report)).

3. **Run the linter:**

   ```bash
   npm run lint       # tsc --noEmit + guardrails-scan
   npm run guardrails # regression_check + guardrails-scan
   ```

   Both should be clean. The guardrails suite enforces the Four Laws, scope
   boundaries, secret safety, and regression checks.

4. **Confirm the extension loads in pi:**

   Start pi and run `/mega-status`. You should see config output, current
   context usage, and store stats (checkpoint count, dedup rate, tokens saved).

---

## Running the Test Suite

```bash
npm test
```

This runs **192 tests** via `node --test` on the compiled `dist/` output.

### Unit tests

Engine modules in isolation:

- **`src/engine.ts`** — `compactSession()` Trident pipeline, recall, persistence.
- **`src/vectorStore.ts`** — add/search/dedupe, MinHash/LSH, cosine, MMR.
- **`src/embedder.ts`** — `TrigramEmbedder` 512-dim, L2-normalized.
- **`src/compact.ts`** — `summarizeMessages`, `mergeCompactSummaries`, `autoCompactCheck`.
- **`src/supersede.ts`** — obsolete file-read pruning.
- **`src/boundary.ts`** — drop-boundary guards (anchor floor + tool-pair).
- **`src/tokens.ts`** — deterministic token estimator.
- **`src/config/dedup.ts`** — `DedupConfig` / `loadDedupConfig()` env-var
  resolution, tier flag defaults.
- **`src/store/sqlite.ts`** — SQLite store CRUD, FTS5 trigram search,
  parameterized queries.
- **`src/store/compression.ts`** — `compressSmart` / `decompressSmart`
  round-trip, zstd fallback.
- **`src/store/backfill.ts`** — resumable backfill orchestrator (L0/L1/L2/
  RAPTOR), idempotent re-runs.
- **`src/monitoring.ts`** — `events.log` append, `dashboard.json` aggregation,
  FP-rate alert evaluation.
- **`src/canary.ts`** — `CanaryController` sequential L0→L1→L2→RAPTOR
  step-up, p95 breach auto-disable.

### Integration tests

- **`src/recall.ts`** — `recallAndInline()` end-to-end: auto-inline on resume,
  on-demand recall, dedup sentinel insertion, top-K retrieval with MMR.
- **`src/store/migrate.ts`** — `migrateJsonToSqlite()` JSON → SQLite migration,
  idempotent re-run, legacy `.checkpoints.json.gz` retained as DR snapshots.
- **`src/httpEmbedder.ts`** — BYO localhost embedder contract, loopback-only
  enforcement (remote host rejected at config time, PREVENT-PI-004).

### Handler-level tests

- **`extensions/mega-compact.test.ts`** — drives the compiled extension through
  a faithful mock pi runtime. Covers:
  - `context` event → auto-trigger → compact → checkpoint persist.
  - `session_start` (resume) → auto-inline recall.
  - `session_before_compact` cancellation (no double-compact).
  - Slash command handlers (`/mega-compact`, `/mega-status`,
    `/mega-recall`, `/mega-dashboard`).
  - Live stats widget updates on context, agent, and turn events.

---

## Manual Testing Checklist

Each section is a standalone scenario. Run them in order or independently.

### 1. Auto-Compaction

**Goal:** Verify that the extension auto-compacts when context usage exceeds the
configured threshold.

**Steps:**

1. Start pi with the extension loaded. Confirm with `/mega-status`.
2. Note your current tier and threshold:
   ```
   /mega-status
   ```
   The status output shows `MEGACOMPACT_TIER` (default `low` = 50k tokens) and
   `MEGACOMPACT_FAST_GATE_PCT` (default 70%).
3. Work a session until context fills past the gate percentage (70%+ of the
   tier threshold). You can speed this up by:
   - Reading large files repeatedly.
   - Having long conversations.
   - Setting `MEGACOMPACT_TIER=low` (50k threshold) so the gate fires sooner.
4. Watch the live stats widget above the pi editor:
   ```
    ⚡ low │ 35k/50k tokens (70%) │ 0 chkpts │ turn 12
      ◐ armed │ dedup: 0% │ saved: 0 tok
   ```
   The trigger state should transition: `○ idle` → `◐ armed` (≥ gate %) →
   `● ready` (≥ threshold).
5. When the trigger fires, you should see:
   - A `compact_start` event in `events.log`.
   - Context visibly drops (token count decreases).
   - A checkpoint persisted (`chkpt_xxx` appears in status and store).
   - A `compact_end` event in `events.log` with `fromTokens` / `toTokens`.
6. Verify the checkpoint persisted in the SQLite store:
   ```bash
   sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
     "SELECT checkpoint_id, session_id, timestamp, dedup_status FROM context_chunks ORDER BY timestamp DESC LIMIT 5;"
   ```

**Pass criteria:**
- Auto-trigger fires at the configured threshold.
- Context drops after compaction.
- Checkpoint appears in the store.
- `events.log` has `compact_start` and `compact_end` entries.
- Widget shows updated checkpoint count and tokens saved.

---

### 2. Resume / Auto-Inline

**Goal:** Verify that checkpoints are auto-inlined when resuming a session with
`pi --continue`.

**Steps:**

1. End the session from Scenario 1 (or any session with persisted checkpoints).
2. Restart pi with the continue flag:
   ```bash
   pi --continue
   ```
3. The extension's `session_start` handler fires `recallAndInline` with
   `source:"resume"`. Check `events.log`:
   ```bash
   tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
   Look for an event with `"type":"recall_inject"` — it should list the
   checkpoint IDs that were auto-inlined.
4. In the pi session, ask about something you worked on earlier. The relevant
   checkpoint content should be available without manual recall.
5. Verify with `/mega-status` — the "injected" count should be > 0.

**Pass criteria:**
- `pi --continue` triggers auto-inline.
- `events.log` shows `recall_inject` with checkpoint IDs.
- Relevant context is available in the resumed session.
- `/mega-status` shows injected checkpoints.

**Note:** `pi --continue` emits `session_start` with reason `startup` (not
`resume`). The extension broadened its check in v0.2.0 to handle this — it
recalls whenever the session has persisted checkpoints and a usable query.
Brand-new empty sessions are excluded.

---

### 3. On-Demand Recall

**Goal:** Verify that `/mega-recall [query]` finds and inlines relevant
checkpoints.

**Steps:**

1. In a session with persisted checkpoints, run:
   ```
   /mega-recall file reading optimization
   ```
   (Replace the query with something relevant to your session history.)
2. The command semantic-searches the local store, dedupes against the current
   context window, and inlines the top-K checkpoints (default K = 3, set by
   `MEGACOMPACT_AUTO_INLINE_K`).
3. Check `events.log` for a `recall_inject` event:
   ```bash
   grep recall_inject ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
4. Run `/mega-recall` with no query — it should use your latest message
   as the query.
5. Run `/mega-recall` with a nonsense query that matches nothing — it
   should return gracefully without injecting irrelevant content.

**Pass criteria:**
- Relevant checkpoints are inlined for a matching query.
- No-query variant uses the latest message.
- Non-matching query does not inject garbage.
- `events.log` records the recall event.

---

### 4. Dedup Verification

**Goal:** Verify that the L0/L1/L2 dedup tiers collapse duplicate and
near-duplicate regions correctly.

**Steps:**

1. Work a session that produces similar content multiple times (e.g., read the
   same file twice, or ask similar questions).
2. After several compactions, check the dedup hit rate:
   ```
   /mega-status
   ```
   The status output includes `dedup rate` — the percentage of compacted
   regions that were already stored (collapsed as duplicates).
3. Inspect the dedup decisions in `events.log`:
   ```bash
   grep -E '"result":"(deduped|new|mark_only)"' \
     ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
   - `deduped` — region was collapsed (duplicate detected).
   - `new` — region was stored as a new checkpoint.
   - `mark_only` — tier recorded its decision but did not collapse (safe
     degrade mode).
4. Verify the SQLite store has rows with `dedup_status` set:
   ```bash
   sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
     "SELECT dedup_status, COUNT(*) FROM context_chunks GROUP BY dedup_status;"
   ```
   You should see a mix of `active` and `removed` rows (removed = collapsed by
   SemDeDup, kept for audit but excluded from retrieval).
5. Optional: Toggle a tier to `MARK_ONLY` and verify it records but does not
   collapse:
   ```bash
   MEGACOMPACT_MARK_ONLY_L1=true pi --continue
   ```
   Work a session, then check that L1 decisions in `events.log` show
   `result:"mark_only"` and the corresponding rows in the store are `active`
   (not `removed`).

**Pass criteria:**
- Dedup hit rate > 0% after repeated similar content.
- `events.log` shows `deduped` results for duplicates.
- `dedup_status` column in SQLite has `removed` entries for collapsed rows.
- `MARK_ONLY` mode records decisions without collapsing.

---

### 5. Dashboard

**Goal:** Verify the localhost dashboard shows live state correctly.

**Steps:**

1. Start the dashboard from a pi session:
   ```
   /mega-dashboard
   ```
   This starts a local HTTP server on a random port (3000–3999) and writes the
   URL to the terminal.
2. Open the URL in a browser. You should see:
   - **Status bar** — current tier, trigger state, context utilization.
   - **Token gauge** — live token usage vs. threshold.
   - **Compaction graph** — timeline of compaction events with token counts.
   - **Checkpoint list** — recent checkpoints with timestamps.
   - **Recall activity** — dedup hits and injection stats.
   - **Event stream** — real-time SSE updates (no polling).
3. Work a session to trigger a compaction. The dashboard should update in real
   time via SSE (Server-Sent Events).
4. Check the API endpoints directly:
   ```bash
   curl -s http://127.0.0.1:<port>/api/snapshot | jq .
   curl -s http://127.0.0.1:<port>/api/events   # SSE stream
   ```
5. Verify dashboard status and stop:
   ```
   /mega-dashboard-status
   /mega-dashboard-stop
   ```

**Pass criteria:**
- Dashboard starts and opens in a browser.
- Token gauge and store stats reflect current session state.
- SSE stream updates in real time on compaction/recall events.
- `/mega-dashboard-stop` cleanly shuts down the server.
- Server only listens on `127.0.0.1` (no network exposure).

---

### 6. DR Drill

**Goal:** Verify the disaster-recovery drill validates SQLite integrity and can
rebuild from legacy JSON snapshots.

**Steps:**

1. Run the DR drill script:
   ```bash
   scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact
   ```
2. The script performs these checks:
   - `PRAGMA integrity_check` on `sqlite.db` — should return `ok`.
   - Counts `context_chunks` rows and compares to the legacy
     `.checkpoints.json.gz` snapshot count.
   - Recomputes the `region_hash` set and compares to stored hashes (catches
     state drift).
   - If `sqlite.db` is missing or corrupt: rebuilds from
     `<sessionId>.checkpoints.json.gz` via `migrateJsonToSqlite()`.
3. Verify the output shows all checks passing.
4. Optional: Simulate corruption to test the rebuild path:
   ```bash
   cp ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
      ~/.pi/agent/extensions/pi-mega-compact/sqlite.db.bak
   echo "corrupt" > ~/.pi/agent/extensions/pi-mega-compact/sqlite.db
   scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact
   # Should detect corruption and rebuild from JSON snapshots
   cp ~/.pi/agent/extensions/pi-mega-compact/sqlite.db.bak \
      ~/.pi/agent/extensions/pi-mega-compact/sqlite.db
   ```

**Pass criteria:**
- `PRAGMA integrity_check` returns `ok`.
- Row count matches JSON snapshot count (or is higher if new checkpoints were
  added post-migration).
- Region hashes match (no state drift).
- Corrupt SQLite triggers rebuild from JSON snapshots.
- Rebuilt database passes integrity check.

---

### 7. Benchmark

**Goal:** Verify the dedup benchmark runs at scale and produces usable metrics.

**Steps:**

1. Build the project (benchmarks run on compiled output):
   ```bash
   npm run build
   ```
2. Run the benchmark at three scales:
   ```bash
   node scripts/dedup-benchmark.mjs 100 1000 10000
   ```
   This generates 100, 1,000, and 10,000 synthetic checkpoints and runs them
   through the full dedup pipeline.
3. The benchmark outputs:
   - **Dedup hit rate** — percentage of checkpoints collapsed as duplicates at
     each scale.
   - **Compression ratio** — token reduction from compaction.
   - **Per-tier p95 latency** — L0/L1/L2/RAPTOR p95 in milliseconds (should be
     under `MEGACOMPACT_P95_BUDGET_MS` default 100 ms).
   - **Storage bytes** — total SQLite database size at each scale.

**Pass criteria:**
- Benchmark completes without errors at all three scales.
- p95 latency per tier is within the 100 ms budget.
- Dedup hit rate increases with scale (more duplicates at higher counts).
- Storage grows sublinearly (dedup collapses duplicates).

---

## What to Include in a Bug Report

When filing a bug at
[https://github.com/TheArchitectit/pi-mega-compact/issues](https://github.com/TheArchitectit/pi-mega-compact/issues),
include:

1. **`/mega-status` output** — config + current context usage + store
   stats (checkpoint count, dedup rate, tokens saved).
2. **`/mega-dashboard-status` output** — dashboard server status (if running).
3. **pi version** — `pi --version` or the release tag you're running.
4. **OS** — e.g., `Linux 6.12.94-1-MANJARO x86_64`, `macOS 15.3`, etc.
5. **Node version** — `node -v` (must be >= 18).
6. **`events.log` slice** — the relevant lines around the problem:
   ```bash
   tail -100 ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
   Each line is `{ts, tier, result, latencyMs, falsePositive?}`. Include the
   lines around the timestamp of the issue.
7. **`dashboard.json`** — aggregate metrics from the state dir:
   ```bash
   cat ~/.pi/agent/extensions/pi-mega-compact/dashboard.json | jq .
   ```
   This contains hit rate, FP rate, per-tier p95, and storage bytes.
8. **If you suspect data loss or duplication:**
   - `sqlite.db` file size + checkpoint count:
     ```bash
     ls -lh ~/.pi/agent/extensions/pi-mega-compact/sqlite.db
     sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
       "SELECT COUNT(*) FROM context_chunks;"
     ```
   - DR drill output: `scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact`
   - `dedup_status` breakdown: `SELECT dedup_status, COUNT(*) FROM context_chunks GROUP BY dedup_status;`

---

## Known Issues & Limitations

- **MiniLM not shipped.** `MEGACOMPACT_MINILM` defaults to `false`. The ONNX
  embedder was prototyped then dropped (async-vs-sync conflict, second native
  dep). Use `MEGACOMPACT_EMBEDDING_URL` for a localhost embedder instead.

- **RAPTOR in shadow mode.** `MEGACOMPACT_RAPTOR_ENABLED` defaults to `false`.
  The tree builds + logs to `events.log` but does not serve retrieval yet.

- **Default embedder is heuristic-strength.** `TrigramEmbedder` (512-dim
  trigram bag) is zero-dependency and offline but not production-RAG quality.
  Set `MEGACOMPACT_EMBEDDING_URL` for a localhost embedding server for better
  semantic recall (loopback-only, PREVENT-PI-004).

- **No background cron for retention.** The 90-day TTL is a manual maintenance
  procedure (see `docs/RETENTION_POLICY.md`). `VACUUM` is exclusive/blocking —
  run off-peak when no session is active.

- **GTX 1080 / older hardware.** The extension itself is CPU-only. If you use
  a BYO GPU embedder, older GPUs (Pascal sm_61) may be slower.

- **No remote monitoring.** All monitoring is local files (`events.log`,
  `dashboard.json`). No telemetry, no remote alertmanager (PREVENT-PI-004).

---

## Severity Classification

Bug reports should reference the severity tiers in
[`docs/DEDUP_RUNBOOK.md`](docs/DEDUP_RUNBOOK.md). Summary:

| SEV | Definition |
|-----|------------|
| **SEV-1** | Data loss or injection loop |
| **SEV-2** | False-positive / false-negative dedup |
| **SEV-3** | Monitoring gap |

**Immediate action:** Flip the suspect tier to `MARK_ONLY_*` = `true` for
SEV-1/SEV-2. Verify extension is loaded for SEV-3. See `DEDUP_RUNBOOK.md` §2
for the full first-15-minutes checklist.
