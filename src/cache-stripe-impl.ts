/**
 * cache-stripe-impl.ts — Vector-Aware Cache Striping implementation.
 *
 * Computes a stability score for each context chunk and assigns it to a
 * cache stripe / prompt-cache layer. Stable chunks (high recency + frequency +
 * semantic density) go to early layers (cached prefix); volatile chunks append
 * at Layer 4 (tail). Runs entirely offline — no network, no LLM (PREVENT-PI-004).
 *
 * The stability score is a weighted composite:
 *   stability = 0.5 * semanticSimilarity + 0.3 * recency + 0.2 * frequency
 *
 * - semanticSimilarity: cosine similarity of the chunk's embedding against the
 *   running session embedding (from TrigramEmbedder). High similarity means the
 *   chunk is topically relevant to current work.
 * - recency: how recently the chunk appeared (normalized to 0.0-1.0 across all
 *   chunks in the epoch). Recent chunks are more likely to benefit from caching.
 * - frequency: how often the chunk's content has been referenced (0.0-1.0,
 *   estimated from a simple access counter stored alongside).
 *
 * Reassignment happens at epoch boundaries via refreshStripeAssignments.
 * All SQL is parameterized (PREVENT-002). No pi runtime types are imported,
 * keeping this module pi-agnostic.
 */

