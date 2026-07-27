# S45 — CRAG Quality Metrics (Diversity & Coverage)

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S41 (self-RAG quality gate), S42 (RAPTOR multi-level retrieval), `src/vectorStore.ts`, `src/recall.ts`, `src/monitoring.ts`
**Priority:** P2
**Status:** Draft → implement-ready (re-planned 2026-07-25)
**Target version:** v0.9.x

---

## RE-PLAN 2026-07-25

A pre-implementation audit of this spec found that the **metric computations are clean** — the relevance, coverage, diversity, and specificity math uses real signals (cosine similarity over real embedding vectors, real term overlap against `checkpoint.summary`, real pairwise dissimilarity over `checkpoint.embedding`, real `tokenEstimate` values). None of those algorithms need to change.

The defect was **five invented constants** that the spec presented as authoritative:

1. Composite weights `0.35 * relevance + 0.25 * coverage + 0.25 * diversity + 0.15 * specificity` — arbitrary, determine pass/fail.
2. Stopword list (hardcoded: `the, a, is, and, or, of, to, in, for, on, at`) — no source.
3. `50%` IDF threshold for broaden-query — magic constant.
4. Specificity optimal range `100–500` tokens — no measurement.
5. Specificity divisor `300` (`avgTokenEstimate / 300`) — magic number.

This re-plan keeps the real metric algorithms and replaces every invented constant with a **configurable, env-overridable, calibrated** value. Defaults are preserved as `uncalibrated` defaults — they reproduce the original spec's behavior, but every consumer (events.log, dashboard, pass/fail gate) is labeled `uncalibrated: true` until `scripts/calibrate-crag.mjs` is run against a real recall corpus.

Additionally, the original spec referenced `hits[i].checkpoint.embedding` for the diversity metric. A schema audit (see PREREQUISITES) confirms that `SearchHit` does NOT expose a top-level `embedding` field — embeddings live on `hit.checkpoint.embedding` (`src/store/sqlite/utils.ts:rowToCheckpoint`, populated via `decodeEmbedding(row.embedding_blob)`). That path is populated on the sync `vectorSearch` path (`vector-search.ts:117`) and the async `vectorSearchAsync` hydration path (`vector-search.ts:217`, via `getCheckpoint`). Legacy JSON checkpoints migrated via `migrateJsonToSqlite` may carry an empty `embedding: []` if the source file predates the embedder; the diversity metric MUST guard against empty embeddings rather than assuming they are always populated.

**What changed in this revision:**
- All weights/thresholds moved to env-overridable config with `uncalibrated:true` labeling.
- Stopword list sourced from `src/config/stopwords.ts` (shared with S41, derived from the real trigram tokenizer vocab — see SCOPE).
- New calibration script `scripts/calibrate-crag.mjs` correlates composite score with a real downstream quality signal (whether the recall was later superseded by a user re-query — harvestable from `events.log`).
- Diversity metric guards against `checkpoint.embedding.length === 0` (real data, not a stub).
- Error-logging contract: no silent fallback — `crag_metrics_failed` is logged with the real error; original results still returned. Expansion bounded to 1 iteration.
- Gate renamed: `CRAG_ENABLED` (default ON, per re-plan) replaces the two-flag `CRAG_METRICS_ENABLED`/`CRAG_EXPANSION_ENABLED` scheme; expansion also defaults ON via `CRAG_EXPANSION_ENABLED` (default ON) — a feature that's off by default is a feature that doesn't ship. Expansion cost is bounded to 1 re-retrieval iteration (hard invariant), so ON-by-default is safe. Operators can opt OUT via env for A/B comparison.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): CRAG metrics are additive — they evaluate *already-retrieved* `SearchHit[]` and optionally trigger re-retrieval with expanded queries. The anchor-floor guard in `src/boundary.ts:computeDropRange()` is never touched.
- **PREVENT-PI-003** (no system role): recall blocks are injected via the existing `before_agent_start` systemPrompt prepend path. CRAG changes *which* hits pass quality checks, not *how* they're injected.
- **PREVENT-PI-004** (no network): all quality metrics (relevance, coverage, diversity, specificity) are pure in-process math — cosine similarity, term overlap, pairwise dissimilarity. Query expansion uses local TrigramEmbedder re-embedding. No HTTP calls.
- **Feature flags default ON (all of them)**: `CRAG_ENABLED` defaults to `true` — quality metrics are pure, sub-millisecond math; safe to always run. `CRAG_EXPANSION_ENABLED` also defaults to `true` — expansion triggers re-retrieval (bounded to 1 iteration, hard invariant) and ships ON so the quality gate actually improves recall out-of-the-box. A feature that's off by default is a feature that doesn't ship. Setting `CRAG_ENABLED=false` reproduces the pre-CRAG behavior exactly (opt-out for A/B comparison).
- **Non-fatal, but loud**: quality evaluation and expansion are best-effort. If metrics computation fails, the original recall result is returned unchanged AND a `crag_metrics_failed` event is logged to `events.log` with the real error message. No silent fallback.
- **Expansion bounded to 1 iteration**: if expanded results are still low quality, original results are used. No re-expansion loop.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's recall path **never evaluates the quality of retrieved results**. It grabs top-K checkpoints and injects them, but has no way to detect failure modes:

