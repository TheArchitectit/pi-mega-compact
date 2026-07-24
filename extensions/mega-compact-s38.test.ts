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

// ---- classifier unit tests (no extension harness needed) ----

test("S38: classifyError returns 'transient' for error/aborted stopReasons", () => {
	assert.equal(classifyErrorFn({ stopReason: "error" }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "aborted" }), "transient");
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

test("S38: retry fires up to max (5) for transient errors, then stops", async () => {
	const h = harness();
	for (let i = 0; i < 5; i++) await s38TurnEnd(h, "error", "internal server error");
	assert.equal(h.sendUserMessages.length, 5, "transient: 5 retry nudges (<= max 5)");
	await s38TurnEnd(h, "error", "internal server error");
	assert.equal(h.sendUserMessages.length, 5, "transient: exhausted -> no 6th nudge");
	assert.ok(eventTypes(h.stateDir).includes("error_retry_exhausted"), "exhausted event logged");
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
	const h = harness();
	await s38TurnEnd(h, "error", "5xx server error");
	assert.equal(h.sendUserMessages.length, 1, "first transient: 1 nudge");
	await s38TurnEnd(h, "stop");
	await s38TurnEnd(h, "error", "5xx server error");
	assert.equal(h.sendUserMessages.length, 2, "success reset counter -> transient fires again from count=1");
});

test("S38: error_retry_exhausted event logged when max exceeded", async () => {
	const h = harness();
	await s38TurnEnd(h, "error", "malformed bad request");
	await s38TurnEnd(h, "error", "malformed bad request");
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

test("cleanup", async () => {
	// PGlite WASM close can hang; race with a timeout to prevent 40-min hangs.
	try {
		await Promise.race([closeVectorIndex(), new Promise((r) => setTimeout(r, 3000))]);
	} catch { /* ignore */ }
	rmSync(baseTmp, { recursive: true, force: true });
});
