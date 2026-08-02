/**
 * phase2-separation.test.ts — buildSeparatedPrompt (Phase 2) tests.
 * Split from separated-prompt.test.ts; test bodies are unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSeparatedPrompt } from "../separated-prompt.js";
import { msg, asR } from "./_helpers.js";

describe("buildSeparatedPrompt (Phase 2)", () => {
  let origSep: string | undefined;

  beforeEach(() => {
    origSep = process.env.MEGACOMPACT_MESSAGE_SEPARATION;
  });

  afterEach(() => {
    if (origSep === undefined) {
      delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    } else {
      process.env.MEGACOMPACT_MESSAGE_SEPARATION = origSep;
    }
  });

  it("flag OFF returns messages unchanged (byte-identical)", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "false";
    const msgs: Record<string, unknown>[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("default env (unset) returns messages unchanged", () => {
    delete process.env.MEGACOMPACT_MESSAGE_SEPARATION;
    const msgs: Record<string, unknown>[] = [
      msg("system", "you are a bot"),
      msg("user", "hello"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag ON moves toolResult + bashExecution to tail, keeps rest in order", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const u1 = msg("user", "what is the weather?");
    const a1 = msg("assistant", "let me check");
    const tool = msg("toolResult", [{ type: "text", text: "sunny" }], {
      toolCallId: "tc1",
      toolName: "get_weather",
      isError: false,
    });
    const bash = msg("bashExecution", "ls", { command: "ls", output: "file.ts", exitCode: 0, cancelled: false, truncated: false });
    const a2 = msg("assistant", "it's sunny");

    const msgs: Record<string, unknown>[] = [u1, a1, tool, bash, a2];
    const result = asR(buildSeparatedPrompt(msgs as never));

    assert.equal(result.length, 5);
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "assistant");
    assert.equal(result[2].role, "assistant");
    assert.equal(result[3].role, "toolResult");
    assert.equal(result[4].role, "bashExecution");
  });

  it("flag ON with no tool/bash messages returns the same reference (nothing to reorder)", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const msgs: Record<string, unknown>[] = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "bye"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("flag ON preserves relative order of non-tool messages", () => {
    process.env.MEGACOMPACT_MESSAGE_SEPARATION = "1";

    const q1 = msg("user", "first question");
    const a1 = msg("assistant", "first answer");
    const q2 = msg("user", "second question");
    const tool = msg("toolResult", [{ type: "text", text: "data" }], {
      toolCallId: "tc1",
      toolName: "lookup",
      isError: false,
    });

    const msgs: Record<string, unknown>[] = [q1, a1, q2, tool];
    const result = asR(buildSeparatedPrompt(msgs as never));

    assert.equal(result[0].content, "first question");
    assert.equal(result[1].content, "first answer");
    assert.equal(result[2].content, "second question");
    assert.equal(result[3].role, "toolResult");
  });
});
