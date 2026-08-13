# C2 Finding 2 — session-resume re-records turns (`DuplicateTurnError`)

Sprint: **R** (resume fix). Branch: `fix/c2-findings`. Repo: pi-mega-compact.

## Problem

557 `turn_write_failed` events in `RADOPENCODE/.pi/mega-compact/events.log`,
all `DuplicateTurnError: conversation "conv_…" already has turnIndex N`. On a
live device this is heavy log noise and — worse — the resumed session's **new**
turns fail to record, so the turn layer (which `fork` reads) silently loses
post-resume work.

## Evidence (from RADOPENCODE turns.db + events.log)

| conversation | turns in table | failures | write span | resume pattern |
|---|---|---|---|---|
| `conv_34c99041ba1d7e6e` | 68 (`sess_…c31e39787e48`) | **502** | 08-02 18:43 → 08-03 12:54 (~18h) | ~7 resumes |
| `conv_6a2df43939dd1e1c` | 43 (`sess_…c8a4c5ec7b3d`) | 45 | 08-03 17:43 → 18:23 | ~1 resume |
| `conv_a616e8f373fa07cd` | 11 (`sess_…f90bc8ac72b1`) | 10 | written 02:58→03:00; failures 04:34–04:43 | resumed ~2h later, turnIndex stuck at 0 |

In-table duplicate `(conversation_id, turn_index)` pairs: **0** — each turn
appears once; the errors are failed *second* writes where the loser threw.

## Root cause

1. `ensureConversationId(sessionId)` (`src/store/turns/sqlite-store/write.ts:108`)
   maps `sessionId → conversationId` via the **persistent**
   `session_conversations` table. When pi resumes a session it reuses the same
   `sessionId`, so mega reuses the **same `conversationId`** (the pre-resume
   turns survive).
2. `recordTurnRow` (`extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts:35`)
   stores `turnIndex: event.turnIndex` — pi's **per-session** counter, which
   **restarts at 0** on resume.
3. `appendTurn` (`src/store/turns/sqlite-store/write.ts`) enforces a UNIQUE
   constraint on `(conversation_id, turn_index)`. On resume, turn 0 already
   exists → `DuplicateTurnError` → caught + logged as `turn_write_failed`.

The resumed session's new turns (which pi labels turnIndex 0,1,2… again) ALL
collide with the pre-resume turns and fail to record. That is fork-data loss,
not just log noise.

> NOTE: the ithacus bridge was initially suspected but exonerated — it wrote to
> a separate `"global"` conversation (its duplicates silently swallowed by
> ithacus's try/catch). 0 of 557 logged errors mention `"global"`. Fixed
> separately in ithacus v0.6.17 (hygiene); this spec is the real fix.

## Fix options

**Option A — skip-existing (pre-check / catch `DuplicateTurnError`).** Reject:
on resume pi re-fires turnIndex 0,1,2… for **new** turns; skipping them loses
the resumed session's work from the turn store. Makes the data loss silent.

**Option B — monotonic conversation turnIndex (RECOMMENDED).** In
`recordTurnRow`, store `turnIndex = (max existing turn_index for the
conversation) + 1` instead of `event.turnIndex`.
- Non-resumed sessions: max starts at -1, so indices go 0,1,2… — **identical to
  today** (backward-compatible).
- Resumed sessions: continue from the high-water mark (11, 12, …) — no
  collision, resumed turns ARE recorded.
- `turn_index` becomes the conversation's monotonic turn number, stable across
  resumes — which is exactly what `fork` wants.
- The dashboard `turn_written`/`turn_write_failed` events can still log
  `event.turnIndex` for display; the *stored* index is the conversation index.

**Option C — session-segment scoping.** Add a resume-segment counter to the
unique key. More schema churn; rejected in favor of B's simpler monotonic index.

**Recommendation: Option B.**

## Dependents to audit before implementing (anything reading `turns.turn_index`)

- `forkFromConversation` (`src/fork.ts`) — reads turn_index; confirm fork's
  `turnIndex` arg now means conversation-monotonic (it should — fork wants the
  conversation's Nth turn, not pi's per-session N).
- `stampTurnsEpoch` (`extensions/mega-turn-store.ts:155`) — uses a turn-index
  range; confirm it tolerates monotonic indices.
- turn_recall / HyDE telemetry writes (`turns_meta`, `turn_recall`) — confirm
  they key off `turn_id`/`turn_index` consistently.
- Dashboard Turns tab — displays `turn_index`; verify the monotonic index reads
  sensibly (it will — it's just a number).
- `recordTurn` in the **bridge** (`src/bridge/factory.ts:207`) — the child path
  passes `input.turnIndex` straight through. Confirm the child path also wants
  conversation-monotonic (it does — children have their own conversation).

## Files (Option B)

- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  compute `nextTurnIndex = maxExisting + 1` for `convId` and pass that to
  `recordTurnWrite` (instead of `event.turnIndex`). Keep `event.turnIndex` for
  the dashboard event payload (display).
- Possibly a helper `nextTurnIndexFor(convId)` in
  `src/store/turns/sqlite-store/` (read path) — keep `recordTurnRow` under the
  soft limit.
- `src/bridge/factory.ts` `recordTurn` — consider applying the same monotonic
  computation for the child path (so children are resume-safe too). At minimum,
  catch `DuplicateTurnError` → re-attempt with `maxExisting+1` so a resumed
  child doesn't lose turns.

## Test plan

- **Unit:** `recordTurnRow` with a mock store — first session writes 0,1,2;
  simulate resume (same convId, event.turnIndex resets to 0) → writes continue
  3,4,5 (NOT 0,1,2), no `DuplicateTurnError`.
- **Regression:** existing turn-write + fork tests still pass (turn_index
  meaning unchanged for non-resumed sessions).
- **Resume integration:** a real `turns.db` with a pre-existing conversation;
  fire `turn_end` with a restarted `event.turnIndex`; assert the new turn lands
  at `maxExisting+1` and `events.log` shows no `turn_write_failed`.
- **Bridge child path:** `src/bridge/factory.test.ts` — recordTurn on a
  conversation that already has turns, with a colliding `turnIndex`, asserts it
  lands at the next free index (not a throw).

## Sprint R steps

1. Audit dependents (above); document any that need a coordinated change.
2. Implement Option B in `recordTurnRow` + helper (+ bridge child path).
3. Tests (above). Gate: build + `node --test dist/**/*.test.js` + lint +
   regression_check + guardrails-scan.
4. Review (controller) — verify no `MUTATION`/rate-limiter disable, file limits.
5. Deploy via `./scripts/deploy.sh <next-patch>` (explicit version arg).
6. Device verify: `pi update --extensions`; resume a session in RADOPENCODE;
   confirm `events.log` shows no new `turn_write_failed` and the resumed turns
   land at the high-water mark in `turns.db`.
