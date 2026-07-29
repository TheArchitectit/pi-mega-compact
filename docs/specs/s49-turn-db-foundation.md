# S49 — Turn-DB Foundation (Contract-First Isolated Store)

**Date:** 2026-07-29 (revision 1)
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Revision record:** `docs/specs/s49-rev1-architecture-upgrade.md`
**Depends on:** S48 core (shipped `f65e477` — `turns`/`turn_recall`/`conversation_branches` in main `sqlite.db`)
**Priority:** P1
**Status:** implement-ready
**Target version:** v0.9.1
**Reuse target:** host-agnostic — any TUI, API gateway, or test harness embeds `src/store/turns/` directly.

---

## REVISION NOTE (v0 → v1)

v0 (2026-07-28) defined the reuse architecture as a **dependency rule** ("no pi imports in `src/`").
v1 upgrades this to a **contract-first, event-sourced, capability-gated kernel**:

1. **Contract-first** — the `TurnStore` interface (in `types.ts`) is the source of truth. Hosts program against the interface, not the schema. `node:sqlite` is the reference implementation, not the only one.
2. **Append-only** — turns and recall hits are appended, never mutated. A "turn was recalled" is a new fact, not an UPDATE. Materialized views (per-conversation rollups, active-turn projections) are derived, not stored.
3. **Capability-gated** — `store.asReader()`, `store.asWriter()`, `store.asAdmin()`. Each consumer gets only the capabilities it needs.
4. **Ledger protocol** — host PUSHES facts (`append`), PULLS views (`query`). Store never initiates (no callbacks, no subscriptions, no emitters).
5. **StoreSnapshot** — `store.checkpoint()` / `store.restore()` for backup, migration, and test seeding.

Full rationale: `docs/specs/s49-rev1-architecture-upgrade.md`.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): the turn store is **read-only over memory**
  and write-only over its own provenance tables. It never touches drop ranges, checkpoints, or
  message ordering.
- **PREVENT-PI-003** (no system role): no change to injection paths.
- **PREVENT-PI-004** (no network): pure `node:sqlite` (in-process). Zero network. No PGlite.
- **PREVENT-002** (parameterized SQL): all queries use bound parameters.
- **PREVENT-001** (JSON.parse null check): any JSON column read uses `safeJson`.
- **Migration non-destructive + reversible**: copy-then-drop gated; legacy tables kept one release.
- **Feature flag default ON**: `TURNS_DB_ENABLED` (env `MEGACOMPACT_TURNS_DB`, default `true`).
- **Non-fatal**: store write failures log and never break the agent loop, recall, or compaction.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## THE CONTRACT (source of truth)

This is the `TurnStore` interface. **Every implementation must satisfy this.** The types are
domain-level (no SQL, no file paths, no pi types). A host imports `types.ts` + `index.ts` only.

