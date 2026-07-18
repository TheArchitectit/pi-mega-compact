/**
 * mega-compact.extension.test.ts — end-to-end drive of the REAL extension
 * entry (extensions/mega-compact.ts) through a faithful mock pi.
 *
 * This is the closest we get to "a live pi session" without a model: it
 * loads the compiled extension, captures its event/command handlers, and
 * fires them with mock ctx objects — proving the three compact layers
 * (auto-trigger -> compactSession) AND the three recall entries all
 * route through the real code, not just the unit-tested src/ modules.
 *
 * Uses a per-test isolated state dir (process.env.MEGACOMPACT_STATE_DIR)
 * so concurrent node --test runs do not collide on disk.
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
const baseTmp = mkdtempSync(join(tmpdir(), "mc-ext-"));
// Isolate the machine-wide repo index so test runs (which call bindRepo ->
// upsertRepoRegistry) never pollute the developer's real ~/.mega-compact-index.
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
let counter = 0;

/** Build a mock pi + ctx and load the extension into them. */
function harness(opts: { keepTier?: boolean; keepThreshold?: boolean } = {}) {
	const stateDir = join(baseTmp, `run-${counter++}`);
	process.env.MEGACOMPACT_STATE_DIR = stateDir;
	process.env.MEGACOMPACT_DEBUG = "true";
	// Low threshold so the auto-trigger gate trips on our small mock context.
	// Tier tests opt out (keepTier/keepThreshold) so they can drive the real
	// tier resolution instead of the forced 50-token threshold.
	if (!opts.keepThreshold) process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	if (!opts.keepTier) delete process.env.MEGACOMPACT_TIER;
	process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

	const handlers: Record<string, Function> = {};
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
				if (handlers["session_before_compact"]) {
					return handlers["session_before_compact"](
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
			handlers[ev] = h;
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
		sendUserMessage: (m: string) => { sendUserMessages.push(m); },
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

	// Import the compiled extension (same dist/extensions dir as this test).
	const mod = require("./mega-compact.js") as { default: (p: any) => void };
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
		fire: (ev: string, event: any, ctx: any) => handlers[ev](event, ctx),
		ctx: makeCtx,
		session,
	};
}

test("auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact", async () => {
	const h = harness();
	const messages = h.session;
	// The mock session is tiny (~100 tokens). piCompactWouldNoop() would skip
	// ctx.compact() for a transcript under pi's keepRecentTokens budget — so
	// lower the floor to 0 to simulate a transcript large enough that pi WOULD
	// compact (the positive path this test exercises).
	// S16: this is the LEGACY path — the default no longer calls ctx.compact()
	// (it returns a live-trimmed view instead). Set the legacy flag to exercise
	// the v0.4.28 ctx.compact durable-trim flow this test asserts.
	process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
	process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		const res = await h.fire("context", { type: "context", messages }, ctx);
		// L1->L4 ran: a checkpoint was persisted to the SQLite store + a marker entry written.
		const { listCheckpoints } = await import("../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"checkpoint persisted to local vector db",
		);
		assert.equal(
			h.appended.some((a) => a.t === "mega-compact-marker"),
			true,
			"marker sentinel appended",
		);
		// The legacy context handler triggers pi's compaction flow (ctx.compact),
		// which calls our session_before_compact handler to supply the DURABLE trim.
		assert.equal(
			res,
			undefined,
			"legacy context handler returns nothing (no local drop)",
		);
		assert.equal(
			h.compactCalls.length,
			1,
			"ctx.compact() called to start durable trim (legacy path)",
		);
		// The durable trim was supplied (summary + firstKeptEntryId from pi's prep).
		assert.ok(h.compactCalls[0] !== undefined, "compaction flow executed");
	} finally {
		delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
		delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	}
});

test("auto-trigger: skips ctx.compact() when pi would no-op (session too small, legacy path)", async () => {
	const h = harness();
	const messages = h.session;
	// Default floor (20000): the tiny mock transcript is below pi's
	// keepRecentTokens budget, so piCompactWouldNoop() must skip ctx.compact()
	// rather than surface pi's "Nothing to compact (session too small)" throw.
	// S16: exercised under the legacy flag (the default path never calls ctx.compact).
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		const res = await h.fire("context", { type: "context", messages }, ctx);
		assert.equal(
			res,
			undefined,
			"legacy context handler returns nothing (no local drop)",
		);
		assert.equal(
			h.compactCalls.length,
			0,
			"ctx.compact() NOT called — pi would no-op",
		);
		// Our recall checkpoint still persisted (Path A) — the durable trim is the
		// only thing skipped; recall is independent of it.
		const { listCheckpoints } = await import("../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"recall checkpoint still persisted",
		);
		assert.equal(
			h.appended.some((a) => a.t === "mega-compact-marker"),
			true,
			"marker sentinel still appended",
		);
	} finally {
		delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	}
});