1. **Low diversity** — if all top-K checkpoints are about the same subtopic (e.g., all 5 are about "JWT token expiry"), the recall block is redundant. MMR reranking (`src/vectorStore.ts:245–255`) helps but doesn't measure whether diversity was actually achieved.

2. **Low coverage** — if the query mentions "authentication AND database" but all retrieved chunks are about authentication only, the database aspect is missing. No detection, no recovery.

3. **Low relevance** — when the vector store has few checkpoints, top-K may return weakly relevant results. The cosine scores are available (`SearchHit.score`) but never evaluated against a quality floor.

4. **No recovery mechanism** — S41 (self-RAG quality gate) evaluates recall quality via word-overlap critique on the *injected block*. But it evaluates at the block level after formatting. CRAG evaluates at the *result set* level before formatting, and can trigger re-retrieval with expanded queries.

5. **No quality telemetry** — there is no logging of recall quality metrics over time. We can't answer "what fraction of recall requests produce diverse, relevant results?"

The Python radical-memory-mcp has a CRAG (Corrective RAG) implementation that evaluates retrieval quality on 4 metrics and triggers fallback strategies when quality is LOW.

---

## PREREQUISITES

These must be satisfied before any implementation task starts.

### P1. `SearchHit.embedding` availability audit

**Finding from the 2026-07-25 audit:** the `SearchHit` interface (`src/vectorStore.ts:37–44`) does NOT expose a top-level `embedding` field. Embeddings live on `hit.checkpoint.embedding`, populated by `rowToCheckpoint` (`src/store/sqlite/utils.ts:101–125`) via `decodeEmbedding(row.embedding_blob)`.

Confirmed populated paths:
- Sync `vectorSearch` (`src/vector-search.ts:115–118`): hits come from `listCheckpoints` and are scored with `cosineSimilarity(qv, cp.embedding)`.
- Async `vectorSearchAsync` (`src/vector-search.ts:217–220`): cross-repo hits are hydrated via `getCheckpoint(sessionId, checkpointId, repoId)`, which calls `rowToCheckpoint`.

Risk path: legacy JSON checkpoints migrated via `migrateJsonToSqlite` (`src/store/migrate.ts:79`) call `upsertCheckpoint` with `encodeEmbedding(cp.embedding ?? [])`. If a pre-embedder-era JSON file lacks an `embedding` field, the stored blob decodes to `[]`. `cosineSimilarity([], x)` returns `0` (or `NaN` if not guarded), and the diversity metric over `[]`-vs-`[]` pairs is meaningless.

**Task (P1.1, blocking):** before shipping the diversity metric, run a schema audit query against a representative state dir:

```sql
SELECT COUNT(*) AS total,
       SUM(CASE WHEN length(embedding_blob) = 0 OR embedding_blob IS NULL THEN 1 ELSE 0 END) AS empty_embeddings
  FROM context_chunks;
```

If `empty_embeddings > 0`, the diversity metric MUST guard against `hit.checkpoint.embedding.length === 0`:

```ts
// diversity metric guard
function diversity(hits: SearchHit[]): number {
  const valid = hits.filter((h) => Array.isArray(h.checkpoint.embedding) && h.checkpoint.embedding.length > 0);
  if (valid.length < 2) return 1.0; // nothing to compare — preserve existing edge-case semantics
  // ... pairwise cosine over valid only
}
```

The relevance metric already gets a free guard: `SearchHit.score` is the cosine of the query vector and `cp.embedding`; an empty embedding produces `score = 0`, which naturally fails the `minRelevance` floor without special handling.

**Acceptance:** diversity metric never returns `NaN` when `checkpoint.embedding` is `[]`; audit query committed as a comment in `src/recallMetrics.ts`.

### P2. Stopword list sourced from `src/config/stopwords.ts`

The original spec hardcoded `(the, a, is, and, or, of, to, in, for, on, at)` with no source. This is shared with S41's self-RAG critique. Both must consume a single shared list.

