/**
 * vector-read.ts — free functions for VectorStore read-only operations.
 *
 * Extracted from vectorStore.ts (PR0 split) to bring it under 500 lines.
 * All functions take `store: VectorStore` as first param and access store
 * fields/props directly via type-cast to access private fields (acceptable
 * since these fields were effectively public via the original methods).
 *
 * Call sites in src/ and extensions/ are rewritten from `store.stats(sid)`
 * → `vectorStats(store, sid)`.
 */

import type { Vector } from "./embedder.js";
import { cosineSimilarity } from "./embedder.js";
import type { StoredCheckpoint, SessionState } from "./store.js";
import {
  listCheckpoints,
  loadSessionState,
  saveSessionState,
  setDedupStatus,
  getDedupStats,
  repoStats as repoStatsFromStore,
  dataInvariantStats,
} from "./store/sqlite.js";
import { normalizeSessionId } from "./store.js";
import { computeRegionHash } from "./vectorStore.js";
import type { VectorStore } from "./vectorStore.js";
import type { SearchHit } from "./vectorStore.js";

// ---------------------------------------------------------------------------
// Cosine
// ---------------------------------------------------------------------------

/** Convenience wrapper for raw vector cosine similarity (exposed for tests). */
export function vectorSimilarity(_store: VectorStore, a: Vector, b: Vector): number {
  return cosineSimilarity(a, b);
}

// ---------------------------------------------------------------------------
// SemDeDup
// ---------------------------------------------------------------------------

/**
 * SemDeDup offline cleanup (Sprint 12, QA #17): within a session, mark the
 * lower-quality row of any pair scoring cosine > `threshold` as
 * `dedup_status='removed'` (kept, not deleted — retrieval excludes it). Keeps
 * the row with the higher `tokenEstimate` (more context preserved). Runs as a
 * single scan; idempotent (re-running skips already-removed rows).
 *
 * Returns the number of rows marked removed.
 */
