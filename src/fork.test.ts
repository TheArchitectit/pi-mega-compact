/**
 * fork.test.ts — S50C fork primitive tests. No network; temp dirs.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnStore } from "./store/turns/index.js";
import { forkFromConversation, ForkError } from "./fork.js";

let tmpDir: string;
let counter = 0;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mc-fork-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function stateDir(): string {
	return join(tmpDir, `run-${counter++}`);
}

test("fork resolves the turn + returns the recall set to rehydrate", () => {
	const dir = stateDir();
	const store = createTurnStore(dir);
	const conv = store.ensureConversationId("sess_f");
	const turnId = store.recordTurn({ conversationId: conv, sessionId: "sess_f", turnIndex: 2 });
	store.recordTurnRecall(turnId, [
		{ checkpointId: "cp_a", score: 0.9, source: "flat" },
		{ checkpointId: "cp_b", score: 0.7, source: "raptor", raptorLevel: 1 },
	]);
	const out = forkFromConversation(store, conv, 2);
	assert.ok(out.childConversationId.startsWith("conv_"));
	assert.notEqual(out.childConversationId, conv);
	assert.equal(out.forkTurn.turnIndex, 2);
	assert.deepEqual(out.checkpointIds.sort(), ["cp_a", "cp_b"]);
	assert.equal(out.recalled.length, 2);
	store.close();
});

test("unknown turn → ForkError TURN_NOT_FOUND", () => {
	const dir = stateDir();
	const store = createTurnStore(dir);
	const conv = store.ensureConversationId("sess_g");
	assert.throws(() => forkFromConversation(store, conv, 99), (e: unknown) => {
		return e instanceof ForkError && e.code === "TURN_NOT_FOUND";
	});
	store.close();
});

test("turn with no recall set → ForkError NO_RECALL", () => {
	const dir = stateDir();
	const store = createTurnStore(dir);
	const conv = store.ensureConversationId("sess_h");
	store.recordTurn({ conversationId: conv, sessionId: "sess_h", turnIndex: 0 });
	assert.throws(() => forkFromConversation(store, conv, 0), (e: unknown) => {
		return e instanceof ForkError && e.code === "NO_RECALL";
	});
	store.close();
});
