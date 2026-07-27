# S46 — Visual Memory Map Dashboard

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S40 (importance scoring), S42 (RAPTOR multi-level retrieval), `extensions/dashboard-server/server.ts`, `extensions/dashboard-client/`, `src/store/sqlite.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## RE-PLAN 2026-07-25

**Why this re-plan exists.** A prior audit of S46 found that the graph data is **real** but three elements were **synthetic / invented**:

- **Real (kept):** nodes are real `context_chunks` rows; **temporal edges** connect real sequential checkpoints; **topical edges** reflect real RAPTOR cluster membership; layout uses real dagre/elkjs.
- **Defect 1 — Causal edges (DELETED).** The old spec scanned summary text for phrases ("as we decided", "from the previous", "based on", "following up"), extracted a referenced topic, guessed a target checkpoint, and emitted a `weight = 0.8` edge. Every such edge was a potential false positive with no ground truth. **Causal edges are DELETED entirely.** The graph shows only **temporal** and **topical** edges — real relationships, not guessed ones.
- **Defect 2 — Keyword node-type classification (DELETED).** The old spec matched keywords ("decision"/"decided"/"chose" → decision; "error"/"exception"/"failed" → error; default → message). Keyword matching misclassifies quoted text (e.g., a message that *quotes* the word "error" becomes an `error` node). **Node types are now sourced from REAL schema fields:** `checkpoint.is_decision` from S40's `detectItemType` (real, stored), `checkpoint.is_error` from the real error classifier (`extensions/mega-events/error-classifier.ts`), default → `message`. No keyword lists.
- **Defect 3 — Importance fallback (DE-MARKED as display-only).** The old `default importance = tokenEstimate / 1000` was a magic divisor pretending to be a signal. The divisor is retained **only as a display normalizer** named `IMPORTANCE_DISPLAY_DIVISOR` (configurable) for the rare case where S40's real `importance_score` is absent. It is documented as a display helper, **not** a fake importance score. The primary path is S40's real `checkpoint.importance_score`.

**Boundary statement.** This spec is honest about what the map shows: **real relationships only** (temporal = sequential checkpoints; topical = RAPTOR cluster membership). It does **not** invent causal relationships. If a relationship cannot be sourced from real schema or real cluster membership, it is not drawn.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004** (no network): the dashboard is localhost-only, already audited (`extensions/dashboard-server/server.ts:15` — bind to `127.0.0.1`). The memory graph API reads from the local SQLite store only. No remote calls.
- **PREVENT-PI-001** (anchor floor): the memory map is a read-only visualization. It does not modify message ordering, drop ranges, or checkpoint storage.
- **Feature flags default ON**: `MEMORY_MAP_ENABLED` defaults to `true`. The `/api/memory-graph` endpoint is available out-of-the-box on a running dashboard. (See RISKS for rationale; gate remains for opt-out.)
- **Dashboard is optional**: the dashboard-client is a separate build (`extensions/dashboard-client/package.json`) not shipped in the npm package. Adding reactflow does not affect the main package size.
- **Data safety**: the API returns `content_preview` (truncated to 200 chars), not full message content. This limits data exposure even on localhost.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

The dashboard currently shows aggregate metrics (Overview, Canary, DR tabs) but has **no way to visualize the structure of conversation memory**. This makes debugging and navigation difficult:

1. **No visual memory structure** — checkpoints are stored as flat rows in `context_chunks` (`src/store/sqlite/checkpoints.ts`). There's no way to see how memories relate to each other — which are sequential, which discuss the same topic, which are clusters.

2. **No temporal navigation** — to find a specific earlier conversation, the user must search by text or browse a flat list. There's no timeline or graph to navigate by relationship.

3. **RAPTOR clusters are invisible** — the RAPTOR tree (`src/dedup/raptor/`) groups related checkpoints into clusters, but this structure is never shown to the user. Cluster membership and hierarchy are stored in `raptor_nodes` but only used at retrieval time.

4. **No branching surface** — the planned conversation branching feature needs a navigation surface where users can pick a point to branch from. Without a visual graph, branching is just an abstract concept.

5. **Debugging is opaque** — when recall returns unexpected results, there's no way to see *why* certain checkpoints were selected or how they relate to the query context.

---

## SCOPE

### IN SCOPE (new files):
- `src/memoryGraph.ts` — graph data generation from SQLite (nodes + edges)
- `src/memoryGraph.test.ts` — unit tests for graph construction
- `extensions/dashboard-client/src/tabs/MemoryMapTab.tsx` — reactflow-based graph component
- `extensions/dashboard-client/src/components/MemoryGraphNode.tsx` — custom node renderer
- `extensions/dashboard-client/src/components/MemoryGraphEdge.tsx` — custom edge renderer
- `extensions/dashboard-client/src/components/MemoryGraphPanel.tsx` — detail side panel

### IN SCOPE (modified files):
- `extensions/dashboard-server/server.ts` — add `GET /api/memory-graph` endpoint (~line 243)
- `extensions/dashboard-client/src/App.tsx` — add "Memory Map" tab (~line 48)
- `extensions/dashboard-client/package.json` — add `reactflow` dependency
- `src/config/dedup.ts` — add memory map config flags (incl. `IMPORTANCE_DISPLAY_DIVISOR`)

### OUT OF SCOPE:
- Conversation branching — S46 provides the navigation surface only; branching logic is a separate sprint.
- Real-time graph updates — the graph is loaded on-demand when the tab is opened, not streamed via SSE.
- Graph editing — the graph is read-only; no user mutations.
- **Synthetic causal edges** — explicitly OUT OF SCOPE. The map shows real relationships only.

---

## EXECUTION

### Sprint S46A: Graph Data Generation (Backend)

**Goal:** Build the memory graph from SQLite data — nodes are memories, edges are **real** relationships only (temporal + topical).

**Acceptance:** `buildMemoryGraph(sessionId, opts)` returns `{ nodes, edges }` with correct types and **only real relationships**. Zero synthetic edges.

**Tasks:**

- [ ] **S46A.1** Create `src/memoryGraph.ts` with types
  - `MemoryGraphNode` type: `{ id: string; type: "message" | "decision" | "error" | "topic" | "cluster"; contentPreview: string; timestamp: number; importanceScore: number; sessionId: string; metadata?: Record<string, unknown> }`
  - `MemoryGraphEdge` type: `{ source: string; target: string; type: "temporal" | "topical"; weight: number }` — **`causal` removed from the union.**
  - `MemoryGraph` type: `{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; sessionId: string; generatedAt: number; edgeTypes: ["temporal", "topical"] }` — `edgeTypes` is the honest, closed list of edge types this graph emits.
  - `MemoryGraphOptions` type: `{ maxNodes?: number; minImportance?: number; sessionFilter?: string; timeRange?: { from: number; to: number } }`

- [ ] **S46A.2** Implement temporal edge generation
  - Query `context_chunks` for the session, ordered by `timestamp` ASC (`src/store/sqlite/checkpoints.ts`)
  - Create temporal edges: each checkpoint `i` → checkpoint `i+1` with `weight = 1.0` (real sequential relationship)

- [ ] **S46A.3** Implement node type inference from REAL schema fields (NOT keywords)
  - For each checkpoint row, resolve the node `type`:
    - `checkpoint.is_decision === true` → `type: "decision"` — sourced from S40's `detectItemType` (real, stored field). See `src/extractive.ts` / `src/types.ts` for the stored flag.
    - `checkpoint.is_error === true` → `type: "error"` — sourced from the real error classifier (`extensions/mega-events/error-classifier.ts`'s `classifyError`). Non-`null` result on the checkpoint's stored message/error → `is_error`.
    - Otherwise → `type: "message"`.
  - **No keyword lists.** No scanning for "decision"/"decided"/"chose"/"error"/"exception"/"failed". The prior keyword-based approach (which misclassified quoted text) is removed.
  - For RAPTOR cluster nodes: `type: "cluster"`, content preview = stored cluster summary.

- [ ] **S46A.4** Implement topical edge generation (RAPTOR clusters)
  - Query `raptor_nodes` table for cluster membership (`src/store/sqlite/raptor.ts`)
  - For each RAPTOR cluster: create edges between all member checkpoints with `type: "topical"`, `weight = clusterDepth / maxDepth` (real cluster geometry)
  - Cluster nodes themselves: add `type: "cluster"` node with the stored summary as content preview

- [ ] **S46A.5** (DELETED — was "Implement causal edge detection")
  - **This task is removed.** Causal edges were synthetic (phrase-matching with no ground truth). The graph emits **temporal** and **topical** edges only. This deletion is a deliberate boundary: the map shows real relationships, not guessed ones.

- [ ] **S46A.6** Implement importance scoring integration (real S40 score, display normalizer fallback)
  - Primary path: when `checkpoint.importance_score` is present (S40-derived, real), use it directly. S40 owns the scoring model; S46 does not re-invent it.
  - Fallback: when `importance_score` is absent, use `tokenEstimate / IMPORTANCE_DISPLAY_DIVISOR` where `IMPORTANCE_DISPLAY_DIVISOR` is a configurable display normalizer (default `1000`, env `MEGACOMPACT_IMPORTANCE_DISPLAY_DIVISOR`).
  - **Document the fallback as a display helper, not a fake importance score.** The divisor only normalizes token counts into the [0,1]-ish range used for node sizing. It is not a signal and must not be persisted or logged as if it were S40's score.
  - Node size in the frontend is proportional to `importanceScore`.

- [ ] **S46A.7** Add filtering to `buildMemoryGraph()`
  - `maxNodes`: limit total nodes (default 200); when exceeded, keep highest-importance nodes
  - `minImportance`: filter out nodes below this threshold
  - `timeRange`: only include nodes within the time window
  - `sessionFilter`: only include nodes from this session (or null for all)

- [ ] **S46A.8** Add tests in `src/memoryGraph.test.ts`
  - Test: temporal edges connect sequential checkpoints
  - Test: topical edges connect RAPTOR cluster members
  - Test: **no causal edges are ever emitted** (grep the output `edges` array; every edge has `type === "temporal" | "topical"`)
  - Test: importance filtering removes low-importance nodes
  - Test: maxNodes caps the result size
  - Test: empty session returns `{ nodes: [], edges: [], edgeTypes: ["temporal","topical"] }`
  - Test: node types come from real schema fields — a checkpoint with `is_decision: true` is a `decision` node; a checkpoint whose stored message classifies non-`null` via `classifyError` is an `error` node; otherwise `message`. **Add a regression test:** a message that merely *quotes* the word "error" or "decided" is NOT reclassified (the old keyword bug).

- [ ] **S46A.9** Verify: `npm run build && npm test`

---

### Sprint S46B: Dashboard API Endpoint

**Goal:** Expose the memory graph via a REST endpoint.

**Acceptance:** `GET /api/memory-graph?session_id=X&max_nodes=N` returns valid JSON with nodes and edges, with a real error-logging contract.

**Tasks:**

- [ ] **S46B.1** Add config flags to `src/config/dedup.ts`
  - `MEMORY_MAP_ENABLED: boolean` (env: `MEGACOMPACT_MEMORY_MAP`, default: `true`)
  - `MEMORY_MAP_MAX_NODES: number` (env: `MEGACOMPACT_MEMORY_MAP_MAX`, default: `200`)
  - `IMPORTANCE_DISPLAY_DIVISOR: number` (env: `MEGACOMPACT_IMPORTANCE_DISPLAY_DIVISOR`, default: `1000`) — documented as a display normalizer, not a signal.

- [ ] **S46B.2** Add `GET /api/memory-graph` endpoint in `extensions/dashboard-server/server.ts`
  - Location: after existing `/api/repos` endpoint (~line 274)
  - Query params: `session_id` (required), `max_nodes` (optional, default 200), `min_importance` (optional, default 0), `from` / `to` (optional timestamps)
  - Handler: import `buildMemoryGraph()` from `src/memoryGraph.js`, call with params, return JSON
  - Gated: return 404 when `MEMORY_MAP_ENABLED=false`
  - Error-logging contract (REAL fields, not invented):
    - On success: log `memory_graph_request` event with `{ sessionId, nodeCount, edgeCount, edgeTypes: ["temporal","topical"] }`.
    - On empty session: return `200` with `{ nodes: [], edges: [], edgeTypes: ["temporal","topical"], sessionId, generatedAt }` and log `memory_graph_empty` with `{ sessionId }`. **Empty is not an error** — it's an honest "no memories to display" state.
    - On 500: log `memory_graph_error` with the **real error message** (`error.message`), not a generic string. Return `500` with `{ error: "<real message>" }`.

- [ ] **S46B.3** Add API contract type in `extensions/dashboard-server/api-contracts/`
  - `MemoryGraphResponse` type matching `MemoryGraph` from `src/memoryGraph.ts` (including the closed `edgeTypes: ["temporal","topical"]` field)
  - Add to the existing contract barrel

- [ ] **S46B.4** Add API tests
  - Test: endpoint returns 404 when `MEMORY_MAP_ENABLED=false`
  - Test: endpoint returns valid graph JSON when enabled
  - Test: query params are parsed correctly
  - Test: invalid/empty session returns `{ nodes: [], edges: [] }` with `200` (not an error) and emits `memory_graph_empty`
  - Test: 500 path logs `memory_graph_error` with the real error message

- [ ] **S46B.5** Verify: `npm run build && npm test`

---

### Sprint S46C: Frontend — React Flow Graph Component

**Goal:** Interactive graph visualization in the dashboard.

**Acceptance:** Memory Map tab renders a zoomable, pannable graph with colored nodes and filter controls.

**Tasks:**

- [ ] **S46C.1** Add reactflow dependency
  - `cd extensions/dashboard-client && npm install reactflow`
  - Update `extensions/dashboard-client/package.json` (already has recharts as reference)
  - Verify: `npm run build` in dashboard-client

- [ ] **S46C.2** Create `extensions/dashboard-client/src/tabs/MemoryMapTab.tsx`
  - Fetch data from `/api/memory-graph` on mount (via existing `useApi` hook pattern in `src/hooks/useApi.ts`)
  - Render `<ReactFlow>` with nodes and edges
  - Layout: use `dagre` or `elkjs` for automatic hierarchical layout (or simple force-directed)
  - Background: `<Background />` component from reactflow for grid dots
  - Controls: `<Controls />` for zoom in/out/fit
  - Empty state: when `nodes.length === 0`, render "No memories to display" (matches the backend's honest empty contract)

- [ ] **S46C.3** Create custom node renderer `extensions/dashboard-client/src/components/MemoryGraphNode.tsx`
  - Node styling by type:
    - `message` → blue background, small (20px)
    - `decision` → green background, medium (30px)
    - `error` → red background, medium (30px)
    - `topic` → purple background, medium (25px)
    - `cluster` → gray background, large (40px)
  - Node size scales with `importanceScore` (15px–50px range)
  - Display: truncated content preview (first 60 chars)
  - Click: select node, show in detail panel

- [ ] **S46C.4** Create custom edge renderer `extensions/dashboard-client/src/components/MemoryGraphEdge.tsx`
  - Edge styling by type:
    - `temporal` → solid gray line, weight = line thickness
    - `topical` → dotted purple line
  - **No `causal` style.** Causal edges are not emitted by the backend; the frontend does not render them.
  - Edge label (optional): show weight on hover

- [ ] **S46C.5** Create detail panel `extensions/dashboard-client/src/components/MemoryGraphPanel.tsx`
  - Side panel (slides in from right) when a node is selected
  - Shows: full content preview, timestamp, importance score, node type, connected edges count
  - "Branch from here" button (disabled — future feature, shows tooltip "Coming soon")
  - Close button to dismiss

- [ ] **S46C.6** Add filter controls to MemoryMapTab
  - Time range picker (from/to date inputs)
  - Importance threshold slider (0–1)
  - Node type checkboxes (message, decision, error, topic, cluster)
  - Session dropdown (fetch session list from `/api/repos` or `/api/snapshot`)
  - Re-fetch graph on filter change

- [ ] **S46C.7** Add "Memory Map" tab to `extensions/dashboard-client/src/App.tsx`
  - Add `MemoryMapTab` lazy import (~line 22)
  - Add `"memory-map"` to `TabId` union (~line 36)
  - Add to `TABS` array (~line 48)
  - Add render case (~line 72)

- [ ] **S46C.8** Verify: `cd extensions/dashboard-client && npm run build && npm test`

---

### Sprint S46D: Integration Tests + Polish

**Goal:** End-to-end verification and edge-case handling.

**Acceptance:** Dashboard loads memory map for a real session; filters work; empty sessions handled honestly.

**Tasks:**

- [ ] **S46D.1** Integration test: API → frontend data flow
  - Mock API response with known graph data
  - Verify reactflow renders correct node count
  - Verify filter changes trigger re-fetch

- [ ] **S46D.2** Edge case: empty session
  - API returns `{ nodes: [], edges: [] }` — frontend shows "No memories to display" message
  - No crash, no empty graph with controls
  - Backend emits `memory_graph_empty` (not `memory_graph_error`)

- [ ] **S46D.3** Edge case: large session (>200 nodes)
  - API truncates to `maxNodes` by importance
  - Frontend renders without performance degradation
  - Warning shown: "Showing top 200 of N memories"

- [ ] **S46D.4** Edge case: no RAPTOR clusters
  - Topical edges are absent; graph still renders with temporal edges only
  - No crash from missing `raptor_nodes` table
  - `edgeCount` reflects temporal-only; `edgeTypes` stays `["temporal","topical"]` (the closed list of types this graph *can* emit)

- [ ] **S46D.5** Full regression test
  - `MEGACOMPACT_MEMORY_MAP=false npm test` — opt-out path returns 404, no frontend tab visible
  - `MEGACOMPACT_MEMORY_MAP=true npm test` — default path, all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

## ACCEPTANCE CRITERIA

1. **Graph renders correctly**: Memory Map tab shows a zoomable, pannable graph with colored nodes and typed edges.
2. **Node types from real schema**: `decision` is sourced from `checkpoint.is_decision` (S40's `detectItemType`, real, stored); `error` is sourced from the real error classifier (`extensions/mega-events/error-classifier.ts`); default → `message`. **No keyword matching.** Add a regression test that a message quoting the word "error" or "decided" is not reclassified.
3. **Edge types are real only**:
   - **temporal** (sequential checkpoints) — real.
   - **topical** (RAPTOR cluster membership) — real.
   - **No causal edges.** Grep the codebase for causal-edge phrase-matching patterns ("as we decided", "from the previous", "based on", "following up") in `src/memoryGraph.ts` → returns nothing.
4. **Importance from real S40 score**: primary path uses `checkpoint.importance_score` (S40-derived). The `tokenEstimate / IMPORTANCE_DISPLAY_DIVISOR` fallback is a documented display normalizer, not a fake signal; it is not persisted or logged as S40's score.
5. **Error-logging contract**: `memory_graph_request` logs real `{ sessionId, nodeCount, edgeCount, edgeTypes: ["temporal","topical"] }`; empty session → `memory_graph_empty` with `{ sessionId }` and `200` (not an error); 500 → `memory_graph_error` with the real `error.message`.
6. **Gate default ON**: `MEMORY_MAP_ENABLED` defaults to `true`; the endpoint is available out-of-the-box. Opt-out via `MEGACOMPACT_MEMORY_MAP=false` returns 404.
7. **Filters work**: time range, importance threshold, node type, and session filters update the graph.
8. **Detail panel works**: clicking a node shows its full content and metadata.
9. **Performance**: graph with 200 nodes renders in <2 seconds; zoom/pan is smooth.
10. **No data leakage**: content previews are truncated to 200 chars; full content is only in the detail panel.

---

## ROLLBACK

1. Set `MEGACOMPACT_MEMORY_MAP=false` to disable the API endpoint (opt-out).
2. Remove the "Memory Map" tab from `TABS` in `App.tsx` to hide the frontend.
3. Remove `reactflow` dependency from `extensions/dashboard-client/package.json`.
4. All backend code is in new files (`src/memoryGraph.ts`).
5. No database migrations required — reads from existing `context_chunks` and `raptor_nodes`.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| reactflow increases client bundle size | Medium | Low | reactflow is ~100KB gzipped; lazy-loaded tab only |
| Graph layout is ugly for large sessions | Medium | Low | Dagre hierarchical layout is well-tested; maxNodes caps at 200 |
| RAPTOR data missing for some sessions | Medium | Low | Graceful degradation — topical edges absent, temporal edges still work |
| Graph data generation is slow for large sessions | Low | Medium | maxNodes cap + importance filtering; single SQLite query |
| Importance fallback masquerades as a signal | Low | Low | `IMPORTANCE_DISPLAY_DIVISOR` is documented as a **display normalizer only**, not a fake importance score; it is never persisted or logged as S40's score. The primary path is the real `checkpoint.importance_score`. |
| Node type from real schema fields is incomplete | Medium | Low | If S40's `is_decision` flag is absent for older checkpoints, those nodes fall through to `message` (honest default). No synthetic inference. |
