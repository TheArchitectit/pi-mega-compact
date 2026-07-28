/**
 * connection.ts — S49 isolated turns.db connection.
 *
 * Separate connection cache + own WAL + own schema init from the main memory
 * store (src/store/sqlite/utils.ts openStore). This is the isolation that keeps
 * per-turn provenance writes off the authoritative memory DB (program §2).
 *
 * Self-contained: `withTx` is duplicated here (12 lines) instead of imported
 * from the memory utils so src/store/turns/ has NO dependency on the memory
 * module graph — that keeps the reuse seam clean for other hosts. Pi-agnostic.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getStateDir } from "../../store.js";
import { TurnsConfig } from "../../config/turns.js";
import { initTurnSchema } from "./schema.js";
import { migrateTurnTablesIfNeeded } from "./migrations.js";

/** Default turns.db filename within a state dir (override via TURNS_DB_PATH). */
export const TURNS_DB_FILE = "turns.db";

// Module-level connection cache, SEPARATE from the memory store's cache. One
// handle per resolved db path; cross-process durability via reopening the file.
const cache = new Map<string, DatabaseSync>();

/** Resolve the turns.db path for a state dir (env override wins — tests/DR). */
export function turnDbPath(stateDir: string = getStateDir()): string {
  const override = process.env.MEGACOMPACT_TURNS_DB_PATH;
  if (override && override.trim() !== "") return override;
  return join(stateDir, TURNS_DB_FILE);
}

/** Open (or reuse) the isolated turns store for a state dir. */
export function openTurnStore(stateDir: string = getStateDir()): DatabaseSync {
  const path = turnDbPath(stateDir);
  const existing = cache.get(path);
  if (existing) {
    // A closed handle in the cache (test called db.close() directly) would
    // surface as "database is not open" on next reuse. Detect + evict.
    try {
      existing.exec("SELECT 1");
      return existing;
    } catch {
      cache.delete(path);
    }
  }

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initTurnSchema(db);
  // S49B: one-time move of legacy main-db turn tables into turns.db (idempotent,
  // non-fatal). Runs only when the isolated store is enabled. Uses the real main
  // db file (sqlite.db) in the SAME state dir — never the test-only turns.db path.
  if (TurnsConfig.TURNS_DB_ENABLED) {
    migrateTurnTablesIfNeeded(db, stateDir);
  }
  cache.set(path, db);
  return db;
}

/** Close and evict a cached connection (test teardown only). */
export function closeTurnStore(stateDir: string = getStateDir()): void {
  const path = turnDbPath(stateDir);
  const db = cache.get(path);
  if (db) {
    db.close();
    cache.delete(path);
  }
}

/**
 * Run `fn` atomically. SAVEPOINT (not BEGIN) so it nests safely under an outer
 * transaction. Duplicated from memory utils to keep this module self-contained.
 */
export function withTx(db: DatabaseSync, fn: () => void): void {
  db.exec("SAVEPOINT turns_tx");
  try {
    fn();
    db.exec("RELEASE turns_tx");
  } catch (e) {
    db.exec("ROLLBACK TO turns_tx");
    db.exec("RELEASE turns_tx");
    throw e;
  }
}
