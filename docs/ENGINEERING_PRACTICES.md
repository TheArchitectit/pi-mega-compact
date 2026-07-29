# Engineering Practices — pi-mega-compact

**Version:** 1.0
**Date:** 2026-07-29
**Status:** ACTIVE — every sprint must comply

This document codifies the project's structural conventions. It is the single source of truth for
how we split files, gate releases, log events, and enforce guardrails. If CLAUDE.md or a spec
disagrees with this document, **this document wins** (and the other gets updated).

---

## 1. File Size Limits (HARD)

| Kind | Soft limit | Hard limit | Action on breach |
|---|---|---|---|
| Source (`src/**/*.ts`) | 300 lines | 500 lines | Split immediately |
| Extension (`extensions/**/*.ts`) | 400 lines | 500 lines | Split immediately |
| Test (`*.test.ts`) | 400 lines | 600 lines | Extract shared helpers; split by describe block |
| Spec (`docs/specs/*.md`) | 500 lines | — | Split into sub-docs with a parent index |
| Config / barrel (`index.ts`, `types.ts`) | 100 lines | — | Re-export only; no logic |

**Rule:** A file that hits the soft limit and still has work to do in the current sprint **must** be
split before that work lands. A file at the hard limit is a build blocker — `npm run lint`
will warn; the PR cannot merge.

**Enforcement:** `scripts/guardrails-scan.mjs` gains a `--file-size` mode (S49+) that checks
every `.ts` file against these limits. Until then, the agent checks manually at each gate.

---

## 2. File Splitting Pattern (MANDATORY)

When a file exceeds its limit, use the **delegate-shell pattern** — the established convention
in `extensions/mega-runtime/`:

### The pattern

```
original-file.ts          ← becomes a thin delegate shell
  new-feature-impl.ts    ← the real logic (free function or class)
```

**Shell file** (`original-file.ts`):

```ts
// Thin delegate — logic lives in new-feature-impl.ts
export function doThing(ctx: Context, arg: Arg): Result {
  return doThingImpl(ctx, arg);
}
```

**Implementation file** (`new-feature-impl.ts`):

```ts
// Context interface — what the impl needs from the caller
interface DoThingContext {
  stateDir: string;
  // …only the narrow surface the impl requires
}

// Free function — testable in isolation
export function doThingImpl(ctx: DoThingContext, arg: Arg): Result {
  // real logic here
}
```

### Rules

1. **One responsibility per impl file.** `retention.ts` handles pruning. `snapshot.ts` handles
   backup/restore. Never mix them.
2. **The context interface is the seam.** The impl receives a narrow interface, not the full
   class or `ExtensionAPI`. This is how `src/` stays pi-agnostic.
3. **The shell is 1–3 lines per method.** If the delegate is more than `return implFn(ctx, arg)`,
   the split is wrong.
4. **Tests import the impl.** `retention.test.ts` imports `retentionImpl`, not the shell. The shell
   is tested by the existing integration suite.
5. **No re-export chains.** A barrel (`index.ts`) re-exports types only. Logic flows through
   impl imports, not re-export indirection.

### Reference examples

| Shell | Impl files | Notes |
|---|---|---|
| `extensions/mega-runtime/runtime.ts` (~437 lines) | `effects.ts`, `game-state.ts`, `perf.ts`, `pressure-getters.ts`, … | Original reference; delegates-only |
| `src/store/sqlite.ts` | `schema.ts`, `turns.ts`, `utils.ts`, `raptor.ts`, `global-index.ts`, … | Main store barrel + impl split |
| `extensions/dashboard-server/routes.ts` | `routes-core.ts`, `routes-game.ts`, `routes-repo.ts`, `routes-sessions.ts` | Route-level split |

---

## 3. Contract-First Architecture

Every new module starts with the **types file** — the interface that consumers depend on.
Implementation files import from it; consumers import only the types + factory.

### Ordering (MANDATORY for new modules)

```
1. types.ts         ← the contract (interfaces, domain types, factory signature)
2. impl.ts          ← the reference implementation
3. index.ts         ← barrel (re-exports from types + factory from impl)
4. *.test.ts        ← compliance suite against the contract
```

**The types file is reviewed first** and is the gate for all subsequent implementation. If the
contract is wrong, every implementation built on it is wrong. No code is written until the types
file is approved.

### What goes in `types.ts`

- Domain types (value objects, enums, result types)
- Interface definitions (the contract)
- Factory function signature (`createX(options): X`)
- **Nothing else** — no imports from impl files, no runtime logic

### What does NOT go in `types.ts`

- SQL schemas (those are private to the implementation)
- `import` from `node:sqlite`, `better-sqlite3`, or any storage backend
- Logging, monitoring, or error-handling logic
- Default values (those go in `config.ts` or the impl)

---

## 4. Capability Gating (Store Handles)

Every store that crosses a trust boundary (dashboard reads, compaction writes, admin prune)
must expose **capability-gated views**:

```ts
interface SomeStore {
  asReader(): StoreReader;   // query only — for dashboards, TUI, analytics
  asWriter(): StoreWriter;   // append only — for event handlers, compaction
  asAdmin(): StoreAdmin;     // prune, vacuum, restore — for maintenance commands
}
```

