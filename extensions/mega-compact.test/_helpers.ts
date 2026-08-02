/**
 * Shared harness for the mega-compact split test files.
 *
 * Extracted from the top of mega-compact.test.ts: the mock-pi harness that loads
 * the compiled extension and lets tests fire event/command handlers against it.
 * Each split test file imports `harness()` (and `require`/`baseTmp` where
 * needed) so the per-test isolated state-dir environment is preserved.
 *
 * Note: relative paths are one directory deeper than the original file, hence
 * `../mega-compact.js` for the extension entry and `../../src/...` for src.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeVectorIndex } from "../../src/store/vectorIndex.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-ext-"));
// Isolate the machine-wide repo index so test runs (which call bindRepo ->
// upsertRepoRegistry) never pollute the developer's real ~/.mega-compact-index.
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
// This end-to-end extension test drives the compact/recall flow through the
// synchronous node:sqlite store (the authoritative path). The redundant PGlite
// HNSW cross-repo index is additive and exercised in its own dedicated test
// (store/vectorIndex.test.ts); starting the WASM worker here only risks the
// teardown stall that hangs node --test on some machines. Disable it for this
// suite — the extension behavior under test is identical with it off.
process.env.MEGACOMPACT_PGLITE_DISABLED = "1";
export const baseTmpDir = baseTmp;
export { closeVectorIndex };
let counter = 0;

/** Build a mock pi + ctx and load the extension into them. */
export function harness(opts: { keepTier?: boolean; keepThreshold?: boolean } = {}) {
	const stateDir = join(baseTmp, `run-${counter++}`);
	process.env.MEGACOMPACT_STATE_DIR = stateDir;
	process.env.MEGACOMPACT_DEBUG = "true";
	// Low threshold so the auto-trigger gate trips on our small mock context.
	// Tier tests opt out (keepTier/keepThreshold) so they can drive the real
	// tier resolution instead of the forced 50-token threshold.
	if (!opts.keepThreshold) process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	if (!opts.keepTier) delete process.env.MEGACOMPACT_TIER;
	process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

	const handlers: Record<string, Function[]> = {};
	const commands: Record<
		string,
		{ handler: (a: string, c: any) => Promise<void> }
	> = {};
	const appended: any[] = [];
	let statusKey: string | undefined;
	let statusText: string | undefined;
	const notifies: string[] = [];
	const compactCalls: any[] = [];
	const sendUserMessages: string[] = [];

	// Minimal AgentMessage factory for the session we project into the extension.
	function msg(role: string, text: string, toolName?: string): AgentMessage {
		if (role === "assistant" && toolName) {
			return {
				role: "assistant",
				content: [
					{ type: "toolCall", name: toolName, id: "c1", arguments: {} },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				stopReason: "tool_use",
				timestamp: 0,
			} as unknown as AgentMessage;
		}
		if (role === "toolResult" && toolName) {
			return {
				role: "toolResult",
				toolCallId: "c1",
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
			} as unknown as AgentMessage;
		}
		return {
			role: "user",
			content: text,
			timestamp: 0,
		} as unknown as AgentMessage;
	}

	const session: AgentMessage[] = [
		msg("user", "read src/vec.ts and understand the index"),
		msg("assistant", "ok", "Read"),
		msg("user", "edit src/vec.ts to add a cosine helper"),
		msg("assistant", "ok", "Edit"),
		msg("user", "now fix the dedupe bug in store.ts"),
		msg("assistant", "ok", "Edit"),
		msg("user", "actually we should add recall sorting too"),
		msg("assistant", "ok", "Edit"),
	];

	// Mirror the REAL SessionManager: getEntries() returns SessionEntry objects,
	// which the extension projects to messages via the SDK's
	// sessionEntryToContextMessages(entry). The harness must use the same shape
	// (type:"message" with a .message) or recentUserQuery() silently queries "".
	const toEntry = (m: AgentMessage, i: number): any => ({
		type: "message",
		id: `e${i}`,
		parentId: null,
		timestamp: String(i),
		message: m,
	});
	const sessionManager = {
		getSessionId: () => "sess_ext_001",
		getEntries: () => session.map(toEntry),
		// Faithful mock: getBranch() returns the current branch's entries, which
		// piCompactWouldNoop() reads to predict whether ctx.compact() would no-op.
		getBranch: () => session.map(toEntry),
	};

	function makeCtx(over: Partial<any> = {}) {
		return {
			ui: {
				setStatus: (k: string, t: string | undefined) => {
					statusKey = k;
					statusText = t;
				},
				notify: (s: string) => notifies.push(s),
				select: () => {},
				confirm: async () => true,
				input: async () => "",
				setWidget: () => {},
			},
			mode: "tui" as any,
			hasUI: true,
			cwd: stateDir,
			sessionManager,
			modelRegistry: {} as any,
			model: undefined,
			isIdle: () => true,
			isProjectTrusted: () => true,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
			// Faithful mock: ctx.compact() starts pi's flow, which fires the
			// session_before_compact handler (where WE supply the durable trim).
			compact: (opts?: any) => {
				compactCalls.push(opts);
				const _sbc = handlers["session_before_compact"]; if (_sbc && _sbc.length) {
					return _sbc[0](
						{
							type: "session_before_compact",
							reason: "threshold",
							willRetry: false,
							signal: undefined,
							// pi computed the cut honoring anchor floor + tool-pair (PREVENT-PI-002);
							// our handler reuses it as firstKeptEntryId.
							preparation: {
								firstKeptEntryId: "e2",
								messagesToSummarize: session.slice(0, 2),
								tokensBefore: 500,
							},
						} as any,
						makeCtx(),
					);
				}
				return undefined;
			},
			getSystemPrompt: () => "system base",
			...over,
		} as any;
	}

	const pi = {
		on: (ev: string, h: Function) => {
			if (!handlers[ev]) handlers[ev] = [];
			handlers[ev].push(h);
		},
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts;
		},
		registerTool: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		sendMessage: (_m: any) => {},
		sendUserMessage: (m: string) => {
			sendUserMessages.push(m);
		},
		appendEntry: (t: string, d: any) => appended.push({ t, d }),
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off" as any,
		setThinkingLevel: () => {},
	} as any;

	// Import the compiled extension (same dist dir as this test's parent).
	const mod = require("../mega-compact.js") as { default: (p: any) => void };
	mod.default(pi);

	return {
		stateDir,
		handlers,
		commands,
		appended,
		get status() {
			return { statusKey, statusText };
		},
		notifies,
		compactCalls,
		sendUserMessages,
		fire: async (ev: string, event: any, ctx: any) => { let r: any; for (const h of handlers[ev] || []) r = await h(event, ctx); return r; },
		ctx: makeCtx,
		session,
	};
}