```ts
// ─── Domain types ───────────────────────────────────────────────────

/** Unique turn identifier (monotonic within a conversation). */
type TurnId = string;

/** Unique conversation identifier. */
type ConversationId = string;

/** Unique session identifier. */
type SessionId = string;

/** A single turn record — an immutable fact. */
interface TurnEntry {
  conversationId: ConversationId;
  sessionId: SessionId;
  turnIndex: number;
  role: "user" | "assistant" | "system" | "tool";
  endedAt: number;       // epoch ms
  ctxTokens?: number;    // context window tokens at end of turn
  ctxPercent?: number;   // context window utilization 0-1
  pressureBand?: "green" | "yellow" | "red";
  model?: string;        // model used for this turn
}

/** A recall hit recorded during a turn — an immutable fact. */
interface TurnRecallEntry {
  turnId: TurnId;
  checkpointId: string;
  score: number;
  source: "checkpoint" | "cluster_summary" | "memory";
  raptorLevel?: number;
}

/** A conversation fork — an immutable fact. */
interface ConversationFork {
  parentConversationId: ConversationId;
  childConversationId: ConversationId;
  forkTurnIndex: number;    // turn in the parent where the fork happened
  createdAt: number;
}

/** Filters for querying turns. All fields optional (AND-combined). */
interface TurnFilter {
  conversationId?: ConversationId;
  sessionId?: SessionId;
  sinceMs?: number;         // epoch ms lower bound
  untilMs?: number;         // epoch ms upper bound
  pressureBand?: string;
  limit?: number;
  offset?: number;
}

/** What a prune operation removed. */
interface PruneReport {
  turnsRemoved: number;
  recallRemoved: number;
  branchesPreserved: number;
  freedBytes: number;        // approximate, from file-size delta
}

/** Retention policy — what the admin cap allows. */
interface RetentionPolicy {
  maxTurnAgeMs: number;                // delete turns older than this
  keepMinPerConversation: number;      // always keep at least N turns per conversation
  vacuumAfterPrune: boolean;           // run VACUUM after pruning
}

/** A complete snapshot for backup/migration/test-seeding. */
interface StoreSnapshot {
  version: 1;
  exportedAt: number;       // epoch ms
  turns: TurnEntry[];
  recall: TurnRecallEntry[];
  forks: ConversationFork[];
}

// ─── Capability interfaces ──────────────────────────────────────────

/** Read-only view — dashboards, TUI, analytics. */
interface TurnReader {
  query(filter: TurnFilter): TurnEntry[];
  getTurn(turnId: TurnId): TurnEntry | undefined;
  listRecall(turnId: TurnId): TurnRecallEntry[];
  listForks(conversationId: ConversationId): ConversationFork[];
  countTurns(conversationId: ConversationId): number;
  /** Project a materialized view: conversation → aggregate stats. */
  conversationStats(conversationId: ConversationId): {
    turnCount: number;
    firstTurnAt: number;
    lastTurnAt: number;
    avgCtxPercent: number;
    pressureBands: Record<string, number>;
  };
}

/** Append-only writer — compaction engine, event handlers. */
interface TurnWriter {
  appendTurn(entry: TurnEntry): TurnId;
  appendRecall(entry: TurnRecallEntry): void;
  ensureConversationId(sessionId: SessionId): ConversationId;
  /** Record a fork — copies the parent's turn_recall into the child's seed set. */
  forkConversation(parentId: ConversationId, forkTurnIndex: number): ConversationId;
}

/** Admin operations — prune command, DR, migration. */
interface TurnAdmin {
  prune(policy: RetentionPolicy): PruneReport;
  vacuum(): void;
  checkpoint(): StoreSnapshot;
  restore(from: StoreSnapshot): void;
  clear(): void;  // test-only; wipes all data
}

/** The composed store — hosts get a capability-gated view. */
interface TurnStore extends TurnReader, TurnWriter, TurnAdmin {
  /** Return a read-only view (for dashboards, TUI, analytics). */
  asReader(): TurnReader;
  /** Return an append-only view (for event handlers, compaction). */
  asWriter(): TurnWriter;
  /** Return an admin view (for prune, DR, migration). */
  asAdmin(): TurnAdmin;
  /** Close the underlying connection. For tests + graceful shutdown. */
  close(): void;
}

/** Factory: create a store from a state directory. */
interface TurnStoreOptions {
  stateDir: string;
  /** Override DB path (for tests / DR). Default: join(stateDir, "turns.db") */
  dbPath?: string;
  /** In-memory mode (for tests). Default: false. */
  inMemory?: boolean;
}

declare function createTurnStore(options: TurnStoreOptions): TurnStore;
```

---

## PROBLEM

S48 put `turns`, `turn_recall`, and `conversation_branches` **inside the main `sqlite.db`** — the
same file that holds checkpoints, RAPTOR nodes, embeddings, and the raw-transcript mirror. Three
concrete problems:

1. **Contention** — turn/recall writes happen on the hot agent loop and share one WAL with
   compaction/vector traffic.
2. **Space coupling** — per-turn provenance is append-forever but is not memory content; it bloats
   the file we want lean for fast checkpoint scans, with no independent retention story.
