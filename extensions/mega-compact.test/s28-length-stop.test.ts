/**
 * s28-length-stop.test.ts — S28 length-stop auto-continue nudge + dashboard events.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, require } from "./_helpers.js";

function eventTypes(stateDir: string): string[] {
	const { readFileSync: rf, existsSync: ex } =
		require("node:fs") as typeof import("node:fs");
	const { join: j } = require("node:path") as typeof import("node:path");
	const logPath = j(stateDir, "events.log");
	if (!ex(logPath)) return [];
	const content = rf(logPath, "utf-8").trim();
	if (content.length === 0) return [];
	return content
		.split("\n")
		.map((line) => {
			try {
				return JSON.parse(line).type;
			} catch {
				return undefined;
			}
		})
		.filter((t): t is string => typeof t === "string");
}

test("S28: length-stop auto-continue nudges once, no ctx.compact on low-pressure length path", async () => {
	const h = harness();
	// Force a low-pressure context so the durable-trim branch (which calls
	// ctx.compact()) is NOT taken; only the length-stop nudge should fire.
	const lowPressureCtx = h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }),
	});
	// 1) Normal stop: no length flag armed → no nudge.
	await h.fire(
		"turn_end",
		{
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", stopReason: "stop" },
		},
		lowPressureCtx,
	);
	await h.fire(
		"agent_end",
		{ type: "agent_end", messages: [] },
		lowPressureCtx,
	);
	assert.equal(h.sendUserMessages.length, 0, "normal stop: no nudge");
	assert.equal(h.compactCalls.length, 0, "normal stop: no ctx.compact");

	// 2) Length stop: arms the flag, agent_end fires exactly one continue nudge
	//    that references the output-token truncation (not a compaction).
	await h.fire(
		"turn_end",
		{
			type: "turn_end",
			turnIndex: 2,
			message: { role: "assistant", stopReason: "length" },
		},
		lowPressureCtx,
	);
	await h.fire(
		"agent_end",
		{ type: "agent_end", messages: [] },
		lowPressureCtx,
	);
	assert.equal(h.sendUserMessages.length, 1, "length stop: exactly one nudge");
	assert.match(
		h.sendUserMessages[0],
		/output-token cap/,
		"length stop: nudge references the output-token truncation",
	);
	assert.equal(
		h.compactCalls.length,
		0,
		"length path: ctx.compact() NOT called (low pressure)",
	);

	// 3) One-shot: a second agent_end without a new length stop must NOT re-nudge.
	await h.fire(
		"agent_end",
		{ type: "agent_end", messages: [] },
		lowPressureCtx,
	);
	assert.equal(
		h.sendUserMessages.length,
		1,
		"one-shot: no second nudge without a new length stop",
	);
});

test("S28: length-stop auto-continue fires even when config.auto === false (autoContinueLengthStop is the sole gate)", async () => {
	// Disable auto (durable-trim + queued-resume) but keep the length-stop flag on.
	// Set BEFORE harness() loads the compiled extension so loadConfig() picks it up.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		// Re-load the extension with the new env so config.auto is false but
		// autoContinueLengthStop stays true (default).
		const h2 = harness();
		const lowPressureCtx = h2.ctx({
			isIdle: () => true,
			hasPendingMessages: () => false,
			getContextUsage: () => ({
				tokens: 100,
				contextWindow: 200000,
				percent: 0,
			}),
		});
		// Length stop arms the flag; agent_end must still nudge despite auto=false.
		await h2.fire(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", stopReason: "length" },
			},
			lowPressureCtx,
		);
		await h2.fire(
			"agent_end",
			{ type: "agent_end", messages: [] },
			lowPressureCtx,
		);
		assert.equal(
			h2.sendUserMessages.length,
			1,
			"auto=false: length stop still nudges",
		);
		assert.match(
			h2.sendUserMessages[0],
			/output-token cap/,
			"auto=false: nudge references the output-token truncation",
		);
		assert.equal(
			h2.compactCalls.length,
			0,
			"auto=false: ctx.compact() NOT called (auto gates durable-trim)",
		);
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("S28: length_stop + length_stop_continue dashboard events fire on the right paths", async () => {
	const h = harness();
	const lowPressureCtx = h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }),
	});
	// Normal stop: no length_stop event, no nudge, no length_stop_continue.
	await h.fire(
		"turn_end",
		{
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", stopReason: "stop" },
		},
		lowPressureCtx,
	);
	await h.fire(
		"agent_end",
		{ type: "agent_end", messages: [] },
		lowPressureCtx,
	);
	const afterNormal = eventTypes(h.stateDir);
	assert.ok(
		!afterNormal.includes("length_stop"),
		"normal stop: no length_stop dashboard event",
	);
	assert.ok(
		!afterNormal.includes("length_stop_continue"),
		"normal stop: no length_stop_continue dashboard event",
	);
	assert.equal(h.sendUserMessages.length, 0, "normal stop: no nudge");

	// Length stop: length_stop fires on turn_end, length_stop_continue on agent_end.
	await h.fire(
		"turn_end",
		{
			type: "turn_end",
			turnIndex: 2,
			message: { role: "assistant", stopReason: "length" },
		},
		lowPressureCtx,
	);
	const afterTurnEnd = eventTypes(h.stateDir);
	assert.ok(
		afterTurnEnd.includes("length_stop"),
		"length stop: length_stop dashboard event fired on turn_end",
	);
	await h.fire(
		"agent_end",
		{ type: "agent_end", messages: [] },
		lowPressureCtx,
	);
	const afterAgentEnd = eventTypes(h.stateDir);
	assert.ok(
		afterAgentEnd.includes("length_stop_continue"),
		"length stop: length_stop_continue dashboard event fired on agent_end",
	);
	assert.equal(h.sendUserMessages.length, 1, "length stop: exactly one nudge");
});

test("S28: non-length stopReasons do not arm the length-stop flag (no length_stop event); S38 owns error/aborted retries", async () => {
	const h = harness();
	const lowPressureCtx = h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }),
	});
	// S28 contract: every non-length StopReason must leave lengthStopPending unset,
	// so no length_stop event fires and no length-stop resume nudge is armed.
	// (S38 separately owns error/aborted — it WILL fire error-retry nudges for those;
	// this test only asserts the S28 length-stop flag is not armed.)
	let transientRetries = 0;
	for (const stopReason of ["tool_use", "error", "aborted"] as const) {
		const before = h.sendUserMessages.length;
		await h.fire(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", stopReason },
			},
			lowPressureCtx,
		);
		await h.fire(
			"agent_end",
			{ type: "agent_end", messages: [] },
			lowPressureCtx,
		);
		// tool_use is success (0 nudges); error is transient under S38 (1 retry);
		// aborted is classified as 'cancelled' (no retry — logged as
		// error_retry_cancelled, see agent-handlers.ts).
		if (stopReason === "tool_use" || stopReason === "aborted") {
			assert.equal(
				h.sendUserMessages.length - before,
				0,
				`${stopReason} (success/cancelled): no retry nudge`,
			);
		} else {
			transientRetries += h.sendUserMessages.length - before;
		}
	}
	// Only 'error' produces one S38 transient retry nudge (aborted is cancelled).
	assert.equal(
		transientRetries,
		1,
		"S38 owns error: 1 transient retry (aborted is cancelled, not retried)",
	);
	assert.ok(
		!eventTypes(h.stateDir).includes("length_stop"),
		"non-length stopReasons: no length_stop dashboard event",
	);
});

