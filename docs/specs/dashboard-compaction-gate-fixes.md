# Dashboard Compaction-Gate Fixes (blank tabs + memory/wiki seeding)

**Date:** 2026-07-31
**Priority:** P1 (user-reported: "why wiki is always blank", "the dashboards are blank", "how do you explain the session graph for an end user and how do they interact with the memories, we have to wait for a compaction?")
**Status:** SPEC — pending implementation. Blocked on the in-flight Track A/B/C workflow (agents are editing `memoryGraph.ts`, `schema.ts`, `context-handler.ts` — the exact files this spec touches). Implement immediately after the workflow lands + the gate is green.

---

## PROBLEM / MOTIVATION

A full audit of all 13 dashboard tabs found that the majority read from `context_chunks` (checkpoints), which are **only written during compaction** (`src/engine.ts:compactSession`). Compaction fires when context crosses the tier threshold (~50–70% of the window). For sessions that never cross the threshold, these tabs stay **permanently blank** — and the empty states don't explain why.

### Audit findings (per tab)

| Tab | Data source | Populates | Verdict |
|---|---|---|---|
| **TopicsTab (Wiki)** | `context_chunks` → k-means+TF-IDF | **10th compaction** (`WIKI_REBUILD_EVERY_N_COMPACTS=10`, `context-handler.ts:284`) | Always blank for most users. Empty state explains the gate but the gate is too high. |
| **MemoryMapTab** | `buildMemoryGraph()` reads checkpoints | 1st compaction | Empty state (`MemoryMapTab.tsx:319`) is "No memory data available." — **no explanation**. |
| **ReposTab** | `/api/indexes` (global vector index summary) | 1st compaction (no vectors until checkpoints exist) | Inherits the compaction gate. |
| **TurnsTab** | `turns` table (turns.db) | First turn (no compaction needed) | OK. |
| **MetricsTab** | `perf_samples` | First `turn_end` (`perf-handler.ts:104`) | OK — should NOT be blank. |
| **EventsTab** | `events.log` via SSE | First event | OK — should NOT be blank. |
| **CacheTab** | `perf_samples` + snapshot | Provider section from turn_end; dedup section needs compaction | Partial. |
| **OverviewTab** | `dashboard.json` + `/api/sessions` | Immediately (live runtime) | OK — should NOT be blank. |
| **SessionsTab** | `/api/sessions` + timeseries | First turn | OK. |
| **GameTab/Achievements** | `game_scores`/`achievements` | First `turn_end` (`agent-handlers.ts:325`) | OK. |
| **ConfigTab** | snapshot + game-state | Immediately | OK. |
| **MaintenanceTab** | db-stats + schema-health | Immediately | OK. |

### The three real problems

1. **Wiki (TopicsTab) is always blank.** The 10-compaction gate means a typical user never sees it. The empty state *does* explain (`TopicsTab.tsx:66`) but "check back after a few more compaction cycles" is useless when compactions may never happen in a session.
2. **MemoryMapTab empty state is uninformative.** `"No memory data available."` gives no hint that it fills after compaction — this is why users report "the dashboards are blank" with no understanding of why.
3. **No pre-compaction memory surface.** The turns DB (`turns.db`, S48) has real embeddings from turn 1, but the memory graph and wiki only consume `context_chunks` (checkpoints). Everything memory-related is gated on compaction.

## DECISIONS

### D1: Lower the wiki rebuild cadence + seed from live turns
- Lower `WIKI_REBUILD_EVERY_N_COMPACTS` default 10 → 3 (`src/config/turns.ts`). A user who compacts even once gets a topic model within 3 compactions instead of 10.
- **Seed an initial topic model from the turns DB** when no `context_chunks` exist yet. The turns DB has embeddings from turn 1 (S48). `buildTopicModel` currently reads only `context_chunks`; add a fallback path that reads from `turns` (or a union of both) so the wiki shows *something* before the 3rd compaction. Gated: only when `turnsDbEnabled` and the `context_chunks` count is below a floor (e.g. < 50).
- Config flag: `MEGACOMPACT_WIKI_SEED_FROM_TURNS` (default ON; OFF = byte-identical pre-change).

### D2: Rewrite the empty states to explain the gate
- **MemoryMapTab** (`MemoryMapTab.tsx:319`): replace `"No memory data available."` with a clear explanation: "Memories appear after your first compaction (~N% of context). The graph shows checkpoints (compaction summaries) linked by semantic similarity and time. Run a longer session or lower the compaction tier to see it sooner." Include the configured threshold % so the user knows the number.
- **ReposTab**: same treatment — "Repo memory appears after the first compaction."
- **TopicsTab**: keep the existing message but soften the cadence claim once D1 lands ("after every 3rd compaction" instead of 10th).

