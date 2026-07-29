/**
 * migrations.test.ts — S49B main-db → turns.db migration tests.
 *
 * Seeds a legacy main sqlite.db (with S48-era turn tables + session_state
 * conversation pointers), then opens the turns store and asserts rows moved,
 * legacy dropped, and the move is idempotent + flag-gated. No network.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTurnStore, closeTurnStore } from "./connection.js";
import { TurnsConfig } from "../../config/turns.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-migrate-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Seed a legacy main db with S48-era turn tables + a conversation pointer. */
function seedLegacyMainDb(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, "sqlite.db"));
	db.exec(`
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, role TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER, ctx_tokens INTEGER,
      ctx_percent REAL, pressure_band TEXT, model_id TEXT, epoch_id TEXT,
      UNIQUE(session_id, turn_index)
    );
    CREATE TABLE turn_recall (
      id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id INTEGER NOT NULL,
      checkpoint_id TEXT NOT NULL, score REAL NOT NULL, source TEXT NOT NULL,
      raptor_level INTEGER, UNIQUE(turn_id, checkpoint_id)
    );
    CREATE TABLE conversation_branches (
      conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL,
      fork_turn_id INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE session_state (
      session_id TEXT PRIMARY KEY, injected_checkpoint_ids TEXT,
      stored_region_hashes TEXT, conversation_id TEXT, last_turn_id INTEGER
    );
    INSERT INTO turns (conversation_id, session_id, turn_index, started_at, ended_at, ctx_tokens)
      VALUES ('conv_leg', 'sess_leg', 0, 100, 200, 500);
    INSERT INTO turn_recall (turn_id, checkpoint_id, score, source)
      VALUES (1, 'cp_leg', 0.6, 'flat');
    INSERT INTO conversation_branches (conversation_id, parent_conversation_id, fork_turn_id, created_at)
      VALUES ('conv_child', 'conv_leg', 1, 300);
    INSERT INTO session_state (session_id, conversation_id) VALUES ('sess_leg', 'conv_leg');
  `);
	db.close();
}

function tableExists(db: DatabaseSync, name: string): boolean {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
			.get(name) !== undefined
	);
}

test("fresh dir (no main db) → no-op, marks migrated", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	// openTurnStore ran the migration hook; with no sqlite.db it should just mark.
	const row = db
		.prepare("SELECT value FROM turns_meta WHERE key='migrated_from_main'")
		.get() as { value: string } | undefined;
	assert.equal(row?.value, "1");
	closeTurnStore(dir);
});

test("legacy rows moved, legacy tables dropped, conversation pointer migrated", () => {
	const dir = stateDir();
	seedLegacyMainDb(dir);
	const db = openTurnStore(dir); // triggers migration

	// Rows present in turns.db.
	const turns = db.prepare("SELECT * FROM turns").all() as Array<
		Record<string, unknown>
	>;
	assert.equal(turns.length, 1);
	assert.equal(turns[0].conversation_id, "conv_leg");
	const recall = db.prepare("SELECT * FROM turn_recall").all() as Array<
		Record<string, unknown>
	>;
	assert.equal(recall.length, 1);
	assert.equal(recall[0].checkpoint_id, "cp_leg");
		const branches = db
				.prepare("SELECT * FROM conversation_forks")
				.all() as Array<Record<string, unknown>>;
		assert.equal(branches.length, 1);
		assert.equal(branches[0].parent_conversation_id, "conv_leg");
		assert.equal(branches[0].child_conversation_id, "conv_child");
		assert.equal(branches[0].fork_turn_index, 1);
		// Conversation pointer migrated to session_conversations (session_id → conversation_id).
		const ptr = db
				.prepare("SELECT conversation_id FROM session_conversations WHERE session_id='sess_leg'")
				.get() as { conversation_id: string } | undefined;
		assert.equal(ptr?.conversation_id, "conv_leg");

	closeTurnStore(dir);

	// Legacy tables dropped from the main db.
	const main = new DatabaseSync(join(dir, "sqlite.db"));
	assert.ok(!tableExists(main, "turns"));
	assert.ok(!tableExists(main, "turn_recall"));
	assert.ok(!tableExists(main, "conversation_branches"));
	assert.ok(tableExists(main, "session_state")); // left intact
	main.close();
});

test("idempotent: re-open does not re-copy or re-drop", () => {
	const dir = stateDir();
	seedLegacyMainDb(dir);
	openTurnStore(dir);
	closeTurnStore(dir);
	// Second open — marker set, should be a no-op even though main db now lacks turn tables.
	const db = openTurnStore(dir);
	const turns = db.prepare("SELECT * FROM turns").all() as Array<
		Record<string, unknown>
	>;
	assert.equal(turns.length, 1); // still exactly the migrated row, not duplicated
	closeTurnStore(dir);
});

test("flag OFF → legacy tables untouched, no marker write from hook", () => {
	const dir = stateDir();
	seedLegacyMainDb(dir);
	const original = TurnsConfig.TURNS_DB_ENABLED;
	TurnsConfig.TURNS_DB_ENABLED = false;
	try {
		const db = openTurnStore(dir);
		closeTurnStore(dir);
		void db;
	} finally {
		TurnsConfig.TURNS_DB_ENABLED = original;
	}
	// Main db turn tables must be intact (migration hook was gated off).
	const main = new DatabaseSync(join(dir, "sqlite.db"));
	assert.ok(tableExists(main, "turns"));
	assert.ok(tableExists(main, "conversation_branches"));
	main.close();
});
