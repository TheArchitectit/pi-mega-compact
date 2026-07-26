# S29 — HyDE for Vague Recall Queries

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 12 (vector search), S27 (self-RAG quality gate), `src/recall.ts`, `src/vectorStore.ts`, `src/embedder.ts`
**Priority:** P1
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): HyDE and multi-query expansion operate on the *query* side of recall — they transform the search query before embedding and searching. They never touch the anchor-floor guard in `src/boundary.ts:computeDropRange()`. The anchor floor protects recent messages; HyDE improves recall relevance. These are orthogonal.
- **PREVENT-PI-003** (no system role): recalled context is injected via the `before_agent_start` systemPrompt prepend path. HyDE changes which chunks are retrieved, not how they are injected.
- **PREVENT-PI-004** (no network): HyDE and multi-query expansion call the configured LLM provider. By default this is localhost Ollama (`http://127.0.0.1:11434`), the same loopback exception class as `src/dedup/raptor/summarizer.ts:12` and `src/httpEmbedder.ts`. All LLM calls are annotated with `guardrails-allow PREVENT-PI-004`. No remote API is ever called. Cache prevents repeated LLM calls for the same query.
- **Feature flags default OFF**: `HYDE_ENABLED` and `MULTI_QUERY_ENABLED` both default to `false`. Zero behavior change unless explicitly enabled. When OFF, `recallAndInline()` behaves identically to current production.
- **S27 quality gate preserved**: the original query (not the hypothetical) is always passed to the self-RAG quality gate (`src/recallCritique.ts`). HyDE improves *retrieval*; the quality gate validates *injection*.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's `recallAndInline()` in `src/recall.ts` (line ~128–153) embeds the raw user query and searches the vector store:

1. **Vague queries retrieve irrelevant chunks** — when a user asks "what did we decide about auth?" or "what was that bug we fixed?", the raw query "what did we decide about auth" is embedded via `TrigramEmbedder.embed()` (`src/embedder.ts:64–83`). This embedding represents the *question*, not the *answer*. The actual stored checkpoint says "we decided to use JWT tokens with short-lived refresh tokens" — a very different embedding space. Cosine similarity between the question embedding and the answer embedding is low, so relevant chunks rank poorly.

2. **No query expansion** — a single query produces a single embedding and a single search. If the user writes "auth decision" and the stored chunk says "JWT token architecture", these don't overlap well lexically or semantically. There is no mechanism to expand the query into alternative phrasings that might match better.

3. **Embedding mismatch** — the `TrigramEmbedder` (`src/embedder.ts:64–83`) uses character 3-gram bags-of-counts. This works well when the query and target share vocabulary ("JWT tokens" ↔ "JWT authentication tokens"), but fails on semantic gap ("what did we decide" ↔ "we decided to use"). HyDE bridges this gap by generating a hypothetical answer that uses the *same vocabulary* as the stored chunks.

4. **No LLM-assisted retrieval** — the recall path is entirely embedding-based (no LLM involvement). The compaction pipeline uses LLM for summarization (`src/dedup/raptor/summarizer.ts`), but the query side has no LLM assistance. HyDE and multi-query expansion would bring LLM power to the query side, complementing the existing embedding search.

5. **Token waste on irrelevant recall** — when vague queries retrieve irrelevant chunks, those chunks consume system-prompt tokens without helping the agent. This is worse than no recall at all (it wastes tokens and may confuse the agent).

**Root cause:** the recall path treats every query identically — embed it raw, search, inject. There is no awareness of query quality (vague vs. specific) and no mechanism to improve the query before searching.

---

## SCOPE

### IN SCOPE (new files):
- `src/hyde.ts` — HyDE transformer (hypothetical document generation, prompt templates, TTL cache)
- `src/hyde.test.ts` — unit tests for HyDE
- `src/queryExpansion.ts` — multi-query expansion + RRF fusion
- `src/queryExpansion.test.ts` — unit tests for multi-query and RRF

### IN SCOPE (modified files):
- `src/recall.ts` — integrate HyDE and multi-query into `recallAndInline()` between query construction and embedding
- `src/config/dedup.ts` — add HyDE + multi-query config flags
- `src/log.ts` — add HyDE logging event types (or use existing `Logger`)

