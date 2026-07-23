/**
 * migrate.ts — Sprint 8: bring v0.1.0 JSON checkpoint files into SQLite.
 *
 * Reads every `<sessionId>.checkpoints.json.gz` in the state dir, computes the
 * dedup-tier columns (content_hash / content_hash2 / normalized_text) that
 * Sprints 9-12 match on, and upserts into context_chunks idempotently
 * (ON CONFLICT id DO NOTHING — re-running is a no-op). The JSON files are kept
 * as disaster-recovery snapshots; they are never deleted.
 *
 * Runs on first VectorStore construction (auto-migrate) and is also exposed for
 * the integration test to call explicitly.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir, readGzJson, normalizeSessionId } from "../store.js";
import type { StoredCheckpoint } from "../store.js";
import { openStore, upsertCheckpoint, listCheckpoints } from "./sqlite.js";
import { computeContentDigest } from "../dedup/digest.js";

/** Scan a state dir for v0.1.0 checkpoint JSON files. */
function legacyCheckpointFiles(stateDir: string): string[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).filter((f) => f.endsWith(".checkpoints.json.gz"));
}

/** Derive the normalized text + two content hashes for the dedup tiers. */
export function deriveContentHashes(cp: StoredCheckpoint): {
  normalizedText: string;
  contentHash: string;
  contentHash2: string;
} {
  // M1: use the SAME digest the live L0 path uses (computeContentDigest), so a
  // migrated checkpoint and a freshly-added one with identical summary content
  // produce identical (content_hash, content_hash2) and dedup against each other.
  // The old scheme used whitespace-only normalization (no NFC/lowercase/ANSI
  // strip) and a different hash2 basis (summary+topicSummary vs reversed text),
  // so migrated rows never matched live rows — excluding migrated data from
  // exact dedup. Migrated checkpoints have no stored regionText, so the summary
  // is the canonical basis (mirrors how the live path digests a summary region).
  const digest = computeContentDigest(cp.summary ?? "");
  return {
    normalizedText: digest.normalizedText,
    contentHash: digest.contentHash,
    contentHash2: digest.contentHash2,
  };
}

/** Read a single legacy checkpoint file (lossless: returns every stored field). */
export function readLegacyCheckpointFile(sessionId: string, stateDir: string = getStateDir()): StoredCheckpoint[] {
  const file = join(stateDir, `${normalizeSessionId(sessionId)}.checkpoints.json.gz`);
  return readGzJson<StoredCheckpoint[]>(file, []);
}

export interface MigrationResult {
  sessionsScanned: number;
  checkpointsMigrated: number;
  alreadyPresent: number;
}

/**
 * Migrate all legacy JSON checkpoint files in `stateDir` into SQLite.
 * Idempotent — safe to call repeatedly. Does not delete JSON files.
 */
export function migrateJsonToSqlite(stateDir: string = getStateDir()): MigrationResult {
  openStore(stateDir); // ensures schema exists
  const files = legacyCheckpointFiles(stateDir);
  let sessionsScanned = 0;
  let migrated = 0;
  let alreadyPresent = 0;

  for (const file of files) {
    // File name shape: <sessionId>.checkpoints.json.gz
    const sessionId = file.replace(/\.checkpoints\.json\.gz$/, "");
    const cps = readLegacyCheckpointFile(sessionId, stateDir);
    if (cps.length === 0) continue;
    sessionsScanned++;

    const existing = new Set(listCheckpoints(sessionId, stateDir).map((c) => c.checkpointId));
    for (const cp of cps) {
      if (existing.has(cp.checkpointId)) {
        alreadyPresent++;
        continue;
      }
      const { normalizedText, contentHash, contentHash2 } = deriveContentHashes(cp);
      upsertCheckpoint(
        { ...cp, summary: cp.summary ?? "", regionHash: cp.regionHash ?? "" },
        stateDir,
      );
      // Persist the extra dedup columns (upsertCheckpoint sets them null).
      setContentHashes(cp.checkpointId, contentHash, contentHash2, normalizedText, stateDir);
      migrated++;
    }
  }

  return { sessionsScanned, checkpointsMigrated: migrated, alreadyPresent };
}

// Direct column update for the computed hashes (kept out of upsertCheckpoint's
// hot path so the common write doesn't pay for hashing).
function setContentHashes(
  checkpointId: string,
  contentHash: string,
  contentHash2: string,
  normalizedText: string,
  stateDir: string,
): void {
  const Database = openStore(stateDir);
  Database.prepare(
    `UPDATE context_chunks
       SET content_hash = @ch, content_hash2 = @ch2,
           content_hash_version = 1, normalized_text = @nt
     WHERE id = @id`,
  ).run({ id: checkpointId, ch: contentHash, ch2: contentHash2, nt: normalizedText });
}