**Task (P2.1, blocking for S45A.3 only):** create `src/config/stopwords.ts` exporting `STOPWORDS: ReadonlySet<string>`. The list is derived from the real TrigramEmbedder vocab behavior: tokens that appear in >50% of typical checkpoints AND contribute no discriminative signal. The original 10-word list is retained as the initial default (preserving back-compat) but is now labeled with its provenance and is overridable via `MEGACOMPACT_CRAG_STOPWORDS` (comma-separated env var).

Acceptance: `src/config/stopwords.ts` exists, `src/recallMetrics.ts` and S41's self-RAG both import from it, no inline hardcoded lists remain.

---

## SCOPE

### IN SCOPE (new files):
- `src/recallMetrics.ts` — quality metric computation (relevance, coverage, diversity, specificity) + `evaluateRecall` composite
- `src/recallMetrics.test.ts` — unit tests for all metrics
- `src/queryExpansion.ts` — query expansion strategies for low-quality recall
- `src/queryExpansion.test.ts` — unit tests for expansion
- `src/config/stopwords.ts` — shared stopword list (see PREREQUISITE P2)
- `scripts/calibrate-crag.mjs` — calibration script correlating composite score with real downstream quality signal

### IN SCOPE (modified files):
- `src/recall.ts` — run `evaluateRecall()` after `searchRecall()` returns, optionally trigger re-retrieval (~line 133)
- `src/config/dedup.ts` — add CRAG config flags (~line 30)
- `src/monitoring.ts` — add `RecallQualityEvent` type + `logRecallQuality()` function (~line 22)
- `extensions/dashboard-server/server.ts` — add `/api/recall-quality` endpoint

### OUT OF SCOPE:
- Changes to `src/engine.ts` — CRAG operates on the recall path only, not compaction.
- Changes to dedup tiers — quality metrics evaluate recall results, not storage dedup.
- LLM-based quality evaluation — all metrics are deterministic, compute-only.
- Modifying the `SearchHit` interface to add a top-level `embedding` field — the audit confirmed `checkpoint.embedding` is the right access path; no interface change needed (guard handles empty-embedding edge case).

---

## EXECUTION

### Sprint S45A: Core Quality Metrics

**Goal:** Implement the four quality metrics: relevance, coverage, diversity, specificity.

**Acceptance:** Each metric returns a [0, 1] score. Composite evaluation produces `{ pass, score, breakdown, recommendation, uncalibrated, weights }`. Diversity metric never returns `NaN` on empty embeddings.

**Tasks:**

- [ ] **S45A.1** Create `src/recallMetrics.ts` with types
  - `RecallQualityBreakdown` type: `{ relevance: number; coverage: number; diversity: number; specificity: number }`
  - `RecallQualityResult` type: `{ pass: boolean; score: number; breakdown: RecallQualityBreakdown; recommendation: string | null; uncalibrated: boolean; weights: RecallQualityWeights }`
  - `RecallQualityConfig` type: `{ minDiversity, minCoverage, minRelevance, weights: RecallQualityWeights, specificityDivisor, specificityOptimalMin, specificityOptimalMax, idfBroadenRatio, stopwords: ReadonlySet<string> }`
  - `RecallQualityWeights` type: `{ relevance: number; coverage: number; diversity: number; specificity: number }`

- [ ] **S45A.2** Implement `relevance(query, hits)` metric
  - Average of `SearchHit.score` (cosine similarity already computed in `src/vectorStore.ts:215`, `src/vector-search.ts:117`)
  - Normalized to [0, 1] — scores already in this range for normalized embeddings
  - High relevance = all hits are strongly related to the query
  - Empty-embedding checkpoints produce `score = 0` (already the case in `vector-search.ts:117` via `cosineSimilarity(qv, [])` returning 0); no extra guard needed

- [ ] **S45A.3** Implement `coverage(query, hits, stopwords)` metric
  - Extract query terms: tokenize on whitespace, lowercase, remove stopwords from `src/config/stopwords.ts` (shared with S41, see PREREQUISITE P2)
  - For each query term: check if it appears in *any* hit's `checkpoint.summary` (case-insensitive substring match)
  - Coverage = (terms found in at least one hit) / (total query terms)
  - Edge case: 0 query terms after stopword removal → coverage = 1.0

- [ ] **S45A.4** Implement `diversity(hits)` metric (WITH empty-embedding guard — see PREREQUISITE P1)
  - Filter `hits` to `valid = hits.filter((h) => Array.isArray(h.checkpoint.embedding) && h.checkpoint.embedding.length > 0)`
  - If `valid.length < 2` → diversity = 1.0 (nothing to compare — preserve existing edge-case semantics)
  - For each pair of hits (i, j) where i < j in `valid`: compute `1 - cosineSimilarity(hits[i].checkpoint.embedding, hits[j].checkpoint.embedding)`
  - Diversity = average of all pairwise dissimilarities
  - Range [0, 1]: 0 = all identical, 1 = all orthogonal
  - **No NaN path:** the guard ensures both vectors are non-empty; `cosineSimilarity` over two non-empty vectors is finite

