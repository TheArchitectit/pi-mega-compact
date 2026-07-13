/**
 * vectorStore.ts — Layer 3 (CLUSTER): the local vector database.
 *
 * One store, three consumers (per PLAN.md): auto-inline on resume, on-demand
 * /recall-context, and the dedup sentinel. All share `add / search / dedupe`.
 *
 * Backed by the gzipped on-disk checkpoint files (store.ts). Similarity is a
 * linear cosine scan — checkpoint counts are small, so no ANN index is needed.
 */

import { createHash } from "node:crypto";
import type { Embedder, Vector } from "./embedder.js";
import { cosineSimilarity, defaultEmbedder } from "./embedder.js";
import type { StoredCheckpoint, SessionState } from "./store.js";
import {
  appendCheckpoint,
  getStateDir,
  listCheckpoints,
  nextCheckpointId,
  normalizeSessionId,
  loadSessionState,
  saveSessionState,
  rewriteCheckpoints,
} from "./store.js";

export interface SearchHit {
  checkpoint: StoredCheckpoint;
  score: number;
}

export interface AddInput {
  sessionId: string;
  summary: string;
  /** Compressed topic summary (extractive). When present, embedded instead of regionText. */
  topicSummary?: string;
  keyDecisions?: string[];
  nextSteps?: string[];
  filesModified?: string[];
  tokenEstimate?: number;
  /** Raw text of the compacted region — used to derive the regionHash + vector. */
  regionText: string;
  timestamp: number;
}

export interface AddResult {
  checkpoint: StoredCheckpoint;
  deduped: boolean; // true when an equivalent region already existed (skipped embed)
  /** Which dedup tier matched: regionHash | summaryHash | contentSimilarity | undefined (new). */
  reason?: string;
}

