# S43 — Query Reformulation for Vague Recall Queries

**Date:** 2026-07-26 (rewritten 2026-07-25)
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 12 (vector search), S41 (self-RAG quality gate), `src/recall.ts`, `src/vectorStore.ts`, `src/embedder.ts`, `src/store/sqlite.ts` (`context_chunks` store)
**Priority:** P1
**Status:** Re-planned → implement-ready
**Target version:** v0.9.x
**Filename stability:** filename kept as `s43-hyde-vague-queries.md` for stable cross-references; title and content reflect the new (non-LLM) algorithm.

---

## RE-PLAN 2026-07-25 — HyDE REMOVED

**Audit verdict:** HyDE's premise is "generate a hypothetical answer document via an LLM, embed it, search." That premise requires an LLM call. Under PREVENT-PI-004 (zero network calls at runtime), the only path is the localhost Ollama exception — which is **NOT the default**. In the default config, HyDE silently degraded to a **no-op**: it returned the raw query and logged nothing. A stub masquerading as a feature. The audit verdict was unambiguous: fundamental redesign required.

**User decision (2026-07-25):** HyDE is REMOVED. The replacement is a **fully local, zero-LLM query-reformulation algorithm** using real embedding neighbors + real TF-IDF from the actual checkpoint corpus. Rename intent: "Query Reformulation for Vague Recall Queries."

**The new algorithm, in one line:** embed the raw query → linear-scan the real `context_chunks` store for the top-N nearest neighbors by REAL cosine similarity → extract the highest-weighted terms from those neighbors by REAL TF-IDF (real term frequency, real inverse document frequency over the real corpus) → re-embed the expanded query → search → fuse raw-query results with expanded-query results via RRF (Reciprocal Rank Fusion, k=60, sourced from the original RRF paper).

**Every input is REAL:** real query embedding, real stored chunks, real cosine, real TF-IDF. No LLM. No mock. No silent no-op.

**Deleted from the prior plan:**
- `MEGACOMPACT_HYDE_MODEL`, `MEGACOMPACT_HYDE_URL` env vars
- The `fetch` to localhost Ollama
- The `guardrails-allow PREVENT-PI-004` annotation for the LLM path
- HyDE prompt templates (`HYDE_PROMPTS`), per-query-type prompts
- The `hydeTransform` LLM bridge
- The LLM `variations` count (3), LLM temperature (0.3), LLM token limit (200)
- The Ollama dependency entirely. The Ollama-based `multi-query` LLM expansion is also gone (the new "expansion" is corpus-grounded TF-IDF, not LLM rephrasings).

