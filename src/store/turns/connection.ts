/**
 * connection.ts — S49 reconciled turns.db connection manager.
 *
 * RECONCILIATION (s49-turn-db ∪ master): exposes master's contract-facing
 * `openTurnDb` / `closeTurnDb` / `closeAllTurnDbs` (consumed by SqliteTurnStore)
 * AND this branch's value-adds: closed-handle eviction, the MEGACOMPACT_TURNS_DB_PATH
 * env override, and the one-time main-db → turns.db migration (S49B) run after
 * schema init. The unified `initTurnSchema` (schema.ts) creates both the
 * contract tables and the S51/S52 additive shells.
 *
 * Separate cache from the main memory store (src/store/sqlite/utils.ts) so a
 * turn-DB failure can never touch the authoritative memory DB (program §2).
 * Pi-agnostic (PREVENT-PI-004: node:sqlite in-process, no network).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TurnsConfig } from "../../config/turns.js";
import { initTurnSchema } from "./schema.js";
import { migrateTurnTablesIfNeeded } from "./migrations.js";

/** Default turns.db filename within a state dir. */
export const TURNS_DB_FILE = "turns.db";

// Module-level cache, SEPARATE from the memory store's cache. Keyed by the
// resolved db path (or `:memory:<stateDir>` for in-memory).
const cache = new Map<string, DatabaseSync>();

/** Resolve the turns.db path (env override wins — tests/DR). */
export function turnDbPath(stateDir: string): string {
	const override = process.env.MEGACOMPACT_TURNS_DB_PATH;
	if (override && override.trim() !== "") return override;
	return join(stateDir, TURNS_DB_FILE);
}

/**
 * Open (or reuse) the isolated turn database connection. Contract-facing
 * shape consumed by `SqliteTurnStore`. Accepts `dbPath` / `inMemory` overrides
 * for tests. Runs the unified schema init + the one-time main-db migration.
 */
export function openTurnDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): DatabaseSync {
	const resolvedPath =
		options?.inMemory === true
			? ":memory:"
			: (options?.dbPath ?? turnDbPath(stateDir));
	const cacheKey = options?.inMemory ? `:memory:${stateDir}` : resolvedPath;

	const cached = cache.get(cacheKey);
	if (cached) {
		// A closed handle in the cache (test called db.close() directly) would
		// surface as "database is not open" on reuse. Detect + evict.
		try {
			cached.exec("SELECT 1");
			return cached;
		} catch {
			cache.delete(cacheKey);
		}
	}

	if (options?.inMemory !== true && !existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}
	const db = new DatabaseSync(resolvedPath);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	initTurnSchema(db);
	// S49B: one-time move of legacy main-db turn tables into turns.db (idempotent,
	// non-fatal). File-backed only; never runs for the in-memory test backend.
	if (options?.inMemory !== true && TurnsConfig.TURNS_DB_ENABLED) {
		migrateTurnTablesIfNeeded(db, stateDir);
	}
	cache.set(cacheKey, db);
	return db;
}

/**
 * Back-compat alias for callers (S51 topics store, dashboard routes) that open
 * a raw DatabaseSync against turns.db to run their own read queries. Equivalent
 * to `openTurnDb(stateDir)` (file-backed, default path).
 */
export function openTurnStore(stateDir: string): DatabaseSync {
	return openTurnDb(stateDir);
}

/** Back-compat alias: close the cached file-backed connection for a state dir. */
export function closeTurnStore(stateDir: string): void {
	closeTurnDb(stateDir);
}

/** Close and evict a cached connection. Idempotent. */
export function closeTurnDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): void {
	const resolvedPath =
		options?.inMemory === true
			? ":memory:"
			: (options?.dbPath ?? turnDbPath(stateDir));
	const cacheKey = options?.inMemory ? `:memory:${stateDir}` : resolvedPath;
	const db = cache.get(cacheKey);
	if (!db) return;
	db.close();
	cache.delete(cacheKey);
}

/** Close all cached connections (test teardown / graceful shutdown). */
export function closeAllTurnDbs(): void {
	for (const db of cache.values()) {
		try {
			db.close();
		} catch {
			// best-effort
		}
	}
	cache.clear();
}

/**
 * Run `fn` atomically. SAVEPOINT (not BEGIN) so it nests safely under an outer
 * transaction. Self-contained (not imported from memory utils) to keep the
 * reuse seam clean.
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
