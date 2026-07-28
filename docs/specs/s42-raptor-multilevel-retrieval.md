# S42 — RAPTOR Multi-Level Retrieval

> **RE-PLAN (2026-07-25):** Prior draft defaulted all feature flags to OFF (conservative ship posture) and proposed an Ollama-based incremental enrichment step (S42C). This revision flips all feature flags to ON — features that default OFF are features that do not ship — and DELETES the Ollama enrichment sub-sprint entirely. Extractive cluster summaries are permanent: deterministic, fully local, no LLM/Ollama dependency (keeps the extension compliant with PREVENT-PI-004 without a `guardrails-allow` exception). Level weights and freshness thresholds are marked `uncalibrated` and require real-data calibration scripts before they can be declared stable. Mock-data language removed from active design.

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 13 (RAPTOR tree build), Sprint 14 (RAPTOR promoted to live recall), S41 (self-RAG quality gate), `src/dedup/raptor/`, `src/vectorStore.ts`, `src/recall.ts`
**Priority:** P1
**Status:** S42A ✅ SHIPPED (v0.8.23, commit `1b78948` — `multilevel.ts` engine + 9 tests) → S42B (config flags + `raptorSearchHits` wiring + `SearchHit.raptorSummary`) and S42D (build history + freshness auto-skip) implement-ready. S42C DELETED in re-plan.
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): multi-level retrieval is additive — it produces `SearchHit[]` that feed into the existing `recallAndInline()` pipeline. The anchor-floor guard in `src/boundary.ts:computeDropRange()` is never touched. Multi-level retrieval affects *which* checkpoints are recalled, not *how* messages are dropped.
- **PREVENT-PI-003** (no system role): recalled RAPTOR nodes are injected via the existing `before_agent_start` systemPrompt prepend path. Multi-level retrieval changes which hits are selected, not the injection mechanism.
- **PREVENT-PI-004** (no network): all retrieval, expansion, dedup, and summary functions are pure in-process math (cosine similarity, BFS traversal, extractive summarization). No Ollama dependency; no `guardrails-allow` exception required. No remote API calls.
- **Feature flags default ON**: `RAPTOR_MULTILEVEL_ENABLED`, `RAPTOR_LEAF_EXPANSION` both default to `true`. `RAPTOR_ENRICHMENT_ENABLED` and S42C are DELETED — extractive summaries are permanent. Zero behavior change unless explicitly disabled. When OFF, `raptorSearchHits()` and `recallAndInline()` behave identically to current production.
- **Gating + error-logging contract** (lines 16–18): every feature is gated (default ON); every run logs structured events with real fields + `uncalibrated` marker where applicable; NO silent failures — if a tier fails it logs `*_failed` with the real error and returns the original result. There is NO code path where RAPTOR silently no-ops and returns nothing; a failed tier must log and fall back to a real result.
- **Shadow mode respected**: `isShadowMode()` (`src/dedup/raptor/index.ts:19`) is honored — when shadow mode is ON, multi-level retrieval returns `[]` regardless of flag state.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's RAPTOR recall path is **flat** — it only serves leaf-level checkpoints despite building a hierarchical tree:

1. **Leaf-only retrieval** — `raptorSearchHits()` in `src/vectorStore.ts` (line ~465–510) calls `stagedExpansion()` which returns **leaf ids only** (`src/dedup/raptor/retrieval.ts:89–108`). The tree's internal summary nodes — which capture higher-level themes like "authentication architecture decisions" or "database migration strategy" — are never served to recall. The user gets individual conversation fragments but never the "big picture."

2. **No level-aware scoring** — `stagedExpansion()` (`src/dedup/raptor/retrieval.ts:55–108`) scores all nodes uniformly by cosine similarity to the query. There is no mechanism to weight leaf nodes (detailed, specific) differently from level-1 clusters (moderate abstraction) or the root (session-wide summary). A leaf about "JWT token expiry" and a level-1 node about "authentication design" would score equally if both are cosimilar to the query.

