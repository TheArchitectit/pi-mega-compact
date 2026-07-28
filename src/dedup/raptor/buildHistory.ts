/**
 * buildHistory.ts — S42D RAPTOR build history + freshness.
 *
 * - Stores one structured row per tree build in `raptor_build_history`.
 * - `computeCoherenceScore`: avg intra-cluster cosine similarity (0–1) for a
 *   built tree — a health/diagnostics metric, not a gating signal.
 * - `isRaptorTreeFresh`: lets the build call site skip a rebuild when the last
 *   build is recent (within `freshnessHours`) and the checkpoint count has not
 *   drifted by more than 20%. Returns false when no history exists (forces a
 *   build) — the same default as a missing tree.
 *
 * No network. Pure SQLite + local cosine.
 */

import { randomUUID } from "node:crypto";
import { openStore, withTx } from "../../store/sqlite/utils.js";
import { getStateDir } from "../../store.js";
import { normalizeSessionId } from "../../store.js";
import { cosineSimilarity } from "../../embedder.js";
import type { RaptorTree } from "./tree.js";
import type { DatabaseSync } from "node:sqlite";

/** A row in raptor_build_history. */
export interface BuildHistoryRow {
  buildId: string;
  sessionId: string;
  stateDir: string;
  startedAt: number;
  completedAt: number;
  nodeCount: number;
  leafCount: number;
  depth: number;
  configJson: string;
  coherenceScore: number | null;
  timedOut: boolean;
}

/** Args for insertBuildHistory (buildId + startedAt are derived at the call site). */
export interface RecordBuildInput {
  sessionId: string;
  stateDir: string;
  startedAt: number;
  completedAt: number;
  nodeCount: number;
  leafCount: number;
  depth: number;
  configJson: string;
  coherenceScore: number | null;
  timedOut: boolean;
}

/** Insert one build-history row. Idempotent on build_id (PK). */
export function insertBuildHistory(
  input: RecordBuildInput,
  stateDir: string = getStateDir(),
): string {
  const db = openStore(stateDir);
  const buildId = randomUUID();
  const sid = normalizeSessionId(input.sessionId);
  withTx(db, () => {
    db.prepare(
      `INSERT INTO raptor_build_history
         (build_id, session_id, state_dir, started_at, completed_at,
          node_count, leaf_count, depth, config_json, coherence_score, timed_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(build_id) DO NOTHING`,
    ).run(
      buildId,
      sid,
      input.stateDir,
      input.startedAt,
      input.completedAt,
      input.nodeCount,
      input.leafCount,
      input.depth,
      input.configJson,
      input.coherenceScore,
      input.timedOut ? 1 : 0,
    );
  });
  return buildId;
}

/** The most recent build row for a session (by completed_at), or null. */
export function getLatestBuild(
  sessionId: string,
  stateDir: string = getStateDir(),
): BuildHistoryRow | null {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const row = db
    .prepare(
      `SELECT build_id, session_id, state_dir, started_at, completed_at,
              node_count, leaf_count, depth, config_json, coherence_score, timed_out
       FROM raptor_build_history
       WHERE session_id = ?
       ORDER BY completed_at DESC
       LIMIT 1`,
    )
    .get(sid) as
    | {
        build_id: string;
        session_id: string;
        state_dir: string;
        started_at: number;
        completed_at: number;
        node_count: number;
        leaf_count: number;
        depth: number;
        config_json: string;
        coherence_score: number | null;
        timed_out: number;
      }
    | undefined;
  if (!row) return null;
  return {
    buildId: row.build_id,
    sessionId: row.session_id,
    stateDir: row.state_dir,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nodeCount: row.node_count,
    leafCount: row.leaf_count,
    depth: row.depth,
    configJson: row.config_json,
    coherenceScore: row.coherence_score,
    timedOut: row.timed_out === 1,
  };
}