### OUT OF SCOPE:
- Changes to `src/vectorStore.ts` — HyDE produces an alternative query string that is fed to the existing `search()` call
- Changes to `src/engine.ts` — recall is called via `recallAndInline()`, not directly
- Changes to `src/embedder.ts` — HyDE uses the existing embedder to embed the hypothetical document
- LLM-based re-ranking of results (cross-encoder reranking) — future enhancement
- Learning which queries are "vague" from feedback — future enhancement
- Dashboard visualization of HyDE metrics — future sprint

---

## EXECUTION

### Sprint S29A: HyDE Transformer

**Goal:** Build a HyDE (Hypothetical Document Embedding) transformer that takes a vague query, generates a hypothetical answer via LLM, and returns it for embedding and search.

**Acceptance:** `src/hyde.test.ts` passes; HyDE generates plausible hypothetical documents; TTL cache prevents redundant LLM calls; graceful fallback on LLM failure.

**Tasks:**

- [ ] **S29A-1: Define HyDE types and prompt templates** (`src/hyde.ts`)
  ```ts
  import type { Embedder, Vector } from "./embedder.js";

  /** Query type classification for prompt selection. */
  export type QueryType = "decision" | "fact" | "code" | "error" | "general";

  export interface HyDEOptions {
    /** LLM endpoint (localhost Ollama). Default: MEGACOMPACT_HYDE_URL or http://127.0.0.1:11434 */
    llmUrl?: string;
    /** LLM model. Default: MEGACOMPACT_HYDE_MODEL or MEGACOMPACT_RAPTOR_MODEL */
    llmModel?: string;
    /** Cache TTL in seconds. Default: 3600 (1 hour). */
    cacheTtlSeconds?: number;
  }

  export interface HyDEResult {
    /** The hypothetical document (answer). */
    hypothetical: string;
    /** Whether the LLM was used (false = cache hit or fallback). */
    llmUsed: boolean;
    /** Whether the result came from cache. */
    fromCache: boolean;
    /** Classified query type. */
    queryType: QueryType;
  }
  ```
  Prompt templates:
  ```ts
  const HYDE_PROMPTS: Record<QueryType, string> = {
    decision: `You are a helpful assistant. A developer is asking about a decision that was made in a previous conversation. Generate a short, specific answer (2-3 sentences) that describes what was decided. Use concrete technical terms.\n\nQuestion: {query}\n\nAnswer:`,
    fact: `You are a helpful assistant. Generate a short, factual answer (2-3 sentences) to the following question. Be specific and use technical terms.\n\nQuestion: {query}\n\nAnswer:`,
    code: `You are a helpful assistant. Generate a short answer (2-3 sentences) describing code or implementation details that would answer the following question. Include specific function names, file paths, or technical patterns.\n\nQuestion: {query}\n\nAnswer:`,
    error: `You are a helpful assistant. Generate a short answer (2-3 sentences) describing an error, bug, or issue that was encountered and how it was resolved. Be specific.\n\nQuestion: {query}\n\nAnswer:`,
    general: `You are a helpful assistant. Generate a short, specific answer (2-3 sentences) to the following question. Use concrete details.\n\nQuestion: {query}\n\nAnswer:`,
  };
  ```

- [ ] **S29A-2: Implement query type classification** (`src/hyde.ts`)
  ```ts
  /**
   * Classify a query into a type category for prompt selection.
   * Pure heuristic: keyword matching, no LLM call.
   */
  export function classifyQuery(query: string): QueryType
  ```
  Rules (ordered, first match wins):
  - `decision`: contains "decide", "chose", "picked", "opted", "decision", "trade-off", "tradeoff", "why did we"
  - `error`: contains "bug", "error", "fix", "crash", "broke", "issue", "fail", "broken", "regression"
  - `code`: contains "implement", "function", "code", "file", "module", "class", "method", "how does", "how is", "where is"
  - `fact`: contains "what is", "what was", "what are", "when", "who", "which", "how many", "how much"
  - `general`: everything else

