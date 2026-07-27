# S47 — Auto-Categorizing Memory Wiki

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S40 (importance scoring), S42 (RAPTOR multi-level retrieval), S46 (visual memory map), `src/store/sqlite.ts`, `extensions/dashboard-server/server.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## RE-PLAN 2026-07-25

This spec was re-planned on 2026-07-25 after an audit found that the prior version contained the **highest proportion of invented data** of all the RAG specs:

1. **The entire topic taxonomy was fabricated.** The 4 parent topics (`code`, `infrastructure`, `process`, `debugging`) and 10 sub-topics (`authentication`, `database`, `api`, `frontend`, `deployment`, `monitoring`, `storage`, `errors`, `performance`, `decisions`, `testing`) were a single developer's intuition — there was **no corpus analysis** and **no category discovery**. Their hardcoded keyword lists (e.g. `auth/login/jwt/token/oauth/session/password`, `sql/sqlite/pg/migration/schema/query/index`, the 30+ terms across the taxonomy) caused ambiguous multi-category assignments and could not be grounded in what the user's memories actually discuss. The taxonomy is **REMOVED**.

2. **The Ollama LLM path is REMOVED** (full decision). The prior `WIKI_TOPIC_MODEL=llm|hybrid` path called localhost Ollama for classification + summary generation — a PREVENT-PI-004 violation that silently no-op'd in the default config (Ollama absent). The LLM path is **DELETED**; only the local path remains.

3. **Categories are now DERIVED BY CLUSTERING REAL CHECKPOINT EMBEDDINGS.** The replacement algorithm runs **k-means** (or hierarchical clustering) on the **real `context_chunks.embedding_blob`** vectors in the store. The cluster count `k` is chosen by a **real criterion** (elbow method on real within-cluster sum of squares, or silhouette score — both pure local math on real vectors). No hand-picked `k`.

4. **Cluster labels are extracted from real TF-IDF terms** of real member chunks. For each cluster, take the top-TF-IDF terms across its real member chunks (real term frequency, real inverse document frequency over the real corpus). The top 3–5 terms become the cluster's label. No fabricated keyword lists.

5. **No LLM.** The Ollama summary path is DELETED. Wiki page summaries are **extractive** — real top sentences by real TF-IDF weighting — using the same honest boundary as S42 (`src/dedup/raptor/summarizer.ts`). No synthetic generation.

6. **`WIKI_TOPIC_MODEL=llm|hybrid` is DELETED.** Only the local path remains — but "local" now means "real k-means + real TF-IDF", not "hand-picked keywords."

7. **Confidence is a REAL cluster-membership confidence**: cosine distance from the chunk to its assigned centroid, normalized. A real number, not `min(1.0, matchCount/5)` (the divisor 5 was invented).

The prior `matchCount/5` confidence formula, the `2 matches to assign` minimum threshold, and the LLM summary prompt were all invented and unverified — they are removed. The Problem section is reframed: the problem is still "memories need categorization for a wiki view," but the solution is **real clustering**, not a fabricated taxonomy.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004** (no network): topic clustering is pure in-process local math — k-means + TF-IDF over real `context_chunks.embedding_blob` vectors and real member-chunk text. **No Ollama, no LLM, no `fetch`/HTTP to remote.** The wiki dashboard is localhost-only (same exception class as the existing `/dashboard` server, audited via `guardrails-allow` inline annotations).
- **PREVENT-PI-001** (anchor floor): the wiki is a read-only presentation layer over stored memories. It does not modify message ordering, drop ranges, or checkpoint storage.
- **Feature flags default ON**: `AUTO_WIKI_ENABLED` defaults to `true`. Wiki tables are created at schema-init time when enabled; clustering runs on the rebuild trigger (every Nth compaction). Setting `AUTO_WIKI_ENABLED=false` suppresses all wiki behavior.
- **Rebuild-time assignment**: topics are assigned when the wiki is rebuilt (every Nth compaction), not at every checkpoint write. This bounds the clustering cost — a full pass over `context_chunks` runs only when the count trigger fires.
- **Non-fatal**: clustering or assignment failure logs a warning and continues. Memories without a confident cluster assignment are simply uncategorized.

Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Conversation memories accumulate as a flat list in the `memories` and `context_chunks` tables. There is **no organizational structure** beyond timestamps and RAPTOR clusters:

1. **No topical organization** — to find all memories about "authentication", the user must search by text. There is no browsable category. RAPTOR clusters (`src/dedup/raptor/`) group *similar* memories, but clusters are ephemeral (rebuilt on tree construction) and not user-navigable.

2. **No knowledge base** — memories are transactional (created, retrieved, injected). There is no way to browse a synthesized view of "what do I know about deployment?" or "what patterns appear across the database-related memories?"

3. **No topic hierarchy** — RAPTOR clusters are flat (leaf → level-1 → root). There is no semantic hierarchy of categories.

4. **No topic summaries** — even if memories were grouped, there is no auto-generated summary for each topic. The user would have to read every memory individually.

5. **Sprint S46 provides visual navigation** (memory map) but not *categorical* navigation. The wiki complements the map: the map shows relationships, the wiki shows categories.

**The solution is real clustering, not a fabricated taxonomy.** Prior approach (hardcoded 4-parent / 10-sub-topic tree with hand-picked keyword lists) reflected a single developer's intuition, not what the user's memories actually discuss. The re-plan derives categories from the real corpus: k-means on real `embedding_blob` vectors, with cluster labels extracted from real TF-IDF terms of real member chunks. Categories track what is *actually* in the store.

---

## SCOPE

### IN SCOPE (new files):
- `src/topics/cluster.ts` — k-means + silhouette/elbow selection over real embeddings
- `src/topics/labels.ts` — TF-IDF term extraction + cluster labeling
- `src/topics/types.ts` — `Topic`, `TopicAssignment`, `ClusterModel` types
- `src/topics/index.ts` — barrel re-export
- `src/topics/cluster.test.ts` — unit tests for k-means + label extraction
- `src/wiki.ts` — wiki page generation (extractive summaries) from cluster topics
- `src/wiki.test.ts` — unit tests for wiki generation
- `src/store/sqlite/topics.ts` — SQLite topic storage (tables + CRUD)
- `src/store/sqlite/topics.test.ts` — unit tests for topic storage
- `extensions/dashboard-client/src/tabs/WikiTab.tsx` — wiki dashboard tab
- `extensions/dashboard-client/src/components/WikiPage.tsx` — wiki page renderer
- `extensions/dashboard-client/src/components/TopicTree.tsx` — topic hierarchy browser

### IN SCOPE (modified files):
- `extensions/mega-events/compact-handlers.ts` — trigger wiki rebuild on the Nth compaction count
- `extensions/dashboard-server/server.ts` — add wiki API endpoints
- `extensions/dashboard-client/src/App.tsx` — add "Wiki" tab
- `src/store/sqlite.ts` — add barrel re-export for topics submodule
- `src/config/dedup.ts` — add wiki config flags

### OUT OF SCOPE:
- Real-time topic updates — topics are assigned at rebuild time (every Nth compaction), not refreshed per-write.
- User-editable topics — wiki pages are auto-generated; manual editing is a future feature.
- Full-text search within wiki — the wiki is browsed by topic tree; search is via existing `/recall-context` endpoint.
- LLM-based summarization — DELETED. Summaries are extractive (real top sentences by real TF-IDF), same honest boundary as S42.
- Calibration script — the clustering derives from real data; there are no invented weights to calibrate.

---

## EXECUTION

### Sprint S47A: Real Clustering + TF-IDF Labeling

**Goal:** Derive topic clusters from real `context_chunks.embedding_blob` vectors; label each cluster with top TF-IDF terms of its real member chunks.

**Acceptance:** `buildTopicModel(db)` returns a `ClusterModel` with k clusters, where k was chosen by a real criterion (elbow or silhouette on real vectors), and each cluster has a label derived from real TF-IDF terms. Zero hardcoded keyword lists. Zero LLM calls.

**Tasks:**

- [ ] **S47A.1** Create `src/topics/types.ts` with types
  - `Topic`: `{ id: string; label: string; termScores: Array<{ term: string; score: number }>; memoryCount: number; lastUpdated: number }`
  - `TopicAssignment`: `{ memoryId: string; topicId: string; confidence: number; assignedAt: number; method: "kmeans+tfidf" }`
  - `ClusterModel`: `{ topics: Topic[]; assignments: TopicAssignment[]; k: number; criterion: "elbow" | "silhouette"; silhouetteScore: number; totalChunks: number; builtAt: number }`

- [ ] **S47A.2** Implement `loadEmbeddings(db): Array<{ chunkId: string; vec: Float32Array }>`
  - Read real `embedding_blob` from `context_chunks` (existing column, see `src/store/sqlite.ts`)
  - Skip rows with null/empty embeddings
  - Return as a typed array
  - If fewer than `WIKI_K_RANGE[0]` chunks have embeddings: return empty (caller falls back to single 'general' cluster)

- [ ] **S47A.3** Implement k-means over real embeddings
  - Standard Lloyd's algorithm: initialize with k-means++ seeding (deterministic given a seeded RNG)
  - Distance: cosine (embeddings are L2-normalized per `src/embedder.ts:TrigramEmbedder`)
  - Convergence: centroid movement < 1e-4 or 50 iterations
  - Multiple restarts (default 5), keep lowest within-cluster sum of squares (WCSS)

- [ ] **S47A.4** Implement k selection by a real criterion
  - For `k` in `WIKI_K_RANGE` (default `[3, 15]`):
    - Run k-means
    - Record WCSS (for elbow) and silhouette score (for silhouette)
  - **Elbow method**: pick the k at the point of max curvature on the WCSS-vs-k curve (real geometric computation on the real curve, not a hand-picked k).
  - **Silhouette method** (default, when corpus is large enough): pick the k with the highest mean silhouette score across all clusters.
  - If the corpus is too small for silhouette (silhouette undefined for k=1 or trivially for very small N): fall back to elbow. If still degenerate: log a warning and return a single "general" cluster.

- [ ] **S47A.5** Implement TF-IDF cluster labeling
  - For each cluster, gather its real member chunks' text (the `content` column of `context_chunks`).
  - Tokenize: lowercase, split on whitespace/punctuation (standard tokenization, no domain keyword list).
  - Compute real TF (term frequency within the cluster's member chunks) and real IDF (inverse document frequency over the *entire corpus* — all chunks in `context_chunks`, not just this cluster's members).
  - TF-IDF score per term: `tf * idf`.
  - Top `WIKI_LABEL_TOP_TERMS` (default 3–5) terms by score become the cluster's `label` (joined with a separator). `termScores` keeps the full sorted list.
  - No stopwords list is fabricated — common terms naturally have low IDF and are filtered out by the math. (Optional: standard English stopword list is a *configurable* opt-in, never the default classifier of "what the user's memories discuss.")

- [ ] **S47A.6** Implement confidence as real cluster-membership
  - For each assigned chunk: `confidence = (1 + cosine(chunkVec, centroidVec)) / 2` — cosine is in [-1, 1], normalized to [0, 1].
  - Chunks assigned to their closest centroid. A chunk whose top-2 centroids are within a small margin (default 0.05 on the normalized scale) is flagged low-confidence but still assigned (non-fatal).
  - No invented `matchCount/5` divisor.

- [ ] **S47A.7** Implement `buildTopicModel(db, config): ClusterModel`
  - Orchestrate: load embeddings → pick k → run k-means → assign chunks → label clusters → assemble `ClusterModel`.
  - Pure local math. Zero LLM. Zero network.

- [ ] **S47A.8** Add tests in `src/topics/cluster.test.ts`
  - Test: synthetic embeddings with 3 well-separated clusters → k=3 chosen, clusters correctly separated.
  - Test: corpus too small (< WIKI_K_RANGE[0] chunks) → returns single 'general' cluster, logs warning.
  - Test: degenerate corpus (all-zero embeddings) → returns single 'general' cluster, logs warning, no crash.
  - Test: TF-IDF labels reflect the *actual* high-frequency discriminative terms of synthetic cluster members (seed real terms into the test chunks, assert they appear in the label).
  - Test: confidence is in [0, 1]; closer-to-centroid chunk has higher confidence.
  - Test: deterministic given a seeded RNG.

- [ ] **S47A.9** Verify: `npm run build && npm test`
  - Grep assertion (in a test): no occurrence of "ollama", "llm", "hybrid" in `src/topics/`.
  - Grep assertion (in a test): no occurrence of the 30+ prior fabricated keyword terms ("jwt", "oauth", "sqlite", "graphql", "docker", "TypeError", "p95", etc.) as hardcoded literals in `src/topics/`.

---

### Sprint S47B: Topic Storage + Rebuild Trigger

**Goal:** Persist derived clusters + assignments in SQLite; trigger wiki rebuild on a real compaction count.

**Acceptance:** Clusters survive restart; rebuild fires on every Nth compaction (real count trigger), not a timer.

**Tasks:**

- [ ] **S47B.1** Create `src/store/sqlite/topics.ts` with schema
  - `topics` table: `id TEXT PRIMARY KEY, label TEXT NOT NULL, term_scores TEXT /* JSON array of {term, score} */, memory_count INTEGER DEFAULT 0, last_updated INTEGER, cluster_model_built_at INTEGER`
  - `memory_topics` table: `memory_id TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topics(id), confidence REAL, assigned_at INTEGER, method TEXT CHECK(method IN ('kmeans+tfidf')), PRIMARY KEY (memory_id, topic_id)`
  - Index: `CREATE INDEX idx_memory_topics_topic ON memory_topics(topic_id)`
  - No parent_topic_id column (no fabricated hierarchy — clusters are flat; hierarchy is a future feature if real data supports it).
  - No seed data — topics are derived from real data at rebuild time.

- [ ] **S47B.2** Implement CRUD operations
  - `replaceTopicModel(db, model: ClusterModel)` — atomically clears old topics + assignments and inserts the new model (transaction). Old topics do not persist across rebuilds.
  - `getTopics(db)` → `Topic[]`
  - `getMemoriesForTopic(db, topicId, limit?, offset?)` → `{ memoryId, content, timestamp, importance }[]`
  - `getTopicForMemory(db, memoryId)` → `TopicAssignment | null`
  - `getTopicStats(db)` → `{ totalTopics: number; totalAssigned: number; lastRebuildAt: number }`

- [ ] **S47B.3** Add barrel re-export in `src/store/sqlite.ts`
  - `export * from "./sqlite/topics.js";`

- [ ] **S47B.4** Add config flags to `src/config/dedup.ts`
  - `AUTO_WIKI_ENABLED: boolean` (env: `MEGACOMPACT_AUTO_WIKI`, default: `true`)
  - `WIKI_K_RANGE: [number, number]` (env: `MEGACOMPACT_WIKI_K_RANGE`, default: `[3, 15]`) — the k search space.
  - `WIKI_LABEL_TOP_TERMS: number` (env: `MEGACOMPACT_WIKI_LABEL_TOP_TERMS`, default: `5`) — how many TF-IDF terms form a label.
  - `WIKI_REBUILD_EVERY_N_COMPACTS: number` (env: `MEGACOMPACT_WIKI_REBUILD_EVERY`, default: `10`) — real count trigger.
  - **DELETED**: `WIKI_TOPIC_MODEL`, `WIKI_MAX_TOPICS`, `WIKI_MIN_MEMORIES_PER_TOPIC` — these encoded the fabricated taxonomy or the LLM path. K is now derived; minimum-per-topic is now the natural `WIKI_K_RANGE[0]` floor.

- [ ] **S47B.5** Implement the rebuild trigger in `extensions/mega-events/compact-handlers.ts`
  - Maintain a compaction counter (persisted in `session_state` as `wiki_compact_counter`).
  - After each compaction: increment counter. When `counter % WIKI_REBUILD_EVERY_N_COMPACTS === 0` AND `AUTO_WIKI_ENABLED === true`:
    - Call `buildTopicModel(db, config)`.
    - Call `replaceTopicModel(db, model)`.
    - Log `wiki_rebuild` event with real metrics (see Error-Logging Contract below).
  - Non-fatal: any failure logs a warning, continues, does not affect compaction.

- [ ] **S47B.6** Add tests in `src/store/sqlite/topics.test.ts`
  - Test: schema creation.
  - Test: `replaceTopicModel` is atomic (old model gone, new model in place).
  - Test: rebuild counter increments correctly; fires on every Nth compaction.
  - Test: `AUTO_WIKI_ENABLED=false` → no rebuild, no topic table writes.
  - Test: rebuild failure does not corrupt existing model (transaction rollback).

- [ ] **S47B.7** Verify: `npm run build && npm test`

---

### Sprint S47C: Wiki Page Generation (Extractive)

**Goal:** Generate wiki pages from cluster topics — extractive summary (real top sentences by real TF-IDF), key memories, related topics.

**Acceptance:** `generateWikiPage(topicId)` returns a structured wiki page with all sections. Zero LLM calls.

**Tasks:**

- [ ] **S47C.1** Create `src/wiki.ts` with types
  - `WikiPage`: `{ topic: Topic; summary: string; keyMemories: Array<{ content: string; timestamp: number; importance: number }>; recentMemories: Array<{ content: string; timestamp: number; importance: number }>; relatedTopics: Topic[]; generatedAt: number }`
  - `WikiIndex`: `{ topics: Array<{ id: string; label: string; memoryCount: number }> }`

- [ ] **S47C.2** Implement `generateWikiPage(topicId, db): WikiPage`
  - Fetch topic metadata.
  - Fetch memories for topic (ordered by `timestamp DESC`, limit 50).
  - **Summary (extractive, no LLM)**: rank sentences across the topic's member chunks by real TF-IDF weight (real term frequency × real inverse document frequency over the topic's corpus), pick the top-N highest-scoring sentences, concatenate in original document order. Same honest boundary as `src/dedup/raptor/summarizer.ts`.
  - `keyMemories`: top-K by `importance` (from S40) — real importance scores.
  - `recentMemories`: last 10 by `timestamp` — real timestamps.
  - `relatedTopics`: topics that share the most member chunks with this topic (via `memory_topics` join) — real co-occurrence.

- [ ] **S47C.3** Implement `getWikiIndex(db): WikiIndex`
  - Query all topics.
  - Return sorted by `memory_count DESC`.
  - No `WIKI_MIN_MEMORIES_PER_TOPIC` filter (DELETED) — all derived clusters are shown.

- [ ] **S47C.4** Add tests in `src/wiki.test.ts`
  - Test: wiki page has all required sections (summary, keyMemories, recentMemories, relatedTopics).
  - Test: summary is extractive — only sentences that appear verbatim in member chunks are in the summary (no LLM-generated text).
  - Test: empty topic returns minimal page (no crash).
  - Test: related topics are correctly identified via co-occurrence.
  - Test: wiki index is sorted by memory count.
  - Grep assertion (in a test): no occurrence of "ollama" / "llm" / "hybrid" in `src/wiki.ts`.

- [ ] **S47C.5** Verify: `npm run build && npm test`

---

### Sprint S47D: Dashboard Wiki Tab

**Goal:** Add a browsable wiki interface to the dashboard.

**Acceptance:** Wiki tab shows topic list (derived clusters); clicking a topic shows its wiki page.

**Tasks:**

- [ ] **S47D.1** Add API endpoints in `extensions/dashboard-server/server.ts`
  - `GET /api/wiki/index` — returns `WikiIndex` (topic list with counts).
  - `GET /api/wiki/topic/:id` — returns `WikiPage` for a topic.
  - `GET /api/wiki/search?q=term` — search topics by label/term-scores (FTS5 on topic labels).
  - All gated: return 404 when `AUTO_WIKI_ENABLED=false`.

- [ ] **S47D.2** Create `extensions/dashboard-client/src/components/TopicTree.tsx`
  - Flat list of derived clusters (no fabricated hierarchy) — sorted by memory count.
  - Each node: topic label (the top TF-IDF terms), memory count badge, last-rebuild timestamp.
  - Click: load wiki page for that topic.
  - Highlight: currently selected topic.
  - Search input at top: filters topics by label/term.

- [ ] **S47D.3** Create `extensions/dashboard-client/src/components/WikiPage.tsx`
  - Renders a `WikiPage` response:
    - Header: topic label + term-scores (the top TF-IDF terms with their scores).
    - Summary section: extractive summary (rendered as plain paragraphs — clearly NOT LLM-generated).
    - Key Memories section: list with importance indicators.
    - Recent Memories section: scrollable list with timestamps.
    - Related Topics section: clickable links to related wiki pages.
  - "View in Memory Map" link (future: deep-link to S46 memory map focused on this topic).

- [ ] **S47D.4** Create `extensions/dashboard-client/src/tabs/WikiTab.tsx`
  - Layout: two-column (TopicTree on left, WikiPage on right).
  - Initial state: show wiki index overview (total topics, total memories, last rebuild time, k chosen, silhouette score).
  - Loading: show spinner while fetching wiki page.
  - Empty state: "No topics yet — topics are derived after the next compaction cycle" (when fewer than `WIKI_K_RANGE[0]` chunks exist).

- [ ] **S47D.5** Add "Wiki" tab to `extensions/dashboard-client/src/App.tsx`
  - Add `WikiTab` lazy import (~line 22).
  - Add `"wiki"` to `TabId` union (~line 36).
  - Add to `TABS` array (~line 48).
  - Add render case (~line 72).

- [ ] **S47D.6** Verify: `cd extensions/dashboard-client && npm run build && npm test`

- [ ] **S47D.7** Full regression test
  - `MEGACOMPACT_AUTO_WIKI=false npm test` — zero behavior change.
  - `MEGACOMPACT_AUTO_WIKI=true npm test` — all new tests pass.
  - `python3 scripts/regression_check.py --all` — green.

---

## ERROR-LOGGING CONTRACT

- **Gate**: `AUTO_WIKI_ENABLED` (default ON).
- **`wiki_rebuild` event** (emitted by `extensions/mega-events/compact-handlers.ts` on every rebuild):
  - `clusterCount: number` — real k chosen.
  - `totalChunks: number` — real count of chunks with embeddings at rebuild time.
  - `method: "kmeans+tfidf"` — constant.
  - `criterion: "elbow" | "silhouette"` — real criterion used for k selection.
  - `silhouetteScore: number | null` — real mean silhouette score across clusters (null if corpus too small for silhouette).
  - `uncalibrated: false` — constant; the clustering derives from real data, there are no invented weights to calibrate.
- **Assignment failure** (a chunk could not be confidently assigned): log `warn` with `{ memoryId, reason }`, continue (non-fatal).
- **Rebuild failure** (clustering threw): log `error` with `{ error, totalChunks }`, do not replace existing model (transaction rollback), continue (non-fatal).
- **Degenerate corpus**: log `warn` with `{ totalChunks, reason: "corpus-too-small" | "all-zero-embeddings" }`, return single 'general' cluster.

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF**: `AUTO_WIKI_ENABLED=false` creates no tables, runs no clustering, returns 404 on wiki endpoints.
2. **Gate default ON**: `AUTO_WIKI_ENABLED` defaults to `true` — wiki tables are created at schema-init; rebuild fires on every Nth compaction.
3. **Zero LLM calls**: grep for `ollama` / `llm` / `hybrid` across `src/topics/` and `src/wiki.ts` returns **nothing**.
4. **Zero hardcoded keyword lists**: grep for the prior 30+ fabricated keyword terms (`jwt`, `oauth`, `sqlite`, `graphql`, `docker`, `TypeError`, `p95`, `auth`, `migration`, `endpoint`, `react`, `ci/cd`, `container`, `metrics`, `latency`, `backup`, `checkpoint`, `crash`, `stacktrace`, `bottleneck`, `optimize`, `trade-off`, `rationale`, `mock`, `coverage`, `regression`, `assert`, etc.) as hardcoded literals in `src/topics/` returns **nothing**.
5. **Categories derived from real k-means**: clusters come from real `context_chunks.embedding_blob` vectors; k chosen by a real criterion (elbow on real WCSS or silhouette on real distances). No hand-picked k.
6. **Labels from real TF-IDF**: each cluster's label is the top TF-IDF terms of its real member chunks (real TF, real IDF over the real corpus). No fabricated keyword lists.
7. **Confidence is real cluster-membership**: cosine distance from chunk to assigned centroid, normalized to [0, 1]. No invented `matchCount/5` divisor.
8. **Extractive summaries**: wiki page summaries contain only sentences that appear verbatim in member chunks. No LLM-generated text.
9. **Error-logging contract**: `wiki_rebuild` event emits `{clusterCount, totalChunks, method:"kmeans+tfidf", silhouetteScore, uncalibrated:false}`; assignment failures log warnings (non-fatal).
10. **Rebuild trigger is a real count**: every Nth compaction (configurable `WIKI_REBUILD_EVERY_N_COMPACTS`, default 10). No timer.
11. **Wiki pages are complete**: each page has summary, key memories, recent memories, and related topics.
12. **Topic list is navigable**: dashboard shows the derived cluster list; clicking a cluster loads its wiki page.
13. **Non-fatal**: clustering or assignment failure does not prevent compaction, memory storage, or recall.
14. **Performance**: clustering runs only on the Nth compaction (amortized); clustering cost is O(N·k·restarts·iterations) over real chunks — acceptable because it does not run on every compaction.

---

## ROLLBACK

1. Set `MEGACOMPACT_AUTO_WIKI=false` to disable all wiki functionality.
2. Drop `topics` and `memory_topics` tables (SQLite migration not needed — tables are only written when enabled).
3. Remove "Wiki" tab from `TABS` in `App.tsx`.
4. All new code is in new files (`src/topics/`, `src/wiki.ts`, `src/store/sqlite/topics.ts`).
5. Integration point in `extensions/mega-events/compact-handlers.ts` is gated behind `if (config.AUTO_WIKI_ENABLED)`.
6. `WIKI_TOPIC_MODEL` env var is removed from config; old values silently ignored (no migration).

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Clustering quality depends on corpus size — small corpora produce unstable clusters | Medium | Medium | Falls back to a single 'general' cluster (logged) when fewer than `WIKI_K_RANGE[0]` chunks have embeddings or silhouette is undefined. |
| k selection is noisy on small corpora | Medium | Low | Elbow/silhouette computed on real vectors; multiple k-means restarts (default 5) reduce variance. Falls back to 'general' cluster on degenerate input. |
| TF-IDF labels are uninformative for very short chunks | Low | Low | IDF over the real corpus naturally downweights common terms; `WIKI_LABEL_TOP_TERMS` is configurable. |
| Wiki pages are stale until the next Nth compaction | Medium | Low | Pages are regenerated on-demand from stored assignments; `last_rebuild_at` timestamp in the index shows freshness. Rebuild trigger is configurable. |
| Clustering cost on large corpora slows the Nth compaction | Low | Medium | Runs only on the Nth compaction (amortized). Configurable `WIKI_K_RANGE` bounds k. Multiple restarts are bounded (default 5). Can be disabled via `AUTO_WIKI_ENABLED=false`. |
| Large number of uncategorized memories (low-confidence assignments) | Medium | Low | Low-confidence assignments are still recorded (non-fatal); the wiki index shows all derived clusters; "uncategorized" is implicit (memories not in any cluster). |
