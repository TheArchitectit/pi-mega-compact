/**
 * recordTurnRow.test.ts — S49R unit test for the resume duplicate-turn fix.
 *
 * Uses a REAL turns.db (temp stateDir) + a mock MegaRuntime/MegaConfig. Asserts:
 *   - first session writes turn_index 0,1,2
 *   - resume (same convId, event.turnIndex resets to 0) continues at 3,4,5 with
 *     sessionTurnIndex 0,1,2 — no DuplicateTurnError
 *   - the dashboard payload still carries event.turnIndex (display only)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnStore, closeAllTurnDbs, type TurnStore } from "../../../../src/store/turns/index.js";
import { recordTurnRow } from "./recordTurnRow.js";
import type { MegaConfig } from "../../../mega-config.js";
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { TurnEndEvent } from "./event.js";

let dir: string;
let store: TurnStore;
let events: Array<Record<string, unknown>>;
let config: MegaConfig;
let runtime: MegaRuntime;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mc-rtr-"));
	store = createTurnStore({ stateDir: dir });
	events = [];
	config = {
		turnsDbEnabled: true,
	} as unknown as MegaConfig;
	runtime = {
		rt: { sessionId: "sess_rtr" },
		currentStateDir: dir,
		currentModel: { modelId: "test-model" },
		pressureBand: "green",
		lastCtxTokens: 100,
		lastCtxPercent: 0.5,
		recentInternalErrors: [] as string[],
		recordInternalError: (c: string) => {
			(runtime as unknown as { recentInternalErrors: string[] }).recentInternalErrors.push(c);
		},
		dashboard: { event: (type: string, data: Record<string, unknown>) => events.push({ type, ...data }) },
	} as unknown as MegaRuntime;
});

afterEach(() => {
	try {
		store.close();
	} catch {
		/* best-effort */
	}
	closeAllTurnDbs();
	rmSync(dir, { recursive: true, force: true });
});

function endEvent(turnIndex: number): TurnEndEvent {
	return {
		turnIndex,
		message: { role: "assistant", content: "x" },
	};
}

test("first session writes monotonic turn_index 0,1,2 with sessionTurnIndex matching", () => {
	for (let i = 0; i < 3; i++) {
		recordTurnRow(endEvent(i), runtime, config);
	}
	const turns = store.query({ conversationId: store.ensureConversationId("sess_rtr") });
	assert.equal(turns.length, 3);
	const indices = turns.map((t) => t.turnIndex).sort((a, b) => a - b);
	assert.deepEqual(indices, [0, 1, 2]);
	for (const t of turns) assert.equal(t.sessionTurnIndex, t.turnIndex);
});

test("resume (same convId, event.turnIndex resets 0) → continues 3,4,5, sessionTurnIndex 0,1,2, no DuplicateTurnError", () => {
	for (let i = 0; i < 3; i++) recordTurnRow(endEvent(i), runtime, config);
	// Resume: pi re-fires event.turnIndex 0,1,2 for NEW turns.
	for (let i = 0; i < 3; i++) recordTurnRow(endEvent(i), runtime, config);

	const turns = store.query({ conversationId: store.ensureConversationId("sess_rtr") });
	assert.equal(turns.length, 6);
	const indices = turns.map((t) => t.turnIndex).sort((a, b) => a - b);
	assert.deepEqual(indices, [0, 1, 2, 3, 4, 5]);

	// sessionTurnIndex for the resumed segment is 0,1,2 (carried from event).
	const resumed = turns
		.filter((t) => t.turnIndex >= 3)
		.map((t) => t.sessionTurnIndex)
		.sort((a, b) => (a ?? 0) - (b ?? 0));
	assert.deepEqual(resumed, [0, 1, 2]);

	// No turn_write_failed events.
	assert.equal(
		events.filter((e) => e.type === "turn_write_failed").length,
		0,
		"no duplicate-turn errors on resume",
	);
});

test("dashboard payload still carries event.turnIndex (display only)", () => {
	recordTurnRow(endEvent(0), runtime, config);
	recordTurnRow(endEvent(0), runtime, config); // resume event.turnIndex=0 again
	const written = events.filter((e) => e.type === "turn_written");
	assert.equal(written.length, 2);
	for (const w of written) {
		assert.equal(w.turnIndex, 0, "payload reports the per-session event.turnIndex");
	}
});

// Sprint H (Finding 3 / Option A): a turn-row write failure emits
// `turn_write_failed` AND feeds the separate `storeErrorRate` ring.
test("turn-row write failure → turn_write_failed + recordInternalError('store_write')", () => {
	// Point the state dir at a plain file so ensureConversationIdFor's DB open
	// throws — forcing the catch branch (real failure, no mock/stub).
	const badDir = join(dir, "not-a-dir");
	writeFileSync(badDir, "x");
	(runtime as unknown as { currentStateDir: string }).currentStateDir = badDir;

	recordTurnRow(endEvent(0), runtime, config);

	assert.equal(
		events.filter((e) => e.type === "turn_write_failed").length,
		1,
		"turn_write_failed emitted on failure",
	);
	assert.deepEqual(
		(runtime as unknown as { recentInternalErrors: string[] }).recentInternalErrors,
		["store_write"],
		"store-write failure recorded in the internal-error ring",
	);
});