3. **No leaf expansion** — when a cluster node matches well (e.g., "authentication decisions cluster"), there is no way to fetch its leaf descendants for detailed context. The user sees only the cluster summary, not the individual decisions within it.

4. **Summaries are extractive by design** — the current build in `src/dedup/raptor/tree.ts:summarizeInto()` (line ~97–112) calls `summarizeCluster()` which uses extractive summarization (`src/dedup/raptor/summarizer.ts:39–42`). Extractive summaries are permanent: deterministic, fully local, no LLM dependency. This is the correct default for a memory system — the summaries contain real message text, not LLM paraphrases that may drift.

5. **No build history** — there is no record of when trees were built, with what configuration, or how long they took. Freshness checks in `raptorSearchHits()` compare `tree.builtAt` against `maxCheckpointTimestamp` (`src/vectorStore.ts:486`), but there is no structured build log.

---

## SCOPE

### IN SCOPE (new files)

- `src/dedup/raptor/multilevel.ts` — multi-level retrieval engine (level-weighted scoring, leaf expansion, result dedup)
- `src/dedup/raptor/multilevel.test.ts` — unit tests for multi-level retrieval
- `src/dedup/raptor/buildHistory.ts` — build history tracking + freshness checks
- `src/dedup/raptor/buildHistory.test.ts` — unit tests for build history
- `src/store/sqlite.ts` — add `raptor_build_history` table

### OUT OF SCOPE (DELETED: S42C Ollama enrichment)

- `src/dedup/raptor/enrichment.ts` — DELETED. Extractive summaries are permanent; no LLM/Ollama dependency.

### IN SCOPE (modified files)

- `src/vectorStore.ts` — replace `raptorSearchHits()` (line ~465) to use multi-level retrieval instead of leaf-only `stagedExpansion()`
- `src/dedup/raptor/index.ts` — update `runRaptor()` to record build history
- `src/config/dedup.ts` — add RAPTOR multi-level config flags (no enrichment flag — S42C is deleted)
- `src/dedup/raptor/retrieval.ts` — add `multilevelRetrieval()` alongside existing `stagedExpansion()`

### OUT OF SCOPE

- Changes to `src/recall.ts` — the recall path already calls `store.search()` which calls `raptorSearchHits()`. No recall.ts changes needed.
- Changes to `src/engine.ts` — the compaction pipeline builds trees via `runRaptor()` (called from the extension). No engine.ts changes needed.
- GMM soft clustering — k-means++ (`src/dedup/raptor/kmeans.ts`) is retained as the clustering algorithm. GMM is a future enhancement.
- Dashboard visualization of tree levels — future sprint.
- Cross-repo RAPTOR — this sprint is per-session; cross-repo RAPTOR trees are a future enhancement.

---

## EXECUTION

### Sprint S42A: Multi-Level Retrieval Engine

**Goal:** Build a retrieval engine that searches across ALL RAPTOR tree levels with configurable level weights, supports leaf expansion, and deduplicates results.

**Acceptance:** `src/dedup/raptor/multilevel.test.ts` passes; multi-level retrieval returns results from multiple tree levels; leaf expansion adds children to cluster results; dedup removes overlaps.

**Tasks:**

- [ ] **S42A-1: Define multi-level retrieval types** (`src/dedup/raptor/multilevel.ts`)

  ```ts
  export interface MultilevelRetrieveOptions {
    embedder: Embedder;
    /** Weight per tree level (index 0 = leaves, index 1 = level 1, etc.).
     *  Default: [1.0, 0.9, 0.8, 0.7, 0.5]. Capped at tree depth. */
    levelWeights?: number[];
    /** When true, expand cluster hits to include leaf descendants. Default: true. */
    leafExpansion?: boolean;
    /** Max leaf descendants to fetch per cluster hit. Default: 10. */
    maxLeafExpansion?: number;
    /** Final number of results to return. Default: 5. */
    k?: number;
    /** MMR diversity weight. Default: 0.5. */
    mmrLambda?: number;
  }

  export interface MultilevelHit {
    nodeId: string;
    level: number;
    score: number;          // weighted score after level weighting
    rawScore: number;       // raw cosine similarity
    isLeaf: boolean;
    /** Leaf ids covered by this node (for leaf expansion). */
    leafIds: string[];
    summary: string;
    embedding: Vector;
  }
  ```

