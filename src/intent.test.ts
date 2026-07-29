/**
 * intent.test.ts — S52A rewind-intent queue tests. No network; temp dirs.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTurnStore, closeAllTurnDbs } from "./store/turns/connection.js";
import { openIntentQueue } from "./intent.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-intent-"));
});

afterEach(() => {
	closeAllTurnDbs();
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

test("postIntent creates a pending intent", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const q = openIntentQueue(db);
	const intent = q.postIntent({ conversationId: "conv_a", targetTurnIndex: 3 });
	assert.equal(intent.conversationId, "conv_a");
	assert.equal(intent.targetTurnIndex, 3);
	assert.equal(intent.status, "pending");
	assert.ok(intent.id.length > 0);
	assert.ok(intent.createdAt > 0);
});

test("pendingIntents lists only unconsumed", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const q = openIntentQueue(db);
	q.postIntent({ conversationId: "c1", targetTurnIndex: 1 });
	const i2 = q.postIntent({ conversationId: "c2", targetTurnIndex: 2 });
	assert.equal(q.pendingIntents().length, 2);
	q.consumeIntent(i2.id);
	assert.equal(q.pendingIntents().length, 1);
	assert.equal(q.pendingIntents()[0].conversationId, "c1");
});

test("consumeIntent marks status consumed (not deleted)", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const q = openIntentQueue(db);
	const intent = q.postIntent({ conversationId: "c", targetTurnIndex: 0 });
	q.consumeIntent(intent.id);
	assert.equal(q.pendingIntents().length, 0);
	const all = q.allIntents();
	assert.equal(all.length, 1);
	assert.equal(all[0].status, "consumed");
	assert.equal(all[0].id, intent.id);
});

test("abandonIntent deletes the intent", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const q = openIntentQueue(db);
	const intent = q.postIntent({ conversationId: "c", targetTurnIndex: 0 });
	q.abandonIntent(intent.id);
	assert.equal(q.pendingIntents().length, 0);
	assert.equal(q.allIntents().length, 0);
});

test("allIntents returns newest-first + respects limit", () => {
	const dir = stateDir();
	const db = openTurnStore(dir);
	const q = openIntentQueue(db);
	q.postIntent({ conversationId: "a", targetTurnIndex: 0 });
	q.postIntent({ conversationId: "b", targetTurnIndex: 0 });
	q.postIntent({ conversationId: "c", targetTurnIndex: 0 });
	const all = q.allIntents();
	assert.equal(all.length, 3);
	// newest-first: c was posted last
	assert.equal(all[0].conversationId, "c");
	assert.equal(q.allIntents(2).length, 2);
});
