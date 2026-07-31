/**
 * mega-compact.s38-error-retry.test.ts — S38 error-retry safety net tests.
 *
 * Extracted from mega-compact.test.ts so the error-retry feature has a focused,
 * fast-isolated test file. Exercises the real extension entry through a mock pi:
 *   - classifyError classifier (transient / permanent / compaction-noop / null)
 *   - turn_end retry nudges (max 5 transient, max 1 permanent)
 *   - compaction-noop DOES NOT retry (pi race guard)
 *   - MAX=0 disables transient retries
 *   - mid-response errors (stream died without a stopReason)
 *   - S38.5 race-guard (strict deferred vs synchronous)
 *
 * The harness is duplicated from mega-compact.test.ts (per guardrails guidance to
 * keep each test file self-contained; the harness is ~200 lines and does not
 * warrant a shared helper module that would itself exceed the 500-line target).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeVectorIndex } from "../src/store/vectorIndex.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-s38-"));
// Isolate the machine-wide repo index so test runs never pollute the real one.
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
let counter = 0;

/** Read events.log and return an array of event type strings. */
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
		.map((line) => { try { return JSON.parse(line).type; } catch { return undefined; } })
		.filter((t): t is string => typeof t === "string");
}

/** Build a mock pi + ctx and load the extension into them. */
function harness(opts: { keepTier?: boolean; keepThreshold?: boolean } = {}) {
	const stateDir = join(baseTmp, `run-${counter++}`);
	process.env.MEGACOMPACT_STATE_DIR = stateDir;
	process.env.MEGACOMPACT_DEBUG = "true";
	if (!opts.keepThreshold) process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	if (!opts.keepTier) delete process.env.MEGACOMPACT_TIER;
	process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

	const handlers: Record<string, Function[]> = {};
	const appended: any[] = [];
	const sendUserMessages: string[] = [];
	const compactCalls: any[] = [];

	const session: AgentMessage[] = [
		{ role: "user", content: "read src/vec.ts and understand the index", timestamp: 0 } as unknown as AgentMessage,
		{ role: "assistant", content: [{ type: "toolCall", name: "Read", id: "c1", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", timestamp: 0 } as unknown as AgentMessage,
		{ role: "user", content: "edit src/vec.ts to add a cosine helper", timestamp: 0 } as unknown as AgentMessage,
		{ role: "assistant", content: [{ type: "toolCall", name: "Edit", id: "c1", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", timestamp: 0 } as unknown as AgentMessage,
	];
	const toEntry = (m: AgentMessage, i: number): any => ({ type: "message", id: `e${i}`, parentId: null, timestamp: String(i), message: m });
	const sessionManager = { getSessionId: () => "sess_ext_001", getEntries: () => session.map(toEntry), getBranch: () => session.map(toEntry) };

	function makeCtx(over: Partial<any> = {}) {
		return {
			ui: { setStatus: () => {}, notify: () => {}, select: () => {}, confirm: async () => true, input: async () => "", setWidget: () => {} },
			mode: "tui" as any, hasUI: true, cwd: stateDir, sessionManager,
			modelRegistry: {} as any, model: undefined,
			isIdle: () => true, isProjectTrusted: () => true,
			signal: undefined, abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
			getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
			compact: (opts?: any) => {
				compactCalls.push(opts);
				const _sbc = handlers["session_before_compact"];
				if (_sbc && _sbc.length) return _sbc[0]({ type: "session_before_compact", reason: "threshold", willRetry: false, signal: undefined, preparation: { firstKeptEntryId: "e2", messagesToSummarize: session.slice(0, 2), tokensBefore: 500 } } as any, makeCtx());
				return undefined;
			},
			getSystemPrompt: () => "system base", ...over,
		} as any;
	}
	const pi = {
		on: (ev: string, h: Function) => { if (!handlers[ev]) handlers[ev] = []; handlers[ev].push(h); },
		registerCommand: () => {}, registerTool: () => {}, registerShortcut: () => {},
		registerFlag: () => {}, getFlag: () => undefined,
		registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
		sendMessage: () => {}, sendUserMessage: (m: string) => { sendUserMessages.push(m); },
		appendEntry: (t: string, d: any) => appended.push({ t, d }),
		setSessionName: () => {}, getSessionName: () => undefined, setLabel: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => [], getAllTools: () => {}, setActiveTools: () => {},
		getCommands: () => [], setModel: async () => false,
		getThinkingLevel: () => "off" as any, setThinkingLevel: () => {},
	} as any;
	const mod = require("./mega-compact.js") as { default: (p: any) => void };
	mod.default(pi);
	return {
		stateDir, handlers, appended, compactCalls, sendUserMessages,
		fire: async (ev: string, event: any, ctx: any) => { let r: any; for (const h of handlers[ev] || []) r = await h(event, ctx); return r; },
		ctx: makeCtx, session,
	};
}

const { classifyError: classifyErrorFn } =
	require("./mega-events.js") as { classifyError: typeof import("./mega-events.js").classifyError };

/** S38 helper: fire a turn_end with a given stopReason + optional text, using a
 *  low-pressure ctx so the durable-trim branch (ctx.compact) does NOT fire. */
async function s38TurnEnd(h: ReturnType<typeof harness>, stopReason: string | undefined, text?: string) {
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	const message: any = { role: "assistant" };
	if (stopReason !== undefined) message.stopReason = stopReason;
	if (text) message.content = text;
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message }, lowCtx);
}

/** R3 helper: like s38TurnEnd but attaches a `usage` object so the classifier's
 *  0-token poisoned-context signal is exercised (usage PRESENT with 0 tokens).
 *  Pass `tokens` > 0 to simulate a turn that reached the model. */
async function s38TurnEndUsage(h: ReturnType<typeof harness>, stopReason: string | undefined, text: string | undefined, tokens: number) {
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	const message: any = { role: "assistant", usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
	if (stopReason !== undefined) message.stopReason = stopReason;
	if (text) message.content = text;
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message }, lowCtx);
}

// ---- classifier unit tests (no extension harness needed) ----

test("S38: classifyError returns 'transient' for error stopReason", () => {
	assert.equal(classifyErrorFn({ stopReason: "error" }), "transient");
});

test("S38: classifyError returns 'cancelled' for aborted stopReason (ESC/Ctrl-C)", () => {
	assert.equal(classifyErrorFn({ stopReason: "aborted" }), "cancelled");
	assert.equal(classifyErrorFn({ stopReason: "aborted", errorMessage: "Operation aborted" }), "cancelled");
	assert.equal(classifyErrorFn({ stopReason: "aborted", errorMessage: "Aborted after 3 retry attempts" }), "cancelled");
});

test("S38: classifyError does NOT return 'cancelled' for error message containing 'aborted' with non-aborted stopReason", () => {
	// Defense: the old text-based s.includes('aborted') path is gone,
	// but verify that an error message mentioning 'aborted' with stopReason
	// 'error' (not 'aborted') still classifies as transient, not cancelled.
	assert.equal(classifyErrorFn({ stopReason: "error", errorMessage: "Connection aborted" }), "transient");
});

test("S38: classifyError returns 'transient' for max-output-token text", () => {
	assert.equal(classifyErrorFn({ stopReason: "error", content: "reached the maximum output token limit" }), "transient");
	assert.equal(classifyErrorFn("max output token exceeded"), "transient");
});

test("S38: classifyError returns 'permanent' for auth/unauthorized text", () => {
	assert.equal(classifyErrorFn("unauthorized: invalid api key"), "permanent");
	assert.equal(classifyErrorFn("permission denied"), "permanent");
});

test("S38: classifyError returns null for stop/toolUse stopReasons (success)", () => {
	assert.equal(classifyErrorFn({ stopReason: "stop" }), null);
	assert.equal(classifyErrorFn({ stopReason: "toolUse" }), null);
	assert.equal(classifyErrorFn({ stopReason: "tool_use" }), null);
});

test("S38: classifyError returns null for 'length' stopReason (S28 guard)", () => {
	assert.equal(classifyErrorFn({ stopReason: "length" }), null);
});

test("S38: classifyError returns 'transient' for mid-response errors with no stopReason", () => {
	assert.equal(classifyErrorFn({}), "transient");
	assert.equal(classifyErrorFn({ content: [] }), "transient");
	assert.equal(classifyErrorFn({ stopReason: undefined }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "" }), "transient");
});

test("S38: classifyError returns 'transient' for error objects with message field", () => {
	assert.equal(classifyErrorFn({ error: { message: "Stream interrupted" } }), "transient");
	assert.equal(classifyErrorFn({ error: { message: "Connection lost" } }), "transient");
	assert.equal(classifyErrorFn({ error: { message: "500 Internal Server Error" } }), "transient");
	assert.equal(classifyErrorFn({ error: "Connection lost" }), "transient");
});

test("S38: classifyError returns 'transient' for mid-response stream failures in content", () => {
	assert.equal(classifyErrorFn({ content: [{ type: "text", text: "Processing... Error: connection reset" }] }), "transient");
	assert.equal(classifyErrorFn({ content: [{ type: "text", text: "Here is the answer..." }], stopReason: "error" }), "transient");
});

test("S38: classifyError returns 'transient' for partial content with NO stopReason (stream died after emitting text)", () => {
	// The mid-response disconnect case: provider streamed partial content then
	// died without a stopReason. MUST be transient (retryable), NOT null.
	assert.equal(classifyErrorFn({ role: "assistant", content: [{ type: "text", text: "partial response..." }], stopReason: undefined }), "transient");
	assert.equal(classifyErrorFn({ role: "assistant", content: [{ type: "text", text: "Here is the start of the answer" }] }), "transient");
	assert.equal(classifyErrorFn({ role: "assistant", content: "partial response..." }), "transient");
});

test("S38: classifyError returns null for success stopReasons even with empty content", () => {
	assert.equal(classifyErrorFn({ stopReason: "stop", content: [] }), null);
	assert.equal(classifyErrorFn({ stopReason: "tool_use", content: [] }), null);
});

test("S38: classifyError returns 'compaction-noop' for 'Already compacted' text", () => {
	assert.equal(classifyErrorFn("Error: Already compacted"), "compaction-noop");
});

test("S38: classifyError returns 'compaction-noop' for 'Nothing to compact' text", () => {
	assert.equal(classifyErrorFn("Nothing to compact (session too small)"), "compaction-noop");
});

test("S38: classifyError returns 'compaction-noop' for 'Auto compaction failed' text", () => {
	assert.equal(classifyErrorFn("Auto compaction failed"), "compaction-noop");
	assert.equal(classifyErrorFn("Auto-compaction failed"), "compaction-noop");
});

// ---- context-overflow classifier (S38.8: 400 "too long... even after compaction") ----

test("S38: classifyError returns 'context-overflow' for the literal user 400 string", () => {
	assert.equal(
		classifyErrorFn("Your conversation is too long for this model's context window even after compaction. Reduce the conversation length or enable/allow compaction."),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for 'All targets failed' wrapper", () => {
	assert.equal(
		classifyErrorFn("All targets failed: ... Last error: ... too long ... context window even after compaction"),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for invalid_request_error JSON shape", () => {
	assert.equal(
		classifyErrorFn('{"type":"invalid_request_error","message":"... too long for context window ..."}'),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for OpenRouter 'All targets failed' max-context 400 (FAIL-20260725)", () => {
	// Regression: the OpenAI/OpenRouter provider-side phrasing
	// "maximum context length is N tokens ... requires at least M tokens ...
	// reduce your input or max_tokens" does NOT contain "too long" / "context
	// window" / "reduce the conversation", so it slipped past the original S38.8
	// regex and fell through to the generic transient branch, firing 5 blind
	// retry nudges that re-submitted the same oversized prompt -> re-400 ->
	// busy-loop. The exact user-facing wrapper string from the router:
	assert.equal(
		classifyErrorFn('Error: 400: {"message":"All targets failed: neuralwatt/glm-5.2-short. Last error: This model\'s maximum context length is 200000 tokens. Your request requires at least 201070 tokens (201070 prompt + 0 max_tokens). Please reduce your input or max_tokens.","type":"invalid_request_error"}'),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for bare 'maximum context length' phrasing", () => {
	assert.equal(
		classifyErrorFn("This model's maximum context length is 128000 tokens. Your request requires at least 130000 tokens. Please reduce your input or max_tokens."),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for 'context length exceeded' phrasing", () => {
	assert.equal(
		classifyErrorFn("This model's context length exceeded: 200000 tokens"),
		"context-overflow",
	);
});

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

// ---- integration tests (fire turn_end through the real extension) ----

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
	const h = harness();
	for (let i = 0; i < 5; i++) await s38TurnEnd(h, "error", `internal server error ${i}`);
	assert.equal(h.sendUserMessages.length, 1, "R1 dedup: 1 nudge in burst (rest suppressed)");
	// The 6th turn reaches count=6 > max=5 → exhausted (count advances even for dedup'd turns).
	await s38TurnEnd(h, "error", "internal server error 5");
	assert.equal(h.sendUserMessages.length, 1, "exhausted: still 1 nudge (no 6th)");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_exhausted"), "exhausted event logged on max+1");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_dedup_skip"), "dedup_skip events logged for suppressed turns");
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

test("S38: retry fires for mid-response errors (no stopReason — stream died silently)", async () => {
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant" } }, lowCtx);
	assert.equal(h.sendUserMessages.length, 1, "mid-response silent failure: 1 retry nudge fired");
	assert.ok(eventTypes(h.stateDir).includes("error_retry"), "error_retry event logged for mid-response failure");
});

test("S38: retry fires for error objects with message field", async () => {
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message: { role: "assistant", error: { message: "Connection reset by peer" } } }, lowCtx);
	assert.equal(h.sendUserMessages.length, 1, "error object with message: 1 retry nudge fired");
});

test("S38: retry fires for partial content with no stopReason (disconnect after emitting text)", async () => {
	// The post-resume disconnect case: provider streamed partial content then
	// died mid-stream with NO stopReason. Must fire a retry nudge.
	const h = harness();
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	await h.fire("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "Here is the start of the answer" }], stopReason: undefined },
	}, lowCtx);
	assert.equal(h.sendUserMessages.length, 1, "partial-content mid-response failure: 1 retry nudge fired");
	assert.ok(eventTypes(h.stateDir).includes("error_retry"), "error_retry event logged for partial-content failure");
});

// ---- S38.5: race-guard strengthening (cooldown 10s->30s + deferred re-check) ---

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

// ---- R3 classifier unit tests: poisoned-context signals ----

test("R3 classifier: 0-token generic error (usage present, 0 tokens) → poisoned-context", () => {
	// The 2026-07-28 incident: stopReason 'error' + usage 0 tokens. The turn
	// never reached the model; retrying re-submits the same poisoned context.
	assert.equal(classifyErrorFn({ stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }), "poisoned-context");
	// Bare stopReason 'error' with NO usage field stays transient (unknown tokens
	// — conservative; preserves the pre-R3 mid-response/partial-content behavior).
	assert.equal(classifyErrorFn({ stopReason: "error" }), "transient");
});

test("R3 classifier: ECONNRESET (0-token) → transient (network failures stay transient)", () => {
	// R3: network failures must stay transient even with 0 tokens.
	assert.equal(classifyErrorFn({ stopReason: "error", content: "ECONNRESET", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "connection reset by peer", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "timeout", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "503 service unavailable", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
});

test("R3 classifier: 'request failed' generic (no transient marker) → poisoned-context", () => {
	// The exact incident phrasing: "Request failed — please retry." with no
	// specific transient cause → deterministic rejection.
	assert.equal(classifyErrorFn({ stopReason: "error", content: "Request failed — please retry.", usage: { inputTokens: 0, outputTokens: 0 } }), "poisoned-context");
	assert.equal(classifyErrorFn("request failed"), "poisoned-context");
});

test("R3 classifier: orphaned-tool-result 400 (non-overflow) → poisoned-context", () => {
	// Provider request-validation 400 that is NOT context-overflow: orphaned
	// tool result / malformed message structure. Previously 'permanent' (1
	// retry), now 'poisoned-context' (retry re-submits the same malformed shape).
	assert.equal(classifyErrorFn('{"type":"invalid_request_error","message":"orphaned tool result: tooluse ids mismatch"}'), "poisoned-context");
	assert.equal(classifyErrorFn("invalid request: unexpected role ordering"), "poisoned-context");
	assert.equal(classifyErrorFn("malformed message structure"), "poisoned-context");
});

test("R3 classifier: context-overflow phrasing still context-overflow (not poisoned)", () => {
	// Regression guard: the context-overflow check runs BEFORE the poisoned
	// signals, so a 400 "too long" stays context-overflow (forced re-compact),
	// not poisoned (advise + compact).
	assert.equal(
		classifyErrorFn({ stopReason: "error", content: "Your conversation is too long for this model's context window even after compaction.", usage: { inputTokens: 0, outputTokens: 0 } }),
		"context-overflow",
	);
	assert.equal(
		classifyErrorFn('{"type":"invalid_request_error","message":"maximum context length is 200000 tokens. requires at least 201070 tokens."}'),
		"context-overflow",
	);
});

test("R3 classifier: auth/permission stays permanent (not poisoned)", () => {
	// Auth errors are retryable-once (permanent), not poisoned — the user can
	// fix the key and retry.
	assert.equal(classifyErrorFn("unauthorized: invalid api key"), "permanent");
	assert.equal(classifyErrorFn("permission denied"), "permanent");
});

// ---- R6 integration tests (retry redesign) ----

test("R6(a): 10 consecutive identical 0-token transient failures produce at most errorRetrySessionMax nudges", async () => {
	// Use TRANSIENT 0-token failures (network text so they're transient, not
	// poisoned) + turn_start + tiny backoff between each so the nudge is
	// consumed and the next turn can fire. sessionMax default = 3. Repeat
	// threshold raised to disable the stateful poisoned upgrade so this
	// exercises the SESSION CAP, not the repeat signal.
	const prevBackoff = process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
	const prevRepeat = process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD;
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999";
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
	}
});

test("R6(b): poisoned-context fires zero retry nudges and exactly one advise message", async () => {
	// auto=false so the guarded compact attempt (R3c) is skipped — this test
	// focuses on the advise + no-retry behavior. The compact path is the same
	// race-guarded deferred mechanism already covered by the context-overflow tests.
	const prevAuto = process.env.MEGACOMPACT_AUTO;
	process.env.MEGACOMPACT_AUTO = "false";
	try {
		const h = harness();
		// 0-token generic "request failed" (no transient marker) → poisoned.
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		assert.equal(h.sendUserMessages.length, 1, "poisoned: exactly one advise message");
		assert.ok(
			h.sendUserMessages[0].includes("/clear") || h.sendUserMessages[0].includes("/new"),
			"advise mentions /clear or /new",
		);
		assert.ok(eventTypes(h.stateDir).includes("poisoned_context"), "poisoned_context event logged");
		assert.ok(!eventTypes(h.stateDir).includes("error_retry"), "poisoned: zero retry nudges (no error_retry event)");
		// Second poisoned turn: advise throttled to one per session.
		await s38TurnEndUsage(h, "error", "Request failed — please retry.", 0);
		assert.equal(h.sendUserMessages.length, 1, "poisoned: advise throttled (one per session)");
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
	process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = "1";
	process.env.MEGACOMPACT_ERROR_RETRY_SESSION_MAX = "999"; // don't let session cap bind
	process.env.MEGACOMPACT_POISONED_REPEAT_THRESHOLD = "999"; // don't let repeat upgrade bind
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
		assert.ok(h.sendUserMessages.some((m) => m.includes("/clear") || m.includes("/new")), "repeat threshold: advise message fired");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
		if (prevBackoff === undefined) delete process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS;
		else process.env.MEGACOMPACT_ERROR_RETRY_BACKOFF_MS = prevBackoff;
	}
});

// ---- R7 regression tests: network/throughput errors must NEVER upgrade to ----
// ---- poisoned-context (2026-07-30 false-alarm incident) ----

/** R7 helper: fire the same transient error text `count` times with turn_start
 *  + elapsed backoff between turns so each turn's nudge can fire. */
async function r7RepeatTurns(h: ReturnType<typeof harness>, text: string, count: number) {
	for (let i = 0; i < count; i++) {
		await s38TurnEnd(h, "error", text);
		await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
	}
}

/** R7 helper: shared assertions for "stays transient" — no poisoned upgrade,
 *  no /clear advise, and the transient retry path actually ran. */
function assertStaysTransient(h: ReturnType<typeof harness>, label: string) {
	assert.ok(
		!eventTypes(h.stateDir).includes("poisoned_context"),
		`${label}: no poisoned_context event (network errors never upgrade)`,
	);
	assert.ok(
		!h.sendUserMessages.some((m) => m.includes("/clear")),
		`${label}: no /clear advise message`,
	);
	assert.ok(
		eventTypes(h.stateDir).includes("error_retry"),
		`${label}: transient retry path ran (error_retry event)`,
	);
}

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
			h.sendUserMessages.some((m) => m.includes("/clear")),
			"non-network repeat: /clear advise fired",
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
		assert.ok(h.sendUserMessages.some((m) => m.includes("/clear")), "deterministic rejection: /clear advise fired");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

test("R7 classifier: 0-token 'timed out' error → transient (not poisoned)", () => {
	// Unit-level pin of the R7(e) gap.
	assert.equal(
		classifyErrorFn({
			stopReason: "error",
			content: "Request timed out or failed. Try again",
			usage: { inputTokens: 0, outputTokens: 0 },
		}),
		"transient",
	);
});

test("R7 classifier: bare network phrasings → transient", () => {
	assert.equal(classifyErrorFn("socket hang up"), "transient");
	assert.equal(classifyErrorFn("the operation timed out"), "transient");
	assert.equal(classifyErrorFn("connect ETIMEDOUT 10.0.0.1:443"), "transient");
});

test("R7 classifier: 429/rate-limit → transient (control)", () => {
	assert.equal(classifyErrorFn("429 Too Many Requests: rate limit exceeded"), "transient");
});

// ---- R8 regression tests: router-wrapped infra errors (2026-07-30 incident #2) ----
// pi's console "Error: 500:" prefix is NOT part of the delivered message body,
// so router phrasings ("All targets failed", "No healthy target selected",
// "Too many concurrent requests") matched NO marker and the 0-token signal
// poisoned the session on the FIRST turn.

/** The exact error bodies from the 2026-07-30 incident (GLM router flapping). */
const R8_NO_HEALTHY_TARGET =
	'{"message":"No healthy target selected for alias \'hf:zai-org/GLM-4.7\'","type":"api_error"}';
const R8_SOCKET_CLOSED =
	"All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"; // guardrails-allow PREVENT-PI-004: verbatim 2026-07-30 incident error text (string fixture, not a network call)
const R8_TOO_MANY_CONCURRENT =
	'All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: {"error": "Too many concurrent requests for this model"}';

test("R8 classifier: router phrasings → transient, even at 0 tokens", () => {
	for (const text of [R8_NO_HEALTHY_TARGET, R8_SOCKET_CLOSED, R8_TOO_MANY_CONCURRENT]) {
		assert.equal(
			classifyErrorFn({ stopReason: "error", content: text, usage: { inputTokens: 0, outputTokens: 0 } }),
			"transient",
			`0-token router error must be transient: ${text.slice(0, 60)}`,
		);
	}
});

test("R8 classifier: structured status field wins over phrasing", () => {
	// 5xx → transient even with zero recognizable text.
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 502, message: "???" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"transient",
	);
	// 429 structured → transient.
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { statusCode: 429, message: "???" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"transient",
	);
	// 401 → permanent (not transient, not poisoned).
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 401, message: "???" } }),
		"permanent",
	);
	// 400 with deterministic-rejection text → still poisoned (text rules 4xx).
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 400, message: "orphaned tool result: tooluse ids mismatch" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"poisoned-context",
	);
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

test("cleanup", async () => {
	// PGlite WASM close can hang; race with a timeout to prevent 40-min hangs.
	try {
		await Promise.race([closeVectorIndex(), new Promise((r) => setTimeout(r, 3000))]);
	} catch { /* ignore */ }
	rmSync(baseTmp, { recursive: true, force: true });
	// Force-exit: each harness() creates a MegaRuntime with an fs.watch
	// game-state watcher that is never disposed (no session_shutdown in tests).
	// Those handles keep the event loop alive indefinitely after all tests
	// complete, so `node --test` (without --test-force-exit) would hang.
	// Drain stdout/stderr, then defer the exit: a bare process.exit() discards
	// unflushed pipe buffers — observed 2026-07-30: when piped, the trailing
	// tests' results and the run summary silently vanished from the report.
	await new Promise((r) => process.stdout.write("", r));
	await new Promise((r) => process.stderr.write("", r));
	await new Promise((r) => setTimeout(r, 1500));
	process.exit(0);
});
