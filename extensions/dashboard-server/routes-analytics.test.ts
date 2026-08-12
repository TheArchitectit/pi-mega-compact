/**
 * routes-analytics.test.ts — PMA-3 route tests.
 *
 * Tests handleAnalyticsStatus + handleAnalyticsDetailed directly with mock
 * req/res and a temporary state directory (no subprocess, no port).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAnalyticsStatus, handleAnalyticsDetailed } from "./routes-analytics.js";
import { createAnalyticsStore, closeAllAnalyticsDbs } from "../../src/store/analytics/index.js";
import type { RouteContext } from "./routes-core.js";

let baseTmp: string;
let counter = 0;

beforeEach(() => {
	baseTmp = mkdtempSync(join(tmpdir(), "mc-pma3-"));
});

afterEach(() => {
	closeAllAnalyticsDbs();
	rmSync(baseTmp, { recursive: true, force: true });
});

function mockReq(method: string, url: string): IncomingMessage {
	const r = Readable.from([]) as IncomingMessage;
	Object.assign(r, { method, url, headers: {} });
	return r;
}

function mockRes(): { res: ServerResponse; status: number; body: string } {
	const state = { status: 0, body: "" };
	const res = {
		writeHead(s: number) { state.status = s; },
		end(b?: unknown) { state.body = typeof b === "string" ? b : JSON.stringify(b ?? ""); },
	} as unknown as ServerResponse;
	return { res, get status() { return state.status; }, get body() { return state.body; } } as any;
}

function ctxFor(dir: string): RouteContext {
	return { stateDir: dir } as any;
}

// ── handleAnalyticsStatus ─────────────────────────────────────────────

test("PMA-3: GET /api/analytics/status returns 200 with counts", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	// Seed a fact so counts > 0.
	const store = createAnalyticsStore({ stateDir: dir });
	store.asWriter().appendRequestEvent({
		id: "test_status_1",
		eventKind: "request_completed",
		observedAt: Date.now(),
		source: "test",
		quality: {},
	});
	store.close();

	const ctx = ctxFor(dir);
	const m = mockRes();
	const handled = handleAnalyticsStatus(mockReq("GET", "/api/analytics/status"), m.res, ctx as any);
	assert.equal(handled, true);
	assert.equal(m.status, 200);
	const parsed = JSON.parse(m.body);
	assert.equal(parsed.requestEventCount, 1);
	assert.equal(parsed.enabled, true);
});

test("PMA-3: GET /api/analytics/status on empty store returns zeros", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsStatus(mockReq("GET", "/api/analytics/status"), m.res, ctx as any);
	assert.equal(m.status, 200);
	const parsed = JSON.parse(m.body);
	assert.equal(parsed.requestEventCount, 0);
	assert.equal(parsed.freshThrough, null);
});

test("PMA-3: POST /api/analytics/status → 405", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsStatus(mockReq("POST", "/api/analytics/status"), m.res, ctx as any);
	assert.equal(m.status, 405);
});

test("PMA-3: non-analytics URL → false (passthrough)", () => {
	const m = mockRes();
	const handled = handleAnalyticsStatus(mockReq("GET", "/api/version"), m.res, ctxFor(join(baseTmp, "x")) as any);
	assert.equal(handled, false);
});

// ── handleAnalyticsDetailed ───────────────────────────────────────────

test("PMA-3: GET /api/analytics/detailed returns events", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const store = createAnalyticsStore({ stateDir: dir });
	store.asWriter().appendRequestEvent({
		id: "detail_1",
		correlationId: "corr_1",
		sessionId: "sess_test",
		eventKind: "request_completed",
		observedAt: 1000,
		provider: "anthropic",
		model: "claude-sonnet-4",
		status: "stop",
		inputTokens: 5000,
		outputTokens: 1200,
		source: "test",
		quality: {},
	});
	store.close();

	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsDetailed(mockReq("GET", "/api/analytics/detailed"), m.res, ctx as any);
	assert.equal(m.status, 200);
	const parsed = JSON.parse(m.body);
	assert.equal(parsed.events.length, 1);
	assert.equal(parsed.events[0].provider, "anthropic");
	assert.equal(parsed.events[0].inputTokens, 5000);
	assert.equal(parsed.total, 1);
	assert.equal(parsed.hasMore, false);
});

test("PMA-3: GET /api/analytics/detailed with provider filter", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const store = createAnalyticsStore({ stateDir: dir });
	store.asWriter().appendRequestEvent({
		id: "f1", eventKind: "request_completed", observedAt: 1000,
		provider: "anthropic", source: "test", quality: {},
	});
	store.asWriter().appendRequestEvent({
		id: "f2", eventKind: "request_completed", observedAt: 2000,
		provider: "openai", source: "test", quality: {},
	});
	store.close();

	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsDetailed(mockReq("GET", "/api/analytics/detailed?provider=anthropic"), m.res, ctx as any);
	assert.equal(m.status, 200);
	const parsed = JSON.parse(m.body);
	assert.equal(parsed.events.length, 1);
	assert.equal(parsed.events[0].provider, "anthropic");
});

test("PMA-3: GET /api/analytics/detailed on empty → 0 events", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsDetailed(mockReq("GET", "/api/analytics/detailed"), m.res, ctx as any);
	assert.equal(m.status, 200);
	const parsed = JSON.parse(m.body);
	assert.equal(parsed.events.length, 0);
	assert.equal(parsed.total, 0);
});

test("PMA-3: invalid limit param → 400", () => {
	const dir = join(baseTmp, `run-${counter++}`);
	const ctx = ctxFor(dir);
	const m = mockRes();
	handleAnalyticsDetailed(mockReq("GET", "/api/analytics/detailed?limit=abc"), m.res, ctx as any);
	assert.equal(m.status, 400);
});