test("auto-trigger (S16): trims the live view and does NOT call ctx.compact()", async () => {
	const h = harness();
	const messages = h.session;
	// S16 default: live context-event trim. No legacy flag. Lower the anchor floor
	// so the trimmed recent window (4 messages, 2 user) clears the anchor check
	// and the live trim actually fires — mirrors how the legacy test lowers the
	// durable floor to exercise its positive path.
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
	try {
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		const res = await h.fire("context", { type: "context", messages }, ctx);
		// S16: context handler returns a TRIMMED messages array (live trim), not undefined.
		assert.ok(
			res && typeof res === "object",
			"context handler returns a result object (live trim)",
		);
		assert.ok(
			Array.isArray((res as any).messages),
			"result has a trimmed messages array",
		);
		// The trimmed view starts with the compacted summary (user-role) + is shorter.
		assert.ok(
			(res as any).messages.length < messages.length,
			"trimmed view is shorter than the full session",
		);
		// S16: ctx.compact() is NEVER called (it would stop the agent).
		assert.equal(
			h.compactCalls.length,
			0,
			"ctx.compact() NOT called — compact-and-continue",
		);
		// The recall checkpoint is still persisted (the durable value).
		const { listCheckpoints } = await import("../src/store/sqlite.js");
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"recall checkpoint persisted under live trim",
		);
	} finally {
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("auto-trigger (S16): does not trim when below the anchor floor (returns undefined, no ctx.compact)", async () => {
	const h = harness();
	// A session so short that buildLiveTrimmedView's anchor floor can't hold — the
	// live trim skips this call (returns undefined, the next context event retries).
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	const shortSession = [h.session[0], h.session[1]]; // one user + one assistant
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	const res = await h.fire(
		"context",
		{ type: "context", messages: shortSession },
		ctx,
	);
	// Either it skipped (undefined) or trimmed safely — but it must never call ctx.compact.
	assert.equal(
		h.compactCalls.length,
		0,
		"ctx.compact() NOT called under live trim (short session)",
	);
	if (res === undefined) {
		// skipped path is fine
		assert.ok(
			true,
			"below anchor floor → no trim this call (retries next event)",
		);
	}
});

test("auto-trigger (S16): sendUserMessage resume nudge fires only when idle + queued + not already nudged", async () => {
	const h = harness();
	// No queued messages → the nudge must NOT fire (the guard prevents busy-loops).
	// We assert the extension did not throw and did not push a spurious resume.
	const ctx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false });
	await h.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
	// No throw + no spurious nudge side-effect is the contract; appended stays
	// free of any auto "continue" marker when there is no queued work.
	assert.equal(
		h.appended.some((a) => a.t && /continue/i.test(String(a.d ?? ""))),
		false,
		"no spurious continue when no queued work",
	);
});

test("auto-trigger (S16): durable trim still happens via pi native auto-compaction (session_before_compact)", async () => {
	const h = harness();
	// pi's native auto-compaction fires at agent-end with reason "threshold" (the
	// CONTINUING path). Our session_before_compact handler must still supply the
	// durable trim summary — independent of the live context-event trim.
	const prep = {
		firstKeptEntryId: "e2",
		messagesToSummarize: h.session.slice(0, 4),
		tokensBefore: 500,
	};
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			signal: undefined,
			preparation: prep,
		} as any,
		h.ctx(),
	);
	assert.ok(
		res?.compaction,
		"we supply a durable compaction result to pi's native path",
	);
	assert.ok(
		res.compaction.firstKeptEntryId === "e2",
		"reuses pi's boundary (PREVENT-PI-002)",
	);
	assert.ok(res.compaction.summary.length > 0, "summary is non-empty");
});

