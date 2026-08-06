/**
 * routes-prefix-stability.test.ts — prefix-stability API route (PC-C).
 *
 * Exercises handlePrefixStability against a real temporary events.log file and a
 * stub ServerResponse, verifying the contract the CacheTab relies on: per-turn
 * stable-prefix ratio trend, avgRatio, and trend classification — plus flag-off
 * 404 (MEGACOMPACT_PC_C=0). Real file reads, no mocks of the data source.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { handlePrefixStability } from "./routes-prefix-stability.js";

interface Capture {
	status: number;
	body: string;
}

function stubRes(): { res: ServerResponse; capture: Capture } {
	const capture = { status: 0, body: "" };
	const res = {
		writeHead(code: number, _headers?: unknown): ServerResponse {
			capture.status = code;
			return res as unknown as ServerResponse;
		},
		end(body?: unknown): ServerResponse {
			capture.body = String(body ?? "");
			return res as unknown as ServerResponse;
		},
	} as unknown as ServerResponse;
	return { res, capture };
}

function makeReq(url: string, method = "GET"): IncomingMessage {
	return { url, method } as unknown as IncomingMessage;
}

function makeCtx(eventsPath: string): RouteContext {
	return {
		snapshotPath: "",
		eventsPath,
		stateDir: "",
		SERVER_VERSION: "",
		serveClientAsset: () => false,
		eventOffsetRef: { value: 0 },
		overlayCurrentRepo: () => {},
		detectCrossRepoDrift: () => [],
	} as unknown as RouteContext;
}

/** Write a synthetic events.log with N prefix_stability rows of a given ratio. */
function writeEvents(dir: string, rows: Array<{ stablePrefix: number; totalMessages: number }>): string {
	const path = join(dir, "events.log");
	const lines = rows.map((r, i) =>
		JSON.stringify({
			ts: 1_700_000_000_000 + i * 1000,
			event: "prefix_stability",
			stablePrefix: r.stablePrefix,
			totalMessages: r.totalMessages,
			separation: "off",
			striping: "v3",
		}),
	);
	writeFileSync(path, lines.join("\n") + "\n");
	return path;
}

describe("handlePrefixStability", () => {
	test("non-matching URL returns false (falls through)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pcs-"));
		try {
			const ctx = makeCtx(join(dir, "events.log"));
			const { res, capture } = stubRes();
			const claimed = handlePrefixStability(makeReq("/api/snapshot"), res, ctx);
			assert.equal(claimed, false);
			assert.equal(capture.status, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("flag-off (MEGACOMPACT_PC_C=0) returns 404", () => {
		const dir = mkdtempSync(join(tmpdir(), "pcs-"));
		try {
			const prev = process.env.MEGACOMPACT_PC_C;
			process.env.MEGACOMPACT_PC_C = "0";
			try {
				const ctx = makeCtx(join(dir, "events.log"));
				const { res, capture } = stubRes();
				const claimed = handlePrefixStability(makeReq("/api/prefix-stability"), res, ctx);
				assert.equal(claimed, true);
				assert.equal(capture.status, 404);
			} finally {
				if (prev === undefined) delete process.env.MEGACOMPACT_PC_C;
				else process.env.MEGACOMPACT_PC_C = prev;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns per-turn ratio trend from events.log", () => {
		const dir = mkdtempSync(join(tmpdir(), "pcs-"));
		try {
			const eventsPath = writeEvents(dir, [
				{ stablePrefix: 5, totalMessages: 10 }, // 0.5
				{ stablePrefix: 6, totalMessages: 10 }, // 0.6
				{ stablePrefix: 7, totalMessages: 10 }, // 0.7
				{ stablePrefix: 9, totalMessages: 10 }, // 0.9
			]);
			const ctx = makeCtx(eventsPath);
			const { res, capture } = stubRes();
			const claimed = handlePrefixStability(makeReq("/api/prefix-stability?limit=50"), res, ctx);
			assert.equal(claimed, true);
			assert.equal(capture.status, 200);
			const body = JSON.parse(capture.body) as {
				turns: Array<{ ratio: number; turnIndex: number; stablePrefix: number }>;
				avgRatio: number;
				trend: string;
				count: number;
			};
			assert.equal(body.count, 4);
			assert.deepEqual(body.turns.map((t) => t.ratio), [0.5, 0.6, 0.7, 0.9]);
			assert.equal(body.turns[0].turnIndex, 0);
			assert.equal(body.avgRatio, 0.675);
			// Tail (0.9, avg 0.9) - head (0.5.., avg 0.5) = +0.4 > 0.05 → improving.
			assert.equal(body.trend, "improving");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ignores non-prefix_stability rows and clamps limit", () => {
		const dir = mkdtempSync(join(tmpdir(), "pcs-"));
		try {
			const eventsPath = join(dir, "events.log");
			const rows = [
				JSON.stringify({ ts: 1, event: "other_event", foo: 1 }),
				JSON.stringify({ ts: 2, event: "prefix_stability", stablePrefix: 4, totalMessages: 8, striping: "v3" }),
				JSON.stringify({ ts: 3, event: "prefix_stability", stablePrefix: 5, totalMessages: 8, striping: "v3" }),
				JSON.stringify({ ts: 4, event: "prefix_stability", stablePrefix: 6, totalMessages: 8, striping: "v3" }),
			];
			writeFileSync(eventsPath, rows.join("\n") + "\n");
			const ctx = makeCtx(eventsPath);
			const { res, capture } = stubRes();
			handlePrefixStability(makeReq("/api/prefix-stability?limit=2"), res, ctx);
			const body = JSON.parse(capture.body) as { count: number; turns: unknown[] };
			assert.equal(body.count, 2); // limit clamp, non-matching row excluded
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
