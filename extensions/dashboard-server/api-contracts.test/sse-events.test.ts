/**
 * sse-events.test.ts — SseEvent union discriminator validation, plus the SSE
 * ENDPOINTS entry configuration check. Split out of api-contracts.test.ts;
 * test bodies are unchanged.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS } from "../api-contracts/index.js";
import { assertField } from "./_helpers.js";
describe("SSE /api/events — SseEvent union discriminator validation", () => {
	/** All 21 SseEvent variants with their discriminator `type` value and a minimal payload. */
	const SSE_VARIANTS: ReadonlyArray<{
		discriminator: string;
		payload: string;
	}> = [
		{
			discriminator: "compact_start",
			payload: JSON.stringify({
				type: "compact_start",
				ts: "2025-01-01T00:00:00Z",
				trigger: "auto",
				sessionId: "s1",
			}),
		},
		{
			discriminator: "compact_end",
			payload: JSON.stringify({
				type: "compact_end",
				ts: "2025-01-01T00:00:00Z",
				sessionId: "s1",
				checkpointId: "c1",
				tokensIn: 10000,
				tokensOut: 4000,
				tokensFreed: 6000,
				success: true,
			}),
		},
		{
			discriminator: "compact_trigger",
			payload: JSON.stringify({
				type: "compact_trigger",
				ts: "2025-01-01T00:00:00Z",
				pressure: 75,
				threshold: 80,
				armed: true,
			}),
		},
		{
			discriminator: "compact_skip",
			payload: JSON.stringify({
				type: "compact_skip",
				ts: "2025-01-01T00:00:00Z",
				reason: "pressure insufficient",
			}),
		},
		{
			discriminator: "tier_changed",
			payload: JSON.stringify({
				type: "tier_changed",
				ts: "2025-01-01T00:00:00Z",
				from: "super-compact",
				to: "ultra-compact",
				contextPct: 82,
			}),
		},
		{
			discriminator: "model_changed",
			payload: JSON.stringify({
				type: "model_changed",
				ts: "2025-01-01T00:00:00Z",
				provider: "anthropic",
				providerName: "Anthropic",
				model: "claude-3.5-sonnet",
			}),
		},
		{
			discriminator: "pressure_lifted",
			payload: JSON.stringify({
				type: "pressure_lifted",
				ts: "2025-01-01T00:00:00Z",
				beforePct: 85,
				afterPct: 40,
			}),
		},
		{
			discriminator: "checkpoint_persisted",
			payload: JSON.stringify({
				type: "checkpoint_persisted",
				ts: "2025-01-01T00:00:00Z",
				checkpointId: "ckpt-1",
				sessionTokens: 8000,
			}),
		},
		{
			discriminator: "recall_inject",
			payload: JSON.stringify({
				type: "recall_inject",
				ts: "2025-01-01T00:00:00Z",
				query: "compaction history",
				chunks: 5,
				tokens: 2000,
			}),
		},
		{
			discriminator: "anchors_updated",
			payload: JSON.stringify({
				type: "anchors_updated",
				ts: "2025-01-01T00:00:00Z",
				count: 10,
				pinned: 3,
			}),
		},
		{
			discriminator: "config_updated",
			payload: JSON.stringify({
				type: "config_updated",
				ts: "2025-01-01T00:00:00Z",
				key: "thresholdTokens",
				value: 120000,
			}),
		},
		{
			discriminator: "config_preset",
			payload: JSON.stringify({
				type: "config_preset",
				ts: "2025-01-01T00:00:00Z",
				preset: "aggressive",
			}),
		},
		{
			discriminator: "crew_presence_changed",
			payload: JSON.stringify({
				type: "crew_presence_changed",
				ts: "2025-01-01T00:00:00Z",
				activeAgents: 3,
				currentTurn: 1,
			}),
		},
		{
			discriminator: "crew_turn_changed",
			payload: JSON.stringify({
				type: "crew_turn_changed",
				ts: "2025-01-01T00:00:00Z",
				turnIndex: 2,
				agentName: "worker-2",
			}),
		},
		{
			discriminator: "crew_bandit_chosen",
			payload: JSON.stringify({
				type: "crew_bandit_chosen",
				ts: "2025-01-01T00:00:00Z",
				chosenAgent: "worker-1",
				score: 0.85,
				regret: 0.12,
			}),
		},
		{
			discriminator: "game_ritual_start",
			payload: JSON.stringify({
				type: "game_ritual_start",
				ts: "2025-01-01T00:00:00Z",
				sessionId: "ritual-1",
				stages: [
					{ index: 0, name: "warmup", durationMs: 60000, status: "pending" },
				],
			}),
		},
		{
			discriminator: "game_ritual_stage",
			payload: JSON.stringify({
				type: "game_ritual_stage",
				ts: "2025-01-01T00:00:00Z",
				sessionId: "ritual-1",
				stageIndex: 1,
				stageName: "deep-work",
			}),
		},
		{
			discriminator: "game_ritual_end",
			payload: JSON.stringify({
				type: "game_ritual_end",
				ts: "2025-01-01T00:00:00Z",
				sessionId: "ritual-1",
				success: true,
			}),
		},
		{
			discriminator: "game_mode_changed",
			payload: JSON.stringify({
				type: "game_mode_changed",
				ts: "2025-01-01T00:00:00Z",
				config: { enabled: true, theme: "neon", displayMode: "full" },
			}),
		},
		{
			discriminator: "game_render",
			payload: JSON.stringify({
				type: "game_render",
				ts: "2025-01-01T00:00:00Z",
				frame: "\x1b[2J\x1b[H",
			}),
		},
		{
			discriminator: "session_sample",
			payload: JSON.stringify({
				type: "session_sample",
				ts: "2025-01-01T00:00:00Z",
				sessionId: "sess-abc",
				tokens: 42_000,
				percent: 35.5,
			}),
		},
	];

	test("all 21 SseEvent variants have a type field matching their discriminator", () => {
		assert.equal(
			SSE_VARIANTS.length,
			21,
			"SseEvent union should have 21 variants",
		);

		for (const variant of SSE_VARIANTS) {
			const obj: Record<string, unknown> = JSON.parse(variant.payload);
			assert.ok(
				"type" in obj,
				`SSE variant "${variant.discriminator}" must have a "type" field`,
			);
			assert.equal(
				typeof obj["type"],
				"string",
				`SSE variant "${variant.discriminator}" type field must be a string`,
			);
			assert.equal(
				obj["type"],
				variant.discriminator,
				`SSE variant type field must match discriminator "${variant.discriminator}"`,
			);
		}
	});

	test("every SSE variant has a ts field of type string", () => {
		for (const variant of SSE_VARIANTS) {
			const obj: Record<string, unknown> = JSON.parse(variant.payload);
			assertField(obj, "ts", ["string"]);
		}
	});

	test("SSE ENDPOINTS entry is correctly configured as SSE type", () => {
		assert.equal(ENDPOINTS.events.type, "sse");
		assert.equal(ENDPOINTS.events.method, "GET");
		assert.equal(ENDPOINTS.events.path, "/api/events");
		assert.ok(ENDPOINTS.events.event, "SSE endpoint must have an event name");
	});

	test("SSE discriminators are unique across all variants", () => {
		const discriminators = SSE_VARIANTS.map((v) => v.discriminator);
		const unique = new Set(discriminators);
		assert.equal(
			unique.size,
			discriminators.length,
			"SSE discriminators must be unique",
		);
	});
});
