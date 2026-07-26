# S44 — Three-Tier Latency-Aware Recall Routing

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 14 (tier flags + monitoring), S41 (self-RAG quality gate), S42 (RAPTOR multi-level retrieval), `src/vectorStore.ts`, `src/recall.ts`, `src/store/vectorIndex.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): the tiered router is additive — it produces `SearchHit[]` that feed into the existing `recallAndInline()` pipeline (`src/recall.ts:108`). The anchor-floor guard in `src/boundary.ts:computeDropRange()` is never touched.
- **PREVENT-PI-003** (no system role): recalled hits are injected via the existing `before_agent_start` systemPrompt prepend path. The router affects *which* hits are returned, not *how* they're injected.
- **PREVENT-PI-004** (no network): L0 is an in-memory Map, L1 is node:sqlite FTS5 (in-process), L2 is PGlite HNSW (in-process WASM). No HTTP calls. Embedding cache uses the existing local `TrigramEmbedder` (`src/embedder.ts:61–90`).
- **Feature flags default OFF**: `TIERED_ROUTING_ENABLED` defaults to `false`. Zero behavior change unless explicitly enabled. When OFF, `recallAndInline()` and `recallAndInlineAsync()` behave identically to current production.
- **Non-fatal degradation**: any failure in L0 cache or L1 FTS5 falls through to the next tier. L2 PGlite failure already falls through to sync `search()` (`src/vectorStore.ts:270`).
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's recall path has **no caching** and **no latency-aware routing**. Every recall request pays the full cost regardless of query repetition:

1. **No result caching** — `recallAndInline()` (`src/recall.ts:108–185`) calls `searchRecall()` → `store.search()` (`src/vectorStore.ts:200–270`) which scans every checkpoint's embedding via `cosineSimilarity()` on every call. If the same session asks the same query twice within minutes, the full O(N) scan runs twice.

2. **No embedding cache** — the `TrigramEmbedder.embed()` (`src/embedder.ts:61–90`) runs a full character 3-gram hash + L2 normalize on every query. For repeated queries this is wasted compute.

3. **No tiered fallback** — `searchAsync()` (`src/vectorStore.ts:268–320`) always tries PGlite first, then falls back to sync `search()`. There is no way to short-circuit via a cheap sync check before hitting the async index.

4. **No hit-rate instrumentation** — while `monitoring.ts` tracks dedup decisions per tier, there is no tracking of recall query hit rates, cache effectiveness, or per-tier latency distribution.

The Rust rewrite of radical-memory-mcp has a three-tier query router with Redis (<1ms) → FAISS (5ms CPU) → PostgreSQL (50–100ms), with per-tier hit-rate tracking and session-scoped cache invalidation. We should adapt this to our stack.

---

## SCOPE

### IN SCOPE (new files):
- `src/tieredRouter.ts` — three-tier recall router (L0 cache → L1 FTS5 → L2 HNSW)
- `src/tieredRouter.test.ts` — unit tests for routing, cache, invalidation, hit-rate tracking
- `src/store/sqlite/fts5-search.ts` — FTS5 trigram search helper for L1 tier
- `src/store/sqlite/fts5-search.test.ts` — unit tests for FTS5 search

### IN SCOPE (modified files):
- `src/recall.ts` — wire tiered router into `recallAndInline()` and `recallAndInlineAsync()` when `TIERED_ROUTING_ENABLED=true`
- `src/vectorStore.ts` — expose `search()` internals so the router can call L1/L2 individually; add `searchFTS5()` method
- `src/config/dedup.ts` — add tiered routing config flags (lines ~30–65)
- `src/embedder.ts` — add embedding cache wrapper around `embed()`
- `src/monitoring.ts` — add tiered routing metrics (lines ~22–49)
- `extensions/mega-events/context-handler.ts` — call `invalidateSessionCache()` on new messages
- `extensions/dashboard-server/server.ts` — add `/api/tiered-routing` endpoint for hit-rate metrics

### OUT OF SCOPE:
- Changes to `src/engine.ts` — compaction path unchanged; router only affects recall.
- Changes to dedup tiers — L0/L1/L2 dedup in `vectorStore.add()` is unaffected.
- Changes to RAPTOR tree — multi-level retrieval (`S42`) remains the default for RAPTOR-enabled sessions.

---

## EXECUTION

### Sprint S44A: Embedding Cache + L0 Result Cache

**Goal:** In-memory caches for repeated queries. Zero behavior change when OFF.

**Acceptance:** Same query returns cached result in <1ms; cache expires after TTL; session invalidation clears entries.

**Tasks:**

- [ ] **S44A.1** Create `src/tieredRouter.ts` with types (`src/types.ts` reference)
  - `TieredRouterConfig` type: `{ enabled, l0TtlMs, l1ConfidenceThreshold, embeddingCacheTtlMs }`
  - `TieredRouterMetrics` type: `{ l0Hits, l0Misses, l1Hits, l1Misses, l2Hits, l2Misses, avgLatencyMs: Record<Tier, number> }`
  - `TieredRouter` class with constructor accepting config + VectorStore

- [ ] **S44A.2** Implement L0 result cache in `src/tieredRouter.ts`
  - `private l0Cache: Map<string, { results: SearchHit[]; timestamp: number; sessionId: string }>`
  - Cache key: `hash(sessionId + ":" + query)` using `createHash("sha256")` (same pattern as `src/vectorStore.ts:39`)
  - TTL eviction: check `Date.now() - entry.timestamp > config.l0TtlMs` on access
  - Background sweep every 60s to purge expired entries

- [ ] **S44A.3** Implement embedding cache in `src/tieredRouter.ts`
  - `private embeddingCache: Map<string, { vector: Vector; timestamp: number }>`
  - Key: `hash(queryText)` — same query always gets same embedding
  - TTL: `config.embeddingCacheTtlMs` (default 1h)
  - Wrap `embedder.embed()` — check cache first, store on miss

- [ ] **S44A.4** Add config flags to `src/config/dedup.ts` (~line 30)
  - `TIERED_ROUTING_ENABLED: boolean` (env: `MEGACOMPACT_TIERED_ROUTING`, default: `false`)
  - `TIERED_L0_TTL_MS: number` (env: `MEGACOMPACT_TIERED_L0_TTL`, default: `300000`)
  - `TIERED_L1_CONFIDENCE_THRESHOLD: number` (env: `MEGACOMPACT_TIERED_L1_THRESHOLD`, default: `0.8`)
  - `TIERED_EMBEDDING_CACHE_TTL_MS: number` (env: `MEGACOMPACT_TIERED_EMBED_TTL`, default: `3600000`)

- [ ] **S44A.5** Add L0 cache tests in `src/tieredRouter.test.ts`
  - Test: L0 hit returns cached result without calling L1/L2
  - Test: L0 miss falls through to L1
  - Test: L0 TTL expiry evicts entry
  - Test: embedding cache returns same vector for same query
  - Test: embedding cache TTL expiry re-embeds

- [ ] **S44A.6** Verify: `npm run build && npm test` — all 372+ tests pass, zero regressions

---

### Sprint S44B: L1 FTS5 Trigram Search Tier

**Goal:** Add fast sync FTS5 trigram search as L1 tier between cache and HNSW.

**Acceptance:** L1 returns results in <5ms for sessions with <1000 checkpoints; confidence scoring works.

**Tasks:**

- [ ] **S44B.1** Create `src/store/sqlite/fts5-search.ts`
  - `searchFTS5(db, sessionId, query, limit)` — FTS5 trigram query against `context_chunks` table
  - Reuse existing FTS5 index on `context_chunks` (created in `src/store/sqlite/schema.ts`)
  - Returns `{ checkpointId, score, snippet }[]` where score is the FTS5 BM25 rank normalized to [0, 1]
  - Confidence metric: ratio of best FTS5 score to a calibrated maximum (empirically ~0.6 for trigram)

- [ ] **S44B.2** Add `searchFTS5()` method to `VectorStore` (`src/vectorStore.ts`)
  - Public method that delegates to `fts5-search.ts`
  - Returns `SearchHit[]` with `score` from FTS5 BM25 normalized
  - Used by the tiered router as the L1 tier

- [ ] **S44B.3** Implement L1 tier in `src/tieredRouter.ts`
  - On L0 miss: call `vectorStore.searchFTS5(sessionId, query, k*2)`
  - If best hit score ≥ `config.l1ConfidenceThreshold` (default 0.8): cache to L0, return
  - If best hit score < threshold: fall through to L2

- [ ] **S44B.4** Add L1 tier tests in `src/tieredRouter.test.ts`
  - Test: L1 high confidence promotes results to L0 cache
  - Test: L1 low confidence falls through to L2
  - Test: L1 latency is <5ms for 100 checkpoints
  - Test: L1 returns empty when session has no checkpoints

- [ ] **S44B.5** Verify: `npm run build && npm test`

---

### Sprint S44C: L2 HNSW Async Tier + Routing Logic

**Goal:** Complete the three-tier cascade with L2 as the async HNSW fallback.

**Acceptance:** Full cascade works: L0 → L1 → L2; results are cached to L0 after any tier returns.

**Tasks:**

- [ ] **S44C.1** Implement L2 tier in `src/tieredRouter.ts`
  - On L1 miss: call `vectorStore.searchAsync(sessionId, query, k, opts)` (`src/vectorStore.ts:268`)
  - L2 is async — the router's `route()` method must be `async`
  - Cache L2 results to L0 on return

- [ ] **S44C.2** Implement session-scoped cache invalidation
  - `invalidateSession(sessionId: string)` — remove all L0 entries where `entry.sessionId === sessionId`
  - Called from `extensions/mega-events/context-handler.ts` when new messages arrive
  - Also clears embedding cache entries for that session's queries

- [ ] **S44C.3** Add hit-rate tracking in `src/tieredRouter.ts`
  - Per-tier counters: `hits`, `misses`, `totalLatencyMs`
  - `getMetrics()` returns `{ l0: {hits, misses, avgMs}, l1: {...}, l2: {...}, totalQueries }`
  - Log to `events.log` every 100 queries via `logDecision()` (`src/monitoring.ts:22`)

- [ ] **S44C.4** Add monitoring integration to `src/monitoring.ts` (~line 45)
  - `TieredRoutingMetrics` interface added to the monitoring types
  - `logTieredMetrics()` appends structured event to events.log
  - Dashboard JSON includes tiered routing summary

- [ ] **S44C.5** Add routing tests in `src/tieredRouter.test.ts`
  - Test: L0 miss → L1 miss → L2 hit → cache to L0
  - Test: L0 miss → L1 hit (no L2 call)
  - Test: L0 hit (no L1/L2 calls)
  - Test: session invalidation clears correct entries
  - Test: hit-rate counters increment correctly
  - Test: embedding cache is independent of result cache

- [ ] **S44C.6** Verify: `npm run build && npm test`

---

### Sprint S44D: Integration + Dashboard

**Goal:** Wire tiered router into recall path and expose metrics on dashboard.

**Acceptance:** `recallAndInline()` uses tiered router when flag is ON; dashboard shows tier hit rates.

**Tasks:**

- [ ] **S44D.1** Wire into `recallAndInline()` (`src/recall.ts:108–185`)
  - When `TIERED_ROUTING_ENABLED=true`: call `tieredRouter.route(sessionId, query, k)` instead of `searchRecall()`
  - TieredRouter instance created lazily (singleton, similar to `getDefaultStore()` in `src/engine.ts:67`)
  - Fallback: if router throws, fall through to existing `searchRecall()`

- [ ] **S44D.2** Wire into `recallAndInlineAsync()` (`src/recall.ts:286–345`)
  - Same pattern: use `tieredRouter.routeAsync()` when flag is ON
  - Router's L2 tier already calls `searchAsync()` internally

- [ ] **S44D.3** Wire session invalidation into context handler
  - `extensions/mega-events/context-handler.ts`: on `before_agent_start` with new messages, call `tieredRouter.invalidateSession(sessionId)`
  - Non-fatal: if router not initialized, skip

- [ ] **S44D.4** Add dashboard API endpoint
  - `GET /api/tiered-routing` in `extensions/dashboard-server/server.ts` (~line 243)
  - Returns tiered routing metrics from the router singleton
  - 404 when `TIERED_ROUTING_ENABLED=false`

- [ ] **S44D.5** Add dashboard tab content (optional, low priority)
  - `extensions/dashboard-client/src/tabs/MetricsTab.tsx`: add tier hit-rate cards
  - Show L0/L1/L2 hit rates, avg latency, total queries
  - Simple bar chart using existing recharts dependency

- [ ] **S44D.6** Full regression test with flag OFF
  - `MEGACOMPACT_TIERED_ROUTING=false npm test` — zero behavior change
  - `MEGACOMPACT_TIERED_ROUTING=true npm test` — all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF**: `TIERED_ROUTING_ENABLED=false` (default) produces identical results to current production. All 372+ existing tests pass unchanged.
2. **Cache hit returns in <1ms**: L0 cache hit for a repeated query returns the same `SearchHit[]` without calling any search function.
3. **L1 FTS5 returns in <5ms**: For sessions with <1000 checkpoints, FTS5 trigram search completes in <5ms.
4. **Full cascade works**: L0 miss → L1 miss → L2 HNSW → result cached to L0 for next call.
5. **Session invalidation**: New messages for a session clear that session's L0 cache entries.
6. **Hit-rate tracking**: Per-tier counters (hits, misses, avg_latency_ms) are logged every 100 queries.
7. **Non-fatal degradation**: Any tier failure falls through to the next tier. Router failure falls through to existing `searchRecall()`.
8. **Embedding cache**: Same query text returns the same embedding vector without re-computation (within TTL).

---

## ROLLBACK

1. Set `MEGACOMPACT_TIERED_ROUTING=false` to disable the entire feature.
2. All new code is in new files (`src/tieredRouter.ts`, `src/store/sqlite/fts5-search.ts`).
3. Integration points in `src/recall.ts` are gated behind `if (config.TIERED_ROUTING_ENABLED)`.
4. Dashboard endpoint returns 404 when disabled — no stale data.
5. No database migrations required — FTS5 index already exists on `context_chunks`.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| L0 cache serves stale results after dedup changes | Medium | Medium | Session invalidation on new messages; TTL=5min bounds staleness |
| FTS5 trigram search has low confidence for semantic queries | Medium | Low | L1 low confidence falls through to L2 HNSW — no recall loss |
| Embedding cache grows unbounded in long sessions | Low | Low | TTL=1h + background sweep; max ~1000 entries typical |
| L2 PGlite timeout causes slow recall | Low | Medium | Existing timeout guard in `searchAsync()` (`src/vectorStore.ts:270`) already handles this |
| Cache key collision (hash of query text) | Very Low | Very Low | SHA-256 truncated to 16 hex — collision probability ~2^-64 |
