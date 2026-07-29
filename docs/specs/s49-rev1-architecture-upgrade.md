# S49 Program Spec — REVISION 1 (2026-07-29)

**Parent:** `docs/specs/s49-program-per-turn-memory-platform.md` (original, 2026-07-28)
**Reason:** The original spec's reuse architecture (§3) was a **dependency rule** ("no pi imports in `src/`") — necessary but not sufficient for a framework we'll embed in future products. This revision upgrades it to a **contract-first, event-sourced, capability-gated kernel** that any host can embed without re-learning the schema or re-implementing retention.

**What changed and why:**

| Section | Original (v0) | Revision 1 | Why |
|---|---|---|---|
| §3 Reuse architecture | Dependency rule: `src/` has no pi imports | **Contract-first kernel**: `TurnStore` interface is the source of truth; `node:sqlite` is one implementation. Hosts program against the interface, not the schema. | A dependency rule doesn't make something reusable — a contract does. Future hosts (TUI, API gateway, test harness) shouldn't need to learn SQL. |
| §3 Store semantics | CRUD rows (`INSERT` + later `UPDATE`) | **Append-only event log**. A "turn was recalled" is a new fact, not an UPDATE to the turn row. Materialized views project current state from the log. | Gives rewind, audit, and fork for free — no overwritten state to lose. An `epoch_id` on each append enables point-in-time reconstruction. |
| §3 Capability model | Single store handle (reader + writer + admin) | **Capability-gated handles**: `store.asReader()`, `store.asWriter()`, `store.asAdmin()`. Each consumer gets only what it needs. | Dashboard gets reader, compaction gets writer, prune gets admin. Survives multi-process and multi-tenant. |
| §3 Host protocol | "Store never calls back into pi" (prose) | **Ledger handshake**: host PUSHES facts (`append`), PULLS views (`query`). Store never initiates. Documented as a protocol, not a suggestion. | A prose rule is breakable. A protocol is testable — the store's public surface has zero subscription/emitter/callback types. |
| §4 Storage decision | `turns.db = node:sqlite` (only option) | **`TurnStore` interface is primary; `SqliteTurnStore` is the reference implementation.** In-memory store ships for tests. Future: IndexedDB, Postgres, CRDT-sqlite. | The schema is an implementation detail of one backend. The contract is what future projects embed. |
| §4 Schema | Tables defined inline in spec | **Schema is owned by the implementation, not the spec.** The spec defines the *types* (`TurnEntry`, `TurnFilter`, `RetentionPolicy`); the SQL is private to `SqliteTurnStore`. | If the contract is the source of truth, the SQL is a private detail — changing indexes or adding columns shouldn't require a spec amendment. |
| §3 StoreSnapshot | Not present | **`StoreSnapshot` type** for backup/migration. `store.checkpoint()` → `StoreSnapshot`; `store.restore(from)`. | This is how you move data between hosts, back up before a prune, or seed a test. Without it, migration is ad-hoc SQL scripts. |
| S49 spec file layout | `schema.ts`, `connection.ts`, `turnStore.ts` as separate files | **Contract module** (`types.ts` — the `TurnStore` interface + all domain types) ships FIRST. Implementation files import from it. Hosts import only `types.ts` + `index.ts` (factory). | If the contract is first, every implementation decision is checked against it. If it's last, it's documentation after the fact. |

**What did NOT change:**

- Program sprint structure (S49–S52) and dependencies
- Safety protocols (PREVENT-PI-001–004, feature flags default ON, non-fatal)
- `node:sqlite` as the reference implementation (synchronous, in-process, WAL)
- Feature flag `TURNS_DB_ENABLED` / env `MEGACOMPACT_TURNS_DB`
- Migration strategy (copy-then-drop, idempotent, one-release rollback)
- "No new migration in later sprints" rule (schema.ts pre-creates future tables)

**Migration path from v0 specs:**

- `docs/specs/s49-program-per-turn-memory-platform.md` — add revision note header + link to this file; body unchanged (historical record)
- `docs/specs/s49-turn-db-foundation.md` — replace with the revision (contract-first layout)
- `docs/specs/s49-conversation-db-dashboard.md` — superseded by this program revision (was an earlier draft that didn't account for the program structure)
- `docs/specs/s50-per-turn-metrics-fork.md` — NEW, written from the contract-first shape
- `docs/specs/s51-auto-categorizing-wiki.md` — NEW (replaces S47 re-target, written against `TurnStore` reader)
- `docs/specs/s52-dashboard-management-rewind.md` — NEW, written against capability-gated handles
