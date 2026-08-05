/**
 * cache-stripe-impl.ts — Vector-Aware Cache Striping (PLAN_V2 Phase 3).
 *
 * Owns refreshStripeAssignments: the DB-touching write path that scores each
 * context chunk and UPSERTs its stripe row into cache_stripes. All pure math
 * and scoring types live in cache-stripe-score.ts (extracted via the
 * delegate-shell pattern to keep this file under the 300-line src/ soft
 * limit). cache-stripe.ts re-exports the public surface.
 *
 * Runs entirely offline — no network, no LLM (PREVENT-PI-004). All SQL is
 * parameterized (PREVENT-002). No pi runtime types are imported, keeping this
 * module pi-agnostic.
 */

import { randomBytes } from "node:crypto";
import { openStore, withTx } from "./store/sqlite/utils.js";
import type { DatabaseSync } from "node:sqlite";
import {
  computeStabilityScore,
  stabilityToStripe,
  fallbackEmbed,
  l2Normalize,
  type ChunkInput,
  type EmbedderLike,
} from "./cache-stripe-score.js";

export {
  computeStabilityScore,
  stabilityToStripe,
  fallbackEmbed,
  l2Normalize,
} from "./cache-stripe-score.js";
export type {
  CacheStripe,
  ChunkInput,
  EmbedderLike,
} from "./cache-stripe-score.js";

// ─── Stripe Reassignment ─────────────────────────────────────────────────────

/**
 * Refresh stripe assignments for all chunks in an epoch.
 *
 * Steps:
 *  1. Resolve target epochId: explicit string → use it; '' → no epoch filter
 *     (assign all chunks); undefined → look up the most recently committed
 *     checkpoint_epochs row so the stripes we write are visible to the
 *     buildCacheOptimizedPrompt reader (`ORDER BY created_at DESC LIMIT 1`).
 *     If no epoch exists yet (pre-first-compaction), fall back to a random id
 *     — the write succeeds and the rows are simply never read until an epoch
 *     lands.
 *  2. Read context_chunks (chunk_id = c.id, NOT rowid — the read path joins
 *     on the TEXT id).
 *  3. Score each chunk via computeStabilityScore (mean-pool embeddings for a
 *     session-level semantic "query" vector).
 *  4. Atomic UPSERT into cache_stripes.
 *
 * Non-fatal: failures are logged via the provided logger and never thrown.
 * Returns the count of chunks reassigned (0 on error).
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

  let actualEpochId: string;
  if (epochId !== undefined) {
    actualEpochId = epochId;
  } else {
    try {
      const latest = db
        .prepare(
          `SELECT epoch_id FROM checkpoint_epochs ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { epoch_id: string } | undefined;
      actualEpochId = latest?.epoch_id ?? nextEpochId();
    } catch {
      actualEpochId = nextEpochId();
    }
  }
  const now = Math.floor(Date.now() / 1000);

  try {
    // cache_stripes has no access_count / last_accessed_at columns (schema:
    // chunk_id/stripe/stability/assigned_at/epoch_id) — querying them throws.
    // Score freshness/frequency to 0 here; stability derives from content +
    // semantic similarity only until an access-tracking column is added.
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id,
                COALESCE(c.summary, c.normalized_text, c.key_decisions, '') AS content
         FROM context_chunks c
         LEFT JOIN cache_stripes s ON s.chunk_id = c.id
         WHERE (? = '' OR s.epoch_id = ? OR s.epoch_id IS NULL)`,
      )
      .all(actualEpochId, actualEpochId) as Array<{
      chunk_id: string;
      content: string;
    }>;

    if (rows.length === 0) {
      log("cache-stripe: no chunks to reassign");
      return 0;
    }

    const allChunks: ChunkInput[] = rows.map((r) => ({
      chunkId: r.chunk_id,
      content: r.content,
      accessCount: 0,
      lastAccessedAt: 0,
    }));

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

/** Generate a random epoch id (16 hex chars) for tokenizing stripe cohorts. */
function nextEpochId(): string {
  return randomBytes(8).toString("hex");
}