- [ ] **S42A-2: Implement level-weighted scoring** (`src/dedup/raptor/multilevel.ts`)

  ```ts
  /**
   * Score all RAPTOR tree nodes by cosine similarity to the query, then apply
   * level-specific weights. Returns hits sorted by weighted score descending.
   *
   * Level weights: leaves (level 0) get weight 1.0, level 1 gets 0.9, etc.
   * This ensures detailed leaves score highest while still surfacing higher-level
   * summaries when they're highly relevant.
   */
  export function scoreTreeLevels(
    query: string,
    tree: RaptorTree,
    opts: Pick<MultilevelRetrieveOptions, 'embedder' | 'levelWeights'>,
  ): MultilevelHit[]
  ```

  Implementation:
  - `qv = embedder.embed(query)`
  - For each node in `tree.nodes.values()`:
    - `rawScore = cosineSimilarity(qv, node.embedding)`
    - `levelWeight = levelWeights[min(node.level, levelWeights.length - 1)]`
    - `weightedScore = rawScore * levelWeight`
  - For leaves (ids not in `tree.nodes`): score using the nearest parent's embedding (same approach as `stagedExpansion()` at `retrieval.ts:95–102`)
  - Sort by `weightedScore` descending

- [ ] **S42A-3: Implement leaf expansion** (`src/dedup/raptor/multilevel.ts`)

  ```ts
  /**
   * Given a set of cluster-level hits, expand each one to include its leaf
   * descendants. Deduplicates: if a leaf is already present as a direct hit,
   * it is not duplicated. Returns the merged set (original hits + expanded leaves).
   */
  export function expandLeafDescendants(
    hits: MultilevelHit[],
    tree: RaptorTree,
    maxPerCluster: number,
    embedder: Embedder,
    queryVector: Vector,
  ): MultilevelHit[]
  ```

  Implementation:
  - For each hit where `!hit.isLeaf`:
    - `leaves = leafDescendants(hitNode, tree)` (reuse `retrieval.ts:32–42`)
    - Cap at `maxPerCluster` leaves (sorted by cosine to query)
    - Score each leaf: `rawScore = cosineSimilarity(qv, leaf.embedding)`, `weightedScore = rawScore * levelWeights[0]`
    - Add to result set, skipping any leaf already present (by `nodeId`)
  - Return merged hits

- [ ] **S42A-4: Implement result dedup** (`src/dedup/raptor/multilevel.ts`)

  ```ts
  /**
   * Deduplicate hits: if both a cluster node and its leaf child appear in
   * results, keep the higher-scoring one. If leaf expansion was applied,
   * the leaf set supersedes the cluster summary (more specific wins).
   */
  export function deduplicateMultilevelHits(hits: MultilevelHit[]): MultilevelHit[]
  ```

  Implementation:
  - Build a `parentId → children[]` index from the tree
  - For each cluster hit, check if any of its leaf children are also in the result set
  - If yes, remove the cluster hit (leaves provide more specific context)
  - If no leaves are in the set, keep the cluster hit (it provides the abstract view)

- [ ] **S42A-5: Implement top-level `multilevelRetrieval()`** (`src/dedup/raptor/multilevel.ts`)

  ```ts
  /**
   * Full multi-level retrieval pipeline: score → expand → dedup → MMR → top-K.
   * Drop-in replacement for `stagedExpansion()` in the RAPTOR recall path.
   */
  export function multilevelRetrieval(
    query: string,
    tree: RaptorTree,
    opts: MultilevelRetrieveOptions,
  ): MultilevelHit[]
  ```

  Pipeline:
  1. `scored = scoreTreeLevels(query, tree, opts)`
  2. Top-N candidates (N = `k * 3` for MMR diversity window)
  3. If `leafExpansion`: `expanded = expandLeafDescendants(topN, tree, maxLeafExpansion, embedder, qv)`
  4. `deduped = deduplicateMultilevelHits(expanded ?? topN)`
  5. MMR rerank to `k` using `mmrRerank()` from `src/dedup/mmr.ts`
  6. Return final `MultilevelHit[]`

