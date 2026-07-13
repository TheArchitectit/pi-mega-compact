/**
 * integrity.ts — post-backfill / audit integrity checks (Sprint 10).
 *
 * Two checks (QA #1 / QA #14 spirit, re-mapped locally):
 *   1. Sentinel vs recomputed: the `session_state.stored_region_hashes` set must
 *      equal the set of `region_hash` values recomputed from `context_chunks`.
 *      A mismatch flags a tampered / stale sentinel (so the dedup sentinel can't
 *      miss a real duplicate).
 *   2. Orphan id detection: any `injected_checkpoint_ids` entry that does not
 *      correspond to a real `context_chunks.id` is orphaned and flagged.
 *
 * Pure read-only verification — never mutates; returns a structured report.
 * SQLite is the source of truth; no network (PREVENT-PI-004).
 */

import { openStore, listCheckpoints, loadSessionState } from "./sqlite.js";
import { getStateDir, normalizeSessionId } from "../store.js";

export interface IntegrityReport {
  sessionId: string;
  ok: boolean;
  storedRegionHashes: number;
  recomputedRegionHashes: number;
  regionHashMismatch: boolean;
  orphanInjectedIds: string[];
}

/** Verify one session's sentinel set + injected-id integrity. */
export function checkSessionIntegrity(
  sessionId: string,
  stateDir: string = getStateDir(),
): IntegrityReport {
  openStore(stateDir); // ensure schema is initialized for this state dir
  const sid = normalizeSessionId(sessionId);
  const state = loadSessionState(sessionId, stateDir);
  const checkpoints = listCheckpoints(sessionId, stateDir);

  // Recompute the region-hash set from the checkpoint rows (source of truth).
  const recomputed = new Set(checkpoints.map((c) => c.regionHash).filter(Boolean));
  const stored = new Set(state.storedRegionHashes);
  const regionHashMismatch =
    recomputed.size !== stored.size || [...recomputed].some((h) => !stored.has(h));

  // Orphan injected ids: referenced but no matching checkpoint.
  const validIds = new Set(checkpoints.map((c) => c.checkpointId));
  const orphanInjectedIds = state.injectedCheckpointIds.filter((id) => !validIds.has(id));

  return {
    sessionId: sid,
    ok: !regionHashMismatch && orphanInjectedIds.length === 0,
    storedRegionHashes: stored.size,
    recomputedRegionHashes: recomputed.size,
    regionHashMismatch,
    orphanInjectedIds,
  };
}

/** Check every session present in the store. */
export function checkAllIntegrity(stateDir: string = getStateDir()): IntegrityReport[] {
  const db = openStore(stateDir);
  const rows = db.prepare("SELECT DISTINCT session_id FROM context_chunks").all() as {
    session_id: string;
  }[];
  return rows.map((r) => checkSessionIntegrity(r.session_id, stateDir));
}
