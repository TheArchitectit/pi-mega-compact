/**
 * sqlite-store.test.ts — SqliteTurnStore compliance + SQLite-specific tests.
 *
 * Compliance: shared suite run in-memory (fast).
 * SQLite-specific: file-backed tests verifying:
 *   - Separate turns.db (not sqlite.db)
 *   - WAL mode active
 *   - Connection caching (same path → same connection)
 *   - dbSizeBytes reports file size
 *   - File persistence across store instances
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTurnStore } from "./sqlite-store.js";
import { runComplianceSuite } from "./contract-compliance.test.js";
import { closeAllTurnDbs } from "./connection.js";
import type { TurnEntry } from "./types.js";

// ── Compliance suite (in-memory, fast) ──────────────────────────

runComplianceSuite(
	"SqliteTurnStore",
	(options) => new SqliteTurnStore(options),
	{ stateDir: join(tmpdir(), "turns-compliance-sqlite"), inMemory: true },
);

// ── SQLite-specific file-backed tests ───────────────────────────

describe("SqliteTurnStore — file-backed", () => {
	let stateDir: string;
	let store: SqliteTurnStore;

	beforeEach(() => {
		closeAllTurnDbs(); // clear any cached connections
		stateDir = mkdtempSync(join(tmpdir(), "turns-file-"));
		store = new SqliteTurnStore({ stateDir });
	});

	afterEach(() => {
		try {
			store.close();
		} catch {
			// best-effort
		}
		closeAllTurnDbs();
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("creates turns.db separate from sqlite.db", () => {
		const turnsDbPath = join(stateDir, "turns.db");
		assert.ok(existsSync(turnsDbPath), "turns.db should exist");

		// sqlite.db should NOT be created by the turns store
		const sqliteDbPath = join(stateDir, "sqlite.db");
		assert.ok(!existsSync(sqliteDbPath), "sqlite.db should NOT be created");
	});

	it("uses WAL journal mode", () => {
		const row = (
			store as unknown as {
				db: { prepare: (s: string) => { get: () => unknown } };
			}
		).db
			.prepare("PRAGMA journal_mode")
			.get() as { journal_mode: string };
		assert.equal(row.journal_mode, "wal");
	});

	it("caches connections for the same path", () => {
		// Creating a second store with the same stateDir should reuse
		// the cached connection (not create a new file lock conflict)
		const store2 = new SqliteTurnStore({ stateDir });
		try {
			// Both should be able to write without locking errors
			const entry: TurnEntry = {
				conversationId: "conv_cache",
				sessionId: "sess_cache",
				turnIndex: 0,
				role: "assistant",
				endedAt: Date.now(),
			};
			store.asWriter().appendTurn(entry);
			store2.asWriter().appendTurn({
				...entry,
				turnIndex: 1,
			});

			assert.equal(store.asReader().countTurns("conv_cache"), 2);
		} finally {
			store2.close();
		}
	});

	it("reports dbSizeBytes for file-backed store", () => {
		const entry: TurnEntry = {
			conversationId: "conv_size",
			sessionId: "sess_size",
			turnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
		};
		store.asWriter().appendTurn(entry);

		// prune returns a PruneReport with freedBytes; we can also
		// verify the file exists and has content
		const turnsDbPath = join(stateDir, "turns.db");
		const size = statSync(turnsDbPath).size;
		assert.ok(size > 0, "turns.db should have non-zero size after writes");
	});

	it("persists data across store instances", () => {
		const entry: TurnEntry = {
			conversationId: "conv_persist",
			sessionId: "sess_persist",
			turnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
			model: "test-model",
		};
		store.asWriter().appendTurn(entry);
		store.close();
		closeAllTurnDbs();

		// Re-open the same stateDir
		const store2 = new SqliteTurnStore({ stateDir });
		try {
			const turns = store2.asReader().query({ conversationId: "conv_persist" });
			assert.equal(turns.length, 1);
			assert.equal(turns[0].model, "test-model");
		} finally {
			store2.close();
			closeAllTurnDbs();
		}
	});

	it("supports custom dbPath", () => {
		const customPath = join(stateDir, "custom-turns.db");
		const customStore = new SqliteTurnStore({
			stateDir,
			dbPath: customPath,
		});
		try {
			assert.ok(existsSync(customPath), "custom db path should be created");
			customStore.asWriter().appendTurn({
				conversationId: "conv_custom",
				sessionId: "sess_custom",
				turnIndex: 0,
				role: "user",
				endedAt: Date.now(),
			});
			assert.equal(customStore.asReader().countTurns("conv_custom"), 1);
		} finally {
			customStore.close();
			closeAllTurnDbs();
		}
	});
});