- [ ] **S29A-3: Implement TTL cache** (`src/hyde.ts`)
  ```ts
  /**
   * In-memory TTL cache for HyDE results.
   * Key: FNV-1a hash of normalized query string.
   * Value: { hypothetical: string, timestamp: number }.
   * Eviction: lazy (check TTL on read, not on write).
   */
  const hydeCache = new Map<string, { hypothetical: string; timestamp: number }>();

  function cacheKey(query: string): string {
    // Normalize: lowercase, collapse whitespace, trim
    return fnv1a(query.toLowerCase().replace(/\s+/g, " ").trim()).toString(36);
  }

  function getCached(query: string, ttlMs: number): string | null {
    const entry = hydeCache.get(cacheKey(query));
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttlMs) {
      hydeCache.delete(cacheKey(query));
      return null;
    }
    return entry.hypothetical;
  }

  function setCache(query: string, hypothetical: string): void {
    hydeCache.set(cacheKey(query), { hypothetical, timestamp: Date.now() });
  }
  ```
  Note: `fnv1a` is already available in `src/embedder.ts:50–55`. Re-export or duplicate (pure function, no deps).

- [ ] **S29A-4: Implement LLM call for hypothetical document generation** (`src/hyde.ts`)
  ```ts
  /**
   * Generate a hypothetical document for a query using the configured LLM.
   * Uses the same spawnSync pattern as `src/dedup/raptor/summarizer.ts:48–82`
   * (localhost Ollama, PREVENT-PI-004 annotated).
   *
   * Returns null on failure (caller falls back to raw query).
   */
  export async function generateHypotheticalLLM(
    query: string,
    queryType: QueryType,
    opts: HyDEOptions,
  ): Promise<string | null>
  ```
  Implementation:
  1. Build prompt: `HYDE_PROMPTS[queryType].replace("{query}", query)`
  2. Call Ollama via `spawnSync` (same pattern as `summarizer.ts:57–76`):
     ```ts
     const WORKER = String.raw`
       const url = process.env.H_URL, model = process.env.H_MODEL, prompt = process.env.H_PROMPT;
       try {
         const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
           body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3, num_predict: 200 } }) });
         // guardrails-allow PREVENT-PI-004: localhost-only user-spawned Ollama server
         const j = await r.json();
         process.stdout.write(JSON.stringify({ ok: r.ok, text: j.response || "" }));
       } catch (e) {
         process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
       }
     `;
     ```
  3. Parse response, return trimmed text or null on failure
  4. Low temperature (0.3) for focused, factual hypothetical answers
  5. Short token limit (200 tokens max) — we just need a plausible answer, not a complete one

- [ ] **S29A-5: Implement top-level `hydeTransform()`** (`src/hyde.ts`)
  ```ts
  /**
   * HyDE transform: take a query, generate a hypothetical answer, return it
   * for embedding. Checks cache first; falls back to raw query on LLM failure.
   *
   * The hypothetical answer is embedded INSTEAD of the original query for search,
   * but the original query is always preserved for quality gate checking (S27).
   */
  export function hydeTransform(
    query: string,
    opts: HyDEOptions = {},
  ): HyDEResult
  ```
  Implementation:
  1. Check cache: `cached = getCached(query, cacheTtlMs)`
  2. If cache hit: return `{ hypothetical: cached, llmUsed: false, fromCache: true, queryType }`
  3. `queryType = classifyQuery(query)`
  4. Call `generateHypotheticalLLM(query, queryType, opts)`
  5. If LLM success: `setCache(query, hypothetical)`, return result
  6. If LLM failure: return `{ hypothetical: query, llmUsed: false, fromCache: false, queryType }` (graceful degradation — use raw query)

- [ ] **S29A-6: Implement vagueness detection** (`src/hyde.ts`)
  ```ts
  /**
   * Heuristic: is this query "vague" enough to benefit from HyDE?
   * Returns true if the query is short, question-like, or lacks specific terms.
   * Used to decide whether to apply HyDE (skip for specific queries).
   */
  export function isVagueQuery(query: string): boolean
  ```
  Rules (ANY match → vague):
  - Length < 8 words AND contains a question word ("what", "why", "how", "when", "where", "which", "who")
  - Length < 5 words (very short queries are always vague)
  - Contains "we decided", "we used", "we chose", "that thing about", "the thing where"
  - Does NOT contain: file paths (`.ts`, `.js`, `/`), specific technical terms (>2 capitalized words), function names (`camelCase` patterns)

