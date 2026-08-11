/**
 * connection.ts — PMA-1 connection manager for analytics.db.
 *
 * Own module-level connection cache, deliberately SEPARATE from the main
 * memory store (openStore) and the turns store (openTurnDb) so an analytics-DB
 * failure can never touch the authoritative memory DB or the turns DB (PMA §3.1).
 *
 * Mirrors src/store/turns/connection.ts. PREVENT-PI-004: node:sqlite in-process,
 * no network. PREVENT-002: parameterized path binding.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Db } from "node:sqlite";
import { initAnalyticsSchema } from "./schema.js";

export const ANALYTICS_DB_FILE = "analytics.db";

/** Resolve the analytics DB path, honoring the env override. */
export function analyticsDbPath(stateDir: string): string {
	const env = process.env.MEGACOMPACT_ANALYTICS_DB_PATH;
	if (env && env.trim() !== "") return env.trim();
	return join(stateDir, ANALYTICS_DB_FILE);
}

// Module-private cache — separate from openStore's cache and turns' cache.
const cache = new Map<string, DatabaseSync>();

/** File size helper (0 for in-memory). */
function dbFileSize(dbPath: string): number {
	try {
		return statSync(dbPath).size;
	} catch {
		return 0;
	}
}

/**
 * Open (or reuse from cache) the analytics.db for `stateDir`.
 * Sets PRAGMAs, initializes the schema, and caches the connection.
 * In-memory mode (`:memory:`) is supported for tests.
 */
export function openAnalyticsDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): DatabaseSync {
	const inMemory = options?.inMemory === true;
	const resolvedPath = inMemory ? ":memory:" : (options?.dbPath ?? analyticsDbPath(stateDir));
	const cacheKey = inMemory ? `:memory:${stateDir}` : resolvedPath;

	const cached = cache.get(cacheKey);
	if (cached) {
		try {
			cached.exec("SELECT 1");
			return cached;
		} catch {
			// Stale handle — evict and re-open.
			cache.delete(cacheKey);
		}
	}

	// Ensure the state dir exists for file-backed mode.
	if (!inMemory && !existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	const db = inMemory ? new Db(":memory:") : new Db(resolvedPath);
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");

	initAnalyticsSchema(db);
	cache.set(cacheKey, db);
	return db;
}

/** Close and evict the analytics DB for `stateDir` (idempotent). */
export function closeAnalyticsDb(
	stateDir: string,
	options?: { dbPath?: string; inMemory?: boolean },
): void {
	const inMemory = options?.inMemory === true;
	const resolvedPath = inMemory ? ":memory:" : (options?.dbPath ?? analyticsDbPath(stateDir));
	const cacheKey = inMemory ? `:memory:${stateDir}` : resolvedPath;

	const db = cache.get(cacheKey);
	if (!db) return;
	try {
		db.close();
	} catch {
		/* already closed */
	}
	cache.delete(cacheKey);
}

/** Close ALL cached analytics DBs (test teardown / graceful shutdown). */
export function closeAllAnalyticsDbs(): void {
	for (const db of cache.values()) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
	cache.clear();
}

/** Report the file size of analytics.db for a state dir (0 if absent/in-memory). */
export function analyticsDbSize(stateDir: string): number {
	return dbFileSize(analyticsDbPath(stateDir));
}

/**
 * SAVEPOINT-based transaction wrapper (nests safely under an outer transaction).
 * Uses a distinct savepoint name from the turns store (`turns_tx`) and the main
 * store (`mc_tx`) to avoid collisions.
 */
export function withTx(db: DatabaseSync, fn: () => void): void {
	db.exec("SAVEPOINT analytics_tx");
	try {
		fn();
		db.exec("RELEASE analytics_tx");
	} catch (e) {
		db.exec("ROLLBACK TO analytics_tx");
		db.exec("RELEASE analytics_tx");
		throw e;
	}
}