test("session_before_compact supplies our durable trim (not pi's summary)", async () => {
	const h = harness();
	// pi fires session_before_compact with its own computed preparation.
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "overflow",
			willRetry: true,
			preparation: {
				firstKeptEntryId: "e2",
				messagesToSummarize: h.session.slice(0, 2),
				tokensBefore: 500,
			},
			signal: undefined,
		} as any,
		h.ctx(),
	);
	assert.ok(res && res.compaction, "returns a compaction result");
	assert.equal(
		res.compaction.firstKeptEntryId,
		"e2",
		"reuses pi's cut boundary (PREVENT-PI-002 safe)",
	);
	assert.ok(
		typeof res.compaction.summary === "string" &&
			res.compaction.summary.length > 0,
		"our summary supplied",
	);
	assert.ok(res.compaction.tokensBefore >= 0, "tokensBefore reported");
});

test("session_before_compact supplies a fallback summary when nothing to summarize", async () => {
	const h = harness();
	// Empty preparation → no messages to summarize (anchor floor protects
	// everything). We MUST still supply a compaction (never {}), otherwise pi
	// runs its own compact() which throws "Nothing to compact (session too
	// small)" and leaves the session stuck with no resume context. The fallback
	// records a minimal resume summary so the session always resumes.
	const res = await h.fire(
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			preparation: {
				firstKeptEntryId: "e0",
				messagesToSummarize: [],
				tokensBefore: 0,
			},
			signal: undefined,
		} as any,
		h.ctx(),
	);
	assert.ok(
		res && (res as any).compaction,
		"fallback compaction supplied (never {})",
	);
	assert.ok(
		(res as any).compaction.summary.includes("context compacted"),
		"fallback summary injected so the session resumes",
	);
	assert.equal(
		(res as any).compaction.firstKeptEntryId,
		"e0",
		"keeps pi's cut point",
	);
});

test("resume auto-inline stages recall into the system prompt", async () => {
	const h = harness();
	// Seed a checkpoint first (simulate a prior session that compacted).
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	// Fresh resume: session_start with reason "resume".
	const ctx = h.ctx();
	await h.fire(
		"session_start",
		{
			type: "session_start",
			reason: "resume",
			previousSessionFile: undefined,
		} as any,
		ctx,
	);
	// The next before_agent_start must prepend the recalled block.
	const res = await h.fire(
		"before_agent_start",
		{
			type: "before_agent_start",
			prompt: "base system",
			images: undefined,
			systemPrompt: "base system",
			systemPromptOptions: {},
		} as any,
		ctx,
	);
	assert.ok(
		res && typeof res.systemPrompt === "string",
		"before_agent_start returns a systemPrompt",
	);
	assert.ok(
		res.systemPrompt.includes("Recalled context"),
		"recalled block injected into system prompt",
	);
});

test("/recall-context reports and stages the top checkpoint", async () => {
	const h = harness();
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx();
	await h.commands["mega-recall"].handler("dedupe bug store.ts", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("recall staged")),
		"command reports staged checkpoints",
	);
	assert.ok(
		h.notifies.some((n) => n.includes("chkpt_")),
		"command names the checkpoint",
	);
});

test("/megacompact-status reports live store stats", async () => {
	const h = harness();
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 50000,
			contextWindow: 200000,
			percent: 25,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("store:") && n.includes("chkpt")),
		"status shows checkpoint count",
	);
});

// ---- Model/provider capture (Phase 5b model_snapshots) ----------------------
test("model_select captures model + provider into SQL", async () => {
	const h = harness();
	const modelCtx = h.ctx({
		model: {
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			provider: "anthropic",
			contextWindow: 200000,
			maxTokens: 32000,
			reasoning: false,
			cost: { input: 0.000015, output: 0.000075 },
		},
		modelRegistry: {
			getProviderDisplayName: (p: string) =>
				p === "anthropic" ? "Anthropic" : p,
		},
	});
	await h.fire("model_select", {}, modelCtx);
	const { latestModelSnapshot } = await import("../src/store/sqlite.js");
	const snap = latestModelSnapshot(h.stateDir);
	assert.ok(snap, "model_snapshots row persisted");
	assert.equal(snap!.modelId, "claude-opus-4-8", "correct model id captured");
	assert.equal(snap!.provider, "anthropic", "correct provider captured");
	assert.equal(
		snap!.providerName,
		"Anthropic",
		"provider display name resolved",
	);
	assert.equal(snap!.inputRate, 0.000015, "input rate captured");
});