- [ ] **S29A-7: Unit tests** (`src/hyde.test.ts`)
  - `classifyQuery()` correctly categorizes decision/code/error/fact/general queries
  - `isVagueQuery()` identifies vague queries ("what did we decide about auth?") and rejects specific ones ("how does VectorStore.search() filter by sessionId?")
  - `hydeTransform()` returns a hypothetical document (mock Ollama)
  - Cache hit: second call with same query returns `fromCache: true` without LLM call
  - Cache TTL expiry: after TTL, a new LLM call is made
  - LLM failure: returns raw query as fallback (`hypothetical === query`)
  - Prompt selection: decision query uses decision prompt, error query uses error prompt

---

### Sprint S29B: Multi-Query Expansion + RRF Fusion

**Goal:** Build a multi-query expansion system that generates query variations and fuses results with Reciprocal Rank Fusion (RRF).

**Acceptance:** `src/queryExpansion.test.ts` passes; expansion generates 2–3 variations; RRF correctly merges multiple result sets.

**Tasks:**

- [ ] **S29B-1: Define multi-query types** (`src/queryExpansion.ts`)
  ```ts
  import type { Embedder, Vector } from "./embedder.js";

  export interface MultiQueryOptions {
    /** Number of variations to generate. Default: 3. */
    variations?: number;
    /** LLM endpoint (localhost Ollama). Default: from HyDE config. */
    llmUrl?: string;
    /** LLM model. Default: from HyDE config. */
    llmModel?: string;
  }

  export interface ExpandedQuery {
    original: string;
    variations: string[];
  }

  export interface RRFResult {
    /** Merged + re-ranked items. */
    items: Array<{ id: string; score: number }>;
  }
  ```

- [ ] **S29B-2: Implement LLM-based query expansion** (`src/queryExpansion.ts`)
  ```ts
  /**
   * Generate query variations using the LLM. Each variation is a rephrasing
   * of the original query that might retrieve different relevant chunks.
   * Uses the same spawnSync Ollama pattern as HyDE.
   *
   * Falls back to empty array on LLM failure (caller uses only the original query).
   */
  export function expandQuery(
    query: string,
    opts: MultiQueryOptions = {},
  ): string[]
  ```
  Implementation:
  1. Build prompt:
     ```
     Generate exactly {N} different ways to ask the following question. Each variation should use different words but ask about the same thing. Output one variation per line, numbered.

     Question: {query}
     ```
  2. Call Ollama via `spawnSync` (same pattern)
  3. Parse numbered list: split on `\n`, strip numbering prefix, trim
  4. Return up to `N` non-empty variations
  5. On failure: return `[]` (original query is always searched regardless)

- [ ] **S29B-3: Implement Reciprocal Rank Fusion (RRF)** (`src/queryExpansion.ts`)
  ```ts
  /**
   * Reciprocal Rank Fusion: merge multiple ranked lists into a single ranking.
   * Standard RRF formula: score(d) = Σ 1/(k + rank_i(d))
   * where k=60 (standard constant from the original RRF paper).
   *
   * @param resultSets - Array of ranked lists, each item has { id: string, rank: number }
   * @param k - RRF constant (default 60)
   * @returns Merged list sorted by fused score descending
   */
  export function reciprocalRankFusion(
    resultSets: Array<Array<{ id: string; rank: number }>>,
    k?: number,
  ): Array<{ id: string; score: number }>
  ```
  Implementation:
  ```ts
  export function reciprocalRankFusion(
    resultSets: Array<Array<{ id: string; rank: number }>>,
    k = 60,
  ): Array<{ id: string; score: number }> {
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
  }
  ```

- [ ] **S29B-4: Implement multi-query search + fusion** (`src/queryExpansion.ts`)
  ```ts
  /**
   * Full multi-query pipeline: expand query → search with each variation →
   * fuse results with RRF → return merged, re-ranked items.
   *
   * The search function is injected (dependency inversion) so this module
   * stays pi-agnostic and testable.
   */
  export function multiQuerySearch(
    query: string,
    search: (q: string, limit: number) => Array<{ id: string; score: number }>,
    opts: MultiQueryOptions & { searchLimit?: number; rrfK?: number },
  ): Array<{ id: string; score: number }>
  ```
  Implementation:
  1. `variations = expandQuery(query, opts)` — may be empty
  2. All queries = `[query, ...variations]`
  3. For each query: `results = search(q, searchLimit)` — returns ranked by similarity
  4. Convert to ranked lists: `rankedList = results.map((r, i) => ({ id: r.id, rank: i + 1 }))`
  5. `fused = reciprocalRankFusion(allRankedLists, rrfK)`
  6. Return fused results

