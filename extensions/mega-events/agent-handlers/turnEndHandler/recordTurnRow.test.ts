/**
 * recordTurnRow.test.ts — duplicate-turn-write regression test.
 *
 * Reproduces the 289 `turn_write_failed` events seen in events.log: the
 * turn_end handler calls recordTurnRow, which calls appendTurn. When the same
 * (conversationId, turnIndex) is written twice (a double-write race), the store
 * throws DuplicateTurnError. Before the fix, the catch block logged this as
 * `turn_write_failed` — a false failure that made the Turns tab + context
 * engine look broken.
 *
 * After the fix: the second write emits `turn_written` with `duplicate:true`
 * (the turn IS already in turns.db — the second append just collided).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTurnRow } from "./recordTurnRow.js";
import type { MegaRuntime } from "../../../mega-runtime.js";
import type { MegaConfig } from "../../../mega-config.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-dup-turn-"));
let counter = 0;

function stateDir(): string {
	return join(baseTmp, `run-${counter++}`);
}

/** Minimal mock runtime: captures dashboard.event() calls + the fields the handler reads. */
function mockRuntime(stateDir: string): { rt: MegaRuntime; events: { type: string; fields: Record<string, unknown> }[] } {
	const events: { type: string; fields: Record<string, unknown> }[] = [];
	const rt = {
		currentStateDir: stateDir,
		rt: { sessionId: "sess_dup" },
		pressureBand: "low",
		currentModel: { modelId: "test-model" },
		lastCtxTokens: 1000,
		lastCtxPercent: 10,
		dashboard: {
			event(type: string, fields: Record<string, unknown>) {
				events.push({ type, fields: { ...fields } });
			},
		},
	} as unknown as MegaRuntime;
	return { rt, events };
}

const configOn = { turnsDbEnabled: true } as unknown as MegaConfig;

function turnEndEvent(turnIndex: number) {
	return { turnIndex, message: { role: "assistant", stopReason: "stop" } };
}

test("recordTurnRow: double-write emits turn_written with duplicate:true (not turn_write_failed)", () => {
	const dir = stateDir();
	const { rt, events } = mockRuntime(dir);

	// First write: should succeed normally.
	recordTurnRow(turnEndEvent(0), rt, configOn);

	// Second write with the SAME turnIndex: this is the double-write race.
	// Before the fix, this emitted `turn_write_failed`. After the fix, it
	// emits `turn_written` with `duplicate:true` — the turn IS already in
	// turns.db; the second append just collided on the UNIQUE constraint.
	recordTurnRow(turnEndEvent(0), rt, configOn);

	// Assert: exactly 2 events, both `turn_written` (zero `turn_write_failed`).
	assert.equal(events.length, 2, "exactly 2 dashboard events (two writes)");

	const firstEv = events[0];
	const secondEv = events[1];

	assert.equal(firstEv.type, "turn_written", "first write → turn_written");
	assert.equal(
		(firstEv.fields as { duplicate?: boolean }).duplicate,
		undefined,
		"first write is NOT a duplicate",
	);

	assert.equal(secondEv.type, "turn_written", "second write → turn_written (NOT turn_write_failed)");
	assert.equal(
		(secondEv.fields as { duplicate?: boolean }).duplicate,
		true,
		"second write is marked duplicate:true",
	);

	// Sanity: no turn_write_failed events at all.
	const failures = events.filter((e) => e.type === "turn_write_failed");
	assert.equal(failures.length, 0, "zero turn_write_failed events for a duplicate write");
});

test("recordTurnRow: different turnIndex writes each succeed (no duplicate flag)", () => {
	const dir = stateDir();
	const { rt, events } = mockRuntime(dir);

	// Two writes with different turn indexes — both should be normal turn_written.
	recordTurnRow(turnEndEvent(0), rt, configOn);
	recordTurnRow(turnEndEvent(1), rt, configOn);

	assert.equal(events.length, 2, "exactly 2 dashboard events");
	assert.equal(events[0].type, "turn_written", "turn 0 → turn_written");
	assert.equal(events[1].type, "turn_written", "turn 1 → turn_written");
	assert.equal(
		(events[0].fields as { duplicate?: boolean }).duplicate,
		undefined,
		"turn 0 is NOT a duplicate",
	);
	assert.equal(
		(events[1].fields as { duplicate?: boolean }).duplicate,
		undefined,
		"turn 1 is NOT a duplicate",
	);
});

test("recordTurnRow cleanup", () => {
	rmSync(baseTmp, { recursive: true, force: true });
});
