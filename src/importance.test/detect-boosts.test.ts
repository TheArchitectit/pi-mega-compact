/**
 * detect-boosts.test.ts — S40A-4/5: recencyBoost, retentionBoost, detectItemType.
 * Split from src/importance.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ContextItemType,
	recencyBoost,
	retentionBoost,
	detectItemType,
} from "../importance.js";

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

test("detectItemType: role=tool → ToolExecution (priority 1)", () => {
	assert.equal(
		detectItemType("error: something failed", "tool"),
		ContextItemType.ToolExecution,
	);
});

test("detectItemType: role=custom → SystemMessage (priority 2)", () => {
	assert.equal(detectItemType("anything here", "custom"), ContextItemType.SystemMessage);
});

test("detectItemType: error content → Error", () => {
	assert.equal(detectItemType("Error: ENOENT at src/config.ts:42", "assistant"), ContextItemType.Error);
	assert.equal(detectItemType("Traceback (most recent call last)", "assistant"), ContextItemType.Error);
	assert.equal(detectItemType("panic: runtime error", "assistant"), ContextItemType.Error);
	assert.equal(detectItemType("E4030 connection refused", "assistant"), ContextItemType.Error);
});

test("detectItemType: decision content → Decision", () => {
	assert.equal(detectItemType("we decided to use JWT auth", "assistant"), ContextItemType.Decision);
	assert.equal(detectItemType("going with option B", "assistant"), ContextItemType.Decision);
	assert.equal(detectItemType("let's go with the async approach", "assistant"), ContextItemType.Decision);
	assert.equal(detectItemType("switching to a different database", "assistant"), ContextItemType.Decision);
});

test("detectItemType: fenced code block ≥20 chars → CodeBlock", () => {
	const code = "```js\nconst x = 42;\nconst y = 'hello world';\n```";
	assert.equal(detectItemType(code, "assistant"), ContextItemType.CodeBlock);
});

test("detectItemType: short fenced block (<20 chars) does NOT → CodeBlock", () => {
	const short = "```\nshort\n```";
	assert.notEqual(detectItemType(short, "assistant"), ContextItemType.CodeBlock);
});

test("detectItemType: file modification verbs → FileModification", () => {
	assert.equal(detectItemType("edited src/config.ts to add a flag", "assistant"), ContextItemType.FileModification);
	assert.equal(detectItemType("created README.md", "assistant"), ContextItemType.FileModification);
	assert.equal(detectItemType("wrote tests/main.test.ts", "assistant"), ContextItemType.FileModification);
});

test("detectItemType: role=user → UserMessage", () => {
	assert.equal(detectItemType("plain question", "user"), ContextItemType.UserMessage);
});

test("detectItemType: role=assistant → AssistantMessage", () => {
	assert.equal(detectItemType("plain answer", "assistant"), ContextItemType.AssistantMessage);
});

test("detectItemType: fallback → AssistantMessage", () => {
	assert.equal(detectItemType("nothing matches here", "unknown" as any), ContextItemType.AssistantMessage);
});

test("detectItemType: empty string does not crash and falls back", () => {
	assert.equal(detectItemType("", "user"), ContextItemType.UserMessage);
	assert.equal(detectItemType("", "assistant"), ContextItemType.AssistantMessage);
});

test("detectItemType: priority — error before decision (first match wins)", () => {
	assert.equal(detectItemType("error: we decided to fail", "assistant"), ContextItemType.Error);
});