### D3: Stack the graph — turns preview + checkpoint view, with validation gates

**Decision (locked with user, 2026-07-31): STACK, don't replace.** The graph shows a turns-based preview pre-compaction and the checkpoint view post-compaction, with cross-checks so the preview never degrades the real view.

**Data-path reality (from schema audit):** the `turns` table (S48) has **no embedding column** — it stores metadata only (role, tokens, pressure, epoch_id). Embeddings live in `context_chunks.embedding_blob` (checkpoints), `embedding_cache` (content-hash keyed, populated by the A2 cache-striping work), and the PGlite HNSW index. So the turns preview cannot read embeddings from `turns` directly.

**Decision (locked with user, 2026-07-31): implement ALL THREE content sources, layered by availability.** Not one fallback — all three contribute, each with its own lifecycle, availability, and edge semantics. A turn progresses through them as a session matures:

- **Source A — `turns` structural nodes** (always available, turn 1, no content): each `turns` row becomes a node with metadata only (role, pressure_band, ctx_tokens, turn_index). **No embedding** → temporal edges only (sequential within a conversation), no semantic edges. This is the floor: the graph is *never* empty from turn 1, even with every other flag off.
- **Source B — `raw_transcript` content nodes** (when `dbMirror` ON, default OFF): joins `turns` to `raw_transcript` on `(session_id, turn_index)` to attach `content_bytes` + `role`. Content is embedded on demand via the TrigramEmbedder, cached in `embedding_cache` (content_hash keyed). Enables semantic edges between turn-content nodes.
- **Source C — `memories` content nodes** (when memory review runs): each `memories` row (with `source_turn` + `content`) becomes a node, embedded on demand + cached. Richer than turns (curated, categorized) but sparser (only reviewed memories).

Each source is independently flag-gated so the graph degrades gracefully: turn off `dbMirror` and you lose Source B semantic edges but keep Source A structure; turn off memory review and you lose Source C but keep A+B. The three sources are **unioned, not cascaded** — a turn that has both a `turns` row (Source A) and a `raw_transcript` row (Source B) renders as ONE node (the richest available source wins; see promotion/identity gates below).

**Stacking rules + validation gates (the core of this decision):**

1. **Source-badged nodes, not a blended soup.** Every node carries `nodeType: "checkpoint" | "turn" | "turn-content" | "memory"`. The UI renders them with distinct visual treatment (checkpoint = filled circle, turn = hollow, turn-content = hollow+ring, memory = diamond). The user sees *what kind of thing* they're looking at — no silent mixing of compaction summaries with raw turns.

2. **Checkpoint view is authoritative; turns view is additive.** When `context_chunks` is non-empty, checkpoint nodes are always rendered. Turn/memory preview nodes are rendered *in addition* (stacked), not as a replacement. The graph never hides real checkpoints behind preview noise.

3. **Promotion gate — turns graduate to checkpoints, they don't duplicate.** When a turn's `epoch_id` becomes non-null (the turn has been compacted into a checkpoint), the turn-preview node is **suppressed** in favor of its checkpoint node. Cross-check: `turns.epoch_id IS NOT NULL` → the checkpoint already represents this turn → drop the preview node to avoid double-counting. This is the key cross-check: a turn and its compaction summary never both render.

4. **Identity merge across sources A/B.** A `turns` row (Source A) and its matching `raw_transcript` row (Source B) share `(session_id, turn_index)`. They render as ONE node — the richest available source wins (B if dbMirror on + content present, else A). The node id is stable: `turn:<session_id>:<turn_index>`. This is the cross-source dedup: a turn never appears as both a structural node and a content node.

5. **Semantic-edge cross-check.** Edges are computed per-source-type (temporal edges within turns; temporal + semantic + raptor within checkpoints; cross-type semantic edges only above a *stricter* threshold, e.g. 0.85 vs 0.7 within-type). Cross-type edges (turn↔checkpoint) are allowed but gated tighter so a turn doesn't spuriously link to an unrelated checkpoint summary. **Semantic edges require an embedding** — Source A (structural-only) nodes get temporal edges only; Source B/C (content) nodes get semantic edges.

