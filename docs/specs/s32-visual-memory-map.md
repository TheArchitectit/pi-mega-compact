# S32 — Visual Memory Map Dashboard

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S26 (importance scoring), S28 (RAPTOR multi-level retrieval), `extensions/dashboard-server/server.ts`, `extensions/dashboard-client/`, `src/store/sqlite.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004** (no network): the dashboard is localhost-only, already audited (`extensions/dashboard-server/server.ts:15` — bind to `127.0.0.1`). The memory graph API reads from the local SQLite store only. No remote calls.
- **PREVENT-PI-001** (anchor floor): the memory map is a read-only visualization. It does not modify message ordering, drop ranges, or checkpoint storage.
- **Feature flags default OFF**: `MEMORY_MAP_ENABLED` defaults to `false`. The `/api/memory-graph` endpoint returns 404 when disabled.
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
- `src/config/dedup.ts` — add memory map config flags

### OUT OF SCOPE:
- Conversation branching — S32 provides the navigation surface only; branching logic is a separate sprint.
- Real-time graph updates — the graph is loaded on-demand when the tab is opened, not streamed via SSE.
- Graph editing — the graph is read-only; no user mutations.

---

## EXECUTION

### Sprint S32A: Graph Data Generation (Backend)

**Goal:** Build the memory graph from SQLite data — nodes are memories, edges are relationships.

**Acceptance:** `buildMemoryGraph(sessionId, opts)` returns `{ nodes, edges }` with correct types and relationships.

**Tasks:**

- [ ] **S32A.1** Create `src/memoryGraph.ts` with types
  - `MemoryGraphNode` type: `{ id: string; type: "message" | "decision" | "error" | "topic" | "cluster"; contentPreview: string; timestamp: number; importanceScore: number; sessionId: string; metadata?: Record<string, unknown> }`
  - `MemoryGraphEdge` type: `{ source: string; target: string; type: "temporal" | "causal" | "topical"; weight: number }`
  - `MemoryGraph` type: `{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; sessionId: string; generatedAt: number }`
  - `MemoryGraphOptions` type: `{ maxNodes?: number; minImportance?: number; sessionFilter?: string; timeRange?: { from: number; to: number } }`

- [ ] **S32A.2** Implement temporal edge generation
  - Query `context_chunks` for the session, ordered by `timestamp` ASC (`src/store/sqlite/checkpoints.ts`)
  - Create temporal edges: each checkpoint `i` → checkpoint `i+1` with `weight = 1.0`
  - Node type inference from checkpoint content:
    - Contains "decision" or "decided" or "chose" → `type: "decision"`
    - Contains "error" or "exception" or "failed" → `type: "error"`
    - Default → `type: "message"`

- [ ] **S32A.3** Implement topical edge generation (RAPTOR clusters)
  - Query `raptor_nodes` table for cluster membership (`src/store/sqlite/raptor.ts`)
  - For each RAPTOR cluster: create edges between all member checkpoints with `type: "topical"`, `weight = clusterDepth / maxDepth`
  - Cluster nodes themselves: add `type: "cluster"` node with summary as content preview

- [ ] **S32A.4** Implement causal edge detection (heuristic)
  - Scan checkpoint summaries for cross-references: phrases like "as we decided", "from the previous", "based on", "following up"
  - When found, extract the referenced topic and find the most recent prior checkpoint mentioning that topic
  - Create causal edge with `type: "causal"`, `weight = 0.8`
  - This is heuristic — false positives are acceptable (edges are visual, not structural)

- [ ] **S32A.5** Implement importance scoring integration
  - When S26 importance scoring is enabled: use `importance_score` from the `memories` or `context_chunks` table
  - When disabled: default importance = `tokenEstimate / 1000` (normalized to [0, 1])
  - Node size in the frontend will be proportional to importance

- [ ] **S32A.6** Add filtering to `buildMemoryGraph()`
  - `maxNodes`: limit total nodes (default 200); when exceeded, keep highest-importance nodes
  - `minImportance`: filter out nodes below this threshold
  - `timeRange`: only include nodes within the time window
  - `sessionFilter`: only include nodes from this session (or null for all)

- [ ] **S32A.7** Add tests in `src/memoryGraph.test.ts`
  - Test: temporal edges connect sequential checkpoints
  - Test: topical edges connect RAPTOR cluster members
  - Test: causal edges are created for cross-reference patterns
  - Test: importance filtering removes low-importance nodes
  - Test: maxNodes caps the result size
  - Test: empty session returns empty graph
  - Test: node types are correctly inferred

- [ ] **S32A.8** Verify: `npm run build && npm test`

---

### Sprint S32B: Dashboard API Endpoint

**Goal:** Expose the memory graph via a REST endpoint.

**Acceptance:** `GET /api/memory-graph?session_id=X&max_nodes=N` returns valid JSON with nodes and edges.

**Tasks:**

- [ ] **S32B.1** Add config flags to `src/config/dedup.ts`
  - `MEMORY_MAP_ENABLED: boolean` (env: `MEGACOMPACT_MEMORY_MAP`, default: `false`)
  - `MEMORY_MAP_MAX_NODES: number` (env: `MEGACOMPACT_MEMORY_MAP_MAX`, default: `200`)

- [ ] **S32B.2** Add `GET /api/memory-graph` endpoint in `extensions/dashboard-server/server.ts`
  - Location: after existing `/api/repos` endpoint (~line 274)
  - Query params: `session_id` (required), `max_nodes` (optional, default 200), `min_importance` (optional, default 0), `from` / `to` (optional timestamps)
  - Handler: import `buildMemoryGraph()` from `src/memoryGraph.js`, call with params, return JSON
  - Gated: return 404 when `MEMORY_MAP_ENABLED=false`
  - Error handling: try/catch, return 500 with `{ error: "..." }` on failure

- [ ] **S32B.3** Add API contract type in `extensions/dashboard-server/api-contracts/`
  - `MemoryGraphResponse` type matching `MemoryGraph` from `src/memoryGraph.ts`
  - Add to the existing contract barrel

- [ ] **S32B.4** Add API tests
  - Test: endpoint returns 404 when `MEMORY_MAP_ENABLED=false`
  - Test: endpoint returns valid graph JSON when enabled
  - Test: query params are parsed correctly
  - Test: invalid session_id returns empty graph (not error)

- [ ] **S32B.5** Verify: `npm run build && npm test`

---

### Sprint S32C: Frontend — React Flow Graph Component

**Goal:** Interactive graph visualization in the dashboard.

**Acceptance:** Memory Map tab renders a zoomable, pannable graph with colored nodes and filter controls.

**Tasks:**

- [ ] **S32C.1** Add reactflow dependency
  - `cd extensions/dashboard-client && npm install reactflow`
  - Update `extensions/dashboard-client/package.json` (already has recharts as reference)
  - Verify: `npm run build` in dashboard-client

- [ ] **S32C.2** Create `extensions/dashboard-client/src/tabs/MemoryMapTab.tsx`
  - Fetch data from `/api/memory-graph` on mount (via existing `useApi` hook pattern in `src/hooks/useApi.ts`)
  - Render `<ReactFlow>` with nodes and edges
  - Layout: use `dagre` or `elkjs` for automatic hierarchical layout (or simple force-directed)
  - Background: `<Background />` component from reactflow for grid dots
  - Controls: `<Controls />` for zoom in/out/fit

- [ ] **S32C.3** Create custom node renderer `extensions/dashboard-client/src/components/MemoryGraphNode.tsx`
  - Node styling by type:
    - `message` → blue background, small (20px)
    - `decision` → green background, medium (30px)
    - `error` → red background, medium (30px)
    - `topic` → purple background, medium (25px)
    - `cluster` → gray background, large (40px)
  - Node size scales with `importanceScore` (15px–50px range)
  - Display: truncated content preview (first 60 chars)
  - Click: select node, show in detail panel

- [ ] **S32C.4** Create custom edge renderer `extensions/dashboard-client/src/components/MemoryGraphEdge.tsx`
  - Edge styling by type:
    - `temporal` → solid gray line, weight = line thickness
    - `causal` → dashed green line, arrow at target
    - `topical` → dotted purple line
  - Edge label (optional): show weight on hover

- [ ] **S32C.5** Create detail panel `extensions/dashboard-client/src/components/MemoryGraphPanel.tsx`
  - Side panel (slides in from right) when a node is selected
  - Shows: full content preview, timestamp, importance score, node type, connected edges count
  - "Branch from here" button (disabled — future feature, shows tooltip "Coming soon")
  - Close button to dismiss

- [ ] **S32C.6** Add filter controls to MemoryMapTab
  - Time range picker (from/to date inputs)
  - Importance threshold slider (0–1)
  - Node type checkboxes (message, decision, error, topic, cluster)
  - Session dropdown (fetch session list from `/api/repos` or `/api/snapshot`)
  - Re-fetch graph on filter change

- [ ] **S32C.7** Add "Memory Map" tab to `extensions/dashboard-client/src/App.tsx`
  - Add `MemoryMapTab` lazy import (~line 22)
  - Add `"memory-map"` to `TabId` union (~line 36)
  - Add to `TABS` array (~line 48)
  - Add render case (~line 72)

- [ ] **S32C.8** Verify: `cd extensions/dashboard-client && npm run build && npm test`

---

### Sprint S32D: Integration Tests + Polish

**Goal:** End-to-end verification and edge-case handling.

**Acceptance:** Dashboard loads memory map for a real session; filters work; empty sessions handled.

**Tasks:**

- [ ] **S32D.1** Integration test: API → frontend data flow
  - Mock API response with known graph data
  - Verify reactflow renders correct node count
  - Verify filter changes trigger re-fetch

- [ ] **S32D.2** Edge case: empty session
  - API returns `{ nodes: [], edges: [] }` — frontend shows "No memories to display" message
  - No crash, no empty graph with controls

- [ ] **S32D.3** Edge case: large session (>200 nodes)
  - API truncates to `maxNodes` by importance
  - Frontend renders without performance degradation
  - Warning shown: "Showing top 200 of N memories"

- [ ] **S32D.4** Edge case: no RAPTOR clusters
  - Topical edges are absent; graph still renders with temporal edges only
  - No crash from missing `raptor_nodes` table

- [ ] **S32D.5** Full regression test
  - `MEGACOMPACT_MEMORY_MAP=false npm test` — zero behavior change
  - `MEGACOMPACT_MEMORY_MAP=true npm test` — all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

## ACCEPTANCE CRITERIA

1. **Graph renders correctly**: Memory Map tab shows a zoomable, pannable graph with colored nodes and typed edges.
2. **Node types are accurate**: decision/error/topic/message/cluster types are correctly inferred from content and RAPTOR data.
3. **Edge types work**: temporal (sequential), topical (RAPTOR clusters), and causal (cross-references) edges are generated.
4. **Filters work**: time range, importance threshold, node type, and session filters update the graph.
5. **Detail panel works**: clicking a node shows its full content and metadata.
6. **Performance**: graph with 200 nodes renders in <2 seconds; zoom/pan is smooth.
7. **Zero behavior change when OFF**: `MEMORY_MAP_ENABLED=false` (default) returns 404; no frontend tab visible.
8. **No data leakage**: content previews are truncated to 200 chars; full content is only in the detail panel.

---

## ROLLBACK

1. Set `MEGACOMPACT_MEMORY_MAP=false` to disable the API endpoint.
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
| Causal edge detection is noisy | High | Low | Heuristic — false positives are visual, not structural; weight < 1.0 |
| RAPTOR data missing for some sessions | Medium | Low | Graceful degradation — topical edges absent, temporal edges still work |
| Graph data generation is slow for large sessions | Low | Medium | maxNodes cap + importance filtering; single SQLite query |