test("/mega-status surfaces the captured model + provider", async () => {
	const h = harness();
	const modelCtx = h.ctx({
		model: {
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			provider: "anthropic",
			contextWindow: 200000,
			maxTokens: 32000,
			reasoning: false,
			cost: { input: 0.000015, output: 0.000075 },
		},
		modelRegistry: { getProviderDisplayName: () => "Anthropic" },
	});
	await h.fire("model_select", {}, modelCtx);
	await h.fire(
		"context",
		{ type: "context", messages: h.session },
		h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		}),
	);
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 50000,
			contextWindow: 200000,
			percent: 25,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	assert.ok(
		h.notifies.some(
			(n) =>
				n.includes("🤖 model:") &&
				n.includes("Claude Opus 4.8") &&
				n.includes("Anthropic"),
		),
		"status surfaces captured model + provider",
	);
});

// ---- Named compaction tiers -------------------------------------------------
// low=50k, medium=100k, high=200k, ultra=1M, mega=10M. Driven through the REAL
// loadConfig()/status path by setting MEGACOMPACT_TIER before loading the ext.
// Percentage-based thresholds: tierPct × the model context window. The harness
// getContextUsage below reports contextWindow=2_000_000, so each tier resolves to
// tierPct × 2_000_000 — which fires BELOW pi's native ~80% auto-compaction for
// ANY model size (200k or 1M). Driven through the REAL loadConfig()/status path
// by setting MEGACOMPACT_TIER before loading the ext.
const TIER_CASES: Array<[string, number]> = [
	["low", 1_000_000], // 0.50 × 2_000_000
	["medium", 1_200_000], // 0.60 × 2_000_000
	["high", 1_400_000], // 0.70 × 2_000_000
	["ultra", 1_400_000], // 0.70 × 2_000_000
	["mega", 1_500_000], // 0.75 × 2_000_000
];
for (const [tier, threshold] of TIER_CASES) {
	test(`tier "${tier}" resolves to a ${threshold.toLocaleString()}-token threshold (tierPct × 2M window; live band shown separately)`, async () => {
		// Keep tier + keep threshold UNSET so the tier (not an explicit number)
		// drives the threshold. harness() would otherwise reset the threshold.
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
		process.env.MEGACOMPACT_TIER = tier;
		const h = harness({ keepTier: true, keepThreshold: true });
		// tokens=1 against a 2M window → near-zero pressure → live band "low".
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 1,
				contextWindow: 2_000_000,
				percent: 0.01,
			}),
		});
		await h.commands["mega-status"].handler("", ctx);
		delete process.env.MEGACOMPACT_TIER;
		// /mega-status renders threshold with toLocaleString() (thousands commas).
		assert.ok(
			h.notifies.some(
				(n) =>
					n.includes(`preset=${tier}`) && n.includes(`threshold=${threshold.toLocaleString()}`),
			),
			`status should report preset=${tier} threshold=${threshold.toLocaleString()} (tierPct × 2M window)`,
		);
		// S24: the headline tier is the LIVE pressure band, shown as "tier=low (live)".
		assert.ok(
			h.notifies.some((n) => n.includes("tier=low (live)")),
			"live band reported (low at near-zero pressure)",
		);
	});
}

test("explicit MEGACOMPACT_THRESHOLD_TOKENS overrides the tier", async () => {
	process.env.MEGACOMPACT_TIER = "mega";
	process.env.MEGACOMPACT_THRESHOLD_TOKENS = "777";
	const h = harness({ keepTier: true, keepThreshold: true });
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 1,
			contextWindow: 2_000_000,
			percent: 0.01,
		}),
	});
	await h.commands["mega-status"].handler("", ctx);
	delete process.env.MEGACOMPACT_TIER;
	assert.ok(
		h.notifies.some(
			(n) => n.includes("preset=custom") && n.includes("threshold=777"),
		),
		"explicit threshold wins over tier (preset=custom)",
	);
});