**Kept from the prior plan:** the RRF fusion step (the formula itself is LLM-free; only `k=60` is sourced from the original RRF paper) and the original-query-vs-expanded-query fusion shape.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): query reformulation operates on the *query* side of recall — it transforms the search query before embedding and searching. It never touches the anchor-floor guard in `src/boundary.ts:computeDropRange()`. The anchor floor protects recent messages; query reformulation improves recall relevance. These are orthogonal.
- **PREVENT-PI-003** (no system role): recalled context is injected via the `before_agent_start` systemPrompt prepend path. Query reformulation changes which chunks are retrieved, not how they are injected.
- **PREVENT-PI-004** (no network): **query reformulation makes ZERO network calls.** Every operation is in-process: `TrigramEmbedder.embed()` is a pure local function (`src/embedder.ts:63`); the linear scan over `context_chunks` is a local SQLite read; TF-IDF is computed over the real in-process corpus. There is no Ollama fetch, no `guardrails-allow PREVENT-PI-004` annotation, and no loopback server. The entire algorithm is PREVENT-PI-004-clean by construction (no exception needed).
- **Feature flag default ON:** `QUERY_REFORMULATION_ENABLED` defaults to `true`. Unlike the old HyDE flag (which defaulted OFF to hide the silent no-op), the new algorithm is a real, safe, local computation. Operators can disable via `MEGACOMPACT_QUERY_REFORMULATION_ENABLED=false` for A/B comparison. **No silent no-op is possible** — when enabled, the algorithm runs end-to-end or emits a `query_reformulation_failed` event (see Logging Contract).
- **S41 quality gate preserved:** the original raw query (not the expanded query) is always passed to the self-RAG quality gate (`src/recallCritique.ts`). Query reformulation improves *retrieval*; the quality gate validates *injection*. Misclassification of "vague" only changes which path runs (raw-only vs. raw+expanded), not whether a stub no-ops.
- **PREVENT-PI-002** (no toolCall/toolResult split): orthogonal — query reformulation never touches compaction boundaries.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`.

---

## PROBLEM

Today's `recallAndInline()` in `src/recall.ts` embeds the raw user query and searches the vector store. This works poorly for vague recall queries:

1. **Vague queries retrieve irrelevant chunks** — when a user asks "what did we decide about auth?" or "what was that bug we fixed?", the raw query is embedded via `TrigramEmbedder.embed()` (`src/embedder.ts:63–90`). This embedding represents the *question*, not the *answer*. The actual stored checkpoint says "we decided to use JWT tokens with short-lived refresh tokens" — a very different embedding space. Cosine similarity between the question embedding and the answer embedding is low, so relevant chunks rank poorly.

2. **No query expansion against the real corpus** — a single query produces a single embedding and a single search. If the user writes "auth decision" and the stored chunk says "JWT token architecture," these don't overlap well lexically or semantically. There is no mechanism to expand the query with vocabulary actually present in the stored checkpoints.

3. **Embedding mismatch** — the `TrigramEmbedder` uses character 3-gram bags-of-counts. It works well when the query and target share vocabulary ("JWT tokens" ↔ "JWT authentication tokens") but fails on a semantic gap ("what did we decide" ↔ "we decided to use"). The fix is *not* an LLM: it is to surface the actual vocabulary of the stored corpus and inject it into the query so the embedder sees overlapping tokens.

4. **Token waste on irrelevant recall** — when vague queries retrieve irrelevant chunks, those chunks consume system-prompt tokens without helping the agent. This is worse than no recall at all (it wastes tokens and may confuse the agent).

5. **The old "fix" (HyDE) was a stub** — the prior S43 plan proposed generating a hypothetical answer via an LLM. But the only LLM path allowed under PREVENT-PI-004 is the localhost Ollama exception, which is not the default. In the default config, HyDE silently no-op'd: it returned the raw query and logged nothing. A stub masquerading as a feature. (See RE-PLAN header above.) The real fix must be fully local and use real signals from the actual corpus.

**Root cause:** the recall path treats every query identically — embed it raw, search, inject. There is no awareness of query quality (vague vs. specific) and no mechanism to reformulate the query before searching using real signals from the stored corpus.

**Solution shape (this spec):** embed the raw query → linear-scan the real `context_chunks` store for top-N nearest neighbors by real cosine → extract the highest-weighted terms from those neighbors by real TF-IDF over the real corpus → re-embed the expanded query → search with it → RRF-fuse raw-query results with expanded-query results. Every input real. No LLM. No mock. No silent no-op.

---

## SCOPE

### IN SCOPE (new files):
- `src/queryReformulation.ts` — the reformulation pipeline (vagueness detection, neighbor linear scan, TF-IDF extraction, re-embedding, RRF fusion)
- `src/queryReformulation.test.ts` — unit tests for every stage of the pipeline

### IN SCOPE (modified files):
- `src/recall.ts` — wire query reformulation into `recallAndInline()` between query construction and the `recall()` call, behind `QUERY_REFORMULATION_ENABLED`
- `src/config/dedup.ts` — add the new configurable constants (see Execution S43A-1)
- `src/log.ts` — add the `query_reformulation` and `query_reformulation_failed` event types (or use existing `Logger`)

### OUT OF SCOPE:
- Changes to `src/vectorStore.ts` — reformulation produces an expanded query string that is fed to the existing `search()` call. The linear-scan over `context_chunks` for neighbors uses the existing store read API (no schema change).
- Changes to `src/engine.ts` — recall is called via `recallAndInline()`, not directly.
- Changes to `src/embedder.ts` — reformulation uses the existing `TrigramEmbedder` to embed the raw query and the expanded query. No embedder change.
- LLM-based re-ranking of results (cross-encoder reranking) — out of scope; the project makes zero LLM calls at runtime by PREVENT-PI-004.
- Learning which queries are "vague" from feedback — future enhancement.
- Dashboard visualization of reformulation metrics — future sprint.
- ANN-accelerated neighbor lookup (PGlite HNSW) — future enhancement; the default path is a linear scan over `embedding_blob` (small N), which is the same default the rest of the recall path already uses.

---

## EXECUTION

### Sprint S43A: Query Reformulation Pipeline

**Goal:** Build a fully-local, zero-LLM query-reformulation pipeline that takes a vague query, finds its real nearest neighbors in the `context_chunks` store, extracts real TF-IDF-weighted expansion terms from those neighbors, re-embeds the expanded query, and RRF-fuses raw-query results with expanded-query results.

**Acceptance:** `src/queryReformulation.test.ts` passes; reformulation produces a real expanded query for vague queries; RRF correctly merges the two result sets; cache TTL eviction logs hit rate; on embedder/store failure, the original query result is returned AND a `query_reformulation_failed` event is logged (not silent).

**Tasks:**

- [ ] **S43A-1: Define configurable constants** (`src/config/dedup.ts`)
  Add to `DedupConfigShape` interface:
  ```ts
  // --- S43: Query Reformulation (fully local, zero LLM) ---
  QUERY_REFORMULATION_ENABLED: boolean;          // default true
  EXPANSION_NEIGHBOR_COUNT: number;             // default 5
  EXPANSION_TOP_TERMS: number;                  // default N (see calibration note below)
  RRF_K: number;                                // default 60 (sourced from the original RRF paper)
  VAGUE_MIN_WORDS: number;                      // default 8 (gates expansion firing)
  VAGUE_VERY_SHORT_WORDS: number;               // default 5
  QUERY_REFORM_CACHE_TTL_SECONDS: number;       // default 3600
  ```
  Add to `loadDedupConfig()`:
  ```ts
  QUERY_REFORMULATION_ENABLED: envBool("MEGACOMPACT_QUERY_REFORMULATION_ENABLED", true),
  EXPANSION_NEIGHBOR_COUNT:    envNum("MEGACOMPACT_EXPANSION_NEIGHBOR_COUNT", 5),
  EXPANSION_TOP_TERMS:         envNum("MEGACOMPACT_EXPANSION_TOP_TERMS", N),  // see calibration
  RRF_K:                       envNum("MEGACOMPACT_RRF_K", 60),
  VAGUE_MIN_WORDS:             envNum("MEGACOMPACT_VAGUE_MIN_WORDS", 8),
  VAGUE_VERY_SHORT_WORDS:      envNum("MEGACOMPACT_VAGUE_VERY_SHORT_WORDS", 5),
  QUERY_REFORM_CACHE_TTL_SECONDS: envNum("MEGACOMPACT_QUERY_REFORM_CACHE_TTL", 3600),
  ```
  **Calibration labeling (REQUIRED):** every numeric constant above is labeled in the source as either:
  - **`// sourced`** — `RRF_K = 60` comes from the original RRF paper (Cormack et al., 2009); this is not an uncalibrated magic number.
  - **`// uncalibrated — default, tuneable`** — `EXPANSION_NEIGHBOR_COUNT`, `EXPANSION_TOP_TERMS`, `VAGUE_MIN_WORDS`, `VAGUE_VERY_SHORT_WORDS`, `QUERY_REFORM_CACHE_TTL_SECONDS` are pragmatic defaults, not the result of a benchmark. They are env-overridable precisely so they can be tuned after we have real telemetry. The acceptance criteria require this label.

