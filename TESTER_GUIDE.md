# Tester Guide — pi-mega-compact v0.6.9

This guide is for QA testers and contributors validating pi-mega-compact before
a release or after a change. It covers environment setup, the automated test
suite, a manual testing checklist, bug-report expectations, and known
limitations.

---

## Prerequisites

- **Node >= 22.13** — check with `node -v`. Required for the `node:sqlite`
  (`DatabaseSync`) built-in store. **No native module is compiled** — there is
  no `better-sqlite3` build step anymore.
- **npm** — ships with Node.
- **A pi coding agent install** with package support (`pi install` /
  `pi update --extensions`) — see the
  [pi repo](https://github.com/earendil-works/pi).
- **`jq`** (optional) — useful for reading `events.log` and `dashboard.json`
  during manual testing.
- **`sqlite3` CLI** (optional) — handy for inspecting the store directly during
  DR drills and debugging.

### Install the extension (npm is the ONLY supported path)

Distribution and updates go through `npm publish` + `pi update --extensions`
**only** (PREVENT-DIST-001). Tarballs (`npm pack` / `.tgz`) and symlinks bypass
pi's package manager and do NOT propagate to other devices — never use them to
validate a real install.

```bash
pi install npm:pi-mega-compact     # first time: adds to packages + installs
pi update --extensions             # thereafter: pulls the latest published version
```

pi auto-discovers the extension from the package's own
`"pi": { "extensions": [...] }` manifest entry — **no manual `settings.json` /
`pi.extensions` edit is needed.**

> **Confirm the version you're testing.** After `pi update --extensions`, the
> toolbar widget shows `vX.Y.Z` (read from `package.json` at runtime), and
> `/mega-status` prints the same version. This is the fastest way to verify the
> update actually landed. Check the registry with
> `npm view pi-mega-compact version`.

> **Beware a stale `extensions/` copy shadowing the npm install.** pi pulls the
> npm-managed extension into `~/.pi/agent/npm/node_modules/pi-mega-compact`, but
> a **separate, older copy can linger at `~/.pi/agent/extensions/pi-mega-compact`**
> (e.g. a past dev symlink or manual install). That copy is what pi actually
> loads if present — and it can be a much older version whose `src/` still has the
> static pglite import, crashing at load with `Cannot find module '@electric-sql/pglite'`
> even after you publish a fixed version. Symptoms: `pi` crashes on startup, but
> `npm view pi-mega-compact version` shows the new version. Fix: `pi uninstall npm:pi-mega-compact`,
> then `rm -rf ~/.pi/agent/extensions/pi-mega-compact`, then reinstall. Always
> verify the loaded path + version:
> ```bash
> pi list | grep pi-mega-compact        # path must be .../npm/node_modules/... , NOT .../extensions/...
> cat ~/.pi/agent/npm/node_modules/pi-mega-compact/package.json | grep '"version"'   # must equal the published version
> ```

### From a git checkout (development only — NOT a valid test target)

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git
cd pi-mega-compact
npm install      # dev deps only; no native build
npm run build    # tsc → dist/
```

A local checkout can run the automated suite, but a **real** install/update must
be validated via npm (bump version → `npm publish` → `pi update --extensions`).

---

## Test Environment Setup

1. **Install and build** (checkout for development):

   ```bash
   git clone https://github.com/TheArchitectit/pi-mega-compact.git
   cd pi-mega-compact
   npm install && npm run build
   ```

2. **Verify the test suite passes:**

   ```bash
   npm test
   ```

   This runs `tsc` then `node --test` on `dist/**/*.test.js`. All **346** tests
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

   Install via `pi install npm:pi-mega-compact`, then start pi and run
   `/mega-status`. You should see the installed **version** (`vX.Y.Z`), config
   output, current context usage, and store stats (checkpoint count, dedup rate,
   tokens saved).

---

## Running the Test Suite

```bash
npm test
```

This runs **346 tests** via `node --test` on the compiled `dist/` output.

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
- **`src/store/sqlite.ts`** — `node:sqlite` (`DatabaseSync`) store CRUD, FTS5
  trigram search, parameterized queries (no native addon).
- **`src/store/vectorIndex.ts`** — async PGlite/HNSW cross-repo index, kill-switch
  (`MEGACOMPACT_PGLITE_DISABLED`) graceful degrade to sync scan.
- **`src/store/compression.ts`** — `compressSmart` / `decompressSmart`
  round-trip, zstd fallback.
- **`src/store/backfill.ts`** — resumable backfill orchestrator (L0/L1/L2/
  RAPTOR), idempotent re-runs.
- **`src/memory.ts` / `src/memoryOps.ts` / `src/memoryRecall.ts`** — durable
  memory store, apply/consolidate ops, recall + auto-inline (RAG context).
- **`src/driftDetection.ts`** — cross-repo drift report (stale/idle/compaction
  lag/model churn).
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
- **`extensions/mega-trim.ts`** — S16 live context-event trim (compact-and-
  continue, anchor floor + tool-pair boundary honored).

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
2. Note your current **preset** and threshold:
   ```
   /mega-status
   ```
   The status output shows `preset` (the `MEGACOMPACT_TIER` base preset, default
   `low` = 50% of the model context window) and `MEGACOMPACT_FAST_GATE_PCT` (default 70%). The headline
   `tier` is the **live pressure band** (`low`/`medium`/`high`/`ultra`/`mega`), not
   a manual setting — there is no `/mega-tier` command (removed in v0.6.0).
3. Work a session until context fills past the gate percentage (70%+ of the
   tier threshold). You can speed this up by:
   - Reading large files repeatedly.
   - Having long conversations.
   - Setting `MEGACOMPACT_TIER=low` (50% of the context window) so the gate fires sooner.
4. Watch the live stats widget above the pi editor:
   ```
    ⚡ low·low v0.6.0 │ 35k/50k tokens (70%) │ 0 chkpts │ turn 12
      ◐ armed │ dedup: 0% │ saved: 0 tok
   ```
   The headline band **auto-climbs** as context fills: `low → medium → high →
   ultra → mega` (driven by `currentTokens / effectiveThreshold`, where
   `effectiveThreshold = tierPct × contextWindow`), then falls back
   as a compaction relieves pressure. The trigger state should transition:
   `○ idle` → `◐ armed` (≥ gate %) → `● ready` (≥ effectiveThreshold = tierPct × window).
5. When the trigger fires, you should see:
   - A `compact_start` event in `events.log`.
   - Context visibly drops (token count decreases).
   - A checkpoint persisted (`chkpt_xxx` appears in status and store).
   - A `compact_end` event in `events.log` with `fromTokens` / `toTokens`.
6. Verify the checkpoint persisted in the SQLite store:
   ```bash
   sqlite3 <repo>/.pi/mega-compact/sqlite.db \
     "SELECT checkpoint_id, session_id, timestamp, dedup_status FROM context_chunks ORDER BY timestamp DESC LIMIT 5;"
   ```

**Pass criteria:**
- Auto-trigger fires at the configured threshold.
- Context drops after compaction.
- Checkpoint appears in the store.
- `events.log` has `compact_start` and `compact_end` entries.
- Widget shows updated checkpoint count and tokens saved.

### 1b. Auto-Compaction during a Team Run (sub-agents)

**Goal:** Verify context is relieved **during** a long team/sub-agent run, not
only at the very end. Regression: previously the durable trim fired only when
the parent agent settled, so a team run ballooned to ~150k and "compacted but
didn't resume."

**Steps:**

1. Start a team run (multiple sub-agents, or a long `/mega-*` sequence that
   spawns agents). Set `MEGACOMPACT_TIER=low` so the gate fires early.
2. Watch the live stats widget token count while sub-agents settle one by one.
3. After each sub-agent's `agent_end`, confirm context drops to a relieved level
   (the mid-run durable trim fires at `agent_end` when idle + over threshold).
4. Confirm the model is fed a compacted view per call (live trim) — the widget
   token count should not sit pinned at the ceiling throughout the run.
5. At the end of the run, context should be at a comfortable level and the next
   turn should resume cleanly (no 150k reload).

**Pass criteria:**
- Context drops between sub-agents (not only at parent settle).
- `events.log` shows `agent-end-durable-trigger` + `native-compact` entries
  during the run (set `MEGACOMPACT_DEBUG=true` to see them).
- The run resumes/continues without a context-ceiling stall.

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
   tail -f <repo>/.pi/mega-compact/events.log | jq .
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
   grep recall_inject <repo>/.pi/mega-compact/events.log | jq .
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
     <repo>/.pi/mega-compact/events.log | jq .
   ```
   - `deduped` — region was collapsed (duplicate detected).
   - `new` — region was stored as a new checkpoint.
   - `mark_only` — tier recorded its decision but did not collapse (safe
     degrade mode).
4. Verify the SQLite store has rows with `dedup_status` set:
   ```bash
   sqlite3 <repo>/.pi/mega-compact/sqlite.db \
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
   This starts a local HTTP server on a port in the 9320–9329 range
   (configurable via `MEGACOMPACT_DASHBOARD_PORT`) and writes the URL to the
   terminal.
2. Open the URL in a browser. You should see:
   - **Status bar** — live pressure band (auto-climbing tier), trigger state, context utilization.
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

**Reading the pressure band (don't misread it as a leak):**

- The band is `pressure = currentTokens / effectiveThreshold` — a **ratio** over
  the live fire point `effectiveThreshold = tierPct × contextWindow` (a **% of
  the model context window**). When the window is known, pressure uses a
  **single percentage basis** (`lastCtxPercent / (tierPct*100)`), so the band no
  longer flickers between a token-ratio and a percent basis on alternating
  context events (the old 30%↔70s% oscillation is gone — see
  `docs/specs/s27-tiered-percent-threshold.md`).
- An **instant** drop (e.g. 70s → ~30% in under a second,
  no 30s+ compaction pause) is **not** compaction and **not** a context shrink.
  It is the ratio being recomputed against a moving `effectiveThreshold` basis
  (e.g. the window changed, or the `custom` tier / pre-first-context-event
  fallback re-read).
- **Genuine compaction takes 30s+** (disk rewrite + session reload). If the band
  drops that fast with no pause, it's the denominator changing, not the context
  actually shrinking. Treat sub-second drops as measurement artifacts.
- **Wild jumps** now only occur on the **fallback path** (a `custom` tier or
  before the first context event provides a window, where the fire point falls back
  to the boot token value). Report these with the **exact band values + the time
  between them**; they are useful signal but not leaks or data loss on their own.
- If you want to confirm whether a drop was real compaction vs. a recompute,
  check the **compaction graph / SSE event stream** — real compaction emits a
  compaction event; a recompute does not.

---

### 6. DR Drill

**Goal:** Verify the disaster-recovery drill validates SQLite integrity and can
rebuild from legacy JSON snapshots.

**Steps:**

1. Run the DR drill script:
   ```bash
   scripts/dedup-restore-drill.sh <repo>/.pi/mega-compact
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
   cp <repo>/.pi/mega-compact/sqlite.db \
      <repo>/.pi/mega-compact/sqlite.db.bak
   echo "corrupt" > <repo>/.pi/mega-compact/sqlite.db
   scripts/dedup-restore-drill.sh <repo>/.pi/mega-compact
   # Should detect corruption and rebuild from JSON snapshots
   cp <repo>/.pi/mega-compact/sqlite.db.bak \
      <repo>/.pi/mega-compact/sqlite.db
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

### 8. Version display

**Goal:** Verify the installed npm version is visible and tracks updates.

**Steps:**

1. After `pi update --extensions`, read the toolbar widget above the editor —
   the first line now shows `⚡ <live-band>·<preset> vX.Y.Z …` (e.g.
   `⚡ low·low v0.6.0 …`); the live band climbs with context pressure.
2. Run `/mega-status` — the header prints the installed version.
3. Open `/mega-dashboard` — the header pill shows `vX.Y.Z`.
4. Bump `version` in `package.json`, `npm publish`, re-run `pi update
   --extensions`, and confirm all three surfaces show the new number on next
   repaint/restart (no code change required per release).

**Pass criteria:**
- Toolbar, `/mega-status`, and dashboard all report the same version.
- The version updates after a publish+update without any source edit (it is read
  from `package.json` at runtime).
- `npm view pi-mega-compact version` matches what's displayed.

---

### 9. Cross-repo recall

**Goal:** Verify recall augments from other repos' checkpoints.

**Steps:**

1. Work and compact in **repo A** (produces `chkpt_xxx` rows tagged with
   `repoId`).
2. Switch to **repo B** (thin/empty store) and resume a pi session, or run
   `/mega-recall --cross-repo <topic>`.
3. On resume, recall should augment from repo A's checkpoints when repo B's store
   is thin. Cross-repo hits use a stricter cosine floor
   (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are labeled with their
   source repo.
4. Confirm a machine-wide injected-set (`~/.mega-compact-index/index.sqlite`)
   prevents re-injecting the same foreign checkpoint.
5. Disable with `MEGACOMPACT_CROSSREPO_ENABLED=false` and confirm recall stays
   single-repo.

**Pass criteria:**
- Cross-repo hits appear on resume / `--cross-repo` and are repo-labeled.
- No duplicate foreign injection across resumes.
- Kill-switch confines recall to the current repo.

---

### 10. Durable memory (auto-review → RAG)

**Goal:** Verify the conversation auto-reviews into durable memories that are
recalled as RAG context.

**Steps:**

1. Work a session for `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` (default 10) turns.
   Auto-review should write `decision` / `fact` / `preference` memories to
   SQLite (hallucination-guarded).
2. Inspect memories:
   ```
   /mega-memory list
   /mega-memory search <topic>
   ```
3. On a later resume/branch, relevant memories should be auto-inlined as RAG
   context (capped + deduped). Confirm via `/mega-status` or the dashboard.
4. Manual write + consolidate:
   ```
   /mega-memory save decision "We chose node:sqlite over better-sqlite3"
   /mega-memory consolidate      # merges near-duplicate rows
   /mega-memory forget <text>    # removes a memory
   ```
   (`/m` is the shortform for all of the above.)

**S24 — pressure-tied cadence + storage hardening:**

5. **Cadence scales with pressure.** Compare review frequency at calm vs hot
   context: under high pressure the effective review interval shrinks (see
   `memoryReviewCadence`), and a successful compaction also triggers an immediate
   review when pressure is `high`+ (`review-on-compact`). To observe: run a long
   session and watch `/mega-memory list` grow more often as context fills.
6. **Overflow cannot recur (the `4868/5000` client-cap fix).** Memories are
   written to SQLite **only** (never pi's file-backed buffer). Each entry is
   truncated at `MEGACOMPACT_MEMORY_MAX_CHARS` (default 4000 chars, with a
   `…[truncated]` marker) and the per-repo store is bounded at
   `MEGACOMPACT_MEMORY_MAX_ROWS` (default 500) via LRU eviction of the
   least-recently-referenced rows. Verify:
   ```
   # force small caps, write a huge memory, confirm it is truncated on read-back
   MEGACOMPACT_MEMORY_MAX_CHARS=50 /mega-memory save note "<500-char string>"
   /mega-memory search "<first 40 chars>"   # returned row ends with …[truncated]
   # push past the row cap; oldest un-referenced rows should evict, referenced survive
   ```
   No write should ever fail on size, and the store must stay bounded.

**Pass criteria:**
- Auto-review produces durable memories after the interval.
- Relevant memories are recalled on resume without manual action.
- `save` / `consolidate` / `forget` mutate the store as described.
- Review cadence tightens under pressure and fires on high-pressure compaction.
- Memory writes are SQLite-only, size-capped, and the store is LRU-bounded.

---

### 11. Cross-repo drift detection

**Goal:** Verify the dashboard's drift report flags stale / lagging / churning
repos.

**Steps:**

1. Start the dashboard (`/mega-dashboard`) and open the **All-repos** view.
2. Query the drift API directly:
   ```bash
   curl -s http://127.0.0.1:<port>/api/drift | jq .
   ```
3. The report flags: repos idle >30d, an active repo >24h behind the
   most-recently-active repo's last compaction, and model churn within 7d. It is
   read-only — it never writes the index.

**Pass criteria:**
- `/api/drift` returns a structured report over `repo_registry`.
- Stale / lagging / churning repos are surfaced.
- The report performs no writes.

---

## What to Include in a Bug Report

When filing a bug at
[https://github.com/TheArchitectit/pi-mega-compact/issues](https://github.com/TheArchitectit/pi-mega-compact/issues),
include:

1. **`/mega-status` output** — config + current context usage + store
   stats (checkpoint count, dedup rate, tokens saved) + the **installed
   version** (`vX.Y.Z`). Always include this so we know which build you're on.
2. **`/mega-dashboard-status` output** — dashboard server status (if running).
3. **pi version** — `pi --version` or the release tag you're running.
4. **OS** — e.g., `Linux 6.12.94-1-MANJARO x86_64`, `macOS 15.3`, etc.
5. **Node version** — `node -v` (must be >= 18).
6. **`events.log` slice** — the relevant lines around the problem:
   ```bash
   tail -100 <repo>/.pi/mega-compact/events.log | jq .
   ```
   Each line is `{ts, tier, result, latencyMs, falsePositive?}`. Include the
   lines around the timestamp of the issue.
7. **`dashboard.json`** — aggregate metrics from the state dir:
   ```bash
   cat <repo>/.pi/mega-compact/dashboard.json | jq .
   ```
   This contains hit rate, FP rate, per-tier p95, and storage bytes.
8. **If you suspect data loss or duplication:**
   - `sqlite.db` file size + checkpoint count:
     ```bash
     ls -lh <repo>/.pi/mega-compact/sqlite.db
     sqlite3 <repo>/.pi/mega-compact/sqlite.db \
       "SELECT COUNT(*) FROM context_chunks;"
     ```
   - DR drill output: `scripts/dedup-restore-drill.sh <repo>/.pi/mega-compact`
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

- **Requires Node >= 22.13.** The synchronous store uses the `node:sqlite`
  built-in; older Node lacks it. There is no native build fallback.

- **No remote monitoring.** All monitoring is local files (`events.log`,
  `dashboard.json`). No telemetry, no remote alertmanager (PREVENT-PI-004).

- **Pressure band wild jumps / instant drop-backs (largely resolved).** The old
  root cause — a static `thresholdTokens` frozen at boot (`loadConfig()`) plus a
  dual-basis switch (token-ratio vs percent) — is addressed by the tiered-%
  threshold: `effectiveThreshold = tierPct × contextWindow` is computed per-window
  at runtime (no longer fixed at boot), and the `pressure` getter uses one
  percentage basis when the window is known, so the 30%↔70s% flicker is gone.
  See `docs/specs/s27-tiered-percent-threshold.md` and the Dashboard
  "Reading the pressure band" note above. **Residual:** a brief recompute can
  still show on the fallback path (`custom` tier or before the first context event
  reports a window, where the fire point falls back to the boot token value). A
  genuine compaction still takes 30s+ and emits a compaction event; an instant
  drop is a recomputed denominator, not a leak.

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