- [ ] **S42A-6: Unit tests** (`src/dedup/raptor/multilevel.test.ts`)
  - Multi-level retrieval returns results from multiple tree levels (construct a 3-level tree, verify hits from level 0, 1, and root)
  - Level weights shift scoring: with `levelWeights=[0.1, 1.0]`, level-1 nodes outrank equally-scoring leaves
  - Leaf expansion adds children to cluster results (verify a level-1 hit produces its 3 leaf children)
  - Dedup removes cluster hits when leaf children are present
  - Empty tree returns `[]`
  - Single-leaf tree returns that leaf

---

### Sprint S42B: Integration into VectorStore + Config

**Goal:** Wire multi-level retrieval into the live RAPTOR recall path (`VectorStore.raptorSearchHits()`) behind feature flags, and add all configuration to `config/dedup.ts`.

**Acceptance:** With `RAPTOR_MULTILEVEL_ENABLED=true`, `VectorStore.search()` returns multi-level RAPTOR hits merged with flat hits via MMR. With flag OFF, behavior is identical to current production. All 372+ existing tests pass with flag OFF.

**Tasks:**

- [ ] **S42B-1: Add config flags** (`src/config/dedup.ts`)
  Add to `DedupConfigShape` interface (after `RAPTOR_CONSISTENCY` at line ~88):

  ```ts
  RAPTOR_MULTILEVEL_ENABLED: boolean;   // default true
  RAPTOR_LEVEL_WEIGHTS: number[];       // default [1.0, 0.9, 0.8, 0.7, 0.5] (uncalibrated)
  RAPTOR_LEAF_EXPANSION: boolean;       // default true
  RAPTOR_MAX_LEAF_EXPANSION: number;    // default 10 (uncalibrated)
  RAPTOR_FRESHNESS_HOURS: number;       // default 4 (uncalibrated)
  ```

  Add to `loadDedupConfig()` return object:

  ```ts
  RAPTOR_MULTILEVEL_ENABLED: envBool("MEGACOMPACT_RAPTOR_MULTILEVEL", true),
  RAPTOR_LEVEL_WEIGHTS: envNumArray("MEGACOMPACT_RAPTOR_LEVEL_WEIGHTS", [1.0, 0.9, 0.8, 0.7, 0.5]),
  RAPTOR_LEAF_EXPANSION: envBool("MEGACOMPACT_RAPTOR_LEAF_EXPANSION", true),
  RAPTOR_MAX_LEAF_EXPANSION: envNum("MEGACOMPACT_RAPTOR_MAX_LEAF_EXP", 10),
  RAPTOR_FRESHNESS_HOURS: envNum("MEGACOMPACT_RAPTOR_FRESHNESS_HOURS", 4),
  ```

  Add helper `envNumArray(name, def)` for parsing comma-separated numeric env vars.
  NOTE: `RAPTOR_ENRICHMENT_ENABLED` and `RAPTOR_ENRICHMENT_BATCH_SIZE` are DELETED — S42C Ollama enrichment is not part of this sprint. Extractive summaries are permanent.

