# S48 — Per-Turn Vector Tracking + Conversation Branching

**Status:** ✅ CORE SHIPPED (2026-07-28, raptor-promotion branch) — `turns` + `turn_recall` + `conversation_branches` tables, `turn_end` writer, recall-provenance writer, `forkConversation` primitive. 7 unit tests.

---

## Problem

The vector store had no per-turn record. `currentTurn` lived in `MegaRuntime` (reset per session, never persisted), recall provenance was log-only (`events.log`, timestamp-keyed), and a "conversation" spanning pi session resumes had no relational handle. This blocked:

- **Per-turn memory quality** — "which turns had a recall miss?" was unanswerable.
- **Per-conversation memories** — `memories.source_turn` existed but referenced an integer with no row to join.
- **Fork / recall-to-point-in-time** — no way to start a new conversation that inherits another's context state at turn N.

## What shipped (core)

Three new tables (all additive — `CREATE TABLE IF NOT EXISTS`, plus `ensureColumn` migrations for legacy DBs):

### `turns`
One row per `turn_end`. The relational spine.

| column | meaning |
| ------ | ------- |
| `id` (PK) | global turn id |
| `conversation_id` | groups turns across resumes (`/clear` → new root) |
| `session_id` + `turn_index` | per-session turn (UNIQUE pair) |
| `role` | the turn's last role (`user`/`assistant`/`tool`) |
| `started_at` / `ended_at` | timing |
| `ctx_tokens` / `ctx_percent` | `runtime.lastCtxTokens` / `lastCtxPercent` snapshot |
| `pressure_band` | `low`/`mid`/`high`/`critical` |
| `model_id` | model used |
| `epoch_id` | FK `checkpoint_epochs` (set when a compact closes this turn's epoch) |

### `turn_recall`
Recall provenance — which checkpoints/cluster summaries were injected at a turn.

| column | meaning |
| ------ | ------- |
| `turn_id` (FK) | the turn that received this recall |
| `checkpoint_id` | the injected checkpoint OR raptor node id |
| `score` | cosine relevance |
| `source` | `flat` / `raptor` / `cross-repo` / `memory` |
| `raptor_level` | set for RAPTOR cluster hits |

### `conversation_branches`
Fork registry. A row per fork: `(child_conversation_id, parent_conversation_id, fork_turn_id, created_at)`.

### `SessionState` extension
Added `conversationId` + `lastTurnId` to `SessionState` (both optional; legacy files/rows get `undefined`/NULL). Persisted in the `session_state` table via two new columns. `ensureConversationId()` resolves-or-generates-per-session.

### Write points
- **`turn_end` handler** (`extensions/mega-events/agent-handlers.ts`): writes one `turns` row with the cached metrics. Best-effort + non-fatal.
- **`doRecall`** (`extensions/mega-pipeline/recall.ts`): after a recall resolves `toInject`, writes `turn_recall` rows linking the turn to each injected checkpoint with its source path + score. Best-effort + non-fatal.

### `forkConversation(parentConvId, forkTurnId)`
Creates a new `conversation_id`, records the branch lineage, and **returns the parent's recall set at `forkTurnId`** (the `checkpoint_id`s + scores that were injected) so the caller can seed the forked session's `injectedCheckpointIds` with exactly that context. This is a **recall-fork**, not a live-window replay — see the explicit non-goal below.

## What's NOT shipped (deferred — the "rest" of per-turn conversations)

### 1. Live-window replay (true point-in-time rewind)
A fork today inherits the *memory state* (which checkpoints were injected) but NOT the exact live message window. True rewind ("load conversation X exactly as it was at turn 7, live messages and all") requires snapshotting the message log per turn — expensive, and `raw_transcript` already stores messages (not duplicated here). If needed later: a `turn_windows` table storing a compressed snapshot of `ctx.sessionManager.getEntries()` per turn, behind a flag (default off — most use cases want recall-fork, not token replay).

### 2. `raw_transcript.turn_index` population
The column is added (migration landed) but `appendRawTranscript` doesn't yet set it. Wire `runtime.currentTurn` through the context-handler append path. Small follow-up — the schema is ready.

### 3. Epoch linking (`turns.epoch_id`)
The `epoch_id` FK exists but `turn_end` doesn't set it (the compact that *closes* an epoch happens at a different lifecycle point than turn_end). Wire when a compact commits: stamp the turns in the closed epoch's seq range with the `epoch_id`. Enables "show me turns that were compacted together."

### 4. Dashboard / query surface
No UI yet for per-turn or per-conversation views. The data is queryable:
- Per-turn metrics: `SELECT * FROM turns WHERE conversation_id = ? ORDER BY turn_index`
- Per-turn recall: `SELECT * FROM turn_recall WHERE turn_id = ?`
- Cache-hit rate per turn: join `turn_recall` against `session_state.injected_checkpoint_ids` (already-injected = cache hit)
- Conversation fork tree: `SELECT * FROM conversation_branches WHERE parent_conversation_id = ?`

### 5. Recall-to-point command (user-facing fork)
`forkConversation` is a primitive, not yet a `/mega-fork <conv> <turn>` command. The command would: call `forkConversation`, create a new pi session, seed its `injectedCheckpointIds` with the returned recall set, and run a fresh recall against the same query. The seed-set ensures the forked session starts with the parent's context at the fork point.

## Design decisions

- **Embeddings live on `context_chunks` / `raptor_nodes`, NOT per-turn.** `turns`/`turn_recall` store *provenance* (which embeddings served which turn), not the vectors. Per-turn embedding storage would be a 512-float blowout with no query benefit.
- **Conversation = a group of sessions.** `conversationId` survives `/clear`-less resumes (inherited via `session_state`); `/clear` generates a new root. A fork carries `parent_conversation_id`.
- **Recall-fork, not token-replay.** A fork reconstructs the *memory state* (injected checkpoints) at a turn, not the exact tokens. This is the cheap, high-value interpretation — see non-goal #1 for the expensive one.
- **All best-effort + non-fatal.** Turn/recall writes are wrapped in try/catch — a tracking failure never breaks the agent loop or the recall path.

## Acceptance (met)

`src/store/sqlite/turns.test.ts` — 7 tests: recordTurn upsert + getTurn, recordTurnRecall + listTurnRecall, listConversationTurns, ensureConversationId stability across resumes, forkConversation lineage + replay-set, clearTurns cascade, conversationId SessionState round-trip.
