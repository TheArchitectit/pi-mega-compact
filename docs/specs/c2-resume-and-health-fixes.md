# C2 fixes — full spec (Sprints R + H + C2-cont)

> Execution-ready. Supersedes the three draft specs
> (`c2-findings-sprint-plan.md`, `c2-finding-resume-duplicate-turn.md`,
> `c2-finding-health-observability-gap.md`) — those are kept as the original
> investigation record; this is the implementation contract.
>
> Branch: `fix/c2-findings` (off `master` @ v0.21.3).
> Origin: the bridge C2 end-to-end investigation — see
> [`docs/blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md`](../blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md).

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

### 1.3 Dependents audit (MUST complete before implementing)

Anything that reads `turns.turn_index` and assumes it equals pi's
`event.turnIndex`. Verify each; update if it assumed the session counter:

- [ ] `forkFromConversation` (`src/fork.ts:56`) — uses `getTurnByIndex(convId,
      turnIndex)`; **already conversation-relative** → OK (this is the insight
      that makes Option B safe). Confirm `fork`'s `turnIndex` arg is documented
      as conversation-monotonic.
- [ ] `stampTurnsEpoch` (`extensions/mega-turn-store.ts:155`) — uses a
      turn-index range; confirm it tolerates monotonic indices (it should —
      it's selecting a contiguous slice of the conversation).
- [ ] `turn_recall` / HyDE telemetry writes (`turns_meta`, `turn_recall`) —
      confirm they key off `turn_id`/`turn_index` consistently and don't assume
      session-counter alignment.
- [ ] Dashboard "Turns" tab — displays `turn_index`; verify the monotonic index
      reads sensibly (it will — just a number). **Decide:** show the
      conversation-monotonic index (continuous across resumes — *more* correct)
      or display `event.turnIndex` (no visible change). Recommendation: show
      the monotonic index; it's the conversation's true turn history.
- [ ] Bridge child path `recordTurn` (`src/bridge/factory.ts:207`) — passes
      `input.turnIndex` straight through. A re-dispatched child with the same
      stable `ITHACUS_MEGA_SESSION_ID` hits the same resume bug. Apply Option B
      here too (compute `max + 1` for the child's conversation). Fallback:
      catch `DuplicateTurnError` → retry at `max + 1` (uglier; prefer direct
      Option B for consistency).
- [ ] Any test that asserts a specific `turn_index` after a resume/resend —
      update expectations to the monotonic index.

### 1.4 Files

- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  compute `nextTurnIndex = maxExisting + 1` for `convId`; pass to
  `recordTurnWrite` (instead of `event.turnIndex`). Keep `event.turnIndex` in
  the dashboard event payload.
- New helper `nextTurnIndexFor(convId, store)` in
  `src/store/turns/sqlite-store/` (read path) — keeps `recordTurnRow` under
  the soft limit. `SELECT MAX(turn_index) FROM turns WHERE conversation_id = ?`,
  return `coalesce(max, -1) + 1`.
- `src/bridge/factory.ts` `recordTurn` — apply the same monotonic computation
  for the child path (use the bridge's own `getTurnStore()`).
- Test files (below).

### 1.5 Test plan

- **Unit (helper):** `nextTurnIndexFor` — empty conversation → 0; turns 0..N →
  N+1; gap in indices (0,1,5) → 6 (MAX+1, not count).
- **Unit (recordTurnRow):** mock store — first session writes 0,1,2; simulate
  resume (same convId, `event.turnIndex` resets to 0) → writes continue 3,4,5;
  **no `DuplicateTurnError`**; dashboard payload still carries `event.turnIndex`.
- **Integration (resume):** real `turns.db` with a pre-existing conversation
  (turns 0..10); fire `turn_end` with `event.turnIndex=0`; assert the new turn
  lands at index 11 and `events.log` shows no `turn_write_failed`.
- **Regression:** existing turn-write + fork tests still pass (turn_index
  meaning unchanged for non-resumed sessions). Fork-from-turn tests: confirm
  they address the conversation's Nth turn.
- **Bridge child path:** `src/bridge/factory.test.ts` — `recordTurn` on a
  conversation that already has turns, with a colliding `turnIndex`, asserts it
  lands at the next free index (not a throw). Add a resume case (same
  conversation, restarted `turnIndex`) → continues at high-water mark.

### 1.6 Sprint R steps

1. **Dependents audit** (§1.3) — document each checkbox; flag any that need a
   coordinated change. If a dependent assumed the session counter, fix it in
   the same sprint.
2. **Implement** helper + `recordTurnRow` + bridge child path.
3. **Tests** (§1.5). Gate: `npm run build` + `node --test dist/**/*.test.js` +
   `npm run lint` + `python3 scripts/regression_check.py --all` +
   `node scripts/guardrails-scan.mjs`.
4. **Review** (controller) — grep for `MUTATION`/disabled guards; verify file
   limits (`src/` 300/500, `extensions/` 400/500); verify flag-OFF byte-identity
   (this change is unconditional, but confirm no flag path regresses).
5. **Deploy** via `./scripts/deploy.sh <next-patch>` (mega-compact requires an
   **explicit version arg** — NOT no-arg).
6. **Device verify:** `pi update --extensions`; resume a session in RADOPENCODE;
   confirm `events.log` shows no new `turn_write_failed` and resumed turns land
   at the high-water mark in `turns.db`. (Cross-check with Sprint H's
   internal-error signal going quiet.)

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

### 2.2 Fix — Option B: internal-errors ring + sub-score (+ relabel)

Add a ring buffer of recent internal-error events in `MegaRuntime`, compute a
`storeErrorRate` sub-score, and surface it in the dashboard Health tab. This
covers ALL internal errors (`*_failed` events), not just ones categorized by
hand. Plus relabel the `drift` chip as `compaction lag`.

**Rejected alternative — broaden `lastErrorCategory`:** set it in the
`turn_write_failed` catch. Minimal, but couples the turn-write path to the
health ring and only covers errors we remember to categorize. Rejected in
favor of the ring that covers everything.

### 2.3 Files

- `extensions/mega-runtime/runtime.ts` — add `recentInternalErrors: string[]`
  ring (mirrors `recentErrorCategories`), capped at the same `RING_MAX`.
- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  push to the ring on `turn_write_failed` (category `"store_write"`).
- Audit sibling `*_failed` emits (`recall_failed`, `fork_failed`, etc.) — push
  to the ring where they exist.
- `extensions/mega-events/health-handler.ts` — read the ring; compute
  `storeErrorRate = 1 - (recent_internal / RING_MAX)`; feed composite.
- `src/contextHealth.ts` + `src/store/sqlite/context-health.ts` — extend the
  `context_health` row + `computeHealthScore` weights (re-balance + document
  the new axis; or fold `storeErrorRate` into `errorRate` as a second input —
  decide during impl, document the choice).
- `extensions/dashboard-client/src/tabs/HealthTab.tsx` — surface the new
  signal; turn `errorRate` amber/red when internal errors accumulate.
- `extensions/mega-runtime/widget.ts:132` + HealthTab — relabel `drift` →
  `compaction lag` (keep `ok|warn` semantics; clarify in tooltip/detail).

### 2.4 Test plan

- **Unit:** `computeHealthScore` with the new axis; ring buffer behavior
  (cap, shift); `storeErrorRate` math.
- **Integration:** simulate a `turn_write_failed` storm; assert the dashboard
  health view reflects it (NOT `1.0`); assert the `drift` chip reads
  `compaction lag`.
- **Regression:** existing health tests + dashboard snapshot tests; re-balance
  of `computeHealthScore` weights doesn't break existing sample fixtures
  (update fixtures with the new axis value).
- **Dashboard build:** `npm run build:dashboard` (the HealthTab change needs
  the React bundle rebuilt; `deploy.sh` enforces `extensions/dashboard-client/dist/index.html`
  present + listed by `npm pack --dry-run`).

### 2.5 Sprint H steps

1. Implement §2.3 (ring + sub-score + dashboard surface + relabel).
2. Tests (§2.4). Gate: build + `node --test dist/**/*.test.js` + lint +
   regression_check + guardrails-scan + `npm run build:dashboard`.
3. Review (controller) — verify no health gate silently disabled; file limits.
4. Deploy via `./scripts/deploy.sh <next-patch>` (explicit arg).
5. Device verify: `pi update --extensions`; trigger a store-write failure (or
   reproduce Finding 2 pre-R-fix); confirm the Health tab shows the
   internal-error signal (not flat 1.0) and the `drift` chip reads
   `compaction lag`.

### 2.6 Ordering note

Sprint H is most valuable **after** Sprint R lands: once R stops the duplicate
errors, H's internal-error signal should go quiet — a clean end-to-end
verification that R worked. But H is independently shippable and lower risk
(telemetry/display only); land it first if R's audit runs long.

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

## 5. Open risks

1. **Dependents that assumed the session counter** (§1.3) — the audit is the
   gate. The fork path is confirmed safe; the others must be checked before
   deploy. If any assumed `turn_index == event.turnIndex`, fix it in-sprint.
2. **`computeHealthScore` re-balance** (§2.3) — re-weighting the composite
   shifts historical health rows' meaning. Decide fold-into-errorRate vs
   new-axis during impl; update fixtures; document.
3. **Dashboard display change** (§1.3 + §2.3) — the Turns tab showing the
   monotonic index and the `drift`→`compaction lag` relabel are visible
   changes; confirm with the user if the display choice matters (default:
   show monotonic; relabel).
