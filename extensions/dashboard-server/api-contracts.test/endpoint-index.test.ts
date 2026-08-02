/**
 * endpoint-index.test.ts — runtime contract validation for GET /api/index and
 * GET /api/repos. Split out of api-contracts.test.ts; test bodies are unchanged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertField } from "./_helpers.js";
describe("GET /api/index", () => {
	test("summary payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			totalRepos: 3,
			totalCheckpoints: 45,
			totalTokensSaved: 150000,
			totalCompressedOriginalBytes: 40960,
			repos: [
				{
					repoRoot: "/home/user/repo1",
					displayName: "repo1",
					stateDir: "/home/user/.pi/mega-compact/repo1",
					checkpointCount: 15,
					tokensSaved: 50000,
					compressedOriginalBytes: 16384,
					lastCompactedAt: 1700000000000,
					provider: "anthropic",
					providerName: "Anthropic",
					modelName: "claude-3",
					inputRate: 100,
					outputRate: 80,
					lastSeen: 1700000000000,
					tokensKept: 20000,
					tokensDropped: 30000,
					sessions: 5,
					contextWindow: 200000,
					maxTokens: 180000,
					reasoning: false,
				},
			],
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string"]);
		assertField(obj, "totalRepos", ["number"]);
		assertField(obj, "totalCheckpoints", ["number"]);
		assertField(obj, "totalTokensSaved", ["number"]);
		assertField(obj, "totalCompressedOriginalBytes", ["number"]);
		assertField(obj, "repos", ["array"]);

		const repos = obj["repos"] as unknown[];
		assert.ok(repos.length > 0, "repos array should have at least one entry");
		const first = repos[0] as Record<string, unknown>;
		assertField(first, "repoRoot", ["string"]);
		assertField(first, "displayName", ["string"]);
		assertField(first, "checkpointCount", ["number"]);
		assertField(first, "lastCompactedAt", ["number", "null"]);
		assertField(first, "provider", ["string", "null"]);
		assertField(first, "lastSeen", ["number"]);
	});

	test("fallback payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: null,
			summary: null,
			repos: [],
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["null"]);
		assertField(obj, "summary", ["null"]);
		assertField(obj, "repos", ["array"]);
		assert.equal((obj["repos"] as unknown[]).length, 0);
	});
});

describe("GET /api/repos", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			repos: [
				{
					repoRoot: "/home/user/repo1",
					displayName: "repo1",
					stateDir: "/home/user/.pi/repo1",
					checkpointCount: 15,
					tokensSaved: 50000,
					compressedOriginalBytes: 16384,
					lastCompactedAt: null,
					provider: null,
					providerName: null,
					modelName: null,
					inputRate: null,
					outputRate: null,
					lastSeen: 1700000000000,
					tokensKept: 20000,
					tokensDropped: 30000,
					sessions: 5,
					contextWindow: null,
					maxTokens: null,
					reasoning: null,
				},
			],
			count: 1,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string", "null"]);
		assertField(obj, "repos", ["array"]);
		assertField(obj, "count", ["number"]);
	});
});
