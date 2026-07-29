/**
 * turns.test.ts — S50C per-turn + per-conversation metrics tests. No network.
 * Seeds a turns.db (S49 contract store) and a main db (raw_transcript +
 * checkpoint_epochs) and asserts the rollups match seeded truth.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	createTurnStore,
	closeAllTurnDbs,
	type TurnStore,
} from "../store/turns/index.js";
import { openStore } from "../store/sqlite/utils.js";
import { appendRawTranscript } from "../store/sqlite/raw-transcript.js";
import { writeCheckpointEpoch } from "../store/sqlite/raw-transcript.js";
import { turnMetrics, conversationMetrics } from "./turns.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-metrics-"));
});

afterEach(() => {
	closeAllTurnDbs();
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

/** Seed one conversation: 2 turns, recall on turn 0, raw messages, one epoch. */
function seed(dir: string): { store: TurnStore; conv: string } {
	const store = createTurnStore({ stateDir: dir });
	const conv = store.ensureConversationId("sess_m");
	const t0 = store.appendTurn({
		conversationId: conv,
		sessionId: "sess_m",
		turnIndex: 0,
		role: "assistant",
		endedAt: Date.now(),
		ctxTokens: 800,
		ctxPercent: 0.4,
	});
	store.appendRecall({
		turnId: t0,
		checkpointId: "cp_1",
		score: 0.9,
		source: "checkpoint",
	});
	store.appendRecall({
		turnId: t0,
		checkpointId: "cp_2",
		score: 0.8,
		source: "checkpoint",
	});
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_m",
		turnIndex: 1,
		role: "assistant",
		endedAt: Date.now(),
		ctxTokens: 1200,
	});
	store.asAdmin().stampTurnsEpoch("sess_m", "ep_1");

	const main = openStore(dir);
	// 5 raw messages in the committed range; ep_1's summary is much smaller
	// (compression ratio < 1). turn_index is set on all of them.
	const msgs = [
		{ hash: "h0", turn: 0, bytes: "aaaaaaaa" },
		{ hash: "h1", turn: 0, bytes: "bbbbbbbb" },
		{ hash: "h2", turn: 1, bytes: "cccccccc" },
		{ hash: "h3", turn: 1, bytes: "dddddddd" },
		{ hash: "h4", turn: 1, bytes: "eeeeeeee" },
	];
	for (const m of msgs) {
		appendRawTranscript(main, {
			contentHash: m.hash,
			sessionId: "sess_m",
			seq: 0,
			role: "user",
			contentBytes: m.bytes,
			toolName: null,
			messageTimestamp: null,
			checkpointEpoch: "ep_1",
			turnIndex: m.turn,
		});
	}
	writeCheckpointEpoch(main, {
		epochId: "ep_1",
		sessionId: "sess_m",
		startedSeq: 0,
		committedSeq: 3,
		summaryMessageText: "sum",
		cutIndex: 3,
		checkpointId: "cp_x",
		createdAt: Date.now(),
	});
	return { store, conv };
}

test("turnMetrics returns per-turn recall + dedup + compression", () => {
	const dir = stateDir();
	const { store, conv } = seed(dir);
	const main = openStore(dir);
	const rows = turnMetrics(store, main, conv);
	assert.equal(rows.length, 2);
	const t0 = rows.find((r) => r.turnIndex === 0)!;
	assert.equal(t0.recallCount, 2);
	assert.equal(t0.rawMessageCount, 2);
	assert.equal(t0.dedupUniqueRatio, 1); // PK(content_hash,session_id) → all stored rows unique
	const t1 = rows.find((r) => r.turnIndex === 1)!;
	assert.equal(t1.rawMessageCount, 3);
	assert.equal(t1.epochId, "ep_1");
	assert.ok(t0.compressionRatio > 0 && t0.compressionRatio < 1); // summary smaller than raw
	store.close();
});

test("conversationMetrics aggregates per-turn metrics", () => {
	const dir = stateDir();
	const { store, conv } = seed(dir);
	const main = openStore(dir);
	const m = conversationMetrics(store, main, conv);
	assert.equal(m.turnCount, 2);
	assert.equal(m.totalRecall, 2);
	assert.equal(m.totalRawMessages, 5);
	assert.equal(m.epochCount, 1);
	assert.ok(m.avgDedupUniqueRatio > 0);
	store.close();
});

test("metrics tolerate a main db without raw_transcript (reuse host)", () => {
	const dir = stateDir();
	const store = createTurnStore({ stateDir: dir });
	const conv = store.ensureConversationId("sess_n");
	const t = store.appendTurn({
		conversationId: conv,
		sessionId: "sess_n",
		turnIndex: 0,
		role: "assistant",
		endedAt: Date.now(),
	});
	store.appendRecall({
		turnId: t,
		checkpointId: "cp",
		score: 0.5,
		source: "checkpoint",
	});
	// Bare in-memory db with NO raw_transcript / checkpoint_epochs tables.
	const bare = new DatabaseSync(":memory:");
	const rows = turnMetrics(store, bare, conv);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].recallCount, 1);
	assert.equal(rows[0].rawMessageCount, 0);
	assert.equal(rows[0].dedupUniqueRatio, 0);
	assert.equal(rows[0].compressionRatio, 0);
	store.close();
});
