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

// ── S49R: resume-divergence — raw_transcript join must not zero on resume ──
test("turnMetrics resumes: sessionTurnIndex re-keys raw_transcript join (no false zero)", () => {
	const dir = stateDir();
	const store = createTurnStore({ stateDir: dir });
	const conv = store.ensureConversationId("sess_r");
	// Pre-resume turns: monotonic 0,1 (session counter coincides).
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_r",
		turnIndex: 0,
		sessionTurnIndex: 0,
		role: "assistant",
		endedAt: Date.now(),
	});
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_r",
		turnIndex: 1,
		sessionTurnIndex: 1,
		role: "assistant",
		endedAt: Date.now() + 1,
	});
	// Resumed turns: monotonic 2,3 but session counter resets to 0,1.
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_r2",
		turnIndex: 2,
		sessionTurnIndex: 0,
		role: "assistant",
		endedAt: Date.now() + 2,
	});
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_r2",
		turnIndex: 3,
		sessionTurnIndex: 1,
		role: "assistant",
		endedAt: Date.now() + 3,
	});

	const main = openStore(dir);
	// raw_transcript keyed by SESSION counter 0,1 (as dbMirrorAppend seeds it
	// from runtime.currentTurn). 2 rows each → 4 raw messages total.
	const raw = [
		{ hash: "hr0", turn: 0 },
		{ hash: "hr1", turn: 0 },
		{ hash: "hr2", turn: 1 },
		{ hash: "hr3", turn: 1 },
	];
	// raw_transcript is keyed by (session_id, session turn_index). On a real
	// resume pi reuses the SAME sessionId, so the resumed-segment turns carry
	// the resumed session id — seed the raw rows under that session.
	for (const m of raw) {
		appendRawTranscript(main, {
			contentHash: m.hash,
			sessionId: "sess_r2",
			seq: 0,
			role: "user",
			contentBytes: "rawbytes",
			toolName: null,
			messageTimestamp: null,
			checkpointEpoch: "ep_r",
			turnIndex: m.turn,
		});
		// Mirror the raw rows under the pre-resume session so t0,t1 also join.
		appendRawTranscript(main, {
			contentHash: `pre-${m.hash}`,
			sessionId: "sess_r",
			seq: 0,
			role: "user",
			contentBytes: "rawbytes",
			toolName: null,
			messageTimestamp: null,
			checkpointEpoch: "ep_r",
			turnIndex: m.turn,
		});
	}

	const rows = turnMetrics(store, main, conv);
	assert.equal(rows.length, 4);
	// Resumed turns (monotonic 2,3) carry sessionTurnIndex 0,1 → join finds the
	// raw rows keyed by session counter. NOT zeroed.
	const t2 = rows.find((r) => r.turnIndex === 2)!;
	const t3 = rows.find((r) => r.turnIndex === 3)!;
	assert.equal(t2.rawMessageCount, 2, "resumed turn 2 joins via sessionTurnIndex");
	assert.equal(t3.rawMessageCount, 2, "resumed turn 3 joins via sessionTurnIndex");
	// Pre-resume turns (session counter == monotonic) also join.
	const t0 = rows.find((r) => r.turnIndex === 0)!;
	const t1 = rows.find((r) => r.turnIndex === 1)!;
	assert.equal(t0.rawMessageCount, 2);
	assert.equal(t1.rawMessageCount, 2);
	store.close();
});

test("turnMetrics pre-migration rows (NULL sessionTurnIndex) still join via coalesce", () => {
	const dir = stateDir();
	const store = createTurnStore({ stateDir: dir });
	const conv = store.ensureConversationId("sess_pm");
	// No sessionTurnIndex → row has NULL session_turn_index; turnIndex IS the
	// session counter for these legacy rows.
	store.appendTurn({
		conversationId: conv,
		sessionId: "sess_pm",
		turnIndex: 0,
		role: "assistant",
		endedAt: Date.now(),
	});
	const main = openStore(dir);
	appendRawTranscript(main, {
		contentHash: "hpm",
		sessionId: "sess_pm",
		seq: 0,
		role: "user",
		contentBytes: "rawpm",
		toolName: null,
		messageTimestamp: null,
		checkpointEpoch: "ep_pm",
		turnIndex: 0,
	});
	const rows = turnMetrics(store, main, conv);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].rawMessageCount, 1, "NULL sessionTurnIndex falls back to turnIndex");
	store.close();
});