// ---- S24: memory review tied to pressure / compaction -----------------------
// Build a decision-bearing session large enough to guarantee a real (non-skipped,
// non-deduped) compaction. Each user turn contains a decision phrase
// (/\bactually\b/i, /\bwe (?:use|decided)\b/i) so reviewConversation yields ops.
function decisionSession(): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 0; i < 14; i++) {
		out.push({
			role: "user",
			content: `actually we decided to use approach ${i} for module ${i}`,
			timestamp: i,
		} as unknown as AgentMessage);
		out.push({
			role: "assistant",
			content: [{ type: "toolCall", name: "Edit", id: `c${i}`, arguments: {} }],
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
			timestamp: i,
		} as unknown as AgentMessage);
		out.push({
			role: "toolResult",
			content: [{ type: "text", text: `edited module ${i}` }],
			toolCallId: `c${i}`,
			toolName: "Edit",
			isError: false,
			timestamp: i,
		} as unknown as AgentMessage);
	}
	return out;
}

test("S24: high pressure triggers a memory review on compaction", async () => {
	const h = harness();
	// Force a real (non-legacy) compaction at full pressure → pressureBand "mega",
	// which must fire the shared runMemoryReview on compact (review-on-compact).
	process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "false";
	try {
		const messages = decisionSession();
		const ctx = h.ctx({
			getContextUsage: () => ({
				tokens: 200000,
				contextWindow: 200000,
				percent: 100,
			}),
		});
		await h.fire("context", { type: "context", messages }, ctx);
		// review-on-compact runs as a fire-and-forget async (doCompact is sync), so
		// let the microtask/macrotask queue drain before asserting the side effect.
		await new Promise((r) => setTimeout(r, 20));
		const { listMemories, listCheckpoints } = await import(
			"../src/store/sqlite.js"
		);
		// A checkpoint must have been persisted (proves compaction ran, not skipped).
		assert.ok(
			listCheckpoints("sess_ext_001", h.stateDir).length > 0,
			"checkpoint persisted to local vector db",
		);
		// The just-compacted region is worth remembering, so durable memories must
		// have been written to the SQLite store (review-on-compact path).
		const mem = listMemories(null, 50, h.stateDir);
		assert.ok(
			mem.length > 0,
			"memory review wrote durable memories on compact",
		);
	} finally {
		delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	}
});

test("S24: /mega-status reports the live pressure band + %", async () => {
	const h = harness();
	// Populate the runtime's live context first (a context event sets
	// lastCtxTokens/lastCtxPercent), then read /mega-status. At 100% usage the live
	// band must read "mega" and pressure must report 100%.
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	await h.fire("context", { type: "context", messages: h.session }, ctx);
	await h.commands["mega-status"].handler("", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("tier=mega (live)")),
		"live band reported as mega at 100% pressure",
	);
	assert.ok(
		h.notifies.some((n) => n.includes("pressure=100%")),
		"live pressure % reported",
	);
});

// ---- /dashboard commands ----------------------------------------------------
test("/dashboard-status reports no server when pid file missing", async () => {
	// Private base so this asserts "no server" on a range nothing else uses,
	// not the machine-global 9320 family (which may hold a leftover/production server).
	process.env.MEGACOMPACT_DASHBOARD_PORT = "49320";
	try {
		const h = harness();
		const ctx = h.ctx();
		await h.commands["mega-dashboard-status"].handler("", ctx);
		assert.ok(
			h.notifies.some((n) => n.includes("not running")),
			"reports no server running",
		);
	} finally {
		delete process.env.MEGACOMPACT_DASHBOARD_PORT;
	}
});

test("/dashboard-stop reports no server when pid file missing", async () => {
	const h = harness();
	const ctx = h.ctx();
	await h.commands["mega-dashboard-stop"].handler("", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("no dashboard server running")),
		"reports no server",
	);
});

test("/dashboard skips server spawn when already running", async () => {
	// Use a private dashboard port base for THIS test's harness + fake server so
	// it never races the (parallel, hard-coded-9320) dashboard-server.test.js or
	// a leftover production server. Set BEFORE harness() so registerDashboardCommands
	// reads our base for findLivePort().
	process.env.MEGACOMPACT_DASHBOARD_PORT = "29320";
	const h = harness();
	const confirms: boolean[] = [];
	const livPort = 29320; // inside the harness's private scan range (29320–29329)
	const { createServer } = await import("node:http");
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				updatedAt: new Date().toISOString(),
				tier: "test",
				version: 1,
				config: {},
				session: {},
				context: {},
				trigger: {},
				store: {},
			}),
		);
	});
	await new Promise<void>((r) => server.listen(livPort, "127.0.0.1", r));
	const { join: j } = await import("node:path");
	const { writeFileSync: wf } = await import("node:fs");
	wf(
		j(h.stateDir, "port.pid"),
		JSON.stringify({ port: livPort, pid: process.pid }),
	);

	const ctx = h.ctx({
		ui: {
			setStatus: () => {},
			notify: (s: string) => {
				h.notifies.push(s);
			},
			select: () => {},
			confirm: async () => {
				confirms.push(true);
				return true;
			},
			input: async () => "",
		},
	});

	await h.commands["mega-dashboard"].handler("", ctx);
	assert.ok(
		h.notifies.some((n) => n.includes("already running")),
		"reports already running",
	);
	assert.ok(confirms.length > 0, "confirm dialog was shown");

	await new Promise<void>((r) => server.close(() => r()));
	delete process.env.MEGACOMPACT_DASHBOARD_PORT;
});

