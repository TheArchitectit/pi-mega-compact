/**
 * handler-susceptibility.test.ts — repeated-error poisoned-context susceptibility (R3/R6/R7/R8/R9) through turn_end.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, s38TurnEnd, s38TurnEndUsage, eventTypes, r7RepeatTurns, assertStaysTransient, R8_NO_HEALTHY_TARGET, R8_SOCKET_CLOSED } from "./_helpers.js";


test("R6(a): 10 consecutive identical 0-token transient failures produce at most errorRetrySessionMax nudges", async () => {
	// Use TRANSIENT 0-token failures (network text so they're transient, not
	// poisoned) + turn_start + tiny backoff between each so the nudge is
	// consumed and the next turn can fire. sessionMax default = 3. Repeat
	// threshold raised to disable the stateful poisoned upgrade so this
	// exercises the SESSION CAP, not the repeat signal.
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const prevRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	const prevOutage = process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999";
	// R10: disable the outage advisory so this test isolates the session cap only.
	process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = "0";
	try {
		const h = harness();
		for (let i = 0; i < 10; i++) {
			// 0-token transient: usage present with 0 tokens + "connection reset" (network marker).
			await s38TurnEndUsage(h, "error", "connection reset", 0);
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		assert.ok(h.sendUserMessages.length <= 3, `R6(a): at most sessionMax (3) nudges, got ${h.sendUserMessages.length}`);
		assert.ok(eventTypes(h.stateDir).includes("error_retry_session_exhausted"), "session_exhausted event logged");
	} finally {
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
		if (prevRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = prevRepeat;
		if (prevOutage === undefined) delete process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
		else process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = prevOutage;
	}
});

test("R6(b): poisoned-context fires zero retry nudges (dashboard-only advisory)", async () => {
	// auto=false so the guarded compact attempt (R3c) is skipped — this test
	// focuses on the advise + no-retry behavior. The compact path is the same
	// race-guarded deferred mechanism already covered by the context-overflow tests.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		// 0-token generic "request failed" (no transient marker) → poisoned.
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "poisoned: no /clear user message (dashboard-only)");
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "poisoned_context event logged");
		assert.ok(!eventTypes(h.stateDir).includes("error_retry"), "poisoned: zero retry nudges (no error_retry event)");
		// Second poisoned turn: advise throttled to one per session.
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "poisoned: no /clear user message (dashboard-only throttled)");
		assert.ok(eventTypes(h.stateDir).filter((t) => t === "poisoned_context").length >= 2, "poisoned_context logged each turn");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R6(c): transient burst retries with backoff gating — second immediate nudge suppressed while one pending", async () => {
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const prevSession = process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
	const prevRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	const prevOutage = process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = "999"; // don't let session cap bind
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999"; // don't let repeat upgrade bind
	// R10: disable the outage advisory so this test isolates backoff gating only.
	process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = "0";
	try {
		const h = harness();
		// Turn 1: transient → nudge 1 fires (pending=true, backoff=1ms).
		await s38TurnEnd(h, "error", "internal server error 0");
		assert.equal(h.sendUserMessages.length, 1, "first transient: 1 nudge");
		// Turn 2: immediate (no turn_start) → suppressed by retryNudgePending.
		await s38TurnEnd(h, "error", "internal server error 1");
		assert.equal(h.sendUserMessages.length, 1, "second immediate nudge suppressed (retryNudgePending)");
		// turn_start consumes the pending nudge (resets pending + count).
		await h.fire("turn_start", { type: "turn_start", turnIndex: 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 5)); // let backoff elapse
		// Turn 3: transient → nudge 2 fires (pending cleared, backoff elapsed).
		await s38TurnEnd(h, "error", "internal server error 2");
		assert.equal(h.sendUserMessages.length, 2, "after turn_start + backoff: nudge fires");
	} finally {
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
		if (prevSession === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
		else process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = prevSession;
		if (prevRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = prevRepeat;
		if (prevOutage === undefined) delete process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
		else process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = prevOutage;
	}
});

test("R6(d): user abort (stopReason aborted) never nudges, even across repeated aborts", async () => {
	const h = harness();
	await s38TurnEnd(h, "aborted", "Operation aborted");
	assert.equal(h.sendUserMessages.length, 0, "aborted: no nudge");
	await s38TurnEnd(h, "aborted", "Aborted after 3 retry attempts");
	assert.equal(h.sendUserMessages.length, 0, "aborted: still no nudge after repeated aborts");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_cancelled"), "cancelled event logged");
});

test("R6(e): success resets retry-nudge-pending state", async () => {
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		// Turn 1: transient → nudge fires, pending=true.
		await s38TurnEnd(h, "error", "internal server error 0");
		assert.equal(h.sendUserMessages.length, 1, "first transient: 1 nudge");
		// Turn 2: immediate transient → suppressed by pending (no turn_start).
		await s38TurnEnd(h, "error", "internal server error 1");
		assert.equal(h.sendUserMessages.length, 1, "second immediate suppressed by pending");
		// Turn 3: success (stop) → resets pending (R4), no nudge.
		await s38TurnEnd(h, "stop");
		assert.equal(h.sendUserMessages.length, 1, "success: no nudge, resets pending");
		await new Promise((r) => setTimeout(r, 5)); // let backoff elapse
		// Turn 4: transient → nudge fires again (pending was reset by success).
		await s38TurnEnd(h, "error", "internal server error 2");
		assert.equal(h.sendUserMessages.length, 2, "after success reset pending: transient nudge fires");
	} finally {
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R3: repeated identical transient error text upgrades to poisoned-context at threshold", async () => {
	// The stateful repeat signal: 3 consecutive identical transient errors
	// (default threshold) upgrade to poisoned. Uses "5xx server error" —
	// deliberately NO known-retryable marker ("5xx" is not /5\d\d/, and
	// "server error" alone matches nothing): the classifier returns transient
	// via the generic 'error' fallthrough, then the repeat tracker upgrades it.
	// auto=false to skip the compact attempt.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		// Turns 1-2: transient (repeatCount 1, 2) → nudges fire.
		await s38TurnEnd(h, "error", "5xx server error");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		await s38TurnEnd(h, "error", "5xx server error");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 3 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		// Turn 3: repeatCount=3 ≥ threshold → upgraded to poisoned. No nudge, advise fires.
		await s38TurnEnd(h, "error", "5xx server error");
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "repeat threshold reached: poisoned_context event logged");
		assert.ok(!h.sendUserMessages.some((m) => m.includes("/clear") || m.includes("/new")), "repeat threshold: no /clear user message (dashboard-only)");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(a): repeated 'timed out' phrasing (2026-07-30 incident text) stays transient — no poisoned upgrade", async () => {
	// The incident error text was "Request timed out or failed. Try again" —
	// "timed out" (two words) does NOT match the old guard's /timeout/, so the
	// 3rd repeat fired the /clear poisoned advise. Must stay transient.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, "Request timed out or failed. Try again", 3);
		assertStaysTransient(h, "timed out x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(b): repeated ETIMEDOUT errno stays transient", async () => {
	// Node's timeout errno lowercases to "etimedout" — does NOT contain the
	// substring "timeout". Slipped through the old guard.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, "connect ETIMEDOUT 142.250.80.46:443", 3);
		assertStaysTransient(h, "ETIMEDOUT x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(c): repeated 'socket hang up' stays transient", async () => {
	// Node surfaces ECONNRESET as the message "socket hang up" (the errno lives
	// in error.code, which extractErrorSignature never sees).
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, "socket hang up", 3);
		assertStaysTransient(h, "socket hang up x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(d): repeated 429 rate-limit stays transient", async () => {
	// /clear cannot fix a rate limit — the classifier explicitly keeps 429
	// transient, so the repeat-upgrade must not override that verdict.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, "429 Too Many Requests: rate limit exceeded", 3);
		assertStaysTransient(h, "429 x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(e): 0-token 'timed out' turn is NOT poisoned on first occurrence", async () => {
	// Deeper gap: with usage PRESENT at 0 tokens, the classifier's 0-token
	// poisoned signal fires on turn ONE for "timed out" phrasing (the stopReason
	// 'error' is in the text blob and no transient marker matched). The network
	// markers must be checked before that signal so this returns transient.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		await s38TurnEndUsage(h, "error", "Request timed out or failed. Try again", 0);
		assert.ok(
			!eventTypes(h.stateDir).includes("poisoned_context"),
			"0-token timed out: no poisoned_context on first turn",
		);
		assert.ok(
			!h.sendUserMessages.some((m) => m.includes("/clear")),
			"0-token timed out: no /clear advise on first turn",
		);
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R7(f): repeated non-network transient still upgrades to poisoned-context (control)", async () => {
	// True-positive control: an error with NO known-retryable marker that
	// repeats identically must still upgrade (the R3 feature itself).
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, "upstream rejected the request", 3);
		assert.ok(
			eventTypes(h.stateDir).includes("poisoned_context"),
			"non-network repeat: poisoned_context event logged",
		);
		assert.ok(
			!h.sendUserMessages.some((m) => m.includes("/clear")),
			"non-network repeat: no /clear user message (dashboard-only)",
		);
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R7(g): 'Request failed — please retry.' 0-token stays poisoned-context (2026-07-28 control)", async () => {
	// The deterministic-rejection incident that motivated R3 must remain
	// poisoned: the shared marker pattern must NOT match this text.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		assert.ok(
			eventTypes(h.stateDir).includes("poisoned_context"),
			"deterministic rejection: poisoned_context event logged",
		);
		assert.ok(!h.sendUserMessages.some((m) => m.includes("/clear")), "deterministic rejection: no /clear user message (dashboard-only)");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R8(a): 0-token 'No healthy target' turn is NOT poisoned on first occurrence", async () => {
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		await s38TurnEndUsage(h, "error", R8_NO_HEALTHY_TARGET, 0);
		assert.ok(!eventTypes(h.stateDir).includes("poisoned_context"), "no poisoned_context on first turn");
		assert.ok(!h.sendUserMessages.some((m) => m.includes("/clear")), "no /clear advise");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R8(b): repeated 'No healthy target' x3 stays transient", async () => {
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, R8_NO_HEALTHY_TARGET, 3);
		assertStaysTransient(h, "no-healthy-target x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R8(c): repeated 'All targets failed / socket closed' x3 stays transient", async () => {
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_AUTO = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	try {
		const h = harness();
		await r7RepeatTurns(h, R8_SOCKET_CLOSED, 3);
		assertStaysTransient(h, "all-targets-failed x3");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

test("R9 handler: bare 0-token error turn x1 is transient (no poisoned, no advise)", async () => {
	const h = harness();
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		// Single bare 0-token error turn
		await s38TurnEndUsage(h, "error", undefined, 0);
		await h.fire("turn_start", { type: "turn_start", turnIndex: 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		// No poisoned_context event should be logged
		assert.ok(!eventTypes(h.stateDir).includes("poisoned_context"), "bare 0-token single turn must not log poisoned_context");
		// No /clear advise message
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "bare 0-token single turn must not /clear");
		// An error_retry event should be emitted
		assert.ok(eventTypes(h.stateDir).includes("error_retry"), "bare 0-token single turn must trigger error_retry");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		delete process.env.MEGACOMPACT_AUTO;
	}
});

test("R9 handler: bare 0-token error x3 upgrades to poisoned at threshold (corroborated)", async () => {
	const h = harness();
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		// Three consecutive bare 0-token error turns
		for (let i = 0; i < 3; i++) {
			await s38TurnEndUsage(h, "error", undefined, 0);
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		// poisoned_context event should eventually be logged
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "bare 0-token x3 must log poisoned_context");
		// R13: dashboard-only default — no user message, but poisoned event fires.
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "bare 0-token x3: no /clear user message (dashboard-only default)");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		delete process.env.MEGACOMPACT_AUTO;
	}
});