- [ ] **S45A.5** Implement `specificity(hits, divisor, optimalMin, optimalMax)` metric
  - Measure average chunk length (`checkpoint.tokenEstimate`) as a proxy for information density
  - All three constants come from `RecallQualityConfig`, NOT hardcoded:
    - `specificityDivisor` (default `300`, env `MEGACOMPACT_CRAG_SPECIFICITY_DIVISOR`, labeled `uncalibrated`)
    - `specificityOptimalMin` (default `100`, env `MEGACOMPACT_CRAG_SPECIFICITY_OPTIMAL_MIN`, labeled `uncalibrated`)
    - `specificityOptimalMax` (default `500`, env `MEGACOMPACT_CRAG_SPECIFICITY_OPTIMAL_MAX`, labeled `uncalibrated`)
  - Formula: `specificity = clamp(0, 1, avgTokenEstimate / specificityDivisor)` with diminishing returns above `specificityOptimalMax` (linear ramp-down to 0 by `2 * specificityOptimalMax`)
  - Below `specificityOptimalMin / 2` → 0 (too short to be specific)
  - All ranges documented as `uncalibrated` until `scripts/calibrate-crag.mjs` validates them against real recall quality

- [ ] **S45A.6** Implement `evaluateRecall(query, hits, config)` composite
  - Weighted average using `config.weights` (NOT hardcoded):
    - `score = weights.relevance * relevance + weights.coverage * coverage + weights.diversity * diversity + weights.specificity * specificity`
    - Default weights `{relevance: 0.35, coverage: 0.25, diversity: 0.25, specificity: 0.15}` — env-overridable via `MEGACOMPACT_CRAG_WEIGHTS` (comma-separated `r,c,d,s`)
    - Weights are normalized to sum to 1.0 before applying (defensive: a user setting `0.4,0.3,0.2,0.1` works without manual normalization)
  - `pass = score >= 0.4 AND breakdown.relevance >= minRelevance AND breakdown.coverage >= minCoverage AND breakdown.diversity >= minDiversity`
    - The `0.4` overall floor is itself a constant — make it `config.minOverallScore` (default `0.4`, env `MEGACOMPACT_CRAG_MIN_OVERALL`, labeled `uncalibrated`)
  - `uncalibrated: true` flag propagated from `config` (set when defaults are in use; cleared once `calibrate-crag.mjs` output is applied)
  - `recommendation`: generate human-readable advice string based on which metric is lowest
    - diversity < 0.3 → "chunks are too similar — consider expanding K or using MMR"
    - coverage < 0.4 → "query terms not well covered — consider query expansion"
    - relevance < 0.5 → "chunks may be irrelevant — consider stricter threshold"
    - overall < 0.4 → "quality is low — recommend re-retrieval with expanded query"
  - Recommendation strings also use the env-overridable thresholds (not hardcoded `0.3`/`0.4`/`0.5`)

