/**
 * session-state.ts — `session_state` table (injection tracking).
 */
import type { DatabaseSync } from "node:sqlite";
import type { SessionState } from "../../store.js";
import { getStateDir, normalizeSessionId } from "../../store.js";
import { openStore, jsonText } from "./utils.js";

function loadSessionStateRow(sid: string, db: DatabaseSync): SessionState {
  const row = db.prepare("SELECT * FROM session_state WHERE session_id = ?").get(sid) as any;
  if (!row) {
    return { injectedCheckpointIds: [], storedRegionHashes: [] };
  }
  return {
    injectedCheckpointIds: row.injected_checkpoint_ids ? JSON.parse(row.injected_checkpoint_ids) : [],
    storedRegionHashes: row.stored_region_hashes ? JSON.parse(row.stored_region_hashes) : [],
  };
}

export function loadSessionState(sessionId: string, stateDir: string = getStateDir()): SessionState {
  return loadSessionStateRow(normalizeSessionId(sessionId), openStore(stateDir));
}

export function saveSessionState(sessionId: string, state: SessionState, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  const sid = normalizeSessionId(sessionId);
  db.prepare(
    `INSERT INTO session_state(session_id, injected_checkpoint_ids, stored_region_hashes)
     VALUES(@sid, @inj, @reg)
     ON CONFLICT(session_id) DO UPDATE SET
       injected_checkpoint_ids=excluded.injected_checkpoint_ids,
       stored_region_hashes=excluded.stored_region_hashes`,
  ).run({
    sid,
    inj: jsonText(state.injectedCheckpointIds),
    reg: jsonText(state.storedRegionHashes),
  });
}