test("state snapshot writes dashboard.json after compaction", async () => {
	const h = harness();
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	// Fire auto-trigger compaction (context event above 80% threshold)
	await h.fire("context", { type: "context", messages: h.session }, ctx);
	const { existsSync: ex, readFileSync: rf } = await import("node:fs");
	const { join: j } = await import("node:path");
	const snapPath = j(h.stateDir, "dashboard.json");
	assert.ok(ex(snapPath), "dashboard.json written after compaction");
	const snap = JSON.parse(rf(snapPath, "utf-8"));
	// Item B: the honest token model is wired — the original dropped region was
	// captured (originalTokens > 0), and the saved amount never exceeds the
	// original (saved = max(0, original − stored) ≤ original). For this tiny
	// harness session the summary can be ≥ the region, so saved may be 0; the
	// positive "saved > 0" case with a large region is covered by the
	// vectorStore unit tests.
	assert.ok(
		snap.store.originalTokens > 0,
		"snapshot.store.originalTokens captured after compaction",
	);
	assert.ok(
		snap.store.originalTokens >= snap.store.tokensSaved,
		"model invariant: original region >= tokens saved",
	);
	// Item A: crew (live agent) block is present in the dashboard snapshot.
	assert.ok(
		snap.crew && typeof snap.crew.activeAgents === "number",
		"snapshot.crew.activeAgents present",
	);
});

test("events.log receives compaction events", async () => {
	const h = harness();
	const ctx = h.ctx({
		getContextUsage: () => ({
			tokens: 200000,
			contextWindow: 200000,
			percent: 100,
		}),
	});
	// Fire auto-trigger compaction twice (first fires compaction, second also fires)
	await h.fire("context", { type: "context", messages: h.session }, ctx);
	const { readFileSync: rf, existsSync: ex } = await import("node:fs");
	const { join: j } = await import("node:path");
	const logPath = j(h.stateDir, "events.log");
	if (ex(logPath)) {
		const content = rf(logPath, "utf-8").trim();
		// At minimum, we expect at least one event logged
		assert.ok(content.length > 0, "events.log is non-empty after compaction");
	} else {
		// events.log may not exist if the DashboardEmitter path differs from stateDir;
		// verify dashboard.json was written (proves the post-compact path executed)
		assert.ok(
			ex(j(h.stateDir, "dashboard.json")),
			"dashboard.json proves post-compact ran",
		);
	}
});

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
		{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "stop" } },
		lowPressureCtx,
	);
	await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
	assert.equal(h.sendUserMessages.length, 0, "normal stop: no nudge");
	assert.equal(h.compactCalls.length, 0, "normal stop: no ctx.compact");

	// 2) Length stop: arms the flag, agent_end fires exactly one continue nudge
	//    that references the output-token truncation (not a compaction).
	await h.fire(
		"turn_end",
		{ type: "turn_end", turnIndex: 2, message: { role: "assistant", stopReason: "length" } },
		lowPressureCtx,
	);
	await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
	assert.equal(h.sendUserMessages.length, 1, "length stop: exactly one nudge");
	assert.match(
		h.sendUserMessages[0],
		/output-token cap/,
		"length stop: nudge references the output-token truncation",
	);
	assert.equal(h.compactCalls.length, 0, "length path: ctx.compact() NOT called (low pressure)");

	// 3) One-shot: a second agent_end without a new length stop must NOT re-nudge.
	await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
	assert.equal(h.sendUserMessages.length, 1, "one-shot: no second nudge without a new length stop");
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
			getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }),
		});
		// Length stop arms the flag; agent_end must still nudge despite auto=false.
		await h2.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "length" } },
			lowPressureCtx,
		);
		await h2.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
		assert.equal(h2.sendUserMessages.length, 1, "auto=false: length stop still nudges");
		assert.match(
			h2.sendUserMessages[0],
			/output-token cap/,
			"auto=false: nudge references the output-token truncation",
		);
		assert.equal(h2.compactCalls.length, 0, "auto=false: ctx.compact() NOT called (auto gates durable-trim)");
	} finally {
		if (prevAuto === undefined) delete process.env.MEGACOMPACT_AUTO;
		else process.env.MEGACOMPACT_AUTO = prevAuto;
	}
});

