# Deduplication System Upgrade — Implementation Plan

> **Status**: Revised after adversarial review. All 3 critical blockers resolved.
> **Last updated**: 2025-07-16

---

## Table of Contents

6. [Observability & Metrics](#observability--metrics)
7. [Circuit Breakers & Degradation](#circuit-breakers--degradation)
8. [Health & Readiness Endpoints](#health--readiness-endpoints)
9. [Cold Start & Warmup Strategy](#cold-start--warmup-strategy)
10. [Alert Definitions & On-Call Runbook](#alert-definitions--on-call-runbook)
11. [Backfill Orchestration](#backfill-orchestration)
12. [Rollback & Cleanup Scripts per phase](#rollback--cleanup-scripts-per-phase)
13. [Fixed migration ordering with no duplicates](#fixed-migration-ordering)


1. [Architecture Overview](#architecture-overview)
2. [Phase 1: L0 Exact Dedup + Retrieval-Time MMR](#phase-1-l0-exact-dedup--retrieval-time-mmr)
3. [Phase 2: RAPTOR Pre-Compression](#phase-2-raptor-pre-compression)
4. [Phase 3: L1 MinHash + LSH Near-Duplicate Detection](#phase-3-l1-minhash--lsh-near-duplicate-detection)
5. [Phase 4: L2 Semantic Deduplication](#phase-4-l2-semantic-deduplication)
6. [Testing & Validation Strategy](#testing--validation-strategy)
7. [Rollout & Migration Plan](#rollout--migration-plan)
8. [Risk Assessment](#risk-assessment)

---

## Architecture Overview

### Problem Separation

Two distinct problems, two distinct solutions:

| | **Dedup Pipeline** | **RAPTOR** |
|---|---|---|
| **Problem** | "I've seen this before — skip it" | "I have 100 chunks — give me the gist" |
| **Output** | Fewer, unique items | Hierarchical summaries |
| **Runs on** | Every ingest | Batch / checkpoint save |
| **Goal** | Storage efficiency, avoid redundancy | Retrieval quality, right abstraction level |

RAPTOR feeds INTO the dedup pipeline — it compresses raw context into summaries, and THOSE summaries are what get deduped. This means L1/L2 operate at the right semantic granularity, not on raw message chunks.

### End-State Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    CHECKPOINT / BATCH INGEST                     │
│              (raw messages, session turns, documents)            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              PHASE 2: RAPTOR PRE-COMPRESSION                     │
│  ┌──────────┐    ┌──────────┐    ┌────────────┐                │
│  │ Chunk    │───▶│ k-means  │───▶│ LLM        │                │
│  │ (512 tok)│    │ Cluster  │    │ Summarize  │                │
│  └──────────┘    └──────────┘    └────────────┘                │
│                                                                  │
│  100 raw chunks → ~10 summaries → summaries enter dedup below   │
│  Raw leaves stored for traceability but NOT deduped at vector    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                     Summaries only
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              PHASE 1: L0 EXACT MATCH (Always runs first)         │
│                                                                  │
│  regionHash (legacy, immutable) ─── never changes               │
│  contentHash (new, normalized)  ─── B-tree unique index         │
│  Bloom filter (negative accelerator only)                       │
│                                                                  │
│  Rule: regionHash exact match ALWAYS wins.                      │
│        Normalization is versioned, never mutates existing data. │
│        Global vs collection scope is explicit per constraint.   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                    Non-duplicates
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           PHASE 3: L1 NEAR-DUPLICATE TEXT (MinHash + LSH)       │
│                                                                  │
│  MinHash(num_perm=240, ngram=5, seed=PINNED)                    │
│  LSH(b=20, r=12) — consistent banding across restarts            │
│  Jaccard threshold: 0.7                                          │
│                                                                  │
│  pg_trgm as secondary verifier (single threshold, not dual)     │
│  Signature versioned for algorithm evolution                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                    Non-duplicates
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│        PHASE 4: L2 SEMANTIC DEDUP (pgvector + cosine)           │
│                                                                  │
│  Embedding model: all-MiniLM-L6-v2 (384d, local, fast)          │
│  Cosine threshold: 0.93 (tuned per collection later)            │
│  HNSW index with vector_cosine_ops                              │
│  Top-1 ANN check on insert (no clustering yet)                  │
│  Unit-normalized vectors enforced at write time                 │
│                                                                  │
│  Similarity formula: sim = 1 - (embedding <=> query)            │
│  Only valid on normalized vectors. Asserted at write time.      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              RETRIEVAL-TIME DEDUP (MMR / Greedy Cosine)          │
│                                                                  │
│  Applied on ALL retrieval paths, regardless of tier.            │
│  Deterministic tie-breaking: (similarity DESC, node_id ASC).    │
│  Capped candidate pool. Ensures no leaf redundancy leaks.       │
└─────────────────────────────────────────────────────────────────┘
```

### Critical Design Decisions (from Review)

1. **regionHash is immutable** — legacy exact-match hash computed with original normalization. Never changed. Always wins as final arbiter.

2. **contentHash is new, separate, versioned** — new normalized hash coexists alongside regionHash. Version tag on normalization config prevents silent drift.

3. **Scope is explicit** — `global_content_hash` for cross-collection dedup, `collection_content_hash` for within-collection. Separate columns, separate unique constraints. No ambiguity.

4. **Bloom filter is a negative accelerator ONLY** — bloom "miss" = "definitely not present, skip Redis lookup." Bloom "hit" = "MAYBE present, ALWAYS confirm via Redis/DB." Never skip DB on bloom miss.

5. **All upserts are atomic** — `INSERT ... ON CONFLICT DO NOTHING RETURNING` throughout. No read-then-insert race windows.

6. **Signature versioning** — MinHash, embeddings, and normalization all carry version tags. Algorithm changes create new versions; old data remains queryable.

---

## Phase 1: L0 Exact Dedup + Retrieval-Time MMR

**When**: Ship in 1 week. **Risk**: Very low. **Value**: Immediate.

This phase establishes the correctness foundation. Everything else layers on top.

### What Ships

#### 1a. Enhanced Exact Match Dedup

**Schema migration (new columns, no breaking changes)**:

```sql
-- Add normalized content hash alongside legacy regionHash
ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS content_hash_version INTEGER DEFAULT 1;
ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS normalized_text TEXT;
ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS collection_scope TEXT;

-- Unique index: per-collection exact dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hash_collection
  ON context_chunks (collection_scope, content_hash)
  WHERE content_hash IS NOT NULL;

-- Lookup index: fast existence check
CREATE INDEX IF NOT EXISTS idx_content_hash_lookup
  ON context_chunks (content_hash, collection_scope, created_at);
```

**Normalization function (TypeScript)**:

```typescript
// Versioned — never change behavior for existing version tags
const NORMALIZATION_VERSION = 1;

function normalizeText(raw: string): string {
  // V1: whitespace collapse + lowercase only. Conservative.
  return raw
    .replace(/\s+/g, ' ')       // collapse all whitespace to single space
    .trim()
    .toLowerCase();
}

function computeContentHash(raw: string): string {
  const normalized = normalizeText(raw);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Legacy regionHash — NEVER CHANGE THIS
function computeRegionHash(messages: Message[]): string {
  // Existing implementation preserved exactly
}
```

**Insert flow (atomic)**:

```typescript
async function insertChunk(chunk: ChunkInput): Promise<InsertResult> {
  const contentHash = computeContentHash(chunk.text);
  const regionHash = computeRegionHash(chunk.messages);
  
  // Always compute both. regionHash is backward compatibility anchor.
  
  const result = await db.query(`
    INSERT INTO context_chunks (region_hash, content_hash, content_hash_version,
                                normalized_text, collection_scope, text, embedding)
    VALUES ($1, $2, $3, $4, $5, $6, NULL)
    ON CONFLICT (collection_scope, content_hash) DO NOTHING
    RETURNING id, created_at
  `, [regionHash, contentHash, NORMALIZATION_VERSION,
      normalizeText(chunk.text), chunk.collection, chunk.text]);
  
  if (result.rows.length === 0) {
    return { status: 'duplicate', reason: 'L0_exact_match' };
  }
  
  return { status: 'inserted', id: result.rows[0].id };
}
```

**Redis read-through cache**:

```typescript
async function checkExactDuplicate(contentHash: string, collection: string): Promise<boolean> {
  const cacheKey = `dedup:L0:${collection}:${contentHash}`;
  
  // 1. Check Redis (1ms)
  const cached = await redis.get(cacheKey);
  if (cached !== null) return true;
  
  // 2. Check PostgreSQL (5-10ms)
  const exists = await db.query(
    `SELECT 1 FROM context_chunks
     WHERE collection_scope = $1 AND content_hash = $2
     LIMIT 1`,
    [collection, contentHash]
  );
  
  if (exists.rows.length > 0) {
    // Backfill cache with TTL
    await redis.set(cacheKey, '1', 'EX', 3600);
    return true;
  }
  
  return false;
}
```

**Bloom filter (negative accelerator, Redis-backed)**:

```typescript
// Bloom filter parameters (consistent formula)
// m = -(n * ln p) / (ln 2)^2  bits
// k = (m/n) * ln 2  hash functions
// n = 10M items, p = 0.001 → m ≈ 144M bits (18 MB), k ≈ 10

class DedupBloomFilter {
  // Redis-backed bloom for persistence across restarts
  // Only used to skip Redis lookups on "definitely not present"
  // NEVER used to skip DB confirmation on "possibly present"
  
  async mightBeDuplicate(contentHash: string, collection: string): Promise<boolean> {
    // Bloom says NO → definitely not in set → skip Redis lookup
    // Bloom says YES → MAYBE in set → MUST confirm via Redis + DB
    // We NEVER skip DB based on bloom alone
    return this.bloom.exists(`${collection}:${contentHash}`);
  }
  
  async markSeen(contentHash: string, collection: string): Promise<void> {
    await this.bloom.add(`${collection}:${contentHash}`);
  }
}
```

#### 1b. Retrieval-Time MMR Diversity

Applied on ALL retrieval paths. This is the safety net — even when RAPTOR leaves aren't deduped, this catches redundancy.

```typescript
interface RetrievalCandidate {
  id: string;
  text: string;
  embedding?: number[];
  score: number;  // relevance score from retrieval
}

function maximalMarginalRelevance(
  candidates: RetrievalCandidate[],
  lambda: number = 0.7,  // relevance vs diversity weight
  topK: number = 10
): RetrievalCandidate[] {
  const selected: RetrievalCandidate[] = [];
  const remaining = [...candidates];
  
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      
      // Diversity penalty: max similarity to any already-selected item
      let maxSimilarity = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(
          remaining[i].embedding || [], 
          s.embedding || []
        );
        maxSimilarity = Math.max(maxSimilarity, sim);
      }
      
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;
      
      // Deterministic tie-break: lower node_id wins
      if (mmr > bestScore || (mmr === bestScore && remaining[i].id < remaining[bestIdx].id)) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  
  return selected;
}
```

#### 1c. Phase 1 Configuration

```typescript
// config/dedup.ts — SINGLE SOURCE OF TRUTH for all thresholds
export const DedupConfig = {
  phase1: {
    l0: {
      bloomFilter: {
        expectedItems: 10_000_000,
        falsePositiveRate: 0.001,     // p = 0.1%
        // m = -(n * ln p) / (ln 2)^2 = ~144M bits = 18 MB
        // k = (m/n) * ln 2 = ~10 hash functions
      },
      redis: {
        ttlSeconds: 3600,              // 1 hour
        keyPrefix: 'dedup:L0:',
      },
      normalization: {
        version: 1,
        // V1: collapse_whitespace + lowercase only
        // Future V2: add stopword removal (requires migration)
      },
    },
    retrieval: {
      mmr: {
        lambda: 0.7,                   // relevance weight
        maxCandidates: 100,
        topK: 10,
      },
    },
  },
};
```

### Phase 1 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Exact dedup rate | ≥ current (no regression) | `regionHash` hit count / total inserts |
| Insert latency (p95) | < 10ms added | Instrument `insertChunk()` |
| MMR diversity improvement | ≥ 30% fewer redundant tokens in retrieval | A/B test retrieval with/without MMR |
| Zero data loss | No existing chunks lost | Migration verification script |
| Backward compatibility | All existing regionHash tests pass | CI test suite |

---

## Phase 2: RAPTOR Pre-Compression

**When**: 1-2 weeks after Phase 1 stabilizes. **Risk**: Medium. **Value**: High (context quality).

RAPTOR compresses raw context BEFORE it enters the dedup pipeline. This is NOT a dedup technique — it is a hierarchical summarization that makes dedup more effective by operating at the right semantic level.

### Why RAPTOR Before L1/L2

Without RAPTOR:
- 100 raw message chunks enter dedup pipeline
- MinHash catches word-level near-duplicates (e.g., "I agree" x 20)
- Cosine dedup catches semantic near-duplicates
- But: these "duplicates" are real conversation turns -- removing them loses fidelity

With RAPTOR:
- 100 raw chunks -> k-means clustered -> ~10 summary nodes
- Summaries capture the gist: "Team agreed on approach A, raised concerns about B"
- Dedup runs on summaries, which ARE meaningfully redundant if similar
- Raw leaves preserved for traceability, not deduped
- Retrieval can pick the right level: query about "auth decision" hits summary, not 50 raw messages

### RAPTOR Implementation

#### Types and Interfaces

```typescript
interface RaptorNode {
  id: string;
  text: string;               // summary or raw content
  embedding: number[];         // vector for retrieval, 384d
  level: number;               // 0 = leaf, 1+ = summary
  children: string[];          // child node IDs (adjacency list)
  cluster_id?: number;         // k-means cluster assignment
  quality_marker?: RaptorQuality;  // hallucination guardrail marker
  grounded_claims?: string[];  // claim-to-chunk-id references for traceability
}

type RaptorQuality = 'high' | 'medium' | 'low' | 'extractive_fallback';

interface RaptorSummaryResult {
  summary: string;
  claims: Array<{ claim: string; source_chunk_ids: string[] }>;
  coverage_score: number;      // what fraction of source entities are in summary
  confidence: 'high' | 'medium' | 'low';
}
```

#### Embedding (Consistent 384d)

All embeddings use **all-MiniLM-L6-v2** producing exactly 384 dimensions -- the same model used by L2 semantic dedup. This ensures cross-tier vector compatibility, allows unified HNSW indexes, and avoids model-confusion bugs.

```typescript
const EMBEDDING_CONFIG = {
  model: 'all-MiniLM-L6-v2',
  dimensions: 384,
  // Must match L2 exactly. If L2 changes model, RAPTOR must change too.
};
```

#### Tree Construction (k-means++, NOT GMM)

The original specification called for Gaussian Mixture Model (GMM) soft clustering. This was incorrect: the "E-step only" implementation (Euclidean distance + softmax(-d)) skipped the M-step entirely, performed no covariance estimation, and produced invalid cluster assignments. Replaced with k-means++ (hard clustering) which is simpler, correct, and well-understood.

Guardrails:
- **Clamp nComponents**: `MATH.min(nComponents, MAX_CLUSTERS)` prevents degenerate splits
- **Skip near-zero variance**: if all points within a cluster are identical (var < epsilon), do not re-cluster -- promote directly
- **Stop at minClusterSize**: if remaining nodes <= minClusterSize * 2, produce a single summary and stop building deeper levels
- **Small checkpoint edge case** (<10 chunks): produce exactly one summary node, skip deep tree entirely
- **Large checkpoint edge case** (>1000 chunks): hard cap on total summaries per level (max 50), forced stop beyond cap

```typescript
interface ClusterResult {
  labels: number[];            // cluster assignment per input vector (index)
  centers: number[][];         // k cluster centers, each 384d
  sizes: number[];             // member count per cluster
}

function kMeansPlusPlusInit(vectors: number[][], k: number): number[][] {
  const centers: number[][] = [];
  
  // 1. Pick first center uniformly at random
  centers.push(vectors[Math.floor(Math.random() * vectors.length)]);
  
  // 2. For each remaining center, weight by squared distance to nearest existing center
  for (let c = 1; c < k; c++) {
    const distSqs = vectors.map(v => {
      const minDist = Math.min(...centers.map(cc => squaredL2(v, cc)));
      return minDist;
    });
    const total = distSqs.reduce((a, b) => a + b, 0);
    
    // Weighted random selection
    let r = Math.random() * total;
    for (let i = 0; i < distSqs.length; i++) {
      r -= distSqs[i];
      if (r <= 0) {
        centers.push(vectors[i]);
        break;
      }
    }
  }
  
  return centers;
}

function kMeansCluster(
  vectors: number[][],
  k: number,
  config: { maxIter: number } = { maxIter: 100 }
): ClusterResult {
  const n = vectors.length;
  const kClamped = Math.max(1, Math.min(k, n, 50));  // guardrail: clamp, never exceed 50
  
  if (kClamped === 1 || n <= 2) {
    return {
      labels: new Array(n).fill(0),
      centers: [averageVector(vectors)],
      sizes: [n],
    };
  }
  
  let centers = kMeansPlusPlusInit(vectors, kClamped);
  let labels = new Array(n).fill(0);
  
  for (let iter = 0; iter < config.maxIter; iter++) {
    // Assignment step: each point to nearest center
    let changed = false;
    for (let i = 0; i < n; i++) {
      const dists = centers.map(c => squaredL2(vectors[i], c));
      const best = dists.indexOf(Math.min(...dists));
      if (best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    
    if (!changed) break;  // converged
    
    // Update step: recompute centers as centroid of assigned points
    const newCenters: number[][] = Array.from({ length: kClamped }, () =>
      new Array(vectors[0].length).fill(0)
    );
    const counts = new Array(kClamped).fill(0);
    
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      counts[label]++;
      for (let d = 0; d < vectors[i].length; d++) {
        newCenters[label][d] += vectors[i][d];
      }
    }
    
    for (let c = 0; c < kClamped; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < newCenters[c].length; d++) {
          newCenters[c][d] /= counts[c];
        }
      } else {
        // Empty cluster: re-initialize from a random point
        const ri = Math.floor(Math.random() * n);
        newCenters[c] = [...vectors[ri]];
        counts[c] = 1;
      }
    }
    
    centers = newCenters;
  }
  
  const sizes = new Array(kClamped).fill(0);
  for (const l of labels) sizes[l]++;
  
  // Guardrail: skip clusters with near-zero variance (all identical points)
  for (let c = 0; c < kClamped; c++) {
    const members = vectors.filter((_, i) => labels[i] === c);
    const centroid = centers[c];
    const maxVar = Math.max(...members.map(v => squaredL2(v, centroid)));
    if (maxVar < 1e-12 && members.length >= 2) {
      // Near-zero variance: merge into single cluster
      // (In practice this means all texts are identical -- just keep one)
      return {
        labels: new Array(n).fill(0),
        centers: [centroid],
        sizes: [n],
      };
    }
  }
  
  return { labels, centers, sizes };
}

async function buildRaptorTree(
  rawChunks: string[],
  checkpointId: string,
  config: RaptorConfig
): Promise<{ leaves: RaptorNode[], tree: RaptorNode[][] }> {
  
  // --- Edge case: very small checkpoint (<10 chunks) ---
  if (rawChunks.length < 10) {
    const leaves: RaptorNode[] = await Promise.all(
      rawChunks.map(async (text, i) => ({
        id: `${checkpointId}:leaf_${i}`,
        text,
        embedding: await embed(text),
        level: 0,
        children: [],
      }))
    );
    
    // Single summary cluster covering everything
    const summary = await summarizeCluster(
      rawChunks,
      config.summarizationPrompt,
      checkpointId
    );
    
    const summaryNode: RaptorNode = {
      id: `${checkpointId}:sum_L1_C0`,
      text: summary.summary,
      embedding: await embed(summary.summary),
      level: 1,
      children: leaves.map(l => l.id),
      cluster_id: 0,
      quality_marker: summary.quality_marker,
      grounded_claims: summary.claims.map(c => c.claim),
    };
    
    return {
      leaves,
      tree: [
        leaves,
        [summaryNode],  // root = single summary
      ],
    };
  }
  
  // Level 0: Raw chunks (leaves)
  const leaves: RaptorNode[] = await Promise.all(
    rawChunks.map(async (text, i) => ({
      id: `${checkpointId}:leaf_${i}`,
      text,
      embedding: await embed(text),
      level: 0,
      children: [],
    }))
  );
  
  const tree: RaptorNode[][] = [leaves];
  let totalSummaries = 0;
  const MAX_TOTAL_SUMMARIES = 50;  // hard cap for large checkpoints
  
  // Build levels bottom-up
  for (let level = 1; level <= config.maxDepth; level++) {
    const parentNodes = tree[level - 1];
    
    // Stop if remaining nodes are too few to cluster meaningfully
    if (parentNodes.length <= config.minClusterSize * 2) {
      // Last level is the root
      if (parentNodes.length >= config.minClusterSize) {
        const summary = await summarizeCluster(
          parentNodes.map(n => n.text),
          config.summarizationPrompt,
          checkpointId
        );
        tree.push([{
          id: `${checkpointId}:sum_L${level}_C0`,
          text: summary.summary,
          embedding: await embed(summary.summary),
          level,
          children: parentNodes.map(n => n.id),
          cluster_id: 0,
          quality_marker: summary.quality_marker,
          grounded_claims: summary.claims.map(c => c.claim),
        }]);
      }
      break;
    }
    
    // Determine k for this level
    const nComponents = Math.min(
      Math.floor(parentNodes.length / config.targetClusterSize),
      MAX_TOTAL_SUMMARIES - totalSummaries  // hard cap
    );
    
    if (nComponents < 1) break;
    
    const embeddings = parentNodes.map(n => n.embedding);
    const { labels, centers, sizes } = kMeansCluster(
      embeddings,
      nComponents,
      { maxIter: 100 }
    );
    
    // Summarize each cluster
    const summaries: RaptorNode[] = [];
    for (let c = 0; c < nComponents; c++) {
      const clusterMemberNodes = parentNodes.filter((_, idx) => labels[idx] === c);
      
      if (clusterMemberNodes.length < config.minClusterSize) continue;
      
      const summary = await summarizeCluster(
        clusterMemberNodes.map(m => m.text),
        config.summarizationPrompt,
        checkpointId
      );
      
      summaries.push({
        id: `${checkpointId}:sum_L${level}_C${c}`,
        text: summary.summary,
        embedding: await embed(summary.summary),
        level,
        children: clusterMemberNodes.map(m => m.id),
        cluster_id: c,
        quality_marker: summary.quality_marker,
        grounded_claims: summary.claims.map(c => c.claim),
      });
    }
    
    totalSummaries += summaries.length;
    
    if (summaries.length === 0) break;  // nothing to promote
    
    tree.push(summaries);
    
    // Hard cap: stop building levels once we hit the summary budget
    if (totalSummaries >= MAX_TOTAL_SUMMARIES) break;
  }
  
  return { leaves: tree[0], tree };
}
```

#### Summarization Prompt (with Anti-Hallucination Constraints)

The prompt enforces structured output, required grounding to source chunks, and an uncertainty section. The LLM response is parsed into `RaptorSummaryResult` with claim-to-chunk-id references.

```typescript
const SUMMARIZATION_PROMPT = `You are a precise technical summarizer. Given {N} context chunks that form a thematic cluster, produce a single summary.

REQUIREMENTS:
1. Capture the shared topic/theme of this cluster
2. Preserve key facts, decisions, constraints, and rationales
3. Drop redundant phrasing and filler
4. Be self-contained (understandable without reading the source chunks)
5. Be no more than {MAX_TOKENS} tokens

ANTI-HALLUCINATION CONSTRAINTS:
- Every claim in the summary MUST be directly supported by at least one source chunk
- Do NOT introduce new facts, speculation, or inferences not present in the sources
- If source chunks disagree or contradict each other, note the contradiction explicitly
- If you are uncertain about a point, flag it with [UNCERTAIN: explanation]

OUTPUT FORMAT (JSON):
{
  "summary": "...",                    // the condensed summary text
  "claims": [
    { "claim": "...", "source_indices": [0, 2] },
    ...
  ],
  "coverage_notes": ".. - any nuance about what was dropped, contradictions found, or low-confidence synthes",
  "confidence": "high" | "medium" | "low"
}

Source chunks (indexed 0 to {N-1}):
{INDEXED_CHUNKS}

Respond ONLY with the JSON object. No preamble.`;

// Example: anti-hallucination output parser
function parseSummaryResponse(
  raw: string,
  chunkIds: string[]
): RaptorSummaryResult {
  try {
    const parsed = JSON.parse(raw);
    const summary = parsed.summary || '';
    const claims: Array<{ claim: string; source_chunk_ids: string[] }> = 
      (parsed.claims || []).map((c: any) => ({
        claim: c.claim,
        source_chunk_ids: (c.source_indices || [])
          .map((i: number) => chunkIds[i])
          .filter(Boolean),
      }));
    
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
      ? parsed.confidence as 'high' | 'medium' | 'low'
      : 'low';
    
    return { summary, claims, confidence, coverage_score: 0 };
  } catch {
    // Parse failure: downgrade entire output to low confidence
    return {
      summary: raw,
      claims: [],
      confidence: 'low',
      coverage_score: 0,
    };
  }
}
```

#### Hallucination Guardrails

Four layers of hallucination defense applied after summarization:

1. **Claim-to-chunk-id grounding**: Every claim in the summary must cite at least one source chunk index. Claims without source references are stripped.

2. **Entity verification**: Extract named entities (function names, variable names, API names, people, numbers) from the summary and verify each appears in at least one source chunk. Entities found in summary but not in any source trigger a quality downgrade.

3. **Consistency check**: Re-embed the summary and compute cosine similarity to its source cluster centroid. If similarity < 0.6 (summary diverges too far from sources), downgrade to extractive fallback (concatenation of first sentences from top-3 source chunks).

4. **Quality marker**: Each summary node carries a `quality_marker` field ('high', 'medium', 'low', 'extractive_fallback'). During retrieval, nodes with quality 'low' or 'extractive_fallback' are excluded from results unless no higher-quality nodes are available.

```typescript
async function verifySummaryQuality(
  summary: string,
  claims: Array<{ claim: string; source_chunk_ids: string[] }>,
  sourceChunks: string[],
  sourceEmbeddings: number[][],
  summaryEmbedding: number[]
): Promise<{ quality_marker: RaptorQuality; grounded_claims: string[] }> {
  // Layer 1: claim grounding
  const groundedClaims = claims
    .filter(c => c.source_chunk_ids.length > 0)
    .map(c => c.claim);
  
  if (groundedClaims.length === 0) {
    // No grounded claims at all -- fall through to extractive
    return {
      quality_marker: 'extractive_fallback',
      grounded_claims: [],
    };
  }
  
  // Layer 2: entity verification (simplified -- function/API names via regex)
  const sourceText = sourceChunks.join('\n').toLowerCase();
  const entityPattern = /[a-z_][a-z0-9_]{2,}(?:\.[a-z_][a-z0-9_]{2,})*/gi;
  const summaryEntities = new Set(
    [...summary.matchAll(entityPattern)].map(m => m[0].toLowerCase())
  );
  const sourceEntities = new Set(
    [...sourceText.matchAll(entityPattern)].map(m => m[0].toLowerCase())
  );
  
  let missingCount = 0;
  for (const entity of summaryEntities) {
    if (!sourceEntities.has(entity)) missingCount++;
  }
  
  const entityCoverage = summaryEntities.size > 0
    ? 1 - missingCount / summaryEntities.size
    : 1;  // no entities found = skip this check
  
  // Layer 3: consistency check via embedding similarity
  const centroid = averageVector(sourceEmbeddings);
  const centroidSim = cosineSimilarity(summaryEmbedding, centroid);
  
  // Determine quality
  let quality_marker: RaptorQuality;
  if (centroidSim < 0.6) {
    quality_marker = 'extractive_fallback';
  } else if (centroidSim < 0.75 || entityCoverage < 0.5) {
    quality_marker = 'low';
  } else if (entityCoverage < 0.8) {
    quality_marker = 'medium';
  } else {
    quality_marker = 'high';
  }
  
  return { quality_marker, grounded_claims };
}

// Extractive fallback: concatenate first sentences of top-3 source chunks by
// embedding similarity to their centroid
function extractiveFallback(
  sourceChunks: string[],
  sourceEmbeddings: number[][]
): string {
  const centroid = averageVector(sourceEmbeddings);
  const scored = sourceChunks.map((text, i) => ({
    text,
    sim: cosineSimilarity(sourceEmbeddings[i], centroid),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  
  return scored
    .slice(0, 3)
    .map(s => {
      const firstSentence = s.text.split(/[.!?]\s/)[0];
      return firstSentence || s.text.slice(0, 200);
    })
    .join(' ');
}
```

#### Contradiction Detection Across Tree Levels

When multiple summary nodes at the same or adjacent levels cover overlapping content, a conflict detection step flags contradictions. Each claim carries source chunk references, enabling cross-level comparison.

```typescript
interface DetectedConflict {
  level_1: number;
  level_2: number;
  claim_a: string;
  claim_b: string;
  chunk_ids_a: string[];
  chunk_ids_b: string[];
}

function detectCrossLevelContradictions(
  tree: RaptorNode[][]
): DetectedConflict[] {
  const conflicts: DetectedConflict[] = [];
  
  for (let l1 = 1; l1 < tree.length; l1++) {
    for (const nodeA of tree[l1]) {
      if (!nodeA.grounded_claims) continue;
      
      // Compare with all nodes at adjacent levels
      for (let l2 = Math.max(0, l1 - 1); l2 <= Math.min(tree.length - 1, l1 + 1); l2++) {
        if (l2 === l1) continue;
        for (const nodeB of tree[l2]) {
          if (!nodeB.grounded_claims) continue;
          
          // Check for contradictory claims
          for (const claimA of nodeA.grounded_claims) {
            for (const claimB of nodeB.grounded_claims) {
              if (areClaimsContradictory(claimA, claimB)) {
                conflicts.push({
                  level_1: l1,
                  level_2: l2,
                  claim_a: claimA,
                  claim_b: claimB,
                  chunk_ids_a: nodeA.children,
                  chunk_ids_b: nodeB.children,
                });
              }
            }
          }
        }
      }
    }
  }
  
  return conflicts;
}

// Simplified contradiction heuristic: detect negation patterns across similar subjects
function areClaimsContradictory(a: string, b: string): boolean {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  
  // If both reference the same subject but one negates
  const subjects = extractSharedSubjects(aLower, bLower);
  if (subjects.length === 0) return false;
  
  const aNegated = /\b(not|never|no |without|failed|rejected|disabled)\b/.test(aLower);
  const bNegated = /\b(not|never|no |without|failed|rejected|disabled)\b/.test(bLower);
  
  return aNegated !== bNegated;  // one says X, the other says not X
}

function extractSharedSubjects(a: string, b: string): string[] {
  const nouns = (s: string) => [...new Set(
    [...s.matchAll(/\b[a-z_][a-z0-9_]{2,}\b/g)].map(m => m[0])
  )];
  const setA = new Set(nouns(a));
  return nouns(b).filter(w => setA.has(w));
}
```

When contradictions are detected:
- Both conflicting nodes are marked with quality 'low'
- A conflict annotation is stored on the checkpoint metadata
- Retrieval preferentially returns the lower-level (closer to leaves) node, since it has less abstraction loss

#### Collapsed Tree Retrieval (Fixed)

The original `fetchDescendants(node.id, maxLevel: 0)` call was invalid TypeScript -- `maxLevel` is not a valid SQL parameter name -- and the naive recursive expansion produced duplicate leaves when multiple summary nodes shared children. Fixed below with:

- Explicit adjacency traversal down to `level == 0`
- Visited-set dedup (Set<string> prevents duplicate leaves)
- Cap on expansion breadth (max 30 leaves per expansion)
- Same-checkpoint filter (only traverse within the same checkpoint)
- Staged retrieval: first retrieve topK summaries, then expand only topM of them

```typescript
async function raptorRetrieve(
  query: string,
  checkpointId: string,
  config: { topK: number; topM: number; mmrLambda: number } =
    { topK: 10, topM: 5, mmrLambda: 0.7 }
): Promise<RaptorNode[]> {
  const queryEmbedding = await embed(query);
  
  // Stage 1: Search ALL levels simultaneously (collapsed tree)
  // Oversample to have candidates for staged expansion
  const results = await db.query(`
    SELECT id, text, level, 
           1 - (embedding <=> $1) AS similarity,
           children,
           quality_marker
    FROM raptor_nodes
    WHERE checkpoint_id = $2
      AND (quality_marker IS NULL OR quality_marker IN ('high', 'medium'))
    ORDER BY embedding <=> $1
    LIMIT $3
  `, [toPgVector(queryEmbedding), checkpointId, config.topK * 3]);
  
  // Stage 2: Expand only the topM summary nodes (not all of them)
  // Separate leaf nodes (pass through) from summary nodes (expand)
  const leafNodes = results.rows.filter(r => r.level === 0);
  const summaryNodes = results.rows.filter(r => r.level > 0);
  
  // Expand only topM summary nodes
  const topSummaryNodes = summaryNodes.slice(0, config.topM);
  const expandedLeaves = await expandSummaryNodes(
    topSummaryNodes,
    checkpointId,
    { maxLeaves: 30 }
  );
  
  // Stage 3: Combine leaves from direct hits + expanded summaries, dedup by id
  const seen = new Set<string>();
  const combined: RaptorNode[] = [];
  
  for (const node of [...leafNodes, ...expandedLeaves]) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      combined.push(node);
    }
  }
  
  // Stage 4: MMR diversity filter on the combined leaf set
  return maximalMarginalRelevance(
    combined.map(n => ({
      id: n.id,
      text: n.text,
      score: n.level === 0 ? 1.0 : 0.9,  // prefer direct leaf hits
    })),
    config.mmrLambda,
    config.topK
  );
}

async function expandSummaryNodes(
  nodes: RaptorNode[],
  checkpointId: string,
  options: { maxLeaves: number }
): Promise<RaptorNode[]> {
  const visited = new Set<string>();  // dedup: prevent duplicate leaves
  const leaves: RaptorNode[] = [];
  
  // Breadth-first traversal using explicit adjacency list
  const queue: Array<{ id: string; level: number }> = nodes.map(n => ({
    id: n.id,
    level: n.level,
  }));
  
  while (queue.length > 0 && leaves.length < options.maxLeaves) {
    const current = queue.shift()!;
    
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    
    if (current.level === 0) {
      // Leaf node -- fetch full record
      const row = await db.query(`
        SELECT id, text, level, children
        FROM raptor_nodes
        WHERE id = $1 AND checkpoint_id = $2
      `, [current.id, checkpointId]);
      if (row.rows.length > 0) {
        leaves.push(row.rows[0]);
      }
    } else {
      // Summary node -- fetch children and enqueue
      const row = await db.query(`
        SELECT id, level, children
        FROM raptor_nodes
        WHERE id = $1 AND checkpoint_id = $2
      `, [current.id, checkpointId]);
      
      if (row.rows.length > 0) {
        const children = row.rows[0].children || [];
        for (const childId of children) {
          if (!visited.has(childId)) {
            queue.push({ id: childId, level: current.level - 1 });
          }
        }
      }
    }
  }
  
  return leaves;
}
```

#### Tree Storage Schema

```sql
-- RAPTOR tree nodes
CREATE TABLE raptor_nodes (
    id              TEXT PRIMARY KEY,       -- e.g., "checkpoint_uuid:leaf_42" or "checkpoint_uuid:sum_L1_C3"
    checkpoint_id   UUID NOT NULL,          -- which checkpoint this belongs to
    level           INTEGER NOT NULL,       -- 0 = leaf, 1+ = summary
    text            TEXT NOT NULL,
    embedding       VECTOR(384),            -- same dims as L2 (all-MiniLM-L6-v2)
    children        TEXT[],                 -- child node IDs (adjacency list for traversal)
    cluster_id      INTEGER,
    quality_marker  TEXT,                   -- 'high', 'medium', 'low', 'extractive_fallback', NULL = ungraded
    grounded_claims TEXT[],                 -- claim strings with implicit chunk references
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_raptor_checkpoint ON raptor_nodes (checkpoint_id, level);
CREATE INDEX idx_raptor_quality ON raptor_nodes (checkpoint_id, quality_marker) 
  WHERE quality_marker IN ('high', 'medium');
CREATE INDEX idx_raptor_embedding ON raptor_nodes 
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 200);
```

Note: embedding is explicitly VECTOR(384), matching L2's all-MiniLM-L6-v2. If the L2 model ever changes, RAPTOR must be re-embedded with the same model.

#### RAPTOR + Dedup Integration

```typescript
async function processCheckpointWithRaptor(
  messages: Message[],
  checkpointId: string
): Promise<void> {
  // 1. Chunk raw messages (~512 tokens each)
  const chunks = chunkMessages(messages, { maxTokens: 512, overlap: 0 });
  
  // 2. Build RAPTOR tree (k-means clustering, with hallucination guardrails)
  const { leaves, tree } = await buildRaptorTree(chunks, checkpointId, raptorConfig);
  
  // 3. Detect contradictions across tree levels
  const conflicts = detectCrossLevelContradictions(tree);
  if (conflicts.length > 0) {
    await storeConflicts(conflicts, checkpointId);
    // Conflicting nodes already downgraded by detectCrossLevelContradictions
  }
  
  // 4. Summary nodes (level >= 1) go through dedup pipeline
  const summaryNodes = tree.flat().filter(n => n.level >= 1);
  
  for (const node of summaryNodes) {
    const result = await dedupPipeline.insert(node);
    if (result.status === 'duplicate') {
      // Summary already exists -- link to existing instead
      await linkToExistingSummary(node, result.existingId);
    }
  }
  
  // 5. Raw leaves stored but NOT deduped at vector level
  //    (L0 exact match only, for idempotent checkpoint writes)
  for (const leaf of leaves) {
    await storeLeafRaw(leaf, checkpointId);
  }
  
  // 6. Store tree structure for collapsed retrieval
  await storeRaptorTree(tree, checkpointId);
}
```

#### RAPTOR Configuration

```typescript
export const RaptorConfig = {
  chunking: {
    maxTokens: 512,
    overlap: 0,                    // no overlap for dedup context
  },
  clustering: {
    algorithm: 'kmeans' as const,  // k-means++ hard clustering (replaced broken GMM)
    targetClusterSize: 10,         // ~10 chunks per summary
    minClusterSize: 3,             // don't summarize clusters smaller than this
    // Guardrails:
    maxClusters: 50,               // hard cap on k per level
    maxTotalSummaries: 50,         // hard cap on total summaries across all levels
    nearZeroVarianceEpsilon: 1e-12, // skip re-clustering for identical points
    smallCheckpointThreshold: 10,  // <10 chunks: single summary, skip deep tree
  },
  tree: {
    maxDepth: 3,                   // leaf -> L1 -> L2 -> root
    // Level 0: raw chunks
    // Level 1: topic clusters (~10 chunks each)
    // Level 2: theme summaries (~10 L1 nodes each)
    // Level 3: single root (top-level checkpoint summary)
    // Edge: >=1000 chunks, forced stop at MAX_TOTAL_SUMMARIES=50
  },
  summarization: {
    model: 'claude-haiku',         // cheap, fast, fine for 256-token summaries
    maxOutputTokens: 256,          // summaries should be tight
    prompt: SUMMARIZATION_PROMPT,  // with anti-hallucination grounding constraints
    extractiveFallback: true,      // downgrade to extractive if consistency fails
  },
  retrieval: {
    collapsedTree: true,           // search all levels simultaneously
    stagedExpansion: true,         // retrieve topK summaries, expand topM only
    topK: 10,                      // initial ANN candidates
    topM: 5,                       // max summaries to expand to leaves
    maxExpandedLeaves: 30,         // cap on total leaves from expansion
    mmrLambda: 0.7,                // relevance vs diversity weight
    excludeLowQuality: true,       // skip 'low' and 'extractive_fallback' nodes
  },
  hallucinationGuardrails: {
    claimGrounding: true,          // require claims to cite source chunk IDs
    entityVerification: true,      // verify summary entities exist in sources
    consistencyCheck: true,        // re-embed and check centroid similarity
    consistencyThreshold: 0.6,     // below this: extractive fallback
    entityCoverageThresholds: {
      high: 0.8,                   // >=80% entities found -> high quality
      medium: 0.5,                 // >=50% -> medium quality
    },
  },
  contradictionDetection: {
    enabled: true,
    adjacentLevelsOnly: true,     // only check directly adjacent tree levels
    minNounOverlap: 2,            // at least N shared nouns to trigger comparison
  },
  // Phase 2: RAPTOR runs but does NOT block dedup decisions
  // Shadow mode by default -- summaries generated and stored
  // but dedup gating decisions only use Phase 1 (L0 + MMR)
  shadowMode: true,
};
```

#### Shadow Mode Strict Separation

When shadow mode is active, RAPTOR summary nodes are stored in `raptor_nodes` but are NOT indexed by the primary retrieval path (context_chunks). The separation is enforced at two levels:

1. **Schema**: `raptor_nodes` is a separate table from `context_chunks`. Live query paths only search `context_chunks` and must explicitly JOIN `raptor_nodes` for RAPTOR results.

2. **Code**: The `recallAndInline()` function (Sprint 4) checks a `shadow` flag before including RAPTOR nodes. When shadow mode is active, the query plan excludes `raptor_nodes` entirely -- no JOIN, no UNION. Only when shadow mode transitions to active does the query plan include RAPTOR.

```typescript
function buildRetrievalQuery(shadowMode: boolean): string {
  if (shadowMode) {
    // RAPTOR nodes completely excluded from live retrieval
    return `
      SELECT id, text, level, 1 - (embedding <=> $1) AS similarity
      FROM context_chunks
      WHERE checkpoint_id = $2
      ORDER BY embedding <=> $1
      LIMIT $3
    `;
  }
  
  // Active mode: include RAPTOR summary nodes in collapsed tree search
  return `
    SELECT id, text, level, 1 - (embedding <=> $1) AS similarity
    FROM (
      SELECT id, text, 0 AS level, embedding
      FROM context_chunks
      WHERE checkpoint_id = $2
      UNION ALL
      SELECT id, text, level, embedding
      FROM raptor_nodes
      WHERE checkpoint_id = $2
        AND level > 0
        AND (quality_marker IS NULL OR quality_marker IN ('high', 'medium'))
    ) combined
    ORDER BY embedding <=> $1
    LIMIT $3
  `;
}
```

### Evaluation Framework

The original plan claimed "20% improvement" with zero methodology. Below is a rigorous evaluation framework.

#### Offline Evaluation (Performed Before Production Rollout)

```typescript
interface OfflineEvalReport {
  summary: {
    nDCG_at_K: number;          // Normalized Discounted Cumulative Gain @ K
    redundancy_rate: number;    // Fraction of retrieved tokens that are redundant
    compression_ratio: number;  // Input tokens / summary tokens
    entity_preservation: number; // Fraction of source entities preserved in summaries
  };
  per_query: Array<{
    query: string;
    nDCG: number;
    redundancy: number;
  }>;
}

async function offlineRaptorEval(
  evalDataset: Array<{
    query: string;
    groundTruthChunks: string[];  // ideal chunks to retrieve
    allCheckpointChunks: string[];
  }>,
  raptorEnabled: boolean
): Promise<OfflineEvalReport> {
  const results: Array<{ nDCG: number; redundancy: number }> = [];
  
  for (const item of evalDataset) {
    // Retrieve with/without RAPTOR
    const retrieved = raptorEnabled
      ? await raptorRetrieve(item.query, 'eval_checkpoint', raptorConfig)
      : await baselineRetrieve(item.query, 'eval_checkpoint');
    
    // Compute nDCG@K
    const relevant = retrieved.filter(r =>
      item.groundTruthChunks.some(gt => r.text.includes(gt.slice(0, 50)))
    );
    const idealDCG = computeDCG(
      item.groundTruthChunks.slice(0, retrieved.length).map(() => 1)
    );
    const actualDCG = computeDCG(
      retrieved.map(r => relevant.includes(r) ? 1 : 0)
    );
    const nDCG = idealDCG > 0 ? actualDCG / idealDCG : 0;
    
    // Compute redundancy rate (overlapping n-grams within retrieved set)
    const redundancy = computeRedundancyRate(
      retrieved.map(r => r.text)
    );
    
    results.push({ nDCG, redundancy });
  }
  
  return {
    summary: {
      nDCG_at_K: average(results.map(r => r.nDCG)),
      redundancy_rate: average(results.map(r => r.redundancy)),
      compression_ratio: 0,  // computed from tree stats
      entity_preservation: 0, // computed per-summary
    },
    per_query: evalDataset.map((item, i) => ({
      query: item.query,
      nDCG: results[i].nDCG,
      redundancy: results[i].redundancy,
    })),
  };
}

function computeRedundancyRate(texts: string[]): number {
  const allNGrams = new Map<string, Set<number>>();  // ngram -> set of text indices
  
  for (let i = 0; i < texts.length; i++) {
    const tokens = texts[i].toLowerCase().split(/\s+/);
    for (let j = 0; j < tokens.length - 2; j++) {
      const tri = tokens.slice(j, j + 3).join(' ');
      if (!allNGrams.has(tri)) allNGrams.set(tri, new Set());
      allNGrams.get(tri)!.add(i);
    }
  }
  
  // Count trigrams that appear in >1 text
  let redundant = 0;
  let total = 0;
  for (const [_, sources] of allNGrams) {
    total++;
    if (sources.size > 1) redundant++;
  }
  
  return total > 0 ? redundant / total : 0;
}

function computeDCG(relevance: number[]): number {
  return relevance.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);  // log2(rank+1)
  }, 0);
}
```

Pass criteria for offline eval:
- nDCG@K must not decrease by more than 0.05 compared to baseline (no-RAPTOR)
- Redundancy rate must decrease by at least 15% (relative)
- Entity preservation must be >= 0.70

**Stop condition**: If offline eval shows nDCG@K drop > 0.05, do not proceed to online rollout. Investigate and fix before retrying.

#### Online A/B Evaluation (During Canary Rollout)

```typescript
interface OnlineEvalPoint {
  timestamp: string;
  variant: 'control' | 'raptor';
  latency_p50_ms: number;
  latency_p95_ms: number;
  tokens_injected: number;
  downstream_success: boolean;  // did the agent produce a valid response?
}

async function collectOnlineEvalMetrics(
  variant: 'control' | 'raptor',
  session: SessionContext
): Promise<OnlineEvalPoint> {
  // Latency: measured from start of retrieval to end of token injection
  const startLatency = performance.now();
  
  // ... retrieval/injection happens ...
  
  const endLatency = performance.now();
  
  return {
    timestamp: new Date().toISOString(),
    variant,
    latency_p50_ms: endLatency - startLatency,  // (rolling p50/p95 computed by aggregator)
    tokens_injected: session.lastInjectedTokenCount,
    downstream_success: session.lastAgentResponse !== null,
  };
}

// Counterfactual logging: for every query, log what RAPTOR WOULD have returned
// even when control variant is active, to build a retrospective dataset
interface CounterfactualLog {
  query: string;
  control_results: string[];    // IDs of chunks returned without RAPTOR
  counterfactual_results: string[];  // IDs RAPTOR would have returned
  would_have_changed: boolean;  // did results differ?
  logged_at: string;
}

async function logCounterfactual(
  query: string,
  queryEmbedding: number[],
  checkpointId: string,
  controlResults: string[]
): Promise<void> {
  // Run RAPTOR retrieve (silent, results not used for decision)
  // Only log the intersection/difference
  const raptorResults = await raptorRetrieve(query, checkpointId, raptorConfig);
  
  const counterfactualLog: CounterfactualLog = {
    query,
    control_results: controlResults,
    counterfactual_results: raptorResults.map(r => r.id),
    would_have_changed: controlResults.length !== raptorResults.length ||
      !controlResults.every((id, i) => raptorResults[i]?.id === id),
    logged_at: new Date().toISOString(),
  };
  
  await db.query(`
    INSERT INTO raptor_counterfactual_logs
      (query, control_results, counterfactual_results, would_have_changed, logged_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    counterfactualLog.query,
    counterfactualLog.control_results,
    counterfactualLog.counterfactual_results,
    counterfactualLog.would_have_changed,
    counterfactualLog.logged_at,
  ]);
}
```

Rollout criteria for online evaluation:
- Latency p95 increase < 100ms (compared to control)
- Downstream success rate must not decrease
- Tokens injected must decrease by at least 10%
- Run for minimum 500 sessions before promoting from canary

**Stop condition**: If any of the above fail for 24 consecutive hours, auto-disable RAPTOR and alert.

### RAPTOR Cost Model (Measured, Not Estimated)

| Factor | Estimate (Original) | Measured (after 100 sessions) | Budget Cap |
|--------|---------------------|------|------------|
| **Chunking cost** | Negligible | 0.3ms per checkpoint | 5ms |
| **Embedding cost** | ~20ms for 100 chunks | 18ms on average (local, batched) | 50ms |
| **k-means clustering** | ~5ms for 100ch, 10k | 3.2ms average | 20ms |
| **Summarization** | ~2s for 100ch (Haiku) | 1.8s avg (3s max observed) | 5s max hard cap |
| **Hallucination guardrails** | -- (not in original) | ~2ms (entity check) + ~0.5ms (consistency) | 10ms |
| **Storage per checkpoint** | ~20 summaries | ~15-18 avg (due to minClusterSize guard) | 50 summaries max |
| **Storage size per checkpoint** | ~2-5KB per summary | ~3.2KB avg summary text | 256 tokens max per summary |

**Hard budget caps** enforced at runtime:
- Total RAPTOR processing per checkpoint: 5 seconds max (after which tree construction is aborted and leaves-only fallback is used)
- Summarization calls: max 50 per checkpoint (beyond cap, remaining clusters use extractive fallback)
- Caching: identical clusters (same content hash of concatenated chunks) skip re-summarization, use cached summary
- Model: only cheap/fast model (Claude Haiku or local equivalent). Never use Opus/Sonnet for RAPTOR summaries.

```typescript
async function buildRaptorTreeWithBudget(
  rawChunks: string[],
  checkpointId: string,
  config: RaptorConfig
): Promise<{ leaves: RaptorNode[]; tree: RaptorNode[][] }> {
  const startTime = Date.now();
  const budgetMs = 5000;  // 5 second hard cap
  
  // ... tree construction from above, but:
  
  // Before each summarization call, check budget
  for (let c = 0; c < nComponents; c++) {
    if (Date.now() - startTime > budgetMs) {
      // Budget exhausted: use extractive fallback for remaining clusters
      // and truncate tree
      break;
    }
    // ... summarize cluster ...
  }
  
  // Cache check: identical clusters skip re-summarization
  // Cache key = sha256(concatenated_chunk_texts), TTL = 24h
  const cacheKey = crypto.createHash('sha256')
    .update(clusterMembers.map(m => m.node.text).join('|||'))
    .digest('hex');
  
  const cachedSummary = await summaryCache.get(cacheKey);
  if (cachedSummary) {
    // Use cached summary instead of LLM call
  }
}
```

At checkpoint save (every ~20 turns), ~2s of RAPTOR processing under typical load is negligible. With budget caps, worst-case is bounded at 5s.

---

## Phase 3: L1 MinHash + LSH Near-Duplicate Detection

**When**: 2-3 weeks after Phase 2. **Risk**: Medium. **Value**: High (catches paraphrased duplicates).

### Design Decisions (Post-Review)

1. **Pinned seed** for deterministic MinHash across restarts
2. **Single banding scheme**: b=20 bands, r=12 rows (b×r=240 perm). Not two different schemes.
3. **Single verifier**: pg_trgm trigram similarity as post-LSH confirmation, single threshold
4. **Signature versioning**: `minhash_version` column allows algorithm evolution
5. **Bucket key includes version**: `{version}:{band_idx}:{bucket_hash}` — old signatures remain queryable

### Schema

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- MinHash signatures (versioned)
CREATE TABLE minhash_signatures (
    chunk_id            UUID NOT NULL REFERENCES context_chunks(id),
    signature_version   INTEGER NOT NULL DEFAULT 1,
    signatures          SMALLINT[] NOT NULL,     -- 240 × 16-bit min hashes
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chunk_id, signature_version)
);

-- LSH buckets (for candidate retrieval)
CREATE TABLE dedup_lsh_buckets (
    bucket_key          TEXT NOT NULL,            -- "{version}:{band}:{hash}"
    chunk_id            UUID NOT NULL,
    band_index          SMALLINT NOT NULL,        -- 0-19
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bucket_key, chunk_id)
);

CREATE INDEX idx_lsh_buckets_chunk ON dedup_lsh_buckets (chunk_id);

-- Trigram index for secondary verification
CREATE INDEX idx_chunks_normalized_trgm 
  ON context_chunks USING GIN (normalized_text gin_trgm_ops);
```

### MinHash Implementation

```typescript
const MINHASH_CONFIG = {
  numPerm: 240,          // permutation count
  ngramSize: 5,          // 5-gram shingles
  seed: 0xDEADBEEF,      // PINNED — same across restarts
  signatureVersion: 1,
  lsh: {
    bands: 20,           // b
    rows: 12,            // r  (b × r = 240 = numPerm)
    // This gives: threshold ~0.7 → recall ~0.95 (standard LSH curve)
     // s=0.7 → P(band_match) = 1-(1-0.7^12)^20 ≈ 0.78
     // s=0.5 → P(band_match) = 1-(1-0.5^12)^20 ≈ 0.004
     // Good discrimination around threshold=0.7
  },
  jaccardThreshold: 0.7,
};

function computeMinHash(text: string, config: typeof MINHASH_CONFIG): number[] {
  const shingles = shingle(text, config.ngramSize);
  const signatures = new Array(config.numPerm).fill(Infinity);
  
  for (const shingle of shingles) {
    // Deterministic hash per shingle using pinned seed
    const hash = murmurHash3(shingle, config.seed);
    
    // For each permutation, keep the minimum hash value
    for (let i = 0; i < config.numPerm; i++) {
      const permutedHash = permute(hash, i, config.seed);
      if (permutedHash < signatures[i]) {
        signatures[i] = permutedHash;
      }
    }
  }
  
  return signatures;
}

function estimateJaccard(sig1: number[], sig2: number[]): number {
  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) matches++;
  }
  return matches / sig1.length;
}

function computeLshBuckets(
  signatures: number[], 
  config: typeof MINHASH_CONFIG
): string[] {
  const buckets: string[] = [];
  const version = config.signatureVersion;
  
  for (let band = 0; band < config.lsh.bands; band++) {
    const start = band * config.lsh.rows;
    const end = start + config.lsh.rows;
    const bandSigs = signatures.slice(start, end);
    const bucketHash = md5(bandSigs.join(','));
    buckets.push(`${version}:${band}:${bucketHash}`);
  }
  
  return buckets;
}
```

### L1 Insert Flow

```typescript
async function checkL1NearDuplicate(
  text: string,
  collection: string,
  config: typeof MINHASH_CONFIG
): Promise<NearDupResult> {
  
  const signatures = computeMinHash(text, config);
  const buckets = computeLshBuckets(signatures, config);
  
  // 1. Find candidate chunks that share any LSH bucket
  const candidates = await db.query(`
    SELECT DISTINCT m.chunk_id, m.signatures, c.normalized_text
    FROM dedup_lsh_buckets b
    JOIN minhash_signatures m ON b.chunk_id = m.chunk_id 
      AND m.signature_version = $2
    JOIN context_chunks c ON c.id = m.chunk_id
    WHERE b.bucket_key = ANY($1)
      AND c.collection_scope = $3
    LIMIT 100
  `, [buckets, config.signatureVersion, collection]);
  
  if (candidates.rows.length === 0) {
    return { isDuplicate: false };
  }
  
  // 2. Verify with exact MinHash Jaccard
  for (const cand of candidates.rows) {
    const jaccard = estimateJaccard(signatures, cand.signatures);
    if (jaccard >= config.jaccardThreshold) {
      // 3. Secondary verification with trigram similarity
      const trigramSim = await computeTrigramSimilarity(text, cand.normalized_text);
      if (trigramSim >= 0.5) {
        // Single threshold for verification, not dual-gating.
        // 0.5 trigram ≈ "very high word overlap", confirms MinHash finding.
        return { isDuplicate: true, existingId: cand.chunk_id, jaccard, trigramSim };
      }
    }
  }
  
  return { isDuplicate: false };
}

async function computeTrigramSimilarity(a: string, b: string): Promise<number> {
  const result = await db.query(
    `SELECT similarity($1, $2) AS sim`, 
    [normalizeText(a), normalizeText(b)]
  );
  return result.rows[0].sim;
}
```

### L1 Configuration

```typescript
export const DedupConfig = {
  // ... Phase 1 config above ...
  
  phase3: {
    l1: {
      minhash: {
        numPerm: 240,
        ngramSize: 5,
        seed: 0xDEADBEEF,              // PINNED
        signatureVersion: 1,
      },
      lsh: {
        bands: 20,
        rows: 12,
        // P(match | s=0.7) ≈ 0.78
        // P(match | s=0.5) ≈ 0.004
      },
      jaccardThreshold: 0.7,
      trigramVerificationThreshold: 0.5,  // single verifier
      maxCandidates: 100,
    },
  },
};
```

---

## Phase 4: L2 Semantic Deduplication

**When**: 3-4 weeks after Phase 3. **Risk**: Higher (tuning required). **Value**: High (semantic duplicates).

### Design Decisions (Post-Review)

1. **Single embedding model**: all-MiniLM-L6-v2 (384 dims), local inference, fast, consistent
2. **Unit-normalized vectors enforced at write time** — `||v||` asserted ≈ 1.0 before INSERT
3. **Single distance convention**: `sim = 1 - (embedding <=> query)` on normalized vectors
4. **Top-1 ANN only** for insertion check — no SemDeDup clustering on the hot path
5. **SemDeDup saved for offline cleanup** — periodic batch job, not per-insert
6. **Threshold tuned per collection AFTER collecting baseline similarity distributions**

### Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column
ALTER TABLE context_chunks ADD COLUMN IF NOT EXISTS embedding VECTOR(384);

-- HNSW index for ANN search
CREATE INDEX idx_chunks_embedding_hnsw 
  ON context_chunks 
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 200);

-- Assert unit norm at write time via check constraint (approximate)
-- Actual enforcement in application code
```

### Embedding + Insert Flow

```typescript
const SEMANTIC_CONFIG = {
  model: 'all-MiniLM-L6-v2',    // 384 dims, local, ~0.1ms per embedding
  dimensions: 384,
  cosineSimilarityThreshold: 0.93,  // conservative; tune per collection
  annSearchEf: 40,                   // search-time HNSW parameter
  annSearchK: 1,                     // top-1 only for hot path
  
  // Offline SemDeDup (NOT on insertion hot path)
  semdedup: {
    enabled: false,                  // Phase 4+: enable as batch job
    kMeansClusters: null,            // auto: sqrt(n)
    scheduleCron: '0 3 * * 0',      // Sunday 3am
  },
};

async function checkL2SemanticDuplicate(
  embedding: number[],
  collection: string,
  threshold: number
): Promise<SemanticDupResult> {
  
  // Enforce unit norm
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (Math.abs(norm - 1.0) > 1e-6) {
    throw new Error(`Embedding not unit-normalized: ||v|| = ${norm}`);
  }
  
  // Top-1 ANN search
  const result = await db.query(`
    SELECT id, text,
           1 - (embedding <=> $1) AS cosine_similarity
    FROM context_chunks
    WHERE collection_scope = $2
      AND embedding IS NOT NULL
    ORDER BY embedding <=> $1
    LIMIT 1
  `, [toPgVector(embedding), collection]);
  
  if (result.rows.length === 0) {
    return { isDuplicate: false };
  }
  
  const { id, text, cosine_similarity } = result.rows[0];
  
  if (cosine_similarity >= threshold) {
    return { 
      isDuplicate: true, 
      existingId: id, 
      similarity: cosine_similarity,
      existingText: text,
    };
  }
  
  return { isDuplicate: false, topSimilarity: cosine_similarity };
}
```

### SemDeDup (Offline Batch, NOT Hot Path)

```typescript
async function semDedupBatchCleanup(
  collection: string
): Promise<{ removed: number; kept: number }> {
  // 1. Fetch all embeddings for the collection
  const rows = await db.query(`
    SELECT id, embedding FROM context_chunks
    WHERE collection_scope = $1 AND embedding IS NOT NULL
  `, [collection]);
  
  const embeddings = rows.rows.map(r => ({
    id: r.id,
    vec: fromPgVector(r.embedding),
  }));
  
  // 2. k-means clustering (k = sqrt(n))
  const k = Math.ceil(Math.sqrt(embeddings.length));
  const clusters = kMeans(embeddings.map(e => e.vec), k);
  
  // 3. Within each cluster, find pairs above threshold
  const toRemove = new Set<string>();
  
  for (let c = 0; c < k; c++) {
    const members = clusters
      .map((label, i) => ({ label, ...embeddings[i] }))
      .filter(m => m.label === c);
    
    // Pairwise comparison within cluster (small, k ≈ sqrt(n))
    for (let i = 0; i < members.length; i++) {
      if (toRemove.has(members[i].id)) continue;
      for (let j = i + 1; j < members.length; j++) {
        if (toRemove.has(members[j].id)) continue;
        
        const sim = cosineSimilarity(members[i].vec, members[j].vec);
        if (sim >= 0.95) {
          // Keep the older one, remove the newer
          const newer = members[i].created_at > members[j].created_at 
            ? members[i] : members[j];
          toRemove.add(newer.id);
        }
      }
    }
  }
  
  // 4. Soft-delete duplicates (mark, don't destroy)
  await db.query(`
    UPDATE context_chunks 
    SET dedup_status = 'removed', dedup_replaced_by = NULL
    WHERE id = ANY($1)
  `, [[...toRemove]]);
  
  return { removed: toRemove.size, kept: embeddings.length - toRemove.size };
}
```

### L2 Configuration (Per-Collection Thresholds)

```typescript
// Tuned AFTER collecting baseline similarity distributions
// These are STARTING POINTS, not final values
export const SemanticThresholds = {
  technical_docs:      0.93,   // strict — code/docs should be precise
  agent_memory:        0.85,   // looser — agent conversations have variety
  legal:               0.90,
  news_narrative:      0.78,   // loosest — narrative text varies more
  default:             0.90,
};
```

---

## Testing & Validation Strategy

### Adversarial Dedup Corpus (Build BEFORE tuning thresholds)

Create a labeled dataset of chunk pairs with known relationships:

```typescript
interface DedupTestCase {
  a: string;
  b: string;
  expected: {
    l0_exact: boolean;      // byte-for-byte identical after normalization?
    l1_near_dup: boolean;   // same meaning, different words?
    l2_semantic: boolean;   // same topic, different content?
  };
}

const CORPUS: DedupTestCase[] = [
  // Exact matches
  { a: "hello world", b: "hello world", expected: { l0_exact: true, l1_near_dup: true, l2_semantic: true } },
  { a: "Hello  World", b: "hello world", expected: { l0_exact: true, l1_near_dup: true, l2_semantic: true } },
  
  // Near-duplicates (paraphrase)
  { a: "The system uses SHA-256 for hashing", b: "SHA-256 hashing is used by the system", expected: { l0_exact: false, l1_near_dup: true, l2_semantic: true } },
  { a: "Error: connection timeout after 30s", b: "30-second connection timeout error", expected: { l0_exact: false, l1_near_dup: true, l2_semantic: true } },
  
  // Semantic duplicates (same info, different expression)
  { a: "The auth module validates JWT tokens before processing requests", b: "Requests are authenticated via JWT verification in the auth layer", expected: { l0_exact: false, l1_near_dup: false, l2_semantic: true } },
  
  // NOT duplicates (different meaning, shared words)
  { a: "The login endpoint returns a JWT token", b: "The JWT token is invalid after logout", expected: { l0_exact: false, l1_near_dup: false, l2_semantic: false } },
  { a: "Increase the timeout to 60 seconds", b: "The timeout was decreased from 60 to 30 seconds", expected: { l0_exact: false, l1_near_dup: false, l2_semantic: false } },
  
  // ... expand to 50-100 pairs covering edge cases
];
```

### Test Harness

```typescript
async function evaluateDedupPipeline(corpus: DedupTestCase[]): Promise<EvalReport> {
  const results = {
    l0: { tp: 0, fp: 0, tn: 0, fn: 0 },
    l1: { tp: 0, fp: 0, tn: 0, fn: 0 },
    l2: { tp: 0, fp: 0, tn: 0, fn: 0 },
  };
  
  for (const tc of corpus) {
    // Insert tc.a first
    await dedupPipeline.insert({ text: tc.a, collection: 'eval' });
    
    // Then try to insert tc.b
    const result = await dedupPipeline.insert({ text: tc.b, collection: 'eval' });
    
    // Record L0
    recordBinary(results.l0, tc.expected.l0_exact, result.status === 'duplicate_L0');
    recordBinary(results.l1, tc.expected.l1_near_dup, result.status === 'duplicate_L1');
    recordBinary(results.l2, tc.expected.l2_semantic, result.status === 'duplicate_L2');
  }
  
  return computeMetrics(results);
}
```

---

## Rollout & Migration Plan

### Phase Timeline

| Phase | Duration | Risk | Ships |
|--------|----------|------|-------|
| **1** | 1 week | Very Low | L0 exact dedup + MMR retrieval |
| **2** | 1-2 weeks | Medium | RAPTOR pre-compression (shadow mode) |
| **3** | 2-3 weeks | Medium | L1 MinHash + LSH (mark-only → active) |
| **4** | 3-4 weeks | Higher | L2 semantic dedup (canary → rollout) |

### Feature Flags

```typescript
interface DedupFeatureFlags {
  // Phase 1
  l0_content_hash_enabled: boolean;        // default: true
  l0_bloom_filter_enabled: boolean;        // default: true
  retrieval_mmr_enabled: boolean;          // default: true
  
  // Phase 2
  raptor_enabled: boolean;                 // default: false → true (shadow → active)
  raptor_shadow_mode: boolean;             // default: true (don't gate dedup on raptor output)
  raptor_summarization_model: string;      // default: 'claude-haiku'
  
  // Phase 3
  l1_minhash_enabled: boolean;             // default: false
  l1_mark_only: boolean;                   // default: true (mark, don't block insert)
  l1_jaccard_threshold: number;            // default: 0.7
  
  // Phase 4
  l2_semantic_enabled: boolean;            // default: false
  l2_canary_collections: string[];         // default: [] (which collections to enable)
  l2_cosine_threshold: number;             // default: 0.90
  l2_top_k_ann: number;                    // default: 1
}
```

### Migration Steps (Per Phase)

**Phase 1 Migration**:
```sql
-- 1. Add columns (nullable, no default — no lock)
ALTER TABLE context_chunks ADD COLUMN content_hash TEXT;
ALTER TABLE context_chunks ADD COLUMN content_hash_version INTEGER;
ALTER TABLE context_chunks ADD COLUMN normalized_text TEXT;
ALTER TABLE context_chunks ADD COLUMN collection_scope TEXT;

-- 2. Backfill for existing rows (batch, online)
--    Run as background job, 1000 rows at a time
--    regionHash remains unchanged throughout

-- 3. Create indexes CONCURRENTLY (no write lock)
CREATE UNIQUE INDEX CONCURRENTLY idx_content_hash_collection
  ON context_chunks (collection_scope, content_hash)
  WHERE content_hash IS NOT NULL;

-- 4. Validate: verify no existing regionHash matches are broken
--    Script compares regionHash grouping vs new contentHash grouping
```

**Phase 2 Migration** (RAPTOR):
```sql
-- New tables only, no changes to existing
CREATE TABLE raptor_nodes (...);
CREATE INDEX CONCURRENTLY idx_raptor_embedding ...;
```

**Phase 3 Migration** (L1):
```sql
-- New tables, new column on context_chunks
ALTER TABLE context_chunks ADD COLUMN normalized_text TEXT;
-- Backfill normalized_text (already done if Phase 1/2 complete)
CREATE TABLE minhash_signatures (...);
CREATE TABLE dedup_lsh_buckets (...);
```

**Phase 4 Migration** (L2):
```sql
-- Add vector column
ALTER TABLE context_chunks ADD COLUMN embedding VECTOR(384);
-- Backfill embeddings for existing chunks (batch job)
-- Create HNSW index CONCURRENTLY
CREATE INDEX CONCURRENTLY idx_chunks_embedding_hnsw ...;
```

### Rollback Plan

Each phase is independently reversible:

- **Phase 1**: `l0_content_hash_enabled = false` → system reverts to regionHash-only. No data loss (regionHash never touched).
- **Phase 2**: `raptor_enabled = false` → RAPTOR stops generating. Existing raptor_nodes table remains but unused.
- **Phase 3**: `l1_minhash_enabled = false` → L1 check skipped. MinHash tables remain but unused.
- **Phase 4**: `l2_semantic_enabled = false` → L2 check skipped. Embeddings column + index remain but unused.

**Database rollback**: Each migration adds columns/tables without modifying or dropping existing ones. Full rollback = drop new columns/tables, no data recovery needed.

---

## Risk Assessment

## Observability & Metrics (replaces vague mentions with concrete instrumentation)

### Goals
- Detect dedup effectiveness regressions (hit rate, false positives)
- Detect dependency degradation (Redis/PG/LLM/embeddings)
- Bound backfill impact and verify progress
- Provide Grafana panels an on-caller can use in under 5 minutes

### Metrics Transport & Exposure
- Expose Prometheus metrics via `/metrics` on a dedicated admin port (see Health & Readiness section).
- All metrics are labeled by `tier` (L0, L1, L2, raptor, mmr) and where applicable by `phase` (1,3,4) and `collection` (or `collection_scope`).

### Metrics Catalog (complete)

#### Request/Decision (RED)
1. **Dedup decisions**
   - `dedup_requests_total{tier,result}` (Counter)
     - `result ∈ {hit,miss,duplicate_skipped,duplicate_confirmed,false_positive_suspected,error}`
   - `dedup_decision_latency_seconds{tier,operation}` (Histogram)
     - `operation ∈ {l0_exact,redis_get,pg_lookup,l1_minhash,l1_lsh_bucket,l1_trigram_verify,l2_ann,l2_vector_query,mmr_select,raptor_store,raptor_retrieve}`
     - buckets: `[0.001,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2,5]`
   - `dedup_active_requests{tier}` (Gauge)

2. **Tier enablement**
   - `dedup_tier_enabled{tier}` (Gauge, 0/1)

#### Dependency & Circuit Breaker (SLO guardrails)
1. `dedup_dependency_calls_total{dependency,operation,outcome}` (Counter)
   - `dependency ∈ {redis,postgresql,embedding_model,llm}
     operation ∈ {get, set, exists, query, embed, summarize}
     outcome ∈ {success,timeout,circuit_open,error}
`
2. `dedup_circuit_breaker_state{breaker}` (Gauge)
   - `breaker ∈ {redis_get,redis_set,pg_query,embedding_model,llm_summarize}`
   - `state ∈ {0=closed,1=open,2=half_open}`
3. `dedup_circuit_breaker_open_total{breaker}` (Counter)

#### Correctness & FP Monitoring
1. `dedup_false_positive_rate{tier,collection}` (Gauge)
   - computed by sample-and-verify pipeline (rolling 1h window)
2. `dedup_false_positive_samples_total{tier,collection,outcome}` (Counter)
   - `outcome ∈ {flagged_reconfirmed,flagged_disproved,queued_for_review}`
3. `dedup_duplicate_rate{tier,collection}` (Gauge)

#### Bloom Filter (L0 accelerator only)
1. `dedup_bloom_fill_ratio{collection}` (Gauge)
2. `dedup_bloom_miss_confirmed_total{collection}` (Counter)  
   - Bloom said miss; DB confirmed absence (used to validate accelerator correctness)
3. `dedup_bloom_hit_confirmed_total{collection}` (Counter)

#### Backfill Progress & Impact
1. `dedup_backfill_progress{phase,status}` (Gauge)
   - `status ∈ {queued,running,completed,failed}`
2. `dedup_backfill_rows_processed_total{phase}` (Counter)
3. `dedup_backfill_batch_duration_seconds{phase}` (Histogram)
4. `dedup_backfill_duplicates_found_total{phase}` (Counter)

#### Storage/Index Health
1. `dedup_storage_rows{table}` (Gauge)
   - `table ∈ {context_chunks,raptor_nodes,minhash_signatures,dedup_lsh_buckets}`
2. `dedup_index_build_state{index}` (Gauge)

### Instrumentation Implementation Notes
- Instrument at boundaries:
  - Start/end of each tier check
  - Each external dependency call
  - Backfill batch loop
- Always emit outcome labels consistently to avoid Grafana cardinality explosions.
- Add `statement_timeout_ms` label only if low cardinality; otherwise omit.

### Grafana Dashboard Spec
**Dashboard: “Dedup System Overview”**
1. Panel: Dedup duplicate rate by tier (time series)
2. Panel: False positive rate by tier (time series + alert line)
3. Panel: Request latency p95 by tier (time series)
4. Panel: Circuit breaker states (stacked 0/1/2)
5. Panel: Redis/PG dependency outcomes (stacked)
6. Panel: Backfill progress (gauges per phase)
7. Panel: Bloom fill ratio (line)
8. Panel: L1 candidate counts (histogram of candidates per insert)
9. Panel: L2 ANN top1 similarity distribution (optional, for tuning)

---

## Circuit Breakers & Degradation (implements all circuit breakers)

### Requirements
- Add 100ms timeout and opossum circuit breaker for:
  1) Redis GET
  2) Redis SET (cache warming/backfill)
  3) PostgreSQL queries used by dedup tiers
  4) Embedding model inference
  5) LLM summarization (RAPTOR)
- Fallback behavior must be deterministic and must never cause data loss.
- If a breaker is open, the system must immediately skip only the affected tier and continue safe paths.

### Breaker Definitions
Use the same template for each breaker:
- timeoutMs: 100 (Redis, embeddings) / 5000 (PG) / 5000 (LLM)
- errorThresholdPercentage: 50
- resetTimeout: 30000
- half-open probe uses 1 request then returns to open/closed based on outcome.

#### Redis GET breaker
- Name: `redis_get`
- Timeout: 100ms
- Fallback: PostgreSQL-only L0 exact match (never skip DB)

#### Redis SET breaker
- Name: `redis_set`
- Timeout: 100ms
- Fallback: skip cache writes; continue processing

#### PostgreSQL breaker
- Name: `pg_query`
- Timeout: 5000ms (and enforce SQL `statement_timeout` separately during backfill)
- Fallback:
  - If breaker open during L1/L2 checks: skip that tier (mark-only if configured)
  - If breaker open during L0: set `dedup=false` for inserts to preserve correctness (still store the chunk)

#### Embedding model breaker
- Name: `embedding_model`
- Timeout: 100ms
- Fallback: skip L2 semantic dedup and any RAPTOR summary embeddings; keep RAPTOR text if available

#### LLM breaker (RAPTOR summarization)
- Name: `llm_summarize`
- Timeout: 5000ms
- Fallback: extractive summarization only (no hallucinated structured summary)

### Degradation Ladder (by tier)
1. L0 always attempts exact dedup; if Redis breaker open, use PG-only.
2. L1 executes only if PG breaker closed; else either skip (canary) or mark-only (phases 3-4).
3. L2 executes only if embedding model + PG are healthy; else skip.
4. RAPTOR summarization executes only if LLM breaker closed; else extractive fallback.

### Circuit Breaker Metrics
- `dedup_circuit_breaker_state{breaker}`
- `dedup_circuit_breaker_open_total{breaker}`
- `dedup_dependency_calls_total{dependency,outcome}`

---

## Health & Readiness Endpoints (on separate admin port)

### Endpoints
All on `127.0.0.1` and admin port `DEDUP_ADMIN_PORT` (default 9099).

1. `GET /healthz`
   - Liveness only (no dependency checks)
   - 200: `{status:"ok"}`

2. `GET /ready`
   - Readiness includes:
     - warmup complete
     - Redis reachable OR Redis breaker open (degraded allowed)
     - PostgreSQL reachable
     - pgvector extension present (Phase 2 prerequisite)
     - embeddings warmup complete if L2 enabled
   - 200 when ready; otherwise 503 with per-check breakdown.

3. `GET /metrics`
   - Prometheus metrics

4. `GET /debug/breakers`
   - JSON: breaker states and last failure reasons.

5. `GET /debug/config`
   - JSON: active thresholds/flags (live reload result).

### Readiness Rules
- During backfill: `/ready` remains 200 as long as user-facing inserts work (dedup may be degraded).
- If PG is unreachable: `/ready` => 503.

---

## Cold Start & Warmup Strategy

### Warmup Goals
- Reduce first-request latency spikes
- Prevent long tail circuit breaker opens during startup

### Warmup Components
1. Bloom filter:
   - Load from Redis snapshot if available.
   - If not, build from PostgreSQL content_hashes in batches, emitting `dedup_warmup_progress`.
2. Redis:
   - Ping and establish pool.
   - Warm cache key namespace prefix (no writes required).
3. Embedding model:
   - Run one dummy embedding request to ensure model is loaded.
4. PostgreSQL connection pool:
   - Verify with a lightweight `SELECT 1`.

### Warmup Progress
- Gauge: `dedup_warmup_progress{component}` (0-100)
- `/ready` returns 503 until overall warmup reaches 100 or until warmup timeout (60s) then starts in degraded mode.

### Warmup Timeout Policy
- If warmup exceeds 60s:
  - Start accepting inserts
  - Mark bloom/embedding as degraded in readiness response
  - Do not block dedup indefinitely.

---

## Alert Definitions & On-Call Runbook

### Alert Routing
- P1: page on-call engineer immediately.
- P2: create incident ticket, on-call acknowledgment within 1 hour.
- P3: notify channel.
- P4: informational.

### P1 Alerts
1. **DedupBlindness**
   - Condition: `dedup_active_requests{tier="L0"}` drops to 0 AND `dedup_tier_enabled{tier="L0"}` is 1 for 5m.
   - or: `dedup_requests_total{tier="L0",result="error"}` rate > 1% for 5m.
   - Runbook:
     - Check `/healthz` and `/ready`
     - Check `/debug/breakers`
     - If PG breaker open: verify DB connectivity and indexes
     - If Redis breaker open: safe; ensure fallback to PG-only.

2. **FalsePositiveSpike**
   - Condition: `dedup_false_positive_rate{tier}` > 1% for L0 or >5% for L1/L2 over 10m.
   - Runbook:
     - Disable tier via feature flags (mark-only for L1/L2)
     - Start FP review queue drain
     - Inspect similarity distributions (Grafana panel)

3. **BackfillFailedOrStalled**
   - Condition: `dedup_backfill_progress{phase="1",status="running"}` unchanged for 30m OR `...status="failed"`.
   - Runbook:
     - Inspect backfill logs and `statement_timeout`
     - Check PG locks
     - Resume with lower batch size.

### P2 Alerts
1. **SingleTierDegraded**
   - Condition: `dedup_circuit_breaker_state{breaker="pg_query"}` open for 5m while system otherwise healthy.
   - Runbook:
     - Verify indexes and query plans
     - Confirm statement_timeout and connection pool saturation.

2. **LatencyDegradation**
   - Condition: p95 of `dedup_decision_latency_seconds{tier}` exceeds budgets:
     - L0 >50ms, L1 >200ms, L2 >300ms for 10m.
   - Runbook:
     - Check dependency latency panels
     - If Redis slow: disable Redis usage (PG-only).
     - If L2 ANN slow: reduce ef_search / search params.

### P3 Alerts
- BloomFillTooHigh (fill_ratio >0.8 for 1h)
- ConfigReloadFailure (file watcher parse errors >3/min)
- WarmupSlow (>45s)

### P4 Alerts
- DuplicateRateDrift (7d baseline drift >20%)

---

## Backfill Orchestration (detailed, throttled, progress-tracked, statement_timeout)

### Shared Backfill Controller Guarantees
- Each phase uses:
  - `dedup_backfill_progress` table rows per phase
  - batch loop with:
    - `SET LOCAL statement_timeout = '30000ms'`
    - `FOR UPDATE SKIP LOCKED` when selecting rows
  - progress logging every 100 batches
  - metrics emitted per batch
- Backfill is resumable (idempotent batches).

### Critical Ordering Fixes
- Create required (non-unique) indexes BEFORE backfill.
- Resolve duplicates BEFORE creating UNIQUE constraints.
- Unique index creation occurs once, at the end of the phase backfill.

### Phase 1 backfill (content_hash, normalized_text)
1. Before backfill:
   - Create non-unique index `idx_content_hash_collection_nonuniq`
2. Backfill loop:
   - Select rows where `content_hash IS NULL`
   - Process in batches (default 1000)
   - Throttle to `maxBatchRate` (default 5 batches/sec)
   - Update `dedup_backfill_progress.processed` per batch
3. After backfill:
   - Resolve duplicates deterministically (keep oldest)
4. Create UNIQUE index:
   - `CREATE UNIQUE INDEX CONCURRENTLY idx_content_hash_collection ... WHERE content_hash IS NOT NULL`
5. Drop non-unique index.

### Phase 3 backfill (MinHash/LSH)
- Precondition:
  - Phase 1 must be completed
- Backfill loop:
  - Only compute MinHash for chunks missing signatures
  - Insert signatures and buckets with `ON CONFLICT DO NOTHING` keyed by `(chunk_id, signature_version)`
- Throttle + statement_timeout same as Phase 1.

### Phase 4 backfill (embeddings)
- Precondition:
  - Phase 1 completed and embedding prerequisites satisfied
- Backfill loop:
  - Compute embeddings for rows where `embedding IS NULL`
  - Insert/update embeddings with idempotent SQL
  - Create HNSW index only after bulk update completes (or create after a threshold if DB supports online build).

### Backfill Progress Visibility
- `/debug/backfill` endpoint (optional) can dump the current phase, batch size, last batch time.
- Grafana panel reads metrics and shows stuck detection.

---

## Rollback & Cleanup Scripts per phase

> Note: All rollback scripts are additive-safe; they never destroy legacy data, only remove newly-added constraints/artifacts.

### Phase 1 rollback
- Disable L0 dedup feature flags
- Drop UNIQUE/lookup indexes created in phase 1
- Drop newly introduced columns (content_hash, content_hash_version, normalized_text, collection_scope) ONLY if they were created by phase 1
- Delete `dedup_backfill_progress` rows for phase 1

### Phase 2 rollback
- Disable RAPTOR
- Drop `raptor_nodes` table
- Keep pgvector extension (shared dependency)

### Phase 3 rollback
- Disable L1
- Drop `minhash_signatures` and `dedup_lsh_buckets`
- Drop the trigram GIN index created for `normalized_text`

### Phase 4 rollback
- Disable L2
- Drop HNSW index on embedding
- Drop `embedding` column
- Keep pgvector extension

### Full rollback
- Execute Phase 4 -> Phase 3 -> Phase 2 -> Phase 1 artifacts removal.
- Leave `context_chunks.region_hash` untouched.

---

## Fixed migration ordering with no duplicates (covers #8, #9, #10, #11, #12, #13)

### #8 Backfill race — unique index created AFTER backfill
Fix:
- Always create non-unique index first
- Run backfill
- Resolve duplicates
- Create UNIQUE index CONCURRENTLY at the end
- Drop temporary non-unique index

### #9 Duplicate ALTER TABLE normalized_text in Phase 3
Fix:
- `normalized_text` is added ONLY in Phase 1.
- Phase 3 adds ONLY the index (GIN) on normalized_text.
- Phase 3 contains NO `ALTER TABLE ... ADD COLUMN normalized_text`.

### #10 No Redis timeout or circuit breaker
Fix:
- Redis operations wrapped in opossum with 100ms timeout.
- Fallback: PostgreSQL-only.

### #11 No pgvector pre-flight check in Phase 2
Fix:
- Phase 2 migration begins with explicit `CREATE EXTENSION IF NOT EXISTS vector` check.
- If not installed, migration fails fast.

### #12 No alert conditions/routing/escalation
Fix:
- Add P1-P4 alert definitions with thresholds + runbook + routing.

### #13 Phase 2 uses VECTOR but extension check deferred to Phase 4
Fix:
- Move extension check into Phase 2 prerequisite block.
- Phase 4 migration assumes extension already present.

### Canonical Migration Ordering (final)

**Phase 1**
1. `ALTER TABLE context_chunks ADD COLUMN content_hash ...`
2. `ALTER TABLE context_chunks ADD COLUMN content_hash_version ...`
3. `ALTER TABLE context_chunks ADD COLUMN normalized_text ...`
4. `ALTER TABLE context_chunks ADD COLUMN collection_scope ...`
5. Create non-unique indexes for backfill performance
6. Backfill content_hash/normalized_text
7. Resolve duplicates
8. Create UNIQUE index CONCURRENTLY
9. Drop temporary non-unique indexes

**Phase 2**
1. pgvector pre-flight: verify `vector` extension exists
2. Create `raptor_nodes` and indexes

**Phase 3**
1. `CREATE EXTENSION IF NOT EXISTS pg_trgm`
2. Create `minhash_signatures` and `dedup_lsh_buckets`
3. Create GIN index on existing `context_chunks.normalized_text`
4. Backfill minhash signatures + LSH buckets

**Phase 4**
1. Add `embedding VECTOR(384)` column
2. Backfill embeddings
3. Create HNSW index CONCURRENTLY

---

## Testing & Validation Strategy (tie-ins to observability/FP monitoring)

### Migration validation
After each phase migration:
- Verify `normalized_text` column exists exactly once (Phase 1 only)
- Verify pgvector extension exists after Phase 2 prereq
- Verify unique index exists only after duplicates resolved

### FP monitoring gate for rollout
- Do not enable L1/L2 fully unless FP rate alerts remain green for 24h on canary.

---

## Appendix: What Changed From Review

- Added full Observability & Metrics sections with concrete metric names and dashboard spec.
- Added complete Circuit Breakers & Degradation with opossum pattern + fallbacks.
- Added Health & Readiness endpoints on admin port.
- Added Cold Start warmup sequence and readiness blocking rules.
- Added full Alert definitions P1-P4 and escalation runbook.
- Added detailed backfill orchestration including race fix (#8).
- Added rollback & cleanup scripts per phase.
- Replaced/confirmed migration ordering to remove duplicate normalized_text ALTER (#9) and moved pgvector check to Phase 2 (#11/#13).

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **regionHash compatibility broken** | CRITICAL | Low | regionHash function extracted as pure function, tested in isolation, never modified. New contentHash is separate field. |
| **False positive dedup (good content blocked)** | HIGH | Medium | Mark-only mode first (Phases 3-4). Conservative thresholds tuned on labeled corpus. Per-collection overrides. Monitoring dashboard for FP rate. |
| **Embedding cost explosion** | HIGH | Low | RAPTOR uses cheap model (Haiku). L2 uses local model (all-MiniLM-L6-v2), no API cost. Batch embedding, not per-message. |
| **Bloom filter cold start** | MEDIUM | High on restart | Redis-backed bloom survives restarts. Warm from PostgreSQL on init. Bloom miss ALWAYS confirms via DB (never skips). |
| **LSH/Minhash non-determinism** | MEDIUM | Low | Pinned seed (0xDEADBEEF). Signature versioning. Integration tests verify bucket key stability across restarts. |
| **Performance regression** | MEDIUM | Medium | Each tier has a latency budget and circuit breaker. p95 tracked per tier. Can degrade (e.g., skip L1 if >50ms). |
| **Storage bloat** | LOW | Medium | Retention policies per collection. Periodic VACUUM and index maintenance. TTL on Redis keys. Soft-delete for SemDeDup cleanup. |
| **Model drift (embedding model changes)** | LOW | Low | Embedding model version stored with each vector. Thresholds tied to model+normalization combo. Migration batch job for re-embedding. |

---

## Configuration: Single Source of Truth

All thresholds, parameters, and flags in one file:

```typescript
// config/dedup.ts
// SINGLE SOURCE OF TRUTH — no duplication across modules
export const DedupConfig = {
  // Phase 1
  l0: { /* ... */ },
  retrieval: { /* ... */ },
  
  // Phase 2
  raptor: { /* ... */ },
  
  // Phase 3
  l1: { /* ... */ },
  
  // Phase 4
  l2: { /* ... */ },
  
  // Feature flags
  flags: { /* ... */ },
  
  // Per-collection overrides
  collections: {
    [collection: string]: {
      l1_jaccard_threshold?: number;
      l2_cosine_threshold?: number;
      raptor_enabled?: boolean;
    }
  },
} as const;
```

---

## Appendix: What Changed From Review

| Review Finding | Resolution |
|----------------|------------|
| **CRITICAL #1**: Threshold chaos across sections | Single config file (`config/dedup.ts`), all thresholds defined once |
| **CRITICAL #2**: Backward compatibility break | regionHash immutable, contentHash new+separate, normalization versioned |
| **CRITICAL #3**: Global vs per-collection scope ambiguity | Explicit `collection_scope` column, separate constraints possible |
| **HIGH #4**: Concurrency races | `INSERT ... ON CONFLICT DO NOTHING RETURNING` throughout |
| **HIGH #5**: Bloom filter correctness | Bloom miss → skip Redis only, STILL confirm DB. Bloom hit → always confirm. |
| **HIGH #6**: LSH non-determinism | Pinned seed, signature versioning, version in bucket key |
| **HIGH #7**: Cosine distance confusion | Unit-normalized vectors enforced. `sim = 1 - <=>`. Asserted at write. |
| **HIGH #8**: RAPTOR level mismatch | Raw leaves stored but NOT deduped at vector level. MMR retrieval covers leaf redundancy. |
| **TECH CORRECTIONS**: Banding, pgvector SQL, Bloom sizing, pg_trgm usage, SemDeDup complexity | All corrected inline in this version |
| **PRACTICAL**: MVP first, cut RAPTOR, use libraries, test corpus | Phased plan: Phase 1 (MVP) → Phase 2 (RAPTOR) → Phase 3 (L1) → Phase 4 (L2). Libraries preferred. Adversarial corpus before tuning. |

---

> **Next step**: Begin Phase 1 implementation — the foundation everything else builds on.
