/**
 * mega-turn-store.test.ts — S49C adapter routing tests.
 *
 * Proves the adapter writes to the isolated turns.db when turnsDbEnabled is
 * true and to the legacy main-db helpers when false. No network; temp dirs.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ensureConversationIdFor,
	recordTurnWrite,
	recordRecallWrite,
} from "./mega-turn-store.js";
import { closeTurnStore, turnDbPath } from "../src/store/turns/index.js";
import type { MegaConfig } from "./mega-config.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-adapter-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Minimal MegaConfig stub — only the flag the adapter reads. */
function cfg(turnsDbEnabled: boolean): MegaConfig {
	return { turnsDbEnabled } as unknown as MegaConfig;
}

test("flag ON → writes land in turns.db (not main sqlite.db)", () => {
	const dir = stateDir();
	const c = cfg(true);
	const conv = ensureConversationIdFor(c, "sess_on", dir);
	const turnId = recordTurnWrite(
		c,
		{
			conversationId: conv,
			sessionId: "sess_on",
			turnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
		},
		dir,
	);
	recordRecallWrite(
		c,
		turnId,
		[{ checkpointId: "cp_on", score: 0.5, source: "flat" }],
		dir,
	);
	closeTurnStore(dir);
	assert.ok(existsSync(turnDbPath(dir)), "turns.db should exist");
	assert.ok(
		!existsSync(join(dir, "sqlite.db")),
		"main sqlite.db must NOT be created on the flag-ON path",
	);
});

test("flag ON → hyde + recall telemetry round-trips into turns.db row", () => {
	const dir = stateDir();
	const c = cfg(true);
	const conv = ensureConversationIdFor(c, "sess_tele", dir);
	const turnId = recordTurnWrite(
		c,
		{
			conversationId: conv,
			sessionId: "sess_tele",
			turnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
			hyde: {
				ran: true,
				reason: "ran",
				hypotheticalDoc: "hypo doc",
				rawHitCount: 4,
				hydeHitCount: 6,
				fusedHitCount: 8,
				lift: 2,
				generationMs: 42,
			},
			recallMetrics: {
				score: 0.7,
				pass: true,
				relevance: 0.8,
				coverage: 0.6,
				diversity: 0.5,
				specificity: 0.4,
			},
		},
		dir,
	);
	assert.ok(turnId, "telemetry turn must have a turnId");
	const db = new DatabaseSync(turnDbPath(dir));
	const row = db
		.prepare("SELECT * FROM turns WHERE session_id = ?")
		.get("sess_tele") as Record<string, unknown>;
	assert.equal(row.hyde_ran, 1);
	assert.equal(row.hyde_doc, "hypo doc");
	assert.equal(row.hyde_lift, 2);
	assert.equal(row.hyde_generation_ms, 42);
	assert.equal(row.recall_score, 0.7);
	assert.equal(row.recall_pass, 1);
	assert.equal(row.recall_specificity, 0.4);
	db.close();
	closeTurnStore(dir);
});

test("flag OFF → writes land in main sqlite.db (legacy S48 path)", () => {
	const dir = stateDir();
	const c = cfg(false);
	const conv = ensureConversationIdFor(c, "sess_off", dir);
	const turnId = recordTurnWrite(
		c,
		{
			conversationId: conv,
			sessionId: "sess_off",
			turnIndex: 0,
			role: "assistant",
			endedAt: Date.now(),
		},
		dir,
	);
	recordRecallWrite(
		c,
		turnId,
		[{ checkpointId: "cp_off", score: 0.5, source: "flat" }],
		dir,
	);
	// Legacy helpers open the main sqlite.db.
	assert.ok(
		existsSync(join(dir, "sqlite.db")),
		"main sqlite.db should exist on the flag-OFF path",
	);
	assert.ok(
		!existsSync(turnDbPath(dir)),
		"turns.db must NOT be created on the flag-OFF path",
	);
	// And the row is actually in the main db's turns table.
	const main = new DatabaseSync(join(dir, "sqlite.db"));
	const rows = main
		.prepare("SELECT * FROM turns WHERE session_id = ?")
		.all("sess_off") as unknown[];
	assert.equal(rows.length, 1);
	main.close();
});