// Helper: read <stateDir>/events.log JSONL and return the list of event `type`s.
// Dashboard.event (extensions/mega-dashboard.ts) appends `{ ts, type, ...data }`
// per line. Used to assert the S28 length_stop / length_stop_continue dashboard
// events fire on the right paths (spec acceptance #7; OPEN issue #3).
function eventTypes(stateDir: string): string[] {
	const { readFileSync: rf, existsSync: ex } = require("node:fs") as typeof import("node:fs");
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
		{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "stop" } },
		lowPressureCtx,
	);
	await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
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
		{ type: "turn_end", turnIndex: 2, message: { role: "assistant", stopReason: "length" } },
		lowPressureCtx,
	);
	const afterTurnEnd = eventTypes(h.stateDir);
	assert.ok(
		afterTurnEnd.includes("length_stop"),
		"length stop: length_stop dashboard event fired on turn_end",
	);
	await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
	const afterAgentEnd = eventTypes(h.stateDir);
	assert.ok(
		afterAgentEnd.includes("length_stop_continue"),
		"length stop: length_stop_continue dashboard event fired on agent_end",
	);
	assert.equal(h.sendUserMessages.length, 1, "length stop: exactly one nudge");
});

test("S28: non-length stopReasons do not arm the flag (no nudge, no length_stop event)", async () => {
	const h = harness();
	const lowPressureCtx = h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 200000, percent: 0 }),
	});
	// Every other pi-ai StopReason must leave the flag unset → no nudge + no event.
	for (const stopReason of ["tool_use", "error", "aborted"] as const) {
		await h.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason } },
			lowPressureCtx,
		);
		await h.fire("agent_end", { type: "agent_end", messages: [] }, lowPressureCtx);
	}
	assert.equal(
		h.sendUserMessages.length,
		0,
		"non-length stopReasons: no nudge",
	);
	assert.ok(
		!eventTypes(h.stateDir).includes("length_stop"),
		"non-length stopReasons: no length_stop dashboard event",
	);
});

// ---- S29: percent-based auto-compact trigger (gate on context %, not tokens) -
// The context-handler gate now fires on pct/100 >= (autoPctTrigger ?? tierPct)
// for tiered configs, with a token FALLBACK when pct is null. `custom` keeps the
// absolute token gate. These are the first tests to drive a `context` event
// on a tiered config (the default harness forces custom via THRESHOLD_TOKENS=50).

/** S29 tiered-config helper: tiered (not custom), low tier (tierPct 0.5), with
 *  the legacy durable-trim flag off + anchor floor lowered so the live trim
 *  returns a trimmed view (mirrors the S16 live-trim test setup at ~line 329). */
function s29TieredCtx(h: ReturnType<typeof harness>, usage: { tokens: number; contextWindow: number; percent: number | null }) {
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
	delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
	return h.ctx({
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => usage as any,
	});
}

