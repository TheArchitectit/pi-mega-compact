# S31 — CRAG Quality Metrics (Diversity & Coverage)

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S27 (self-RAG quality gate), S28 (RAPTOR multi-level retrieval), `src/vectorStore.ts`, `src/recall.ts`, `src/monitoring.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): CRAG metrics are additive — they evaluate *already-retrieved* `SearchHit[]` and optionally trigger re-retrieval with expanded queries. The anchor-floor guard in `src/boundary.ts:computeDropRange()` is never touched.
- **PREVENT-PI-003** (no system role): recall blocks are injected via the existing `before_agent_start` systemPrompt prepend path. CRAG changes *which* hits pass quality checks, not *how* they're injected.
- **PREVENT-PI-004** (no network): all quality metrics (relevance, coverage, diversity, specificity) are pure in-process math — cosine similarity, term overlap, pairwise dissimilarity. Query expansion uses local TrigramEmbedder re-embedding. No HTTP calls.
- **Feature flags default OFF**: `CRAG_METRICS_ENABLED` and `CRAG_EXPANSION_ENABLED` default to `false`. Zero behavior change unless explicitly enabled.
- **Non-fatal**: quality evaluation and expansion are best-effort. If metrics computation fails, the original recall result is returned unchanged.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's recall path **never evaluates the quality of retrieved results**. It grabs top-K checkpoints and injects them, but has no way to detect failure modes:

1. **Low diversity** — if all top-K checkpoints are about the same subtopic (e.g., all 5 are about "JWT token expiry"), the recall block is redundant. MMR reranking (`src/vectorStore.ts:245–255`) helps but doesn't measure whether diversity was actually achieved.

2. **Low coverage** — if the query mentions "authentication AND database" but all retrieved chunks are about authentication only, the database aspect is missing. No detection, no recovery.

3. **Low relevance** — when the vector store has few checkpoints, top-K may return weakly relevant results. The cosine scores are available (`SearchHit.score`) but never evaluated against a quality floor.

4. **No recovery mechanism** — S27 (self-RAG quality gate) evaluates recall quality via word-overlap critique on the *injected block*. But it evaluates at the block level after formatting. CRAG evaluates at the *result set* level before formatting, and can trigger re-retrieval with expanded queries.

5. **No quality telemetry** — there is no logging of recall quality metrics over time. We can't answer "what fraction of recall requests produce diverse, relevant results?"

The Python radical-memory-mcp has a CRAG (Corrective RAG) implementation that evaluates retrieval quality on 4 metrics and triggers fallback strategies when quality is LOW.

---

## SCOPE

### IN SCOPE (new files):
- `src/recallMetrics.ts` — quality metric computation (relevance, coverage, diversity, specificity)
- `src/recallMetrics.test.ts` — unit tests for all metrics
- `src/queryExpansion.ts` — query expansion strategies for low-quality recall
- `src/queryExpansion.test.ts` — unit tests for expansion

### IN SCOPE (modified files):
- `src/recall.ts` — run `evaluateRecall()` after `searchRecall()` returns, optionally trigger re-retrieval (~line 133)
- `src/vectorStore.ts` — expose embedding vectors on `SearchHit` for diversity computation (~line 50)
- `src/config/dedup.ts` — add CRAG config flags (~line 30)
- `src/monitoring.ts` — add CRAG quality metrics event type (~line 22)
- `extensions/dashboard-server/server.ts` — add `/api/recall-quality` endpoint

### OUT OF SCOPE:
- Changes to `src/engine.ts` — CRAG operates on the recall path only, not compaction.
- Changes to dedup tiers — quality metrics evaluate recall results, not storage dedup.
- LLM-based quality evaluation — all metrics are deterministic, compute-only.

---

## EXECUTION

### Sprint S31A: Core Quality Metrics

**Goal:** Implement the four quality metrics: relevance, coverage, diversity, specificity.

**Acceptance:** Each metric returns a [0, 1] score. Composite evaluation produces `{ pass, score, breakdown, recommendation }`.

**Tasks:**

- [ ] **S31A.1** Create `src/recallMetrics.ts` with types
  - `RecallQualityBreakdown` type: `{ relevance: number; coverage: number; diversity: number; specificity: number }`
  - `RecallQualityResult` type: `{ pass: boolean; score: number; breakdown: RecallQualityBreakdown; recommendation: string | null }`
  - `RecallQualityConfig` type: `{ minDiversity, minCoverage, minRelevance }`

- [ ] **S31A.2** Implement `relevance(query, hits)` metric
  - Average of `SearchHit.score` (cosine similarity already computed in `src/vectorStore.ts:215`)
  - Normalized to [0, 1] — scores already in this range for normalized embeddings
  - High relevance = all hits are strongly related to the query

- [ ] **S31A.3** Implement `coverage(query, hits)` metric
  - Extract query terms: tokenize on whitespace, lowercase, remove stopwords (the, a, is, and, or, of, to, in, for, on, at)
  - For each query term: check if it appears in *any* hit's `checkpoint.summary` (case-insensitive substring match)
  - Coverage = (terms found in at least one hit) / (total query terms)
  - Edge case: 0 query terms after stopword removal → coverage = 1.0

- [ ] **S31A.4** Implement `diversity(hits)` metric
  - For each pair of hits (i, j) where i < j: compute `1 - cosineSimilarity(hits[i].checkpoint.embedding, hits[j].checkpoint.embedding)`
  - Diversity = average of all pairwise dissimilarities
  - Range [0, 1]: 0 = all identical, 1 = all orthogonal
  - Edge case: 0 or 1 hits → diversity = 1.0 (nothing to compare)

- [ ] **S31A.5** Implement `specificity(hits)` metric
  - Measure average chunk length as a proxy for information density
  - Normalize: optimal range is 100–500 tokens; below 50 = too short (low specificity), above 1000 = too verbose
  - `specificity = clamp(0, 1, avgTokenEstimate / 300)` with diminishing returns above 500

- [ ] **S31A.6** Implement `evaluateRecall(query, hits, config)` composite
  - Weighted average: `score = 0.35 * relevance + 0.25 * coverage + 0.25 * diversity + 0.15 * specificity`
  - `pass = score >= 0.4 AND breakdown.relevance >= minRelevance AND breakdown.coverage >= minCoverage AND breakdown.diversity >= minDiversity`
  - `recommendation`: generate human-readable advice string based on which metric is lowest
    - diversity < 0.3 → "chunks are too similar — consider expanding K or using MMR"
    - coverage < 0.4 → "query terms not well covered — consider query expansion"
    - relevance < 0.5 → "chunks may be irrelevant — consider stricter threshold"
    - overall < 0.4 → "quality is low — recommend re-retrieval with expanded query"

- [ ] **S31A.7** Add tests in `src/recallMetrics.test.ts`
  - Test: diverse chunks score high on diversity (>0.7)
  - Test: similar chunks score low on diversity (<0.3)
  - Test: full query term coverage scores 1.0
  - Test: partial coverage scores proportionally
  - Test: empty hits returns score 0 with recommendation
  - Test: single hit returns diversity 1.0
  - Test: composite score weights are applied correctly
  - Test: recommendation text matches lowest metric

- [ ] **S31A.8** Verify: `npm run build && npm test`

---

### Sprint S31B: Query Expansion Strategies

**Goal:** Implement query expansion for low-quality recall results.

**Acceptance:** Expansion produces modified queries that retrieve different results. Re-retrieval with expanded query returns higher-quality results.

**Tasks:**

- [ ] **S31B.1** Create `src/queryExpansion.ts` with strategies
  - `expandQuery(originalQuery, breakdown, currentHits)` → `string[]` (list of expanded queries to try)
  - Strategy 1 — **MMR expansion**: if diversity < 0.3, increase MMR lambda by 0.2 and re-retrieve
  - Strategy 2 — **term extraction**: extract key terms from current hits' summaries that are NOT in the original query; append top-2 as additional query terms
  - Strategy 3 — **broaden query**: remove low-idf terms (terms that appear in >50% of checkpoints) from the query to reduce bias toward common themes

- [ ] **S31B.2** Implement MMR expansion
  - Return `{ strategy: "mmr", mmrLambda: currentLambda + 0.2 }` — caller adjusts MMR parameter
  - Only applicable when diversity is the bottleneck

- [ ] **S31B.3** Implement term extraction expansion
  - Tokenize all current hit summaries
  - Count term frequencies across hits
  - Select terms that appear in ≥2 hits but NOT in the original query
  - Return top-2 as additional query terms
  - Expanded query: `originalQuery + " " + newTerms.join(" ")`

- [ ] **S31B.4** Implement broaden-query expansion
  - Compute term frequencies across ALL checkpoints in the session
  - Remove terms that appear in >50% of checkpoints (too common to be discriminative)
  - If query becomes empty after removal, skip this strategy

- [ ] **S31B.5** Add tests in `src/queryExpansion.test.ts`
  - Test: MMR expansion returns higher lambda
  - Test: term extraction adds relevant terms from hit summaries
  - Test: broaden query removes common terms
  - Test: expansion returns empty when no strategy applies
  - Test: expanded query is always different from original

- [ ] **S31B.6** Verify: `npm run build && npm test`

---

### Sprint S31C: Integration into Recall Path

**Goal:** Wire CRAG quality evaluation into `recallAndInline()` with optional auto-expansion.

**Acceptance:** When `CRAG_METRICS_ENABLED=true`, every recall evaluates quality. When `CRAG_EXPANSION_ENABLED=true` and quality is LOW, re-retrieve with expanded query.

**Tasks:**

- [ ] **S31C.1** Add config flags to `src/config/dedup.ts` (~line 30)
  - `CRAG_METRICS_ENABLED: boolean` (env: `MEGACOMPACT_CRAG_METRICS`, default: `false`)
  - `CRAG_EXPANSION_ENABLED: boolean` (env: `MEGACOMPACT_CRAG_EXPANSION`, default: `false`)
  - `CRAG_MIN_DIVERSITY: number` (env: `MEGACOMPACT_CRAG_MIN_DIVERSITY`, default: `0.3`)
  - `CRAG_MIN_COVERAGE: number` (env: `MEGACOMPACT_CRAG_MIN_COVERAGE`, default: `0.4`)
  - `CRAG_MIN_RELEVANCE: number` (env: `MEGACOMPACT_CRAG_MIN_RELEVANCE`, default: `0.5`)

- [ ] **S31C.2** Integrate into `recallAndInline()` (`src/recall.ts:108–185`)
  - After `searchRecall()` returns `hits` (~line 133): if `CRAG_METRICS_ENABLED`, call `evaluateRecall(opts.query, hits, cragConfig)`
  - Log quality result to events.log via `logDecision()` (`src/monitoring.ts:22`)
  - If `!result.pass && CRAG_EXPANSION_ENABLED`: call `expandQuery()` and re-retrieve via `searchRecall()` with expanded query
  - Merge expanded results with original (dedup by checkpointId), take top-K
  - Re-evaluate merged set; if still low quality, use original results (don't loop)

- [ ] **S31C.3** Integrate into `recallAndInlineAsync()` (`src/recall.ts:286–345`)
  - Same pattern as sync path
  - Expansion + re-retrieval uses `store.searchAsync()` for the expanded query

- [ ] **S31C.4** Add monitoring event type in `src/monitoring.ts` (~line 22)
  - `RecallQualityEvent` type: `{ ts, sessionId, score, breakdown, expanded: boolean, reRetrieved: boolean }`
  - `logRecallQuality()` function appends to events.log

- [ ] **S31C.5** Add integration tests in `src/recallMetrics.test.ts`
  - Test: recall with high-quality results passes without expansion
  - Test: recall with low-quality results triggers expansion when flag is ON
  - Test: expansion improves quality score
  - Test: expansion does NOT trigger when flag is OFF
  - Test: failed expansion gracefully returns original results

- [ ] **S31C.6** Full regression test
  - `MEGACOMPACT_CRAG_METRICS=false npm test` — zero behavior change
  - `MEGACOMPACT_CRAG_METRICS=true npm test` — all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

### Sprint S31D: Dashboard Quality Telemetry

**Goal:** Surface CRAG quality metrics on the dashboard.

**Acceptance:** Dashboard shows recall quality trends; API returns quality breakdown.

**Tasks:**

- [ ] **S31D.1** Add dashboard API endpoint
  - `GET /api/recall-quality` in `extensions/dashboard-server/server.ts` (~line 243)
  - Returns: `{ totalRecalls, passRate, avgScore, avgBreakdown: { relevance, coverage, diversity, specificity }, expansionsTriggered }`
  - Computed from recent events.log entries (last 100 recall quality events)
  - 404 when `CRAG_METRICS_ENABLED=false`

- [ ] **S31D.2** Add quality metrics to MetricsTab
  - `extensions/dashboard-client/src/tabs/MetricsTab.tsx`: add recall quality card
  - Show: pass rate (%), avg score, breakdown bar chart (4 metrics)
  - Show: expansion trigger count
  - Uses existing recharts dependency

- [ ] **S31D.3** Verify: dashboard loads without errors when feature is OFF (404 handled gracefully)

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF**: `CRAG_METRICS_ENABLED=false` (default) produces identical results to current production.
2. **Metrics are accurate**: diverse chunks score >0.7 on diversity; identical chunks score <0.3; full term coverage scores 1.0.
3. **Composite evaluation works**: `evaluateRecall()` returns `{ pass, score, breakdown, recommendation }` with all fields populated.
4. **Expansion improves quality**: when quality is LOW and expansion is enabled, the expanded query retrieves better results.
5. **No infinite loops**: expansion runs at most once per recall request. If expanded results are still low quality, original results are used.
6. **Quality telemetry**: every recall logs quality metrics to events.log when flag is ON.
7. **Dashboard integration**: `/api/recall-quality` returns aggregated quality metrics.

---

## ROLLBACK

1. Set `MEGACOMPACT_CRAG_METRICS=false` to disable quality evaluation.
2. Set `MEGACOMPACT_CRAG_EXPANSION=false` to disable auto-expansion.
3. All new code is in new files (`src/recallMetrics.ts`, `src/queryExpansion.ts`).
4. Integration points in `src/recall.ts` are gated behind `if (config.CRAG_METRICS_ENABLED)`.
5. No database migrations required.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Quality metrics add latency to every recall | Medium | Low | Metrics are pure math (cosine + term overlap); <1ms overhead |
| Expansion produces worse results than original | Low | Medium | Re-evaluate after expansion; use original if expanded is worse |
| Coverage metric is too simplistic (term overlap) | Medium | Low | Weighted combination with other 3 metrics; trigram embedder handles synonyms |
| Diversity metric O(n²) for large K | Low | Low | K is typically 3–5; O(n²) = O(25) max; negligible |
| Query expansion adds LLM-like behavior (expensive) | Low | Low | No LLM calls — all expansion is deterministic term extraction |