6. **Deduplication cross-check against `dedup_mirror`.** A turn-content node whose `content_hash` matches a `dedup_mirror` entry that has since been collapsed into a checkpoint is dropped (it's redundant — the checkpoint already represents that content). Mirrors the existing dedup semantics.

**Config flags (all default ON where the source exists, all flag-OFF = byte-identical pre-change):**
- `MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS` — include Source A structural turn nodes (default ON — no dependency on any other flag).
- `MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT` — include Source B content nodes (default ON, but only effective when `dbMirror` is ON — otherwise no-op, degrades to Source A).
- `MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES` — include Source C memory nodes (default ON, effective when memories exist).
- `MEGACOMPACT_MEMORY_GRAPH_CROSS_TYPE_THRESHOLD` — cosine floor for turn↔checkpoint edges (default 0.85).
- `MEGACOMPACT_MEMORY_GRAPH_WITHIN_TYPE_THRESHOLD` — cosine floor for within-type semantic edges (default 0.7).

**UI (MemoryMapTab):**
- Node shape encodes `nodeType` (checkpoint/turn/turn-content/memory).
- Legend adds the four node types alongside the existing edge-type legend.
- Empty state (when ALL sources are empty) → the D2 explanatory message.
- A small "X checkpoints · Y turns · Z turn-content · W memories" count in the toolbar so the user sees the stack composition, plus a per-source availability indicator (✓/✗ for dbMirror, memory review).

## FULL VALIDATION GATE

The graph builder runs a deterministic, ordered validation pipeline. Every gate is a pure function over the in-progress `{nodes, edges}` that returns `{ok, dropped, reason}`. Gates run in order; a failing gate logs a structured `graph_validation_gate` event (via `events.log`, dashboard-visible) and applies its defensive fix before the next gate sees the data. **The final graph is the only one the route ever serves** — no partial/invalid graph reaches the UI.

### Gate order (each builds on the previous's output)

**Gate 1 — Source availability reconciliation.** For each configured source, confirm the underlying table/column is readable and the gating flag allows it. If a source's table is missing or unreadable, mark its nodes as unavailable and emit `graph_source_unavailable { source, reason }`. This is non-fatal — the remaining sources still render. Catches: dbMirror OFF (Source B), turnsDbEnabled OFF (Source A), no memories written (Source C).

**Gate 2 — Node identity merge (Source A/B).** Assert that no `(session_id, turn_index)` pair appears as both a Source A structural node and a Source B content node. Merge them (richest wins, node id `turn:<session>:<idx>`). If a duplicate survives the merge, drop the poorer one + emit `graph_identity_leak { pair }`. Catches: a turn rendered twice because the A/B join was incomplete.

**Gate 3 — Promotion gate (turn → checkpoint).** For every turn node (A or B), check `turns.epoch_id IS NOT NULL`. If set, the turn has been compacted — suppress the turn node (its checkpoint already represents it). Cross-check: the checkpoint node for that epoch must exist in the node set; if it doesn't (orphaned epoch_id — the checkpoint write failed), KEEP the turn node + emit `graph_orphaned_epoch { turnId, epochId }` rather than rendering nothing. Catches: a turn and its compaction summary both rendering (double-count).

**Gate 4 — No-doubles invariant.** Assert no node id appears more than once in the final node set, and no (sessionId, turnIndex) is claimed by both a turn node and a checkpoint node. If violated, drop the lower-priority duplicate (priority order: checkpoint > turn-content > memory > turn-structural) + emit `graph_node_double { id }`. This is the catch-all after gates 2+3 — if they missed, this one fires. Catches: any residual duplication.

**Gate 5 — Edge integrity.** For every edge, assert both endpoint node ids exist in the final node set (post-gates 2-4). Drop dangling edges + emit `graph_dangling_edge { source, target }`. Assert edge type is legal for the endpoint node types (e.g. a `raptor_parent` edge must touch a checkpoint node; a temporal edge must touch a turn or checkpoint node). Drop illegal-typed edges + emit `graph_edge_type_violation { edge, reason }`. Catches: edges pointing at nodes that gates 2-4 dropped.

**Gate 6 — Edge threshold enforcement.** For every semantic edge, confirm its cosine score meets the threshold for its type pair: within-type ≥ `WITHIN_TYPE_THRESHOLD` (0.7); cross-type ≥ `CROSS_TYPE_THRESHOLD` (0.85). Drop sub-threshold edges + emit `graph_edge_below_threshold { source, target, score, typePair }`. Assert Source A (structural-only, no embedding) nodes have ZERO semantic edges (only temporal) — if any semantic edge touches a structural node, the embedding was misattributed; drop it + emit `graph_structural_semantic_edge { nodeId }`. Catches: spurious cross-type links, embedding misattribution.

**Gate 7 — Dedup_mirror cross-check.** For every turn-content node (Source B), look up its `content_hash` in `dedup_mirror`. If the entry is collapsed (ref_count > 1 or marked removed) AND a checkpoint node represents the same content, drop the turn-content node + emit `graph_dedup_redundant { contentHash }`. Catches: a turn whose content was already folded into a checkpoint via dedup.

**Gate 8 — Snapshot consistency (read isolation).** The builder reads all sources in a single `db.prepare(...)` transaction (or records a `builtAt` timestamp and rejects rows written after it) so a concurrent compaction can't produce a half-promoted graph (some turns promoted, others not). If the read spans a compaction boundary, emit `graph_concurrent_compaction { builtAt }` and re-run. Catches: torn reads during compaction.

**Gate 9 — Regression invariant (the most important).** Compare the new node count against the previous build's node count for the same session. If the count DROPPED when a source became MORE available (e.g. dbMirror just turned ON, adding Source B, but total nodes fell), that's a regression — a gate wrongly dropped nodes. Emit `graph_node_regression { prev, curr, sourcesChanged }` and re-run the build with the suspect gate disabled. Catches: a validation gate that's too aggressive and silently loses user data.

### Validation-gate contract (the API)

`buildMemoryGraph` returns a `MemoryGraph` with a `validation` field the route surfaces to `/api/memory-map`:

```typescript
interface GraphValidationReport {
  gatesRun: number;          // 9
  gatesPassed: number;
  dropped: { nodes: number; edges: number };
  warnings: Array<{ gate: string; code: string; count: number }>;
  sources: { checkpoint: number; turn: number; turnContent: number; memory: number };
  builtAt: number;           // timestamp for gate 8
}
```

The dashboard renders a small "graph health" indicator from this (green = all gates passed + no warnings; yellow = warnings emitted but graph served; red = a gate failed critically and the graph is degraded). This makes the validation **visible to the end user**, not just logged — they can see if their graph is trustworthy.

### Tests (gate-level, must exist)

Each gate gets a dedicated unit test that constructs a deliberately-broken graph and asserts the gate fixes it:
- Gate 2: inject a duplicate (session,turn) pair → assert merge + 1 `graph_identity_leak`.
- Gate 3: inject a turn with `epoch_id` set + matching checkpoint → assert turn suppressed; inject orphaned epoch (no checkpoint) → assert turn kept + `graph_orphaned_epoch`.
- Gate 4: inject a doubled node id → assert lower-priority dropped + `graph_node_double`.
- Gate 5: inject an edge to a non-existent node → assert dropped + `graph_dangling_edge`; inject a `raptor_parent` edge touching a turn node → assert dropped + `graph_edge_type_violation`.
- Gate 6: inject a 0.75 cross-type edge (below 0.85) → assert dropped; inject a semantic edge on a structural node → assert dropped + `graph_structural_semantic_edge`.
- Gate 7: inject a turn-content node whose hash is in dedup_mirror (collapsed) + a checkpoint for it → assert turn-content dropped.
- Gate 9: simulate a build where node count drops when a source is added → assert `graph_node_regression` + re-run.

## FILES (blocked on workflow)

- `src/config/turns.ts` — `WIKI_REBUILD_EVERY_N_COMPACTS` default 10 → 3; add `WIKI_SEED_FROM_TURNS`.
- `src/topics/cluster.ts` or `src/wiki.ts` — seed `buildTopicModel` from `turns`+`raw_transcript`/`memories` when `context_chunks` is below floor.
- `extensions/mega-events/context-handler.ts:273` — wiki rebuild trigger: also fire the seed path.
- `src/memoryGraph.ts` — `buildMemoryGraph` stacked node set: checkpoints (existing, from `context_chunks`) + Source A structural turn nodes (from `turns`) + Source B content nodes (join `turns`↔`raw_transcript`, embed on demand) + Source C memory nodes (from `memories`); the 9-gate validation pipeline (Gate 1-9); returns `GraphValidationReport`.
- `extensions/dashboard-server/routes-memory-map.ts` — surface the `validation` field from `buildMemoryGraph` into the `/api/memory-map` response.
- `extensions/dashboard-server/api-contracts/memory-map.ts` — add `validation: GraphValidationReport` to `MemoryMapResponse`.
- `extensions/dashboard-client/src/tabs/MemoryMapTab.tsx:319` — rewrite empty state; node-shape encoding for the four `nodeType` values; updated legend + per-source count badge + availability indicators; graph-health indicator (green/yellow/red) from the validation report.
- `extensions/dashboard-client/src/tabs/ReposTab.tsx` — rewrite empty state.
- `extensions/dashboard-client/src/tabs/TopicsTab.tsx:66` — update cadence claim (10 → 3).
- `extensions/mega-config.ts` — add `wikiSeedFromTurns`, `memoryGraphSeedTurns`, `memoryGraphSeedTurnContent`, `memoryGraphSeedMemories`, `memoryGraphCrossTypeThreshold`, `memoryGraphWithinTypeThreshold` flags + defaults.
- `src/store/sqlite/embedding-cache.ts` (or the A2 `embedding_cache` table accessor) — `getOrComputeEmbedding(contentHash, content)` helper used by Source B/C, caching in `embedding_cache` to avoid re-embedding on every graph build.

## SAFETY / GUARDRAILS

- Feature flags default ON, env-overridable OFF, flag-OFF = byte-identical pre-change (project convention).
- Non-fatal: the seed path is best-effort; a failure to read the turns DB logs and falls back to the empty state (never breaks the dashboard).
- PREVENT-PI-004: all reads are local SQLite; no network.
- PREVENT-002: parameterized queries only for any new turns-DB reads.
- Does NOT duplicate S48's `turns` table — reads only, appends nothing.

## VERIFY

- `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
- **Three-source availability matrix (integration test):** for each combination of source flags, assert the expected node types appear:
  - All flags OFF → checkpoint-only graph (byte-identical pre-change).
  - `SEED_TURNS` ON only → checkpoint + structural turn nodes (no semantic edges on turns).
  - `SEED_TURNS` + `SEED_TURN_CONTENT` ON, dbMirror OFF → same as above (Source B no-ops; emit `graph_source_unavailable` for B).
  - `SEED_TURNS` + `SEED_TURN_CONTENT` ON, dbMirror ON → checkpoint + turn-content nodes (semantic edges on turns).
  - All three ON, memories written → checkpoint + turn-content + memory nodes.
- Manual: fresh session (no compactions) → Memory Map shows structural turn nodes (hollow) → enable dbMirror → turn-content nodes (hollow+ring) with semantic edges appear → after 1st compaction → checkpoint nodes (filled) appear; turn nodes whose `epoch_id` is now set are suppressed (no doubles) → after 3rd compaction → Topics/Wiki shows topic model.
- **Gate-level tests (each gate, per the validation-gate contract):**
  - Gate 2: inject duplicate (session,turn) pair → assert merge + 1 `graph_identity_leak`.
  - Gate 3: turn with `epoch_id` + matching checkpoint → turn suppressed; orphaned epoch (no checkpoint) → turn kept + `graph_orphaned_epoch`.
  - Gate 4: doubled node id → lower-priority dropped + `graph_node_double`.
  - Gate 5: edge to non-existent node → dropped + `graph_dangling_edge`; `raptor_parent` edge on a turn → dropped + `graph_edge_type_violation`.
  - Gate 6: 0.75 cross-type edge → dropped; semantic edge on structural node → dropped + `graph_structural_semantic_edge`.
  - Gate 7: turn-content node whose hash is collapsed in dedup_mirror + checkpoint exists → dropped + `graph_dedup_redundant`.
  - Gate 9: node count drops when a source is added → `graph_node_regression` + re-run.
  - Graph-health indicator: a graph with any warning → yellow; a critically-failed gate → red; all clean → green.
- Flag-OFF parity: `SEED_TURNS=false SEED_TURN_CONTENT=false SEED_MEMORIES=false WIKI_SEED_FROM_TURNS=false` → behavior byte-identical to pre-change (blank until compaction, cadence 10).

## OPEN QUESTION (resolved)

~~D3 seed memory graph from turns — safer to keep checkpoint-only?~~ **Resolved 2026-07-31: STACK, with validation gates.** The graph stacks turn-preview + memory nodes on top of the checkpoint view, source-badged so the user sees what they're looking at, with a promotion gate (turns compacted into checkpoints are suppressed), a post-build validation invariant (no doubled node ids), and stricter cross-type edge thresholds. The preview never degrades the checkpoint view — it's additive, cross-checked, and the checkpoint is always authoritative.