/** All build rows for a session, newest first. */
export function listBuildHistory(
  sessionId: string,
  stateDir: string = getStateDir(),
): BuildHistoryRow[] {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  const rows = db
    .prepare(
      `SELECT build_id, session_id, state_dir, started_at, completed_at,
              node_count, leaf_count, depth, config_json, coherence_score, timed_out
       FROM raptor_build_history
       WHERE session_id = ?
       ORDER BY completed_at DESC`,
    )
    .all(sid) as Array<{
    build_id: string;
    session_id: string;
    state_dir: string;
    started_at: number;
    completed_at: number;
    node_count: number;
    leaf_count: number;
    depth: number;
    config_json: string;
    coherence_score: number | null;
    timed_out: number;
  }>;
  return rows.map((row) => ({
    buildId: row.build_id,
    sessionId: row.session_id,
    stateDir: row.state_dir,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    nodeCount: row.node_count,
    leafCount: row.leaf_count,
    depth: row.depth,
    configJson: row.config_json,
    coherenceScore: row.coherence_score,
    timedOut: row.timed_out === 1,
  }));
}

/**
 * Compute the average intra-cluster cosine similarity for a RAPTOR tree.
 * For each internal node, compute the mean pairwise cosine similarity of its
 * children's embeddings. Average across all internal nodes. Returns 0–1
 * (higher = more coherent clusters). A tree with no internal nodes returns 0.
 *
 * Child embeddings: a child that is itself an internal node contributes its own
 * centroid. A child id not in `tree.nodes` is a raw leaf — leaves are not stored
 * on RaptorNodes, so `leafEmbeddings` (id → embedding, from the build-time Leaf[]
 * set) supplies the true leaf embedding; if absent, we fall back to the parent
 * node's centroid. Passing `leafEmbeddings` is strongly recommended — without it
 * every leaf collapses to its parent's centroid and the score inflates to ~1.0.
 */
export function computeCoherenceScore(
  tree: RaptorTree,
  leafEmbeddings?: ReadonlyMap<string, number[]>,
): number {
  let sum = 0;
  let count = 0;
  for (const node of tree.nodes.values()) {
    if (node.embedding.length === 0) continue;
    const childEmbeddings: number[][] = [];
    for (const cid of node.children) {
      const child = tree.nodes.get(cid);
      if (child && child.embedding.length > 0) {
        childEmbeddings.push(child.embedding);
      } else {
        // Raw leaf: use its true embedding if known, else parent centroid.
        const leafEmb = leafEmbeddings?.get(cid);
        childEmbeddings.push(leafEmb && leafEmb.length > 0 ? leafEmb : node.embedding);
      }
    }
    if (childEmbeddings.length < 2) continue; // need >=2 to measure spread
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < childEmbeddings.length; i++) {
      for (let j = i + 1; j < childEmbeddings.length; j++) {
        pairSum += cosineSimilarity(childEmbeddings[i], childEmbeddings[j]);
        pairCount++;
      }
    }
    if (pairCount > 0) {
      sum += pairSum / pairCount;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Check if the RAPTOR tree is fresh enough to skip a rebuild.
 * Returns true iff:
 *   - a build-history row exists, AND
 *   - it completed within `freshnessHours`, AND
 *   - the checkpoint count has not changed by more than 20% since the build.
 * A `freshnessHours` of 0 always returns false (rebuild every time) — the spec's
 * "0 disables" escape hatch, symmetric to the S38 retry caps.
 */
export function isRaptorTreeFresh(
  sessionId: string,
  stateDir: string,
  freshnessHours: number,
  currentCheckpointCount: number,
): boolean {
  if (freshnessHours <= 0) return false;
  const latest = getLatestBuild(sessionId, stateDir);
  if (!latest) return false;
  const ageHours = (Date.now() - latest.completedAt) / 3_600_000;
  if (ageHours > freshnessHours) return false;
  if (latest.leafCount <= 0) return false;
  const changeRatio =
    Math.abs(currentCheckpointCount - latest.leafCount) / latest.leafCount;
  return changeRatio <= 0.2;
}

/** Clear build history for a session (used by tests + DR). */
export function clearBuildHistory(
  sessionId: string,
  stateDir: string = getStateDir(),
): void {
  const db: DatabaseSync = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  withTx(db, () => {
    db.prepare("DELETE FROM raptor_build_history WHERE session_id = ?").run(sid);
  });
}
