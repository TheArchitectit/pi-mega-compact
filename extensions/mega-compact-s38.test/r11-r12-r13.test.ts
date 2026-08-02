/**
 * r11-r12-r13.test.ts — R11 signal-tagged events, R12 marker-less signature merging, R13 advisory channel.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, s38TurnEnd, s38TurnEndUsage, eventTypes, eventPayloads, extractErrorSignatureFn, classifyErrorDetailedFn } from "./_helpers.js";


test("R11: poisoned_context event carries signal + rawText", async () => {
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		const payloads = eventPayloads(h.stateDir, "poisoned_context");
		assert.ok(payloads.length >= 1, "expected a poisoned_context event");
		const last = payloads[payloads.length - 1];
		assert.equal(last.signal, "poisoned-request-failed", "signal field present and correct");
		assert.ok(
			typeof last.rawText === "string" && (last.rawText as string).toLowerCase().includes("request failed"),
			"rawText contains error text",
		);
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R11: provider outage advisory payload carries signal + rawText", async () => {
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origSession = process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = "999";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999";
	try {
		const h = harness();
		for (let i = 0; i < 3; i++) {
			await s38TurnEnd(h, "error", "socket hang up");
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		const payloads = eventPayloads(h.stateDir, "provider_outage_advised");
		assert.ok(payloads.length >= 1, "expected provider_outage_advised event");
		const last = payloads[payloads.length - 1];
		assert.equal(last.signal, "transient-marker", "outage event carries signal");
		assert.ok(
			typeof last.rawText === "string" && (last.rawText as string).includes("socket hang up"),
			"outage event carries rawText",
		);
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origSession === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
		else process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = origSession;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
	}
});

test("R11: repeat-upgrade-declined signal is transient-marker for retryable marker", () => {
	// The repeat-upgrade-declined log fires when isKnownRetryable(signature) is true
	// but the count hasn't reached the threshold yet (decline path).  Since the
	// test harness doesn't expose internal logger output, we unit-test the signal
	// tag that the handler would log.
	const detail = classifyErrorDetailedFn("Request timed out or failed. Try again");
	assert.equal(detail.signal, "transient-marker", "repeat-guard text gets transient-marker signal");
	assert.equal(detail.category, "transient");
});

test("R12: extractErrorSignature normalizes volatile tokens", () => {
	// Model/provider paths → <model>
	const sigA = extractErrorSignatureFn("All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: boom");
	const sigB = extractErrorSignatureFn("All targets failed: hf/other-org/GLM-4.7. Last error: boom");
	assert.equal(sigA, sigB, "different model paths must normalize to the same signature");
	assert.ok(sigA.includes("<model>"), "normalized sig should contain <model>");
	assert.ok(!sigA.includes("modal"), "original model alias must be replaced");
	assert.ok(!sigA.includes("hf/other-org"), "original model alias must be replaced");

	// IP:port → <ip>
	const ipA = extractErrorSignatureFn("connect ETIMEDOUT 10.0.0.1:443");
	const ipB = extractErrorSignatureFn("connect ETIMEDOUT 192.168.0.2:8443");
	assert.equal(ipA, ipB, "different IPs must normalize to the same signature");
	assert.ok(ipA.includes("<ip>"), "normalized sig should contain <ip>");
	assert.ok(!ipA.includes("10.0.0.1"), "original IP must be replaced");

	// Hex ids (8+ chars) → <hex>
	const hexA = extractErrorSignatureFn("request id a1b2c3d4e5f6 failed");
	const hexB = extractErrorSignatureFn("request id 9f8e7d6c5b4a failed");
	assert.equal(hexA, hexB, "different hex ids must normalize to the same signature");
	assert.ok(hexA.includes("<hex>"), "normalized sig should contain <hex>");

	// "after N attempts" → "after <n> attempts"
	const rA = extractErrorSignatureFn("Retry failed after 3 attempts: boom");
	const rB = extractErrorSignatureFn("Retry failed after 5 attempts: boom");
	assert.equal(rA, rB, "different attempt counts must normalize to the same signature");
	assert.ok(rA.includes("after <n> attempts"), "normalized sig should contain 'after <n> attempts'");

	// Status codes (3-digit) survive — NOT merged by the 4+ digit rule
	const s500 = extractErrorSignatureFn("error 500 now");
	const s502 = extractErrorSignatureFn("error 502 now");
	assert.notEqual(s500, s502, "3-digit status codes must NOT merge");

	// Empty + bare 0-token error object still returns "bare-0-token-error" (R9 preserved)
	assert.equal(
		extractErrorSignatureFn({ stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }),
		"bare-0-token-error",
		"R9 bare-0-token fallback must survive normalization change",
	);
	// Empty content with no usage keeps returning ""
	assert.equal(extractErrorSignatureFn({ stopReason: "error" }), "", "bare error with no usage must return empty");
});

test("R12: alternating-but-equivalent marker-less errors upgrade at threshold", async () => {
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "3";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		// Two texts that differ ONLY in model alias — no known-retryable markers.
		// "upstream rejected alias modal/a-b/X-1" has no network/timeout/socket/
		// 429/5xx markers in KNOWN_RETRYABLE_TRANSIENT_PATTERN.
		const textA = "upstream rejected alias modal/a-b/X-1";
		const textB = "upstream rejected alias hf/c-d/Y-2";
		// Turn 1 (textA): count → 1
		await s38TurnEnd(h, "error", textA);
		await h.fire("turn_start", { type: "turn_start", turnIndex: 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		// Turn 2 (textB): normalized matches → count → 2
		await s38TurnEnd(h, "error", textB);
		await h.fire("turn_start", { type: "turn_start", turnIndex: 3 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		// Turn 3 (textA again): normalized matches → count → 3 → upgrade
		await s38TurnEnd(h, "error", textA);
		await h.fire("turn_start", { type: "turn_start", turnIndex: 4 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "equivalent alternating errors must upgrade to poisoned at threshold");
		// R13: default advisoryChannel=true → dashboard-only, no /clear user message.
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "no /clear user message (dashboard-only default)");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
		delete process.env.MEGACOMPACT_AUTO;
	}
});

test("R12: genuinely different marker-less errors do NOT merge", async () => {
	// Characterization/control test: two truly distinct error messages must NOT
	// merge under normalization — their signatures stay different and the repeat
	// counter never reaches threshold.  This should pass both before and after
	// the R12 normalization change (guard against over-normalization).
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "3";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		const textA = "upstream rejected the request";
		const textB = "provider returned an empty response";
		// Alternate a,b,a,b — counter never exceeds 1.
		for (let i = 0; i < 4; i++) {
			await s38TurnEnd(h, "error", i % 2 === 0 ? textA : textB);
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		assert.ok(!eventTypes(h.stateDir).includes("poisoned_context"), "truly different errors must NOT trigger poisoned_context");
		assert.equal(h.sendUserMessages.filter((m) => m.includes("/clear")).length, 0, "no /clear for non-repeating errors");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
		delete process.env.MEGACOMPACT_AUTO;
	}
});

test("R13: legacy advisoryChannel=false sends /clear advise as user message", async () => {
	const origChannel = process.env.MEGACOMPACT_ADVISORY_CHANNEL;
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ADVISORY_CHANNEL = "false";
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "3";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		// Fire 3 identical non-network error turns to trigger poisoned upgrade
		await s38TurnEnd(h, "error", "upstream rejected the request");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		await s38TurnEnd(h, "error", "upstream rejected the request");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 3 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		await s38TurnEnd(h, "error", "upstream rejected the request");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 4 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "poisoned_context event fires");
		assert.ok(h.sendUserMessages.some((m) => m.includes("/clear")), "legacy path: /clear advise sent as user message");
	} finally {
		if (origChannel === undefined) delete process.env.MEGACOMPACT_ADVISORY_CHANNEL;
		else process.env.MEGACOMPACT_ADVISORY_CHANNEL = origChannel;
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
		delete process.env.MEGACOMPACT_AUTO;
	}
});