- [ ] **S42B-2: Replace `raptorSearchHits()` to use multi-level retrieval** (`src/vectorStore.ts`)
  Modify `raptorSearchHits()` (currently at line ~465–510):

  ```ts
  private raptorSearchHits(sid: string, query: string, k: number): SearchHit[] {
    // ... existing shadow mode + freshness + timedOut guards (lines 470–486) ...

    if (this.cfg.RAPTOR_MULTILEVEL_ENABLED) {
      // Multi-level: score all levels, expand, dedup
      const { multilevelRetrieval } = await import("./dedup/raptor/multilevel.js");
      const mlHits = multilevelRetrieval(query, tree, {
        embedder: this.embedder,
        levelWeights: this.cfg.RAPTOR_LEVEL_WEIGHTS,
        leafExpansion: this.cfg.RAPTOR_LEAF_EXPANSION,
        maxLeafExpansion: this.cfg.RAPTOR_MAX_LEAF_EXPANSION,
        k,
        mmrLambda: this.cfg.MMR_LAMBDA,
      });
      if (mlHits.length === 0) return [];
      // Convert MultilevelHit → SearchHit (hydrate from checkpoint list)
      const all = listCheckpoints(sid, this.stateDir).filter(cp => cp.dedupStatus !== "removed");
      const qv = this.embedder.embed(query);
      const hits: SearchHit[] = [];
      for (const mh of mlHits) {
        // For leaf hits, look up the checkpoint directly
        // For cluster hits, use the node's summary + embedding
        const cp = all.find(c => c.checkpointId === mh.nodeId);
        if (cp) {
          hits.push({ checkpoint: cp, score: mh.score });
        } else {
          // Cluster node: synthesize a SearchHit from the RAPTOR node
          // This requires extending SearchHit or using the node as a virtual checkpoint
          // See S42B-3 below
        }
      }
      this.record("RAPTOR", hits.length > 0 ? "new" : "mark_only", `ml_leaves=${mlHits.length}`, Date.now() - t0);
      return hits;
    }

    // ... existing leaf-only stagedExpansion path (lines 488–508) ...
  }
  ```

- [ ] **S42B-3: Extend SearchHit to support RAPTOR cluster nodes** (`src/vectorStore.ts`)
  RAPTOR cluster nodes are not checkpoints — they exist only in `raptor_nodes`. To inject them into the recall block, we need a virtual checkpoint representation:

  ```ts
  // In SearchHit, add optional field:
  export interface SearchHit {
    checkpoint: StoredCheckpoint;
    score: number;
    repoId?: string;
    /** When set, this hit is a RAPTOR cluster node (not a stored checkpoint).
     *  The recall block uses `raptorSummary` instead of checkpoint.summary. */
    raptorSummary?: string;
    raptorLevel?: number;
  }
  ```

  Update `formatRecallBlock()` in `src/recall.ts` (line ~67–82) to check `h.raptorSummary`:

  ```ts
  const label = h.raptorLevel !== undefined
    ? `Recalled cluster summary [${i + 1}] (level ${h.raptorLevel}, relevance ${score}%)`
    : `Recalled context [${i + 1}] (relevance ${score}%)`;
  const text = h.raptorSummary ?? h.checkpoint.summary.trim();
  ```

- [ ] **S42B-4: Unit tests for integration** (`extensions/mega-compact.test.ts` or new file)
  - With `RAPTOR_MULTILEVEL_ENABLED=true`, `VectorStore.search()` returns multi-level RAPTOR hits
  - With flag OFF (default), `VectorStore.search()` returns identical results to current production
  - Cluster-level hits include `raptorSummary` and `raptorLevel` fields
  - MMR diversification merges flat + multi-level RAPTOR hits correctly
  - Shadow mode returns `[]` regardless of flag state
  - Full 372+ test regression passes with flag OFF

---

### Sprint S42C: [DELETED] Incremental Enrichment

> **DELETED in RE-PLAN (2026-07-25).** The prior design proposed upgrading extractive → LLM-generated summaries in background batches via Ollama. This was removed because:
>
> 1. **Extractive summaries are permanent, not a fallback.** A memory system should remember real message text — not LLM paraphrases that may drift from the original meaning.
> 2. **Ollama re-introduces a network dependency** (localhost-LLM call) and requires a `guardrails-allow` annotation for PREVENT-PI-004. The extension is fully in-process; no runtime network calls.
> 3. **The enrichment API surface (`RAPTOR_ENRICHMENT_ENABLED`, `RAPTOR_ENRICHMENT_BATCH_SIZE`) is deleted** from `DedupConfigShape`. Only multi-level retrieval flags (`RAPTOR_MULTILEVEL_ENABLED`, `RAPTOR_LEVEL_WEIGHTS`, `RAPTOR_LEAF_EXPANSION`, `RAPTOR_MAX_LEAF_EXPANSION`, `RAPTOR_FRESHNESS_HOURS`) remain.
>
> If richer summaries are ever needed, the correct approach is a better extractive strategy (e.g., top-N sentences by TF-IDF weight, always deterministic and local) — not an LLM rewrite.