- [ ] **S29B-5: Unit tests** (`src/queryExpansion.test.ts`)
  - `expandQuery()` generates 2–3 variations (mock Ollama)
  - `expandQuery()` returns `[]` on LLM failure
  - `reciprocalRankFusion()` correctly merges two ranked lists:
    - List A: [item1, item2, item3] (rank 1, 2, 3)
    - List B: [item2, item1, item4] (rank 1, 2, 3)
    - Fused: item2 > item1 > item3 ≈ item4 (item2 appears high in both)
  - RRF with empty lists returns empty
  - RRF with single list returns that list's ranking
  - RRF constant `k` affects scoring: higher k → less rank differentiation
  - `multiQuerySearch()` searches with original + variations and fuses results
  - `multiQuerySearch()` uses only original query when expansion fails

---

### Sprint S29C: Integration into Recall Path

**Goal:** Wire HyDE and multi-query expansion into `recallAndInline()` behind feature flags, preserving the original query for S27 quality gate checking.

**Acceptance:** With `HYDE_ENABLED=true`, vague queries trigger HyDE transformation before embedding. With `MULTI_QUERY_ENABLED=true`, queries are expanded and results are fused. With both flags OFF, behavior is identical to current production.

**Tasks:**

- [ ] **S29C-1: Add config flags** (`src/config/dedup.ts`)
  Add to `DedupConfigShape` interface:
  ```ts
  HYDE_ENABLED: boolean;              // default false
  HYDE_CACHE_TTL_SECONDS: number;     // default 3600
  HYDE_LLM_URL: string;               // default "http://127.0.0.1:11434"
  HYDE_LLM_MODEL: string;             // default "" (uses MEGACOMPACT_RAPTOR_MODEL or skips)
  MULTI_QUERY_ENABLED: boolean;        // default false
  MULTI_QUERY_VARIATIONS: number;      // default 3
  RRF_K: number;                       // default 60
  ```
  Add to `loadDedupConfig()`:
  ```ts
  HYDE_ENABLED: envBool("MEGACOMPACT_HYDE_ENABLED", false),
  HYDE_CACHE_TTL_SECONDS: envNum("MEGACOMPACT_HYDE_CACHE_TTL", 3600),
  HYDE_LLM_URL: process.env.MEGACOMPACT_HYDE_URL ?? "http://127.0.0.1:11434",
  HYDE_LLM_MODEL: process.env.MEGACOMPACT_HYDE_MODEL ?? process.env.MEGACOMPACT_RAPTOR_MODEL ?? "",
  MULTI_QUERY_ENABLED: envBool("MEGACOMPACT_MULTI_QUERY", false),
  MULTI_QUERY_VARIATIONS: envNum("MEGACOMPACT_MULTI_QUERY_VARIATIONS", 3),
  RRF_K: envNum("MEGACOMPACT_RRF_K", 60),
  ```

