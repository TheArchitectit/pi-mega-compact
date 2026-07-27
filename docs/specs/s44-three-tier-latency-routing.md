# S44 — Three-Tier Latency-Aware Recall Routing

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 14 (tier flags + monitoring), S41 (self-RAG quality gate), S42 (RAPTOR multi-level retrieval), `src/vectorStore.ts`, `src/recall.ts`, `src/store/vectorIndex.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## RE-PLAN 2026-07-25

A re-plan audit on 2026-07-25 confirmed the tiered router is **real-instrumented, not mocked**:

- **Latency is a real measurement.** Each tier is wrapped with `Date.now()` deltas (`performance.now()` is also acceptable). L0 latency is the time to read from an in-memory `Map`; L1 latency is the time to run an FTS5 BM25 query on real node:sqlite (`DatabaseSync`); L2 latency is the time to query the real PGlite HNSW index. No synthetic/simulated latency values are introduced anywhere.
- **Hit/miss counters are real booleans** derived from actual tier return values (cache entry present + unexpired → L0 hit; FTS5 returns a row with score ≥ threshold → L1 hit; PGlite returns vectors → L2 hit).
- **The single defect was the FTS5 confidence denominator.** The original spec (line ~119) hardcoded `"empirically ~0.6 for trigram"` as the assumed maximum FTS5 BM25 score, with no reproducible calibration. If wrong, the L1 confidence gate (`score / FTS5_MAX_BM25 ≥ threshold`) produces incorrect pass/fail decisions — false negatives cause unnecessary L2 fallback; false positives return low-quality matches.

**Fix:** replace the magic number with a real **calibration contract**. A new script (`scripts/calibrate-fts5.mjs`) runs FTS5 BM25 against the *real* `context_chunks` corpus in the user's actual state dir, records the observed maximum score, and writes `FTS5_MAX_BM25` to `~/.pi/mega-compact/calibration.json`. The router reads the calibrated value at startup; when absent, the router sets `uncalibrated:true` and logs a `note:"run scripts/calibrate-fts5.mjs"` instruction (non-fatal — L1 still runs, just with an un-normalized raw score gate as a conservative fallback). Re-run the script whenever the FTS5 schema, tokenizer, or chunking strategy changes — documented in the script header and in §CALIBRATION below.

TTL sweep interval (60s) and log cadence (every 100 queries) are **policy defaults, not mocks** — they are configurable via env vars and stay as-is.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): the tiered router is additive — it produces `SearchHit[]` that feed into the existing `recallAndInline()` pipeline (`src/recall.ts:108`). The anchor-floor guard in `src/boundary.ts:computeDropRange()` is never touched.
- **PREVENT-PI-003** (no system role): recalled hits are injected via the existing `before_agent_start` systemPrompt prepend path. The router affects *which* hits are returned, not *how* they're injected.
- **PREVENT-PI-004** (no network): L0 is an in-memory `Map`, L1 is node:sqlite FTS5 (in-process), L2 is PGlite HNSW (in-process WASM). No HTTP calls. Embedding cache uses the existing local `TrigramEmbedder` (`src/embedder.ts:61–90`).
- **Feature flags default ON (post-re-plan)**: `TIERED_ROUTING_ENABLED` defaults to `true`. The feature is opt-out via `MEGACOMPACT_TIERED_ROUTING=false`. When OFF, `recallAndInline()` and `recallAndInlineAsync()` behave identically to current production (fall through to `searchRecall()`).
- **Non-fatal degradation**: any failure in L0 cache or L1 FTS5 falls through to the next tier. L2 PGlite failure already falls through to sync `search()` (`src/vectorStore.ts:270`). All fallthroughs are logged (see §ERROR-LOGGING CONTRACT).
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's recall path has **no caching** and **no latency-aware routing**. Every recall request pays the full cost regardless of query repetition:

1. **No result caching** — `recallAndInline()` (`src/recall.ts:108–185`) calls `searchRecall()` → `store.search()` (`src/vectorStore.ts:200–270`) which scans every checkpoint's embedding via `cosineSimilarity()` on every call. If the same session asks the same query twice within minutes, the full O(N) scan runs twice.

2. **No embedding cache** — the `TrigramEmbedder.embed()` (`src/embedder.ts:61–90`) runs a full character 3-gram hash + L2 normalize on every query. For repeated queries this is wasted compute.

3. **No tiered fallback** — `searchAsync()` (`src/vectorStore.ts:268–320`) always tries PGlite first, then falls back to sync `search()`. There is no way to short-circuit via a cheap sync check before hitting the async index.

4. **No hit-rate instrumentation** — while `monitoring.ts` tracks dedup decisions per tier, there is no tracking of recall query hit rates, cache effectiveness, or per-tier latency distribution.

The Rust rewrite of radical-memory-mcp has a three-tier query router with Redis (<1ms) → FAISS (5ms CPU) → PostgreSQL (50–100ms), with per-tier hit-rate tracking and session-scoped cache invalidation. We adapt this to our stack — with all measurements taken against real in-process backends, not simulated.

---

## SCOPE

### IN SCOPE (new files):
- `src/tieredRouter.ts` — three-tier recall router (L0 cache → L1 FTS5 → L2 HNSW)
- `src/tieredRouter.test.ts` — unit tests for routing, cache, invalidation, hit-rate tracking, uncalibrated fallback
- `src/store/sqlite/fts5-search.ts` — FTS5 trigram search helper for L1 tier
- `src/store/sqlite/fts5-search.test.ts` — unit tests for FTS5 search
- `scripts/calibrate-fts5.mjs` — calibration script: measures real FTS5 BM25 max on the actual `context_chunks` corpus; writes `~/.pi/mega-compact/calibration.json`

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
  - `TieredRouterConfig` type: `{ enabled, l0TtlMs, l1ConfidenceThreshold, embeddingCacheTtlMs, fts5MaxBm25: number | null, logCadenceQueries }`
  - `TieredRouterMetrics` type: `{ l0Hits, l0Misses, l1Hits, l1Misses, l2Hits, l2Misses, avgLatencyMs: Record<Tier, number>, fts5MaxBm25: number | null, uncalibrated: boolean }`
  - `TieredRouter` class with constructor accepting config + VectorStore; reads `fts5MaxBm25` from `~/.pi/mega-compact/calibration.json` at startup (sets `uncalibrated:true` if absent or `null`)

- [ ] **S44A.2** Implement L0 result cache in `src/tieredRouter.ts`
  - `private l0Cache: Map<string, { results: SearchHit[]; timestamp: number; sessionId: string }>`
  - Cache key: `hash(sessionId + ":" + query)` using `createHash("sha256")` (same pattern as `src/vectorStore.ts:39`)
  - TTL eviction: check `Date.now() - entry.timestamp > config.l0TtlMs` on access
  - Background sweep every 60s (configurable via `TIERED_L0_SWEEP_INTERVAL_MS`, default `60000`) to purge expired entries

- [ ] **S44A.3** Implement embedding cache in `src/tieredRouter.ts`
  - `private embeddingCache: Map<string, { vector: Vector; timestamp: number }>`
  - Key: `hash(queryText)` — same query always gets same embedding
  - TTL: `config.embeddingCacheTtlMs` (default 1h)
  - Wrap `embedder.embed()` — check cache first, store on miss

- [ ] **S44A.4** Add config flags to `src/config/dedup.ts` (~line 30)
  - `TIERED_ROUTING_ENABLED: boolean` (env: `MEGACOMPACT_TIERED_ROUTING`, default: `true` per re-plan)
  - `TIERED_L0_TTL_MS: number` (env: `MEGACOMPACT_TIERED_L0_TTL`, default: `300000`)
  - `TIERED_L0_SWEEP_INTERVAL_MS: number` (env: `MEGACOMPACT_TIERED_L0_SWEEP`, default: `60000`)
  - `TIERED_L1_CONFIDENCE_THRESHOLD: number` (env: `MEGACOMPACT_TIERED_L1_THRESHOLD`, default: `0.8`)
  - `TIERED_EMBEDDING_CACHE_TTL_MS: number` (env: `MEGACOMPACT_TIERED_EMBED_TTL`, default: `3600000`)
  - `TIERED_LOG_CADENCE_QUERIES: number` (env: `MEGACOMPACT_TIERED_LOG_CADENCE`, default: `100`)
  - `FTS5_MAX_BM25: number | null` (env: `MEGACOMPACT_FTS5_MAX_BM25`, default: `null` → read from `calibration.json`; `null` if neither present)

- [ ] **S44A.5** Add L0 cache tests in `src/tieredRouter.test.ts`
  - Test: L0 hit returns cached result without calling L1/L2
  - Test: L0 miss falls through to L1
  - Test: L0 TTL expiry evicts entry
  - Test: embedding cache returns same vector for same query
  - Test: embedding cache TTL expiry re-embeds

- [ ] **S44A.6** Verify: `npm run build && npm test` — all existing tests pass, zero regressions

---

### Sprint S44B: L1 FTS5 Trigram Search Tier + Calibration Contract

**Goal:** Add fast sync FTS5 trigram search as L1 tier between cache and HNSW, with a real calibrated confidence denominator (no magic numbers).

**Acceptance:** L1 returns results in <5ms for sessions with <1000 checkpoints; confidence scoring uses a calibrated `FTS5_MAX_BM25` or falls back to `uncalibrated:true`-logged mode.

**Tasks:**

- [ ] **S44B.1** Create `src/store/sqlite/fts5-search.ts`
  - `searchFTS5(db, sessionId, query, limit)` — FTS5 trigram query against `context_chunks` table
  - Reuse existing FTS5 index on `context_chunks` (created in `src/store/sqlite/schema.ts`)
  - Returns `{ checkpointId, score, snippet }[]` where `score` is the raw FTS5 BM25 rank (un-normalized)
  - Confidence normalization happens in the router (see S44B.3) using `config.fts5MaxBm25` — NOT in this helper

- [ ] **S44B.2** Add `searchFTS5()` method to `VectorStore` (`src/vectorStore.ts`)
  - Public method that delegates to `fts5-search.ts`
  - Returns `SearchHit[]` with raw `score` from FTS5 BM25
  - Used by the tiered router as the L1 tier

- [ ] **S44B.3** Implement L1 tier in `src/tieredRouter.ts` with calibrated confidence
  - On L0 miss: `const t0 = Date.now(); const hits = vectorStore.searchFTS5(sessionId, query, k*2); const l1LatencyMs = Date.now() - t0;` (real measurement)
  - Compute confidence: `const fts5MaxBm25 = config.fts5MaxBm25;` (may be `null`)
  - If `fts5MaxBm25 !== null`: `const confidence = hits.length ? hits[0].score / fts5MaxBm25 : 0;`
  - If `fts5MaxBm25 === null` (uncalibrated): set `uncalibrated:true` in metrics; use conservative fallback gate — pass only if `hits.length > 0 && hits[0].score > 0` (i.e. "any positive BM25 match" — strictly weaker than the calibrated gate, biases toward L2 fallback, which is the safe direction)
  - If `confidence ≥ config.l1ConfidenceThreshold` (calibrated path) OR fallback gate passes: cache to L0, return
  - Else: increment `l1Misses`, fall through to L2

- [ ] **S44B.4** Create `scripts/calibrate-fts5.mjs` — the calibration contract
  - Header comment documents: re-run this script whenever the FTS5 schema, tokenizer (`trigram` vs `unicode61`), or chunking strategy in `src/store/sqlite/schema.ts` changes; otherwise the calibrated max will drift and the L1 confidence gate will mis-route
  - Opens the real node:sqlite DB at `~/.pi/mega-compact/mega-compact.db` (or the configured state dir)
  - Runs a representative set of FTS5 BM25 queries against the actual `context_chunks_trgm` table — covering short queries (1–3 trigrams), medium queries (4–10 trigrams), and long queries (>10 trigrams), drawn from a fixed test set embedded in the script (NOT random — reproducible)
  - Records the maximum observed BM25 score across all queries
  - Writes `{ "fts5MaxBm25": <number>, "calibratedAt": <ISO>, "tokenizer": "trigram", "schemaVersion": <from schema.ts> }` to `~/.pi/mega-compact/calibration.json`
  - Prints a summary to stdout; exits 0 on success, non-zero on DB open failure (so CI/cron can detect)

- [ ] **S44B.5** Add L1 tier tests in `src/tieredRouter.test.ts`
  - Test: L1 high confidence (calibrated) promotes results to L0 cache
  - Test: L1 low confidence (calibrated) falls through to L2
  - Test: L1 with `fts5MaxBm25=null` (uncalibrated) uses fallback gate, sets `uncalibrated:true` in metrics
  - Test: L1 latency is <5ms for 100 checkpoints (real `Date.now()` measurement)
  - Test: L1 returns empty when session has no checkpoints

- [ ] **S44B.6** Verify: `npm run build && npm test`

---

### Sprint S44C: L2 HNSW Async Tier + Routing Logic + Error-Logging Contract

**Goal:** Complete the three-tier cascade with L2 as the async HNSW fallback, plus the full error-logging + gating contract.

**Acceptance:** Full cascade works: L0 → L1 → L2; results cached to L0 after any tier returns; all fallthroughs logged; metrics structurally complete.

**Tasks:**

- [ ] **S44C.1** Implement L2 tier in `src/tieredRouter.ts`
  - On L1 miss: `const t0 = Date.now(); const hits = await vectorStore.searchAsync(sessionId, query, k, opts); const l2LatencyMs = Date.now() - t0;` (real measurement)
  - L2 is async — the router's `route()` method must be `async`
  - Cache L2 results to L0 on return
  - On L2 throw: increment `l2Misses`, log `tier_threw: { tier: "L2", error: e.message }` via `logDecision()` (non-fatal), fall through to sync `searchRecall()` (existing production path)

- [ ] **S44C.2** Implement session-scoped cache invalidation
  - `invalidateSession(sessionId: string)` — remove all L0 entries where `entry.sessionId === sessionId`
  - Called from `extensions/mega-events/context-handler.ts` when new messages arrive
  - Also clears embedding cache entries for that session's queries

- [ ] **S44C.3** Add hit-rate tracking in `src/tieredRouter.ts`
  - Per-tier counters: `hits`, `misses`, `totalLatencyMs` (real accumulated `Date.now()` deltas)
  - `getMetrics()` returns `{ l0: {hits, misses, avgMs}, l1: {...}, l2: {...}, totalQueries, fts5MaxBm25, uncalibrated }`
  - Log to `events.log` every `config.logCadenceQueries` queries (default 100, configurable via `TIERED_LOG_CADENCE_QUERIES`) via `logDecision()` (`src/monitoring.ts:22`)
  - See §ERROR-LOGGING CONTRACT for the full log payload schema

- [ ] **S44C.4** Add monitoring integration to `src/monitoring.ts` (~line 45)
  - `TieredRoutingMetrics` interface added to the monitoring types
  - `logTieredMetrics(metrics)` appends structured event to `events.log` with the schema in §ERROR-LOGGING CONTRACT
  - Dashboard JSON includes tiered routing summary
  - When `uncalibrated:true`, log line includes `note:"run scripts/calibrate-fts5.mjs"`

- [ ] **S44C.5** Add routing tests in `src/tieredRouter.test.ts`
  - Test: L0 miss → L1 miss → L2 hit → cache to L0
  - Test: L0 miss → L1 hit (no L2 call)
  - Test: L0 hit (no L1/L2 calls)
  - Test: session invalidation clears correct entries
  - Test: hit-rate counters increment correctly
  - Test: embedding cache is independent of result cache
  - Test: L1 throw → logged `tier_threw: {tier:"L1"}` → L2 still called
  - Test: L2 throw → logged `tier_threw: {tier:"L2"}` → falls through to `searchRecall()`
  - Test: Router top-level throw → logged `tiered_routing_failed` → falls through to `searchRecall()`

- [ ] **S44C.6** Verify: `npm run build && npm test`

---

### Sprint S44D: Integration + Dashboard

**Goal:** Wire tiered router into recall path and expose metrics on dashboard.

**Acceptance:** `recallAndInline()` uses tiered router when flag is ON; dashboard shows tier hit rates; uncalibrated state is visible.

**Tasks:**

- [ ] **S44D.1** Wire into `recallAndInline()` (`src/recall.ts:108–185`)
  - When `TIERED_ROUTING_ENABLED=true`: call `await tieredRouter.route(sessionId, query, k)` instead of `searchRecall()`
  - TieredRouter instance created lazily (singleton, similar to `getDefaultStore()` in `src/engine.ts:67`)
  - Fallback: if router throws, log `tiered_routing_failed: {error}` and fall through to existing `searchRecall()` (non-fatal)

- [ ] **S44D.2** Wire into `recallAndInlineAsync()` (`src/recall.ts:286–345`)
  - Same pattern: use `tieredRouter.routeAsync()` when flag is ON
  - Router's L2 tier already calls `searchAsync()` internally

- [ ] **S44D.3** Wire session invalidation into context handler
  - `extensions/mega-events/context-handler.ts`: on `before_agent_start` with new messages, call `tieredRouter.invalidateSession(sessionId)`
  - Non-fatal: if router not initialized, skip

- [ ] **S44D.4** Add dashboard API endpoint
  - `GET /api/tiered-routing` in `extensions/dashboard-server/server.ts` (~line 243)
  - Returns tiered routing metrics from the router singleton, including `fts5MaxBm25` and `uncalibrated` fields
  - 404 when `TIERED_ROUTING_ENABLED=false`

- [ ] **S44D.5** Add dashboard tab content (optional, low priority)
  - `extensions/dashboard-client/src/tabs/MetricsTab.tsx`: add tier hit-rate cards
  - Show L0/L1/L2 hit rates, avg latency, total queries, FTS5 max BM25 (with "UNCALIBRATED — run scripts/calibrate-fts5.mjs" badge when `uncalibrated:true`)
  - Simple bar chart using existing recharts dependency

- [ ] **S44D.6** Full regression test with flag OFF and ON
  - `MEGACOMPACT_TIERED_ROUTING=false npm test` — zero behavior change
  - `MEGACOMPACT_TIERED_ROUTING=true npm test` — all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

## CALIBRATION

The L1 confidence gate depends on `FTS5_MAX_BM25` — the maximum BM25 score the FTS5 trigram index can produce on this corpus. The original spec hardcoded `~0.6`, an invented magic number. The re-plan replaces it with a real, reproducible calibration procedure:

1. **Script:** `scripts/calibrate-fts5.mjs` (added in S44B.4)
2. **What it measures:** runs a fixed, reproducible query set (short / medium / long trigram counts) against the real `context_chunks_trgm` table in the user's actual state dir, records the max observed BM25 score.
3. **Output:** writes `~/.pi/mega-compact/calibration.json`:
   ```json
   { "fts5MaxBm25": <number>, "calibratedAt": "<ISO>", "tokenizer": "trigram", "schemaVersion": <n> }
   ```
4. **Router startup:** reads `calibration.json`; if absent or `fts5MaxBm25: null`, sets `uncalibrated:true` and uses the conservative fallback gate (S44B.3). Non-fatal — recall still works, just with a weaker L1 gate biased toward L2 fallback.
5. **Env override:** `MEGACOMPACT_FTS5_MAX_BM25=<number>` takes precedence over the file (for testing/benchmarks).
6. **When to re-run** (documented in the script header): whenever the FTS5 schema, tokenizer (`trigram` vs `unicode61`), or chunking strategy in `src/store/sqlite/schema.ts` changes. Otherwise the calibrated max drifts and the L1 confidence gate mis-routes.
7. **CI/cron:** script exits non-zero on DB open failure, so it can be wired into a periodic check or pre-release gate to detect drift.

---

## ERROR-LOGGING CONTRACT

All tiered-routing log lines are written via `logDecision()` (`src/monitoring.ts:22`) to `events.log` as structured JSON. The contract:

### Gating
- The entire router is gated on `TIERED_ROUTING_ENABLED` (default `true` post-re-plan). When `false`, the router is never instantiated; `recallAndInline()` calls `searchRecall()` directly. Zero tiered-routing log lines are produced.

### `logTieredMetrics` payload (every `logCadenceQueries` queries, default 100)
```json
{
  "event": "tiered_routing_metrics",
  "l0Hits": <int>,
  "l0Misses": <int>,
  "l1Hits": <int>,
  "l1Misses": <int>,
  "l2Hits": <int>,
  "l2Misses": <int>,
  "avgLatencyMs": { "l0": <number>, "l1": <number>, "l2": <number> },
  "totalQueries": <int>,
  "fts5MaxBm25": <number | null>,
  "uncalibrated": <boolean>,
  "note": "run scripts/calibrate-fts5.mjs"   // present ONLY when uncalibrated:true
}
```
All latency values are real `Date.now()` deltas accumulated per tier. All hit/miss counters are real booleans derived from actual tier return values.

### Tier-threw log (non-fatal, per-occurrence)
```json
{ "event": "tier_threw", "tier": "L0" | "L1" | "L2", "error": "<message>" }
```
After logging, the router falls through to the next tier (L0→L1→L2). If L2 throws, falls through to sync `searchRecall()`.

### Router-threw log (non-fatal, per-occurrence)
```json
{ "event": "tiered_routing_failed", "error": "<message>" }
```
After logging, the caller (`recallAndInline()` / `recallAndInlineAsync()`) falls through to the existing `searchRecall()` path. Recall still works — just without the tiered speedups.

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF**: `TIERED_ROUTING_ENABLED=false` produces identical results to current production. All existing tests pass unchanged.
2. **Gate default ON**: `TIERED_ROUTING_ENABLED` defaults to `true`; the feature is opt-out.
3. **Real latency instrumentation**: every per-tier latency is a real `Date.now()` delta measured around the actual tier call. No synthetic or simulated latency values exist anywhere in the router.
4. **FTS5 max is calibrated, not magic**: `FTS5_MAX_BM25` is either (a) read from `~/.pi/mega-compact/calibration.json` produced by `scripts/calibrate-fts5.mjs` measuring the real corpus, (b) overridden via `MEGACOMPACT_FTS5_MAX_BM25` env, or (c) `null` with `uncalibrated:true` logged and the conservative fallback gate active. The invented `~0.6` constant is gone.
5. **Uncalibrated state is explicit**: when `fts5MaxBm25` is `null`, the `logTieredMetrics` payload includes `"uncalibrated": true` and `"note": "run scripts/calibrate-fts5.mjs"`; the dashboard shows an "UNCALIBRATED" badge.
6. **Error-logging contract**: tier-threw → `tier_threw` log + fall through to next tier; router-threw → `tiered_routing_failed` log + fall through to `searchRecall()`. All non-fatal.
7. **Cache hit returns in <1ms**: L0 cache hit for a repeated query returns the same `SearchHit[]` without calling any search function.
8. **L1 FTS5 returns in <5ms**: For sessions with <1000 checkpoints, FTS5 trigram search completes in <5ms (real measurement).
9. **Full cascade works**: L0 miss → L1 miss → L2 HNSW → result cached to L0 for next call.
10. **Session invalidation**: New messages for a session clear that session's L0 cache entries.
11. **Hit-rate tracking**: Per-tier counters (hits, misses, avg_latency_ms) are logged every `logCadenceQueries` queries (default 100, configurable).
12. **Non-fatal degradation**: Any tier failure falls through to the next tier. Router failure falls through to existing `searchRecall()`.
13. **Embedding cache**: Same query text returns the same embedding vector without re-computation (within TTL).
14. **Calibration re-run documented**: `scripts/calibrate-fts5.mjs` header documents that the script must be re-run on FTS5 schema, tokenizer, or chunking strategy change.

---

## ROLLBACK

1. Set `MEGACOMPACT_TIERED_ROUTING=false` to disable the entire feature.
2. All new code is in new files (`src/tieredRouter.ts`, `src/store/sqlite/fts5-search.ts`, `scripts/calibrate-fts5.mjs`).
3. Integration points in `src/recall.ts` are gated behind `if (config.TIERED_ROUTING_ENABLED)`.
4. Dashboard endpoint returns 404 when disabled — no stale data.
5. No database migrations required — FTS5 index already exists on `context_chunks`.
6. `~/.pi/mega-compact/calibration.json` is safe to delete (router falls back to `uncalibrated:true` mode).

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| L0 cache serves stale results after dedup changes | Medium | Medium | Session invalidation on new messages; TTL=5min bounds staleness |
| FTS5 trigram search has low confidence for semantic queries | Medium | Low | L1 low confidence falls through to L2 HNSW — no recall loss |
| FTS5 BM25 max drifts after schema/tokenizer/chunking change (was: invented `~0.6` magic number) | Medium | Medium | **RESOLVED via `scripts/calibrate-fts5.mjs`** — measures real FTS5 BM25 max on the actual `context_chunks` corpus; writes `~/.pi/mega-compact/calibration.json`; script header documents re-run on schema/tokenizer/chunking change; `uncalibrated:true` logged fallback when not yet calibrated |
| Embedding cache grows unbounded in long sessions | Low | Low | TTL=1h + background sweep; max ~1000 entries typical |
| L2 PGlite timeout causes slow recall | Low | Medium | Existing timeout guard in `searchAsync()` (`src/vectorStore.ts:270`) already handles this |
| Cache key collision (hash of query text) | Very Low | Very Low | SHA-256 truncated to 16 hex — collision probability ~2^-64 |
| Calibrated `FTS5_MAX_BM25` is stale relative to a growing corpus | Low | Low | Conservative L1 threshold (0.8) tolerates drift; re-running the script periodically or on schema change refreshes the value; `uncalibrated:true` mode is the safe fallback |
