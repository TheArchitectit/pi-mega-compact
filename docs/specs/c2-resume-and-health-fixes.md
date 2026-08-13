# C2 fixes — full spec (Sprints R + H + C2-cont)

> Execution-ready. Supersedes the three draft specs
> (`c2-findings-sprint-plan.md`, `c2-finding-resume-duplicate-turn.md`,
> `c2-finding-health-observability-gap.md`) — those are kept as the original
> investigation record; this is the implementation contract.
>
> Branch: `fix/c2-findings` (off `master` @ v0.21.3).
> Origin: the bridge C2 end-to-end investigation — see
> [`docs/blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md`](../blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md).
>
> **Rev 2026-08-13 (v2 — decisions locked, binding):** Sprint R's `turn_index`
> dependents audit is COMPLETE (results in §1.3) and the scope is locked to
> COMPLETE (no corners): Option B **plus** the `sessionTurnIndex` carry so the
> raw_transcript join never silently zeroes. Sprint H is locked to **B2** (a
> 6th health axis `storeErrorRate` with its own gauge) — no fold-into-errorRate
> — with weights `0.09/0.09` and the trend-line step-change noted. Everything
> in this document reflects the locked decisions; "decide during impl" phrasing
> has been removed.

## 0. Background (one paragraph)

The first real end-to-end test of the bidirectional mega-compact ↔ ithacus
bridge surfaced 557 `turn_write_failed` events. The bridge was exonerated
(wrote to a separate `"global"` conversation; its own duplicates were silently
swallowed by ithacus's try/catch — ithacus v0.6.17 dropped the redundant
parent echo as hygiene). The 557 are a **mega-compact session-resume bug**,
and the investigation also found that those errors were **invisible to the
health dashboard** (`errorRate` stayed 1.0). This spec fixes both, and
continues the bridge C2 validation.

---

## 1. Sprint R — resume duplicate-turn fix (Finding 2)

### 1.1 Problem (verified)

557 `turn_write_failed` events in `RADOPENCODE/.pi/mega-compact/events.log`,
all `DuplicateTurnError: conversation "conv_…" already has turnIndex N`.

**Verified root cause** (three confirmed facts):

1. **The collision key.** `appendTurn` (`src/store/turns/sqlite-store/write.ts`)
   runs `INSERT INTO turns (conversation_id, session_id, turn_index, …)` with a
   `UNIQUE(conversation_id, turn_index)` constraint. The catch at `write.ts:61-64`
   matches `"UNIQUE constraint"` and throws `DuplicateTurnError(conversationId, turnIndex)`.
2. **The conversation persists across resume.** `ensureConversationId(sessionId)`
   (`src/store/turns/sqlite-store/write.ts:108`) maps `sessionId → conversationId`
   via the **persistent** `session_conversations` table. pi reuses the same
   `sessionId` on resume → mega returns the **same `conversationId`** → the
   pre-resume turns survive.
3. **turnIndex restarts.** `recordTurnRow`
   (`extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts:35`)
   stores `turnIndex: event.turnIndex` — pi's **per-session** counter, which
   **restarts at 0** on resume. So turn 0 already exists in the resumed
   conversation → collision.

**Impact:** not just log noise — the resumed session's **new** turns all fail
to record, so they're lost from the turn store. `fork` (which reads the turn
store) silently loses post-resume work.

**Evidence table** (from `RADOPENCODE/.pi/mega-compact/turns.db` + `events.log`):

| conversation | turns in table | failures | written | failures occurred |
|---|---|---|---|---|
| `conv_34c99041ba1d7e6e` | 68 | **502** | 08-02 18:43→08-03 12:54 (~18h) | throughout (~7 resumes) |
| `conv_6a2df43939dd1e1c` | 43 | 45 | 08-03 17:43→18:11 | 08-03 17:51→18:23 |
| `conv_a616e8f373fa07cd` | 11 | 10 | 08-13 02:58→03:00 | 08-13 04:34→04:43 (resume ~2h later) |

