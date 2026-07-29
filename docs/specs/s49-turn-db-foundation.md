# S49 — Turn-DB Foundation (Isolated Per-Turn Store)

**Date:** 2026-07-28
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Depends on:** S48 core (shipped `f65e477` — `turns`/`turn_recall`/`conversation_branches` in main `sqlite.db`)
**Priority:** P1
**Status:** ✅ SHIPPED (S49A/S49B/S49C, branch `s49-turn-db`) — isolated `turns.db` + host-agnostic `TurnStore` + main-db→turns.db migration + retention + adapter re-point. 13 new tests (9 turnStore + 4 migrations + 2 adapter); 803 total passing.
**Target version:** v0.9.0
**Reuse target:** host-agnostic — our own TUI + API gateway embed `src/store/turns/` directly.

---

## REUSE CONTRACT (load-bearing)

Every module in this sprint is **pi-agnostic** and lives in `src/store/turns/`. No import of
`ExtensionAPI`, `ExtensionContext`, `MegaRuntime`, or any `@earendil-works/*` type. The only
host-supplied inputs are plain values (`stateDir`, ids, numbers). A host does:

```ts
import { createTurnStore } from "pi-mega-compact/src/store/turns/index.js";
const store = createTurnStore({ stateDir });   // own sqlite file, own WAL
const turnId = store.recordTurn({ conversationId, sessionId, turnIndex, endedAt: Date.now() });
```

pi-specific wiring (`extensions/mega-events/agent-handlers.ts`, `extensions/mega-pipeline/recall.ts`)
becomes a **thin adapter** that calls the store — the store never calls back into pi.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): the turn store is **read-only over memory**
  and write-only over its own provenance tables. It never touches drop ranges, checkpoints, or
  message ordering. Moving turn tables out of the main DB does not change compaction behavior.
- **PREVENT-PI-003** (no system role): no change to injection paths.
- **PREVENT-PI-004** (no network): pure `node:sqlite` (in-process). Zero network. No PGlite here —
  turn data is relational provenance (exact lookups), not vector NN; see program §4.
- **PREVENT-002** (parameterized SQL): all queries use bound parameters; no string concatenation.
- **PREVENT-001** (JSON.parse null check): any JSON column read uses the existing `safeJson`.
- **Migration is non-destructive + reversible**: copy-then-drop is gated; main-DB tables are kept
  for one release before removal, so a rollback never loses turn history.
- **Feature flag default ON**: `TURNS_DB_ENABLED` (env `MEGACOMPACT_TURNS_DB`, default `true`).
  When OFF, turn helpers keep using the main `sqlite.db` exactly as S48 shipped them (byte-identical
  behavior — regression-tested).
- **Non-fatal**: all turn-store writes stay best-effort — a failure logs and never breaks the agent
  loop, the recall path, or compaction.
- Gate (every sub-sprint): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

S48 put `turns`, `turn_recall`, and `conversation_branches` **inside the main `sqlite.db`** — the
same file that holds checkpoints, RAPTOR nodes, embeddings, and the raw-transcript mirror. This
causes three concrete problems (see program §2):

1. **Contention** — turn/recall writes happen on the hot agent loop (`turn_end`, every recall) and
   share one WAL connection with compaction/vector traffic. Node:sqlite is synchronous: a
   turn-tracking write queues behind any in-flight memory transaction.
2. **Space coupling** — per-turn provenance is append-forever but is not memory content; it bloats
   the file we want lean for fast checkpoint scans, and it has no independent retention story.
