/**
 * enums-decay.test.ts — S40A-1/2/3: ContextItemType, DEFAULT_MULTIPLIERS, ageDecay.
 * Split from src/importance.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ContextItemType,
	DEFAULT_MULTIPLIERS,
	ageDecay,
} from "../importance.js";

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
		assert.equal(typeof DEFAULT_MULTIPLIERS[t], "number", `missing multiplier for ${t}`);
	}
});

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
	assert.equal(ageDecay(10 * 3_600_000, 0.1, 0.8), 0.8);
	assert.equal(ageDecay(2 * 3_600_000, 0.1, 0.8), 0.2);
});
