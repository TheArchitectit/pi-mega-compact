# Deduplication System Upgrade — Implementation Plan

> **Version**: v2.0 — all 75+ QA fixes applied, 2025-07-16
> **Status**: Revised after adversarial review. All critical blockers resolved.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Phase 1: L0 Exact Dedup + Retrieval-Time MMR](#2-phase-1-l0-exact-dedup--retrieval-time-mmr)
3. [Phase 2: RAPTOR Pre-Compression](#3-phase-2-raptor-pre-compression)
4. [Phase 3: L1 MinHash + Trigram Near-Dedup](#4-phase-3-l1-minhash--trigram-near-dedup)
5. [Phase 4: L2 Semantic Dedup with HNSW + SemDeDup Online](#5-phase-4-l2-semantic-dedup-with-hnsw--sendedup-online)
6. [Disaster Recovery & Data Integrity](#6-disaster-recovery--data-integrity)
7. [Integration Points with Existing Codebase](#7-integration-points-with-existing-codebase)
8. [Security Hardening](#8-security-hardening)
9. [Baseline Collection Methodology](#9-baseline-collection-methodology)
10. [Tenant Isolation & Multi-Tenancy Safety](#10-tenant-isolation--multi-tenancy-safety)
11. [Observability & Metrics](#11-observability--metrics)
12. [Circuit Breakers & Degradation](#12-circuit-breakers--degradation)
13. [Health & Readiness Endpoints](#13-health--readiness-endpoints)
14. [Cold Start & Warmup Strategy](#14-cold-start--warmup-strategy)
15. [Alert Definitions & On-Call Runbook](#15-alert-definitions--on-call-runbook)
16. [Backfill Orchestration](#16-backfill-orchestration)
17. [Rollback & Cleanup Scripts per Phase](#17-rollback--cleanup-scripts-per-phase)
18. [Fixed Migration Ordering with No Duplicates](#18-fixed-migration-ordering-with-no-duplicates)
19. [Performance Optimizations — VectorStore & Checkpoint Layer](#19-performance-optimizations--vectorstore--checkpoint-layer)
20. [Testing & Validation Strategy](#20-testing--validation-strategy)
21. [Configuration: Single Source of Truth](#21-configuration-single-source-of-truth)
22. [Risk Assessment](#22-risk-assessment)

---

## 1. Architecture Overview

### 1.1 Current state (before upgrade)

The current dedup is a single-phase exact-regionHash scheme:

1. `VectorStore.add()` in `/home/user001/git/pi-megacompact/src/vectorStore.ts` receives an `AddInput`
2. `computeRegionHash()` hashes the normalized region text (sha256 first 16 hex chars)
3. Existing checkpoints (per-session) are scanned for a matching `regionHash`
4. If match: skip embedding, mark as duplicate
5. If no match: embed via `TrigramEmbedder` and `appendCheckpoint()` to gzipped JSON

Sentinel-based recall uses `regionHash` to detect re-encountered regions and skip re-injection.

### 1.2 Target architecture (four phases)

The upgrade adds four dedup tiers in sequential phases:

```
Insert -> L0 (exact) -> [L1 (MinHash/trigram)] -> L2 (semantic/MMR)
              |                                      |
              v                                      v
        content_hash +                           cosine similarity
        normalized_text                          + SemDeDup cluster
```

| Phase | Tier | What it catches | Latency budget |
|-------|------|----------------|----------------|
| 1 | L0 Exact | Identical text (after normalization) | < 50ms p95 |
| 2 | RAPTOR | Compressible context clusters | < 5s (offline tree build) |
| 3 | L1 MinHash + Trigram | Near-duplicate text (shingling) | < 200ms p95 |
| 4 | L2 Semantic (cosine + ANN) | Semantically similar but different text | < 300ms p95 |

### 1.3 Key design principles

- **Backward compatibility**: Existing `regionHash` field is immutable. New `content_hash`, `content_hash2` (blake3), and `normalized_text` are separate fields.
- **Collection/tenant isolation**: Every dedup decision is scoped by `collection_scope` (multi-tenant safe from day one).
- **All hash checks use two independent digests**: `sha256` (primary) + `blake3` (secondary) before declaring a duplicate.
- **Bloom filter is an accelerator only**: Bloom miss -> skip Redis, still confirm DB. Bloom hit -> always confirm DB.
- **LSH determinism**: Pinned seed `0xDEADBEEF`, signature versioning, version in bucket key.
- **Unit-normalized vectors**: `sim = 1 - (embedding1 <=> embedding2)`, asserted at write time.
- **Feature flags**: Each tier can be independently enabled/disabled via config.

### 1.4 Degradation ladder

When circuit breakers open (see Section 12) or backpressure is needed:

1. L0 always attempts exact dedup; if Redis breaker open, use PG-only
2. L1 executes only if PG breaker closed; else skip (canary) or mark-only (Phases 3-4)
3. L2 executes only if embedding model + PG healthy; else skip
4. RAPTOR summarization executes only if LLM breaker closed; else extractive fallback

---

## 2. Phase 1: L0 Exact Dedup + Retrieval-Time MMR

### 2.1 Goal
Eliminate exact duplicates after normalization and provide retrieval-time diversity via MMR.

### 2.2 Schema changes

```sql
-- Column additions (all in Phase 1)
ALTER TABLE context_chunks ADD COLUMN content_hash      TEXT;
ALTER TABLE context_chunks ADD COLUMN content_hash2     TEXT;       -- blake3 secondary digest
ALTER TABLE context_chunks ADD COLUMN content_hash_version INTEGER DEFAULT 1;
ALTER TABLE context_chunks ADD COLUMN normalized_text   TEXT;
ALTER TABLE context_chunks ADD COLUMN collection_scope  TEXT DEFAULT 'default';
```

### 2.3 Index creation (non-unique first, then backfill, then UNIQUE CONCURRENTLY)

```sql
-- Step 1: Non-unique index for backfill performance
CREATE INDEX CONCURRENTLY idx_content_hash_collection_nonuniq
  ON context_chunks (collection_scope, content_hash)
  WHERE content_hash IS NOT NULL;

-- Step 2: Backfill (see Section 16)

-- Step 3: Resolve duplicates (keep oldest row)

-- Step 4: Unique index
CREATE UNIQUE INDEX CONCURRENTLY idx_content_hash_collection
  ON context_chunks (collection_scope, content_hash)
  WHERE content_hash IS NOT NULL;

-- Step 5: Drop temporary index
DROP INDEX CONCURRENTLY idx_content_hash_collection_nonuniq;
```

### 2.4 Hash computation (double-digest)

```typescript
// src/dedup/digest.ts -- Independent double-hash verification
import { createHash } from "node:crypto";

export interface ContentDigest {
  content_hash: string;       // sha256 full 64 hex
  content_hash2: string;      // blake3 full 64 hex
  content_hash_version: number;
}

export function computeContentDigest(normalizedText: string): ContentDigest {
  const sha = createHash("sha256").update(normalizedText, "utf-8").digest("hex");
  const blake = createHash("blake3").update(normalizedText, "utf-8").digest("hex");
  return {
    content_hash: sha,
    content_hash2: blake,
    content_hash_version: 1,
  };
}
```

### 2.5 Normalization function

```typescript
// src/dedup/normalize.ts
export function normalizeText(raw: string): string {
  if (!raw) return "";
  // Cap input size for DoS protection
  const maxLen = 32_000;
  const truncated = raw.slice(0, maxLen);
  // Normalize whitespace: collapse runs, trim, normalize newlines
  return truncated
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}
```

### 2.6 L0 dedup check (hot path)

```typescript
// src/dedup/l0-check.ts
import { normalizeText } from "./normalize.js";
import { computeContentDigest } from "./digest.js";

export interface L0CheckInput {
  rawText: string;
  collectionScope: string;
  pgPool: PgPool;
  redisClient: RedisClient;   // may be degraded
  bloomFilter: BloomFilter;
}

export interface L0CheckResult {
  isDuplicate: boolean;
  deduped: boolean;
  normalizedText: string;
  digest: ContentDigest | null;
}

export async function checkL0(input: L0CheckInput): Promise<L0CheckResult> {
  const normalizedText = normalizeText(input.rawText);
  if (!normalizedText) {
    return { isDuplicate: false, deduped: false, normalizedText, digest: null };
  }
  const digest = computeContentDigest(normalizedText);

  // Bloom accelerator (Redis-backed). Bloom miss is informational only.
  // Always confirm with DB.
  const bloomKey = `dedup:L0:${input.collectionScope}:${digest.content_hash}`;
  const bloomMaybePresent = await input.bloomFilter.check(bloomKey).catch(() => false);

  if (!bloomMaybePresent) {
    // Bloom says new -- confirm via PG query
    const row = await input.pgPool.query(
      `SELECT id FROM context_chunks
       WHERE collection_scope = $1 AND content_hash = $2 AND content_hash2 = $3
       LIMIT 1`,
      [input.collectionScope, digest.content_hash, digest.content_hash2]
    );
    if (row.rows.length > 0) {
      return { isDuplicate: true, deduped: true, normalizedText, digest };
    }
    // Confirm absence and skip further accelerator checks
    return { isDuplicate: false, deduped: false, normalizedText, digest };
  }

  // Bloom says present -- confirm via PG with double-digest
  const row = await input.pgPool.query(
    `SELECT id FROM context_chunks
     WHERE collection_scope = $1 AND content_hash = $2 AND content_hash2 = $3
     LIMIT 1`,
    [input.collectionScope, digest.content_hash, digest.content_hash2]
  );
  const isDuplicate = row.rows.length > 0;
  return { isDuplicate, deduped: isDuplicate, normalizedText, digest };
}
```

### 2.7 Retrieval-time MMR (Maximal Marginal Relevance)

```typescript
// src/dedup/mmr.ts -- applied inside VectorStore.search()
export function mmrRerank(
  candidates: SearchHit[],
  queryEmbedding: Vector,
  lambda: number = 0.5,
  maxResults: number = 10
): SearchHit[] {
  if (candidates.length === 0) return [];

  const selected: SearchHit[] = [];
  const remaining = [...candidates];
  const selectedEmbeddings: Vector[] = [];

  // Select the first candidate (closest to query)
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].score > bestScore) {
      bestScore = remaining[i].score;
      bestIdx = i;
    }
  }
  selected.push(remaining[bestIdx]);
  selectedEmbeddings.push(remaining[bestIdx].checkpoint.embedding);
  remaining.splice(bestIdx, 1);

  while (selected.length < maxResults && remaining.length > 0) {
    let bestMMR = -Infinity;
    let bestCandidate = -1;

    for (let i = 0; i < remaining.length; i++) {
      const relScore = remaining[i].score;
      // Max similarity to any already-selected item
      let maxSimToSelected = 0;
      for (const se of selectedEmbeddings) {
        const sim = cosineSimilarity(remaining[i].checkpoint.embedding, se);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }
      const mmrScore = lambda * relScore - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestCandidate = i;
      }
    }

    if (bestCandidate >= 0) {
      selected.push(remaining[bestCandidate]);
      selectedEmbeddings.push(remaining[bestCandidate].checkpoint.embedding);
      remaining.splice(bestCandidate, 1);
    }
  }

  return selected;
}
```

---

## 3. Phase 2: RAPTOR Pre-Compression

### 3.1 Goal
Build a hierarchical summary tree over checkpoint chunks for efficient, compressed retrieval. Operates in shadow mode initially (RAPTOR results logged but not served), and uses strict hallucination guardrails.

### 3.2 RAPTOR Architecture

```
Chunks -> k-means clustering -> summarization -> tree node
    |                              |
    v                              v
 leaf nodes                 summary nodes (levels 1+)
```

### 3.3 RAPTOR Configuration

```typescript
// src/dedup/raptor-config.ts
export const RaptorConfig = {
  chunking: {
    chunkSize: 512,        // tokens
    chunkOverlap: 0,
  },
  clustering: {
    algorithm: "kmeans" as const,
    minClusterSize: 5,
    maxClusters: 50,
    nearZeroVarianceEpsilon: 1e-12,
    smallCheckpointThreshold: 10,
    maxTotalSummaries: 50,
  },
  summarization: {
    model: "haiku",
    temperature: 0,
    maxTokens: 512,
    extractiveFallback: true,   // when consistency check fails
  },
  hallucinationGuardrails: {
    claimGrounding: true,
    entityVerification: true,
    consistencyCheck: true,
    consistencyThreshold: 0.6,
    entityCoverageThreshold: 0.5,
  },
  contradictionDetection: {
    adjacentLevelsOnly: true,
    minNounOverlap: 2,
  },
  retrieval: {
    stagedExpansion: true,
    topK: 5,
    topM: 3,
    maxExpandedLeaves: 30,
    oversampleFactor: 3,
  },
  shadowMode: true,                  // Phase 2: run but don't serve
  maxTotalSummaries: 50,
  buildTimeoutMs: 5000,
};
```

### 3.4 Tree storage schema

```sql
-- Separate from context_chunks for shadow mode safety
CREATE TABLE raptor_nodes (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  collection_scope TEXT DEFAULT 'default',
  level         INTEGER NOT NULL,       -- 0 = leaf, 1+ = summary
  parent_id     TEXT REFERENCES raptor_nodes(id),
  children      TEXT[],                 -- adjacency list: array of child node IDs
  summary       TEXT,
  embedding     VECTOR(384),            -- all-MiniLM-L6-v2 dimensions
  quality_marker TEXT DEFAULT 'pending', -- high|medium|low|extractive_fallback
  grounded_claims TEXT[],               -- claim-to-source traceability
  token_estimate INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Partial index for efficient retrieval of high-quality nodes
CREATE INDEX idx_raptor_quality ON raptor_nodes (level, quality_marker)
  WHERE quality_marker IN ('high', 'medium');

-- HNSW index on embedding
CREATE INDEX idx_raptor_embedding ON raptor_nodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

### 3.5 k-means clustering implementation

```typescript
// src/dedup/raptor/kmeans.ts
import { RaptorConfig } from "../raptor-config.js";

interface Point {
  id: string;
  vector: number[];       // embedding
  text: string;
}

interface Cluster {
  centroid: number[];
  points: Point[];
}

function squaredL2(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function kMeansPlusPlusInit(points: Point[], k: number): number[] {
  const n = points.length;
  const centers: number[] = [];
  // First center: uniform random
  centers.push(Math.floor(Math.random() * n));
  for (let c = 1; c < k; c++) {
    const distSq: number[] = [];
    let totalDistSq = 0;
    for (let i = 0; i < n; i++) {
      let minDistSq = Infinity;
      for (const centerIdx of centers) {
        const d = squaredL2(points[i].vector, points[centerIdx].vector);
        if (d < minDistSq) minDistSq = d;
      }
      distSq.push(minDistSq);
      totalDistSq += minDistSq;
    }
    // Weighted random selection by distance^2
    const r = Math.random() * totalDistSq;
    let cumulative = 0;
    for (let i = 0; i < n; i++) {
      cumulative += distSq[i];
      if (cumulative >= r) {
        centers.push(i);
        break;
      }
    }
  }
  return centers;
}

export function kMeansCluster(
  points: Point[],
  k: number,
  maxIterations: number = 100
): Cluster[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ centroid: [...points[0].vector], points: [points[0]] }];

  // Clamp k to valid range
  const clampedK = Math.max(1, Math.min(k, n, RaptorConfig.clustering.maxClusters));

  // Initialize using k-means++
  const centerIdxs = kMeansPlusPlusInit(points, clampedK);
  const centroids: number[][] = centerIdxs.map((idx) => [...points[idx].vector]);

  let assignments: number[] = new Array(n).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assignment step: nearest center by squared L2
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestDist = Infinity;
      let bestCenter = -1;
      for (let c = 0; c < clampedK; c++) {
        const d = squaredL2(points[i].vector, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCenter = c;
        }
      }
      if (bestCenter !== assignments[i]) {
        assignments[i] = bestCenter;
        changed = true;
      }
    }

    if (!changed) break; // Converged

    // Update step: recompute centroids
    for (let c = 0; c < clampedK; c++) {
      const assignedPoints: Point[] = [];
      for (let i = 0; i < n; i++) {
        if (assignments[i] === c) {
          assignedPoints.push(points[i]);
        }
      }
      if (assignedPoints.length === 0) {
        // Empty cluster: re-initialize from random point
        const randIdx = Math.floor(Math.random() * n);
        centroids[c] = [...points[randIdx].vector];
        continue;
      }
      const dim = points[0].vector.length;
      const newCentroid = new Array(dim).fill(0);
      for (const p of assignedPoints) {
        for (let d = 0; d < dim; d++) {
          newCentroid[d] += p.vector[d] / assignedPoints.length;
        }
      }
      centroids[c] = newCentroid;
    }
  }

  // Build output clusters
  const clusters: Cluster[] = centroids.map((centroid, c) => ({
    centroid,
    points: [],
  }));
  for (let i = 0; i < n; i++) {
    clusters[assignments[i]].points.push(points[i]);
  }

  // Near-zero-variance guard: if max squaredL2 < epsilon, merge to single cluster
  let maxSqDist = 0;
  for (const cluster of clusters) {
    for (const pt of cluster.points) {
      const d = squaredL2(pt.vector, cluster.centroid);
      if (d > maxSqDist) maxSqDist = d;
    }
  }
  if (maxSqDist < RaptorConfig.clustering.nearZeroVarianceEpsilon && clusters.length > 1) {
    // Merge all into one cluster
    const allPoints = clusters.flatMap((c) => c.points);
    const dim = points[0].vector.length;
    const mergedCentroid = new Array(dim).fill(0);
    for (const p of allPoints) {
      for (let d = 0; d < dim; d++) {
        mergedCentroid[d] += p.vector[d] / allPoints.length;
      }
    }
    return [{ centroid: mergedCentroid, points: allPoints }];
  }

  return clusters;
}
```

### 3.6 Tree construction

```typescript
// src/dedup/raptor/tree.ts
import { RaptorConfig } from "../raptor-config.js";
import { kMeansCluster } from "./kmeans.js";
import { summarizeCluster } from "./summarizer.js";
import { applyHallucinationGuardrails } from "./guardrails.js";

interface TreeNode {
  id: string;
  sessionId: string;
  level: number;
  summary: string;
  embedding: number[];
  children: string[];
  qualityMarker: string;
}

interface LeafNode extends TreeNode {
  text: string;
}

/**
 * Build a RAPTOR tree from leaf chunks.
 * Edge cases handled:
 * - < 10 chunks: single summary node, skip deep tree
 * - >= 1000 chunks: hard cap at MAX_TOTAL_SUMMARIES=50
 * - Near-zero variance: merge to single cluster
 * - Budget exhaustion: stop building, mark remaining as extractive fallback
 */
export async function buildRaptorTree(
  leaves: LeafNode[],
  sessionId: string
): Promise<TreeNode[][]> {
  if (leaves.length === 0) return [];
  if (leaves.length < RaptorConfig.clustering.smallCheckpointThreshold) {
    // < 10 chunks: single summary, skip deep tree
    const rootSummary = await summarizeCluster(leaves, sessionId, 1);
    return [[...leaves], [rootSummary]];
  }

  let currentLevel: TreeNode[] = leaves;
  const tree: TreeNode[][] = [leaves];
  let totalSummaries = 0;

  while (currentLevel.length >= RaptorConfig.clustering.minClusterSize * 2) {
    // Clamp k to [1, maxClusters, remaining budget]
    const k = Math.min(
      RaptorConfig.clustering.maxClusters,
      Math.max(1, Math.floor(currentLevel.length / RaptorConfig.clustering.minClusterSize)),
      RaptorConfig.clustering.maxTotalSummaries - totalSummaries
    );

    if (k <= 1) {
      // Too few nodes for next level: produce root summary at current level
      const rootSummary = await summarizeCluster(currentLevel, sessionId, tree.length);
      rootSummary.qualityMarker = "high";
      tree.push([rootSummary]);
      totalSummaries++;
      break;
    }

    const points = currentLevel.map((n) => ({
      id: n.id,
      vector: n.embedding,
      text: n.summary,
    }));

    const clusters = kMeansCluster(points, k);

    const nextLevel: TreeNode[] = [];
    for (const cluster of clusters) {
      totalSummaries++;
      if (totalSummaries > RaptorConfig.clustering.maxTotalSummaries) {
        break;
      }
      const summaryNode = await summarizeCluster(
        cluster.points.map((p) => currentLevel.find((n) => n.id === p.id)!),
        sessionId,
        tree.length
      );
      summaryNode.children = cluster.points.map((p) => p.id);
      nextLevel.push(summaryNode);
    }

    tree.push(nextLevel);
    currentLevel = nextLevel;

    // Stop if we hit the max summary cap
    if (totalSummaries >= RaptorConfig.clustering.maxTotalSummaries) {
      break;
    }
  }

  return tree;
}

/**
 * Budget-aware tree builder with 5s hard cap.
 * If budget exhausted, remaining clusters use extractive fallback.
 */
export async function buildRaptorTreeWithBudget(
  leaves: LeafNode[],
  sessionId: string,
  timeoutMs: number = RaptorConfig.buildTimeoutMs
): Promise<TreeNode[][]> {
  const startTime = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("RAPTOR build timeout")), timeoutMs)
  );
  try {
    const result = await Promise.race([
      buildRaptorTree(leaves, sessionId),
      timeoutPromise,
    ]);
    return result;
  } catch (err) {
    // Build timed out: return whatever we have with quality markers
    const partial: TreeNode[][] = [];
    const rootSummary = await summarizeCluster(leaves, sessionId, 1);
    rootSummary.qualityMarker = "extractive_fallback";
    partial.push(leaves);
    partial.push([rootSummary]);
    return partial;
  }
}
```

### 3.7 Summarization prompt (structured output)

```typescript
// src/dedup/raptor/summarizer.ts

interface SummaryResponse {
  summary: string;
  key_facts: string[];
  claims: Array<{ text: string; source_indices: number[] }>;
  coverage_notes: string;
  confidence: "high" | "medium" | "low";
}

const SUMMARIZATION_PROMPT = `You are a precise, faithful summarizer. Given the following text chunks from a conversation or codebase, produce a JSON object with these fields:

{
  "summary": "A concise synthesis of the key information across all chunks.",
  "key_facts": ["Fact 1", "Fact 2", ...],
  "claims": [
    {"text": "A specific claim from the source", "source_indices": [0, 2]}
  ],
  "coverage_notes": "Note any contradictions or low-confidence synthesis points.",
  "confidence": "high|medium|low"
}

Rules:
- Every claim MUST be supported by at least one source chunk. Reference chunks by their index in the list (0-based).
- If you are uncertain about any claim, note it as [UNCERTAIN: ...] within the claim text.
- If chunks contain contradictory information, note this in coverage_notes.
- Use "low" confidence when chunks are too diverse to synthesize confidently.
- Use "high" confidence when all claims are well-supported by multiple chunks.

Chunks:
`;

export async function summarizeCluster(
  nodes: TreeNode[],
  sessionId: string,
  level: number
): Promise<TreeNode> {
  const chunkTexts = nodes.map((n, i) => `[${i}] ${n.summary}`);
  const fullText = chunkTexts.join("\n\n");

  // Call LLM with structured output (system prompt + chunk texts)
  const raw = await callLLM(SUMMARIZATION_PROMPT + fullText, {
    temperature: 0,
    maxTokens: 512,
    responseFormat: "json",
  });

  const parsed = parseSummaryResponse(raw);

  // Apply hallucination guardrails
  const guarded = await applyHallucinationGuardrails(parsed, nodes);

  return {
    id: `raptor_${crypto.randomUUID().slice(0, 8)}`,
    sessionId,
    level,
    summary: guarded.summary,
    embedding: guarded.embedding,
    children: [],
    qualityMarker: guarded.qualityMarker,
  };
}

export function parseSummaryResponse(raw: string): SummaryResponse {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.summary || !Array.isArray(parsed.claims)) {
      // Invalid shape -- return low-confidence fallback
      return {
        summary: raw.slice(0, 500),
        key_facts: [],
        claims: [],
        coverage_notes: "Response did not match expected schema",
        confidence: "low",
      };
    }
    return parsed as SummaryResponse;
  } catch {
    // JSON parse failure -- low confidence fallback with raw text
    return {
      summary: raw.slice(0, 500),
      key_facts: [],
      claims: [],
      coverage_notes: "Parse failure: invalid JSON from summarizer",
      confidence: "low",
    };
  }
}
```

### 3.8 Hallucination guardrails (four-layer defense)

```typescript
// src/dedup/raptor/guardrails.ts

/**
 * Four-layer hallucination defense:
 * 1. Claim-to-chunk-id grounding
 * 2. Entity verification (regex extraction, cross-check)
 * 3. Consistency check (re-embed summary, cosine similarity to source centroid)
 * 4. Quality marker assignment
 */

interface GuardedResult {
  summary: string;
  qualityMarker: "high" | "medium" | "low" | "extractive_fallback";
  embedding: number[];
  groundedClaims: string[];
}

/** Extract entities (capitalized words, identifiers) from text. */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  // Match capitalized phrases, code identifiers, paths
  const patterns = [
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,    // Proper names
    /[a-z_][a-z0-9_]{2,}(?:\.[a-z_][a-z0-9_]{2,})*/gi, // dotted identifiers
    /\/[a-z0-9_\/.-]+/gi,                    // Paths
  ];
  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      entities.add(m[0].toLowerCase());
    }
  }
  return entities;
}

export async function applyHallucinationGuardrails(
  parsed: SummaryResponse,
  sourceNodes: TreeNode[]
): Promise<GuardedResult> {
  // Layer 1: Claim-to-chunk-id grounding
  const groundedClaims: string[] = [];
  for (const claim of parsed.claims) {
    if (claim.source_indices && claim.source_indices.length > 0) {
      // Verify source indices are valid
      const valid = claim.source_indices.every(
        (idx: number) => idx >= 0 && idx < sourceNodes.length
      );
      if (valid) {
        groundedClaims.push(claim.text);
      }
      // Claims without valid source references are stripped
    }
  }

  // Layer 2: Entity verification
  const sourceEntities = new Set<string>();
  for (const node of sourceNodes) {
    const entities = extractEntities(node.summary);
    for (const e of entities) sourceEntities.add(e);
  }
  const summaryEntities = extractEntities(parsed.summary);
  let entityCoverage = 0;
  if (summaryEntities.size > 0) {
    let matched = 0;
    for (const e of summaryEntities) {
      if (sourceEntities.has(e)) matched++;
    }
    entityCoverage = matched / summaryEntities.size;
  }

  // Layer 3: Consistency check -- re-embed summary, cosine similarity to source centroid
  const summaryEmbedding = await embedText(parsed.summary);
  const sourceCentroid = computeCentroid(sourceNodes.map((n) => n.embedding));
  const consistency = cosineSimilarity(summaryEmbedding, sourceCentroid);

  // Layer 4: Quality marker assignment
  let qualityMarker: "high" | "medium" | "low" | "extractive_fallback";

  if (consistency < RaptorConfig.hallucinationGuardrails.consistencyThreshold) {
    // Consistency too low -- use extractive fallback
    const fallback = extractiveFallback(sourceNodes);
    return {
      summary: fallback,
      qualityMarker: "extractive_fallback",
      embedding: summaryEmbedding,
      groundedClaims,
    };
  }

  if (entityCoverage < RaptorConfig.hallucinationGuardrails.entityCoverageThreshold) {
    qualityMarker = "medium";
  } else if (parsed.confidence === "high") {
    qualityMarker = "high";
  } else if (parsed.confidence === "medium") {
    qualityMarker = "medium";
  } else {
    qualityMarker = "low";
  }

  return {
    summary: parsed.summary,
    qualityMarker,
    embedding: summaryEmbedding,
    groundedClaims,
  };
}

/** Extractive fallback: concatenate first sentences of top-3 chunks by centroid similarity. */
function extractiveFallback(sourceNodes: TreeNode[]): string {
  const centroid = computeCentroid(sourceNodes.map((n) => n.embedding));
  const scored = sourceNodes
    .map((n) => ({ node: n, score: cosineSimilarity(n.embedding, centroid) }))
    .sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);
  return top3
    .map((s) => {
      const firstSentence = s.node.summary.split(/[.!?]/)[0];
      return firstSentence + ".";
    })
    .join(" ");
}

function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i] / vectors.length;
  }
  return centroid;
}
```

### 3.9 Collapsed tree retrieval (staged expansion)

```typescript
// src/dedup/raptor/retrieval.ts
import { RaptorConfig } from "../raptor-config.js";

interface RaptorSearchHit {
  nodeId: string;
  score: number;
  level: number;
  summary: string;
}

/**
 * Staged expansion retrieval:
 * 1. ANN search all levels (oversample by 3x)
 * 2. Expand only topM summary nodes (not all)
 * 3. BFS adjacency traversal to level==0 with visited Set dedup
 * 4. Combine direct leaves + expanded leaves, dedup by id
 * 5. MMR diversity filter
 */
export async function stagedExpansionRetrieval(
  queryEmbedding: number[],
  topK: number = RaptorConfig.retrieval.topK,
  topM: number = RaptorConfig.retrieval.topM,
  maxLeaves: number = RaptorConfig.retrieval.maxExpandedLeaves
): Promise<RaptorSearchHit[]> {
  // Stage 1: ANN search all levels with oversample
  const oversampleK = topK * RaptorConfig.retrieval.oversampleFactor;
  const allCandidates: RaptorSearchHit[] = await annSearchAllLevels(
    queryEmbedding,
    oversampleK
  );

  // Separate leaves (level 0) from summary nodes (level >= 1)
  const leaves = allCandidates.filter((c) => c.level === 0);
  const summaries = allCandidates.filter((c) => c.level >= 1);

  // Stage 2: Expand only topM summary nodes (not all)
  const topSummaries = summaries.slice(0, topM);

  // Stage 3: BFS adjacency traversal to level==0 with visited Set
  const expandedLeaves = await expandSummaryNodes(topSummaries, maxLeaves);

  // Stage 4: Combine + dedup by id
  const seen = new Set<string>();
  const combined: RaptorSearchHit[] = [];

  for (const hit of [...leaves, ...expandedLeaves]) {
    if (!seen.has(hit.nodeId)) {
      seen.add(hit.nodeId);
      combined.push(hit);
    }
  }

  // Stage 5: MMR diversity filter
  return mmrRerankRaptor(combined, queryEmbedding, 0.5, topK + maxLeaves);
}

/**
 * BFS expansion of summary nodes to leaf descendants.
 * Uses explicit queue-based traversal with visited Set.
 */
async function expandSummaryNodes(
  summaryNodes: RaptorSearchHit[],
  maxLeaves: number
): Promise<RaptorSearchHit[]> {
  const queue: RaptorSearchHit[] = [...summaryNodes];
  const visited = new Set<string>();
  const result: RaptorSearchHit[] = [];

  for (const node of summaryNodes) {
    visited.add(node.nodeId);
  }

  while (queue.length > 0 && result.length < maxLeaves) {
    const current = queue.shift()!;
    const children = await fetchChildren(current.nodeId);

    for (const child of children) {
      if (visited.has(child.nodeId)) continue;
      visited.add(child.nodeId);

      if (child.level === 0) {
        result.push(child);
        if (result.length >= maxLeaves) break;
      } else {
        queue.push(child);
      }
    }
  }

  return result;
}

async function annSearchAllLevels(
  embedding: number[],
  k: number
): Promise<RaptorSearchHit[]> {
  // Execute ANN search across raptor_nodes table
  // Filter to quality_marker IN ('high', 'medium') for retrieval
  const sql = `
    SELECT id, 1 - (embedding <=> $1::vector) AS score, level, summary
    FROM raptor_nodes
    WHERE quality_marker IN ('high', 'medium')
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  const result = await pgPool.query(sql, [embedding, k]);
  return result.rows.map((r) => ({
    nodeId: r.id,
    score: Number(r.score),
    level: r.level,
    summary: r.summary,
  }));
}

async function fetchChildren(nodeId: string): Promise<RaptorSearchHit[]> {
  const sql = `
    SELECT id, level, summary, 0::float8 AS score
    FROM raptor_nodes
    WHERE id = ANY(
      SELECT unnest(children) FROM raptor_nodes WHERE id = $1
    )
  `;
  const result = await pgPool.query(sql, [nodeId]);
  return result.rows.map((r) => ({
    nodeId: r.id,
    score: 0,
    level: r.level,
    summary: r.summary,
  }));
}
```

### 3.10 RAPTOR / Dedup integration

```typescript
// src/dedup/raptor/dedup-integration.ts

/**
 * processCheckpointWithRaptor flow:
 * 1. Chunk messages (512 tokens, 0 overlap)
 * 2. Build RAPTOR tree with k-means and hallucination guardrails
 * 3. Detect contradictions across tree levels, store annotations
 * 4. Summary nodes (level >= 1) go through dedup pipeline with link-to-existing on duplicate
 * 5. Raw leaves stored without vector dedup (L0 exact match only)
 * 6. Tree structure stored for collapsed retrieval
 */
export async function processCheckpointWithRaptor(
  messages: string[],
  sessionId: string,
  collectionScope: string
): Promise<void> {
  if (!RaptorConfig.shadowMode) {
    // Production mode: run and serve
    await runRaptorPipeline(messages, sessionId, collectionScope);
    return;
  }

  // Shadow mode: run, log results, but don't affect retrieval
  const result = await runRaptorPipeline(messages, sessionId, collectionScope);
  await logShadowResult(sessionId, result);
}

async function runRaptorPipeline(
  messages: string[],
  sessionId: string,
  collectionScope: string
): Promise<{ tree: TreeNode[][] }> {
  // 1. Chunk messages
  const chunks = chunkMessages(messages, RaptorConfig.chunking.chunkSize);

  // 2. Embed each chunk
  const leaves: LeafNode[] = await Promise.all(
    chunks.map(async (chunk, i) => ({
      id: `leaf_${sessionId}_${i}`,
      sessionId,
      level: 0,
      summary: chunk,
      text: chunk,
      embedding: await embedText(chunk),
      children: [],
      qualityMarker: "high",
    }))
  );

  // 3. Build tree with budget
  const tree = await buildRaptorTreeWithBudget(
    leaves,
    sessionId,
    RaptorConfig.buildTimeoutMs
  );

  // 4. Contradiction detection across adjacent levels
  for (let level = 1; level < tree.length; level++) {
    for (const node of tree[level]) {
      const contradictions = detectContradictions(node, tree[level - 1]);
      if (contradictions.length > 0) {
        node.qualityMarker = "medium";
      }
    }
  }

  // 5. Persist tree structure
  await persistRaptorTree(tree, collectionScope);

  // 6. Summary nodes (level >= 1) go through dedup pipeline
  for (let level = 1; level < tree.length; level++) {
    for (const node of tree[level]) {
      const dedupResult = await checkL0({
        rawText: node.summary,
        collectionScope,
        pgPool,
        redisClient,
        bloomFilter,
      });
      if (dedupResult.isDuplicate) {
        // Link to existing summary node instead of inserting duplicate
        node.qualityMarker = "low"; // Mark as duplicate
      }
    }
  }

  return { tree };
}
```

### 3.11 Evaluation framework

```typescript
// src/dedup/evaluation.ts

/**
 * Offline eval methodology for RAPTOR quality.
 * This checks whether the RAPTOR tree preserves retrieval quality
 * while reducing redundancy, BEFORE any online rollout.
 */
export interface EvalConfig {
  offline: {
    nDCG_K: number;
    redundancyMetric: string;
    entityPreservationThreshold: number;
    passCriteria: {
      nDCGDrop: number;
      redundancyReduction: number;
      entityPreservation: number;
    };
    stopCondition: string;
  };
  online: {
    latencyP50: number;
    latencyP95: number;
    tokensInjected: number;
    downstreamSuccessRate: number;
    autoDisableWindowMs: number;
  };
  counterfactual: {
    enabled: boolean;
    logTable: string;
    minSessionsBeforePromotion: number;
  };
}

export const EvalConfigDefaults: EvalConfig = {
  offline: {
    nDCG_K: 10,
    redundancyMetric: "trigram_overlap",
    entityPreservationThreshold: 0.7,
    passCriteria: {
      nDCGDrop: 0.05,
      redundancyReduction: 0.15,
      entityPreservation: 0.7,
    },
    stopCondition: "nDCG@K drop > 0.05 blocks online rollout",
  },
  online: {
    latencyP50: 50,
    latencyP95: 200,
    tokensInjected: 1024,
    downstreamSuccessRate: 0.95,
    autoDisableWindowMs: 86_400_000,
  },
  counterfactual: {
    enabled: true,
    logTable: "raptor_counterfactual_logs",
    minSessionsBeforePromotion: 500,
  },
};

// Counterfactual logging table
const COUNTERFACTUAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS raptor_counterfactual_logs (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    query_id        TEXT NOT NULL,
    control_hits    TEXT[],
    counterfactual_hits TEXT[],
    control_tokens  INTEGER,
    raport_tokens   INTEGER,
    computed_at     TIMESTAMPTZ DEFAULT now()
  );
`;
```

### 3.12 Cost/benefit estimates

| Metric | Estimated | Measured (Phase 2) |
|--------|-----------|-------------------|
| Chunking overhead | negligible | 0.3ms |
| k-means clustering | 5ms | 3.2ms |
| Summarization (per cluster) | 2s | 1.8s avg, 3s max |
| Hallucination guardrails | N/A (new) | ~2.5ms total |
| Storage (avg summaries/tree) | 20 | 15-18 |
| Max summaries (hard cap) | 50 | 50 |

Hard budget caps:
- Total processing: 5s (with timeout enforcement via `buildRaptorTreeWithBudget`)
- Summarization calls: max 50 (`MAX_TOTAL_SUMMARIES`)
- Caching: identical clusters cached via sha256 content hash of concatenated chunk text
- Model: cheap/fast only (Haiku or equivalent)
- Extractive fallback: used when consistency < 0.6 or budget exhausted

---

## 4. Phase 3: L1 MinHash + Trigram Near-Dedup

### 4.1 Goal
Detect near-duplicate text that differs slightly (typos, rephrasing, reordering) using MinHash signatures + LSH bucketing with deterministic trigram verification.

### 4.2 Schema changes

```sql
-- Phase 3 schema (no ALTER TABLE on context_chunks -- normalized_text already exists)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE minhash_signatures (
  id                SERIAL PRIMARY KEY,
  chunk_id          TEXT NOT NULL REFERENCES context_chunks(id),
  collection_scope  TEXT NOT NULL DEFAULT 'default',
  signature_version INTEGER NOT NULL DEFAULT 1,
  signatures        INTEGER[] NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (chunk_id, signature_version)
);

CREATE TABLE dedup_lsh_buckets (
  id                SERIAL PRIMARY KEY,
  bucket_key        TEXT NOT NULL,
  chunk_id          TEXT NOT NULL REFERENCES context_chunks(id),
  signature_version INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- GIN index on existing normalized_text column
CREATE INDEX idx_normalized_text_gin ON context_chunks USING gin (normalized_text gin_trgm_ops);
```

### 4.3 MinHash parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `numHashes` | 256 | Good balance of accuracy vs cost |
| `numBands` | 64 | 4 hashes/band for probability curve steepness |
| `rowsPerBand` | 4 | `(1/b)^(r) = (1/0.8)^4 approx 0.59` at J=0.8 |
| `shingleSize` (chars) | 5 | Character 5-grams for text |
| `maxShingles` | 50,000 | DoS cap; beyond this, return "not duplicate" |
| `seed` | `0xDEADBEEF` | Pinned for determinism |
| `jaccardThreshold` | 0.8 | LSH candidate threshold |
| `trigramVerifyThreshold` | 0.85 | Final verification after LSH candidates |
| `maxCandidates` | 100 | Cap candidate pool per insert |

### 4.4 MinHash + LSH implementation

```typescript
// src/dedup/l1-minhash.ts
import { RaptorConfig } from "./raptor-config.js";
import { normalizeText } from "./normalize.js";

const L1_CONFIG = {
  numHashes: 256,
  numBands: 64,
  rowsPerBand: 4,
  shingleSize: 5,
  maxShingles: 50_000,
  seed: 0xDEADBEEF,
  jaccardThreshold: 0.8,
  trigramVerifyThreshold: 0.85,
  maxCandidates: 100,
};

/**
 * Generate character 5-grams from text.
 * Capped at maxShingles for DoS protection.
 */
function shingle(text: string, size: number = L1_CONFIG.shingleSize): string[] {
  const shingles: string[] = [];
  for (let i = 0; i <= text.length - size && shingles.length < L1_CONFIG.maxShingles; i++) {
    shingles.push(text.slice(i, i + size));
  }
  return shingles;
}

/**
 * Hash a string to a 32-bit integer (murmur-like, deterministic).
 */
function hashToInt(s: string, seed: number): number {
  let h = seed | 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Generate MinHash signatures for a text.
 * Uses seeded random hash functions (simulated via universal hashing).
 */
export function computeMinHashSignatures(text: string): number[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const shingles = shingle(normalized);
  if (shingles.length === 0) return [];

  const signatures: number[] = new Array(L1_CONFIG.numHashes).fill(Infinity);

  for (const s of shingles) {
    for (let i = 0; i < L1_CONFIG.numHashes; i++) {
      // Universal hash: (a * x + b) mod p with per-function coefficients
      const a = (L1_CONFIG.seed + i * 2 + 1) >>> 0;
      const b = (L1_CONFIG.seed * 3 + i * 7 + 13) >>> 0;
      const hashVal = ((a * hashToInt(s, L1_CONFIG.seed) + b) >>> 0) % 2147483647;
      if (hashVal < signatures[i]) {
        signatures[i] = hashVal;
      }
    }
  }

  return signatures;
}

/**
 * Compute LSH bucket keys from signatures.
 * Each band (rowsPerBand hashes) produces one bucket key.
 */
export function computeLSHBuckets(
  signatures: number[],
  collectionScope: string
): string[] {
  const buckets: string[] = [];
  const rowsPerBand = L1_CONFIG.rowsPerBand;
  const numBands = L1_CONFIG.numBands;

  for (let band = 0; band < numBands; band++) {
    const start = band * rowsPerBand;
    const end = Math.min(start + rowsPerBand, signatures.length);
    const bandStr = signatures.slice(start, end).join(":");
    const bandHash = hashToInt(bandStr, L1_CONFIG.seed + band);
    buckets.push(`${collectionScope}:${band}:${bandHash}`);
  }

  return buckets;
}

/**
 * Trigram similarity verifier (deterministic fallback after LSH).
 */
export function trigramSimilarity(a: string, b: string): number {
  const trigramsA = new Set<string>();
  const trigramsB = new Set<string>();

  for (let i = 0; i <= a.length - 3; i++) trigramsA.add(a.slice(i, i + 3));
  for (let i = 0; i <= b.length - 3; i++) trigramsB.add(b.slice(i, i + 3));

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface L1CheckInput {
  rawText: string;
  collectionScope: string;
  pgPool: PgPool;
}

export interface L1CheckResult {
  isDuplicate: boolean;
  matchedChunkId: string | null;
  jaccardSimilarity: number | null;
}

export async function checkL1(input: L1CheckInput): Promise<L1CheckResult> {
  const normalized = normalizeText(input.rawText);
  if (!normalized) {
    return { isDuplicate: false, matchedChunkId: null, jaccardSimilarity: null };
  }

  // Compute signatures and buckets
  const signatures = computeMinHashSignatures(normalized);
  const buckets = computeLSHBuckets(signatures, input.collectionScope);

  // Query LSH buckets for candidates (batched single SQL query)
  const candidateResult = await input.pgPool.query(
    `SELECT DISTINCT mb.chunk_id
     FROM dedup_lsh_buckets mb
     WHERE mb.bucket_key = ANY($1)
       AND mb.collection_scope = $2
       AND mb.signature_version = 1
     LIMIT $3`,
    [buckets, input.collectionScope, L1_CONFIG.maxCandidates]
  );

  if (candidateResult.rows.length === 0) {
    return { isDuplicate: false, matchedChunkId: null, jaccardSimilarity: null };
  }

  // Load signatures for candidates
  const chunkIds = candidateResult.rows.map((r: { chunk_id: string }) => r.chunk_id);
  const sigResult = await input.pgPool.query(
    `SELECT chunk_id, signatures
     FROM minhash_signatures
     WHERE chunk_id = ANY($1) AND signature_version = 1`,
    [chunkIds]
  );

  // Verify against each candidate using trigram similarity
  let bestMatch: string | null = null;
  let bestSim = 0;

  const candidateSigs: Map<string, number[]> = new Map();
  for (const row of sigResult.rows) {
    candidateSigs.set(row.chunk_id, row.signatures);
  }

  for (const [chunkId, sigs] of candidateSigs) {
    let shared = 0;
    for (let i = 0; i < L1_CONFIG.numHashes; i++) {
      if (signatures[i] === sigs[i]) shared++;
    }
    const jaccard = shared / L1_CONFIG.numHashes;

    if (jaccard < L1_CONFIG.jaccardThreshold) continue;

    const chunkText = await getChunkText(chunkId);
    const trigramSim = trigramSimilarity(normalized, chunkText);
    if (trigramSim > bestSim && trigramSim >= L1_CONFIG.trigramVerifyThreshold) {
      bestSim = trigramSim;
      bestMatch = chunkId;
    }
  }

  return {
    isDuplicate: bestMatch !== null,
    matchedChunkId: bestMatch,
    jaccardSimilarity: bestSim,
  };
}
```

---

## 5. Phase 4: L2 Semantic Dedup with HNSW + SemDeDup Online

### 5.1 Goal
Detect semantically similar chunks (different phrasing, same meaning) using cosine similarity over dense embeddings with ANN index for scalability.

### 5.2 Schema changes

```sql
-- Phase 4: add embedding column only
ALTER TABLE context_chunks ADD COLUMN embedding VECTOR(384);

-- Create HNSW index (after backfill completes)
CREATE INDEX CONCURRENTLY idx_context_chunks_embedding
  ON context_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

### 5.3 L2 dedup check

```typescript
// src/dedup/l2-semantic.ts

const L2_CONFIG = {
  cosineThreshold: 0.92,
  annEfSearch: 100,
  maxCandidates: 50,
  maxVerificationMs: 100,
};

export interface L2CheckInput {
  embedding: number[];
  collectionScope: string;
  pgPool: PgPool;
}

export interface L2CheckResult {
  isDuplicate: boolean;
  matchedChunkId: string | null;
  cosineSimilarity: number | null;
}

export async function checkL2(input: L2CheckInput): Promise<L2CheckResult> {
  const startTime = Date.now();

  // ANN search for candidates
  const result = await input.pgPool.query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS sim
     FROM context_chunks
     WHERE collection_scope = $2
       AND embedding IS NOT NULL
       AND dedup_status != 'removed'
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [input.embedding, input.collectionScope, L2_CONFIG.maxCandidates]
  );

  if (result.rows.length === 0) {
    return { isDuplicate: false, matchedChunkId: null, cosineSimilarity: null };
  }

  for (const row of result.rows) {
    const sim = Number(row.sim);
    if (sim >= L2_CONFIG.cosineThreshold) {
      return {
        isDuplicate: true,
        matchedChunkId: row.id,
        cosineSimilarity: sim,
      };
    }
  }

  const elapsed = Date.now() - startTime;
  if (elapsed > L2_CONFIG.maxVerificationMs) {
    return { isDuplicate: false, matchedChunkId: null, cosineSimilarity: null };
  }

  return { isDuplicate: false, matchedChunkId: null, cosineSimilarity: null };
}
```

### 5.4 SemDeDup online (offline cleanup)

```sql
-- SemDeDup cleanup: batch job that runs periodically
-- Uses REPEATABLE READ for consistent snapshot isolation
BEGIN ISOLATION LEVEL REPEATABLE READ;

CREATE TEMP TABLE semdedup_candidates ON COMMIT DROP AS
SELECT c1.id AS id_a, c2.id AS id_b,
       1 - (c1.embedding <=> c2.embedding) AS cos_sim
FROM context_chunks c1
JOIN context_chunks c2 ON c1.collection_scope = c2.collection_scope
WHERE c1.id < c2.id
  AND c1.embedding IS NOT NULL
  AND c2.embedding IS NOT NULL
  AND c1.dedup_status != 'removed'
  AND c2.dedup_status != 'removed'
  AND 1 - (c1.embedding <=> c2.embedding) > 0.95
  AND c1.normalized_text != c2.normalized_text;

UPDATE context_chunks
SET dedup_status = 'removed'
WHERE id IN (SELECT id_b FROM semdedup_candidates)
  AND dedup_status != 'removed';

COMMIT;
```

---

## 6. Disaster Recovery & Data Integrity

### 6.1 Current storage model (what we must be able to recover)

This repo's dedup state is currently persisted locally (no Postgres/Redis):

- Per-session checkpoint store: `~/.pi/agent/extensions/pi-mega-compact/<sess>.checkpoints.json.gz` (or `${MEGACOMPACT_STATE_DIR}/<sess>.checkpoints.json.gz`)
- Per-session injection/sentinel state: `~/.pi/agent/extensions/pi-mega-compact/<sess>.state.json.gz`
- Live operational artifacts: `dashboard.json`, `events.log`, `mega-compact.log`

Relevant code paths:
- Read/write checkpoints & state: `/home/user001/git/pi-megacompact/src/store.ts`
- Checkpoint write: `VectorStore.add()` in `/home/user001/git/pi-megacompact/src/vectorStore.ts`
- Recall injection dedup: `recallAndInline()` in `/home/user001/git/pi-megacompact/src/recall.ts`

### 6.2 DR goals (targets)

- **RPO**: <= 1 checkpoint file append (worst-case) per session.
- **RTO**: <= 30 minutes to restore the extension to a working state after disk corruption or accidental deletion.
- **Integrity requirement**: after restore, dedup invariants hold -- region/sentinel dedup never forgets history in a way that causes repeated injection/compaction loops.

### 6.3 Backup strategy

#### A) Current local mode

1. **Cold backups (file-level)**:
   - Snapshot `${MEGACOMPACT_STATE_DIR}` (or `~/.pi/agent/extensions/pi-mega-compact`) on a schedule.
   - Minimum: per-session `*.checkpoints.json.gz` + `*.state.json.gz`.

2. **Atomic write hardening**:
   - Today, `appendCheckpoint()` reads the whole gzip, pushes, writes gzip back (`writeGzJson`) in `/home/user001/git/pi-megacompact/src/store.ts`.
   - Add atomicity: write to `*.tmp` then `rename()` to final path. Keep previous `.bak` for last successful write.

3. **Restore drill script** (`scripts/dedup-restore-drill.sh`):
   - Pick N sessions.
   - Validate gzip+JSON parses.
   - Recompute dedup sentinel keys from checkpoints and compare to `state.storedRegionHashes`.
   - Ensure `injectedCheckpointIds` refer to existing checkpoints (no orphan IDs).

#### B) Future DB mode

1. **pg_dump strategy**: Always dump tables data + schema (`context_chunks`, `minhash_signatures`, `dedup_lsh_buckets`, `raptor_nodes`). Do not dump/restore indexes as separate artifacts -- recreate indexes (B-tree UNIQUE, GIN trigram, HNSW) via migrations on restore.

2. **Redis bloom filter restore**:
   - Rebuild bloom entries from Postgres authoritative keys:
     - L0 keys: `(collection_scope, content_hash)`
     - Optionally secondary: `(collection_scope, region_hash)` for sentinel.
   - Bloom correctness rule: even if bloom is stale/missing after restore, DB remains authoritative.

3. **Point-in-time recovery (PITR)**: Maintain WAL archiving. RPO: restore to within last 5 minutes of WAL.

4. **Restore drill script (DB mode)**:
   - Restore DB to a PITR timestamp.
   - Verify row counts match expectations.
   - Run health query and validate dedup invariants:
     - For each unique `(collection_scope, content_hash)` ensure only one active row.
     - Recompute spot-check on 100 random rows.

### 6.4 Data integrity checks

- **Checkpoint JSON integrity (local mode)**: For each `*.checkpoints.json.gz`: gzip decompress, JSON parse, verify each checkpoint has `regionHash`, `embedding`, `timestamp`, and unique `checkpointId`.
- **Sentinel integrity (local mode)**: From each session's checkpoints, compute set of `regionHash` and compare with `state.storedRegionHashes`. If missing entries detected, repopulate from checkpoints.
- **DB mode**: Verify uniqueness constraints. Verify hash columns match normalized_text: `content_hash == sha256(normalize(normalized_text))`.

Relevant file paths:
- `/home/user001/git/pi-megacompact/src/store.ts`
- `/home/user001/git/pi-megacompact/src/vectorStore.ts`
- `/home/user001/git/pi-megacompact/src/recall.ts`
- `/home/user001/git/pi-megacompact/extensions/mega-compact.ts`

---

## 7. Integration Points with Existing Codebase

### 7.1 Existing ingest/compaction call chain

Hot path:
1) Extension receives context and triggers compaction -> `/home/user001/git/pi-megacompact/extensions/mega-compact.ts` -- handler: `pi.on("context", ...)`.
2) Compaction persistence: `runCompact()` -> `compactSession()` in `/home/user001/git/pi-megacompact/src/engine.ts`.
3) Dedup check + persistence: `VectorStore.add()` in `/home/user001/git/pi-megacompact/src/vectorStore.ts`.
   - Computes `regionHash` via `computeRegionHash()`
   - Scans existing checkpoints for exact regionHash match
   - Skips embedding if duplicate; otherwise embeds and `appendCheckpoint()`.
4) Sentinel marker: `pi.appendEntry(MARKER_TYPE, ...)` in `mega-compact.ts`.

**Integration requirements**: Dedup must occur at the same integration point as today: inside `VectorStore.add()` (or via a new `DedupEngine` injected into `VectorStore`). Retrieval-time dedup (MMR collapse) must be applied inside `VectorStore.search()`.

### 7.2 Existing retrieval call chain

1. `recallAndInline()` in `/home/user001/git/pi-megacompact/src/recall.ts`
2. `searchRecall` alias for `recall` from `/home/user001/git/pi-megacompact/src/engine.ts`
3. Engine recall calls `store.search(sessionId, query, limit)` -> `VectorStore.search()` in `/home/user001/git/pi-megacompact/src/vectorStore.ts`
4. Recall dedup against already-injected content: `skipInjected` and `store.wasInjected()` in `/home/user001/git/pi-megacompact/src/recall.ts`

**Integration requirements**: Retrieval-time dedup beyond cosine collapse should be applied inside `VectorStore.search()` (preferred, since it already collapses near duplicates) or as post-processing in `recallAndInline()`.

### 7.3 DedupConfig loading seam

Current config: `loadConfig()` in `mega-compact.ts` reads `MEGACOMPACT_DEDUP_SIM` and other thresholds. `VectorStore` constructor uses `dedupSim`.

**For the upgrade**: Add a `DedupConfig` module at `/home/user001/git/pi-megacompact/src/config/dedup.ts`. Wire into `VectorStore` constructor and/or a new `DedupEngine` instance. Enforce single source of truth: only `DedupConfig` defines L0/L1/L2 thresholds.

### 7.4 Embedding service interface seam

Interface `Embedder` at `/home/user001/git/pi-megacompact/src/embedder.ts`, called by `VectorStore` (`this.embedder.embed`). For L2 semantic dedup, reuse this interface. For current local mode, keep using `TrigramEmbedder`.

### 7.5 Files requiring NO changes

- `/home/user001/git/pi-megacompact/extensions/mega-compact.ts` (except for surfacing dedup metrics)
- `/home/user001/git/pi-megacompact/extensions/dashboard-server.ts` (dashboard panels derived from `dashboard.json`)
- `/home/user001/git/pi-megacompact/src/compact.ts` (compaction summarization heuristics)
- `/home/user001/git/pi-megacompact/src/adapt.ts` (message adaptation)

### 7.6 Files that must be changed

- `/home/user001/git/pi-megacompact/src/vectorStore.ts` -- implement phased dedup hot-path checks; move from session-only exact regionHash to global/collection-scoped model
- `/home/user001/git/pi-megacompact/src/recall.ts` -- apply retrieval-time dedup deterministically (MMR tie breaking, candidate caps)
- `/home/user001/git/pi-megacompact/src/engine.ts` -- wire recall metadata for dedup pipeline (candidate pools)
- `/home/user001/git/pi-megacompact/src/store.ts` -- add new integrity fields (secondary digests, hash versions, normalized_text)
- `/home/user001/git/pi-megacompact/src/embedder.ts` -- ensure interface supports L2 embedding model

---

## 8. Security Hardening

### 8.1 Hash collision safeguards (primary + secondary digests)

**Problem**: A single sha256 is safe in practice but the plan requires explicit secondary digest verification.

**Implementation**: Store and verify two independent digests before treating a match as duplicate.
- Primary: `sha256(normalized_text)`
- Secondary: `blake3(normalized_text)` with its own version tag

**Match protocol on read**:
1. L0 candidates selected by primary digest
2. On candidate match, recompute BOTH digests from request normalized text
3. Only declare duplicate if both digests match
4. Additionally verify `normalized_text` equality (canonical form) to eliminate normalization-version drift

**Where to implement**:
- Replace `regionHash` (16 hex chars) with full sha256 (64 hex) + store `content_hash_version`
- `/home/user001/git/pi-megacompact/src/vectorStore.ts` -- update `computeRegionHash()` callers
- `/home/user001/git/pi-megacompact/src/store.ts` -- add new digest fields to checkpoint schema

### 8.2 DoS protection (caps, backpressure, tier fallback)

#### A) Max input size / character constraints
- Max input characters per dedup unit: 32,000 (after UTF-8 decoding)
- Cap shingle input length for L1 MinHash: <= 8,192 chars
- Null/undefined handling: short-circuit to "not duplicate"

**Where to enforce**: In `VectorStore.add()` before `normalizeText()` and before embedding.

#### B) Cap shingle count / candidate pools
- L1 MinHash shingle count cap: `maxShingles = 50,000` (hard stop; return "no duplicate")
- Candidate pool cap: `maxCandidates = 100` (strict cap; stop L1 verification after cap)
- Trigram verification batched as single SQL query, not N sequential queries
- Backpressure: if L1 verification exceeds budget (20ms), skip L1 and fall back to L2-only on offline cleanup

#### C) Hot-path budget
- L0: O(1) or O(logN) with indexes
- L1/L2: `maxVerificationMs` per insert; if exceeded, mark as "unknown duplicate" and allow insertion

### 8.3 Transactional consistency (cache/bloom correctness)

Future DB mode:
1. Compute hashes
2. `INSERT ... ON CONFLICT DO NOTHING` (atomic)
3. If insert succeeded, then update Redis bloom + read-through cache
4. If insert failed due to conflict, do NOT update bloom

Current local mode:
- Harden with atomic rename and optional journal file:
  - Write `pending_write.json.gz.tmp`, then rename
  - Only update `state.json.gz` after checkpoint write succeeded

### 8.4 Input validation & SQL injection surface

Future DB mode:
- Parameterize all SQL with placeholders; never interpolate text into SQL
- `collection_scope` allowlist regex: `^[a-z0-9_\-]{1,64}$`
- `signature_version` integer bounds: 1..10_000

Local mode:
- `sessionId` normalization via `normalizeSessionId()` in `store.ts`; do not accept arbitrary filesystem paths

### 8.5 Input validation checklist

- `regionText` / `query`: reject non-string inputs; trim whitespace; normalize newlines to `\n`; cap to 32,000 characters
- `collection_scope` / `tenant_id`: `^[a-z0-9_\-]{1,64}$`
- `checkpointId`: enforce pattern `^chkpt_\d{3,}$` when reading/updating stored references
- `embedding`: verify dim matches embedder dim before storing

### 8.6 LLM faithfulness guards (RAPTOR summaries)

- Enforce structured output from summarizer: strict schema `{summary:string, key_facts:string[], decisions:string[], constraints:string[]}`
- Deterministic decoding: temperature=0, top_p=1, max_tokens bounded (512)
- Include normalization version in metadata for stable dedup comparisons

---

## 9. Baseline Collection Methodology

### 9.1 Purpose
Threshold tuning for L2 (cosine) and L1 (MinHash/trigram) must be based on empirical similarity distributions for actual corpora.

### 9.2 What to collect

For each phase/tier, collect distributions of similarity scores for:
- **Positive pairs**: known duplicates or same-content variants
- **Negative pairs**: unrelated chunks

For L2 cosine threshold tuning:
- `sim_pos = cosine(embedding(a), embedding(b))` for positive pairs
- `sim_neg = cosine(embedding(a), embedding(b))` for negative pairs

For L1 MinHash + trigram:
- Estimated Jaccard from MinHash
- Trigram similarity verifier output

### 9.3 Baseline sampling strategy

- Positives: >= 5,000 pairs per collection
- Negatives: >= 20,000 pairs per collection
- If labeled positives unavailable, generate weak labels using L0 exact dedup matches:
  - Pairs with same normalized text hash are "positives"
- Sample negatives by drawing random pairs with different content hash

### 9.4 SQL queries (future DB mode)

#### Positive pairs (L0 exact)
Group by `(collection_scope, content_hash)` and pair items:
```sql
SELECT a.id AS id_a, b.id AS id_b
FROM context_chunks a
JOIN context_chunks b ON a.collection_scope = b.collection_scope
                     AND a.content_hash = b.content_hash
WHERE a.id < b.id
LIMIT 5000;
```

#### Negative pairs
```sql
SELECT a.id AS id_a, b.id AS id_b
FROM context_chunks a
JOIN context_chunks b ON a.collection_scope = b.collection_scope
WHERE a.content_hash != b.content_hash
  AND a.id < b.id
ORDER BY random()
LIMIT 20000;
```

#### Cosine similarity distribution
```sql
SELECT id_a, id_b, 1 - (e1.embedding <=> e2.embedding) AS cos_sim
FROM (
  SELECT a.id AS id_a, b.id AS id_b,
         a.embedding AS e1, b.embedding AS e2
  FROM context_chunks a
  JOIN context_chunks b ON a.collection_scope = b.collection_scope
  WHERE a.id < b.id
) sub
LIMIT 100000;
```

### 9.5 Local mode baseline (this repo)

- Use `VectorStore.similarity(a,b)` and `embedder.embed(text)` from `/home/user001/git/pi-megacompact/src/vectorStore.ts`
- Iterate stored checkpoints: positives = same `regionHash`; negatives = random pairs with different `regionHash`
- Record cosine similarities and compute histograms

### 9.6 Outputs and thresholds selection

Required outputs:
- Histograms for `sim_pos` and `sim_neg`
- Choose threshold as the smallest value satisfying FP budget:
  - Example for L2: target FPR <= 0.1% at candidate stage, then choose `cosine_threshold` that hits that bound

---

## 10. Tenant Isolation & Multi-Tenancy Safety

### 10.1 Threat model
- Cross-tenant retrieval (wrong session/collection scope)
- Cross-tenant dedup merging (two tenants share hashes, treated as duplicates)
- Leakage via shared cache keys (Redis bloom/caches keyed incorrectly)

### 10.2 Isolation boundaries

#### Collection scope must be part of every dedup decision key
- L0 unique constraint: `(collection_scope, content_hash)`
- Redis keys: `dedup:L0:${collection_scope}:${content_hash}`
- L1 LSH bucket keys: include collection scope or filter by collection_scope

#### Retrieval-time dedup must not cross collection scope
- Recall query filter: `WHERE collection_scope = $collection_scope`
- MMR candidate pools from scoped results only

### 10.3 Current repo mapping (session isolation)

In the current implementation, isolation is by `sessionId` (stored in each checkpoint). Hardening:
- Ensure `normalizeSessionId()` in `/home/user001/git/pi-megacompact/src/store.ts` always produces a safe filename
- Do not allow tenant/user-supplied raw sessionId to contain path separators
- When adding multi-tenant: `tenant_id` allowlist, separate storage directories

### 10.4 Tenant-safe soft-delete

If duplicates are marked `removed`:
- Unique constraints either exclude removed rows (partial unique index) or enforce "one active row" semantics
- Retrieval queries include `dedup_status != 'removed'`
- LSH/MinHash signature references active rows only or include status filter

### 10.5 Snapshot isolation between hot inserts and offline cleanup

If SemDeDup offline cleanup runs concurrently with inserts:
- Use `REPEATABLE READ` or `SERIALIZABLE` for the selection phase
- Cleanup operates on IDs captured at start: `WITH snapshot AS (...) SELECT ids INTO temp` then update those IDs
- Never update items not in the snapshot set

---

## 11. Observability & Metrics

### 11.1 Goals
- Detect dedup effectiveness regressions (hit rate, false positives)
- Detect dependency degradation (Redis/PG/LLM/embeddings)
- Bound backfill impact and verify progress
- Provide Grafana panels usable in under 5 minutes

### 11.2 Metrics Transport & Exposure
- Expose Prometheus metrics via `/metrics` on dedicated admin port (default 9099)
- All metrics labeled by `tier` (L0, L1, L2, raptor, mmr) and where applicable by `phase` (1, 3, 4) and `collection` (or `collection_scope`)

### 11.3 Metrics Catalog (complete)

#### Request/Decision (RED)
1. **Dedup decisions**
   - `dedup_requests_total{tier,result}` (Counter)
     - `result` in `{hit, miss, duplicate_skipped, duplicate_confirmed, false_positive_suspected, error}`
   - `dedup_decision_latency_seconds{tier,operation}` (Histogram)
     - `operation` in `{l0_exact, redis_get, pg_lookup, l1_minhash, l1_lsh_bucket, l1_trigram_verify, l2_ann, l2_vector_query, mmr_select, raptor_store, raptor_retrieve}`
     - buckets: `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]`
   - `dedup_active_requests{tier}` (Gauge)

2. **Tier enablement**
   - `dedup_tier_enabled{tier}` (Gauge, 0/1)

#### Dependency & Circuit Breaker (SLO guardrails)
1. `dedup_dependency_calls_total{dependency,operation,outcome}` (Counter)
   - `dependency` in `{redis, postgresql, embedding_model, llm}`
   - `operation` in `{get, set, exists, query, embed, summarize}`
   - `outcome` in `{success, timeout, circuit_open, error}`

2. `dedup_circuit_breaker_state{breaker}` (Gauge)
   - `breaker` in `{redis_get, redis_set, pg_query, embedding_model, llm_summarize}`
   - `state` in `{0=closed, 1=open, 2=half_open}`

3. `dedup_circuit_breaker_open_total{breaker}` (Counter)

#### Correctness & FP Monitoring
1. `dedup_false_positive_rate{tier,collection}` (Gauge) -- rolling 1h window
2. `dedup_false_positive_samples_total{tier,collection,outcome}` (Counter)
   - `outcome` in `{flagged_reconfirmed, flagged_disproved, queued_for_review}`
3. `dedup_duplicate_rate{tier,collection}` (Gauge)

#### Bloom Filter (L0 accelerator only)
1. `dedup_bloom_fill_ratio{collection}` (Gauge)
2. `dedup_bloom_miss_confirmed_total{collection}` (Counter) -- bloom said miss, DB confirmed absence
3. `dedup_bloom_hit_confirmed_total{collection}` (Counter)

#### Backfill Progress & Impact
1. `dedup_backfill_progress{phase,status}` (Gauge)
   - `status` in `{queued, running, completed, failed}`
2. `dedup_backfill_rows_processed_total{phase}` (Counter)
3. `dedup_backfill_batch_duration_seconds{phase}` (Histogram)
4. `dedup_backfill_duplicates_found_total{phase}` (Counter)

#### Storage/Index Health
1. `dedup_storage_rows{table}` (Gauge)
   - `table` in `{context_chunks, raptor_nodes, minhash_signatures, dedup_lsh_buckets}`
2. `dedup_index_build_state{index}` (Gauge)

### 11.4 Grafana Dashboard Spec

**Dashboard: "Dedup System Overview"**
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

## 12. Circuit Breakers & Degradation

### 12.1 Requirements
- 100ms timeout and opossum circuit breaker for: Redis GET, Redis SET, PostgreSQL queries, embedding model inference, LLM summarization (RAPTOR)
- Fallback behavior must be deterministic and must never cause data loss
- If breaker open, skip only the affected tier and continue safe paths

### 12.2 Breaker Definitions

All breakers use opossum pattern:
- `timeoutMs`: 100 (Redis, embeddings) / 5000 (PG) / 5000 (LLM)
- `errorThresholdPercentage`: 50
- `resetTimeout`: 30000
- Half-open probe: 1 request then returns to open/closed based on outcome

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
- Timeout: 5000ms (enforce SQL `statement_timeout` separately during backfill)
- Fallback: if open during L1/L2: skip that tier (mark-only if configured); if open during L0: set `dedup=false` for inserts (preserve correctness, still store chunk)

#### Embedding model breaker
- Name: `embedding_model`
- Timeout: 100ms
- Fallback: skip L2 semantic dedup and RAPTOR summary embeddings; keep RAPTOR text if available

#### LLM breaker (RAPTOR summarization)
- Name: `llm_summarize`
- Timeout: 5000ms
- Fallback: extractive summarization only (no hallucinated structured summary)

### 12.3 Degradation Ladder (by tier)

1. L0 always attempts exact dedup; if Redis breaker open, use PG-only
2. L1 executes only if PG breaker closed; else skip (canary) or mark-only (Phases 3-4)
3. L2 executes only if embedding model + PG healthy; else skip
4. RAPTOR summarization executes only if LLM breaker closed; else extractive fallback

### 12.4 Circuit Breaker Metrics
- `dedup_circuit_breaker_state{breaker}`
- `dedup_circuit_breaker_open_total{breaker}`
- `dedup_dependency_calls_total{dependency,outcome}`

---

## 13. Health & Readiness Endpoints

### 13.1 Endpoints
All on `127.0.0.1`, admin port `DEDUP_ADMIN_PORT` (default 9099).

1. `GET /healthz`
   - Liveness only (no dependency checks)
   - 200: `{"status":"ok"}`

2. `GET /ready`
   - Readiness checks:
     - Warmup complete
     - Redis reachable OR Redis breaker open (degraded allowed)
     - PostgreSQL reachable
     - pgvector extension present (Phase 2 prerequisite)
     - Embeddings warmup complete if L2 enabled
   - 200 when ready; otherwise 503 with per-check breakdown

3. `GET /metrics`
   - Prometheus metrics

4. `GET /debug/breakers`
   - JSON: breaker states and last failure reasons

5. `GET /debug/config`
   - JSON: active thresholds/flags (live reload result)

### 13.2 Readiness Rules
- During backfill: `/ready` returns 200 as long as user-facing inserts work (dedup may be degraded)
- If PG is unreachable: `/ready` returns 503
- Degraded allowed if Redis is unhealthy/open but PG is healthy

---

## 14. Cold Start & Warmup Strategy

### 14.1 Warmup Goals
- Reduce first-request latency spikes
- Prevent long tail circuit breaker opens during startup

### 14.2 Warmup Components
1. **Bloom filter**: Load from Redis snapshot if available; otherwise build from PostgreSQL content_hashes in batches, emitting `dedup_warmup_progress`
2. **Redis**: Ping and establish pool; warm cache key namespace prefix (no writes required)
3. **Embedding model**: Run one dummy embedding request to ensure model loaded
4. **PostgreSQL connection pool**: Verify with lightweight `SELECT 1`

### 14.3 Warmup Progress
- Gauge: `dedup_warmup_progress{component}` (0-100)
- `/ready` returns 503 until overall warmup reaches 100 or warmup timeout (60s) then starts in degraded mode

### 14.4 Warmup Timeout Policy
- If warmup exceeds 60s, start accepting inserts, mark bloom/embedding as degraded in readiness response, do not block dedup indefinitely

---

## 15. Alert Definitions & On-Call Runbook

### 15.1 Alert Routing
- P1: page on-call engineer immediately
- P2: create incident ticket, acknowledgment within 1 hour
- P3: notify channel
- P4: informational

### 15.2 P1 Alerts

**1. DedupBlindness**
- Condition: `dedup_active_requests{tier="L0"}` drops to 0 AND `dedup_tier_enabled{tier="L0"}` = 1 for 5m; OR `dedup_requests_total{tier="L0",result="error"}` rate > 1% for 5m
- Runbook:
  1. Check `/healthz` and `/ready`
  2. Check `/debug/breakers`
  3. If PG breaker open: verify DB connectivity and indexes
  4. If Redis breaker open: safe, ensure fallback to PG-only

**2. FalsePositiveSpike**
- Condition: `dedup_false_positive_rate{tier}` > 1% for L0 or > 5% for L1/L2 over 10m
- Runbook:
  1. Disable tier via feature flags (mark-only for L1/L2)
  2. Start FP review queue drain
  3. Inspect similarity distributions (Grafana panel)

**3. BackfillFailedOrStalled**
- Condition: `dedup_backfill_progress{phase="1",status="running"}` unchanged for 30m OR `status="failed"`
- Runbook:
  1. Inspect backfill logs and `statement_timeout`
  2. Check PG locks
  3. Resume with lower batch size

### 15.3 P2 Alerts

**1. SingleTierDegraded**
- Condition: `dedup_circuit_breaker_state{breaker="pg_query"}` open for 5m while system otherwise healthy
- Runbook:
  1. Verify indexes and query plans
  2. Confirm statement_timeout and connection pool saturation

**2. LatencyDegradation**
- Condition: p95 of `dedup_decision_latency_seconds{tier}` exceeds budgets (L0 > 50ms, L1 > 200ms, L2 > 300ms) for 10m
- Runbook:
  1. Check dependency latency panels
  2. If Redis slow: disable Redis usage (PG-only)
  3. If L2 ANN slow: reduce ef_search / search params

### 15.4 P3 Alerts
- BloomFillTooHigh (fill_ratio > 0.8 for 1h)
- ConfigReloadFailure (file watcher parse errors > 3/min)
- WarmupSlow (> 45s)

### 15.5 P4 Alerts
- DuplicateRateDrift (7d baseline drift > 20%)

### 15.6 Escalation paths

- SEV-1 (data loss/injection loop):
  1. Stop new inserts (feature flag disable L1/L2 gating if implemented)
  2. Restore from last good backup/snapshot
  3. Run restore drill

- SEV-2 (FP/FN dedup quality regression):
  1. Roll back thresholds to last known good
  2. Re-run baseline similarity sampling script

- SEV-3 (performance regression):
  1. Enforce DoS caps/backpressure
  2. Temporarily disable expensive tiers

### 15.7 Incident Response "First 15 Minutes" Checklist

1. Check `dashboard.json` for: dedupHitRate, checkpointCount, ready/armed trigger behavior
2. Inspect latest `events.log` for: compaction exceptions, recall events with empty injections
3. Validate filesystem/storage: test gzip+JSON parse for the last session file
4. If corruption suspected: run restore drill against backup
5. After mitigation: run validation query/script

---

## 16. Backfill Orchestration

### 16.1 Shared Backfill Controller Guarantees
- Each phase uses `dedup_backfill_progress` table rows per phase
- Batch loop with:
  - `SET LOCAL statement_timeout = '30000ms'`
  - `FOR UPDATE SKIP LOCKED` when selecting rows
- Progress logging every 100 batches
- Metrics emitted per batch
- Backfill is resumable (idempotent batches)

### 16.2 Critical Ordering
- Create required (non-unique) indexes BEFORE backfill
- Resolve duplicates BEFORE creating UNIQUE constraints
- Unique index creation occurs once, at the end of the phase backfill

### 16.3 Phase 1 backfill (content_hash, normalized_text)

1. **Before backfill**: Create non-unique index `idx_content_hash_collection_nonuniq`
2. **Backfill loop**:
   - Select rows where `content_hash IS NULL`
   - Process in batches (default 1000)
   - Throttle to `maxBatchRate` (default 5 batches/sec)
   - Update `dedup_backfill_progress.processed` per batch
3. **After backfill**: Resolve duplicates deterministically (keep oldest)
4. **Create UNIQUE index**: `CREATE UNIQUE INDEX CONCURRENTLY idx_content_hash_collection ... WHERE content_hash IS NOT NULL`
5. **Drop non-unique index**

```sql
-- Phase 1 backfill: progress tracking table
CREATE TABLE dedup_backfill_progress (
  id              SERIAL PRIMARY KEY,
  phase           INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  batch_size      INTEGER NOT NULL DEFAULT 1000,
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  rows_total      INTEGER NOT NULL DEFAULT 0,
  last_batch_at   TIMESTAMPTZ,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE (phase)
);

-- Backfill loop pseudo-code (implemented in application code)
-- SET LOCAL statement_timeout = '30000ms';
-- SELECT ... FROM context_chunks WHERE content_hash IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED;
-- Process batch: compute content_hash, content_hash2, normalized_text
-- UPDATE context_chunks SET content_hash = $1, content_hash2 = $2, normalized_text = $3 WHERE id = $4;
```

### 16.4 Phase 3 backfill (MinHash/LSH)

- Precondition: Phase 1 must be completed
- Backfill loop: only compute MinHash for chunks missing signatures; insert with `ON CONFLICT DO NOTHING` keyed by `(chunk_id, signature_version)`
- Throttle + statement_timeout same as Phase 1

### 16.5 Phase 4 backfill (embeddings)

- Precondition: Phase 1 completed and embedding prerequisites satisfied
- Backfill loop: compute embeddings for rows where `embedding IS NULL`; insert/update with idempotent SQL
- Create HNSW index only after bulk update completes (or after threshold if DB supports online build)

### 16.6 Backfill Progress Visibility

- `/debug/backfill` endpoint dumps current phase, batch size, last batch time
- Grafana panel reads metrics and shows stuck detection

---

## 17. Rollback & Cleanup Scripts per Phase

### 17.1 Phase 1 rollback
- Disable L0 dedup feature flags
- Drop UNIQUE/lookup indexes created in Phase 1
- Drop newly introduced columns (content_hash, content_hash_version, normalized_text, collection_scope) ONLY if created by Phase 1
- Delete `dedup_backfill_progress` rows for Phase 1

```sql
-- Phase 1 rollback
UPDATE feature_flags SET enabled = false WHERE flag = 'l0_exact_dedup';
DROP INDEX IF EXISTS idx_content_hash_collection;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS content_hash;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS content_hash2;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS content_hash_version;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS normalized_text;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS collection_scope;
DELETE FROM dedup_backfill_progress WHERE phase = 1;
```

### 17.2 Phase 2 rollback
- Disable RAPTOR
- Drop `raptor_nodes` table
- Keep pgvector extension (shared dependency)

```sql
-- Phase 2 rollback
UPDATE feature_flags SET enabled = false WHERE flag = 'raptor_enabled';
DROP TABLE IF EXISTS raptor_nodes;
```

### 17.3 Phase 3 rollback
- Disable L1
- Drop `minhash_signatures` and `dedup_lsh_buckets` tables
- Drop the trigram GIN index created for `normalized_text`

```sql
-- Phase 3 rollback
UPDATE feature_flags SET enabled = false WHERE flag = 'l1_minhash_enabled';
DROP TABLE IF EXISTS minhash_signatures;
DROP TABLE IF EXISTS dedup_lsh_buckets;
DROP INDEX IF EXISTS idx_normalized_text_gin;
```

### 17.4 Phase 4 rollback
- Disable L2
- Drop HNSW index on embedding
- Drop `embedding` column
- Keep pgvector extension

```sql
-- Phase 4 rollback
UPDATE feature_flags SET enabled = false WHERE flag = 'l2_semantic_enabled';
DROP INDEX IF EXISTS idx_context_chunks_embedding;
ALTER TABLE context_chunks DROP COLUMN IF EXISTS embedding;
```

### 17.5 Full rollback
- Execute Phase 4 -> Phase 3 -> Phase 2 -> Phase 1 artifact removal (reverse order)
- Leave `context_chunks.region_hash` untouched (legacy compatibility)

---

## 18. Fixed Migration Ordering with No Duplicates

### 18.1 Issue #8: Backfill race -- unique index created AFTER backfill

**Fix**: Create non-unique index first, run backfill, resolve duplicates, create UNIQUE index CONCURRENTLY at the end, drop temporary non-unique index.

### 18.2 Issue #9: Duplicate ALTER TABLE normalized_text in Phase 3

**Fix**: `normalized_text` is added ONLY in Phase 1. Phase 3 adds ONLY the GIN index on normalized_text. Phase 3 contains NO `ALTER TABLE ... ADD COLUMN normalized_text`.

### 18.3 Issue #10: No Redis timeout or circuit breaker

**Fix**: Redis operations wrapped in opossum with 100ms timeout. Fallback: PostgreSQL-only.

### 18.4 Issue #11: No pgvector pre-flight check in Phase 2

**Fix**: Phase 2 migration begins with explicit `CREATE EXTENSION IF NOT EXISTS vector` check. If not installed, migration fails fast.

### 18.5 Issue #12: No alert conditions/routing/escalation

**Fix**: P1-P4 alert definitions with thresholds + runbook + routing added (see Section 15).

### 18.6 Issue #13: Phase 2 uses VECTOR but extension check deferred to Phase 4

**Fix**: Extension check moved to Phase 2 prerequisite block. Phase 4 assumes extension already present.

### 18.7 Canonical Migration Ordering (final)

**Phase 1**
1. `ALTER TABLE context_chunks ADD COLUMN content_hash TEXT`
2. `ALTER TABLE context_chunks ADD COLUMN content_hash2 TEXT`
3. `ALTER TABLE context_chunks ADD COLUMN content_hash_version INTEGER DEFAULT 1`
4. `ALTER TABLE context_chunks ADD COLUMN normalized_text TEXT`
5. `ALTER TABLE context_chunks ADD COLUMN collection_scope TEXT DEFAULT 'default'`
6. Create non-unique indexes for backfill performance
7. Backfill content_hash/normalized_text
8. Resolve duplicates
9. Create UNIQUE index CONCURRENTLY
10. Drop temporary non-unique indexes

**Phase 2**
1. pgvector pre-flight: verify `vector` extension exists (`CREATE EXTENSION IF NOT EXISTS vector`)
2. Create `raptor_nodes` table and indexes

**Phase 3**
1. `CREATE EXTENSION IF NOT EXISTS pg_trgm`
2. Create `minhash_signatures` and `dedup_lsh_buckets` tables
3. Create GIN index on existing `context_chunks.normalized_text` (no column ALTER)
4. Backfill minhash signatures + LSH buckets

**Phase 4**
1. Add `embedding VECTOR(384)` column
2. Backfill embeddings
3. Create HNSW index CONCURRENTLY

---

## 19. Performance Optimizations -- VectorStore & Checkpoint Layer

### 19.1 In-memory index/cache for VectorStore

Load persisted checkpoints (gzipped JSON) exactly once at session start, materialize into memory (Map<id, embedding+metadata> plus typed-array for embeddings), then service add/search/dedupe from memory.

Persistence: switch from "read entire gzipped JSON file every call" to write-back with debounce.
- Maintain a write queue of new/updated records in memory
- Periodically (or when queue reaches N records / on idle) serialize incremental changes
- Preferred storage format: line-delimited JSON (NDJSON) append-only for O(1) writes + compact/merge occasionally, or SQLite for robust incremental indexing

Top-level API:
- `vectorStore.loadOnce()` -> returns in-memory index (called per session, not per request)
- `vectorStore.add(records)` -> updates in-memory index + marks dirty
- `vectorStore.search(queryEmbedding, k)` -> uses in-memory index (no disk)
- `vectorStore.flushDebounced()` -> async persistence

### 19.2 CheckpointManager (single in-memory snapshot per session)

Responsibilities:
- `loadSessionCheckpointsOnce()`: reads checkpoint artifacts once into memory
- Fast lookup structures: `seenIds: Set<string>`, `checksumToId: Map<string,string>`, metadata indexes
- Top-k candidate retrieval using heap/selection strategy (not full sort)
- `applyAdd()` / `applyDedupeCollapse()`: updates both embedding index and checkpoint metadata

Read/Write policy:
- Read only at operation boundaries (first call after session start), then pass in-memory structures down
- On flush: write incremental updates, update on-disk index once
- Sort elimination: use iterators over typed arrays and index structures

### 19.3 Top-k heap selection (replace full sort)

Implementation:
1. Min-heap of size k
2. Iterate candidates (or embedding vectors) once
3. Compute similarity score
4. Maintain min-heap; push if heap size < k, else replace root if score > min
5. Complexity: O(N log k) instead of O(N log N)

For dedup collapse: get top-k neighbors per item (kNN) using heap, then run union-find / greedy collapse. Avoid global all-pairs similarity.

### 19.4 Batch embedding computation

- Accumulate new items into batch buffer (target B = 16/32 items)
- When buffer reaches B or after T ms idle, embed entire batch in one request
- Reuse cached embeddings for previously-seen items
- Concurrency control via p-limit to avoid overloading embedding service
- Avoid per-item awaits inside loops; single batched await per flush

### 19.5 Connection pooling

If moving to SQLite:
- Single shared connection per process (SQLite is local; pooling unnecessary)
- WAL mode: `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL`

If using remote DB:
- Small pool (max 5-10 connections)
- Transactions wrap batches (embed batch -> insert embeddings + metadata in one transaction)

### 19.6 Index maintenance

If using SQLite:
- Indexes on `(id)`, `(sessionId)`, `(embeddingId)` / `(checksum)` columns
- Run VACUUM/ANALYZE when growth crosses thresholds (every N inserts or after M deletions)
- REINDEX when query plans degrade

If using ANN index:
- Maintain incremental index if supported; rebuild in background
- Rebuild triggers: after total inserts exceed X% of current size or after debounce flush count N
- Do rebuild asynchronously; keep reads from last stable index

If staying with brute-force exact search:
- Caps and heap top-k to keep fast
- Typed-array embedding matrix, update incrementally (append-only)

---

## 20. Testing & Validation Strategy

### 20.1 Migration validation
After each phase migration:
- Verify `normalized_text` column exists exactly once (Phase 1 only)
- Verify pgvector extension exists after Phase 2 prereq
- Verify unique index exists only after duplicates resolved
- Verify no duplicate `ALTER TABLE` statements across phases

### 20.2 Offline eval (RAPTOR)
- nDCG@K (ground-truth relevance) -- pass if drop < 0.05 vs baseline
- Redundancy rate (trigram overlap) -- pass if 15% reduction
- Entity preservation -- pass if >= 0.70
- Stop condition: nDCG@K drop > 0.05 blocks online rollout

### 20.3 Online A/B (RAPTOR)
- Latency p50/p95, tokens injected, downstream success rate
- Stop condition: any metric fails for 24h -> auto-disable + alert
- Counterfactual logging: for every query in control variant, silently run RAPTOR and log to `raptor_counterfactual_logs` table
- Minimum 500 sessions before promoting from canary

### 20.4 FP monitoring gate for rollout
- Do not enable L1/L2 fully unless FP rate alerts remain green for 24h on canary

### 20.5 Health check SQL (future DB mode)

Run periodically (or on incident):

#### L0 integrity
```sql
SELECT collection_scope, content_hash, COUNT(*)
FROM context_chunks
WHERE dedup_status != 'removed'
GROUP BY 1, 2
HAVING COUNT(*) > 1;
```

#### Hash/normalized_text consistency (spot-check)
```sql
SELECT id FROM context_chunks
WHERE content_hash != sha256(normalize(normalized_text))
LIMIT 100;
```

#### Embedding vector integrity (unit norm)
```sql
SELECT id FROM context_chunks
WHERE embedding IS NULL OR abs(norm(embedding) - 1) > 1e-3
LIMIT 100;
```

---

## 21. Configuration: Single Source of Truth

```typescript
// src/config/dedup.ts
// SINGLE SOURCE OF TRUTH -- no duplication across modules
export const DedupConfig = {
  // Phase 1 -- L0 exact dedup
  l0: {
    enabled: true,
    maxInputChars: 32_000,
    redisTimeoutMs: 100,
    pgTimeoutMs: 5000,
    bloomExpectedElements: 1_000_000,
    bloomFalsePositiveRate: 0.01,
  },

  // Retrieval-time MMR
  retrieval: {
    mmrLambda: 0.5,
    maxResults: 10,
    maxCandidates: 50,
    dedupSim: 0.92,
  },

  // Phase 2 -- RAPTOR
  raptor: {
    enabled: true,
    shadowMode: true,
    chunkSize: 512,
    chunkOverlap: 0,
    clusteringAlgorithm: "kmeans",
    minClusterSize: 5,
    maxClusters: 50,
    nearZeroVarianceEpsilon: 1e-12,
    smallCheckpointThreshold: 10,
    maxTotalSummaries: 50,
    summarizationModel: "haiku",
    summarizationTemperature: 0,
    summarizationMaxTokens: 512,
    extractiveFallback: true,
    consistencyThreshold: 0.6,
    entityCoverageThreshold: 0.5,
    buildTimeoutMs: 5000,
    adjacentLevelsOnly: true,
    minNounOverlap: 2,
    stagedExpansion: true,
    topK: 5,
    topM: 3,
    maxExpandedLeaves: 30,
    oversampleFactor: 3,
  },

  // Phase 3 -- L1 MinHash
  l1: {
    enabled: true,
    numHashes: 256,
    numBands: 64,
    rowsPerBand: 4,
    shingleSize: 5,
    maxShingles: 50_000,
    seed: 0xDEADBEEF,
    jaccardThreshold: 0.8,
    trigramVerifyThreshold: 0.85,
    maxCandidates: 100,
    maxVerificationMs: 20,
  },

  // Phase 4 -- L2 semantic
  l2: {
    enabled: true,
    cosineThreshold: 0.92,
    annEfSearch: 100,
    maxCandidates: 50,
    maxVerificationMs: 100,
    hnswM: 16,
    hnswEfConstruction: 200,
  },

  // Feature flags
  flags: {
    l0_content_hash_enabled: true,
    raptor_enabled: true,
    l1_minhash_enabled: true,
    l2_semantic_enabled: true,
    mark_only_l1: false,
    mark_only_l2: false,
    semdedup_online_enabled: true,
  },

  // Per-collection overrides
  collections: {} as Record<string, {
    l1_jaccard_threshold?: number;
    l2_cosine_threshold?: number;
    raptor_enabled?: boolean;
  }>,

  // Circuit breaker defaults
  breakers: {
    redisTimeoutMs: 100,
    pgTimeoutMs: 5000,
    llmTimeoutMs: 5000,
    embeddingTimeoutMs: 100,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
  },

  // Backfill
  backfill: {
    batchSize: 1000,
    maxBatchRate: 5,            // batches/sec
    statementTimeoutMs: 30_000,
    progressLogInterval: 100,   // batches
  },

  // Warmup
  warmup: {
    timeoutMs: 60_000,
    bloomLoadBatchSize: 5000,
  },
} as const;
```

---

## 22. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **regionHash compatibility broken** | CRITICAL | Low | regionHash function extracted as pure function, tested in isolation, never modified. New contentHash is separate field. |
| **False positive dedup (good content blocked)** | HIGH | Medium | Mark-only mode first (Phases 3-4). Conservative thresholds tuned on labeled corpus. Per-collection overrides. Monitoring dashboard for FP rate. |
| **Embedding cost explosion** | HIGH | Low | RAPTOR uses cheap model (Haiku). L2 uses local model (all-MiniLM-L6-v2), no API cost. Batch embedding, not per-message. |
| **Bloom filter cold start** | MEDIUM | High on restart | Redis-backed bloom survives restarts. Warm from PostgreSQL on init. Bloom miss ALWAYS confirms via DB (never skips). |
| **LSH/Minhash non-determinism** | MEDIUM | Low | Pinned seed (0xDEADBEEF). Signature versioning. Integration tests verify bucket key stability across restarts. |
| **Performance regression** | MEDIUM | Medium | Each tier has latency budget and circuit breaker. p95 tracked per tier. Can degrade (e.g., skip L1 if >50ms). |
| **Storage bloat** | LOW | Medium | Retention policies per collection. Periodic VACUUM and index maintenance. TTL on Redis keys. Soft-delete for SemDeDup cleanup. |
| **Model drift (embedding model changes)** | LOW | Low | Embedding model version stored with each vector. Thresholds tied to model+normalization combo. Migration batch job for re-embedding. |