/**
 * analytics-handler.test.ts — PMA-2 adapter tests.
 *
 * Tests the event-to-fact mapping, correlation, TTFT capture, flag gating,
 * and non-fatal behavior. Uses a lightweight mock pi + real analytics.db.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAnalyticsHandler, closeAnalyticsStores, __pmaTimingForTest } from "./analytics-handler.js";
import { createAnalyticsStore, closeAllAnalyticsDbs } from "../../src/store/analytics/index.js";
import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-pma2-"));
let counter = 0;

/** Minimal mock pi that captures handler registrations. */
function mockPi() {
	const handlers: Record<string, Function[]> = {};
	return {
		on: (ev: string, h: Function) => {
			if (!handlers[ev]) handlers[ev] = [];
			handlers[ev].push(h);
		},
		fire: async (ev: string, event: unknown) => {
			for (const h of handlers[ev] || []) await h(event, {});
		},
		registeredEvents: () => Object.keys(handlers),
	} as any;
}

/** Minimal mock runtime with just the fields the adapter reads. */
function mockRuntime(stateDir: string): MegaRuntime {
	return {
		currentStateDir: stateDir,
		rt: { sessionId: "sess_pma2" },
		currentTurn: 0,
		perfTurnStart: 0,
		currentModel: {
			provider: "anthropic",
			providerName: "Anthropic",
			modelId: "claude-sonnet-4",
			modelName: "Claude Sonnet 4",
		},
	} as unknown as MegaRuntime;
}

const configOn = { providerModelAnalytics: true } as MegaConfig;
const configOff = { providerModelAnalytics: false } as MegaConfig;

function stateDir(): string {
	return join(baseTmp, `run-${counter++}`);
}

// ── Flag OFF: no-op ───────────────────────────────────────────────────

test("PMA-2: flag OFF registers no handlers + opens no DB", () => {
	const pi = mockPi();
	const rt = mockRuntime(stateDir());
	registerAnalyticsHandler(pi, rt, configOff);
	// No handlers should be registered.
	assert.equal((pi as any).registeredEvents().length, 0, "no handlers registered when flag OFF");
	// No analytics.db should exist.
	assert.ok(!existsSync(join(rt.currentStateDir, "analytics.db")), "no DB opened when flag OFF");
	closeAnalyticsStores();
});

// ── Flag ON: request lifecycle round-trip ─────────────────────────────

test("PMA-2: turn_start + turn_end → request_started + request_completed in analytics.db", async () => {
	const pi = mockPi();
	const dir = stateDir();
	const rt = mockRuntime(dir);
	registerAnalyticsHandler(pi, rt, configOn);

	// Fire turn_start.
	await (pi as any).fire("turn_start", { turnIndex: 0 });
	// Fire turn_end with a usage block + stopReason.
	await (pi as any).fire("turn_end", {
		turnIndex: 0,
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300 },
		},
	});

	// Check analytics.db has the facts.
	const store = createAnalyticsStore({ stateDir: dir });
	const st = store.asReader().status();
	assert.equal(st.requestEventCount, 2, "2 events: request_started + request_completed");
	store.close();
	closeAnalyticsStores();
});

// ── Correlation: started + completed share correlationId ──────────────

test("PMA-2: request_started and request_completed share correlationId", async () => {
	const pi = mockPi();
	const dir = stateDir();
	const rt = mockRuntime(dir);
	registerAnalyticsHandler(pi, rt, configOn);

	await (pi as any).fire("turn_start", { turnIndex: 1 });
	await (pi as any).fire("turn_end", {
		turnIndex: 1,
		message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
	});

	// The correlationId is req_<sessionId>_<turnIndex>. Verify the adapter set it.
	assert.equal(
		__pmaTimingForTest(rt).correlationId,
		null, // consumed at turn_end
		"correlationId consumed after turn_end",
	);
	// Verify it was set during turn_start (re-fire to check).
	await (pi as any).fire("turn_start", { turnIndex: 2 });
	const corr = __pmaTimingForTest(rt).correlationId as string | null;
	assert.ok(
		corr?.includes("sess_pma2"),
		"correlationId includes sessionId",
	);
	assert.ok(
		corr?.includes("_2"),
		"correlationId includes turnIndex 2",
	);
	closeAnalyticsStores();
});

// ── TTFT: message_update stamps ttft ──────────────────────────────────

test("PMA-2: message_update with text_start captures TTFT", async () => {
	const pi = mockPi();
	const dir = stateDir();
	const rt = mockRuntime(dir);
	registerAnalyticsHandler(pi, rt, configOn);

	await (pi as any).fire("turn_start", { turnIndex: 3 });
	await (pi as any).fire("before_provider_request", {});
	// Small delay so TTFT > 0.
	await new Promise((r) => setTimeout(r, 5));
	await (pi as any).fire("message_update", { assistantMessageEvent: { type: "text_start" } });
	assert.ok(__pmaTimingForTest(rt).ttft > 0, "TTFT stamped after text_start");

	// Second message_update should NOT overwrite (guard).
	const firstTtft = __pmaTimingForTest(rt).ttft;
	await new Promise((r) => setTimeout(r, 5));
	await (pi as any).fire("message_update", { assistantMessageEvent: { type: "text_delta" } });
	assert.equal(__pmaTimingForTest(rt).ttft, firstTtft, "TTFT not overwritten by subsequent chunks");
	closeAnalyticsStores();
});

// ── Non-fatal: adapter never throws ───────────────────────────────────

test("PMA-2: adapter never throws on bad input (non-fatal)", async () => {
	const pi = mockPi();
	const rt = mockRuntime(stateDir());
	registerAnalyticsHandler(pi, rt, configOn);

	// Fire events with missing/malformed payloads — must not throw.
	await (pi as any).fire("turn_start", {}); // no turnIndex
	await (pi as any).fire("turn_end", { message: {} }); // no usage, no stopReason
	await (pi as any).fire("message_update", {}); // no assistantMessageEvent
	assert.ok(true, "adapter survived malformed events");
	closeAnalyticsStores();
});

// ── request_failed: error stopReason → request_failed ─────────────────

test("PMA-2: stopReason='error' → request_failed event", async () => {
	const pi = mockPi();
	const dir = stateDir();
	const rt = mockRuntime(dir);
	registerAnalyticsHandler(pi, rt, configOn);

	await (pi as any).fire("turn_start", { turnIndex: 4 });
	await (pi as any).fire("turn_end", {
		turnIndex: 4,
		message: { role: "assistant", stopReason: "error", errorMessage: "500 Internal" },
	});

	const store = createAnalyticsStore({ stateDir: dir });
	const st = store.asReader().status();
	assert.equal(st.requestEventCount, 2, "2 events: started + failed");
	store.close();
	closeAnalyticsStores();
});

test("PMA-2 cleanup", () => {
	closeAnalyticsStores();
	closeAllAnalyticsDbs();
	rmSync(baseTmp, { recursive: true, force: true });
});