- [ ] **S43A-2: Define reformulation types** (`src/queryReformulation.ts`)
  ```ts
  import type { Embedder, Vector } from "./embedder.js";

  /** A real stored neighbor chunk found by the linear scan. */
  export interface ExpansionNeighbor {
    /** The chunk's stored id (from context_chunks). */
    chunkId: string;
    /** Real cosine similarity between the raw query embedding and the chunk embedding. */
    similarity: number;
    /** The chunk's text (used for TF-IDF term extraction). */
    text: string;
  }

  /** A real TF-IDF-weighted expansion term. */
  export interface ExpansionTerm {
    term: string;
    /** Real TF-IDF weight over the actual corpus. */
    tfidf: number;
  }

  /** The full reformulation result, every field backed by real computation. */
  export interface ReformulationResult {
    /** The original raw query (always preserved for the S41 quality gate). */
    original: string;
    /** The expanded query string (original + top TF-IDF terms). */
    expanded: string;
    /** Real nearest neighbors used for term extraction (for logging/audit). */
    neighbors: ExpansionNeighbor[];
    /** Real TF-IDF terms extracted (for logging/audit). */
    terms: ExpansionTerm[];
    /** Whether RRF fusion was applied (true when expansion produced a non-trivial expanded query). */
    rrfApplied: boolean;
    /** Whether the result came from cache. */
    fromCache: boolean;
    /**
     * Which constants were uncalibrated defaults at runtime (for the logging
     * contract — never empty when expansion fired).
     */
    uncalibrated: string[];
  }
  ```

