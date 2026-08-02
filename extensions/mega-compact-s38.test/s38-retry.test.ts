/**
 * s38-retry.test.ts — S38 error-retry nudges + S38.5 race guard.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, s38TurnEnd, eventTypes } from "./_helpers.js";


test("S38: context-overflow fires NO blind retry nudge and logs 'context_overflow'", async () => {
	const h = harness();
	await s38TurnEnd(
		h,
		"error",
		"Your conversation is too long for this model's context window even after compaction. Reduce the conversation length or enable/allow compaction.",
	);
	const ev = eventTypes(h.stateDir);
	assert.equal(h.sendUserMessages.length, 0, "context-overflow: NO blind retry nudge fired");
	assert.ok(ev.includes("context_overflow"), "context-overflow: 'context_overflow' event logged");
});

test("S38: ESC-abort (stopReason='aborted') fires NO retry nudge and logs 'error_retry_cancelled'", async () => {
	const h = harness();
	await s38TurnEnd(h, "aborted", "Operation aborted");
	const ev = eventTypes(h.stateDir);
	assert.equal(h.sendUserMessages.length, 0, "cancelled: NO retry nudge fired after ESC abort");
	assert.ok(ev.includes("error_retry_cancelled"), "cancelled: 'error_retry_cancelled' event logged");
});

test("S38: ESC-abort resets errorRetryCount and consecutiveErrors so next transient retry starts fresh", async () => {
	const h = harness();
	// First: simulate an ESC abort (should reset both counters to 0)
	await s38TurnEnd(h, "aborted", "Operation aborted");
	assert.equal(h.sendUserMessages.length, 0, "cancelled: no nudge on abort");
	// Then: simulate a real transient error — should fire a fresh retry from count=1
	await s38TurnEnd(h, "error", "500 Internal Server Error");
	assert.equal(h.sendUserMessages.length, 1, "transient after cancel: retry fires from fresh count");
});

test("S38: compaction-noop logs 'compaction_noop_diagnostic' + resets counter + no retry fired", async () => {
	const h = harness();
	await s38TurnEnd(h, "error", "Already compacted");
	const ev = eventTypes(h.stateDir);
	assert.ok(ev.includes("compaction_noop_diagnostic"), "compaction-noop: diagnostic event logged");
	assert.equal(h.sendUserMessages.length, 0, "compaction-noop: NO retry nudge fired");
});

test("S38: compaction-noop does NOT fire pi.sendUserMessage (NOT retryable)", async () => {
	const h = harness();
	await s38TurnEnd(h, "error", "Nothing to compact");
	assert.equal(h.sendUserMessages.length, 0, "compaction-noop: no sendUserMessage");
	assert.ok(eventTypes(h.stateDir).includes("compaction_noop_diagnostic"));
});

test("S38: R1 burst of immediate transient errors fires 1 nudge (dedup), rest suppressed by retryNudgePending", async () => {
	// R1 redesign: a burst of immediate error turn_ends (no turn_start between)
	// produces ONE nudge — the rest are suppressed by retryNudgePending because
	// the queued nudge (deliverAs:'followUp') has not been consumed by a new
	// agent turn. errorRetryCount still advances for each error turn, so the
	// per-burst max + circuit breaker still bound the burst.
	// R10: disable outage advisory so this test isolates nudge dedup only.
	const prevOutage = process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
	process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = "0";
	try {
		const h = harness();
		for (let i = 0; i < 5; i++) await s38TurnEnd(h, "error", `internal server error ${i}`);
		assert.equal(h.sendUserMessages.length, 1, "R1 dedup: 1 nudge in burst (rest suppressed)");
		// The 6th turn reaches count=6 > max=5 → exhausted (count advances even for dedup'd turns).
		await s38TurnEnd(h, "error", "internal server error 5");
		assert.equal(h.sendUserMessages.length, 1, "exhausted: still 1 nudge (no 6th)");
		assert.ok(eventTypes(h.stateDir).includes("error_retry_exhausted"), "exhausted event logged on max+1");
		assert.ok(eventTypes(h.stateDir).includes("error_retry_dedup_skip"), "dedup_skip events logged for suppressed turns");
	} finally {
		if (prevOutage === undefined) delete process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
		else process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = prevOutage;
	}
});

test("S38: retry fires 1x for permanent errors then stops", async () => {
	const h = harness();
	await s38TurnEnd(h, "error", "invalid api key");
	assert.equal(h.sendUserMessages.length, 1, "permanent: 1 retry nudge (<= max 1)");
	await s38TurnEnd(h, "error", "invalid api key");
	assert.equal(h.sendUserMessages.length, 1, "permanent: exhausted -> no 2nd nudge");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_exhausted"), "permanent exhausted logged");
});

test("S38: successful turn (stop/toolUse) resets the retry counter", async () => {
	// R1: backoff is now gating, so use a tiny backoff + small wait to let the
	// second nudge fire after the success reset clears retryNudgePending (R4).
	const prev = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await s38TurnEnd(h, "error", "5xx server error 0");
		assert.equal(h.sendUserMessages.length, 1, "first transient: 1 nudge");
		await s38TurnEnd(h, "stop");
		assert.equal(h.sendUserMessages.length, 1, "success: no nudge, resets pending (R4)");
		await new Promise((r) => setTimeout(r, 5)); // let backoff elapse
		await s38TurnEnd(h, "error", "5xx server error 1");
		assert.equal(h.sendUserMessages.length, 2, "success reset -> transient fires again from count=1");
	} finally {
		if (prev === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prev;
	}
});

test("S38: error_retry_exhausted event logged when max exceeded", async () => {
	// R3: "malformed bad request" is now poisoned-context (not permanent), so
	// use an auth-derived permanent error to exercise the per-burst exhausted path.
	const h = harness();
	await s38TurnEnd(h, "error", "unauthorized: invalid api key");
	await s38TurnEnd(h, "error", "unauthorized: invalid api key");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_exhausted"), "error_retry_exhausted logged");
});

test("S38: MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0 disables transient retries cleanly", async () => {
	const prev = process.env.MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX;
	process.env.MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX = "0";
	try {
		const h = harness();
		await s38TurnEnd(h, "error", "network timeout");
		assert.equal(h.sendUserMessages.length, 0, "max=0: no transient retry nudge");
		assert.ok(!eventTypes(h.stateDir).includes("error_retry"), "max=0: no error_retry event");
	} finally {
		if (prev === undefined) delete process.env.MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX;
		else process.env.MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX = prev;
	}
});

test("S38: no retry for missing stopReason without error/0-token usage", async () => {
	// Missing stopReason alone is not sufficient — must have error or 0-token.
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant" } }, lowCtx);
	assert.equal(h.sendUserMessages.length, 0, "no retry nudge for missing stopReason without error/0-token");
});

test("S38: retry fires for error objects with message field", async () => {
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant", error: { message: "Connection reset by peer" } } }, lowCtx);
	assert.equal(h.sendUserMessages.length, 1, "error object with message: 1 retry nudge fired");
});

test("S38: retry fires for partial content with no stopReason BUT an error field (corroborated)", async () => {
	// The post-resume disconnect case: provider streamed partial content then
	// died mid-stream with NO stopReason. Corroborated by the error field.
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "Here is the start of the answer" }], stopReason: undefined, error: { message: "connection reset" } },
	}, lowCtx);
	assert.equal(h.sendUserMessages.length, 1, "partial-content mid-response failure: 1 retry nudge fired");
	assert.ok(eventTypes(h.stateDir).includes("error_retry"), "error_retry event logged for partial-content failure");
});

test("S38.5: MEGACOMPACT_RACE_GUARD_STRICT=false reverts to synchronous 10s guard", async () => {
	const prev = process.env.MEGACOMPACT_RACE_GUARD_STRICT;
	const prevFloor = process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_RACE_GUARD_STRICT = "false";
	process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
	try {
		const h = harness();
		const hiCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
		await h.fire("agent_end", { type: "agent_end", messages: [] }, hiCtx);
		assert.ok(h.compactCalls.length >= 1, "non-strict: synchronous ctx.compact() fired");
	} finally {
		if (prev === undefined) delete process.env.MEGACOMPACT_RACE_GUARD_STRICT;
		else process.env.MEGACOMPACT_RACE_GUARD_STRICT = prev;
		if (prevFloor === undefined) delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
		else process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = prevFloor;
	}
});

test("S38.5: strict (default) defers ctx.compact() via setTimeout re-check", async () => {
	const prevFloor = process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
	try {
		const h = harness();
		const hiCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
		await h.fire("agent_end", { type: "agent_end", messages: [] }, hiCtx);
		assert.equal(h.compactCalls.length, 0, "strict: ctx.compact() NOT called synchronously (deferred)");
		await new Promise((r) => setTimeout(r, 700));
		assert.ok(h.compactCalls.length >= 1, "strict: deferred ctx.compact() fired after re-check");
	} finally {
		if (prevFloor === undefined) delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
		else process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = prevFloor;
	}
});