- [ ] **S29C-2: Integrate HyDE into `recallAndInline()`** (`src/recall.ts`)
  Modify `recallAndInline()` (line ~128–153). Insert HyDE between query text construction and the `recall()` call:
  ```ts
  // --- HyDE transform (S29) ---
  let searchQuery = rawQuery;
  let hydeApplied = false;

  if (config?.HYDE_ENABLED) {
    const { hydeTransform, isVagueQuery } = await import("./hyde.js");
    if (isVagueQuery(rawQuery)) {
      const result = hydeTransform(rawQuery, {
        llmUrl: config.HYDE_LLM_URL,
        llmModel: config.HYDE_LLM_MODEL || undefined,
        cacheTtlSeconds: config.HYDE_CACHE_TTL_SECONDS,
      });
      searchQuery = result.hypothetical;
      hydeApplied = result.hypothetical !== rawQuery;
      if (hydeApplied) {
        log?.info("hyde_applied", {
          original: rawQuery.slice(0, 80),
          hypothetical: result.hypothetical.slice(0, 120),
          queryType: result.queryType,
          fromCache: result.fromCache,
          llmUsed: result.llmUsed,
        });
      }
    }
  }

  // --- Multi-query expansion (S29) ---
  let fusedHits: SearchHit[] | null = null;

  if (config?.MULTI_QUERY_ENABLED) {
    const { multiQuerySearch } = await import("./queryExpansion.js");
    const allQueries = expandQueryForRecall(rawQuery, config);
    if (allQueries.length > 1) {
      // Search with each variation, fuse results
      const resultSets: Array<Array<{ id: string; rank: number }>> = [];
      for (const q of allQueries) {
        const hits = store.search(sid, q, limit);
        resultSets.push(hits.map((h, i) => ({ id: h.checkpoint.checkpointId, rank: i + 1 })));
      }
      const fused = reciprocalRankFusion(resultSets, config.RRF_K);
      // Reorder hits by fused score
      fusedHits = fused
        .map(f => hits.find(h => h.checkpoint.checkpointId === f.id))
        .filter(Boolean) as SearchHit[];
    }
  }

  // --- Existing recall path ---
  const { hits: rawHits, newHits } = recall({
    sessionId: sid,
    query: searchQuery,  // HyDE-transformed or raw
    limit,
    skipInjected: true,
  }, store);
  const hits = fusedHits ?? rawHits;

  // S27 quality gate: ALWAYS uses the ORIGINAL query (not hypothetical)
  // This ensures the critique checks relevance to what the user actually asked.
  // ... existing quality gate code ...
  ```
  Note: the actual integration will need to handle the `recall()` function's return type and the injection logic carefully. The `fusedHits` path bypasses the `skipInjected` dedup (since RRF fusion already handles dedup via score merging). A second pass should apply `skipInjected` filtering.

- [ ] **S29C-3: Logging for HyDE events** (`src/recall.ts`)
  Add HyDE-specific log entries using the existing `Logger` interface:
  ```ts
  log?.info("hyde_applied", {
    original: rawQuery.slice(0, 80),
    hypothetical: result.hypothetical.slice(0, 120),
    queryType: result.queryType,
    fromCache: result.fromCache,
    llmUsed: result.llmUsed,
    resultsReturned: hits.length,
  });

  log?.info("multi_query_expansion", {
    original: rawQuery.slice(0, 80),
    variationCount: allQueries.length - 1,
    fusedResults: fusedHits?.length ?? 0,
  });
  ```

- [ ] **S29C-4: Integration tests** (`extensions/mega-compact.test.ts` or new file)
  - With `HYDE_ENABLED=true` + vague query: HyDE is applied, hypothetical is different from original, search uses hypothetical embedding
  - With `HYDE_ENABLED=true` + specific query: HyDE is skipped (not vague), search uses raw query
  - With `HYDE_ENABLED=false` (default): no HyDE processing, search uses raw query
  - With `MULTI_QUERY_ENABLED=true`: query is expanded, RRF fuses results
  - With `MULTI_QUERY_ENABLED=false` (default): no expansion, single search
  - S27 quality gate always uses original query (not hypothetical)
  - HyDE logging: `hyde_applied` event is logged when HyDE is triggered
  - Full 372+ test regression passes with both flags OFF

- [ ] **S29C-5: Monitoring hooks** (`src/monitoring.ts` or via existing event system)
  Add metrics for HyDE effectiveness:
  - `hyde_invocations_total` — count of HyDE applications
  - `hyde_cache_hits_total` — count of cache hits vs LLM calls
  - `hyde_llm_failures_total` — count of LLM failures (fallback to raw query)
  - `multi_query_invocations_total` — count of multi-query expansions
  - `rrf_result_count_avg` — average number of fused results
  These are logged as structured events; dashboard visualization is out of scope.

---

## ACCEPTANCE CRITERIA

1. **HyDE generation** — Given a vague query like "what did we decide about auth?", `hydeTransform()` returns a hypothetical document containing specific technical terms (e.g., "JWT", "tokens", "authentication"). The hypothetical is semantically closer to relevant stored chunks than the raw query.

2. **Query classification** — `classifyQuery()` correctly categorizes queries: "why did we choose PostgreSQL" → `decision`, "what was that crash on startup" → `error`, "where is the VectorStore search function" → `code`.

3. **Vagueness detection** — `isVagueQuery()` returns `true` for "what did we decide about auth?" and `false` for "how does VectorStore.search() filter checkpoints by sessionId in the SQLite store?"

