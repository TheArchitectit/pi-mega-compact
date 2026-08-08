/**
 * Shared harness for the mega-compact-s38 split test files.
 *
 * Extracted from the top of mega-compact-s38.test.ts: the mock-pi harness that
 * loads the compiled extension, the eventTypes/eventPayloads log readers, the
 * s38TurnEnd helpers, and the classifyError fixtures.
 *
 * Every split file imports this module, which also registers an `after()` hook
 * that force-exits the test subprocess. Each harness() creates a MegaRuntime
 * with an fs.watch game-state watcher that is never disposed (no
 * session_shutdown in tests); those handles keep the event loop alive
 * indefinitely, so without a force-exit `node --test` (without
 * --test-force-exit) would hang. The hook drains stdout/stderr then defers the
 * exit — a bare process.exit() discards unflushed pipe buffers (observed
 * 2026-07-30: piped test results silently vanished).
 *
 * Relative paths are one directory deeper than the original file, hence
 * `../mega-compact.js` / `../mega-events.js`.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { after } from "node:test";
import assert from "node:assert/strict";
import { closeVectorIndex } from "../../src/store/vectorIndex.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-s38-"));
export const baseTmpDir = baseTmp;
export { closeVectorIndex };
// Isolate the machine-wide repo index so test runs never pollute the real one.
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
let counter = 0;

after(async () => {
	// PGlite WASM close can hang; race with a timeout to prevent 40-min hangs.
	try {
		await Promise.race([closeVectorIndex(), new Promise((r) => setTimeout(r, 3000))]);
	} catch { /* ignore */ }
	if (existsSync(baseTmp)) rmSync(baseTmp, { recursive: true, force: true });
	// Drain stdout/stderr, then defer the exit so the final test report flushes.
	await new Promise((r) => process.stdout.write("", r));
	await new Promise((r) => process.stderr.write("", r));
	await new Promise((r) => setTimeout(r, 1500));
	process.exit(0);
});

/** Read events.log and return an array of event type strings. */
export function eventTypes(stateDir: string): string[] {
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

/** R11: read events.log and return full JSON payloads for a given type. */
export function eventPayloads(stateDir: string, type: string): Record<string, unknown>[] {
	const { readFileSync: rf, existsSync: ex } =
		require("node:fs") as typeof import("node:fs");
	const { join: j } = require("node:path") as typeof import("node:path");
	const logPath = j(stateDir, "events.log");
	if (!ex(logPath)) return [];
	const content = rf(logPath, "utf-8").trim();
	if (content.length === 0) return [];
	return content
		.split("\n")
		.map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
		.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null && p.type === type);
}

/** Build a mock pi + ctx and load the extension into them. */
export function harness(opts: { keepTier?: boolean; keepThreshold?: boolean } = {}) {
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
		sendMessage: (m: { content?: string }) => { if (typeof m?.content === "string") sendUserMessages.push(m.content); }, sendUserMessage: (m: string) => { sendUserMessages.push(m); },
		appendEntry: (t: string, d: any) => appended.push({ t, d }),
		setSessionName: () => {}, getSessionName: () => undefined, setLabel: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => [], getAllTools: () => {}, setActiveTools: () => {},
		getCommands: () => [], setModel: async () => false,
		getThinkingLevel: () => "off" as any, setThinkingLevel: () => {},
	} as any;
	const mod = require("../mega-compact.js") as { default: (p: any) => void };
	mod.default(pi);
	return {
		stateDir, handlers, appended, compactCalls, sendUserMessages,
		fire: async (ev: string, event: any, ctx: any) => { let r: any; for (const h of handlers[ev] || []) r = await h(event, ctx); return r; },
		ctx: makeCtx, session,
	};
}

export type Harness = ReturnType<typeof harness>;

export const { classifyError: classifyErrorFn, classifyErrorDetailed: classifyErrorDetailedFn, extractErrorSignature: extractErrorSignatureFn } =
	require("../mega-events.js") as { classifyError: typeof import("../mega-events.js").classifyError; classifyErrorDetailed: typeof import("../mega-events.js").classifyErrorDetailed; extractErrorSignature: typeof import("../mega-events.js").extractErrorSignature };

/** S38 helper: fire a turn_end with a given stopReason + optional text, using a
 *  low-pressure ctx so the durable-trim branch (ctx.compact) does NOT fire. */
export async function s38TurnEnd(h: Harness, stopReason: string | undefined, text?: string) {
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	const message: any = { role: "assistant" };
	if (stopReason !== undefined) message.stopReason = stopReason;
	if (text) message.content = text;
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message }, lowCtx);
}

/** R3 helper: like s38TurnEnd but attaches a `usage` object so the classifier's
 *  0-token poisoned-context signal is exercised (usage PRESENT with 0 tokens).
 *  Pass `tokens` > 0 to simulate a turn that reached the model. */
export async function s38TurnEndUsage(h: Harness, stopReason: string | undefined, text: string | undefined, tokens: number) {
	const lowCtx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }) });
	const message: any = { role: "assistant", usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
	if (stopReason !== undefined) message.stopReason = stopReason;
	if (text) message.content = text;
	await h.fire("turn_end", { type: "turn_end", turnIndex: 1, message }, lowCtx);
}

/** R7 helper: fire the same transient error text `count` times with turn_start
 *  + elapsed backoff between turns so each turn's nudge can fire. */
export async function r7RepeatTurns(h: Harness, text: string, count: number) {
	for (let i = 0; i < count; i++) {
		await s38TurnEnd(h, "error", text);
		await h.fire("turn_start", { type: "turn_start", turnIndex: i + 2 }, h.ctx());
		await new Promise((r) => setTimeout(r, 3));
	}
}

/** R7 helper: shared assertions for "stays transient" — no poisoned upgrade,
 *  no /clear advise, and the transient retry path actually ran. */
export function assertStaysTransient(h: Harness, label: string) {
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

/** The exact error bodies from the 2026-07-30 incident (GLM router flapping). */
export const R8_NO_HEALTHY_TARGET =
	'{"message":"No healthy target selected for alias \'hf:zai-org/GLM-4.7\'","type":"api_error"}';
export const R8_SOCKET_CLOSED =
	"All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"; // guardrails-allow PREVENT-PI-004: verbatim 2026-07-30 incident error text (string fixture, not a network call)
export const R8_TOO_MANY_CONCURRENT =
	'All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: {"error": "Too many concurrent requests for this model"}';
