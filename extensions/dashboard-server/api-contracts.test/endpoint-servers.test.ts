/**
 * endpoint-servers.test.ts — runtime contract validation for GET /api/servers,
 * GET /api/game-state and PUT /api/game-state. Split out of api-contracts.test.ts;
 * test bodies are unchanged.
 */
import { test, describe } from "node:test";
import { assertField, assertObject } from "./_helpers.js";
describe("GET /api/servers", () => {
	test("sample payload validates field presence and types", () => {
		const raw = JSON.stringify({
			updatedAt: "2025-01-01T00:00:00Z",
			servers: [
				{
					repoRoot: "/home/user/repo1",
					displayName: "repo1",
					model: "claude-3",
					provider: "anthropic",
					lastSeen: 1700000000,
					lastCompactedAt: 1699990000,
					tier: "ultra-compact",
					contextPct: 42,
					state: "idle",
				},
			],
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "updatedAt", ["string"]);
		assertField(obj, "servers", ["array"]);

		const servers = obj["servers"] as unknown[];
		const first = servers[0] as Record<string, unknown>;
		assertField(first, "repoRoot", ["string"]);
		assertField(first, "displayName", ["string"]);
		assertField(first, "model", ["string", "null"]);
		assertField(first, "provider", ["string", "null"]);
		assertField(first, "lastSeen", ["number"]);
		assertField(first, "lastCompactedAt", ["number", "null"]);
	});
});

describe("GET /api/game-state", () => {
	test("sample payload with active ritual validates", () => {
		const raw = JSON.stringify({
			config: {
				enabled: true,
				theme: "ocean",
				displayMode: "full",
			},
			activeRitual: {
				sessionId: "ritual-1",
				stageIndex: 2,
				startedAt: "2025-01-01T00:00:00Z",
				elapsed: 300000,
			},
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "config", ["object"]);
		assertField(obj, "activeRitual", ["object", "null"]);

		const config = assertObject(obj, "config")!;
		assertField(config, "enabled", ["boolean"]);
		assertField(config, "theme", ["string"]);
		assertField(config, "displayMode", ["string"]);

		const ritual = assertObject(obj, "activeRitual")!;
		assertField(ritual, "sessionId", ["string"]);
		assertField(ritual, "stageIndex", ["number"]);
		assertField(ritual, "startedAt", ["string"]);
		assertField(ritual, "elapsed", ["number"]);
	});

	test("sample payload with null ritual validates", () => {
		const raw = JSON.stringify({
			config: {
				enabled: false,
				theme: "mono",
				displayMode: "minimal",
			},
			activeRitual: null,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "config", ["object"]);
		assertField(obj, "activeRitual", ["null"]);
	});
});

describe("PUT /api/game-state", () => {
	test("response payload validates field presence and types", () => {
		// PUT /api/game-state returns GameStateResponse (same as GET)
		const raw = JSON.stringify({
			config: {
				enabled: true,
				theme: "ember",
				displayMode: "full",
			},
			activeRitual: null,
		});
		const obj: Record<string, unknown> = JSON.parse(raw);

		assertField(obj, "config", ["object"]);
		assertField(obj, "activeRitual", ["object", "null"]);

		const config = assertObject(obj, "config")!;
		assertField(config, "enabled", ["boolean"]);
		assertField(config, "theme", ["string"]);
		assertField(config, "displayMode", ["string"]);
	});
});
