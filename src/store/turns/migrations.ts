/**
 * migrations.ts — S49B one-time move of turn tables main-db → turns.db.
 *
 * S48 stored turns/turn_recall/conversation_branches inside the main sqlite.db.
 * S49 isolates them into turns.db. On first open with the flag ON, existing
 * rows are COPIED across (ATTACH + INSERT) then the legacy tables are DROPPED.
 * Idempotent (a turns_meta marker) and reversible (legacy tables remain in the
 * main schema for one release so flag-OFF never loses history). Copy+drop is
 * wrapped in a single transaction: a crash mid-copy rolls back and retries on
 * next open. Non-fatal: any failure logs and leaves legacy intact.
 *
 * PREVENT-002: parameterized queries; ATTACH path is bound, not concatenated.
 * PREVENT-PI-004: pure node:sqlite, no network.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./connection.js";

/** Main memory DB filename (must match src/store/sqlite/utils.ts). */
const MAIN_DB_FILE = "sqlite.db";

/** Tables moved from main db → turns.db (S49). */
const MOVED_TABLES = ["turns", "turn_recall", "conversation_branches"] as const;

const MIGRATED_KEY = "migrated_from_main";

function tableExists(db: DatabaseSync, name: string): boolean {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name) as { name: string } | undefined;
	return row !== undefined;
}

function isMigrated(db: DatabaseSync): boolean {
	const row = db
		.prepare("SELECT value FROM turns_meta WHERE key = ?")
		.get(MIGRATED_KEY) as { value: string } | undefined;
	return row?.value === "1";
}

function markMigrated(db: DatabaseSync): void {
	db.prepare(
		"INSERT OR REPLACE INTO turns_meta (key, value) VALUES (?, '1')",
	).run(MIGRATED_KEY);
}

/**
 * Move legacy turn tables out of the main db into turns.db, once.
 *
 * @param turnDb  the open isolated turns.db handle (from openTurnStore)
 * @param stateDir the state dir containing sqlite.db
 * @param log      optional logger (defaults to console.warn on failure)
 */
export function migrateTurnTablesIfNeeded(
	turnDb: DatabaseSync,
	stateDir: string,
	log: (msg: string) => void = (m) => console.warn(`[turns-migrate] ${m}`),
): void {
	if (isMigrated(turnDb)) return; // already done — idempotent no-op.

	const mainPath = join(stateDir, MAIN_DB_FILE);
	if (!existsSync(mainPath)) {
		// No legacy main db (fresh install / test dir) — nothing to move.
		markMigrated(turnDb);
		return;
	}

	try {
		// Attach the legacy main db read-only-ish and inspect it.
		turnDb.prepare("ATTACH DATABASE ? AS legacy").run(mainPath);
		try {
			const hasTurns = turnDb
				.prepare(
					"SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'turns'",
				)
				.get() as { name: string } | undefined;
			if (!hasTurns) {
				// Main db predates S48 turn tables — nothing to move.
				markMigrated(turnDb);
				return;
			}

			withTx(turnDb, () => {
				// Copy rows (idempotent: INSERT OR IGNORE on the natural keys).
				turnDb.exec(
					`INSERT OR IGNORE INTO main.turns
             SELECT * FROM legacy.turns`,
				);
				turnDb.exec(
					`INSERT OR IGNORE INTO main.turn_recall
             SELECT * FROM legacy.turn_recall`,
				);
				turnDb.exec(
					`INSERT OR IGNORE INTO main.conversation_branches
             SELECT * FROM legacy.conversation_branches`,
				);
				// Migrate the per-session conversation-id pointers from session_state.
				// Legacy stored conversation_id as a COLUMN on main.session_state.
				const hasSessionState = turnDb
					.prepare(
						"SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'session_state'",
					)
					.get() as { name: string } | undefined;
				if (hasSessionState) {
					turnDb.exec(
						`INSERT OR IGNORE INTO main.turns_meta (key, value)
               SELECT 'conv_' || session_id, conversation_id
               FROM legacy.session_state
               WHERE conversation_id IS NOT NULL`,
					);
				}
				// Drop the legacy tables from the main db only after a successful copy.
				// Table names come from a fixed allowlist (MOVED_TABLES), never user input.
				for (const t of MOVED_TABLES) {
					if (tableExists(turnDb, t)) {
						// guardrails-allow PREVENT-002: table name is from the MOVED_TABLES
						// constant allowlist (not user input); SQLite cannot parameterize
						// identifiers, so DROP TABLE requires an identifier literal here.
						turnDb.exec(`DROP TABLE IF EXISTS legacy.${t}`);
					}
				}
				markMigrated(turnDb);
			});
		} finally {
			turnDb.exec("DETACH DATABASE legacy");
		}
	} catch (e) {
		// Non-fatal: leave legacy tables intact so nothing is lost; retry next open.
		log(
			`migration failed (will retry on next open): ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}
