/**
 * cache-stripe-score.ts — stability scoring + pure helpers for cache-striping.
 *
 * Extracted from cache-stripe-impl.ts (delegate-shell split) so the DB-touching
 * refreshStripeAssignments lives apart from pure scoring math. No SQL, no pi
 * runtime types (PREVENT-PI-004, PREVENT-002).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Cache stripe assigned to a single chunk. */
export interface CacheStripe {
  /** Unique identifier for the chunk (the context_chunks.id — TEXT, e.g. "chkpt_001"). */
  chunkId: string;
  /** Cache stripe / layer number:
   *  0 = permanent (system prompt, never evicted)
   *  1 = epoch (stable across the whole session)
   *  2 = topic (stable within a topic cluster)
   *  3 = thread (current conversation thread)
   *  4 = volatile (tail — appended, not cached)
   */
  stripe: number;
  /** Composite stability score (0.0-1.0). */
  stability: number;
  /** Unix-epoch seconds when this assignment was computed. */
  assignedAt: number;
  /** Epoch identifier this assignment belongs to. */
  epochId: string;
}

/** Input shape for computeStabilityScore. Matches the SQL projection the
 *  caller extracts from context_chunks + cache_stripes. */
export interface ChunkInput {
  /** context_chunks.id (TEXT). */
  chunkId: string;
  /** The text content of the chunk. */
  content: string;
  /** Access count — currently 0 (cache_stripes has no tracking column yet). */
  accessCount: number;
  /** Unix-epoch seconds of last access — currently 0 (same reason). */
  lastAccessedAt: number;
}

/** Embedder interface — matches the shape of TrigramEmbedder.embed. */
export interface EmbedderLike {
  embed(text: string): number[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WEIGHT_SEMANTIC = 0.5;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_FREQUENCY = 0.2;

const STRIPE_THRESHOLDS = [
  { minStability: 0.90, stripe: 0 },
  { minStability: 0.70, stripe: 1 },
  { minStability: 0.50, stripe: 2 },
  { minStability: 0.30, stripe: 3 },
  { minStability: -Infinity, stripe: 4 },
] as const;

// ─── Embedding helpers (no external dep) ─────────────────────────────────────

/** FNV-1a 32-bit hash for the content-based embedding fallback. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/** Crude 128-dim hashed n-gram embedding fallback. Used when no embedder is
 *  injected (e.g. tests); production should pass TrigramEmbedder. */
export function fallbackEmbed(text: string): number[] {
  const dim = 128;
  const vec = new Array<number>(dim).fill(0);
  const norm = text.toLowerCase().replace(/\s+/g, " ");
  if (norm.length === 0) return vec;

  vec[Math.floor(fnv1a(norm) * dim)] += 1;
  for (const word of norm.split(" ")) {
    if (word.length === 0) continue;
    vec[Math.floor(fnv1a(word) * dim)] += 0.5;
    for (let i = 0; i < Math.max(1, word.length - 1); i++) {
      const trigram = word.slice(i, i + 3);
      if (trigram.length === 3) {
        vec[Math.floor(fnv1a(trigram) * dim)] += 0.25;
      }
    }
  }
  return l2Normalize(vec);
}

export function l2Normalize(v: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  if (sumSq === 0) return v;
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Compute cosine similarity between two vectors of equal length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Stability Scoring ───────────────────────────────────────────────────────

/**
 * Composite stability = 0.5*semantic + 0.3*recency + 0.2*frequency.
 * Recency/frequency fall back to neutral scores when the epoch lacks
 * access-tracking data (the current cache_stripes schema).
 */
export function computeStabilityScore(
  chunk: ChunkInput,
  allChunks: ChunkInput[],
  embedder?: EmbedderLike,
  sessionEmbed?: number[],
): number {
  const emb = embedder
    ? embedder.embed(chunk.content)
    : fallbackEmbed(chunk.content);
  // No session embedding → self-similarity baseline.
  const sem = cosineSimilarity(emb, sessionEmbed ?? emb);
  const semanticScore = isNaN(sem) ? 0 : sem;

  let recencyScore = 0.5;
  const accessed = allChunks
    .map((c) => c.lastAccessedAt)
    .filter((t) => t > 0);
  if (accessed.length > 1) {
    const minT = Math.min(...accessed);
    const maxT = Math.max(...accessed);
    const range = maxT - minT;
    recencyScore = range > 0 ? (chunk.lastAccessedAt - minT) / range : 1.0;
  }

  const counts = allChunks.map((c) => c.accessCount);
  const maxCount = Math.max(...counts, 1);
  const freqScore = maxCount > 0 ? chunk.accessCount / maxCount : 0;

  const stability =
    WEIGHT_SEMANTIC * semanticScore +
    WEIGHT_RECENCY * recencyScore +
    WEIGHT_FREQUENCY * freqScore;

  return Math.max(0, Math.min(1, stability));
}

/** Map a stability score to its stripe (layer). */
export function stabilityToStripe(stability: number): number {
  for (const t of STRIPE_THRESHOLDS) {
    if (stability >= t.minStability) return t.stripe;
  }
  return 4;
}
