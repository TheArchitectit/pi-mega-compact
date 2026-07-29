# S50 — Per-Turn Metrics + Fork Primitive

**Date:** 2026-07-28
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Depends on:** S49 (shipped — isolated `turns.db` + `TurnStore` + adapter)
**Priority:** P1
**Status:** shipped (S50A / S50B / S50C — dashboard tab is S52, out of scope here)
**Target version:** v0.9.1
**Reuse target:** `src/metrics/turns.ts` + `src/fork.ts` are host-agnostic (pi-agnostic, embeddable).

---

## REUSE CONTRACT

Same invariant as S49: all logic in `src/metrics/turns.ts` and `src/fork.ts` imports no
`ExtensionAPI` / `MegaRuntime` / `@earendil-works/*`. Metrics consume the `TurnStore` interface
(S49) plus plain `DatabaseSync` handles; fork consumes `TurnStore`. Hosts wire pi types at the
adapter edge only. Grep-asserted in tests.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): `raw_transcript.turn_index` and
  `turns.epoch_id` are provenance annotations. They never change which messages are dropped,
  compacted, or injected — they only *label* rows the pipeline already writes. Compaction behavior
  is byte-identical with these columns populated or null.
- **PREVENT-PI-003**: no injection-path change.
- **PREVENT-PI-004** (no network): pure `node:sqlite` (metrics/fork) + local transcript. `/mega-fork`
  rehydrates from local checkpoints only — zero network.
- **PREVENT-002** (parameterized SQL): all metric/epoch queries use bound parameters.
- **Feature flag default ON**: metrics + fork wiring default ON via the existing
  `turnsDbEnabled` (S49) gate and `dbMirror` (S27) gate where applicable. When `dbMirror` is OFF,
  no `raw_transcript` rows exist to annotate — the wiring is a no-op (documented).
- **Non-fatal**: metric/fork/epoch writes stay best-effort — failures log and never break the
  agent loop, compaction, or recall.
- Gate (every sub-sprint): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

S49 isolated the turn spine into `turns.db`, but three gaps keep per-turn memory from being
queryable or rewindable (program §2, S48 spec "What's NOT shipped" items 2/3/5):

1. **`raw_transcript.turn_index` is unpopulated.** The column exists (S43 `ensureColumn`,
   `src/store/sqlite/schema.ts:387`) but `appendRawTranscript` never sets it, because the writer
   (`context-handler.ts`) doesn't thread `runtime.currentTurn` through. Without it, "which raw
   messages belong to turn N" — the basis for per-turn dedup/compression-by-turn metrics — is
   unanswerable.

2. **`turns.epoch_id` is never stamped.** The FK exists but nothing links a turn to the epoch that
   compacted it. "Turns compacted together" (compression-by-conversation-epoch rollups) is
   unanswerable. The epoch row is written at compact-commit (`context-handler.ts:281
   writeCheckpointEpoch`) — the natural stamping point.

3. **No user-facing fork.** `forkConversation` is a store primitive (S49) but there's no command.
   A user can't say "branch a new conversation from conversation X at turn N" and have it
   rehydrate that turn's injected-checkpoint set.

---

## SCOPE

File-size discipline: every new module < 300 lines; single responsibility; thin barrel.