export function vectorSemDedup(
  store: VectorStore,
  sessionId: string,
  threshold?: number,
): number {
  const sid = normalizeSessionId(sessionId);
  const stateDir = store.stateDir;
  const cfg = store.cfg;
  const thr = threshold ?? cfg.SEMDEDUP_COSINE;
  const cps = listCheckpoints(sid, stateDir).filter(
    (c) => c.dedupStatus !== "removed",
  );
  let removed = 0;
  for (let i = 0; i < cps.length; i++) {
    for (let j = i + 1; j < cps.length; j++) {
      const a = cps[i];
      const b = cps[j];
      if (a.dedupStatus === "removed" || b.dedupStatus === "removed") continue;
      if (cosineSimilarity(a.embedding, b.embedding) > thr) {
        const keep = a.tokenEstimate >= b.tokenEstimate ? a : b;
        const drop = keep === a ? b : a;
        setDedupStatus(drop.checkpointId, sid, "removed", stateDir);
        drop.dedupStatus = "removed";
        removed++;
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Dedup sentinel
// ---------------------------------------------------------------------------

/**
 * Dedup sentinel check: has this region already been stored/represented?
 * Consulted by both the persist path and the recall/inline path.
 */
export function vectorDedupe(
  store: VectorStore,
  sessionId: string,
  regionHashOrText: string,
  isText = false,
): boolean {
  const stateDir = store.stateDir;
  const sid = normalizeSessionId(sessionId);
  const hash = isText
    ? computeRegionHash(regionHashOrText)
    : regionHashOrText;
  const state = loadSessionState(sid, stateDir);
  if (state.storedRegionHashes.includes(hash)) return true;
  // H1 follow-up (PR #18 review): a SemDeDup-'removed' row's regionHash must not
  // report "already represented" — its content is excluded from recall, so the
  // incoming region is NOT deduplicated in any retrievable sense.
  return listCheckpoints(sid, stateDir).some(
    (c) => c.dedupStatus !== "removed" && c.regionHash === hash,
  );
}

// ---------------------------------------------------------------------------
// Injection tracking
// ---------------------------------------------------------------------------

/** Mark a checkpoint as injected into the window (recall dedup). */
export function vectorMarkInjected(store: VectorStore, sessionId: string, checkpointId: string): void {
  const stateDir = store.stateDir;
  const sid = normalizeSessionId(sessionId);
  const state = loadSessionState(sid, stateDir);
  if (!state.injectedCheckpointIds.includes(checkpointId)) {
    state.injectedCheckpointIds.push(checkpointId);
    saveSessionState(sid, state, stateDir);
  }
}

/** True if this checkpoint was already injected this session. */
export function vectorWasInjected(store: VectorStore, sessionId: string, checkpointId: string): boolean {
  const stateDir = store.stateDir;
  const state: SessionState = loadSessionState(
    normalizeSessionId(sessionId),
    stateDir,
  );
  return state.injectedCheckpointIds.includes(checkpointId);
}

// ---------------------------------------------------------------------------
// List & TopSimilar
// ---------------------------------------------------------------------------

/** All checkpoints for a session (sorted by checkpointId). */
export function vectorList(store: VectorStore, sessionId: string): StoredCheckpoint[] {
  const stateDir = store.stateDir;
  return listCheckpoints(normalizeSessionId(sessionId), stateDir);
}

/**
 * Return the n most similar checkpoints to the current (most recent) checkpoint
 * by cosine similarity. Returns fewer than n if the session has fewer checkpoints.
 * The current checkpoint itself is excluded from results.
 */
export function vectorTopSimilar(store: VectorStore, sessionId: string, n: number): SearchHit[] {
  const stateDir = store.stateDir;
  const sid = normalizeSessionId(sessionId);
  const checkpoints = listCheckpoints(sid, stateDir);
  if (checkpoints.length <= 1) return [];

  const ordered = [...checkpoints].sort((a, b) =>
    a.checkpointId.localeCompare(b.checkpointId),
  );
  const current = ordered[ordered.length - 1];

  const scored: SearchHit[] = ordered
    .filter(
      (cp) =>
        cp.checkpointId !== current.checkpointId &&
        cp.dedupStatus !== "removed", // H1 follow-up: mirror vectorSearch's filter
    )
    .map((cp) => ({
      checkpoint: cp,
      score: cosineSimilarity(current.embedding, cp.embedding),
    }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, n);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface VectorStats {
  checkpointCount: number;
  totalTokenEstimate: number;
  lastCheckpointId: string | undefined;
  lastSummary: string | undefined;
  injectedCount: number;
  dedupHitRate: number;
  storageDedupRate: number;
  tokensSaved: number;
  originalTokens: number;
  dedupAttempts: number;
  dedupCollapsed: number;
}

/**
 * Store statistics for status reporting / logging. Returns counts + the last
 * (highest-numbered) checkpoint, or nulls when the session is empty.
 */
export function vectorStats(store: VectorStore, sessionId: string): VectorStats {
  const stateDir = store.stateDir;
  const sid = normalizeSessionId(sessionId);
  const cps = listCheckpoints(sid, stateDir);
  const state = loadSessionState(sid, stateDir);
  const ordered = [...cps].sort((a, b) =>
    a.checkpointId.localeCompare(b.checkpointId),
  );
  const last = ordered[ordered.length - 1];
  const injected = state.injectedCheckpointIds.length;
  const ds = getDedupStats(stateDir);
  const sessionTok = cps.reduce((s, c) => s + (c.tokenEstimate ?? 0), 0);
  const sessionOrig = cps.reduce((s, c) => s + (c.originalTokenEstimate ?? 0), 0);
  const sessionSaved = cps.reduce(
    (s, c) => s + Math.max(0, (c.originalTokenEstimate ?? 0) - (c.tokenEstimate ?? 0)),
    0,
  );
  return {
    checkpointCount: cps.length,
    totalTokenEstimate: sessionTok,
    lastCheckpointId: last?.checkpointId,
    lastSummary: last?.summary,
    injectedCount: injected,
    dedupHitRate: cps.length === 0 ? 0 : injected / cps.length,
    storageDedupRate: ds.attempts === 0 ? 0 : ds.deduped / ds.attempts,
    tokensSaved: sessionSaved,
    originalTokens: sessionOrig,
    dedupAttempts: ds.attempts,
    dedupCollapsed: ds.deduped,
  };
}

/**
 * Repo-wide stats — aggregates every session in this store (one per repo).
 * Cumulative, resumable, cross-device.
 */
export function vectorRepoStats(store: VectorStore): ReturnType<typeof repoStatsFromStore> {
  const stateDir = store.stateDir;
  return repoStatsFromStore(stateDir);
}

/** Data-safety invariant: regions retained vs bytes permanently deleted. */
export function vectorDataInvariant(store: VectorStore): ReturnType<typeof dataInvariantStats> {
  const stateDir = store.stateDir;
  return dataInvariantStats(stateDir);
}