/**
 * mega-cache-replay.test.ts — locks the v0.8.7 cache-stability fix.
 *
 * Two tests (reuses the mega-teamrun.test.ts harness shape: mock pi + the REAL
 * compiled extension at extensions/mega-compact.js):
 *  a. REPLAY: drive >=2 gated context events past the debounce within ONE epoch
 *     (same lastCheckpointId) and assert diagLiveTrimReplays > 0 AND the returned
 *     messages array is byte-identical (deepEqual) across replays (stable prefix).
 *  b. DEDUP-ON-DIFFERENT-CHECKPOINT: after a fresh trim, simulate a re-compact
 *     (context grew on the token basis) that DEDUPS onto a DIFFERENT existing
 *     checkpoint id (L0 contentHash match against an OLDER checkpoint, so
 *     result.checkpointId != rt.lastCheckpointId), then assert the NEXT gated
 *     event STILL replays (diagLiveTrimReplays increments) — i.e. the cache key
 *     trimCache.checkpointId === rt.lastCheckpointId holds. This is the P2 gap the
 *     v0.8.6 audit found: keying on the dedup-volatile result.checkpointId
 *     disabled replay for the rest of the epoch after such a dedup fire.
 *
 * MEGACOMPACT_PGLITE_DISABLED keeps the run fast (no WASM index init).
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
const baseTmp = mkdtempSync(join(tmpdir(), "mc-cache-"));
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
process.env.MEGACOMPACT_PGLITE_DISABLED = "true"; // fast: skip WASM index
let counter = 0;

function harness() {
	const stateDir = join(baseTmp, `run-${counter++}`);
	process.env.MEGACOMPACT_STATE_DIR = stateDir;
	process.env.MEGACOMPACT_DEBUG = "true";
	process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
	process.env.MEGACOMPACT_FAST_GATE_PCT = "1";
	process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
	process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
	process.env.MEGACOMPACT_MEMORY_AUTO_REVIEW = "false";
	process.env.MEGACOMPACT_RAPTOR_ENABLED = "false";
	// Disable the FUZZY dedup tiers (L1 MinHash/LSH + L2 cosine) so the DEDUP test
	// is controlled by L0 contentHash only: setB (different vocabulary) then
	// creates a genuinely NEW checkpoint instead of fuzzy-matching setA's, and
	// setA-re-again still L0-contentHash-dedups onto the first setA checkpoint.
	// The TrigramEmbedder otherwise matches on shared structural trigrams
	// ("— step N" / "Edit"), collapsing setB onto setA. Harmless for the REPLAY
	// test (pure replay, no dedup reliance).
	process.env.MEGACOMPACT_L1_ENABLED = "false";
	process.env.MEGACOMPACT_L2_ENABLED = "false";
	delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;

	// Mutable context-usage so tests can drive re-compact on the TOKEN basis by
	// raising `tokens` while keeping `percent` null (→ token gate + token
	// grewEnough path in context-handler.ts). The REPLAY test keeps percent=100 so
	// the percent-basis grewEnough (>=10) never trips (no re-compact → pure replay).
	const usage = {
		tokens: 200000,
		contextWindow: 200000,
		percent: 100 as number | null,
	};

	const handlers: Record<string, Function[]> = {};
	const compactCalls: any[] = [];

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
				content: [{ type: "text", text }],
				toolCallId: "c1",
				toolName,
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

	// Build a session of `n` tool-call triples tagged `tag`. Set A and B differ in
	// content (so B never dedups against A) but A === A reproduces the same
	// regionText → same L0 contentHash → dedup onto the first A checkpoint.
	function buildSession(tag: string, n: number): AgentMessage[] {
		const s: AgentMessage[] = [];
		for (let i = 0; i < n; i++) {
			s.push(
				msg("user", `[${tag}] we decided to use approach ${i} for module ${i}`),
			);
			s.push(msg("assistant", `[${tag}] edited module ${i}`, "Edit"));
			s.push(msg("toolResult", `[${tag}] edited module ${i}`, "Edit"));
		}
		return s;
	}

	const toEntry = (m: AgentMessage, i: number): any => ({
		type: "message",
		id: `e${i}`,
		parentId: null,
		timestamp: String(i),
		message: m,
	});
	const sessionManager = {
		getSessionId: () => "sess_cache_001",
		getEntries: () => buildSession("A", 14).map(toEntry),
		getBranch: () => buildSession("A", 14).map(toEntry),
	};

	function makeCtx(over: Partial<any> = {}) {
		return {
			ui: {
				setStatus: () => {},
				notify: () => {},
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
			getContextUsage: () => ({ ...usage }),
			compact: (opts?: any) => {
				compactCalls.push(opts);
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
		registerCommand: () => {},
		registerTool: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
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

	const mod = require("./mega-compact.js") as { default: (p: any) => void };
	mod.default(pi);
	const { lastRuntime } = require("./mega-events.js") as { lastRuntime: any };

	const fire = async (ev: string, event: any, ctx: any) => {
		let r: any;
		for (const h of handlers[ev] || []) r = await h(event, ctx);
		return r;
	};
	return {
		stateDir,
		handlers,
		compactCalls,
		fire,
		ctx: makeCtx,
		usage,
		buildSession,
		runtime: lastRuntime, // MegaRuntime with diag* counters + rt + trimCache
		// Bypass the 2s debounce so each fire proceeds without real waiting.
		clearDebounce: () => {
			if (lastRuntime) lastRuntime.debounceUntil = 0;
		},
	};
}

test("REPLAY: >=2 gated context events within one epoch replay verbatim (byte-identical)", async () => {
	const h = harness();
	const ctx = h.ctx();
	const session = h.buildSession("A", 14);

	// Fire 3 gated context events; clearDebounce between so each passes the gate.
	// percent stays 100 → percent-basis grewEnough (>=10) never trips → pure replay.
	h.clearDebounce();
	const r1 = await h.fire(
		"context",
		{ type: "context", messages: session },
		ctx,
	);
	h.clearDebounce();
	const r2 = await h.fire(
		"context",
		{ type: "context", messages: session },
		ctx,
	);
	h.clearDebounce();
	const r3 = await h.fire(
		"context",
		{ type: "context", messages: session },
		ctx,
	);

	const rt = h.runtime;
	assert.ok(rt.diagLiveTrimFires >= 1, "fresh trim fired on first event");
	assert.ok(
		rt.diagLiveTrimReplays >= 2,
		`replay fired >=2 (got ${rt.diagLiveTrimReplays})`,
	);
	// byte-identical (stable KV-cache prefix) across replays
	assert.deepEqual(
		r2?.messages,
		r3?.messages,
		"replay messages byte-identical across replays",
	);
	// replay matches the fresh-trim view (shallow-copy preserves content)
	assert.deepEqual(
		r1?.messages,
		r2?.messages,
		"replay matches fresh-trim view (stable prefix)",
	);
});

test("DEDUP: re-compact that dedups onto a DIFFERENT checkpoint still replays next (P2 fix)", async () => {
	const h = harness();
	// Token-basis growth path: percent null → token gate + token grewEnough
	// (currentTokens - trimCache.ctxTokens >= effectiveThreshold * 0.5 = 25).
	h.usage.percent = null;
	h.usage.tokens = 200000;
	const ctx = h.ctx();
	const setA = h.buildSession("A", 14);
	const setB = h.buildSession("B", 14); // different content, same length
	const rt = h.runtime;

	// 1) Fresh trim on setA → genuinely new checkpoint cp_A. lastCheckpointId = cp_A.
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: setA }, ctx);
	const cpA = rt.rt.lastCheckpointId;
	assert.ok(cpA, "cp_A created on fresh trim");
	assert.equal(rt.diagLiveTrimFires, 1, "first fire was a fresh trim");

	// 2) Re-compact on setB (grew tokens) → genuinely new checkpoint cp_B (not deduped).
	h.usage.tokens = 200100; // grew 100 >= 25
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: setB }, ctx);
	const cpB = rt.rt.lastCheckpointId;
	assert.notEqual(cpB, cpA, "cp_B is a different, genuinely new checkpoint");
	assert.equal(
		rt.rt.dedupSkips,
		0,
		"setB did not dedup (different vocabulary, fuzzy tiers off)",
	);

	// 3) Re-compact on setA AGAIN (grew tokens) → L0 contentHash dedup onto cp_A.
	//    result.checkpointId = cp_A (!= lastCheckpointId cp_B); lastCheckpointId is
	//    NOT updated on a dedup (compact.ts:100-104), so it stays cp_B. With the
	//    fix, trimCache.checkpointId is keyed on lastCheckpointId (cp_B), NOT the
	//    dedup-volatile result.checkpointId (cp_A).
	h.usage.tokens = 200200; // grew 100 >= 25
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: setA }, ctx);
	assert.equal(
		rt.rt.lastCheckpointId,
		cpB,
		"dedup did NOT bump lastCheckpointId (still cp_B)",
	);
	assert.ok(
		rt.rt.dedupSkips >= 1,
		"setA re-compact deduped onto an existing checkpoint",
	);
	// The P2 invariant: the cache key must equal the stable epoch signal.
	assert.equal(
		rt.trimCache?.checkpointId,
		rt.rt.lastCheckpointId,
		"trimCache.checkpointId keyed on lastCheckpointId (P2 fix), not dedup-volatile result.checkpointId",
	);

	// 4) Next gated event (no growth) MUST replay instead of re-running runCompact.
	//    Without the fix, trimCache.checkpointId (cp_A) != lastCheckpointId (cp_B)
	//    → the replay condition is false → runCompact re-runs every fire → the
	//    thrash silently persists in that path (the audit's finding).
	const replaysBefore = rt.diagLiveTrimReplays;
	h.usage.tokens = 200200; // no growth → replay
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: setA }, ctx);
	assert.ok(
		rt.diagLiveTrimReplays > replaysBefore,
		`replay fired after dedup-onto-different-checkpoint (got ${rt.diagLiveTrimReplays}, was ${replaysBefore})`,
	);
});

// D.4-test-1 — Debounce exemption: the replay path sits BEFORE the debounce guard.
// Two gated events <2s apart (no clearDebounce) must both replay — diagCtxDebounce
// must NOT increment because the debounce guard is never reached when replay fires.
test("DEBOUNCE-EXEMPTION: two events <2s apart (no clearDebounce) both replay; debounce never reached", async () => {
	const h = harness();
	const ctx = h.ctx();
	const session = h.buildSession("A", 14);

	// 1) Fresh trim.
	h.clearDebounce(); // first event always needs a clear to pass the time guard
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(h.runtime.diagLiveTrimFires, 1, "first fire was fresh trim");

	// 2) Fire two events IN QUICK SUCCESSION without clearing the debounce.
	//    The replay path (D.2) sits BEFORE the debounce guard, so both should
	//    replay the cached trim and the debounce guard is NEVER reached.
	const dbgBefore = h.runtime.diagCtxDebounce;
	const rpyBefore = h.runtime.diagLiveTrimReplays;

	await h.fire("context", { type: "context", messages: session }, ctx);
	await h.fire("context", { type: "context", messages: session }, ctx);

	assert.equal(
		h.runtime.diagCtxDebounce,
		dbgBefore,
		`debounce counter unchanged (${h.runtime.diagCtxDebounce} == ${dbgBefore}) — replay path was reached, not debounce`,
	);
	assert.ok(
		h.runtime.diagLiveTrimReplays >= rpyBefore + 2,
		`both events replayed (replays ${h.runtime.diagLiveTrimReplays} >= ${rpyBefore}+2)`,
	);
});

// D.4-test-2 — Skip→replay fallback: when runCompact returns {skipped: true} and
// a valid trimCache exists, the handler replays the cached trim instead of returning
// empty. We force a skip by firing with a 1-message session (view.length ≤ 1) AFTER
// a fresh trim with a full session has populated trimCache.
test("SKIP-FALLBACK: runCompact skipped + valid trimCache → replays cached trim", async () => {
	const h = harness();
	const ctx = h.ctx();
	const session = h.buildSession("A", 14);

	// 1) Fresh trim with full session → populates trimCache with a valid cut.
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(
		h.runtime.diagLiveTrimFires,
		1,
		"fresh trim populated trimCache",
	);
	assert.ok(h.runtime.trimCache, "trimCache is set");

	// 2) Lower the cut so a 1-message session still passes the cut≤length guard.
	//    The skip→replay path checks cut <= messages.length before replaying.
	h.runtime.trimCache.cut = 0;

	// 3) Drive context growth so grewEnough=true (replay skipped → runCompact runs).
	//    Then fire with just 1 message → runCompact: view.length ≤ 1 → {skipped: true}.
	h.usage.percent = null; // token-basis path
	h.usage.tokens = 200100; // grew 100 >= 25 (effectiveThreshold * 0.5)
	h.clearDebounce();
	const oneMsg = [h.buildSession("X", 1)[0]]; // single user message
	await h.fire("context", { type: "context", messages: oneMsg }, ctx);

	assert.ok(
		h.runtime.diagCtxRunSkipped >= 1,
		`diagCtxRunSkipped incremented (got ${h.runtime.diagCtxRunSkipped})`,
	);
	// The skip path replays trimCache → diagLiveTrimReplays increments.
	assert.ok(
		h.runtime.diagLiveTrimReplays >= 1,
		`skip→replay fired (replays ${h.runtime.diagLiveTrimReplays} >= 1)`,
	);
});

// D.4-test-3 — Recompact delta boundary: config.recompactPctDelta = 50.
// 49% growth → replay (not enough to re-compact).
// 51% growth → fresh compaction (exceeds the 50% delta threshold).
//
// diagLiveTrimFires counts every trim response (replay OR fresh), including
// the initial fresh trim, so cumulative counts can't validate discrete steps.
// Instead we snapshot (fires, replays) before each step and assert the delta.
test("DELTA-BOUNDARY: 49% growth → replay; 51% growth → fresh compaction", async () => {
	const h = harness();
	const ctx = h.ctx();
	const session = h.buildSession("A", 14);

	// Start at low context (percent=5). The handler captures ctxPct from the first
	// trim, then checks pct - ctxPct >= 50 (config.recompactPctDelta default=50).
	h.usage.percent = 5;
	h.usage.tokens = 200000;

	// 1) Fresh trim at pct=5 → trimCache.ctxPct = 5.
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.ok(h.runtime.diagLiveTrimFires >= 1, "fresh trim at pct=5");
	assert.equal(h.runtime.trimCache?.ctxPct, 5, "ctxPct captured as 5");

	// 2) 49% growth: pct=54. grewEnough = 54-5 = 49 < 50 → replay.
	//    Replay increments BOTH fires and replays (line 247-248).
	h.usage.percent = 54;
	h.clearDebounce();
	const { fires: f2, replays: r2 } = {
		fires: h.runtime.diagLiveTrimFires,
		replays: h.runtime.diagLiveTrimReplays,
	};
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(
		h.runtime.diagLiveTrimFires,
		f2 + 1,
		`49% growth: fires +1 (replay counted as fire, ${f2}→${h.runtime.diagLiveTrimFires})`,
	);
	assert.equal(
		h.runtime.diagLiveTrimReplays,
		r2 + 1,
		`49% growth: replays +1 (${r2}→${h.runtime.diagLiveTrimReplays})`,
	);

	// 3) 51% growth: pct=56. grewEnough = 56-5 = 51 >= 50 → falls through to
	//    debounce → runCompact → fresh compaction (line 509).
	//    Fresh compaction increments fires but NOT replays.
	h.usage.percent = 56;
	h.clearDebounce();
	const { fires: f3, replays: r3 } = {
		fires: h.runtime.diagLiveTrimFires,
		replays: h.runtime.diagLiveTrimReplays,
	};
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(
		h.runtime.diagLiveTrimFires,
		f3 + 1,
		`51% growth: fires +1 (fresh compaction, ${f3}→${h.runtime.diagLiveTrimFires})`,
	);
	assert.equal(
		h.runtime.diagLiveTrimReplays,
		r3,
		`51% growth: replays unchanged (fresh compaction ≠ replay, stays ${r3})`,
	);
});

// D.4-test-4 — Epoch invalidation (PREVENT-PI-001/002 guard): a checkpointId
// mismatch means the durable transcript was truncated (session_compact or
// resetRuntime). The replay guard MUST reject a stale trimCache in that case.
test("EPOCH-INVALIDATION: checkpointId mismatch → replay does NOT fire (PREVENT-PI-001/002)", async () => {
	const h = harness();
	const ctx = h.ctx();
	const session = h.buildSession("A", 14);

	// 1) Fresh trim → trimCache.checkpointId = lastCheckpointId = "cp-1".
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(h.runtime.diagLiveTrimFires, 1, "fresh trim");
	assert.ok(h.runtime.trimCache?.checkpointId, "trimCache has checkpointId");

	// 2) Simulate a session_compact (durable truncation) by advancing
	//    lastCheckpointId (harder: the compact path tracks its own epoch).
	//    A mismatch between trimCache.checkpointId and rt.lastCheckpointId means
	//    the cached cut is for a truncated transcript → replay must NOT fire.
	h.runtime.rt.lastCheckpointId = "cp-mismatch";
	assert.notEqual(
		h.runtime.trimCache?.checkpointId,
		h.runtime.rt.lastCheckpointId,
		"checkpointIds differ after simulated durable truncation",
	);

	// 3) Fire the same session (no growth → would normally replay if epoch matched).
	const rpyBefore = h.runtime.diagLiveTrimReplays;
	h.clearDebounce();
	await h.fire("context", { type: "context", messages: session }, ctx);

	// Replay path was blocked by the checkpointId guard → a fresh trim fires instead.
	assert.equal(
		h.runtime.diagLiveTrimReplays,
		rpyBefore,
		`replay NOT incremented (was ${rpyBefore}, still ${h.runtime.diagLiveTrimReplays}) — stale trimCache rejected`,
	);
	// A fresh compaction should have been triggered instead (grewEnough=false, but
	// replay guard failed → falls through to debounce → runCompact → fresh trim).
	// Actually: grewEnough is false (no growth since last fire), and the replay
	// guard rejected → falls to debounce (cleared) → runCompact.
	// runCompact may skip or produce a fresh trim; either way the stale replay is blocked.
	assert.ok(
		h.runtime.diagLiveTrimFires >= 2 || h.runtime.diagCtxRunSkipped >= 1,
		`handler did NOT replay stale trimCache (fires=${h.runtime.diagLiveTrimFires}, skipped=${h.runtime.diagCtxRunSkipped}, replays=${h.runtime.diagLiveTrimReplays})`,
	);

	// Restore for cleanup.
	h.runtime.rt.lastCheckpointId = "cp-1";
});

test("cleanup", async () => {
	await closeVectorIndex();
	rmSync(baseTmp, { recursive: true, force: true });
});