4. **Cache** — Calling `hydeTransform()` twice with the same query returns the cached result on the second call (`fromCache: true`, no LLM call). After TTL expiry, a new LLM call is made.

5. **Graceful degradation** — When the LLM is unavailable, `hydeTransform()` returns the raw query as the hypothetical document. Recall proceeds normally with no error.

6. **Multi-query expansion** — `expandQuery()` generates 2–3 variations of a query. Each variation uses different wording.

7. **RRF fusion** — `reciprocalRankFusion()` correctly merges two ranked lists: items appearing high in multiple lists rank higher than items appearing high in only one list.

8. **Integration** — With `HYDE_ENABLED=true`, `recallAndInline()` applies HyDE to vague queries before searching. With `MULTI_QUERY_ENABLED=true`, queries are expanded and results are fused. With both flags OFF (default), `recallAndInline()` behaves identically to current production.

9. **Quality gate** — The S27 self-RAG quality gate (`recallCritique.ts`) always receives the **original** query, not the hypothetical. This ensures relevance checking is based on what the user actually asked.

10. **Regression** — Full 372+ test suite passes with all new flags OFF (`HYDE_ENABLED=false`, `MULTI_QUERY_ENABLED=false`). Zero behavior change in default configuration.

---

## ROLLBACK

1. **Feature flags** — Set `MEGACOMPACT_HYDE_ENABLED=false` and `MEGACOMPACT_MULTI_QUERY=false` to disable HyDE and multi-query expansion. These are the defaults, so no action is needed unless flags were explicitly enabled.

2. **Code rollback** — Revert changes to:
   - `src/recall.ts` — remove HyDE/multi-query integration (lines ~128–153 revert to direct `recall()` call)
   - `src/config/dedup.ts` — remove HyDE + multi-query config fields
   - Delete `src/hyde.ts`, `src/queryExpansion.ts` (and their tests)

3. **No database changes** — HyDE and multi-query are purely query-side transformations. They do not modify stored data. Rollback has zero data impact.

4. **Cache** — The in-memory HyDE cache is ephemeral (process lifetime). No persistent cache to clean up.

---

## RISKS

1. **LLM latency** — HyDE adds one LLM call per vague query (~0.5–2s on localhost Ollama). This is on the critical path for recall (the user's query is blocked until recall completes). Mitigation: (a) only triggered for vague queries (heuristic filters out specific queries), (b) cache prevents repeated calls, (c) fallback is instant (raw query), (d) the LLM call is a short generation (200 tokens max).

2. **LLM quality** — The hypothetical document quality depends on the Ollama model. Small models (llama3.2:3b) may generate generic or inaccurate hypotheticals. Mitigation: the hypothetical is only used for *search* (embedding similarity), not for the *answer*. The actual stored checkpoint is what gets injected. Even a mediocre hypothetical may be better than a vague raw query.

3. **Multi-query explosion** — With 3 variations + 1 original = 4 searches per query. If `VectorStore.search()` is slow (linear scan over many checkpoints), this multiplies latency by 4x. Mitigation: (a) multi-query is disabled by default, (b) the linear scan is fast for typical checkpoint counts (hundreds, not millions), (c) future ANN index (PGlite) makes this negligible.

4. **Query type misclassification** — `classifyQuery()` is a keyword heuristic. It may misclassify queries (e.g., "what was the error" → `fact` instead of `error`). Mitigation: prompt templates are similar enough that misclassification has minor impact. The general template works as a safe default.

5. **Ollama dependency** — Both HyDE and multi-query require a running localhost Ollama instance. If Ollama is unavailable, HyDE falls back to raw query and multi-query falls back to single search. No user-visible failure, but the features are silently non-functional.

6. **Interaction with S28 (multi-level RAPTOR)** — If both S28 and S29 are enabled, a vague query goes through: HyDE → multi-level RAPTOR search → RRF fusion → MMR diversification → quality gate. This is a complex pipeline. Each stage is individually feature-flagged, so operators can enable one at a time. Mitigation: document the recommended enablement order (S28 first, then S29).

7. **Cache memory** — The in-memory HyDE cache grows unbounded if many unique vague queries are processed. Mitigation: (a) TTL eviction on read, (b) practical limit: a single session generates at most hundreds of unique queries, (c) process restart clears cache. If this becomes an issue, add a max-size LRU eviction policy.
