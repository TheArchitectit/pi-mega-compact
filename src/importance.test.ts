/**
 * importance.test.ts — S40A unit tests for the importance scoring engine.
 *
 * Covers all exports: ContextItemType, DEFAULT_MULTIPLIERS, detectItemType,
 * ageDecay, recencyBoost, retentionBoost, score, preservationCutoff,
 * itemsToPreserve, scoreEngineMessages.
 *
 * Determinism is enforced — same inputs MUST produce same outputs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineMessage } from "./types.js";
import {
	ContextItemType,
	DEFAULT_MULTIPLIERS,
	detectItemType,
	ageDecay,
	recencyBoost,
	retentionBoost,
	score,
	preservationCutoff,
	itemsToPreserve,
	scoreEngineMessages,
} from "./importance.js";

const NOW = 1_700_000_000_000; // fixed epoch ms for determinism

// ---- S40A-1: types and enums ----

test("ContextItemType enum has 8 variants with snake_case values", () => {
	assert.equal(ContextItemType.UserMessage, "user_message");
	assert.equal(ContextItemType.AssistantMessage, "assistant_message");
	assert.equal(ContextItemType.SystemMessage, "system_message");
	assert.equal(ContextItemType.CodeBlock, "code_block");
	assert.equal(ContextItemType.Error, "error");
	assert.equal(ContextItemType.Decision, "decision");
	assert.equal(ContextItemType.FileModification, "file_modification");
	assert.equal(ContextItemType.ToolExecution, "tool_execution");
});

// ---- S40A-2: DEFAULT_MULTIPLIERS ----

test("DEFAULT_MULTIPLIERS matches the Rust reference values", () => {
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.UserMessage], 1.5);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.AssistantMessage], 1.0);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.SystemMessage], 0.5);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.CodeBlock], 1.2);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.Error], 2.0);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.Decision], 2.5);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.FileModification], 1.8);
	assert.equal(DEFAULT_MULTIPLIERS[ContextItemType.ToolExecution], 1.3);
});

test("DEFAULT_MULTIPLIERS has an entry for every ContextItemType variant", () => {
	for (const t of Object.values(ContextItemType)) {
		assert.equal(
			typeof DEFAULT_MULTIPLIERS[t],
			"number",
			`missing multiplier for ${t}`,
		);
	}
});

// ---- S40A-3: ageDecay ----

test("ageDecay: fresh (age=0) returns 0", () => {
	assert.equal(ageDecay(0), 0);
});

test("ageDecay: 1 hour at 5%/hr returns 0.05", () => {
	assert.equal(ageDecay(3_600_000), 0.05);
});

test("ageDecay: 14 hours caps at 0.7 (maxDecay)", () => {
	assert.equal(ageDecay(14 * 3_600_000), 0.7);
});

test("ageDecay: beyond 14 hours stays capped at 0.7", () => {
	assert.equal(ageDecay(100 * 3_600_000), 0.7);
});

test("ageDecay: negative age (future timestamp) returns 0", () => {
	assert.equal(ageDecay(-5_000), 0);
});

test("ageDecay: custom rate and max override defaults", () => {
	// 10h at 0.1/hr = 1.0 → capped at 0.8.
	assert.equal(ageDecay(10 * 3_600_000, 0.1, 0.8), 0.8);
	// 2h at 0.1/hr = 0.2.
	assert.equal(ageDecay(2 * 3_600_000, 0.1, 0.8), 0.2);
});

// ---- S40A-4: recencyBoost + retentionBoost ----

test("recencyBoost: <5min returns 1.2", () => {
	assert.equal(recencyBoost(299_000), 1.2);
});

test("recencyBoost: >5min returns 1.0", () => {
	assert.equal(recencyBoost(301_000), 1.0);
});

test("recencyBoost: exactly 5min (300_000ms) returns 1.0 (boundary)", () => {
	assert.equal(recencyBoost(300_000), 1.0);
});

test("recencyBoost: custom threshold respected", () => {
	assert.equal(recencyBoost(5000, 10_000), 1.2);
	assert.equal(recencyBoost(11_000, 10_000), 1.0);
});

test("retentionBoost: flagged returns 3.0", () => {
	assert.equal(retentionBoost(true), 3.0);
});

test("retentionBoost: unflagged returns 1.0", () => {
	assert.equal(retentionBoost(false), 1.0);
});

// ---- S40A-5: detectItemType ----

test("detectItemType: role=tool → ToolExecution (priority 1)", () => {
	// Even if content looks like an error, tool role wins.
	assert.equal(
		detectItemType("error: something failed", "tool"),
		ContextItemType.ToolExecution,
	);
});

test("detectItemType: role=custom → SystemMessage (priority 2)", () => {
	assert.equal(
		detectItemType("anything here", "custom"),
		ContextItemType.SystemMessage,
	);
});

test("detectItemType: error content → Error", () => {
	assert.equal(
		detectItemType("Error: ENOENT at src/config.ts:42", "assistant"),
		ContextItemType.Error,
	);
	assert.equal(
		detectItemType("Traceback (most recent call last)", "assistant"),
		ContextItemType.Error,
	);
	assert.equal(
		detectItemType("panic: runtime error", "assistant"),
		ContextItemType.Error,
	);
	assert.equal(
		detectItemType("E4030 connection refused", "assistant"),
		ContextItemType.Error,
	);
});

test("detectItemType: decision content → Decision", () => {
	assert.equal(
		detectItemType("we decided to use JWT auth", "assistant"),
		ContextItemType.Decision,
	);
	assert.equal(
		detectItemType("going with option B", "assistant"),
		ContextItemType.Decision,
	);
	assert.equal(
		detectItemType("let's go with the async approach", "assistant"),
		ContextItemType.Decision,
	);
	assert.equal(
		detectItemType("switching to a different database", "assistant"),
		ContextItemType.Decision,
	);
});

test("detectItemType: fenced code block ≥20 chars → CodeBlock", () => {
	const code = "```js\nconst x = 42;\nconst y = 'hello world';\n```";
	assert.equal(
		detectItemType(code, "assistant"),
		ContextItemType.CodeBlock,
	);
});

test("detectItemType: short fenced block (<20 chars) does NOT → CodeBlock", () => {
	const short = "```\nshort\n```";
	assert.notEqual(
		detectItemType(short, "assistant"),
		ContextItemType.CodeBlock,
	);
});

test("detectItemType: file modification verbs → FileModification", () => {
	assert.equal(
		detectItemType("edited src/config.ts to add a flag", "assistant"),
		ContextItemType.FileModification,
	);
	assert.equal(
		detectItemType("created README.md", "assistant"),
		ContextItemType.FileModification,
	);
	assert.equal(
		detectItemType("wrote tests/main.test.ts", "assistant"),
		ContextItemType.FileModification,
	);
});

test("detectItemType: role=user → UserMessage", () => {
	assert.equal(
		detectItemType("plain question", "user"),
		ContextItemType.UserMessage,
	);
});

test("detectItemType: role=assistant → AssistantMessage", () => {
	assert.equal(
		detectItemType("plain answer", "assistant"),
		ContextItemType.AssistantMessage,
	);
});

test("detectItemType: fallback → AssistantMessage", () => {
	// Unknown role with non-matching content falls back to AssistantMessage.
	assert.equal(
		detectItemType("nothing matches here", "unknown" as any),
		ContextItemType.AssistantMessage,
	);
});

test("detectItemType: empty string does not crash and falls back", () => {
	assert.equal(detectItemType("", "user"), ContextItemType.UserMessage);
	assert.equal(detectItemType("", "assistant"), ContextItemType.AssistantMessage);
});

test("detectItemType: priority — error before decision (first match wins)", () => {
	// A message that contains BOTH "error" and "decided" — error wins (rule 3 before rule 4).
	assert.equal(
		detectItemType("error: we decided to fail", "assistant"),
		ContextItemType.Error,
	);
});

// ---- S40A-6: score ----

test("score: fresh decision gets full multiplier (no decay, no recency/retention boost expected unless young)", () => {
	const result = score(
		{
			id: "0",
			content: "we decided to use JWT",
			role: "assistant",
			timestamp: NOW, // age 0
		},
		NOW,
	);
	assert.equal(result.type, ContextItemType.Decision);
	assert.equal(result.rawMultiplier, 2.5);
	assert.equal(result.ageDecay, 0);
	assert.equal(result.recencyBoost, 1.2); // age 0 < 5min
	assert.equal(result.retentionBoost, 1.0); // not userFlagged
	// 2.5 * (1 - 0) * 1.2 * 1.0 = 3.0
	assert.equal(result.finalScore, 3.0);
});

test("score: old decision decays", () => {
	const tenHoursAgo = NOW - 10 * 3_600_000;
	const result = score(
		{
			id: "1",
			content: "we decided to use JWT",
			role: "assistant",
			timestamp: tenHoursAgo,
		},
		NOW,
	);
	// decay at 10h = 0.5; recency 1.0 (>5min); retention 1.0
	// 2.5 * (1 - 0.5) * 1.0 * 1.0 = 1.25
	assert.equal(result.ageDecay, 0.5);
	assert.equal(result.recencyBoost, 1.0);
	assert.equal(result.finalScore, 1.25);
});

test("score: userFlagged triples the result via retentionBoost", () => {
	const flagged = score(
		{
			id: "2",
			content: "we decided to use JWT",
			role: "assistant",
			timestamp: NOW,
			userFlagged: true,
		},
		NOW,
	);
	const unflagged = score(
		{
			id: "3",
			content: "we decided to use JWT",
			role: "assistant",
			timestamp: NOW,
			userFlagged: false,
		},
		NOW,
	);
	// 3.0 / 1.0 retention ratio.
	assert.equal(flagged.finalScore / unflagged.finalScore, 3.0);
});

test("score: clamps finalScore to minimum 0.01", () => {
	// A system message (0.5x) at 14h+ (max decay 0.7) → 0.5 * 0.3 * 1.0 * 1.0 = 0.15. Above 0.01.
	// Force below 0.01 with a custom multiplier of 0 and max decay.
	const result = score(
		{
			id: "4",
			content: "system filler",
			role: "custom",
			timestamp: NOW - 100 * 3_600_000,
		},
		NOW,
		{ [ContextItemType.SystemMessage]: 0.01 },
		{ maxDecay: 0.99 },
	);
	// 0.01 * (1 - 0.99) * 1.0 * 1.0 = 0.0001 → clamped to 0.01.
	assert.equal(result.finalScore, 0.01);
});

test("score: custom multipliers override DEFAULT_MULTIPLIERS", () => {
	const result = score(
		{
			id: "5",
			content: "we decided to use JWT",
			role: "assistant",
			timestamp: NOW,
		},
		NOW,
		{ [ContextItemType.Decision]: 10.0 },
	);
	assert.equal(result.rawMultiplier, 10.0);
	assert.equal(result.finalScore, 10.0 * 1.2); // 10 * (1-0) * 1.2 * 1.0
});

test("score: unknown role narrows to assistant defensively", () => {
	const result = score(
		{
			id: "6",
			content: "plain text",
			role: "weird-role" as any,
			timestamp: NOW,
		},
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
	const item = {
		id: "d1",
		content: "we decided to use JWT",
		role: "assistant",
		timestamp: NOW - 3_600_000,
	};
	const a = score(item, NOW);
	const b = score(item, NOW);
	assert.deepEqual(a, b);
});

// ---- S40A-7: preservationCutoff + itemsToPreserve ----

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
		// scores 1.0, 2.0, ..., 10.0
		finalScore: (i + 1) * 1.0,
	}));
	const threshold = preservationCutoff(items, 0.3);
	// top 30% of 10 = 3 items; the 3rd highest is 8.0 (scores 10,9,8 preserved).
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

// ---- scoreEngineMessages: position-based age fallback ----

test("scoreEngineMessages: assigns position-based timestamps (oldest first)", () => {
	const messages: EngineMessage[] = [
		{ role: "assistant", text: "we decided to use JWT" },
		{ role: "user", text: "ok" },
		{ role: "assistant", text: "edited src/config.ts" },
	];
	const scored = scoreEngineMessages(messages, NOW);
	assert.equal(scored.length, 3);
	// Oldest (i=0) is `messages.length` minutes ago = 3 min.
	assert.equal(scored[0].timestamp, NOW - 3 * 60_000);
	// Newest (i=2) is 1 min ago.
	assert.equal(scored[2].timestamp, NOW - 1 * 60_000);
	// All recency-boosted (< 5 min).
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

// ---- integration: a decision outsurvives filler ----

test("integration: a decision is preserved over filler at the same age", () => {
	// 10 messages, 1 decision (i=4) and 9 filler, all equally old.
	const messages: EngineMessage[] = Array.from({ length: 10 }, (_, i) =>
		i === 4
			? { role: "assistant", text: "we decided to use JWT auth" }
			: { role: "assistant", text: "ok, sounds good" },
	);
	const scored = scoreEngineMessages(messages, NOW - 10 * 60_000); // 10 min old → no recency boost
	// decision rawMultiplier 2.5 vs filler 1.0; same decay, same recency.
	const decision = scored[4];
	const filler = scored[0];
	assert.ok(decision.finalScore > filler.finalScore);
	// top 20% → 2 items; the decision must be in the preserved set.
	const result = itemsToPreserve(scored, 0.2);
	assert.ok(
		result.preservedIds.has("4"),
		"decision must be preserved",
	);
});