3. **Blast radius** — a bug in the least-critical path (turn tracking, deliberately "best-effort,
   non-fatal") currently transacts on the *authoritative* store.

Plus: **no clean seam for reuse.** Turn logic is entangled with the pi-opened main store. A host
that wants only turn tracking must pull the entire memory schema. The contract-first kernel fixes
this: `createTurnStore({ stateDir })` — one call, own file, own WAL, own capabilities.

---

## SCOPE

File-size discipline: **every new module < 300 lines**; split by single responsibility.

### IN SCOPE — new files (`src/store/turns/`)

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/store/turns/types.ts` | **Contract module** — all domain types + `TurnStore` / `TurnReader` / `TurnWriter` / `TurnAdmin` interfaces + `TurnStoreOptions` + `createTurnStore` signature. **Ships first.** | ~130 |
| `src/store/turns/sqlite-store.ts` | `SqliteTurnStore` — reference implementation against `node:sqlite`. Private schema (SQL is an implementation detail). All methods satisfy the contract. | ~250 |
| `src/store/turns/memory-store.ts` | `InMemoryTurnStore` — test harness + embeddable in-process store for hosts that don't want SQLite. Same contract, backed by `Map`s. | ~150 |
| `src/store/turns/connection.ts` | `openTurnDb(stateDir, options?)` — separate connection cache, own WAL, `PRAGMA foreign_keys`. Used by `SqliteTurnStore` only (private). | ~90 |
| `src/store/turns/migrations.ts` | One-time idempotent move of turn tables from main-db → `turns.db` (ATTACH + copy + drop, gated). | ~150 |
| `src/store/turns/retention.ts` | `pruneTurns`, `pruneRecall`, `vacuumTurns` — pulled out of `SqliteTurnStore` for single-responsibility. Implements the `TurnAdmin.prune`/`vacuum` contract. | ~120 |
| `src/store/turns/snapshot.ts` | `checkpoint()` / `restore()` — serializes the full store to a `StoreSnapshot`. Implements the `TurnAdmin.checkpoint`/`restore` contract. | ~100 |
| `src/store/turns/index.ts` | Barrel: re-exports `createTurnStore`, all types, and the `TurnStoreOptions` factory. | ~20 |
| `src/store/turns/sqlite-store.test.ts` | Full contract compliance against `SqliteTurnStore`. | ~250 |
| `src/store/turns/memory-store.test.ts` | Full contract compliance against `InMemoryTurnStore` (proves the contract is backend-agnostic). | ~200 |
| `src/store/turns/migrations.test.ts` | Idempotent, loss-free, reversible. | ~150 |
| `src/store/turns/retention.test.ts` | Prune keeps min-per-conversation, cascades recall, preserves branches, vacuum reclaims space. | ~150 |
| `src/store/turns/contract-compliance.test.ts` | **Shared test suite** — imported by both backend test files. Proves both backends satisfy the same contract. | ~180 |

### IN SCOPE — modified files

- `src/config.ts` — add `TURNS_DB_ENABLED`, `TURNS_RETENTION_DAYS`, `TURNS_DB_PATH`
- `extensions/mega-events/agent-handlers.ts` — `turn_end` → `createTurnStore(...).asWriter().appendTurn()`
- `extensions/mega-pipeline/recall.ts` — provenance → `createTurnStore(...).asWriter().appendRecall()`
- `src/store/sqlite.ts` — when flag ON, stop re-exporting legacy turn helpers
- `src/store/sqlite/schema.ts` — mark legacy turn tables (kept one release for rollback)

### OUT OF SCOPE

- `raw_transcript.turn_index` wiring (S50)
- `turns.epoch_id` stamping (S50)
- `/mega-fork` command (S50)
- Topic clustering / wiki (S51)
- Dashboard tabs / rewind handshake (S52)

---

## EXECUTION

Three gated sub-sprints. Each ends at the full gate; each is independently revertible.

### S49A: Contract + Reference Implementation + In-Memory Backend

**Goal:** the `TurnStore` interface is the source of truth. Two implementations ship:
`SqliteTurnStore` (production) and `InMemoryTurnStore` (tests/embedding). A shared compliance
suite proves both satisfy the contract. Zero behavior change to the running extension (nothing
calls it yet).

**Acceptance:**

- Both backends pass `contract-compliance.test.ts`
- `grep -r "@earendil-works\|extensions/" src/store/turns/` returns nothing
- `SqliteTurnStore` opens a file separate from `sqlite.db`
- `InMemoryTurnStore` passes the same suite with no file I/O

**Tasks:**

- [ ] **S49A-1** `src/store/turns/types.ts` — the contract module. All domain types + interfaces
  - `TurnStoreOptions` + `createTurnStore` signature. **This file is reviewed first and is the
  gate for all subsequent implementation.**
- [ ] **S49A-2** `src/store/turns/connection.ts` — private SQLite connection manager. Own `Map`
  cache (separate from the memory cache). `openTurnDb`, `closeTurnDb`.
- [ ] **S49A-3** `src/store/turns/sqlite-store.ts` — `SqliteTurnStore implements TurnStore`.
  Private schema (CREATE TABLE + indexes are internal — not exported). All methods satisfy the
  contract. `asReader()`/`asWriter()`/`asAdmin()` return thin proxies that delegate to the same
  underlying store but expose only the subset interface.
- [ ] **S49A-4** `src/store/turns/memory-store.ts` — `InMemoryTurnStore implements TurnStore`.
  Same contract, backed by `Map<ConversationId, TurnEntry[]>` etc. For tests + hosts that don't
  want SQLite.
- [ ] **S49A-5** `src/store/turns/contract-compliance.test.ts` — parameterized test suite that
  takes a `TurnStore` factory and asserts every method's contract. Imported by both backend test
  files. Tests: appendTurn returns a TurnId; appendRecall + listRecall round-trips; query filters
  compose (AND); conversationStats aggregates correctly; forkConversation copies seed recall;
  asReader cannot append; asWriter cannot prune; asAdmin can prune + checkpoint + restore;
  close() is idempotent.
- [ ] **S49A-6** `src/store/turns/sqlite-store.test.ts` — imports the compliance suite +
  `SqliteTurnStore`-specific tests (isolation from `sqlite.db`, WAL mode, connection caching).
- [ ] **S49A-7** `src/store/turns/memory-store.test.ts` — imports the compliance suite. Proves
  the contract is backend-agnostic.
- [ ] **S49A-8** `src/store/turns/index.ts` — barrel. Exports `createTurnStore` (routes to
  `SqliteTurnStore` by default, `InMemoryTurnStore` when `options.inMemory`), all types, and
  `TurnStoreOptions`.
- [ ] **GATE S49A** — full gate green. Commit: `feat(turns): S49A contract-first TurnStore + sqlite + in-memory backends`.

### S49B: Migration (main-db → turns.db) + Config

**Goal:** move existing turn data into `turns.db` on first open, idempotently and reversibly; wire
the feature flag.

**Acceptance:** `migrations.test.ts` green; seeded legacy db → rows present in `turns.db` +
legacy tables dropped (behind flag); re-run is a no-op; flag OFF → legacy untouched.

**Tasks:**

- [ ] **S49B-1** `src/config.ts` — `TURNS_DB_ENABLED`, `TURNS_RETENTION_DAYS`, `TURNS_DB_PATH`.
- [ ] **S49B-2** `src/store/turns/migrations.ts` — `migrateTurnTablesIfNeeded(mainDbPath, turnDb)`.
  Detect turn tables in main db; if present and flag ON: ATTACH → INSERT SELECT → DROP → DETACH.
  `turns_meta.migrated_from_main = 1` marker. Non-fatal.
- [ ] **S49B-3** Hook migration into `createTurnStore` (after `initTurnSchema`), gated on flag +
  main-db existence.
- [ ] **S49B-4** `migrations.test.ts` — fresh db → no-op; seeded legacy → rows moved + legacy
  dropped; second open → no re-copy; flag OFF → legacy untouched.
- [ ] **GATE S49B** — full gate green. Commit: `feat(turns): S49B main-db→turns.db migration + config flags`.

### S49C: Retention + Snapshot + Adapter Re-point + Cleanup

**Goal:** pruning API; backup/restore via `StoreSnapshot`; switch the live writers onto the store;
quarantine legacy helpers.

**Acceptance:** retention + snapshot tests green; `turn_end` and recall write to `turns.db` (flag
ON) or main db (flag OFF); flag-OFF behavior byte-identical to S48.

**Tasks:**

- [ ] **S49C-1** `src/store/turns/retention.ts` — `pruneTurns(policy)`, `vacuumTurns()`. Implements
  `TurnAdmin.prune` / `vacuum` contract. Prune respects `keepMinPerConversation`; cascades recall;
  preserves fork lineage; vacuum reclaims space.
- [ ] **S49C-2** `src/store/turns/snapshot.ts` — `checkpoint()`, `restore()`. Implements
  `TurnAdmin.checkpoint` / `restore` contract. Serializes to `StoreSnapshot` JSON; round-trip is
  lossless.
- [ ] **S49C-3** `retention.test.ts` + `snapshot.test.ts`.
- [ ] **S49C-4** Adapter re-point — `agent-handlers.ts` `turn_end` → `store.asWriter().appendTurn()`;
  `recall.ts` provenance → `store.asWriter().appendRecall()`. Gated on `TURNS_DB_ENABLED`.
  Dashboard reads → `store.asReader()`.
- [ ] **S49C-5** `src/store/sqlite.ts` — when flag ON, re-export from `src/store/turns/index.ts`;
  keep legacy `turns.ts` on disk one release for rollback. `schema.ts` legacy tables get a comment.
- [ ] **S49C-6** Regression: S48-era `turns.test.ts` passes under both flag ON and flag OFF.
- [ ] **GATE S49C** — full gate green. Commit: `feat(turns): S49C retention + snapshot + adapter re-point`.

---

## ACCEPTANCE CRITERIA

1. **Contract compliance** — both `SqliteTurnStore` and `InMemoryTurnStore` pass the shared
   compliance suite. Adding a third backend (IndexedDB, Postgres) requires only implementing the
   interface + importing the compliance suite.
2. **Capability gating** — `asReader()` cannot append; `asWriter()` cannot prune; `asAdmin()` can
   prune + checkpoint + restore. Proven by the compliance suite.
3. **Append-only** — no method on `TurnWriter` or `TurnReader` mutates an existing row. All
   mutations (prune, clear) are on `TurnAdmin` only. Proven by grep: `UPDATE` appears nowhere in
   `src/store/turns/` except in `migrations.ts` (which is a one-time copy, not a mutation).
4. **Ledger protocol** — the `TurnStore` interface has zero subscription/emitter/callback types.
   The store never calls into the host. Proven by type inspection.
5. **StoreSnapshot round-trip** — `store.restore(store.checkpoint())` is lossless (proven by test).
6. **Isolation** — turn writes land in `turns.db`, never `sqlite.db` (flag ON).
7. **Reuse-clean** — `grep -r "@earendil-works\|extensions/" src/store/turns/` returns nothing.
8. **Zero behavior change when OFF** — `MEGACOMPACT_TURNS_DB=0 npm test` green.
9. **Migration loss-free + idempotent** — legacy rows present post-migration; re-run is a no-op.
10. **Retention correct** — prune keeps `keepMinPerConversation`, cascades recall, preserves
    branches, vacuum reclaims space.
11. **Non-fatal** — any store/migration/retention failure logs, never breaks the agent loop.
12. **Small files** — every module < 300 lines.
13. **Gate green** at each sub-sprint boundary.

## ROLLBACK

1. `MEGACOMPACT_TURNS_DB=0` → writers use the legacy main-db path (byte-identical to S48).
2. Legacy tables kept in `schema.ts` one release → downgrading never loses history.
3. All new code in `src/store/turns/` + two gated adapter edits → revert the hunks + delete
   the directory to fully back out.
4. `turns.db` is additive; deleting it + flag OFF restores S48 state exactly.

## RISKS

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Migration copies partial data (crash mid-copy) | Low | Medium | `withTx` wraps the whole copy+drop; failure rolls back, marker unset, retried on next open. |
| Two processes open turns.db concurrently | Medium | Low | WAL mode allows one writer + many readers; dashboard reads via `asReader()`. |
| Reuse contract broken by an accidental pi import | Medium | Medium | Grep-assertion test fails the build. |
| Append-only semantics violated by a future change | Low | High | Compliance suite asserts no `UPDATE` in the store; CI grep enforces it. |
| Retention deletes turns a fork still references | Low | High | Fork lineage preserved; `keepMinPerConversation` floor protects recent forks. |
| `StoreSnapshot` grows large for production stores | Medium | Low | `checkpoint()` streams JSON; future: incremental snapshots (S50+). |
