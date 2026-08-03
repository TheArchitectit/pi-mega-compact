/**
 * dashboard-server/routes-rag-metrics.test.ts — GET /api/rag-metrics tests (H2).
 *
 * Handler-level test with a real turns.db (no mocks): seeds telemetry rows then
 * asserts the aggregated JSON shape.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRouteContext } from "./routes-core.js";
import { handleRagMetrics } from "./routes-rag-metrics.js";
import { openTurnStore, closeTurnStore } from "../../src/store/turns/index.js";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "mega-ragm-route-test-"));
});

afterEach(() => {
	try {
		closeTurnStore(testDir);
	} catch {
		/* ignore */
	}
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function makeReq(method: string, url = "/api/rag-metrics"): IncomingMessage {
	return { method, url, headers: {} } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; body: string; statusCode: number } {
	let body = "";
	let statusCode = 0;
	const res = {
		writeHead(code: number, _headers?: Record<string, string>) {
			statusCode = code;
		},
		end(chunk?: string) {
			if (chunk) body = chunk;
		},
	} as unknown as ServerResponse;
	return {
		res,
		get body() {
			return body;
		},
		get statusCode() {
			return statusCode;
		},
	};
}

function ctx() {
	return buildRouteContext({
		snapshotPath: join(testDir, "dashboard.json"),
		eventsPath: join(testDir, "events.log"),
		stateDir: testDir,
		SERVER_VERSION: "9.9.9-test",
		serveClientAsset: () => false,
		detectCrossRepoDrift: () => {
			return {
				generatedAt: 0,
				totals: { ok: 0, warn: 0, stale: 0, compactionLag: 0, modelChurn: 0 },
				repos: [],
			};
		},
	});
}

function seedTelemetry(): void {
	const db = openTurnStore(testDir);
	const now = Date.now();
	for (const i of [0, 1]) {
		db.prepare(
			`INSERT INTO turns (conversation_id, session_id, turn_index, role, ended_at,
			      hyde_ran, hyde_doc, hyde_raw_count, hyde_hyde_count, hyde_fused_count,
			      hyde_lift, hyde_generation_ms, recall_score, recall_pass,
			      recall_relevance, recall_coverage, recall_diversity, recall_specificity)
		   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"conv1",
			`sess_${i}`,
			i,
			"assistant",
			now,
			1,
			"hypo doc",
			4,
			6,
			8,
			2,
			42,
			0.7,
			1,
			0.8,
			0.6,
			0.5,
			0.4,
		);
	}
}

describe("handleRagMetrics", () => {
	it("GET returns 200 with aggregated rag-metrics shape", () => {
		seedTelemetry();
		const req = makeReq("GET");
		const r = makeRes();
		const handled = handleRagMetrics(req, r.res, ctx());
		assert.equal(handled, true, "handler must return true");
		assert.equal(r.statusCode, 200);
		const parsed = JSON.parse(r.body) as {
			flags: { hydeEnabled: boolean; recallMetricsEnabled: boolean };
			totals: {
				telemetryTurns: number;
				hydeRanTurns: number;
				avgLift: number;
				avgGenerationMs: number;
			};
			recent: unknown[];
			daily: unknown[];
		};
		assert.equal(parsed.totals.telemetryTurns, 2);
		assert.equal(parsed.totals.hydeRanTurns, 2);
		assert.equal(parsed.totals.avgLift, 2);
		assert.equal(parsed.totals.avgGenerationMs, 42);
		assert.equal(parsed.recent.length, 2);
		assert.ok(Array.isArray(parsed.daily), "daily must be an array");
		assert.equal(typeof parsed.flags.hydeEnabled, "boolean");
		assert.equal(typeof parsed.flags.recallMetricsEnabled, "boolean");
	});

	it("empty turns.db returns zeroed totals", () => {
		const req = makeReq("GET");
		const r = makeRes();
		handleRagMetrics(req, r.res, ctx());
		const parsed = JSON.parse(r.body) as {
			totals: { telemetryTurns: number; hydeRanTurns: number; avgLift: number; avgScore: number | null; recentPassRate: number };
		};
		assert.equal(parsed.totals.telemetryTurns, 0);
		assert.equal(parsed.totals.hydeRanTurns, 0);
		assert.equal(parsed.totals.avgLift, 0);
		assert.equal(parsed.totals.avgScore, null);
		assert.equal(parsed.totals.recentPassRate, 0);
	});

	it("non-GET returns 405", () => {
		const req = makeReq("POST");
		const r = makeRes();
		const handled = handleRagMetrics(req, r.res, ctx());
		assert.equal(handled, false, "non-GET / non-matching must fall through");
	});
});
