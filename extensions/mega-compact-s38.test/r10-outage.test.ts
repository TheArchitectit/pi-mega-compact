/**
 * r10-outage.test.ts — R10 provider-outage advisory behavior.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, s38TurnEnd, s38TurnEndUsage, eventTypes } from "./_helpers.js";


test("R10: 3 consecutive transient failures fire one provider-outage advisory (no /clear)", async () => {
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
		// R13: default advisoryChannel=true → dashboard-only, no user message.
		const providerMessages = h.sendUserMessages.filter((m) => m.includes("provider is having issues"));
		assert.equal(providerMessages.length, 0, "no provider-outage user message (dashboard-only default)");
		assert.ok(eventTypes(h.stateDir).includes("provider_outage_advised"), "provider_outage_advised dashboard event logged");
		const clearMessages = h.sendUserMessages.filter((m) => m.includes("/clear"));
		assert.equal(clearMessages.length, 0, "no /clear in outage advisory");
		assert.ok(eventTypes(h.stateDir).includes("error_retry"), "error_retry events present");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origSession === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
		else process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = origSession;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
	}
});

test("R10: advisory fires once per outage episode", async () => {
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origSession = process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = "999";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999";
	try {
		const h = harness();
		// Episode 1: 5 consecutive transient failures → 1 advisory at consecutiveErrors=3.
		for (let i = 0; i < 5; i++) {
			await s38TurnEnd(h, "error", "socket hang up");
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		// R13: default advisoryChannel=true → dashboard-only, no user message.
		assert.equal(h.sendUserMessages.filter((m) => m.includes("provider is having issues")).length, 0, "episode 1: no user message (dashboard-only default)");
		assert.equal(eventTypes(h.stateDir).filter((t) => t === "provider_outage_advised").length, 1, "episode 1: 1 dashboard event");

		// Success turn: resets consecutiveErrors + providerOutageAdvised.
		await s38TurnEnd(h, "stop");
		await h.fire("turn_start", { type: "turn_start", turnIndex: 8 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));

		// Episode 2: 3 more transient failures → second advisory.
		for (let i = 0; i < 3; i++) {
			await s38TurnEnd(h, "error", "socket hang up");
			await h.fire("turn_start", { type: "turn_start", turnIndex: 9 + i }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		assert.equal(h.sendUserMessages.filter((m) => m.includes("provider is having issues")).length, 0, "episode 2: no user message (dashboard-only default)");
		assert.equal(eventTypes(h.stateDir).filter((t) => t === "provider_outage_advised").length, 2, "episode 2: 2 dashboard events total");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origSession === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
		else process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = origSession;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
	}
});

test("R10: MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD=0 disables the advisory", async () => {
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origSession = process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
	const origRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	const origThreshold = process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = "999";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999";
	process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = "0";
	try {
		const h = harness();
		for (let i = 0; i < 5; i++) {
			await s38TurnEnd(h, "error", "socket hang up");
			await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
			await new Promise((r) => setTimeout(r, 3));
		}
		const providerMessages = h.sendUserMessages.filter((m) => m.includes("provider is having issues"));
		assert.equal(providerMessages.length, 0, "threshold=0: zero advisory messages");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origSession === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX;
		else process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = origSession;
		if (origRepeat === undefined) delete process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
		else process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = origRepeat;
		if (origThreshold === undefined) delete process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD;
		else process.env.MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD = origThreshold;
	}
});

test("R10: poisoned-context path does NOT fire the outage advisory", async () => {
	// Single "Request failed — please retry." 0-token turn: poisoned on turn 1
	// (auto=false to skip the compact attempt).
	const origBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const origAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		// /clear advise should fire.
		assert.ok(!h.sendUserMessages.some((m) => m.includes("/clear")), "poisoned: no /clear user message (dashboard-only)");
		// No provider-outage advisory.
		assert.equal(h.sendUserMessages.filter((m) => m.includes("provider is having issues")).length, 0, "poisoned path: no outage advisory");
	} finally {
		if (origBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = origBackoff;
		if (origAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = origAuto;
	}
});

