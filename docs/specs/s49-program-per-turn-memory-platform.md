# Per-Turn Memory Platform — Multi-Sprint Program (S49–S52)

**Date:** 2026-07-28 (revision 1: 2026-07-29)
**Owner:** pi-mega-compact
**Status:** Program plan → S49 spec implement-ready
**Revision record:** `docs/specs/s49-rev1-architecture-upgrade.md` — v0 dependency rule upgraded to v1 contract-first, event-sourced, capability-gated kernel.
**Reuse target:** this work is designed to be lifted into other hosts (our own TUI, our API gateway). All host-agnostic logic lives in `src/` behind narrow store interfaces; pi-specific wiring stays in `extensions/`.

---

## 1. Vision

Evolve pi-mega-compact from "a compaction engine with checkpoints" into a **per-turn memory platform**: an isolated, queryable, rewindable, auto-categorized store of per-turn + per-conversation provenance, with a management dashboard. The platform is **host-agnostic at its core** — any TUI or API gateway can embed the same `src/` modules and get identical behavior.

## 2. Why a program (not one sprint)

Four independent capability axes, each with its own acceptance + rollback:

| Sprint | Capability | Depends on | Reuse surface |
| ------ | ---------- | ---------- | ------------- |
| **S49 — Turn-DB Foundation** | Isolated `turns.db` (node:sqlite), clean `TurnStore` interface, migration from main db, retention/pruning. | none | `src/store/turns/` — embeddable store |
| **S50 — Per-Turn Metrics + Fork** | `raw_transcript.turn_index`, `turns.epoch_id`, `/mega-fork` primitive, per-turn + per-conversation metric rollups. | S49 | `src/metrics/turns.ts`, `src/fork.ts` |
| **S51 — Auto-Categorizing Wiki (full S47)** | k-means topic clustering over real embeddings, TF-IDF labels, extractive wiki pages, Wiki tab. | S49 (store iface) | `src/topics/`, `src/wiki.ts` |
| **S52 — Dashboard Management + Rewind** | Turns tab (metrics + prune), Wiki tab polish, fork action, rewind-intent handshake to the host. | S50, S51 | `src/intent.ts` + host adapters |

## 3. The reuse architecture (the load-bearing decision)

Everything reuse-grade obeys the project's `src/` pi-agnostic invariant, tightened:

```
src/
  store/turns/            # S49 — host-agnostic turn store (node:sqlite)
    schema.ts             #   CREATE TABLE for turns/turn_recall/conversation_branches/pending_fork/topics
    turnStore.ts          #   TurnStore interface + createTurnStore(stateDir) factory
    migrations.ts         #   move turn tables out of the host's main sqlite.db (idempotent)
    retention.ts          #   pruneTurns / pruneRecall / vacuum
  metrics/turns.ts        # S50 — per-turn + per-conversation rollups (pure over TurnStore)
  fork.ts                 # S50 — forkConversation + seedInjectedSet (host-agnostic)
  topics/                 # S51 — clustering + labels (pure math, no store dependency)
  wiki.ts                 # S51 — extractive wiki page generation (pure over a TopicStore iface)
  intent.ts               # S52 — rewind-intent write/consume (host-agnostic queue)

extensions/               # pi-specific wiring ONLY (not reused)
  mega-turn-cmds.ts       #   /mega-fork, /mega-turns commands
  dashboard-server/…      #   HTTP endpoints (thin adapters over src/)
  dashboard-client/…      #   React tabs
```

**Reuse contract:** a host (own TUI / API gateway) does:

```ts
import { createTurnStore } from "pi-mega-compact/src/store/turns/turnStore.js";
import { forkConversation } from "pi-mega-compact/src/fork.js";
import { buildTopicModel } from "pi-mega-compact/src/topics/cluster.js";

const store = createTurnStore({ stateDir });   // one call, own sqlite file
store.recordTurn({ … });
const { conversationId, recalled } = forkConversation(store, parentConvId, turnId);
```

No pi imports, no `ExtensionAPI`, no `@earendil-works/*` types in any `src/store/turns|topics|wiki|fork|metrics|intent` module. The only host-supplied inputs are `stateDir` and (for recall seeding) the injected-checkpoint set — both plain values.

## 4. Storage decision (final)

- **`turns.db` = `node:sqlite`** (synchronous source of truth). Rationale (locked in prior review): turn tracking is on the hot sync loop (turn_end, recall); PGlite is async-only and would force an async rewrite of deliberately-sync paths. Turn data is **relational provenance** (exact lookups), not vector NN — no pgvector need. This matches the project's "node:sqlite authoritative, PGlite = async redundant vector index only" split.
- **Isolated file** from the main `sqlite.db`: separate WAL, separate connection cache, separate schema init. A turn-DB failure can never touch the memory store. Retention (`DELETE` + `VACUUM`) runs on `turns.db` only.
- **One schema module** (`src/store/turns/schema.ts`) owns ALL turn-side tables, including S51's `topics`/`memory_topics` and S52's `pending_fork` — so the whole platform is one embeddable file-set.

## 5. What already exists (don't rebuild)

- `turns` / `turn_recall` / `conversation_branches` tables + `recordTurn`/`recordTurnRecall`/`forkConversation`/`ensureConversationId` (S48 core, shipped) — **moved** into the new store, not rewritten.
- `session_heartbeats` (S39) — liveness signal, already present; S52 reuse.
- k-means (`src/dedup/raptor/kmeans.ts`: `kmeanspp`, `cosineDistance`, `meanVector`) — reused by S51 clustering.
- Extractive summarizer (`src/dedup/raptor/summarizer.ts`) — reused by S51 wiki summaries.
- Dashboard tab/route scaffold (lazy `React.lazy` tabs, `routes-*.ts` handler split) — reused by S51/S52.

## 6. Cross-cutting guardrails

Every sprint obeys:

- **PREVENT-PI-001/002**: turn/topic/wiki are read-only over memory; never touch drop ranges or tool-pair boundaries.
- **PREVENT-PI-003**: no `role:"system"` injection; recall stays via `before_agent_start` prepend.
- **PREVENT-PI-004**: zero network. Dashboard is the existing audited localhost exception (`guardrails-allow` annotated). S51 clustering is pure local math — **no LLM, no Ollama** (per S47 re-plan).
- **Feature flags default ON**, env-overridable to OFF; flag-OFF = byte-identical to pre-sprint behavior (regression-tested).
- **No silent failures**: every write/rollupp/cluster logs structured events; failures are non-fatal + logged, never swallowed.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

## 7. Sprint specs

- **S49** → `docs/specs/s49-turn-db-foundation.md` (**revision 1** — contract-first, event-sourced, capability-gated; replaces v0 CRUD design)
- **S50** → `docs/specs/s50-per-turn-metrics-fork.md` (written from the contract-first shape)
- **S51** → `docs/specs/s51-auto-categorizing-wiki.md` (re-targeted onto S49 store, replaces S47)
- **S52** → `docs/specs/s52-dashboard-management-rewind.md` (written against capability-gated handles)

Engineering practices for all sprints: `docs/ENGINEERING_PRACTICES.md`
