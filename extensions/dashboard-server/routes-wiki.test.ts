/**
 * dashboard-server/routes-wiki.test.ts — W2 wiki routes handler tests (W2.4).
 *
 * Real sqlite (no mocks): seeds topics via createTopicStore.replaceTopicModel,
 * then exercises the index / rename / merge endpoints through handleWiki with
 * EventEmitter-based req stubs.
 */

import { EventEmitter } from "node:events";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRouteContext } from "./routes-core.js";
import { handleWiki } from "./routes-wiki.js";
import { TurnsConfig } from "../../src/config/turns.js";
import { createTopicStore } from "../../src/topics/store.js";
import { openTurnStore, closeTurnStore } from "../../src/store/turns/index.js";
import type { ClusterModel } from "../../src/topics/types.js";
import type { WikiIndexResponse, CurationResult } from "./api-contracts/wiki.js";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "mega-wiki-route-test-"));
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

function makeReq(method: string, url = "/api/wiki/index"): IncomingMessage {
	return { method, url, headers: {} } as unknown as IncomingMessage;
}

/** A req that streams a JSON body for readJsonBody. */
function makeJsonReq(method: string, url: string, body: unknown): IncomingMessage {
	const e = new EventEmitter() as unknown as IncomingMessage;
	(e as unknown as { method: string }).method = method;
	(e as unknown as { url: string }).url = url;
	(e as unknown as { headers: Record<string, string> }).headers = {
		"content-type": "application/json",
	};
	process.nextTick(() => {
		e.emit("data", Buffer.from(JSON.stringify(body)));
		e.emit("end");
	});
	return e;
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

function seedModel(): void {
	const model: ClusterModel = {
		topics: [
			{
				id: "topic_0",
				label: "alpha",
				termScores: [{ term: "a", score: 1 }],
				memoryCount: 2,
				lastUpdated: 1000,
			},
			{
				id: "topic_1",
				label: "beta",
				termScores: [{ term: "b", score: 1 }],
				memoryCount: 2,
				lastUpdated: 1000,
			},
		],
		assignments: [
			{
				memoryId: "mem_a0",
				sessionId: "sess1",
				topicId: "topic_0",
				confidence: 0.9,
				assignedAt: 1000,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_a1",
				sessionId: "sess1",
				topicId: "topic_0",
				confidence: 0.8,
				assignedAt: 1000,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_b0",
				sessionId: "sess2",
				topicId: "topic_1",
				confidence: 0.7,
				assignedAt: 1000,
				method: "kmeans+tfidf",
			},
			{
				memoryId: "mem_b1",
				sessionId: "sess2",
				topicId: "topic_1",
				confidence: 0.6,
				assignedAt: 1000,
				method: "kmeans+tfidf",
			},
		],
		k: 2,
		criterion: "silhouette",
		silhouetteScore: 0.5,
		totalChunks: 4,
		builtAt: 1000,
	};
	createTopicStore(testDir).replaceTopicModel(model);
}

describe("handleWiki", () => {
	it("GET /api/wiki/index returns topics (flag ON)", () => {
		seedModel();
		const r = makeRes();
		const handled = handleWiki(makeReq("GET", "/api/wiki/index"), r.res, ctx());
		assert.equal(handled, true);
		assert.equal(r.statusCode, 200);
		const body = JSON.parse(r.body) as WikiIndexResponse;
		assert.equal(body.totalTopics, 2);
		assert.equal(body.topics[0].label, "alpha");
		assert.equal(body.topics[0].edited, false);
		assert.deepEqual(body.topics[0].overrideKinds, []);
	});

	it("rename round-trips and flips edited on the index", async () => {
		seedModel();
		const c = ctx();
		// Rename topic_0.
		const rr = makeRes();
		const handled = handleWiki(
			makeJsonReq("PUT", "/api/wiki/topic/topic_0/label", { label: "Renamed" }),
			rr.res,
			c,
		);
		assert.equal(handled, true);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(rr.statusCode, 200);
		const res = JSON.parse(rr.body) as CurationResult;
		assert.equal(res.ok, true);
		assert.equal(res.edited, true);
		// Index now reflects the rename.
		const idx = makeRes();
		handleWiki(makeReq("GET", "/api/wiki/index"), idx.res, c);
		const body = JSON.parse(idx.body) as WikiIndexResponse;
		const target = body.topics.find((t) => t.id === "topic_0");
		assert.equal(target?.label, "Renamed");
		assert.equal(target?.edited, true);
		// SSE event appended.
		const events = await import("node:fs");
		const tail = events.readFileSync(c.eventsPath, "utf-8");
		assert.match(tail, /wiki_topic_renamed/);
	});

	it("mergeTopics reassigns and source is hidden from the index", async () => {
		seedModel();
		const c = ctx();
		const mr = makeRes();
		handleWiki(
			makeJsonReq("POST", "/api/wiki/merge", {
				sourceTopicId: "topic_0",
				targetTopicId: "topic_1",
			}),
			mr.res,
			c,
		);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(mr.statusCode, 200);
		// Source hidden from index.
		const idx = makeRes();
		handleWiki(makeReq("GET", "/api/wiki/index"), idx.res, c);
		const body = JSON.parse(idx.body) as WikiIndexResponse;
		assert.equal(body.totalTopics, 1);
		assert.equal(body.topics[0].id, "topic_1");
		assert.equal(body.topics[0].memoryCount, 4);
		// Persisted members all under target.
		const db = openTurnStore(testDir);
		const count = db
			.prepare("SELECT COUNT(*) AS c FROM memory_topics WHERE topic_id = 'topic_1'")
			.get() as { c: number };
		assert.equal(count.c, 4);
		const events = await import("node:fs");
		assert.match(events.readFileSync(c.eventsPath, "utf-8"), /wiki_topics_merged/);
	});

	it("merge source==target returns 400", async () => {
		seedModel();
		const mr = makeRes();
		handleWiki(
			makeJsonReq("POST", "/api/wiki/merge", {
				sourceTopicId: "topic_0",
				targetTopicId: "topic_0",
			}),
			mr.res,
			ctx(),
		);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(mr.statusCode, 400);
		// Nothing changed.
		const db = openTurnStore(testDir);
		const topics = db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number };
		assert.equal(topics.c, 2);
	});

	it("flag OFF returns 404 for all /api/wiki/* — restored after test", () => {
		const c = ctx();
		const original = TurnsConfig.WIKI_ENHANCED_ENABLED;
		TurnsConfig.WIKI_ENHANCED_ENABLED = false;
		try {
			const r = makeRes();
			const handled = handleWiki(makeReq("GET", "/api/wiki/index"), r.res, c);
			assert.equal(handled, true, "flag-off still claims the route");
			assert.equal(r.statusCode, 404);
		} finally {
			TurnsConfig.WIKI_ENHANCED_ENABLED = original;
		}
	});
});
