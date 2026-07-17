/**
 * backfill.ts — resumable / idempotent hash backfill (Sprint 10).
 *
 * Purpose: populate `content_hash` / `content_hash2` / `content_hash_version` /
 * `normalized_text` for any rows left with null hashes (e.g. pre-Sprint-9 data
 * or rows that degraded to "store without dedup" under the QA #13 timeout).
 * Structured so Sprint 11 can plug in its own MinHash/LSH phase after the
 * content hashes land.
 *
 * Properties (QA #1 / QA #14):
 *   - Resumable: progress stored in a `backfill_progress` table (last processed id).
 *   - Idempotent: ON CONFLICT DO NOTHING + partial UNIQUE on (session_id, content_hash)
 *     make a second run a no-op where it safely can.
 *   - Batched: 1000 rows/commit to bound lock time; throttle between batches.
 *
 * SQLite is the source of truth; this touches no network (PREVENT-PI-004).
 */

import type { DatabaseSync } from "node:sqlite";
import { openStore } from "./sqlite.js";
import { computeContentDigest } from "../dedup/digest.js";
import { minhashSignature, SIGNATURE_VERSION, NUM_HASHES } from "../dedup/l1-minhash.js";
import { lshBands } from "../dedup/l1-lsh.js";
import { upsertMinhashSignature, insertLshBuckets, listCheckpoints, saveRaptorTree, withTx } from "./sqlite.js";
import { buildRaptorTree, type Leaf } from "../dedup/raptor/tree.js";
import type { Embedder } from "../embedder.js";
import { defaultEmbedder } from "../embedder.js";
import { getStateDir } from "../store.js";

const BATCH = 1000;
const THROTTLE_MS = 0; // synchronous backfill; no cross-process yield needed

/** Backfill phases, in order (Sprint 14 full-pipeline wiring). */
export type BackfillPhase = "L0" | "L1" | "L2" | "RAPTOR";

interface BackfillResult {
  processed: number;
  updated: number;
  duplicatesResolved: number;
}

interface PhaseProgressRow {
  last_session_id: string | null;
  last_id: string | null;
  processed: number;
}

function ensureProgressTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      name TEXT PRIMARY KEY,
      last_session_id TEXT, -- session of the highest (session_id, id) scanned
      last_id TEXT,         -- highest context_chunks.id scanned within that session
      updated INTEGER,
      duplicates_resolved INTEGER
    );
  `);
}

function progress(db: DatabaseSync): { lastSid: string | null; lastId: string | null; updated: number; dups: number } {
  const row = db
    .prepare("SELECT last_session_id, last_id, updated, duplicates_resolved FROM backfill_progress WHERE name='content_hashes'")
    .get() as { last_session_id: string | null; last_id: string | null; updated: number; duplicates_resolved: number } | undefined;
  return { lastSid: row?.last_session_id ?? null, lastId: row?.last_id ?? null, updated: row?.updated ?? 0, dups: row?.duplicates_resolved ?? 0 };
}

/**
 * Backfill content hashes for all rows missing them, from the last scanned
 * (session_id, id) forward. Returns counts; fully idempotent and resumable.
 */
export function backfillContentHashes(stateDir: string = getStateDir()): BackfillResult {
  const db = openStore(stateDir);
  ensureProgressTable(db);
  const start = progress(db);

  // Rows needing hashing: null content_hash, ordered by (session_id, id) for a
  // stable, resumable cursor (ids are only unique per session).
  const pending = db
    .prepare(
      `SELECT id, session_id, summary FROM context_chunks
       WHERE content_hash IS NULL
         AND (session_id > COALESCE(?, '')
              OR (session_id = COALESCE(?, '') AND id > COALESCE(?, '')))
       ORDER BY session_id ASC, id ASC LIMIT ?`,
    )
    .all(start.lastSid, start.lastSid, start.lastId, BATCH) as { id: string; session_id: string; summary: string }[];

  let updated = start.updated;
  let duplicatesResolved = start.dups;
  let processed = 0;
  let lastSid = start.lastSid;
  let lastId = start.lastId;

  function applyRows(rows: { id: string; session_id: string; summary: string }[]): void {
    const lookup = db.prepare(
      "SELECT id FROM context_chunks WHERE session_id = ? AND content_hash = ? AND content_hash2 = ? AND id != ? LIMIT 1",
    );
    const update = db.prepare(
      `UPDATE context_chunks
       SET content_hash=?, content_hash2=?, content_hash_version=?, normalized_text=?,
           dedup_status='active'
       WHERE id=?`,
    );
    for (const row of rows) {
      const digest = computeContentDigest(row.summary ?? "");
      // Keep the oldest row on a collision (partial UNIQUE would reject the
      // newer insert); mark the newer one as superseded-without-store.
      const clash = lookup.get(row.session_id, digest.contentHash, digest.contentHash2, row.id);
      if (clash) {
        db.prepare("UPDATE context_chunks SET dedup_status='dup-resolved' WHERE id=?").run(row.id);
        duplicatesResolved++;
      } else {
        update.run(
          digest.contentHash,
          digest.contentHash2,
          digest.contentHashVersion,
          digest.normalizedText,
          row.id,
        );
        updated++;
      }
      lastSid = row.session_id;
      lastId = row.id;
      processed++;
    }
  }

  if (pending.length > 0) {
    withTx(db, () => applyRows(pending));
    db.prepare(
      "INSERT INTO backfill_progress(name, last_session_id, last_id, updated, duplicates_resolved) VALUES('content_hashes',?,?,?,?) ON CONFLICT(name) DO UPDATE SET last_session_id=excluded.last_session_id, last_id=excluded.last_id, updated=excluded.updated, duplicates_resolved=excluded.duplicates_resolved",
    ).run(lastSid, lastId, updated, duplicatesResolved);
  }

  if (THROTTLE_MS > 0) {
    // No-op in this synchronous build; placeholder for future streaming backfill.
  }

  return { processed, updated, duplicatesResolved };
}

/** True when no rows remain pending (backfill complete for this state dir). */
export function isBackfillComplete(stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM context_chunks WHERE content_hash IS NULL")
    .get() as { c: number };
  return row.c === 0;
}

// ---- Sprint 14: L1 / L2 / RAPTOR phase backfill (resumable) ---------------

function phaseCursor(db: DatabaseSync, phase: BackfillPhase): { lastId: string | null; processed: number } {
  ensureProgressTable(db);
  const row = db
    .prepare("SELECT last_id, updated AS processed FROM backfill_progress WHERE name = ?")
    .get(`phase_${phase}`) as PhaseProgressRow | undefined;
  return { lastId: row?.last_id ?? null, processed: row?.processed ?? 0 };
}

function savePhaseCursor(db: DatabaseSync, phase: BackfillPhase, lastId: string | null, processed: number): void {
  db.prepare(
    `INSERT INTO backfill_progress(name, last_session_id, last_id, updated, duplicates_resolved)
     VALUES(?, NULL, ?, ?, 0)
     ON CONFLICT(name) DO UPDATE SET last_id=excluded.last_id, updated=excluded.updated`,
  ).run(`phase_${phase}`, lastId, processed);
}

export interface PhaseBackfillResult {
  phase: BackfillPhase;
  processed: number;
  batches: number;
  interrupted: boolean;
  /** Last processed checkpoint id (the resume cursor). */
  cursor: string | undefined;
}

/**
 * Backfill L1 (MinHash sigs + LSH buckets) or L2 (MinHash sigs only) derived
 * data for a session, in batches, resumable from the persisted cursor. Pass
 * `interruptAfterBatches` to simulate a crash for resume testing.
 */
export function backfillPhase(
  phase: "L1" | "L2",
  sessionId: string,
  stateDir: string,
  opts: { batchSize?: number; interruptAfterBatches?: number } = {},
): PhaseBackfillResult {
  const db = openStore(stateDir);
  const batchSize = opts.batchSize ?? BATCH;
  const all = listCheckpoints(sessionId, stateDir).sort((a, b) =>
    a.checkpointId.localeCompare(b.checkpointId),
  );
  const { lastId } = phaseCursor(db, phase);
  let { processed } = phaseCursor(db, phase);
  const startIndex = lastId ? all.findIndex((c) => c.checkpointId === lastId) + 1 : 0;

  let batches = 0;
  let interrupted = false;
  let cursor: string | undefined = lastId ?? undefined;

  for (let i = Math.max(0, startIndex); i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    withTx(db, () => {
      for (const cp of batch) {
        const sig = minhashSignature(cp.normalizedText ?? cp.summary ?? "");
        if (sig.length === NUM_HASHES) {
          upsertMinhashSignature(cp.checkpointId, sessionId, SIGNATURE_VERSION, sig, stateDir);
          if (phase === "L1") {
            insertLshBuckets(
              cp.checkpointId, sessionId, SIGNATURE_VERSION,
              lshBands(sig, sessionId, SIGNATURE_VERSION), stateDir,
            );
          }
        }
        cursor = cp.checkpointId;
        processed++;
      }
    });
    savePhaseCursor(db, phase, cursor ?? null, processed);
    batches++;
    if (THROTTLE_MS > 0) { const end = Date.now() + THROTTLE_MS; while (Date.now() < end) { /* throttle */ } }
    if (opts.interruptAfterBatches && batches >= opts.interruptAfterBatches) {
      interrupted = true;
      break;
    }
  }

  return { phase, processed, batches, interrupted, cursor };
}

/**
 * Backfill the RAPTOR tree for a session (single pass over all leaves). Builds
 * + persists raptor_nodes. Not batched — the builder has its own budget cap.
 */
export function backfillRaptor(
  sessionId: string,
  stateDir: string,
  embedder: Embedder = defaultEmbedder(),
): PhaseBackfillResult {
  const all = listCheckpoints(sessionId, stateDir).sort((a, b) =>
    a.checkpointId.localeCompare(b.checkpointId),
  );
  const leaves: Leaf[] = all.map((cp) => {
    const text = cp.normalizedText ?? cp.summary ?? "";
    return {
      id: cp.checkpointId,
      messages: [{ role: "user", text }],
      sourceText: text,
      embedding: embedder.embed(text),
    };
  });
  if (leaves.length === 0) {
    return { phase: "RAPTOR", processed: 0, batches: 0, interrupted: false, cursor: undefined };
  }
  const tree = buildRaptorTree(leaves, { embedder });
  // S25: freshness-guard timestamp = newest checkpoint's epoch.
  const builtAt = all.length > 0 ? Math.max(...all.map((c) => c.timestamp)) : Date.now();
  saveRaptorTree(sessionId, tree, Number.isFinite(builtAt) ? builtAt : Date.now(), stateDir);
  const db = openStore(stateDir);
  ensureProgressTable(db);
  savePhaseCursor(db, "RAPTOR", leaves[leaves.length - 1].id, leaves.length);
  return { phase: "RAPTOR", processed: leaves.length, batches: 1, interrupted: false, cursor: leaves[leaves.length - 1].id };
}