/** Stable hash of a compacted region, the dedup sentinel key. */
export function computeRegionHash(regionText: string): string {
  // Normalize whitespace before hashing so "foo  bar" and "foo bar" dedup.
  const normalized = regionText.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export class VectorStore {
  private readonly embedder: Embedder;
  private readonly dedupSim: number;
  private readonly stateDir: string;

  constructor(
    opts: { embedder?: Embedder; dedupSim?: number; stateDir?: string } = {},
  ) {
    this.embedder = opts.embedder ?? defaultEmbedder();
    // 0.90 ≈ "near-identical" for the default trigram embedder (its cosine
    // ceiling for one-word-different text is ~0.94). Higher values would
    // almost never collapse; lower would over-merge distinct checkpoints.
    this.dedupSim = opts.dedupSim ?? 0.9;
    this.stateDir = opts.stateDir ?? getStateDir();
  }

  /**
   * Add a checkpoint. Dedup cascade:
   *   1. regionHash exact match (legacy, backward-compat)
   *   2. summaryHash exact match (new: catches same-topic incremental compactions)
   *   3. content similarity ≥ dedupSim (catches near-identical summaries)
   *   4. If none match → create new checkpoint
   */
  add(input: AddInput): AddResult {
    const sessionId = normalizeSessionId(input.sessionId);
    const regionHash = computeRegionHash(input.regionText);
    const all = listCheckpoints(sessionId, this.stateDir);

    // 1. Legacy regionHash dedup (backward-compat)
    const regionMatch = all.find((cp) => cp.regionHash === regionHash);
    if (regionMatch) return { checkpoint: regionMatch, deduped: true, reason: "regionHash" };

    // 2. SummaryHash dedup — catches same-topic incremental compactions
    const summaryHash = input.topicSummary
      ? createHash("sha256").update(input.topicSummary).digest("hex").slice(0, 16)
      : undefined;
    if (summaryHash) {
      const summaryMatch = all.find((cp) => cp.summaryHash === summaryHash);
      if (summaryMatch) {
        // Topic didn't change — update timestamp on existing checkpoint
        summaryMatch.timestamp = input.timestamp;
        rewriteCheckpoints(sessionId, all, this.stateDir);
        return { checkpoint: summaryMatch, deduped: true, reason: "summaryHash" };
      }
    }

    // 3. Content similarity dedup — catches near-identical regions
    //    Always embed on regionText (the search key). topicSummary is used for
    //    summaryHash dedup (tier 2) and stored for recall; the vector index
    //    is keyed on the original region for backward-compat search semantics.
    const embedding = this.embedder.embed(input.regionText);
    if (all.length > 0) {
      const nearest = all.reduce(
        (best, cp) => {
          const sim = cosineSimilarity(embedding, cp.embedding);
          return sim > best.sim ? { checkpoint: cp, sim } : best;
        },
        { checkpoint: all[0], sim: -1 },
      );
      if (nearest.sim >= this.dedupSim) {
        // Near-identical — update timestamp on existing checkpoint
        nearest.checkpoint.timestamp = input.timestamp;
        rewriteCheckpoints(sessionId, all, this.stateDir);
        return { checkpoint: nearest.checkpoint, deduped: true, reason: "contentSimilarity" };
      }
    }

    // 4. Genuinely new — create checkpoint
    const checkpointId = nextCheckpointId(sessionId, this.stateDir);
    const checkpoint: StoredCheckpoint = {
      checkpointId,
      sessionId,
      summary: input.summary,
      topicSummary: input.topicSummary,
      summaryHash,
      keyDecisions: input.keyDecisions ?? [],
      nextSteps: input.nextSteps ?? [],
      filesModified: input.filesModified ?? [],
      tokenEstimate: input.tokenEstimate ?? 0,
      regionHash,
      embedding,
      timestamp: input.timestamp,
    };
    appendCheckpoint(checkpoint, this.stateDir);

    // Track the region hash in session state for fast sentinel checks.
    const state = loadSessionState(sessionId, this.stateDir);
    if (!state.storedRegionHashes.includes(regionHash)) {
      state.storedRegionHashes.push(regionHash);
      saveSessionState(sessionId, state, this.stateDir);
    }
    return { checkpoint, deduped: false };
  }

  /**
   * Semantic search within a session's checkpoints. Returns top-K by cosine
   * similarity, with near-duplicate collapse (keep the higher-ranked of any
   * pair scoring above dedupSim against each other).
   */
  search(sessionId: string, query: string, k = 3): SearchHit[] {
    const sid = normalizeSessionId(sessionId);
    const checkpoints = listCheckpoints(sid, this.stateDir);
    if (checkpoints.length === 0) return [];
    const qv = this.embedder.embed(query);

    const scored: SearchHit[] = checkpoints
      .map((cp) => ({
        checkpoint: cp,
        score: cosineSimilarity(qv, cp.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    // Near-duplicate collapse against already-selected hits.
    const selected: SearchHit[] = [];
    for (const hit of scored) {
      const dup = selected.some(
        (s) =>
          cosineSimilarity(s.checkpoint.embedding, hit.checkpoint.embedding) >=
          this.dedupSim,
      );
      if (!dup) selected.push(hit);
      if (selected.length >= k) break;
    }
    return selected;
  }

  /**
   * Dedup sentinel check: has this region already been stored/represented?
   * Consulted by both the persist path and the recall/inline path.
   */
  dedupe(sessionId: string, regionHashOrText: string, isText = false): boolean {
    const sid = normalizeSessionId(sessionId);
    const hash = isText
      ? computeRegionHash(regionHashOrText)
      : regionHashOrText;
    const state = loadSessionState(sid, this.stateDir);
    if (state.storedRegionHashes.includes(hash)) return true;
    return listCheckpoints(sid, this.stateDir).some(
      (c) => c.regionHash === hash,
    );
  }

  /** Mark a checkpoint as injected into the window (recall dedup). */
  markInjected(sessionId: string, checkpointId: string): void {
    const sid = normalizeSessionId(sessionId);
    const state = loadSessionState(sid, this.stateDir);
    if (!state.injectedCheckpointIds.includes(checkpointId)) {
      state.injectedCheckpointIds.push(checkpointId);
      saveSessionState(sid, state, this.stateDir);
    }
  }

  /** True if this checkpoint was already injected this session. */
  wasInjected(sessionId: string, checkpointId: string): boolean {
    const state: SessionState = loadSessionState(
      normalizeSessionId(sessionId),
      this.stateDir,
    );
    return state.injectedCheckpointIds.includes(checkpointId);
  }

  /** Convenience for a raw vector cosine (exposed for tests). */
  similarity(a: Vector, b: Vector): number {
    return cosineSimilarity(a, b);
  }

  /** All checkpoints for a session (sorted by checkpointId). */
  list(sessionId: string): StoredCheckpoint[] {
    return listCheckpoints(normalizeSessionId(sessionId), this.stateDir);
  }

  /**
   * Return the n most similar checkpoints to the current (most recent) checkpoint
   * by cosine similarity. Returns fewer than n if the session has fewer checkpoints.
   * The current checkpoint itself is excluded from results.
   */
  topSimilar(sessionId: string, n: number): SearchHit[] {
    const sid = normalizeSessionId(sessionId);
    const checkpoints = listCheckpoints(sid, this.stateDir);
    if (checkpoints.length <= 1) return [];

    // Find the most recent checkpoint (by checkpointId, which is sequential)
    const ordered = [...checkpoints].sort((a, b) =>
      a.checkpointId.localeCompare(b.checkpointId),
    );
    const current = ordered[ordered.length - 1];

    // Score all other checkpoints by similarity to current
    const scored: SearchHit[] = ordered
      .filter((cp) => cp.checkpointId !== current.checkpointId)
      .map((cp) => ({
        checkpoint: cp,
        score: cosineSimilarity(current.embedding, cp.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, n);
  }

  /**
   * Store statistics for status reporting / logging. Returns counts + the last
   * (highest-numbered) checkpoint, or nulls when the session is empty.
   */
  stats(sessionId: string): {
    checkpointCount: number;
    totalTokenEstimate: number;
    lastCheckpointId: string | undefined;
    lastSummary: string | undefined;
    injectedCount: number;
    dedupHitRate: number; // injected / checkpoints, 0..1
  } {
    const sid = normalizeSessionId(sessionId);
    const cps = listCheckpoints(sid, this.stateDir);
    const state = loadSessionState(sid, this.stateDir);
    const ordered = [...cps].sort((a, b) =>
      a.checkpointId.localeCompare(b.checkpointId),
    );
    const last = ordered[ordered.length - 1];
    const injected = state.injectedCheckpointIds.length;
    return {
      checkpointCount: cps.length,
      totalTokenEstimate: cps.reduce((s, c) => s + (c.tokenEstimate ?? 0), 0),
      lastCheckpointId: last?.checkpointId,
      lastSummary: last?.summary,
      injectedCount: injected,
      dedupHitRate: cps.length === 0 ? 0 : injected / cps.length,
    };
  }
}