In-table duplicate `(conversation_id, turn_index)` pairs: **0** — each turn
appears once; errors are failed *second* writes.

### 1.2 Fix — Option B: monotonic conversation turnIndex

In `recordTurnRow`, store `turnIndex = (max existing turn_index for the
conversation) + 1` instead of `event.turnIndex`. Keep `event.turnIndex` in the
`turn_written`/`turn_write_failed` dashboard payload (display).

**Why this is safe — the load-bearing insight (verified):**
`forkFromConversation` (`src/fork.ts:56`) resolves a turn via
`store.getTurnByIndex(parentConversationId, turnIndex)` — it treats `turnIndex`
as **conversation-relative** ("the Nth turn in this conversation"), NOT as
pi's session-local counter. Today the two meanings coincide only for a
non-resumed session; on resume they diverge. Option B makes the stored value
match what fork already expects. It does **not** change fork's contract; it
makes the data satisfy it.

**Non-resumed case (backward compatible):** fresh conversation, max = none →
first turn stored at 0, then 1, 2, 3… **Identical to today.** Every existing
test asserting "turn 0, 1, 2" against a fresh conversation passes unchanged.

**Resumed case (the fix):** `conv_…` has turns 0–10. Resume fires
`event.turnIndex=0` → max existing = 10 → store at **11**. Next (event 1) →
**12**. Then 13, 14… No collision; resumed turns land.

**No new race:** `turns.db` is the synchronous `node:sqlite` store — a
`SELECT MAX(turn_index)` + `INSERT` in the same sync call cannot be interleaved
by another writer. Post ithacus-v0.6.17 there is a **single writer per path**:
mega's native handler owns the parent (ithacus no longer echoes); the bridge's
`recordTurn` owns the child. So `max + 1` is computed by one writer against a
sync store.

**Rejected alternatives:**
- *Skip-existing / catch `DuplicateTurnError`:* on resume, pi re-fires
  turnIndex 0,1,2… for **new** turns; skipping them loses the resumed session's
  work (silent data loss). Rejected.
- *Session-segment scoping (add a resume-segment column to the unique key):*
  more schema churn; the monotonic index is simpler and gives fork the
  continuous conversation sequence it wants. Rejected.

### 1.3 Dependents audit — COMPLETE (2026-08-13). Verdict: Option B requires coordinated changes.

Every consumer of `turns.turn_index` across src/, extensions/, tests/, and the
dashboard was traced and classified. Results:

**SAFE — conversation-relative already (no change):**
- `src/fork.ts:56` `forkFromConversation` → `getTurnByIndex(convId, turnIndex)`
  (verified — this is the load-bearing insight that makes Option B safe).
- `src/store/turns/sqlite-store/read.ts:67-79,94-107` `getTurnByIndex` /
  `listRecallByIndex` (`WHERE conversation_id = ? AND turn_index = ?`).
- `src/bridge/factory.ts:166-184` bridge `fork()` (delegates to
  `forkFromConversation` with the conversation-relative resolver).