3. **Blast radius** — a bug in the least-critical path (turn tracking, deliberately "best-effort,
   non-fatal") currently opens/transacts on the *authoritative* store.

There is also **no clean seam for reuse**: turn logic is entangled with the pi-opened main store
(`openStore` from `src/store/sqlite/utils.ts`, which runs the full memory `initSchema`). A host that
wants only turn tracking must pull the entire memory schema. The platform needs an **isolated store
behind a narrow interface** that any host can open standalone.

---

## SCOPE

File-size discipline: **every new module < 300 lines**; split by single responsibility; a thin
`index.ts` barrel re-exports. No module approaches the project's largest files.

### IN SCOPE (new files — `src/store/turns/`)

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/store/turns/schema.ts` | `CREATE TABLE IF NOT EXISTS` for `turns`, `turn_recall`, `conversation_branches`, `pending_fork` + indexes. `initTurnSchema(db)`. | ~120 |
| `src/store/turns/connection.ts` | `openTurnStore(stateDir)` — separate connection cache, own WAL, `PRAGMA foreign_keys`, calls `initTurnSchema` (NOT memory `initSchema`). `closeTurnStore`. | ~90 |
| `src/store/turns/types.ts` | `TurnRow`, `TurnRecallRow`, `RecallSource`, `ConversationBranch`, `PendingFork`, `TurnStore` interface. | ~90 |
| `src/store/turns/turnStore.ts` | `createTurnStore(stateDir)` factory returning the `TurnStore` interface (recordTurn/recordTurnRecall/getTurn/listTurnRecall/listConversationTurns/ensureConversationId/forkConversation/clearTurns). | ~200 |
| `src/store/turns/migrations.ts` | One-time idempotent move of turn tables main-db → `turns.db` (ATTACH + copy + drop, gated). | ~150 |
| `src/store/turns/retention.ts` | `pruneTurns({olderThanMs, keepMinPerConversation})`, `pruneRecall`, `vacuumTurns`. | ~120 |
| `src/store/turns/index.ts` | Barrel re-export only. | ~15 |
| `src/store/turns/turnStore.test.ts` | CRUD + fork + conversation-id stability + isolation (turns.db separate from main). | ~250 |
| `src/store/turns/migrations.test.ts` | Move is idempotent, reversible, loss-free. | ~150 |
| `src/store/turns/retention.test.ts` | Prune keeps min-per-conversation, cascades recall, vacuums. | ~150 |

### IN SCOPE (modified files)

- `src/config.ts` — add `TURNS_DB_ENABLED` (default `true`), `TURNS_RETENTION_DAYS` (default `30`),
  `TURNS_DB_PATH` (env override for tests/DR). Env-overridable, documented.
- `extensions/mega-events/agent-handlers.ts` — `turn_end` writer calls `createTurnStore(...).recordTurn`
  (thin adapter) instead of the main-db `recordTurn`. Gated on `TURNS_DB_ENABLED`.
- `extensions/mega-pipeline/recall.ts` — provenance writer calls the store's `recordTurnRecall`.
  Gated on `TURNS_DB_ENABLED`.
- `src/store/sqlite.ts` — when `TURNS_DB_ENABLED`, stop re-exporting the legacy main-db turn helpers
  from the memory barrel (they move to `src/store/turns/index.ts`). Kept one release for rollback.
- `src/store/sqlite/schema.ts` — mark the in-main-db turn `CREATE TABLE` blocks as legacy (kept one
  release for rollback; removed in S49-cleanup). No behavioral change this sprint.

### OUT OF SCOPE

- `raw_transcript.turn_index` wiring (S50).
- `turns.epoch_id` stamping at compact commit (S50).
- `/mega-fork` command (S50) — the store's `forkConversation` is the primitive it will call.
- Topic clustering / wiki (S51) — but `schema.ts` pre-creates `topics`/`memory_topics`/`pending_fork`
  so later sprints add **no new migration**.
- Dashboard tabs / rewind handshake (S52) — `pending_fork` table lands here; the HTTP + consumer land in S52.
- Moving `raw_transcript` or `checkpoint_epochs` — they stay in the main DB (memory mirror; shared
  dedup/epoch linkage). Only the turn spine moves.

---

## EXECUTION

Split into **three gated sub-sprints**. Each ends at the full gate; each is independently revertible.

### Sprint S49A: Isolated store + types + connection

**Goal:** a standalone `turns.db` opens, holds the turn schema, and exposes a `TurnStore` interface
— with **zero** behavior change to the running extension (nothing calls it yet).

**Acceptance:** `turnStore.test.ts` green; `createTurnStore` opens a file *separate* from
`sqlite.db`; all S48 CRUD works against it; no pi imports anywhere in `src/store/turns/`.

**Tasks:**

- [ ] **S49A-1** `src/store/turns/schema.ts` — `initTurnSchema(db)`. Tables mirror the S48 shapes
  exactly (columns + `UNIQUE(session_id, turn_index)`, `UNIQUE(turn_id, checkpoint_id)`,
  `conversation_branches` PK) plus the future `pending_fork` (see S52) and S51 `topics`/
  `memory_topics` shells. Indexes: `idx_turns_conv`, `idx_turns_session`, `idx_turns_epoch` (partial),
  `idx_turn_recall_turn`, `idx_turn_recall_cp`, `idx_conv_branch_parent`. All `IF NOT EXISTS`,
  all parameterized. Comment that turn tables moved out of main db (S49).
- [ ] **S49A-2** `src/store/turns/connection.ts` — `openTurnStore(stateDir)`. Own module-level
  `Map<string, DatabaseSync>` cache (separate from the memory cache); open `join(stateDir, "turns.db")`;
  `PRAGMA journal_mode=WAL`; `PRAGMA foreign_keys=ON`; `initTurnSchema(db)`; dead-handle eviction
  mirroring `openStore`. `closeTurnStore(stateDir)` for tests.
- [ ] **S49A-3** `src/store/turns/types.ts` — port `TurnRow`/`TurnRecallRow`/`RecallSource` from
  `src/store/sqlite/turns.ts` unchanged; add `ConversationBranch`, `PendingFork`; define the
  `TurnStore` interface (method signatures only).
- [ ] **S49A-4** `src/store/turns/turnStore.ts` — `createTurnStore`. Method bodies ported from
  `src/store/sqlite/turns.ts`, switched `openStore(stateDir)` → the cached `openTurnStore(stateDir)`
  handle. Reuse `normalizeSessionId` (import from `src/store.ts` — pure, pi-agnostic). Reuse
  `withTx`/`safeJson` patterns locally (do NOT import from the memory `utils.ts` — keep the module
  graph clean; `withTx` is 12 lines, duplicate it here so `src/store/turns/` is self-contained).
- [ ] **S49A-5** `src/store/turns/index.ts` — barrel.
- [ ] **S49A-6** `turnStore.test.ts` — recordTurn upsert + getTurn; recordTurnRecall + listTurnRecall;
  listConversationTurns ordering; ensureConversationId stability; forkConversation lineage + replay
  set; clearTurns cascade; **isolation test** (turns.db exists, sqlite.db untouched by turn writes).
  Grep-assertion test: no `@earendil-works` / `extensions/` import in `src/store/turns/`.
- [ ] **GATE S49A** — full gate green. Commit: `feat(turns): S49A isolated turns.db store + TurnStore interface`.

### Sprint S49B: Migration (main-db → turns.db) + config

**Goal:** move existing turn data into `turns.db` on first open, idempotently and reversibly; wire
the feature flag.

**Acceptance:** `migrations.test.ts` green; an S48-era main db with turn rows opens post-S49 with
all rows present in `turns.db` and the legacy tables dropped (behind flag); re-running is a no-op.

**Tasks:**

- [ ] **S49B-1** `src/config.ts` — `TURNS_DB_ENABLED` (env `MEGACOMPACT_TURNS_DB !== "0"`, default
  `true`), `TURNS_RETENTION_DAYS` (env, default `30`), `TURNS_DB_PATH` (env, default
  `join(stateDir,"turns.db")`). Doc comments: default ON, opt-out, calibration n/a.
- [ ] **S49B-2** `src/store/turns/migrations.ts` — `migrateTurnTablesIfNeeded(mainDbPath, turnDb)`.
  Detect turn tables in main db (`SELECT name FROM sqlite_master`); if present and flag ON:
  `ATTACH main AS legacy` (read-only) → `INSERT INTO turns SELECT … FROM legacy.turns` (and the
  other two tables) inside `withTx` → `DROP TABLE legacy.turns/turn_recall/conversation_branches`
  → `DETACH`. Guarded by a `turns_meta.migrated_from_main = 1` marker row so it runs once.
  Non-fatal: failure logs, leaves legacy tables intact, store still opens (empty).
- [ ] **S49B-3** Hook `migrateTurnTablesIfNeeded` into `openTurnStore` (after `initTurnSchema`),
  gated on `TURNS_DB_ENABLED` and on the main-db file existing.
- [ ] **S49B-4** `migrations.test.ts` — fresh db → no-op; seeded legacy db → rows moved + legacy
  dropped; second open → no re-copy (marker); flag OFF → legacy untouched.
- [ ] **GATE S49B** — full gate green. Commit: `feat(turns): S49B main-db→turns.db migration + config flags`.

### Sprint S49C: Retention + adapter re-point + cleanup

**Goal:** pruning API; switch the live writers onto the store; quarantine legacy main-db helpers.

**Acceptance:** `retention.test.ts` green; `turn_end` and recall write to `turns.db` (flag ON) or
main db (flag OFF); flag-OFF behavior byte-identical to S48.

**Tasks:**

- [ ] **S49C-1** `src/store/turns/retention.ts` — `pruneTurns({ olderThanMs, keepMinPerConversation })`:
  delete `turn_recall` rows whose turn is older than cutoff **except** the most recent
  `keepMinPerConversation` turns per `conversation_id`; then delete those `turns`; keep
  `conversation_branches` (fork lineage is cheap + needed for the tree). `vacuumTurns()` — `VACUUM`
  the turns.db file. All parameterized, in `withTx`.
- [ ] **S49C-2** `retention.test.ts` — prune respects keep-min; cascades recall; preserves branches;
  vacuum reclaims space (file size shrinks); non-fatal on empty db.
- [ ] **S49C-3** Adapter re-point — `agent-handlers.ts` `turn_end` + `recall.ts` provenance:
  `const ts = createTurnStore({ stateDir: runtime.currentStateDir }); ts.recordTurn(…)`,
  `ts.recordTurnRecall(…)`. Wrapped in the existing try/catch (non-fatal). Gated:
  `if (config.turnsDbEnabled) { store path } else { legacy main-db path }`.
- [ ] **S49C-4** `src/store/sqlite.ts` — when flag ON, re-export turn helpers from
  `src/store/turns/index.ts`; keep the legacy main-db `turns.ts` on disk one release (rollback),
  but no longer routed through the memory barrel when flag ON. `schema.ts` legacy turn tables get
  a "legacy — removed in S49-cleanup" comment (not dropped this sprint).
- [ ] **S49C-5** Regression: existing `turns.test.ts` (S48, 7 tests) must still pass — point it at
  the flag-OFF legacy path AND add a flag-ON twin run so both routes are covered.
- [ ] **GATE S49C** — full gate green. Commit: `feat(turns): S49C retention + adapter re-point + legacy quarantine`.

---

## ACCEPTANCE CRITERIA

1. **Isolation**: turn writes land in `turns.db`, never `sqlite.db` (flag ON). Proven by a test
   asserting the two files' distinctness and that `sqlite.db` byte-size is unchanged by a turn write.
2. **Reuse-clean**: `grep -r "@earendil-works\|extensions/" src/store/turns/` returns nothing.
   `createTurnStore` works with only a `stateDir` — no pi runtime.
3. **Zero behavior change when OFF**: `MEGACOMPACT_TURNS_DB=0 npm test` → all S48-era tests pass
   unchanged; writers use the legacy main-db path.
4. **Migration loss-free + idempotent**: legacy rows present post-migration; re-run is a no-op;
   reversible for one release (legacy tables kept in schema).
5. **Retention correct**: prune keeps `keepMinPerConversation` per conversation, cascades recall,
   preserves branch lineage, and `VACUUM` reclaims space.
6. **Non-fatal**: any store/migration/retention failure logs and never breaks the agent loop,
   recall, or compaction (asserted by try/catch coverage tests).
7. **Small files**: every new module < 300 lines; split by single responsibility; barrel re-export.
8. **Gate green** at each sub-sprint boundary.

## ROLLBACK

1. `MEGACOMPACT_TURNS_DB=0` → writers use the legacy main-db path (byte-identical to S48).
2. Legacy main-db turn tables are kept in `schema.ts` for one release → downgrading never loses
   turn history (rows still writable/readable via the legacy helpers).
3. All new code is in new `src/store/turns/` files + two gated adapter edits → revert the two
   adapter hunks + delete the directory to fully back out.
4. `turns.db` is additive; deleting it + flag OFF restores S48 state exactly.

## RISKS

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Migration copies partial data (crash mid-copy) | Low | Medium | `withTx` wraps the whole copy+drop; failure rolls back, marker unset, retried on next open. |
| Two processes (TUI + dashboard) open turns.db concurrently | Medium | Low | WAL mode allows one writer + many readers; dashboard reads via a read-only connection (S52). |
| Reuse contract broken by an accidental pi import | Medium | Medium | Grep-assertion test in S49A-6 fails the build on any `@earendil-works`/`extensions/` import. |
| Retention deletes turns a fork still references | Low | High | `conversation_branches` preserved; fork replay reads `turn_recall` only for turns *within* retention; `keepMinPerConversation` floor protects recent forks. |
| Connection-cache divergence (two caches for one stateDir) | Low | Low | Separate `Map` keyed identically; `closeTurnStore` mirrors `closeStore` for tests. |