---

### Sprint S42D: Build History + Freshness

**Goal:** Track RAPTOR tree builds in a structured history table with coherence scores and freshness checks, so the system can skip unnecessary rebuilds.

**Acceptance:** `src/dedup/raptor/buildHistory.test.ts` passes; build history records are created on every tree build; freshness check prevents rebuilds when the tree is recent and chunk count is stable.

**Tasks:**

- [ ] **S42D-1: Create `raptor_build_history` table** (`src/store/sqlite.ts`)

  ```sql
  CREATE TABLE IF NOT EXISTS raptor_build_history (
    build_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    state_dir TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    leaf_count INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    config_json TEXT NOT NULL,   -- serialized BuildOptions
    coherence_score REAL,        -- avg intra-cluster cosine (computed post-build)
    timed_out INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_raptor_build_session ON raptor_build_history(session_id);
  ```

  Add helpers: `insertBuildHistory()`, `getLatestBuild()`, `listBuildHistory()`.

- [ ] **S42D-2: Implement coherence score computation** (`src/dedup/raptor/buildHistory.ts`)

  ```ts
  /**
   * Compute the average intra-cluster cosine similarity for a RAPTOR tree.
   * For each internal node, compute the mean pairwise cosine similarity of its
   * children's embeddings. Average across all internal nodes.
   * Returns 0–1 (higher = more coherent clusters).
   */
  export function computeCoherenceScore(tree: RaptorTree): number
  ```

  Implementation:
  - For each non-leaf node in `tree.nodes`:
    - Get child embeddings (leaf children use parent embedding, or look up from tree)
    - Compute mean pairwise cosine similarity
  - Average across all internal nodes

- [ ] **S42D-3: Record build history in `runRaptor()`** (`src/dedup/raptor/index.ts`)
  Modify `runRaptor()` (line ~40–70) to:

  ```ts
  // After saveRaptorTree():
  const coherence = computeCoherenceScore(tree);
  insertBuildHistory({
    buildId: crypto.randomUUID(),
    sessionId: opts.sessionId,
    stateDir: opts.stateDir,
    startedAt: startMs,
    completedAt: Date.now(),
    nodeCount: tree.nodes.size,
    leafCount: leaves.length,
    depth: tree.levels,
    configJson: JSON.stringify({ budgetMs, clustersPerLevel, consistencyThreshold }),
    coherenceScore: coherence,
    timedOut: tree.timedOut,
  });
  ```

- [ ] **S42D-4: Implement freshness check** (`src/dedup/raptor/buildHistory.ts`)

  ```ts
  /**
   * Check if the RAPTOR tree is fresh enough to skip a rebuild.
   * Returns true if:
   *   - The latest build was within `freshnessHours` (default 4)
   *   - The current checkpoint count hasn't changed by more than 20% since the build
   * Returns false if no build history exists or the tree is stale.
   */
  export function isRaptorTreeFresh(
    sessionId: string,
    stateDir: string,
    freshnessHours: number,
    currentCheckpointCount: number,
  ): boolean
  ```

  Implementation:
  1. `latest = getLatestBuild(sessionId, stateDir)` — return false if null
  2. `ageHours = (Date.now() - latest.completedAt) / 3_600_000`
  3. If `ageHours > freshnessHours`: return false
  4. `changeRatio = abs(currentCheckpointCount - latest.leafCount) / max(latest.leafCount, 1)`
  5. Return `changeRatio <= 0.2` (20% threshold)

