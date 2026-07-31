/**
 * dashboard-server/routes-memory.test.ts — /api/memory-status route tests (S53B).
 *
 * Verifies GET /api/memory-status returns memoryStats() data and handles
 * method errors (405) correctly.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRouteContext } from "./routes-core.js";
import { handleMemoryStatus } from "./routes-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function newDir(): string {
	return mkdtempSync(join(tmpdir(), "mega-memory-route-test-"));
}

function makeReq(method: string, url = "/api/memory-status"): IncomingMessage {
	return {
		method,
		url,
		headers: {},
	} as unknown as IncomingMessage;
}

function makeRes(): {
	res: ServerResponse;
	body: string;
	statusCode: number;
} {
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
	return { res, get body() { return body; }, get statusCode() { return statusCode; } };
}

function mockDriftReport(_idxDir: string) {
	return {
		generatedAt: 0,
		totals: { ok: 0, warn: 0, stale: 0, compactionLag: 0, modelChurn: 0 },
		repos: [],
	};
}

beforeEach(() => {
	testDir = newDir();
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("handleMemoryStatus", () => {
	it("GET returns 200 with memoryStats payload", () => {
		const ctx = buildRouteContext({
			snapshotPath: join(testDir, "dashboard.json"),
			eventsPath: join(testDir, "events.log"),
			stateDir: testDir,
			SERVER_VERSION: "9.9.9-test",
			serveClientAsset: () => false,
			detectCrossRepoDrift: mockDriftReport,
		});
		const req = makeReq("GET");
		const { res } = makeRes();
		const handled = handleMemoryStatus(req, res, ctx);
		assert.strictEqual(handled, true, "handler must return true");
	});

	it("non-GET returns 405", () => {
		const ctx = buildRouteContext({
			snapshotPath: join(testDir, "dashboard.json"),
			eventsPath: join(testDir, "events.log"),
			stateDir: testDir,
			SERVER_VERSION: "9.9.9-test",
			serveClientAsset: () => false,
			detectCrossRepoDrift: mockDriftReport,
		});
		const req = makeReq("POST");
		const resObj = makeRes();
		handleMemoryStatus(req, resObj.res, ctx);
		assert.strictEqual(resObj.statusCode, 405, "POST must return 405");
	});

	it("GET response body is valid JSON with required fields", async () => {
		const ctx = buildRouteContext({
			snapshotPath: join(testDir, "dashboard.json"),
			eventsPath: join(testDir, "events.log"),
			stateDir: testDir,
			SERVER_VERSION: "9.9.9-test",
			serveClientAsset: () => false,
			detectCrossRepoDrift: mockDriftReport,
		});
		const req = makeReq("GET");
		let body = "";
		const res = {
			writeHead(_code: number, _headers?: Record<string, string>) {
				/* empty */
			},
			end(chunk?: string) {
				if (chunk) body = chunk;
			},
		} as unknown as ServerResponse;
		handleMemoryStatus(req, res, ctx);
		// Wait for async memoryStats() promise to resolve.
		await new Promise((resolve) => setImmediate(resolve));
		const parsed = JSON.parse(body);
		assert.ok("totalMemories" in parsed, "body must have totalMemories");
		assert.ok("memoriesInLast30Days" in parsed, "body must have memoriesInLast30Days");
		assert.ok("topStableMemories" in parsed, "body must have topStableMemories");
		assert.ok("avgRecallScore" in parsed, "body must have avgRecallScore");
		assert.ok(Array.isArray(parsed.topStableMemories), "topStableMemories must be an array");
		assert.ok(typeof parsed.totalMemories === "number", "totalMemories must be a number");
		assert.ok(typeof parsed.memoriesInLast30Days === "number", "memoriesInLast30Days must be a number");
		assert.ok(typeof parsed.avgRecallScore === "number", "avgRecallScore must be a number");
	});
});