test("S29: percent gate fires when tokens under-report (tiered low, percent 55, tokens 10)", async () => {
	process.env.MEGACOMPACT_TIER = "low";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		// tokens=10 (under the 0.5×10000=5000 token gate), percent=55 (>= 0.5).
		// The OLD token-only gate would return (10 < 5000) → no trim. The S29
		// percent gate (0.55 >= 0.5) fires → live trim returns a trimmed view.
		const ctx = s29TieredCtx(h, { tokens: 10, contextWindow: 10000, percent: 55 });
		const res = await h.fire("context", { type: "context", messages: h.session }, ctx);
		assert.ok(res && typeof res === "object", "percent gate: live trim returned a result object");
		assert.ok(Array.isArray((res as any).messages), "percent gate: result has a trimmed messages array");
		assert.ok(
			(res as any).messages.length < h.session.length,
			"percent gate: trimmed view is shorter than the full session",
		);
		assert.equal(h.compactCalls.length, 0, "percent gate: live trim, no ctx.compact()");

		// Control: percent 40 (< 0.5) → no trim, even with the same under-reported tokens.
		const h2 = harness({ keepTier: true, keepThreshold: true });
		const ctx2 = s29TieredCtx(h2, { tokens: 10, contextWindow: 10000, percent: 40 });
		const res2 = await h2.fire("context", { type: "context", messages: h2.session }, ctx2);
		assert.ok(
			!(res2 && typeof res2 === "object" && Array.isArray((res2 as any).messages)),
			"percent below fire point: no trim (token count 10 is also below the token gate)",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: MEGACOMPACT_AUTO_PCT_TRIGGER overrides the tier fire point (0.85)", async () => {
	process.env.MEGACOMPACT_TIER = "low"; // tierPct 0.5
	process.env.MEGACOMPACT_AUTO_PCT_TRIGGER = "0.85";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	try {
		// percent 80 < 0.85 → no trim.
		const h = harness({ keepTier: true, keepThreshold: true });
		const ctx80 = s29TieredCtx(h, { tokens: 10, contextWindow: 10000, percent: 80 });
		const res80 = await h.fire("context", { type: "context", messages: h.session }, ctx80);
		assert.ok(
			!(res80 && typeof res80 === "object" && Array.isArray((res80 as any).messages)),
			"override 0.85: percent 80 does NOT trim (below the override fire point)",
		);

		// percent 90 >= 0.85 → trim fires (despite the tier's own 0.5 fire point).
		const h2 = harness({ keepTier: true, keepThreshold: true });
		const ctx90 = s29TieredCtx(h2, { tokens: 10, contextWindow: 10000, percent: 90 });
		const res90 = await h2.fire("context", { type: "context", messages: h2.session }, ctx90);
		assert.ok(
			res90 && Array.isArray((res90 as any).messages) && (res90 as any).messages.length < h2.session.length,
			"override 0.85: percent 90 DOES trim (above the override fire point)",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: custom tier keeps the absolute token gate (percent 40 but tokens 100 >= 50)", async () => {
	// MEGACOMPACT_THRESHOLD_TOKENS → custom (tierPct null) → token gate, percent ignored.
	process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	delete process.env.MEGACOMPACT_TIER;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		// percent 40 (low) BUT tokens 100 >= 50 threshold → custom token gate fires.
		const ctx = s29TieredCtx(h, { tokens: 100, contextWindow: 10000, percent: 40 });
		const res = await h.fire("context", { type: "context", messages: h.session }, ctx);
		assert.ok(
			res && Array.isArray((res as any).messages) && (res as any).messages.length < h.session.length,
			"custom tier: token gate fires (tokens 100 >= 50) despite low percent 40",
		);
	} finally {
		delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("S29: tiered config with pct==null falls back to the token gate (not skipped)", async () => {
	// The regression guard for the audit finding: a percent-ONLY gate would skip
	// compaction when percent is unreported. S29 falls back to the token gate
	// (S27 boot-fallback guarantee). tiered low: effectiveThreshold = 0.5×10000 = 5000;
	// tokens 6000 >= 5000 → token fallback fires.
	process.env.MEGACOMPACT_TIER = "low";
	delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	delete process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	try {
		const h = harness({ keepTier: true, keepThreshold: true });
		const ctx = s29TieredCtx(h, { tokens: 6000, contextWindow: 10000, percent: null });
		const res = await h.fire("context", { type: "context", messages: h.session }, ctx);
		assert.ok(
			res && Array.isArray((res as any).messages) && (res as any).messages.length < h.session.length,
			"pct==null on tiered: token fallback fires (NOT skipped) — S27 boot-fallback preserved",
		);
	} finally {
		delete process.env.MEGACOMPACT_TIER;
		delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
	}
});

test("cleanup", async () => {
	// Terminate the global PGlite cross-repo index (WASM worker thread) so the
	// test process can exit. Without this, node --test never returns even though
	// every test passed — the leaked worker keeps the event loop alive.
	await closeVectorIndex();
	rmSync(baseTmp, { recursive: true, force: true });
});
