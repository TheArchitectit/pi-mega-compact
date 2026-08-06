/**
 * phase2-separation.test.ts — buildSeparatedPrompt (Phase 2) tests.
 * Split from separated-prompt.test.ts; test bodies are unchanged.
 *
 * PC-A: buildSeparatedPrompt is now PURE — the MEGACOMPACT_MESSAGE_SEPARATION
 * gate lives only at the call site (tailResult.ts). These tests no longer set
 * the env var; they exercise the pure reordering behavior directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSeparatedPrompt } from "../separated-prompt.js";
import { msg, asR } from "./_helpers.js";

describe("buildSeparatedPrompt (Phase 2)", () => {
  it("no tool/bash messages returns messages unchanged (byte-identical)", () => {
    const msgs: Record<string, unknown>[] = [
      msg("system", "you are a bot"),
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const result = buildSeparatedPrompt(msgs as never);
    assert.equal(result, msgs);
  });

  it("moves toolResult + bashExecution to tail, keeps rest in order", () => {
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

  it("preserves relative order of non-tool messages", () => {
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