- [ ] **S42D-5: Gate rebuilds on freshness** (`src/dedup/raptor/index.ts`)
  Modify the RAPTOR build call site (in the extension's compaction hook) to check freshness before building:

  ```ts
  if (cfg.RAPTOR_FRESHNESS_HOURS > 0) {
    const currentCount = listCheckpoints(sessionId, stateDir).length;
    if (isRaptorTreeFresh(sessionId, stateDir, cfg.RAPTOR_FRESHNESS_HOURS, currentCount)) {
      logger?.info("raptor_skip_fresh", { sessionId });
      return;
    }
  }
  ```

- [ ] **S42D-6: Unit tests** (`src/dedup/raptor/buildHistory.test.ts`)
  - Build history records are created with correct metadata
  - Coherence score is 1.0 for identical embeddings, lower for diverse clusters
  - Freshness check returns true for recent builds with stable count
  - Freshness check returns false for stale builds (>4h old)
  - Freshness check returns false when checkpoint count changed by >20%
  - No build history → freshness returns false (forces build)

---

## ACCEPTANCE CRITERIA

1. **Multi-level retrieval** — Given a 3-level RAPTOR tree (leaves + level-1 clusters + root), `multilevelRetrieval()` returns results from at least 2 different levels. Level weights are respected: changing weights alters the result ordering.

2. **Leaf expansion** — When a level-1 cluster node matches a query with high similarity, its leaf descendants appear in the result set. The cluster node itself is deduplicated away if all its children are present.

3. **Integration** — With `RAPTOR_MULTILEVEL_ENABLED=true` (default), `VectorStore.search()` returns multi-level RAPTOR hits merged with flat search results via MMR. With flag explicitly OFF, search results are identical to current production.

4. **Build history** — Every `runRaptor()` call creates a `raptor_build_history` record with correct metadata (node count, leaf count, depth, coherence score, duration).

5. **Freshness** — `isRaptorTreeFresh()` returns true when the tree is <4h old and checkpoint count is stable (±20%). Returns false when stale or when significant new checkpoints were added.

6. **Extractive summaries permanent** — All RAPTOR cluster summaries use extractive summarization only. No Ollama/LLM dependency. Summary text is real message content, not LLM paraphrase. PREVENT-PI-004 compliance with zero network calls and no `guardrails-allow` annotation required.

7. **Regression** — Full 372+ test suite passes. When all new flags are explicitly OFF, behavior is identical to current production. Default configuration (all flags ON) must not break existing tests.

8. **Safety** — `npm run lint` passes. `python3 scripts/regression_check.py --all` passes. `scripts/guardrails-scan.mjs` reports no new violations. No LLM calls, no Ollama, no network — fully in-process.

---

## ROLLBACK

1. **Feature flags** — Set `MEGACOMPACT_RAPTOR_MULTILEVEL=false` to revert to leaf-only retrieval.

2. **Code rollback** — Revert changes to:
   - `src/vectorStore.ts` — `raptorSearchHits()` reverts to `stagedExpansion()` call
   - `src/config/dedup.ts` — remove new RAPTOR config fields
   - `src/dedup/raptor/index.ts` — remove build history calls
   - `src/store/sqlite.ts` — new table (`raptor_build_history`) is additive and unused by old code; no migration rollback needed

3. **Database** — `raptor_build_history` table is additive (new table). Old code ignores it. No data loss on rollback.

---

## RISKS

1. **Level-weight tuning** — Default weights `[1.0, 0.9, 0.8, 0.7, 0.5]` may not be optimal for all session sizes. Short sessions (10–20 leaves) may not benefit from multi-level retrieval. Mitigation: weights are configurable via env; short sessions have shallow trees (1–2 levels) where the weight difference is minimal.

2. **Cluster node injection into recall** — RAPTOR cluster nodes are not checkpoints. Injecting them into the recall block requires extending `SearchHit` and `formatRecallBlock()`. This is a new pattern that could surprise downstream consumers. Mitigation: `raptorSummary` is optional and only set for RAPTOR cluster hits; existing consumers are unaffected.

3. **SQLite migration** — Adding the `raptor_build_history` table is safe on existing databases. Mitigation: `CREATE TABLE IF NOT EXISTS` makes it idempotent; no data migration needed.