import { randomBytes } from "node:crypto";
import { openStore, withTx } from "./store/sqlite/utils.js";
import type { DatabaseSync } from "node:sqlite";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Cache stripe assigned to a single chunk. */
export interface CacheStripe {
  /** Unique identifier for the chunk (e.g. context_chunks rowid or a content
   *  fingerprint). */
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

/** Input shape for computeStabilityScore. Matches the context_chunks row shape
 *  the SQL caller extracts. */
export interface ChunkInput {
  /** Primary key / rowid from context_chunks. */
  chunkId: string;
  /** The text content of the chunk. */
  content: string;
  /** How many times this chunk has been recalled/referenced (access count). */
  accessCount: number;
  /** Unix-epoch seconds of the most recent access. */
  lastAccessedAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Semantic similarity weight in the composite score. */
const WEIGHT_SEMANTIC = 0.5;
/** Recency weight in the composite score. */
const WEIGHT_RECENCY = 0.3;
/** Frequency weight in the composite score. */
const WEIGHT_FREQUENCY = 0.2;

/** Stripes a chunk lands in based on its stability score. Thresholds define
 *  the boundary between adjacent layers. */
const STRIPE_THRESHOLDS = [
  { minStability: 0.90, stripe: 0 },
  { minStability: 0.70, stripe: 1 },
  { minStability: 0.50, stripe: 2 },
  { minStability: 0.30, stripe: 3 },
  { minStability: -Infinity, stripe: 4 },
] as const;

// ─── Embedding helpers (no external dep) ─────────────────────────────────────

/**
 * FNV-1a 32-bit hash for the content-based embedding fallback. The production
 * path uses TrigramEmbedder from embedder.ts but we keep a self-contained hash
 * for the case where no embedder is passed in.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/**
 * Produce a crude 128-dim pseudorandom embedding from text using hashed n-gram
 * bins. Matches the approach in TrigramEmbedder._embedRaw conceptually. Used
 * only as a fallback / test path; the caller should prefer TrigramEmbedder.
 */
function fallbackEmbed(text: string): number[] {
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

function l2Normalize(v: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  if (sumSq === 0) return v;
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Compute cosine similarity between two vectors of equal length. */
function cosineSimilarity(a: number[], b: number[]): number {
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

/** Embedder interface — matches the shape of TrigramEmbedder.embed. */
export interface EmbedderLike {
  embed(text: string): number[];
}

// ─── Stability Scoring ───────────────────────────────────────────────────────

/**
 * Compute a composite stability score for a single chunk.
 *
 * @param chunk         The chunk metadata + content to score.
 * @param allChunks     All chunks in this epoch (used to compute relative recency).
 * @param embedder      Optional embedder instance. If omitted, uses the
 *                      self-contained fallback (128-dim hashed n-gram).
 * @param sessionEmbed  Pre-computed embedding for the current session (the
 *                      "query" vector). If omitted, computed on the fly from
 *                      the chunk content alone, which degrades semantic scoring
 *                      to a self-similarity baseline.
 * @returns             A number in [0.0, 1.0] where 1.0 = most stable.
 */
export function computeStabilityScore(
  chunk: ChunkInput,
  allChunks: ChunkInput[],
  embedder?: EmbedderLike,
  sessionEmbed?: number[],
): number {
  // ── Semantic similarity (0.5 weight) ────────────────────────────────────
  const emb = embedder
    ? embedder.embed(chunk.content)
    : fallbackEmbed(chunk.content);

  // If no session embedding is provided, use the chunk's own embedding as
  // a self-similarity — this produces a baseline score based on content
  // density (chunks with more meaningful content get higher internal
  // similarity). Real deployments should pass the session embedding.
  const sem = cosineSimilarity(
    emb,
    sessionEmbed ?? emb,
  );
  const semanticScore = isNaN(sem) ? 0 : sem;

  // ── Recency (0.3 weight) ────────────────────────────────────────────────
  // Relative recency: lastAccessedAt of this chunk vs. min/max across epoch.
  // Falls back to 0.5 if there's only one chunk or no timestamp data.
  let recencyScore = 0.5;
  const accessed = allChunks
    .map((c) => c.lastAccessedAt)
    .filter((t) => t > 0);
  if (accessed.length > 1) {
    const minT = Math.min(...accessed);
    const maxT = Math.max(...accessed);
    const range = maxT - minT;
    if (range > 0) {
      recencyScore = (chunk.lastAccessedAt - minT) / range;
    } else {
      recencyScore = 1.0;
    }
  }

  // ── Frequency (0.2 weight) ──────────────────────────────────────────────
  // Access count relative to the max across the epoch.
  const counts = allChunks.map((c) => c.accessCount);
  const maxCount = Math.max(...counts, 1);
  const freqScore = maxCount > 0 ? chunk.accessCount / maxCount : 0;

  // ── Composite ───────────────────────────────────────────────────────────
  const stability =
    WEIGHT_SEMANTIC * semanticScore +
    WEIGHT_RECENCY * recencyScore +
    WEIGHT_FREQUENCY * freqScore;

  // Clamp to [0.0, 1.0] as a safety net.
  return Math.max(0, Math.min(1, stability));
}

/**
 * Determine the cache stripe (layer) for a given stability score.
 *
 * @param stability  Composite stability score in [0.0, 1.0].
 * @returns          Stripe number 0-4.
 */
export function stabilityToStripe(stability: number): number {
  for (const t of STRIPE_THRESHOLDS) {
    if (stability >= t.minStability) return t.stripe;
  }
  return 4;
}

// ─── Stripe Reassignment ─────────────────────────────────────────────────────

/**
 * Refresh stripe assignments for all chunks in the current epoch.
 *
 * Steps:
 *  1. Read all context_chunks from the SQLite store that belong to the
 *     current epoch (or all chunks if no epoch filter).
 *  2. For each chunk, compute a stability score via computeStabilityScore.
 *  3. Map stability -> stripe via stabilityToStripe.
 *  4. UPSERT into cache_stripes.
 *  5. (Stale entries for this epoch are implicitly overwritten by the UPSERT.)
 *
 * The optional embedder parameter allows injecting the production
 * TrigramEmbedder. If omitted, the fallback hashed n-gram embedder is used
 * (works offline in all scenarios).
 *
 * Non-fatal: failures are logged via a provided logger callback and never
 * thrown. Returns the count of chunks reassigned.
 *
 * @param store      An open SQLite DatabaseSync handle (or a stateDir string
 *                   to open lazily). Accepts either to match the caller's
 *                   convenience. When a string is passed, opens the store for
 *                   this call only (does not cache the connection).
 * @param epochId    The epoch to reassign. If omitted, generates a new epoch
 *                   ID (random hex). Pass '' to reassign all chunks without
 *                   filtering by epoch.
 * @param embedder   Optional TrigramEmbedder instance. When provided, uses it
 *                   for semantic similarity; otherwise uses the fallback.
 * @param logFn      Optional logging callback (defaults to no-op).
 * @returns          The number of chunks that were reassigned.
 */
export function refreshStripeAssignments(
  store: DatabaseSync | string,
  epochId?: string,
  embedder?: EmbedderLike,
  logFn?: (msg: string) => void,
): number {
  const db: DatabaseSync =
    typeof store === "string" ? openStore(store) : store;
  const log = logFn ?? (() => {});
  const actualEpochId = epochId ?? nextEpochId();
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Read all relevant context_chunks, using the summary as text content.
    //    The summary field holds the compressed checkpoint content; for fresh
    //    chunks that have no summary yet, fall back to normalized_text or
    //    concatenated key_decisions.
    const rows = db
      .prepare(
        `SELECT c.rowid AS chunk_id,
                COALESCE(c.summary, c.normalized_text, c.key_decisions, '') AS content,
                COALESCE(s.access_count, 0) AS access_count,
                COALESCE(s.last_accessed_at, 0) AS last_accessed_at
         FROM context_chunks c
         LEFT JOIN cache_stripes s ON s.chunk_id = CAST(c.rowid AS TEXT)
         WHERE (? = '' OR s.epoch_id = ? OR s.epoch_id IS NULL)`,
      )
      .all(actualEpochId, actualEpochId) as Array<{
      chunk_id: number;
      content: string;
      access_count: number;
      last_accessed_at: number;
    }>;

    if (rows.length === 0) {
      log("cache-stripe: no chunks to reassign");
      return 0;
    }

    // Build the allChunks array for relative scoring.
    const allChunks: ChunkInput[] = rows.map((r) => ({
      chunkId: String(r.chunk_id),
      content: r.content,
      accessCount: r.access_count,
      lastAccessedAt: r.last_accessed_at,
    }));

    // Compute a session embedding (mean of all chunk embeddings) for semantic
    // similarity comparison.
    let sessionEmbed: number[] | undefined;
    try {
      const dim = embedder ? embedder.embed("").length : 128;
      const sumEmb = new Array<number>(dim).fill(0);
      let count = 0;
      for (const chunk of allChunks) {
        const vec = embedder
          ? embedder.embed(chunk.content)
          : fallbackEmbed(chunk.content);
        for (let i = 0; i < sumEmb.length; i++) sumEmb[i] += vec[i];
        count++;
      }
      if (count > 0) {
        for (let i = 0; i < sumEmb.length; i++) sumEmb[i] /= count;
        sessionEmbed = l2Normalize(sumEmb);
      }
    } catch {
      log("cache-stripe: session embedding failed, skipping semantic weight");
    }

    // 2. Compute stability for each chunk.
    const results: Array<{
      chunkId: string;
      stripe: number;
      stability: number;
    }> = [];

    for (const chunk of allChunks) {
      const stability = computeStabilityScore(
        chunk,
        allChunks,
        embedder,
        sessionEmbed,
      );
      const stripe = stabilityToStripe(stability);
      results.push({ chunkId: chunk.chunkId, stripe, stability });
    }

    // 3. UPSERT into cache_stripes using a savepoint for atomicity.
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO cache_stripes(chunk_id, stripe, stability, assigned_at, epoch_id)
       VALUES (?, ?, ?, ?, ?)`,
    );

    withTx(db, () => {
      for (const r of results) {
        upsert.run(r.chunkId, r.stripe, r.stability, now, actualEpochId);
      }
    });

    log(
      `cache-stripe: reassigned ${results.length} chunks to epoch ${actualEpochId}`,
    );
    return results.length;
  } catch (err) {
    log(
      `cache-stripe: refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

/**
 * Generate a random epoch ID (16 hex chars) for tokenizing stripe cohorts.
 */
function nextEpochId(): string {
  return randomBytes(8).toString("hex");
}