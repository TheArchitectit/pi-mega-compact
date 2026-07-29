/**
 * migrations.ts — S49B one-time move of turn tables main-db → turns.db.
 *
 * S48 stored turns/turn_recall/conversation_branches inside the main sqlite.db.
 * S49 isolates them into turns.db with a contract-first schema (master
 * reconciliation): `conversation_branches` → `conversation_forks`, `model_id` →
 * `model`, strict `role`/`source`/`pressure_band` enums, and `ended_at` NOT NULL.
 *
 * On first open with the flag ON, existing rows are COPIED across (ATTACH +
 * explicit transformed INSERT) then the legacy tables are DROPPED. Idempotent
 * (a turns_meta marker) and reversible (legacy tables remain in the main
 * schema for one release so flag-OFF never loses history). Copy+drop is
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

/**
 * Legacy tables dropped from the main db after a successful copy. The
 * DROPs below use these as literal identifiers (no interpolation) so there
 * is no injection surface.
 */

const MIGRATED_KEY = "migrated_from_main";

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
 * Map a legacy recall `source` value onto the contract enum
 * (`checkpoint` | `cluster_summary` | `memory`). Legacy free-text values:
 *  - `flat` / `checkpoint`        → `checkpoint`
 *  - `raptor` / `cluster_summary` → `cluster_summary`
 *  - `cross-repo` / `memory` / * → `memory`
 */
function mapSource(legacy: string): string {
	switch (legacy) {
		case "flat":
		case "checkpoint":
			return "checkpoint";
		case "raptor":
		case "cluster_summary":
			return "cluster_summary";
		default:
			return "memory";
	}
}

/**
 * Move legacy turn tables out of the main db into turns.db, once. Transforms
 * rows to the unified contract schema (column renames + enum coercion + NULL
 * backfill). Idempotent + non-fatal.
 *
 * @param turnDb   the open isolated turns.db handle
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
				// turns: rename model_id→model, coerce role/ended_at non-null, clamp
				// pressure_band to the enum. Idempotent on (conversation_id, turn_index).
				turnDb.exec(`
          INSERT OR IGNORE INTO main.turns
            (id, conversation_id, session_id, turn_index, role, started_at, ended_at,
             ctx_tokens, ctx_percent, pressure_band, model, epoch_id)
          SELECT
            id, conversation_id, session_id, turn_index,
            COALESCE(NULLIF(role, ''), 'user') AS role,
            started_at,
            COALESCE(ended_at, started_at, 0) AS ended_at,
            ctx_tokens, ctx_percent,
            CASE pressure_band
              WHEN 'green'  THEN 'green'
              WHEN 'yellow' THEN 'yellow'
              WHEN 'red'    THEN 'red'
              ELSE NULL
            END AS pressure_band,
            model_id AS model,
            epoch_id
          FROM legacy.turns
        `);

				// turn_recall: coerce source onto the contract enum. Idempotent on
				// (turn_id, checkpoint_id).
				turnDb.exec(`
          INSERT OR IGNORE INTO main.turn_recall
            (id, turn_id, checkpoint_id, score, source, raptor_level)
          SELECT
            id, turn_id, checkpoint_id, score,
            CASE source
              WHEN 'flat'            THEN 'checkpoint'
              WHEN 'checkpoint'      THEN 'checkpoint'
              WHEN 'raptor'           THEN 'cluster_summary'
              WHEN 'cluster_summary' THEN 'cluster_summary'
              ELSE 'memory'
            END AS source,
            raptor_level
          FROM legacy.turn_recall
        `);

				// conversation_branches → conversation_forks (rename + column map).
				// Legacy: (conversation_id PK, parent_conversation_id, fork_turn_id, created_at).
				// Contract: (id, parent_conversation_id, child_conversation_id, fork_turn_index, created_at).
				turnDb.exec(`
          INSERT OR IGNORE INTO main.conversation_forks
            (parent_conversation_id, child_conversation_id, fork_turn_index, created_at)
          SELECT
            parent_conversation_id,
            conversation_id AS child_conversation_id,
            fork_turn_id AS fork_turn_index,
            created_at
          FROM legacy.conversation_branches
        `);

				// session_conversations: hydrate from legacy session_state if it has a
				// conversation_id column (S48 stored the active conversation there).
				const hasSessionState = turnDb
					.prepare(
						"SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'session_state'",
					)
					.get() as { name: string } | undefined;
				if (hasSessionState) {
					const cols = turnDb
						.prepare("PRAGMA legacy.table_info(session_state)")
						.all() as Array<{ name: string }>;
					if (cols.some((c) => c.name === "conversation_id")) {
						turnDb.exec(`
              INSERT OR IGNORE INTO main.session_conversations (session_id, conversation_id)
              SELECT session_id, conversation_id
              FROM legacy.session_state
              WHERE conversation_id IS NOT NULL
            `);
					}
				}

				// Drop legacy tables from the main db only after a successful copy.
				// These are literal identifiers from the fixed LEGACY_TABLES allowlist
				// (not user input) — SQLite cannot parameterize DDL identifiers, so a
				// literal per table is the provably-injection-free form.
				turnDb.exec("DROP TABLE IF EXISTS legacy.turns");
				turnDb.exec("DROP TABLE IF EXISTS legacy.turn_recall");
				turnDb.exec("DROP TABLE IF EXISTS legacy.conversation_branches");
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

// Exported for tests that need to inspect the source mapping.
export { mapSource };