### Rules

1. **Reader cannot write.** The returned object's type physically cannot call `append`, `prune`,
   or `clear`. TypeScript enforces this at compile time; the compliance suite asserts it at
   runtime.
2. **Writer cannot prune.** The compaction engine should never be able to delete data.
3. **Admin can do anything.** The `/mega-prune` command, the dashboard vacuum button, and the
   test harness use `asAdmin()`.
4. **No "god handle" in production.** The raw `SomeStore` interface (which composes all three) is
   only for the factory + tests. In production, every consumer gets the narrowest capability it
   needs.

### Why

- A dashboard that can accidentally prune is a data-loss risk.
- A compaction engine that can accidentally read stale state during a write is a consistency risk.
- A test that uses the god handle is fine — but production code must be capability-scoped.

---

## 5. Append-Only Semantics (Provenance Stores)

For stores that track **what happened** (turns, recall hits, forks, events), the write model is
**append-only**:

- **`append()` is the only write method.** No `update()`, no `replace()`, no `delete()` on
  individual records.
- **"This changed" is a new fact.** A turn being recalled is a new `turn_recall` row, not an
  UPDATE on the turn.
- **Mutation is admin-only.** `prune()`, `clear()`, and `vacuum()` live on `TurnAdmin`, not
  `TurnWriter`. Bulk deletion is a maintenance operation, not a regular write.
- **Materialized views are derived, not stored.** `conversationStats()` computes from the log,
   not from a summary table that needs updating.

### Why

- **Rewind** — you can replay to any point because nothing was overwritten.
- **Audit** — every mutation is a first-class record.
- **Fork** — a conversation fork is just "start appending to a new stream with a parent pointer."
- **No lost updates** — concurrent append to a log is safe; concurrent UPDATE to a row is not.

### Exception

The main checkpoint store (`src/store/sqlite.ts`) uses CRUD because checkpoints are **mutable
state** (a checkpoint is updated when its dedup status changes). The append-only rule applies
only to **provenance stores** (turns, recall, events, forks) — stores that record *what happened*,
not stores that record *what is*.

---

## 6. Ledger Protocol (Host ↔ Store)

The store is a **ledger** — it records facts and answers queries. It never initiates.

```
HOST (pi / TUI / API gateway)
  │
  │  appendTurn(entry)        ← host pushes a fact
  │  appendRecall(entry)      ← host pushes a fact
  │
  ▼
STORE (src/store/turns/)
  │
  │  query(filter)             ← host pulls a view
  │  conversationStats(id)     ← host pulls a view
  │  prune(policy)             ← host pulls a report
  │
  ▼
HOST decides what to do with it
```

### Rules

1. **The store has zero subscription types.** No `on('write', …)`, no `EventEmitter`, no
   callbacks, no observers.
2. **The store has zero outbound calls.** It never calls into the host, pi, or any extension.
3. **The store is a query engine.** Given a filter, it returns data. Given a policy, it returns
   a report. The host decides whether to act on it.
4. **Non-fatal is the store's job.** Every store method wraps its own errors and never throws
   into the host. A write failure logs locally and returns; a query failure returns an empty
   result.

---

## 7. Feature Flag Protocol

Every new capability ships behind a feature flag, default ON.

### Rules

1. **Default ON.** A feature that's off by default is a feature that doesn't ship. The flag exists
   for opt-out (A/B comparison, rollback), not opt-in.
2. **Env-overridable.** `MEGACOMPACT_<FLAG_NAME>=0` disables the feature. No other mechanism.
3. **Flag-OFF = byte-identical to pre-sprint.** When the flag is off, the code path is exactly
   what it was before the sprint landed. This is regression-tested.
4. **One flag per sprint.** No compound flags (`FEATURE_A_AND_B`). If two capabilities need
   independent control, they get independent flags.
5. **Flag lifecycle:**
   - **Sprint N:** flag introduced, default ON, guarded adapter edits.
   - **Sprint N+1:** flag still present, legacy path still tested.
   - **Sprint N+2:** flag removed, legacy path deleted. Two-release grace period.

### Where flags live

```ts
// src/config.ts — the single source of truth
export const TURNS_DB_ENABLED = envBool("MEGACOMPACT_TURNS_DB", true);
export const TURNS_RETENTION_DAYS = envNum("MEGACOMPACT_TURNS_RETENTION_DAYS", 30);
```

Never inline `process.env` checks in logic files. Always go through `src/config.ts`.

---

## 8. Structured Logging

Every store operation that matters (write, prune, migrate, error) logs a structured event.

### Format

```json
{"ts":"2026-07-29T12:00:00Z","event":"turn_recorded","conversationId":"abc","turnId":"t1","turnIndex":5}
```

### Rules

1. **Every event is a single JSON line** in `events.log` (append-only).
2. **Every event has `ts` and `event` fields.** No exceptions.
3. **Failures are events too.** `turn_record_failed` with the error message.
4. **No `console.log` in `src/`.** Production logging goes through `src/monitoring.ts`
   (`logDecision`). `console.log` is only for `extensions/` debug paths.