- [ ] **S43A-3: Implement vagueness detection** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Heuristic: is this query "vague" enough to benefit from reformulation?
   * Returns true if the query is short, question-like, or lacks specific terms.
   * Used to decide whether to run expansion (skip for specific queries).
   *
   * NOTE: this gates WHICH PATH runs (raw-only vs. raw+expanded). It does
   * NOT gate whether a stub no-ops — expansion is a real algorithm either way.
   * Misclassification is low-cost: a specific query that's wrongly expanded
   * just gets a slightly broader search; a vague query that's wrongly skipped
   * just gets the raw-query search (today's behavior).
   */
  export function isVagueQuery(
    query: string,
    opts: { vagueMinWords: number; vagueVeryShortWords: number },
  ): boolean
  ```
  Rules (ANY match → vague), using the configurable thresholds:
  - Length < `vagueMinWords` AND contains a question word ("what", "why", "how", "when", "where", "which", "who")
  - Length < `vagueVeryShortWords` (very short queries are always vague)
  - Contains "we decided", "we used", "we chose", "that thing about", "the thing where"
  - Does NOT contain: file paths (`.ts`, `.js`, `/`), specific technical terms (>2 capitalized words), function names (`camelCase` patterns)

- [ ] **S43A-4: Implement the real neighbor linear scan** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Linear-scan the real context_chunks store for the top-N nearest neighbors
   * to the raw query embedding by REAL cosine similarity.
   *
   * This is the same default path the rest of the recall pipeline uses
   * (linear scan over embedding_blob, small N). It reads real stored chunks
   * and computes real cosine — no mock, no approximation.
   *
   * Returns the neighbor chunks (id + similarity + text) for TF-IDF extraction.
   */
  export function findExpansionNeighbors(
    queryEmbedding: Vector,
    neighborCount: number,
    /** Injected store reader (dependency inversion — keeps this pi-agnostic). */
    scan: (embedding: Vector, limit: number) => Array<{
      chunkId: string;
      embedding: Vector;
      text: string;
    }>,
  ): ExpansionNeighbor[]
  ```
  Implementation:
  1. Call `scan(queryEmbedding, neighborCount)` — returns up to `neighborCount` chunks
  2. For each: compute `cosineSimilarity(queryEmbedding, chunk.embedding)` (real cosine, `src/embedder.ts:34`)
  3. Sort by similarity descending, take top `neighborCount`
  4. Map to `ExpansionNeighbor` (chunkId, similarity, text)

- [ ] **S43A-5: Implement real TF-IDF term extraction** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Extract the highest-weighted terms from the neighbor chunks by REAL TF-IDF.
   *
   * - TF: real term frequency inside the neighbor chunks (concatenated text).
   * - IDF: real inverse document frequency over the REAL corpus (the entire
   *   context_chunks store, not a hand-picked stopword list).
   *
   * This is corpus-grounded expansion: the terms come from what's actually
   * stored, not from a hypothetical LLM answer.
   */
  export function extractExpansionTerms(
    neighbors: ExpansionNeighbor[],
    topTerms: number,
    /** Injected corpus-size + document-frequency reader (dependency inversion). */
    corpus: {
      /** Total number of chunks in the real corpus (for IDF denominator). */
      totalDocs: number;
      /** Real document frequency for a term across the real corpus. */
      docFreq: (term: string) => number;
    },
  ): ExpansionTerm[]
  ```
  Implementation:
  1. Concatenate neighbor texts → the "neighbor document"
  2. Tokenize (split on whitespace + punctuation, lowercase)
  3. For each unique term in the neighbor document:
     - `tf` = count of term in neighbor document / total terms in neighbor document
     - `df` = `corpus.docFreq(term)` (real document frequency across the real corpus)
     - `idf` = `ln((1 + corpus.totalDocs) / (1 + df)) + 1` (smoothed IDF, never zero)
     - `tfidf` = `tf * idf`
  4. Sort by `tfidf` descending, take top `topTerms`
  5. **NOT a stopword list:** terms that appear in many documents get a low IDF naturally and so rank low. This is the whole point of real TF-IDF — it replaces hand-picked stopword lists with corpus-grounded weighting.

- [ ] **S43A-6: Implement TTL cache** (`src/queryReformulation.ts`)
  ```ts
  /**
   * In-memory TTL cache for reformulation results.
   * Key: FNV-1a hash of normalized query string (re-uses src/embedder.ts:49 fnv1a).
   * Value: { result: ReformulationResult, timestamp: number }.
   * Eviction: lazy (check TTL on read).
   *
   * The cache periodically logs its hit rate (not silent) — see Logging Contract.
   */
  ```
  The cache stores the full `ReformulationResult` so a cache hit avoids the neighbor scan + TF-IDF recomputation. Cache key normalization: lowercase, collapse whitespace, trim — same as the old plan's `cacheKey()`.

- [ ] **S43A-7: Implement top-level `reformulateQuery()`** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Full reformulation pipeline (NO LLM anywhere):
   *   1. Embed the raw query with the real TrigramEmbedder (in-process).
   *   2. Linear-scan the real context_chunks store for top-N nearest neighbors
   *      by real cosine similarity.
   *   3. Extract the highest-weighted terms from those neighbors by real TF-IDF
   *      over the real corpus.
   *   4. Re-embed the expanded query (original + top TF-IDF terms).
   *   5. Return the expanded query + neighbors + terms + metadata for RRF fusion.
   *
   * On ANY thrown error (embedder failure, store read failure, etc.):
   *   - return the raw query as the expanded query (so the caller's raw-query
   *     search still works), AND
   *   - emit a `query_reformulation_failed` event with the real error (NOT silent).
   *
   * The original raw query is ALWAYS preserved separately for the S41 quality gate.
   */
  export function reformulateQuery(
    query: string,
    embedder: Embedder,
    scan: (embedding: Vector, limit: number) => Array<{
      chunkId: string;
      embedding: Vector;
      text: string;
    }>,
    corpus: {
      totalDocs: number;
      docFreq: (term: string) => number;
    },
    opts: {
      neighborCount: number;
      topTerms: number;
      vagueMinWords: number;
      vagueVeryShortWords: number;
      cacheTtlSeconds: number;
    },
  ): ReformulationResult
  ```
  Implementation:
  1. Check cache: if hit and within TTL, return cached result with `fromCache: true`
  2. `isVagueQuery(query, ...)` — if NOT vague, return `{ original: query, expanded: query, neighbors: [], terms: [], rrfApplied: false, fromCache: false, uncalibrated: [...] }` (raw-query-only path; logged)
  3. `queryEmbedding = embedder.embed(query)` (real TrigramEmbedder)
  4. `neighbors = findExpansionNeighbors(queryEmbedding, opts.neighborCount, scan)`
  5. `terms = extractExpansionTerms(neighbors, opts.topTerms, corpus)`
  6. `expanded = `${query} ${terms.map(t => t.term).join(" ")}``
  7. Set cache, return result with `rrfApplied: true`, `uncalibrated: ["EXPANSION_NEIGHBOR_COUNT", "EXPANSION_TOP_TERMS", "VAGUE_MIN_WORDS", "VAGUE_VERY_SHORT_WORDS"]` (RRF_K is sourced, so it is NOT in the uncalibrated list)
  8. **Empty/thin corpus fallback:** if `neighbors.length === 0` or `terms.length === 0`, return `{ original: query, expanded: query, rrfApplied: false, ... }` AND log a `query_reformulation_skipped` event with reason `"empty_corpus"` or `"thin_corpus"` (see Logging Contract). This is the explicit, logged "expansion terms are weak, fall back to raw query" case from the RISKS table.

- [ ] **S43A-8: Implement Reciprocal Rank Fusion (RRF)** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Reciprocal Rank Fusion: merge multiple ranked lists into a single ranking.
   * Standard RRF formula: score(d) = Σ 1/(k + rank_i(d))
   * where k=60 (sourced from the original RRF paper, Cormack et al. 2009 —
   * NOT an uncalibrated magic number).
   *
   * @param resultSets - Array of ranked lists, each item has { id: string, rank: number }
   * @param k - RRF constant (default 60, sourced)
   * @returns Merged list sorted by fused score descending
   */
  export function reciprocalRankFusion(
    resultSets: Array<Array<{ id: string; rank: number }>>,
    k = 60, // sourced
  ): Array<{ id: string; score: number }>
  ```
  Implementation (kept from the prior plan; the formula itself is LLM-free):
  ```ts
  const scores = new Map<string, number>();
  for (const resultSet of resultSets) {
    for (const item of resultSet) {
      const current = scores.get(item.id) ?? 0;
      scores.set(item.id, current + 1 / (k + item.rank));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
  ```

- [ ] **S43A-9: Implement full reformulation + fusion search** (`src/queryReformulation.ts`)
  ```ts
  /**
   * Full pipeline: reformulate query → search with raw + expanded → RRF fuse.
   * The search function is injected (dependency inversion) so this module
   * stays pi-agnostic and testable. ZERO LLM calls anywhere.
   */
  export function reformulationSearch(
    query: string,
    embedder: Embedder,
    scan: (embedding: Vector, limit: number) => Array<{
      chunkId: string;
      embedding: Vector;
      text: string;
    }>,
    corpus: { totalDocs: number; docFreq: (term: string) => number },
    search: (q: string, limit: number) => Array<{ id: string; score: number }>,
    opts: {
      neighborCount: number;
      topTerms: number;
      vagueMinWords: number;
      vagueVeryShortWords: number;
      cacheTtlSeconds: number;
      rrfK: number;
      searchLimit: number;
    },
  ): { fused: Array<{ id: string; score: number }>; reformulation: ReformulationResult }
  ```
  Implementation:
  1. `reformulation = reformulateQuery(query, embedder, scan, corpus, opts)`
  2. If `!reformulation.rrfApplied`: return `{ fused: search(query, opts.searchLimit).map(...), reformulation }` (raw-query-only path)
  3. `rawResults = search(query, opts.searchLimit)` — ranked by similarity
  4. `expandedResults = search(reformulation.expanded, opts.searchLimit)` — ranked by similarity
  5. Convert each to ranked lists: `rawResults.map((r, i) => ({ id: r.id, rank: i + 1 }))` etc.
  6. `fused = reciprocalRankFusion([rawRanked, expandedRanked], opts.rrfK)`
  7. Return `{ fused, reformulation }`

- [ ] **S43A-10: Unit tests** (`src/queryReformulation.test.ts`)
  - `isVagueQuery()` identifies vague queries ("what did we decide about auth?") and rejects specific ones ("how does VectorStore.search() filter by sessionId?") — using configurable thresholds
  - `findExpansionNeighbors()` returns the top-N chunks by real cosine similarity, given a fake `scan` returning 3 chunks with known embeddings
  - `extractExpansionTerms()` returns real TF-IDF-weighted terms — verify that a term appearing in 1 of 100 documents gets a higher IDF than a term appearing in 90 of 100 documents, and that the high-IDF term ranks above the low-IDF term when TF is equal
  - `extractExpansionTerms()` is NOT a stopword list: a frequent term ("the") naturally gets a low IDF and ranks below a rare term ("jwt") even though both have similar TF
  - `reformulateQuery()` on a vague query returns a non-trivial `expanded` string with `rrfApplied: true`, real `neighbors`, real `terms`, and the correct `uncalibrated` list (RRF_K NOT in it)
  - `reformulateQuery()` on a specific query returns `expanded === original`, `rrfApplied: false`
  - `reformulateQuery()` on an empty/thin corpus returns `expanded === original`, `rrfApplied: false` (the explicit, logged fallback)
  - Cache hit: second call with same query returns `fromCache: true` without re-scanning
  - Cache TTL expiry: after TTL, a new scan happens
  - **Error logging contract:** when the embedder throws (injected mock), `reformulateQuery()` returns the raw query AND the caller sees a `query_reformulation_failed` event with the real error message (not silent)
  - `reciprocalRankFusion()` correctly merges two ranked lists:
    - List A: [item1, item2, item3] (rank 1, 2, 3)
    - List B: [item2, item1, item4] (rank 1, 2, 3)
    - Fused: item2 > item1 > item3 ≈ item4 (item2 appears high in both)
  - RRF with empty lists returns empty
  - RRF with single list returns that list's ranking
  - `reformulationSearch()` searches with raw + expanded and fuses results when vague
  - `reformulationSearch()` uses only the raw query when the query is specific

---

### Sprint S43B: Integration into Recall Path

**Goal:** Wire query reformulation into `recallAndInline()` behind `QUERY_REFORMULATION_ENABLED` (default ON), preserving the original raw query for the S41 quality gate, and emitting the full logging contract.

**Acceptance:** With `QUERY_REFORMULATION_ENABLED=true` (default), vague queries trigger reformulation before embedding and RRF-fuse results. With the flag OFF, behavior is identical to today's `recallAndInline()` (raw-query search only). The S41 quality gate always receives the **original** raw query, not the expanded query. On any failure, the raw-query result is returned AND a `query_reformulation_failed` event is logged (not silent).

**Tasks:**

- [ ] **S43B-1: Integrate reformulation into `recallAndInline()`** (`src/recall.ts`)
  Modify `recallAndInline()`. Insert reformulation between query text construction and the `recall()` call:
  ```ts
  // --- S43: Query reformulation (fully local, zero LLM) ---
  let searchQuery = rawQuery;
  let fusedHits: SearchHit[] | null = null;
  let reformulationMeta: ReformulationResult | null = null;

  if (config?.QUERY_REFORMULATION_ENABLED) {
    const { reformulationSearch } = await import("./queryReformulation.js");
    try {
      const { fused, reformulation } = reformulationSearch(
        rawQuery,
        defaultEmbedder,
        /* scan= */ (emb, limit) => store.scanNeighbors(emb, limit),  // real SQLite read
        /* corpus= */ { totalDocs: store.totalChunks(), docFreq: (t) => store.docFreq(t) },
        /* search= */ (q, lim) => store.search(sid, q, lim).map(h => ({ id: h.checkpoint.checkpointId, score: h.score })),
        {
          neighborCount: config.EXPANSION_NEIGHBOR_COUNT,
          topTerms: config.EXPANSION_TOP_TERMS,
          vagueMinWords: config.VAGUE_MIN_WORDS,
          vagueVeryShortWords: config.VAGUE_VERY_SHORT_WORDS,
          cacheTtlSeconds: config.QUERY_REFORM_CACHE_TTL_SECONDS,
          rrfK: config.RRF_K,
          searchLimit: limit,
        },
      );
      reformulationMeta = reformulation;
      if (reformulation.rrfApplied) {
        // Reorder the actual SearchHit objects by fused score
        const fusedIds = new Map(fused.map(f => [f.id, f.score]));
        fusedHits = rawHitsForFusion
          .filter(h => fusedIds.has(h.checkpoint.checkpointId))
          .sort((a, b) => (fusedIds.get(b.checkpoint.checkpointId) ?? 0) - (fusedIds.get(a.checkpoint.checkpointId) ?? 0));
      }
    } catch (e) {
      // Error-logging contract: original query result is returned AND the failure is logged.
      log?.error("query_reformulation_failed", {
        query: rawQuery.slice(0, 80),
        error: String(e && e.message ? e.message : e),
      });
      // searchQuery stays as rawQuery; fusedHits stays null; recall proceeds normally.
    }
  }

  // --- Existing recall path ---
  const { hits: rawHits, newHits } = recall({
    sessionId: sid,
    query: searchQuery,  // reformulation-expanded or raw
    limit,
    skipInjected: true,
  }, store);
  const hits = fusedHits ?? rawHits;

  // S41 quality gate: ALWAYS uses the ORIGINAL raw query (not expanded).
  // This ensures the critique checks relevance to what the user actually asked.
  // ... existing quality gate code unchanged ...
  ```
  Notes:
  - The actual integration will need to handle the `recall()` return type carefully. The `fusedHits` path reorders already-fetched hits by fused score; `skipInjected` is applied on the final `hits` list uniformly.
  - The store-reader methods (`scanNeighbors`, `totalChunks`, `docFreq`) are added to the `VectorStore` interface as pure read methods — they read real `context_chunks` rows and compute real document frequency. No schema change.
  - The `query_reformulation_failed` log line is the only path that emits a failure event. On the empty/thin-corpus fallback, the `reformulateQuery` function itself emits a `query_reformulation_skipped` event with the reason — that path does NOT throw.

- [ ] **S43B-2: Logging contract** (`src/recall.ts`, `src/queryReformulation.ts`)
  Every `query_reformulation` event logs **real** fields (no stub, no placeholder):
  ```ts
  log?.info("query_reformulation", {
    query: rawQuery.slice(0, 80),
    expanded: reformulation.expanded.slice(0, 120),
    neighborCount: reformulation.neighbors.length,
    topTerms: reformulation.terms.map(t => t.term).slice(0, 5),
    rrfApplied: reformulation.rrfApplied,
    fromCache: reformulation.fromCache,
    uncalibrated: reformulation.uncalibrated,   // list of constant names that were defaults, not sourced
    fusedResultCount: fusedHits?.length ?? 0,
  });

  log?.info("query_reformulation_skipped", {
    query: rawQuery.slice(0, 80),
    reason: "empty_corpus" | "thin_corpus" | "not_vague",
  });

  // Error path (only when something threw):
  log?.error("query_reformulation_failed", {
    query: rawQuery.slice(0, 80),
    error: String(e && e.message ? e.message : e),
  });
  ```

  **Cache TTL eviction hit-rate log (periodic, not silent):**
  ```ts
  // On every cache hit or miss, increment a counter. Every Nth call
  // (configurable, default 100), log the hit rate. This makes cache
  // health visible to operators — the old HyDE cache was silent.
  log?.info("query_reformulation_cache_stats", {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: cacheHits / (cacheHits + cacheMisses),
    evictions: cacheEvictions,
  });
  ```

- [ ] **S43B-3: Integration tests** (`extensions/mega-compact.test.ts` or new file)
  - With `QUERY_REFORMULATION_ENABLED=true` (default) + vague query: reformulation is applied, `expanded !== original`, `rrfApplied === true`, search uses the fused hits, `query_reformulation` event is logged with real `{query, expanded, neighbors, terms, rrfApplied, uncalibrated}`
  - With `QUERY_REFORMULATION_ENABLED=true` + specific query: reformulation is skipped (`reason: "not_vague"`), `expanded === original`, `rrfApplied === false`, search uses raw query
  - With `QUERY_REFORMULATION_ENABLED=false`: no reformulation processing, search uses raw query, no `query_reformulation*` events logged
  - With `QUERY_REFORMULATION_ENABLED=true` + empty corpus: `query_reformulation_skipped` event logged with `reason: "empty_corpus"`, search uses raw query
  - With `QUERY_REFORMULATION_ENABLED=true` + embedder throws: `query_reformulation_failed` event logged with the real error, search uses raw query (graceful)
  - S41 quality gate always uses the original raw query (not the expanded query)
  - Cache TTL expiry: after TTL, a new scan happens and is logged
  - Full test-suite regression passes with the flag ON (default) AND with the flag OFF

- [ ] **S43B-4: Monitoring hooks** (`src/monitoring.ts` or via existing event system)
  Add metrics for reformulation effectiveness (all derived from the existing structured events; dashboard visualization is out of scope):
  - `query_reformulation_invocations_total` — count of reformulation applications (vague + non-empty-corpus)
  - `query_reformulation_skips_total{reason}` — count of skips by reason
  - `query_reformulation_failures_total` — count of failures (embedder/store throws)
  - `query_reformulation_cache_hits_total` — cache hits
  - `query_reformulation_cache_misses_total` — cache misses
  - `query_reformulation_cache_evictions_total` — TTL evictions
  - `rrf_fused_result_count_avg` — average number of fused results

---

## ACCEPTANCE CRITERIA

1. **Zero LLM calls anywhere** — `grep -riE "ollama|hyde|fetch.*11434|MEGACOMPACT_HYDE|MEGACOMPACT_HYDE_MODEL|MEGACOMPACT_HYDE_URL" src/ extensions/` returns nothing. The `hydeTransform` LLM bridge, the `HYDE_PROMPTS`, the `fetch` to localhost Ollama, the `guardrails-allow PREVENT-PI-004` annotation for the LLM path, the `variations` count (3), the LLM temperature (0.3), and the LLM token limit (200) are all gone. No Ollama dependency.

2. **Every input real** — every expansion term is backed by:
   - a real query embedding from `TrigramEmbedder.embed()` (in-process, `src/embedder.ts:63`)
   - a real linear scan over the real `context_chunks` store (real SQLite, real `embedding_blob`)
   - a real cosine similarity (`src/embedder.ts:34`)
   - a real TF-IDF (real term frequency over the neighbor document, real inverse document frequency over the real corpus) — NOT a hand-picked stopword list
   - a real re-embedded expanded query

3. **Constants configurable + uncalibrated-labeled (except RRF k=60)** — every new numeric constant is env-overridable. Source labels:
   - `RRF_K = 60` labeled `// sourced` (original RRF paper, Cormack et al. 2009)
   - `EXPANSION_NEIGHBOR_COUNT`, `EXPANSION_TOP_TERMS`, `VAGUE_MIN_WORDS`, `VAGUE_VERY_SHORT_WORDS`, `QUERY_REFORM_CACHE_TTL_SECONDS` labeled `// uncalibrated — default, tuneable`
   The `uncalibrated` field in every `query_reformulation` event lists which constants were defaults at runtime (never includes `RRF_K`).

4. **Error-logging contract** — on embedder/store failure, the original query result is returned AND a `query_reformulation_failed` event logs the real error (not silent). The empty/thin-corpus fallback emits `query_reformulation_skipped` with a real reason, not a silent no-op.

5. **Gate default ON** — `QUERY_REFORMULATION_ENABLED` defaults to `true` (env `MEGACOMPACT_QUERY_REFORMULATION_ENABLED=false` to disable). The flag is a real gate: when ON, the algorithm runs end-to-end or emits a failure event; when OFF, `recallAndInline()` behaves identically to today.

6. **No silent no-op possible** — the audit verdict on the old HyDE plan was "stub masquerading as a feature." The new design makes silent no-ops structurally impossible: the algorithm either (a) runs all five real stages and emits a `query_reformulation` event with real fields, (b) skips with a `query_reformulation_skipped` event carrying a real reason, or (c) fails with a `query_reformulation_failed` event carrying the real error. There is no fourth path.

7. **Vagueness detection** — `isVagueQuery()` returns `true` for "what did we decide about auth?" and `false` for "how does VectorStore.search() filter checkpoints by sessionId in the SQLite store?", using the configurable thresholds. Misclassification only changes which path runs (raw-only vs. raw+expanded), not whether a stub no-ops.

8. **TF-IDF correctness** — `extractExpansionTerms()` returns terms ranked by real TF-IDF. A rare term ("jwt", df=1 in a 100-doc corpus) ranks above a frequent term ("the", df=90 in a 100-doc corpus) even when their TF is equal. No hand-picked stopword list is used anywhere.

9. **RRF fusion** — `reciprocalRankFusion()` correctly merges two ranked lists: items appearing high in multiple lists rank higher than items appearing high in only one list. The `k=60` is sourced from the original RRF paper and labeled `// sourced`.

10. **Integration** — With `QUERY_REFORMULATION_ENABLED=true` (default), `recallAndInline()` reformulates vague queries before searching and RRF-fuses results. With the flag OFF, `recallAndInline()` behaves identically to today's production (raw-query search only).

11. **Quality gate** — The S41 self-RAG quality gate (`recallCritique.ts`) always receives the **original** raw query, not the expanded query. This ensures relevance checking is based on what the user actually asked.

12. **Regression** — Full test suite passes with the flag ON (default) and with the flag OFF. Zero behavior change when the flag is OFF.

---

## ROLLBACK

1. **Feature flag** — Set `MEGACOMPACT_QUERY_REFORMULATION_ENABLED=false` to disable query reformulation. Unlike the old HyDE flag (which hid a silent no-op), this flag gates a real algorithm: when OFF, `recallAndInline()` reverts to today's raw-query search only.

2. **Code rollback** — Revert changes to:
   - `src/recall.ts` — remove reformulation integration (revert to direct `recall()` call with `searchQuery = rawQuery`)
   - `src/config/dedup.ts` — remove the S43 config fields
   - Delete `src/queryReformulation.ts` and `src/queryReformulation.test.ts`

3. **No database changes** — Query reformulation is purely a query-side transformation. It reads real `context_chunks` rows but never writes. The store-reader methods (`scanNeighbors`, `totalChunks`, `docFreq`) are pure read methods added to the `VectorStore` interface; no schema change. Rollback has zero data impact.

4. **Cache** — The in-memory reformulation cache is ephemeral (process lifetime). No persistent cache to clean up.

5. **No Ollama cleanup needed** — Unlike the old HyDE plan, the new design has no Ollama dependency to remove. There is no `MEGACOMPACT_HYDE_URL` or `MEGACOMPACT_HYDE_MODEL` to unset. Rollback is purely code + flag.

---

## RISKS

1. **Empty/thin corpus → weak expansion terms** — the new algorithm uses real embedding neighbors. If the `context_chunks` store is empty or has very few chunks, the neighbor scan returns nothing (or too little) and the TF-IDF extraction produces no terms. **Mitigation:** this case is detected explicitly in `reformulateQuery` and emits a `query_reformulation_skipped` event with `reason: "empty_corpus"` or `"thin_corpus"`, then falls back to the raw-query search. This is the explicit, logged path — not a silent no-op. Operators can see it in the logs and know expansion didn't fire.

2. **Vagueness-detection misclassification** — `isVagueQuery()` is a keyword/length heuristic. It may misclassify queries (e.g., "what was the error" might be classified as vague and trigger expansion when raw-query search would have been fine; or a specific query might slip through and skip expansion). **Mitigation (reframed from the old plan):** misclassification changes WHICH PATH runs (raw-only vs. raw+expanded), not whether a stub no-ops. Both paths are real algorithms; the cost of misclassification is a slightly different result set, not a silent failure. The thresholds are configurable (`VAGUE_MIN_WORDS`, `VAGUE_VERY_SHORT_WORDS`) and labeled `// uncalibrated — default, tuneable` so they can be calibrated from real telemetry later.

3. **Multi-query latency (now 2 searches, not 4)** — reformulation runs 2 searches per vague query (raw + expanded), down from the old plan's 4 (1 raw + 3 LLM variations). The linear scan over `embedding_blob` is fast for typical checkpoint counts (hundreds, not millions), and the future ANN index (PGlite HNSW) makes this negligible. The expanded-query search re-uses the existing `store.search()` path; no new scan code. **Mitigation:** the cache prevents re-running the neighbor scan + TF-IDF for repeated queries; the future ANN index makes this a non-issue.

4. **TF-IDF corpus size estimation** — computing real document frequency (`docFreq`) over the full `context_chunks` store requires counting how many chunks contain each candidate term. For a small corpus this is fast; for a very large one it could be slow if naively re-scanned per term. **Mitigation:** the `docFreq` reader is backed by the existing FTS5 `trigram` index on `context_chunks` (see `src/store/sqlite.ts` schema) — FTS5 answers document-frequency queries in O(log N), not O(N). The reader is also cached per-reformulation-call.

5. **Interaction with S42 (multi-level RAPTOR)** — if both S42 and S43 are enabled, a vague query goes through: query reformulation → multi-level RAPTOR search → RRF fusion → MMR diversification → quality gate. This is a complex pipeline. Each stage is individually feature-flagged, so operators can enable one at a time. **Mitigation:** document the recommended enablement order (S42 first, then S43) and the `uncalibrated` field in every event makes it visible which constants are still defaults.

6. **Cache memory** — the in-memory reformulation cache grows unbounded if many unique vague queries are processed. **Mitigation:** (a) TTL eviction on read, (b) practical limit: a single session generates at most hundreds of unique queries, (c) the periodic `query_reformulation_cache_stats` event surfaces hit rate and evictions so operators can see cache health (the old HyDE cache was silent), (d) process restart clears cache. If this becomes an issue, add a max-size LRU eviction policy.

7. **~Removed risk:~ "HyDE requires Ollama"** — this risk from the prior plan is DELETED. The new design has zero Ollama dependency. There is no LLM to be unavailable; there is no silent fallback to a raw-query stub. The only fallback paths are the explicitly-logged `query_reformulation_skipped` (empty/thin corpus or non-vague query) and `query_reformulation_failed` (embedder/store throw) events.
