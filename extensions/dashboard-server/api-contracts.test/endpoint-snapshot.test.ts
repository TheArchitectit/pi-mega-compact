/**
 * endpoint-snapshot.test.ts — runtime contract validation for GET /api/snapshot
 * and GET /api/version. Split out of api-contracts.test.ts; test bodies are
 * unchanged.
 */
import { test, describe } from "node:test";
import { assertField, assertObject } from "./_helpers.js";

describe("GET /api/snapshot", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			tier: "ultra-compact",
			presetTier: "super-compact",
			pressure: 45.2,
			config: {
				fastGatePct: 60,
				thresholdTokens: 100000,
				anchorUserMessages: 3,
				preserveRecent: 10,
				auto: true,
				autoInlineK: 5,
			},
			session: {
				id: "sess-123",
				state: "idle",
				persistedThisSession: true,
				lastCheckpointId: "ckpt-456",
				lastCompactedFrom: 50000,
			},
			context: {
				tokens: 42000,
				percent: 42,
				contextWindow: 200000,
			},
			trigger: {
				armed: true,
				ready: false,
				currentTokens: 42000,
				thresholdTokens: 100000,
				fastGatePct: 60,
			},
			store: {
				checkpointCount: 15,
				totalTokenEstimate: 120000,
				originalTokens: 200000,
				tokensSaved: 80000,
				injectedCount: 30,
				dedupHitRate: 12.5,
				storageDedupRate: 8.3,
				dedupCollapsed: 5,
			},
			crew: { activeAgents: 2, currentTurn: 1 },
			repo: {
				checkpointCount: 15,
				totalTokenEstimate: 120000,
				originalTokens: 200000,
				tokensSaved: 80000,
				sessionCount: 5,
				dedupAttempts: 10,
				dedupCollapsed: 5,
				storageDedupRate: 8.3,
			},
			integrity: {
				regionsRetained: 8,
				compressedOriginalBytes: 4096,
				duplicatesCollapsed: 5,
				bytesPermanentlyDeleted: 1024,
			},
			cacheHits: {
				session: 3,
				total: 20,
				sessionTokensSaved: 1500,
				totalTokensSaved: 10000,
			},
			compacts: { session: 3, total: 20 },
			timeSaved: {
				compact: { sessionSec: 120, totalSec: 600 },
				cacheHit: { sessionSec: 30, totalSec: 200 },
			},
			compression: {
				session: {
					tokensIn: 50000,
					tokensOut: 20000,
					tokensFreed: 30000,
					compressionPct: 60,
					dedupPct: 5,
				},
				repo: {
					tokensIn: 200000,
					tokensOut: 80000,
					tokensFreed: 120000,
					compressionPct: 60,
					dedupPct: 8,
				},
			},
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string", "null"]);
		assertField(obj, "tier", ["string"]);
		assertField(obj, "presetTier", ["string"]);
		assertField(obj, "pressure", ["number"]);
		assertField(obj, "config", ["object"]);
		assertField(obj, "session", ["object"]);
		assertField(obj, "context", ["object"]);
		assertField(obj, "trigger", ["object"]);
		assertField(obj, "store", ["object"]);
		assertField(obj, "crew", ["object"]);
		assertField(obj, "repo", ["object"]);
		assertField(obj, "integrity", ["object"]);
		assertField(obj, "cacheHits", ["object"]);
		assertField(obj, "compacts", ["object"]);
		assertField(obj, "timeSaved", ["object"]);
		assertField(obj, "compression", ["object"]);

		// Spot-check nested fields
		const config = assertObject(obj, "config")!;
		assertField(config, "fastGatePct", ["number"]);
		assertField(config, "auto", ["boolean"]);

		const session = assertObject(obj, "session")!;
		assertField(session, "id", ["string", "null"]);
		assertField(session, "persistedThisSession", ["boolean"]);

		const context = assertObject(obj, "context")!;
		assertField(context, "tokens", ["number", "null"]);
		assertField(context, "contextWindow", ["number"]);
	});
});

describe("GET /api/version", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({ version: "1.2.3" });
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "version", ["string"]);
	});
});