- `extensions/mega-turn-store.ts` `stampTurnsEpoch` — clears `epoch_id` by
  **session** (`WHERE session_id = ? AND epoch_id IS NULL`), no turn-index
  range at all. (The draft spec's "turn-index range" concern was unfounded.)
- Dashboard "Turns" tab (`routes-turns.ts` + `TurnMemoryView.tsx`) — server
  re-looks-up recall via `listRecallByIndex(convId, e.turnIndex)`; client
  displays/round-trips the number for fork. (Display shows the monotonic index
  going forward — see §1.2 note.)
- `src/store/turns/migrations.ts:108-159` — 1:1 copy of legacy → contract
  (idempotent; historical rows keep their per-session values).
- `src/store/turns/sqlite-store/write.ts:148-211` `forkConversation` — seeds
  the child at `turn_index = 0` (intentional; child's own conversation).
- Legacy `src/store/sqlite/turns.ts` path — only active when `turnsDbEnabled`
  is OFF (retired path; not the Option-B target).

**SAFE-by-coincidence (doesn't assume session counter):** `hydeStore.ts`
`listTelemetryTurns`/`aggregateDailyTelemetry`, `routes-rag-metrics.ts`,
`context_health.ts` (own standalone table), `dbMirrorAppend.ts` (own
`conversation_thread`/`tool_results` tables).

**THREE REQUIRED CHANGES (NEEDS UPDATE):**
1. `recordTurnRow.ts` — the Option-B write itself (the fix).
2. `src/bridge/factory.ts:207` `recordTurn` — apply identical `max + 1` for the
   child path (re-dispatched children hit the same collision).
3. `src/metrics/turns.ts:116` — `rawAggBySessionTurn.get(\`${t.sessionId}::${t.turnIndex}\`)`
   joins turns.db `turn_index` to `raw_transcript.turn_index` (seeded at
   `dbMirrorAppend.ts:60` from `runtime.currentTurn`, the per-session counter).
   After Option B, turns.db `turn_index` goes conversation-monotonic while
   raw_transcript stays session-scoped → resumed turns silently return
   `rawMessageCount = 0`. **Fix (chosen below in §1.2b):** carry pi's session
   counter on the turn row as `sessionTurnIndex` alongside the monotonic
   `turn_index`, and re-key this join on it. (Rejects the "accept the zero"
   minimal scope — no corners.)

**TWO TEST GAPS (UNCLEAR → add coverage):**
- `src/metrics/turns.test.ts:39-107` seeds turns + raw_transcript with
  identical `turn_index`; masks the resume join bug. Add a resume-divergence
  assertion (turns monotonic, raw_transcript session-scoped, join still joins).
- `src/store/turns/sqlite-store.test.ts` + `memory-store.test.ts` — append with
  explicit `turnIndex`; add a resume scenario (same convId, restarted
  `event.turnIndex`) asserting the monotonic continuation.

### 1.3b Scope decision (locked 2026-08-13): COMPLETE — `sessionTurnIndex` carry

Add `sessionTurnIndex` (pi's per-session counter) to the contract `TurnEntry`
alongside the conversation-monotonic `turn_index`. Both are stored on every
turn row. `recordTurnRow` writes `turn_index = max + 1` and
`sessionTurnIndex = event.turnIndex`. Fork/recall/Turns-tab keep keying on
`turn_index` (conversation-monotonic) — unchanged. `src/metrics/turns.ts:116`
re-keys its raw_transcript join on `sessionTurnIndex` (which is what
raw_transcript stores) — so the join survives resume instead of zeroing.
This is bigger than "accept the silent zero" but leaves no deferred telemetry
debt (the no-corners directive). It touches: `TurnEntry`, the turns schema +
`appendTurn` insert, `recordTurnRow`, the bridge `recordTurn`, and the
metrics join. All five are named coordination points, not surprises.

**Known residual (documented, not deferred silently):** raw_transcript stays
session-scoped, and on a resumed session two segments share `(session_id,
session_turn_index)` — so `rawMessageCount` for a resumed-segment turn can
*blend* the pre- and post-resume raw rows (over-count) instead of reading 0.
Never a false zero again; an over-count on resumed segments only. Fully
eliminating it would require dbMirrorAppend to also write the monotonic index
(deeper coordination across the context-handler — out of Sprint R scope, noted
for a follow-up). State this in the release note.

### 1.4 Files (complete scope — Option B + sessionTurnIndex carry)

- `src/store/turns/types.ts` — add `sessionTurnIndex?: number` to the contract
  `TurnEntry` (contract-first). Schema: `ALTER TABLE turns ADD COLUMN
  session_turn_index INTEGER` (migration; nullable, backfilled where possible).
- New helper `nextTurnIndexFor(convId, store)` in
  `src/store/turns/sqlite-store/` (read path) — keeps `recordTurnRow` under
  the soft limit. `SELECT MAX(turn_index) FROM turns WHERE conversation_id = ?`,
  return `coalesce(max, -1) + 1`.
- `src/store/turns/sqlite-store/write.ts` `appendTurn` — honor
  `entry.sessionTurnIndex` (write both columns). `UNIQUE(conversation_id,
  turn_index)` stays (monotonic); optionally enforce
  `UNIQUE(conversation_id, session_id, session_turn_index)` to keep the
  session id non-colliding too.
- `extensions/mega-turn-store.ts` `recordTurnWrite` — pass
  `input.sessionTurnIndex` through; must NOT re-inject the session counter into
  the monotonic field.
- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  `turn_index = nextTurnIndexFor(convId)`; `sessionTurnIndex = event.turnIndex`;
  keep `event.turnIndex` in the dashboard event payload.
- `src/bridge/factory.ts` `recordTurn` (factory.ts:207) — same computation for
  the child path: `turn_index = max + 1` (child's own conversation), carry the
  child's `input.turnIndex` as `sessionTurnIndex`.
- `src/metrics/turns.ts:116` — re-key the raw_transcript join on
  `sessionTurnIndex` (`${t.sessionId}::${t.sessionTurnIndex}`), not the
  monotonic `turn_index`. Key remains conversation-scoped for recall (line 115).
- Test files (below).

### 1.5 Test plan (complete scope)

- **Unit (helper):** `nextTurnIndexFor` — empty conversation → 0; turns 0..N →
  N+1; gap in indices (0,1,5) → 6 (MAX+1, not count).
- **Unit (recordTurnRow):** mock store — first session writes 0,1,2; simulate
  resume (same convId, `event.turnIndex` resets to 0) → `turn_index` continues
  3,4,5 **AND `sessionTurnIndex` is 0,1,2** (both fields present); **no
  `DuplicateTurnError`**; dashboard payload still carries `event.turnIndex`.
- **Integration (resume):** real `turns.db` with a pre-existing conversation
  (turns 0..10); fire `turn_end` with `event.turnIndex=0`; assert
  `turn_index = 11`, `sessionTurnIndex = 0`, no `turn_write_failed` in
  events.log.
- **Metrics resume-divergence (the §1.3 gap):** `src/metrics/turns.test.ts` —
  seed a conversation with turns at monotonic {0,1,2,3} where later turns have
  `sessionTurnIndex` {0,1} (a resume) and raw_transcript rows keyed by session
  counter {0,1}; assert the join on `sessionTurnIndex` returns the raw rows
  (NOT 0) for the resumed-segment turns. Document the blend case (assert the
  pre/post blend is present, so a future elimination is a test change).
- **Regression:** existing turn-write + fork tests pass (fresh conversation:
  `turn_index` == `sessionTurnIndex` == 0,1,2…). Fork-from-turn: still
  conversation's Nth turn.
- **Bridge child path:** `src/bridge/factory.test.ts` — colliding `turnIndex`
  lands at next free index; resume case (same conversation, restarted
  `turnIndex`) → continues at high-water mark; `sessionTurnIndex` carried.
- **Store test additions (the §1.3 gap):** `sqlite-store.test.ts` /
  `memory-store.test.ts` — append with a resend of the same `(convId,
  event.turnIndex)` after a gap → monotonic continuation (no throw).

### 1.6 Sprint R steps

1. ~~**Dependents audit** (§1.3)~~ **DONE 2026-08-13** — results above; scope
   locked to COMPLETE.
2. **Implement** (contract-first): `sessionTurnIndex` in `TurnEntry` + schema
   migration → `nextTurnIndexFor` helper → `appendTurn` honors both columns →
   `recordTurnRow` (write both) → `recordTurnWrite` pass-through → bridge
   `recordTurn` (child) → `metrics/turns.ts` join re-key.
3. **Tests** (§1.5). Gate: `npm run build` + `node --test dist/**/*.test.js` +
   `npm run lint` + `python3 scripts/regression_check.py --all` +
   `node scripts/guardrails-scan.mjs` + schema-health.
4. **Review** (controller) — grep for `MUTATION`/disabled guards; verify file
   limits (`src/` 300/500, `extensions/` 400/500); verify flag-OFF byte-identity
   (schema migration must be flag-agnostic + idempotent); READ every changed
   file, check the join re-key carefuly.
5. **Deploy** via `./scripts/deploy.sh <next-patch>` (mega-compact requires an
   **explicit version arg** — NOT no-arg).
6. **Device verify:** `pi update --extensions`; restart the RADOPENCODE session
   (for ithacus 0.6.17 too); resume a session; confirm no new
   `turn_write_failed`, resumed turns land at high-water mark, and the Health
   view **already shows the metrics join returning non-zero rawMessageCount**
   for resumed turns. (Cross-check with Sprint H's internal-error signal going
   quiet.)

---

## 2. Sprint H — health observability + drift clarity (Findings 3 + 4)

### 2.1 Problem (verified)

**Finding 3:** `errorRate` read **1.0 (healthy)** the entire time 557
`turn_write_failed` events accumulated. The dashboard showed green while the
log showed red.

**Verified root cause:**
- `computeErrorEscalation(recentErrorCategories)` (`src/contextHealth/drift.ts:50`)
  returns `1 - (non-null / total)`.
- `recentErrorCategories` is a ring buffer fed by `runtime.lastErrorCategory`
  (`extensions/mega-events/health-handler.ts:198`).
- `lastErrorCategory` is set to `null` at the start of every turn
  (`turnEndHandler.ts:32`) and only set non-null in the **API-error retry path**
  (`turnEndHandler/errorRetry.ts:51`).
- `turn_write_failed` (`recordTurnRow.ts:54`) **does not touch
  `lastErrorCategory`**. Internal store-write errors never reach the
  error-rate signal. `errorRate` only reflects API retry errors.

**Finding 4:** the status-line `drift warn` chip looked related to the errors.
It isn't. `driftStatusImpl` (`extensions/mega-runtime/runtime-helpers.ts:98`)
→ `detectCrossRepoDrift()` (`src/driftDetection.ts`) flags a repo `warn` when
it is **active but not compacted** (`compaction_lag` signal). For RADOPENCODE
that was simply true (never compacted). `drift warn` (cross-repo compaction
lag) and `errorRate` (API retry errors) are **different axes** but the UI
presents "drift" as one thing, so they get conflated during triage.

### 2.2 Fix — B2 (LOCKED 2026-08-13): internal-errors ring + distinct `storeErrorRate` 6th axis (+ relabel)

**Locked choice: B2 — a separate 6th health axis.** Add a ring buffer of recent
internal-error events in `MegaRuntime`, compute a distinct `storeErrorRate`
sub-score, and surface it as its own gauge in the dashboard Health tab —
separate from the API-error `errorRate`. This covers ALL internal errors
(`*_failed` events) via the ring, not just ones categorized by hand, and keeps
API errors and store errors as two visible signals (the class distinction
Sprint-H is for). Plus relabel the `drift` chip as `compaction lag`.

**Weights:** re-balance `computeHealthScore` by splitting the current
`errorRate` budget (`0.18`) into `errorRate 0.09` (API retry errors) +
`storeErrorRate 0.09` (internal store errors) — the two are equally loud,
matching "a silent store-write failure is as much a health problem as a
retryable API error." All other weights unchanged (`outputQuality 0.22`,
`drift 0.22`, `cachePoison 0.20`, `cacheHealth 0.18`). Document the change.

**Step-change note (documented, not deferred):** historical `context_health`
rows keep their stored composite (point-in-time snapshots — no backfill), so
the trend line shows a boundary step where weights change. Mark on the chart /
in the release note so it isn't read as a real health change.

**Rejected:** B1 (fold `storeErrorRate` into the `errorRate` axis, no schema
change/no re-balance) — still shows one chip where two would be clearer, and
collapses the class distinction in the place a triaging user looks first.
**Rejected:** A (broaden `lastErrorCategory`) — collapses the classes AND only
covers errors remembered to categorize (the same blind spot that hid Finding 2).

### 2.3 Files (B2)

- `extensions/mega-runtime/runtime.ts` — add `recentInternalErrors: string[]`
  ring (mirrors `recentErrorCategories`), capped at the same `RING_MAX`.
- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  push to the ring on `turn_write_failed` (category `"store_write"`).
- Audit sibling `*_failed` emits (`recall_failed`, `fork_failed`, etc.) — push
  to the ring where they exist.
- `extensions/mega-events/health-handler.ts` — read the ring; compute
  `storeErrorRate = 1 - (recent_internal / RING_MAX)`; feed as the 6th axis.
- `src/contextHealth.ts` `ContextHealthSubScores` + `computeHealthScore` — add
  `storeErrorRate` at weight `0.09` + drop `errorRate` to `0.09` (weights sum
  to 1.0). Extend `ContextHealthRow` with `storeErrorScore`.
- `src/store/sqlite/context-health.ts` + schema (`plan-v2.ts`) —
  `ALTER TABLE context_health ADD COLUMN store_error_score REAL` + write it in
  `recordContextHealth`);
- `extensions/dashboard-client/src/tabs/HealthTab.tsx` — separate "Internal
  errors" gauge next to `errorRate` (amber/red when the ring accumulates);
  turn the composite declaration note.
- `extensions/mega-runtime/widget.ts:132` + HealthTab — relabel `drift` →
  `compaction lag` (keep `ok|warn` semantics; clarify in tooltip/detail).

### 2.4 Test plan (B2)

- **Unit:** `computeHealthScore` with the 6th axis — weights sum to 1.0
  (`0.22 + 0.22 + 0.20 + 0.18 + 0.09 + 0.09`); ring buffer behavior (cap,
  shift); `storeErrorRate` math (empty ring → 1.0; all-internal ring → 0).
- **Unit (axis independence):** `turn_write_failed` storm → `storeErrorRate`
  drops; API-retry storm → `errorRate` drops; mixed storm → composite reflects
  both. A store-error storm does NOT change `errorRate` (and vice versa).
- **Integration:** simulate a `turn_write_failed` storm; assert the Health tab
  shows the **separate** "internal errors" gauge (not just the composite);
  assert the `drift` chip reads `compaction lag`.
- **Regression:** existing health tests + dashboard snapshots — rebalanced
  weights updated in fixtures (new `store_error_score` field); the
  `context_health` migration is idempotent (run twice, no error); a
  pre-upgrade DB without `store_error_score` degrades to 1.0 (matches
  "no data → healthy", same as the empty ring).
- **Dashboard build:** `npm run build:dashboard` (HealthTab needs the React
  bundle rebuilt; `deploy.sh` enforces `extensions/dashboard-client/dist/index.html`
  present + listed by `npm pack --dry-run`).

### 2.5 Sprint H steps

1. Implement §2.3 (ring + `store_error_score` schema column + 6th axis +
   dashboard surface + relabel).
2. Tests (§2.4). Gate: build + `node --test dist/**/*.test.js` + lint +
   regression_check + guardrails-scan + schema-health + `npm run build:dashboard`.
3. Review (controller) — verify no health gate silently disabled; file limits
   (`src/` 300/500, `extensions/` 400/500); weights sum to 1.0; pre-upgrade DBs
   degrade to 1.0.
4. Deploy via `./scripts/deploy.sh <next-patch>` (explicit arg).
5. Device verify: `pi update --extensions`; restart RADOPENCODE; trigger a
   store-write failure (or reproduce Finding 2 pre-R-fix); confirm the Health
   tab shows the separate **internal errors** gauge (not flat 1.0 composite) and
   the `drift` chip reads `compaction lag`.

### 2.6 Ordering note (locked: R first)

Sprint H lands **after** Sprint R: once R stops the duplicate errors, H's
internal-error signal should go quiet (the ring drains; the new gauge reads
1.0) — a clean end-to-end verification that R worked. H is independently
shippable and lower risk (telemetry/display only), so it can land first only
if R is held up. Both are COMPLETE scope — neither is weakened.

---

## 3. Sprint C2-cont — bridge validation continues (cross-repo, partly manual)

The bridge passed co-load + liveness in C2. Continue validating the remaining
capabilities on a real device with `pi-mega-compact@R` + `ithacus@0.6.17`:

- [ ] **Parent recall injection** — start a pi session in a repo; on
      `before_agent_start`, ithacus calls `bridge.recallCheckpoints` +
      `recallMemories` and prepends a `[mega-compact] recalled memory:` block
      to the system prompt. Verify in the prompt + `<repo>/.pi/mega-compact/sqlite.db`.
- [ ] **Memory write** — confirm recall reads mega's `memories` (populated by
      mega's pipeline + child compaction), not ithacus's write-dead `ith_memories`.
- [ ] **Child dispatch** — spawn an ithacus child; verify spawn args include a
      second `-e` → `mega-compact-child.js` (check events.log / process args);
      child `before_agent_start` injects recall; `session_shutdown` persists a
      checkpoint.
- [ ] **Cross-dispatch recall** — a second dispatch of the same child (stable
      `ITHACUS_MEGA_SESSION_ID = ithacus-child-<agent>-<repoId>`) recalls the
      first dispatch's checkpoint. (Note: post-R-fix, the child's turns use the
      monotonic index, so re-dispatch no longer collides.)
- [ ] **Fork** — after a few `recordTurn`s, `bridge.fork` returns a child
      conversation (or graceful `NO_RECALL` if no recall seeded). Post-R-fix,
      fork reads the conversation-monotonic turns.
- [ ] **Flag-OFF byte-identity** — `ITHACUS_MEGA_BRIDGE=false` (+ `MEGACOMPACT_ITHACUS_BRIDGE=false`
      for the child path) → ithacus behaves exactly as pre-bridge (no second
      `-e`, no recall injection, no recordTurn).

Track in the ithacus repo; gated on the device having the latest mega-compact
(post-R) + ithacus 0.6.17 installed.

---

## 4. Verification summary

- **Sprint R:** unit (helper + recordTurnRow), integration (real turns.db
  resume), regression (turn-write + fork), bridge child path resume.
- **Sprint H:** unit (computeHealthScore + ring), integration (failure storm
  → dashboard), regression (health + dashboard snapshots), dashboard build.
- **Sprint C2-cont:** real pi session + child dispatch + fork + flag-OFF
  byte-identity.
- **Guardrails:** every change passes `npm run lint` +
  `python3 scripts/regression_check.py --all` + `node scripts/guardrails-scan.mjs`.
- **Deploy:** `./scripts/deploy.sh <version>` (explicit arg) — full gate +
  dashboard build + bundle-presence check.

## 5. Open risks (post-audit, decisions locked)

1. **The `sessionTurnIndex` carry spreads a column through the turn layer**
   (§1.4) — it touches `TurnEntry`, the schema + `appendTurn`, `recordTurnRow`,
   the bridge `recordTurn`, and the metrics join. Each is a named coordination
   point (audit §1.3 has the file:lines), but a missed one = a silent
   resume-join regression; the resume-divergence test (§1.5) is the backstop.
2. **The documented residual** (§1.3b) — the raw_transcript join blends
   pre/post-resume raw rows on a resumed segment (over-count, never a false
   zero). Full elimination needs dbMirrorAppend to carry the monotonic index;
   follow-up, stated in the release note.
3. **`computeHealthScore` re-balance** (§2.3, locked B2) — the trend line
   shows a boundary step at deploy; the chart/release note must flag it so it
   isn't read as a real health change. Pre-upgrade DBs degrade to 1.0 (no
   `store_error_score` column yet).
4. **Dashboard display changes** (§1.3, §2.3) — Turns tab shows the monotonic
   index (continuous across resumes); the `drift` chip relabels to
   `compaction lag`; the Health tab gains a separate "internal errors" gauge.
   All visible; ship as shown (the user's call stands).
