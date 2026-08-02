/**
 * score-preserve.test.ts — S40A-6/7: score, preservationCutoff, itemsToPreserve.
 * Split from src/importance.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ContextItemType,
	score,
	preservationCutoff,
	itemsToPreserve,
	scoreEngineMessages,
} from "../importance.js";
import type { EngineMessage } from "../types.js";
import { NOW } from "./_helpers.js";

test("score: fresh decision gets full multiplier (no decay, no recency/retention boost expected unless young)", () => {
	const result = score(
		{ id: "0", content: "we decided to use JWT", role: "assistant", timestamp: NOW },
		NOW,
	);
	assert.equal(result.type, ContextItemType.Decision);
	assert.equal(result.rawMultiplier, 2.5);
	assert.equal(result.ageDecay, 0);
	assert.equal(result.recencyBoost, 1.2);
	assert.equal(result.retentionBoost, 1.0);
	assert.equal(result.finalScore, 3.0);
});

test("score: old decision decays", () => {
	const tenHoursAgo = NOW - 10 * 3_600_000;
	const result = score(
		{ id: "1", content: "we decided to use JWT", role: "assistant", timestamp: tenHoursAgo },
		NOW,
	);
	assert.equal(result.ageDecay, 0.5);
	assert.equal(result.recencyBoost, 1.0);
	assert.equal(result.finalScore, 1.25);
});

test("score: userFlagged triples the result via retentionBoost", () => {
	const flagged = score(
		{ id: "2", content: "we decided to use JWT", role: "assistant", timestamp: NOW, userFlagged: true },
		NOW,
	);
	const unflagged = score(
		{ id: "3", content: "we decided to use JWT", role: "assistant", timestamp: NOW, userFlagged: false },
		NOW,
	);
	assert.equal(flagged.finalScore / unflagged.finalScore, 3.0);
});

test("score: clamps finalScore to minimum 0.01", () => {
	const result = score(
		{ id: "4", content: "system filler", role: "custom", timestamp: NOW - 100 * 3_600_000 },
		NOW,
		{ [ContextItemType.SystemMessage]: 0.01 },
		{ maxDecay: 0.99 },
	);
	assert.equal(result.finalScore, 0.01);
});

test("score: custom multipliers override DEFAULT_MULTIPLIERS", () => {
	const result = score(
		{ id: "5", content: "we decided to use JWT", role: "assistant", timestamp: NOW },
		NOW,
		{ [ContextItemType.Decision]: 10.0 },
	);
	assert.equal(result.rawMultiplier, 10.0);
	assert.equal(result.finalScore, 10.0 * 1.2);
});

test("score: unknown role narrows to assistant defensively", () => {
	const result = score(
		{ id: "6", content: "plain text", role: "weird-role" as any, timestamp: NOW },
		NOW,
	);
	assert.equal(result.role, "assistant");
	assert.equal(result.type, ContextItemType.AssistantMessage);
});

test("score: undefined/null content does not crash", () => {
	const r1 = score(
		{ id: "a", content: undefined as any, role: "user", timestamp: NOW },
		NOW,
	);
	const r2 = score(
		{ id: "b", content: null as any, role: "assistant", timestamp: NOW },
		NOW,
	);
	assert.equal(r1.type, ContextItemType.UserMessage);
	assert.equal(r2.type, ContextItemType.AssistantMessage);
	assert.equal(r1.content, "");
	assert.equal(r2.content, "");
});

test("score: determinism — same inputs → same output", () => {
	const item = { id: "d1", content: "we decided to use JWT", role: "assistant", timestamp: NOW - 3_600_000 };
	const a = score(item, NOW);
	const b = score(item, NOW);
	assert.deepEqual(a, b);
});

test("preservationCutoff: 10 items at ratio 0.3 → threshold is the 3rd-highest score", () => {
	const items = Array.from({ length: 10 }, (_, i) => ({
		id: String(i),
		type: ContextItemType.AssistantMessage,
		content: "",
		role: "assistant",
		timestamp: 0,
		rawMultiplier: 1.0,
		ageDecay: 0,
		recencyBoost: 1.0,
		retentionBoost: 1.0,
		finalScore: (i + 1) * 1.0,
	}));
	const threshold = preservationCutoff(items, 0.3);
	assert.equal(threshold, 8.0);
});

test("preservationCutoff: ratio=1.0 returns 0 (preserve all)", () => {
	const items = [{ finalScore: 5, id: "x" } as any];
	assert.equal(preservationCutoff(items, 1.0), 0);
});

test("preservationCutoff: ratio=0 returns Infinity (preserve none)", () => {
	const items = [{ finalScore: 5, id: "x" } as any];
	assert.equal(preservationCutoff(items, 0), Infinity);
});

test("preservationCutoff: empty input returns Infinity", () => {
	assert.equal(preservationCutoff([], 0.5), Infinity);
});

test("itemsToPreserve: returns IDs at or above threshold", () => {
	const items = Array.from({ length: 10 }, (_, i) => ({
		id: String(i),
		type: ContextItemType.AssistantMessage,
		content: "",
		role: "assistant",
		timestamp: 0,
		rawMultiplier: 1.0,
		ageDecay: 0,
		recencyBoost: 1.0,
		retentionBoost: 1.0,
		finalScore: (i + 1) * 1.0,
	}));
	const result = itemsToPreserve(items, 0.3);
	assert.equal(result.totalScored, 10);
	assert.equal(result.totalPreserved, 3);
	assert.deepEqual([...result.preservedIds].sort(), ["7", "8", "9"]);
});

test("itemsToPreserve: ratio=1.0 preserves everything", () => {
	const items = Array.from({ length: 5 }, (_, i) => ({
		id: String(i),
		type: ContextItemType.AssistantMessage,
		content: "",
		role: "assistant",
		timestamp: 0,
		rawMultiplier: 1.0,
		ageDecay: 0,
		recencyBoost: 1.0,
		retentionBoost: 1.0,
		finalScore: i + 1,
	}));
	const result = itemsToPreserve(items, 1.0);
	assert.equal(result.totalPreserved, 5);
});

test("itemsToPreserve: ratio=0 preserves nothing", () => {
	const items = Array.from({ length: 5 }, (_, i) => ({
		id: String(i),
		type: ContextItemType.AssistantMessage,
		content: "",
		role: "assistant",
		timestamp: 0,
		rawMultiplier: 1.0,
		ageDecay: 0,
		recencyBoost: 1.0,
		retentionBoost: 1.0,
		finalScore: i + 1,
	}));
	const result = itemsToPreserve(items, 0);
	assert.equal(result.totalPreserved, 0);
	assert.equal(result.threshold, Infinity);
});

test("itemsToPreserve: empty items returns empty set", () => {
	const result = itemsToPreserve([], 0.5);
	assert.equal(result.totalScored, 0);
	assert.equal(result.totalPreserved, 0);
	assert.equal(result.preservedIds.size, 0);
});

test("scoreEngineMessages: assigns position-based timestamps (oldest first)", () => {
	const messages: EngineMessage[] = [
		{ role: "assistant", text: "we decided to use JWT" },
		{ role: "user", text: "ok" },
		{ role: "assistant", text: "edited src/config.ts" },
	];
	const scored = scoreEngineMessages(messages, NOW);
	assert.equal(scored.length, 3);
	assert.equal(scored[0].timestamp, NOW - 3 * 60_000);
	assert.equal(scored[2].timestamp, NOW - 1 * 60_000);
	assert.equal(scored[0].recencyBoost, 1.2);
	assert.equal(scored[2].recencyBoost, 1.2);
});

test("scoreEngineMessages: preserves input order and ids are stringified indices", () => {
	const messages: EngineMessage[] = [
		{ role: "user", text: "first" },
		{ role: "user", text: "second" },
	];
	const scored = scoreEngineMessages(messages, NOW);
	assert.equal(scored[0].id, "0");
	assert.equal(scored[1].id, "1");
});

test("scoreEngineMessages: empty input returns empty array", () => {
	assert.deepEqual(scoreEngineMessages([], NOW), []);
});

test("scoreEngineMessages: determinism — same input → same output", () => {
	const messages: EngineMessage[] = [
		{ role: "assistant", text: "we decided to use JWT" },
		{ role: "user", text: "ok" },
	];
	const a = scoreEngineMessages(messages, NOW);
	const b = scoreEngineMessages(messages, NOW);
	assert.deepEqual(a, b);
});

test("integration: a decision is preserved over filler at the same age", () => {
	const messages: EngineMessage[] = Array.from({ length: 10 }, (_, i) =>
		i === 4
			? { role: "assistant", text: "we decided to use JWT auth" }
			: { role: "assistant", text: "ok, sounds good" },
	);
	const scored = scoreEngineMessages(messages, NOW - 10 * 60_000);
	const decision = scored[4];
	const filler = scored[0];
	assert.ok(decision.finalScore > filler.finalScore);
	const result = itemsToPreserve(scored, 0.2);
	assert.ok(result.preservedIds.has("4"), "decision must be preserved");
});