### IN SCOPE (new files)

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/metrics/turns.ts` | Per-turn + per-conversation rollups: cache-hit, dedup, compression by turn and by conversation. Pure read queries over `TurnStore` + the main-db `raw_transcript`/`checkpoint_epochs`. | ~180 |
| `src/metrics/index.ts` | Barrel. | ~10 |
| `src/fork.ts` | Host-agnostic fork: `forkFromConversation(store, parentConvId, turnIndex)` → resolves turn, calls `store.forkConversation`, returns child conv + recall set to rehydrate. | ~90 |
| `src/metrics/turns.test.ts` | Rollup correctness against seeded turns.db + main db. | ~180 |
| `src/fork.test.ts` | Fork resolves turn + returns replay set; unknown turn errors. | ~90 |
| `extensions/mega-turn-cmds.ts` | `/mega-fork <conv> <turn>` + `/mega-turns` (list) commands (pi-coupled edge). | ~150 |
| `extensions/mega-turn-cmds.test.ts` | Command handler tests via the extension harness. | ~120 |

### IN SCOPE (modified files)

- `src/store/sqlite/raw-transcript.ts` — `RawTranscriptRow` gains optional `turnIndex`;
  `appendRawTranscript` inserts `turn_index` when present.
- `extensions/mega-events/context-handler.ts` — `toRawTranscriptRow` threads `runtime.currentTurn`
  into `turn_index`; at compact-commit (`writeCheckpointEpoch`), stamp `turns.epoch_id` for the
  session's unstamped turns (S50B). Both best-effort + non-fatal.
- `src/store/turns/turnStore.ts` — add `stampTurnsEpoch(sessionId, epochId)` to `TurnStore`
  (sets `epoch_id` on this session's turns where `epoch_id IS NULL`).
- `extensions/mega-commands.ts` — register `mega-turn-cmds.ts` handlers.
- `src/store/sqlite.ts` — barrel re-export for `src/metrics/` (only if a metrics fn is consumed
  by the dashboard later; otherwise metrics stay imported directly).

### OUT OF SCOPE

- Dashboard Turns tab / Wiki tab / rewind handshake (S52) — `/mega-fork` is the primitive the
  dashboard intent will call.
- Auto-categorizing wiki (S51).
- True live-window replay (token-replay rewind) — S48 non-goal #1, stays out. `/mega-fork` is a
  **recall-fork** (rehydrate injected checkpoints), not a message-log rewind.
- Changing compaction/dedup behavior — this sprint only *labels* and *reads*.

---

## EXECUTION

Three gated sub-sprints.

### Sprint S50A: `raw_transcript.turn_index` wiring

**Goal:** every mirrored raw message carries its turn index so dedup/compression-by-turn become
queryable.

**Acceptance:** with `dbMirror` ON, `raw_transcript.turn_index` = `runtime.currentTurn` for new
appends; existing rows (null) untouched; flag OFF (no dbMirror) = no-op.

**Tasks:**

- [x] **S50A-1** `src/store/sqlite/raw-transcript.ts` — add `turnIndex?: number | null` to
  `RawTranscriptRow`; include `turn_index` in the INSERT column list + `@turn_index` bind
  (`row.turnIndex ?? null`). `rowToRawTranscript` maps it back. Column already exists via S43
  `ensureColumn`; no schema change needed.
- [x] **S50A-2** `extensions/mega-events/context-handler.ts` — `toRawTranscriptRow(msg, sessionId,
  epochId, currentTurn)` gains a `currentTurn` param; pass `runtime.currentTurn` at the call site
  (line ~166). `runtime.currentTurn` is maintained by `turn_start` (agent-handlers.ts:231).
- [x] **S50A-3** test — seed dbMirror append, assert `turn_index` matches the passed turn; assert
  null when not passed (back-compat). Reuse the S27 raw-transcript test harness pattern.
- [x] **GATE S50A** — full gate green. Commit `feat(turns): S50A raw_transcript.turn_index wiring`.

### Sprint S50B: `turns.epoch_id` stamping + epoch linking

**Goal:** link turns to the epoch that compacted them at compact-commit.

**Acceptance:** after a compaction commits an epoch, that session's previously-unstamped turns in
`turns.db` carry the new `epoch_id`; already-stamped turns keep theirs.

**Tasks:**

- [x] **S50B-1** `src/store/turns/turnStore.ts` — add `stampTurnsEpoch(sessionId, epochId): number`
  (UPDATE … WHERE session_id=? AND epoch_id IS NULL → returns changes). Add to the `TurnStore`
  interface (`types.ts`). Parameterized.
- [x] **S50B-2** `extensions/mega-events/context-handler.ts` — immediately after
  `writeCheckpointEpoch(db, epoch)` (line ~281), call `stampTurnsEpoch(runtime.rt.sessionId,
  epoch.epochId)` via the S49 store (gated on `config.turnsDbEnabled`; legacy path skipped —
  legacy main-db turn helpers are being retired). Best-effort try/catch.
- [x] **S50B-3** test — record turns (epoch_id null), stamp, assert set + idempotent (second stamp
  no-op); assert returns the stamped count.
- [x] **GATE S50B** — full gate green. Commit `feat(turns): S50B turns.epoch_id stamping`.

### Sprint S50C: Metrics + fork primitive + commands

**Goal:** the per-turn/per-conversation rollups the dashboard (S52) will render, plus the
`/mega-fork` user command.

**Acceptance:** `turnMetrics(store, mainDb, convId)` returns per-turn cache-hit/dedup/compression;
`conversationMetrics` rolls up; `/mega-fork <conv> <turn>` creates a child conversation seeded with
that turn's recall set and notifies the user.

**Tasks:**

- [x] **S50C-1** `src/metrics/turns.ts` — pure read functions:
  - `turnMetrics(store, mainDb, conversationId)` → per-turn rows: `{ turnIndex, ctxTokens,
    ctxPercent, epochId, recallCount, rawMessageCount, dedupUniqueRatio, compressionRatio }`.
    recallCount from `turn_recall` count per turn; dedupUniqueRatio from `raw_transcript`
    (distinct content_hash / rows, grouped by turn_index); compressionRatio from
    `checkpoint_epochs` (summary bytes / committed-range raw bytes) joined on `turns.epoch_id`.
    Tolerates a main db without raw_transcript (reuse host) → dedup/compression 0.
  - `conversationMetrics(store, mainDb, conversationId)` → aggregate of the above per conversation.
  - All take `TurnStore` + a `DatabaseSync` main-db handle (host-agnostic). Parameterized.
- [x] **S50C-2** `src/fork.ts` — `forkFromConversation(store, parentConvId, turnIndex)`:
  `store.getTurn(parentConvId, turnIndex)` → if null throw a typed `ForkError` (TURN_NOT_FOUND);
  else `store.forkConversation(parentConvId, turn.id)` → return `{ childConversationId, recalled,
  forkTurn, checkpointIds }` (throws NO_RECALL when the turn has no injected checkpoints).
  Host-agnostic.
- [x] **S50C-3** `extensions/mega-metrics-cmds.ts` — `/mega-metrics [conv]` (per-turn +
  conversation rollup) and `/mega-fork <turnIndex> [conv]` (creates child conv, returns replay
  set + notifies). Both wrapped try/catch; `turnsDbEnabled` OFF → notify "requires isolated
  turns.db". Registered in `mega-compact.ts`. (Named `mega-metrics-cmds.ts` — not
  `mega-turn-cmds.ts` — and the live-window-injection of the fork recall set is the S52 dashboard
  handshake; the primitive returns the replay set for the host to apply.)
- [x] **S50C-4** tests — `metrics/turns.test.ts` (per-turn + aggregate + bare-main-db tolerance)
  - `fork.test.ts` (resolves turn, returns replay set, typed errors on unknown / no-recall).
- [x] **GATE S50C** — full gate green. Commit `feat(metrics): S50C per-turn metrics + /mega-fork`.

---

## ACCEPTANCE CRITERIA

1. **`turn_index` populated**: new `raw_transcript` rows carry `runtime.currentTurn` (dbMirror ON).
2. **`epoch_id` linked**: post-compact, the session's unstamped turns carry the committed epoch id.
3. **Metrics correct**: per-turn + per-conversation cache-hit/dedup/compression match seeded truth.
4. **Fork works**: `/mega-fork <conv> <turn>` returns a child conversation seeded with exactly the
   recall set injected at that turn; unknown turn → typed error + user notify.
5. **Reuse-clean**: `grep -r "@earendil-works\|extensions/" src/metrics/ src/fork.ts` → nothing.
6. **Zero behavior change when gated off**: `dbMirror` OFF → no raw rows to annotate;
   `turnsDbEnabled` OFF → fork/epoch paths inert; compaction byte-identical.
7. **Non-fatal**: any metric/fork/epoch failure logs, never breaks agent loop/compaction/recall.
8. **Small files**: all new modules < 300 lines.
9. **Gate green** at each sub-sprint boundary.

## ROLLBACK

1. `MEGACOMPACT_TURNS_DB=0` → adapter uses legacy main-db helpers; fork/epoch commands notify
   "disabled"; compaction unchanged.
2. `turn_index`/`epoch_id` columns are additive + nullable — existing rows unaffected; reverting
   the two `context-handler.ts` hunks stops new population with no schema rollback.
3. `/mega-fork` + `/mega-turns` removed by unregistering `mega-turn-cmds.ts`.
4. All new code is new files + 3 small `context-handler.ts`/`raw-transcript.ts` hunks.

## RISKS

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `dbMirror` OFF in most installs → no `raw_transcript` rows → dedup-by-turn empty | Medium | Low | Metrics treat missing rows as 0, documented; turn-level cache-hit/compression still work (they use turns.db + checkpoint_epochs, not raw_transcript). |
| `runtime.currentTurn` resets per session → turn_index ambiguous across resumes | Medium | Medium | `raw_transcript.session_id` + `checkpoint_epoch` disambiguate; metrics group by (session, turn_index). Documented in `turns.ts`. |
| `/mega-fork` rehydrates a large recall set → token spike | Low | Medium | Cap seeded set at the recall `limit`; reuse `recallMaxTokens` accounting; notify the count. |
| Epoch stamp races a concurrent turn_end write | Low | Low | Both are best-effort single-statement UPDATEs on the same WAL connection; worst case a turn is stamped one epoch late (next compact). Non-fatal. |
