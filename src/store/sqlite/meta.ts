/**
 * meta.ts — `meta` table key/value helpers + cumulative counters
 * (tokens_saved, dedup stats, compact count, recall injected, cache-hit tokens).
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

/** Read a string-valued meta key (or undefined). Used for cumulative counters. */
export function getMeta(key: string, stateDir: string = getStateDir()): string | undefined {
  const db = openStore(stateDir);
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/**
 * Cumulative "tokens saved" — the sum of stored checkpoint token estimates across
 * all compactions in this store (one per repo). Persisted in the SQLite `meta`
 * table so it survives session restarts and travels with the repo's state dir,
 * mirroring how `storageDedupRate` is cumulative. Incremented in VectorStore.add()
 * when a new (non-deduped) checkpoint is persisted.
 */
export function getTokensSaved(stateDir: string = getStateDir()): number {
  const raw = getMeta("tokens_saved", stateDir);
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Add `delta` (>=0) to the cumulative tokens-saved counter. */
export function addTokensSaved(delta: number, stateDir: string = getStateDir()): void {
  if (!(delta > 0)) return;
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES('tokens_saved', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
  ).run(String(delta), delta);
}

/** Cumulative store-wide dedup accounting (Sprint 9+). Persisted in the SQLite
 *  `meta` table so it survives session restarts and travels with the repo's
 *  state dir — mirroring `tokens_saved`. Replaces the legacy JSON
 *  `dedup-stats.json` file (all stats now live in the SQLite store). */
export interface DedupStats {
  /** Total add() calls (new checkpoints + deduped collapses). */
  attempts: number;
  /** add() calls that collapsed onto an existing checkpoint. */
  deduped: number;
}

/** Read a store-wide integer counter from the meta table (0 if absent). */
export function getMetaNumber(key: string, stateDir: string = getStateDir()): number {
  const raw = getMeta(key, stateDir);
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Atomically add `delta` to an integer meta counter. */
function incMeta(key: string, delta: number, stateDir: string = getStateDir()): void {
  if (!(delta > 0)) return;
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
  ).run(key, String(delta), delta);
}

/** Read the cumulative store-wide dedup counters. */
export function getDedupStats(stateDir: string = getStateDir()): DedupStats {
  return {
    attempts: getMetaNumber("dedup_attempts", stateDir),
    deduped: getMetaNumber("deduped", stateDir),
  };
}

/** Increment the store-wide dedup counters for one add() call. */
export function bumpDedupStats(deduped: boolean, stateDir: string = getStateDir()): void {
  incMeta("dedup_attempts", 1, stateDir);
  if (deduped) incMeta("deduped", 1, stateDir);
}

// --- Live dashboard counters (schemaless meta key/value — NO migration) -----
// These reuse the private `incMeta` atomically-incrementing integer counter so
// all cumulative tallies live in the same `meta` table as tokens_saved etc.

export function incCompactCount(stateDir: string = getStateDir()): void {
  incMeta("compact_count", 1, stateDir);
}

export function getCompactCount(stateDir: string = getStateDir()): number {
  return getMetaNumber("compact_count", stateDir);
}

export function incRecallInjected(n: number, stateDir: string = getStateDir()): void {
  if (n > 0) incMeta("recall_injected", n, stateDir);
}

export function getRecallInjected(stateDir: string = getStateDir()): number {
  return getMetaNumber("recall_injected", stateDir);
}

export function incCacheHitTokens(delta: number, stateDir: string = getStateDir()): void {
  if (delta > 0) incMeta("cache_hit_tokens_saved", delta, stateDir);
}

export function getCacheHitTokensSaved(stateDir: string = getStateDir()): number {
  return getMetaNumber("cache_hit_tokens_saved", stateDir);
}
