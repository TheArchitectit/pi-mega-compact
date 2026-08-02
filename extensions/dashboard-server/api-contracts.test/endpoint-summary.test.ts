/**
 * endpoint-summary.test.ts — runtime contract validation for GET /api/summary
 * and GET /api/drift. Split out of api-contracts.test.ts; test bodies are
 * unchanged.
 */
import { test, describe } from "node:test";
import { assertField, assertObject } from "./_helpers.js";
describe("GET /api/summary", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			summary: {
				totalRepos: 3,
				totalCheckpoints: 45,
				totalTokensSaved: 150000,
				totalCompressedOriginalBytes: 40960,
			},
			activeRepos: 2,
			totalRepos: 3,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string", "null"]);
		assertField(obj, "summary", ["object", "null"]);
		assertField(obj, "activeRepos", ["number"]);
		assertField(obj, "totalRepos", ["number"]);

		const summary = assertObject(obj, "summary")!;
		assertField(summary, "totalRepos", ["number"]);
		assertField(summary, "totalCheckpoints", ["number"]);
		assertField(summary, "totalTokensSaved", ["number"]);
		assertField(summary, "totalCompressedOriginalBytes", ["number"]);
	});

	test("null summary validates", () => {
		const raw = JSON.stringify({
			updatedAt: null,
			summary: null,
			activeRepos: 0,
			totalRepos: 0,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["null"]);
		assertField(obj, "summary", ["null"]);
		assertField(obj, "activeRepos", ["number"]);
		assertField(obj, "totalRepos", ["number"]);
	});
});

describe("GET /api/drift", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			generatedAt: 1700000000,
			totals: {
				ok: 2,
				warn: 1,
				stale: 1,
				compactionLag: 0,
				modelChurn: 0,
			},
			repos: [
				{
					repoRoot: "/home/user/repo1",
					displayName: "repo1",
					lastSeen: 1700000000,
					lastCompactedAt: 1699990000,
					modelCapturedAt: null,
					signals: [
						{
							kind: "stale",
							severity: "warn",
							detail: "No activity for 48h",
						},
					],
					status: "warn",
				},
			],
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "generatedAt", ["number"]);
		assertField(obj, "totals", ["object"]);
		assertField(obj, "repos", ["array"]);

		const totals = assertObject(obj, "totals")!;
		assertField(totals, "ok", ["number"]);
		assertField(totals, "warn", ["number"]);
		assertField(totals, "stale", ["number"]);
		assertField(totals, "compactionLag", ["number"]);
		assertField(totals, "modelChurn", ["number"]);

		const repos = obj["repos"] as unknown[];
		const first = repos[0] as Record<string, unknown>;
		assertField(first, "repoRoot", ["string"]);
		assertField(first, "displayName", ["string"]);
		assertField(first, "lastSeen", ["number"]);
		assertField(first, "lastCompactedAt", ["number", "null"]);
		assertField(first, "modelCapturedAt", ["number", "null"]);
		assertField(first, "signals", ["array"]);
		assertField(first, "status", ["string"]);

		const signals = first["signals"] as unknown[];
		const sig = signals[0] as Record<string, unknown>;
		assertField(sig, "kind", ["string"]);
		assertField(sig, "severity", ["string"]);
		assertField(sig, "detail", ["string"]);
	});
});