5. **Events are for observability, not control flow.** The store never reads `events.log` to
   make decisions. The dashboard reads it for display only.

### Event naming convention

| Pattern | Meaning | Example |
|---|---|---|
| `*_recorded` | A fact was appended | `turn_recorded`, `recall_recorded` |
| `*_pruned` | Data was removed | `turns_pruned`, `recall_pruned` |
| `*_failed` | An operation failed | `turn_record_failed`, `migration_failed` |
| `*_completed` | A bulk operation finished | `migration_completed`, `vacuum_completed` |
| `*_skipped` | An operation was intentionally skipped | `raptor_build_skipped` |

---

## 9. Sprint Gating (Release Criteria)

Every sub-sprint (S49A, S49B, S49C, …) must pass the **full gate** before committing:

```bash
npm run build                                          # tsc clean
npm test                                               # all tests
npm run lint                                           # tsc --noEmit + guardrails-scan + semantic-scan
python3 scripts/regression_check.py --all              # Four Laws / scope / secrets
```

### Additional per-sprint gates

| Gate | When | What |
|---|---|---|
| **Contract review** | Before any impl code | Types file reviewed + approved |
| **Compliance suite** | After impl | Shared test suite passes for all backends |
| **Capability check** | After adapter wiring | Dashboard gets reader only; compaction gets writer only |
| **Append-only check** | After store impl | `grep -r "UPDATE" src/store/turns/` returns nothing (except migrations) |
| **Reuse check** | After any `src/` edit | `grep -r "@earendil-works\|extensions/" src/store/turns/` returns nothing |
| **File-size check** | At each gate | No `.ts` file exceeds hard limits |
| **Flag-off check** | After adapter wiring | `MEGACOMPACT_TURNS_DB=0 npm test` green |

---

## 10. Non-Fatal Store Operations

Every store write is best-effort. A failure logs and never breaks the agent loop, the recall
path, or compaction.

### Pattern

```ts
try {
  store.asWriter().appendTurn(entry);
} catch (err) {
  // Non-fatal: log structured event, continue
  logDecision(stateDir, "turn_record_failed", { error: String(err), conversationId: entry.conversationId });
}
```

### Rules

1. **Every store call in `extensions/` is wrapped in try/catch.** The catch logs a structured
   event and continues. The store is not the source of truth for the agent loop — the agent loop
   is.
2. **Store calls in `src/` may throw.** The `src/` layer is pi-agnostic and does not decide
   error policy. The `extensions/` adapter decides whether to swallow or propagate.
3. **Read failures return empty.** A failed `query()` returns `[]`. A failed `conversationStats()`
   returns zeroed stats. The dashboard shows an empty state, not an error screen.

---

## 11. Migration Protocol

When moving data between stores (main-db → turns.db, future restructures):

1. **Copy-then-drop, inside a transaction.** `withTx` wraps the entire operation. A crash
   mid-copy rolls back; the marker is unset; migration retries on next open.
2. **Idempotent.** A marker row (`turns_meta.migrated_from_main = 1`) prevents re-copy.
3. **Non-destructive for one release.** Legacy tables are kept in the schema (not dropped)
   until the next release. Downgrading never loses data.
4. **Reversible via flag.** `MEGACOMPACT_TURNS_DB=0` routes writers to the legacy path. The new
   DB is additive; deleting it + flag OFF restores the pre-migration state.
5. **Tested with real data.** The migration test seeds a real main-db with S48 rows, runs the
   migration, and asserts row count + contents match.

---

## 12. File-Size Violations (Current Overages)

These files exceed the 500-line hard limit and should be split in the next sprint that
touches them:

| File | Lines | Proposed split |
|---|---|---|
| `extensions/mega-events/agent-handlers.ts` | 681 | Extract turn-recall writer adapter → `turn-adapter.ts` |
| `src/recall.ts` | 558 | Extract `formatRecallBlock` → `recall-format.ts` |
| `src/vectorStore.ts` | 506 | Extract `searchHits` → `vector-search-hits.ts` |
| `extensions/dashboard-server/html.ts` | 465 | Extract tab templates → `html-tabs.ts` |
| `extensions/dashboard-server/api-contracts/infrastructure.ts` | 465 | Extract validation → `contracts-validation.ts` |
| `extensions/dashboard-server/api-contracts/endpoints.ts` | 453 | Split by domain → `endpoints-turns.ts`, `endpoints-memory.ts` |
| `extensions/mega-events/context-handler.ts` | 440 | Extract memory adapter → `memory-adapter.ts` |
| `src/store/sqlite/schema.ts` | 408 | Extract turn tables → S49 migration handles this |
| `extensions/mega-pipeline/compact.ts` | 388 | Extract boundary logic → `compact-boundary.ts` |
| `extensions/dashboard-server/api-contracts/snapshot.ts` | 386 | Extract snapshot builders → `snapshot-builders.ts` |

---

## 13. Revision History

| Date | Version | Change |
|---|---|---|
| 2026-07-29 | 1.0 | Initial codification from CLAUDE.md + spec conventions + agent session decisions |
