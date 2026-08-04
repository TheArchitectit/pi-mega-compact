/**
 * s24-dashboard.test.ts — S24 memory review on compaction, live pressure band, /dashboard-* commands.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { harness } from "./_helpers.js";

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
			"../../src/store/sqlite.js"
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

test("/dashboard-status reports no server when pid file missing", async () => {
	// Private base so this asserts "no server" on a range nothing else uses,
	// not the machine-global 9320 family (which may hold a leftover/production server).
	process.env.MEGACOMPACT_DASHBOARD_PORT = "49320";
	process.env.MEGACOMPACT_DASHBOARD_HOST = "127.0.0.1";
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
		delete process.env.MEGACOMPACT_DASHBOARD_HOST;
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

test.skip("/dashboard skips server spawn when already running", async () => {
	// Use a private dashboard port base for THIS test's harness + fake server so
	// it never races the (parallel, hard-coded-9320) dashboard-server.test.js or
	// a leftover production server. Set BEFORE harness() so registerDashboardCommands
	// reads our base for findLivePort().
	process.env.MEGACOMPACT_DASHBOARD_PORT = "29320";
	process.env.MEGACOMPACT_DASHBOARD_HOST = "127.0.0.1";
	const h = harness();
	const confirms: boolean[] = [];
	const livPort = 29320; // inside the harness's private scan range (29320–29329)
	const { createServer } = await import("node:http"); // guardrails-allow PREVENT-PI-004: test-only loopback server for dashboard probe test
	const server = createServer((_req, res) => { // guardrails-allow PREVENT-PI-004: test-only loopback server for dashboard probe test
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
	delete process.env.MEGACOMPACT_DASHBOARD_HOST;
});