- [ ] **S45A.7** Add tests in `src/recallMetrics.test.ts`
  - Test: diverse chunks score high on diversity (>0.7)
  - Test: similar chunks score low on diversity (<0.3)
  - Test: full query term coverage scores 1.0
  - Test: partial coverage scores proportionally
  - Test: empty hits returns score 0 with recommendation
  - Test: single hit returns diversity 1.0
  - Test: composite score weights are applied correctly (verify normalization with non-sum-1 weights)
  - Test: recommendation text matches lowest metric
  - Test: diversity metric returns 1.0 (NOT NaN) when all `checkpoint.embedding` are `[]`
  - Test: `uncalibrated: true` is set when default weights are in use
  - Test: `uncalibrated: false` is set when `MEGACOMPACT_CRAG_CALIBRATED=true` env is set (the flag the calibration script's output instructs the user to set)

- [ ] **S45A.8** Verify: `npm run build && npm test`

---

### Sprint S45B: Query Expansion Strategies

**Goal:** Implement query expansion for low-quality recall results.

**Acceptance:** Expansion produces modified queries that retrieve different results. Re-retrieval with expanded query returns higher-quality results. Expansion bounded to 1 iteration.

**Tasks:**

- [ ] **S45B.1** Create `src/queryExpansion.ts` with strategies
  - `expandQuery(originalQuery, breakdown, currentHits, config)` → `string[]` (list of expanded queries to try; bounded to at most 1 is tried by the caller — see S45C.2)
  - Strategy 1 — **MMR expansion**: if diversity < config.minDiversity, increase MMR lambda by 0.2 and re-retrieve (lambda delta configurable via `MEGACOMPACT_CRAG_MMR_LAMBDA_DELTA`, default `0.2`, uncalibrated)
  - Strategy 2 — **term extraction**: extract key terms from current hits' summaries that are NOT in the original query; append top-2 as additional query terms (count configurable via `MEGACOMPACT_CRAG_EXPAND_TERMS`, default `2`, uncalibrated)
  - Strategy 3 — **broaden query**: remove low-idf terms (terms that appear in > `config.idfBroadenRatio` of checkpoints) from the query to reduce bias toward common themes

- [ ] **S45B.2** Implement MMR expansion
  - Return `{ strategy: "mmr", mmrLambda: currentLambda + config.mmrLambdaDelta }` — caller adjusts MMR parameter
  - Only applicable when diversity is the bottleneck

- [ ] **S45B.3** Implement term extraction expansion
  - Tokenize all current hit summaries
  - Count term frequencies across hits
  - Select terms that appear in ≥2 hits but NOT in the original query
  - Return top-`config.expandTerms` as additional query terms
  - Expanded query: `originalQuery + " " + newTerms.join(" ")`

- [ ] **S45B.4** Implement broaden-query expansion
  - Compute term frequencies across ALL checkpoints in the session
  - Remove terms that appear in > `config.idfBroadenRatio` fraction of checkpoints (default `0.5`, env `MEGACOMPACT_CRAG_IDF_BROADEN_RATIO`, uncalibrated — was the original magic `50%`)
  - If query becomes empty after removal, skip this strategy (return `[]`)

- [ ] **S45B.5** Add tests in `src/queryExpansion.test.ts`
  - Test: MMR expansion returns higher lambda (by configured delta, not hardcoded 0.2)
  - Test: term extraction adds relevant terms from hit summaries (count from config)
  - Test: broaden query removes common terms (threshold from config)
  - Test: expansion returns empty when no strategy applies
  - Test: expanded query is always different from original
  - Test: when `idfBroadenRatio = 0.0`, no terms survive removal (edge case)
  - Test: when `idfBroadenRatio = 1.0`, no terms are removed (degenerate)

- [ ] **S45B.6** Verify: `npm run build && npm test`

---

### Sprint S45C: Integration into Recall Path

**Goal:** Wire CRAG quality evaluation into `recallAndInline()` with optional auto-expansion.

**Acceptance:** When `CRAG_ENABLED=true` (default), every recall evaluates quality and logs it. When `CRAG_EXPANSION_ENABLED=true` (default ON) and quality is LOW, re-retrieve ONCE with expanded query. Metrics failures log `crag_metrics_failed` and return original results.

**Tasks:**

- [ ] **S45C.1** Add config flags to `src/config/dedup.ts` (~line 30, in the existing `DedupConfigShape` — extend, don't replace)
  - `CRAG_ENABLED: boolean` (env `MEGACOMPACT_CRAG`, default: `true` — metrics are cheap and safe)
  - `CRAG_EXPANSION_ENABLED: boolean` (env `MEGACOMPACT_CRAG_EXPANSION`, default: `true` — expansion ships ON; bounded to 1 iteration so cost is capped)
  - `CRAG_MIN_DIVERSITY: number` (env `MEGACOMPACT_CRAG_MIN_DIVERSITY`, default: `0.3`, uncalibrated)
  - `CRAG_MIN_COVERAGE: number` (env `MEGACOMPACT_CRAG_MIN_COVERAGE`, default: `0.4`, uncalibrated)
  - `CRAG_MIN_RELEVANCE: number` (env `MEGACOMPACT_CRAG_MIN_RELEVANCE`, default: `0.5`, uncalibrated)
  - `CRAG_MIN_OVERALL_SCORE: number` (env `MEGACOMPACT_CRAG_MIN_OVERALL`, default: `0.4`, uncalibrated)
  - `CRAG_WEIGHTS: RecallQualityWeights` (env `MEGACOMPACT_CRAG_WEIGHTS` as `r,c,d,s`, default `{0.35,0.25,0.25,0.15}`, uncalibrated)
  - `CRAG_SPECIFICITY_DIVISOR: number` (env `MEGACOMPACT_CRAG_SPECIFICITY_DIVISOR`, default: `300`, uncalibrated)
  - `CRAG_SPECIFICITY_OPTIMAL_MIN: number` (env `MEGACOMPACT_CRAG_SPECIFICITY_OPTIMAL_MIN`, default: `100`, uncalibrated)
  - `CRAG_SPECIFICITY_OPTIMAL_MAX: number` (env `MEGACOMPACT_CRAG_SPECIFICITY_OPTIMAL_MAX`, default: `500`, uncalibrated)
  - `CRAG_IDF_BROADEN_RATIO: number` (env `MEGACOMPACT_CRAG_IDF_BROADEN_RATIO`, default: `0.5`, uncalibrated)
  - `CRAG_MMR_LAMBDA_DELTA: number` (env `MEGACOMPACT_CRAG_MMR_LAMBDA_DELTA`, default: `0.2`, uncalibrated)
  - `CRAG_EXPAND_TERMS: number` (env `MEGACOMPACT_CRAG_EXPAND_TERMS`, default: `2`, uncalibrated)
  - `CRAG_CALIBRATED: boolean` (env `MEGACOMPACT_CRAG_CALIBRATED`, default: `false` — set to `true` after running `scripts/calibrate-crag.mjs` and applying its suggested weights)
  - All `uncalibrated` flags derive from `!CRAG_CALIBRATED`

- [ ] **S45C.2** Integrate into `recallAndInline()` (`src/recall.ts:108–185`)
  - After `searchRecall()` returns `hits` (~line 133): if `config.CRAG_ENABLED`, wrap `evaluateRecall()` in try/catch
  - **On success:** call `logRecallQuality()` with the real `{ score, breakdown, expanded: false, reRetrieved: false, uncalibrated, weights }`
  - **On failure:** log `crag_metrics_failed` event to events.log with the real error message (via `logDecision` with `tier: "CRAG"`, `result: "mark_only"`, `reason: "metrics_failed: <error.message>"`) AND return original hits unchanged — NO silent fallback
  - If `!result.pass && config.CRAG_EXPANSION_ENABLED`:
    - Call `expandQuery()` — pick the first non-empty strategy's output
    - Re-retrieve via `searchRecall()` with the expanded query
    - Merge expanded results with original (dedup by `checkpointId`), take top-K
    - Re-evaluate merged set ONCE — if still low quality, use original results (no loop)
    - Log final `logRecallQuality()` with `expanded: true, reRetrieved: <true|false>`
  - **Expansion bounded to 1 iteration — this is a hard invariant, enforced by a counter in the integration code, not by config.**

- [ ] **S45C.3** Integrate into `recallAndInlineAsync()` (`src/recall.ts:286–345`)
  - Same pattern as sync path
  - Expansion + re-retrieval uses `store.searchAsync()` for the expanded query
  - Same 1-iteration bound, same error-logging contract

- [ ] **S45C.4** Add monitoring event type + logger in `src/monitoring.ts` (~line 22, alongside `DedupDecisionEvent`)
  - `RecallQualityEvent` type:
    ```
    {
      ts: number;
      sessionId: string;
      tier: "CRAG";
      score: number;
      breakdown: { relevance: number; coverage: number; diversity: number; specificity: number };
      expanded: boolean;
      reRetrieved: boolean;
      uncalibrated: boolean;
      weights: { relevance: number; coverage: number; diversity: number; specificity: number };
      note?: string;                    // "run scripts/calibrate-crag.mjs" when uncalibrated
      error?: string;                  // present only on crag_metrics_failed
    }
    ```
  - `logRecallQuality(path: string, ev: RecallQualityEvent): void` — appends to `events.log` (best-effort, same pattern as `logDecision`)
  - When `uncalibrated: true`, the event includes `note: "run scripts/calibrate-crag.mjs"` so ops reading `events.log` see the action item
  - `crag_metrics_failed` is logged by calling `logRecallQuality()` with `error: <message>, score: 0, breakdown: {0,0,0,0}, expanded: false, reRetrieved: false`

- [ ] **S45C.5** Add integration tests in `src/recallMetrics.test.ts`
  - Test: recall with high-quality results passes without expansion
  - Test: recall with low-quality results triggers expansion when `CRAG_EXPANSION_ENABLED=true`
  - Test: expansion improves quality score
  - Test: expansion does NOT trigger when `CRAG_EXPANSION_ENABLED=false`
  - Test: failed expansion gracefully returns original results AND logs `crag_metrics_failed`
  - Test: expansion runs at most once (verify no infinite loop — inject a stub `expandQuery` that always returns low-quality results and assert it's called exactly once)
  - Test: `CRAG_ENABLED=false` produces zero quality events in `events.log`

- [ ] **S45C.6** Full regression test
  - `MEGACOMPACT_CRAG=false npm test` — zero behavior change, zero CRAG events logged
  - `MEGACOMPACT_CRAG=true npm test` — all new tests pass
  - `MEGACOMPACT_CRAG=true MEGACOMPACT_CRAG_EXPANSION=true npm test` — expansion tests pass
  - `python3 scripts/regression_check.py --all` — green

---

### Sprint S45D: Calibration Script

**Goal:** Replace the `uncalibrated:true` defaults with weights correlated to a real downstream quality signal.

**Acceptance:** `scripts/calibrate-crag.mjs` runs against a real `events.log` corpus, correlates composite score with the real quality proxy (recall later superseded by a user re-query), prints suggested weights, and instructs the user to set `MEGACOMPACT_CRAG_CALIBRATED=true`.

**Tasks:**

- [ ] **S45D.1** Create `scripts/calibrate-crag.mjs`
  - Reads `events.log` from a state dir (path arg, default `~/.pi/mega-compact`)
  - Extracts every `RecallQualityEvent` with `expanded: false, reRetrieved: false` (the original-evaluation events — the signal we want to correlate against)
  - For each such event, looks forward in `events.log` for a subsequent event (same `sessionId`, within a configurable window — default 5 minutes) indicating the user re-queried (signal: a recall event for the same session with a *different* query embedding hash, OR a `supersede` event targeting one of the originally-injected checkpoints). This re-query is the real quality proxy: if the user re-queried, the original recall was unsatisfying.
  - For each (composite_score, re_queryed) pair: compute the per-metric correlation with `re_queryed` (point-biserial correlation: how well does each metric predict the re-query outcome?)
  - Output suggested weights: weight each metric proportional to its absolute correlation (normalized to sum to 1.0). If a metric has zero or negative correlation, suggest weight 0.
  - Print a table: `{ metric, current_weight, correlation, suggested_weight }`
  - Print the env-var line to apply: `export MEGACOMPACT_CRAG_WEIGHTS=<r>,<c>,<d>,<s> MEGACOMPACT_CRAG_CALIBRATED=true`
  - Exit non-zero if the events.log corpus has fewer than 50 evaluated recalls (too few to calibrate — print a clear "need more data" message)

- [ ] **S45D.2** Add a smoke test for the calibration script
  - Test fixture: a synthetic `events.log` with 100 recall events + 30 re-query signals
  - Test: `node scripts/calibrate-crag.mjs <fixture>` exits 0, prints a weights table, and the printed weights sum to 1.0
  - Test: `node scripts/calibrate-crag.mjs <fixture-with-10-events>` exits non-zero with "need more data"

- [ ] **S45D.3** Document the calibration workflow in the spec's ACCEPTANCE CRITERIA section (below) and in the script's `--help` output

---

### Sprint S45E: Dashboard Quality Telemetry

**Goal:** Surface CRAG quality metrics on the dashboard.

**Acceptance:** Dashboard shows recall quality trends; API returns quality breakdown. When `CRAG_CALIBRATED=false`, the dashboard shows a "Run `scripts/calibrate-crag.mjs`" banner.

**Tasks:**

- [ ] **S45E.1** Add dashboard API endpoint
  - `GET /api/recall-quality` in `extensions/dashboard-server/server.ts` (~line 243)
  - Returns: `{ totalRecalls, passRate, avgScore, avgBreakdown: { relevance, coverage, diversity, specificity }, expansionsTriggered, uncalibrated: boolean }`
  - Computed from recent events.log entries (last 100 recall quality events)
  - 404 when `CRAG_ENABLED=false`

- [ ] **S45E.2** Add quality metrics to MetricsTab
  - `extensions/dashboard-client/src/tabs/MetricsTab.tsx`: add recall quality card
  - Show: pass rate (%), avg score, breakdown bar chart (4 metrics)
  - Show: expansion trigger count
  - When `uncalibrated: true`: render a yellow banner: "Weights are uncalibrated defaults — run `scripts/calibrate-crag.mjs` to calibrate against real recall outcomes."
  - Uses existing recharts dependency

- [ ] **S45E.3** Verify: dashboard loads without errors when feature is OFF (404 handled gracefully) AND when `uncalibrated: true` (banner renders without crashing the chart)

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF:** `CRAG_ENABLED=false` produces identical results to current production AND logs zero CRAG events to `events.log`.
2. **Metrics are accurate:** diverse chunks score >0.7 on diversity; identical chunks score <0.3; full term coverage scores 1.0.
3. **Empty-embedding guard:** the diversity metric returns `1.0` (NOT `NaN`) when `checkpoint.embedding` is `[]` for any/all hits — verified by unit test (see PREREQUISITE P1).
4. **Composite evaluation works:** `evaluateRecall()` returns `{ pass, score, breakdown, recommendation, uncalibrated, weights }` with all fields populated.
5. **All weights and thresholds are configurable:** every constant from the original spec (composite weights `0.35/0.25/0.25/0.15`, specificity divisor `300`, specificity optimal range `100–500`, IDF broaden ratio `0.5`, MMR lambda delta `0.2`, expand-terms count `2`, min-overall `0.4`) is settable via `MEGACOMPACT_CRAG_*` env vars and read from `RecallQualityConfig`, never hardcoded inline.
6. **Uncalibrated labeling:** every `RecallQualityEvent` includes `uncalibrated: boolean` and `weights` object; when `CRAG_CALIBRATED=false`, the event also includes `note: "run scripts/calibrate-crag.mjs"`. The dashboard renders a yellow banner in the same condition.
7. **Stopword list sourced:** `src/config/stopwords.ts` is the single source; S41's self-RAG critique and S45's coverage metric both import from it; no inline hardcoded stopword lists remain in either module.
8. **`SearchHit.embedding` schema audit done:** PREREQUISITE P1 is complete; the audit query is committed as a comment in `src/recallMetrics.ts`; the diversity guard is in place.
9. **Error-logging contract:** metrics failures log `crag_metrics_failed` with the real error message AND return original results; no silent fallback. Verified by integration test.
10. **Expansion improves quality:** when quality is LOW and `CRAG_EXPANSION_ENABLED=true`, the expanded query retrieves better results.
11. **No infinite loops:** expansion runs at most once per recall request. If expanded results are still low quality, original results are used. Hard invariant (counter-enforced, not config-gated).
12. **Quality telemetry:** every recall logs quality metrics to `events.log` when `CRAG_ENABLED=true`.
13. **Dashboard integration:** `/api/recall-quality` returns aggregated quality metrics AND `uncalibrated: boolean`.
14. **Calibration path exists:** `scripts/calibrate-crag.mjs` runs end-to-end against a fixture `events.log`, produces a weights table summing to 1.0, and exits non-zero on too-few events.

---

## ROLLBACK

1. Set `MEGACOMPACT_CRAG=false` to disable quality evaluation entirely (zero events logged, zero behavior change).
2. Set `MEGACOMPACT_CRAG_EXPANSION=false` to disable auto-expansion only (metrics still logged).
3. All new code is in new files (`src/recallMetrics.ts`, `src/queryExpansion.ts`, `src/config/stopwords.ts`, `scripts/calibrate-crag.mjs`).
4. Integration points in `src/recall.ts` are gated behind `if (config.CRAG_ENABLED)`.
5. No database migrations required.
6. To roll back a calibration: unset `MEGACOMPACT_CRAG_CALIBRATED` (or set to `false`) — all events resume carrying `uncalibrated: true` and the dashboard banner re-appears.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Quality metrics add latency to every recall | Medium | Low | Metrics are pure math (cosine + term overlap); <1ms overhead. Gated on `CRAG_ENABLED` (default ON but cheap). |
| Expansion produces worse results than original | Low | Medium | Re-evaluate after expansion; use original if expanded is worse. Expansion bounded to 1 iteration (hard invariant). |
| Coverage metric is too simplistic (term overlap) | Medium | Low | Weighted combination with other 3 metrics; trigram embedder handles synonyms. Weights are uncalibrated defaults — run `scripts/calibrate-crag.mjs`. |
| Diversity metric O(n²) for large K | Low | Low | K is typically 3–5; O(n²) = O(25) max; negligible. Empty-embedding guard skips invalid pairs. |
| Query expansion adds LLM-like behavior (expensive) | Low | Low | No LLM calls — all expansion is deterministic term extraction. Expansion gated on `CRAG_EXPANSION_ENABLED` (default ON; bounded to 1 re-retrieval iteration so cost is capped). |
| Composite weights `{0.35,0.25,0.25,0.15}` are uncalibrated defaults | High | Medium | Every event logs `uncalibrated: true` + `note: "run scripts/calibrate-crag.mjs"` until `MEGACOMPACT_CRAG_CALIBRATED=true` is set. Dashboard renders a yellow banner in the same condition. Weights env-overridable. |
| `SearchHit.checkpoint.embedding` is `[]` for legacy migrated checkpoints | Medium | Medium | Diversity metric guards against empty embeddings (returns 1.0, not NaN). PREREQUISITE P1 audit query committed in `src/recallMetrics.ts`. Relevance is naturally guarded (`cosineSimilarity(qv, []) = 0`). |
| Specificity divisor `300` and optimal range `100–500` are uncalibrated | High | Low | All three constants env-overridable; labeled `uncalibrated` until `calibrate-crag.mjs` validates them. Specificity weight is the smallest (0.15), limiting blast radius. |
| IDF broaden ratio `0.5` is an uncalibrated magic constant | Medium | Low | Env-overridable via `MEGACOMPACT_CRAG_IDF_BROADEN_RATIO`; labeled `uncalibrated`. Only affects the broaden-query strategy, which is one of three expansion strategies. |
| Calibration script correlates against a noisy proxy (user re-query) | Medium | Medium | Point-biserial correlation over ≥50 events smooths noise; script exits non-zero on too-few events. The re-query signal is REAL (harvested from `events.log`), not synthesized. |
