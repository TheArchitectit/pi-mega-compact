/**
 * edge-cases.test.ts — empty/single/near-end/unicode/huge/mixed-role conversations.
 * Split out of dedup-engine.test.ts; describe bodies are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactSession } from "../engine.js";
import { vectorList, vectorStats } from "../vectorStore.js";
import type { EngineMessage } from "../types.js";
import { makeStore, makeMsg, buildConversation, compactFull } from "./_helpers.js";
describe("Edge Cases", () => {
  const SESS = "sess_edge";

  it("empty message list returns skipped", () => {
    const s = makeStore();
    const r = compactSession({ sessionId: SESS, messages: [], keepFrom: 0 }, s);
    assert.equal(r.skipped, true);
    assert.equal(r.summary, "");
    assert.equal(vectorList(s,SESS).length, 0);
  });

  it("single message with keepFrom=0 returns skipped", () => {
    const s = makeStore();
    const r = compactSession(
      { sessionId: SESS, messages: [makeMsg("user", "only one message")], keepFrom: 0 },
      s,
    );
    assert.equal(r.skipped, true);
    assert.equal(vectorList(s,SESS).length, 0);
  });

  it("keepFrom at messages.length compacts all prior messages (verified behavior)", () => {
    // The engine treats keepFrom as the compactable boundary: messages[0..keepFrom)
    // are compacted. When keepFrom equals messages.length the entire conversation is
    // compactable, so it is NOT skipped. This test documents that behavior.
    const s = makeStore();
    const messages = buildConversation(6);
    const r = compactSession({ sessionId: SESS, messages, keepFrom: messages.length }, s);
    assert.equal(r.skipped, false);
    assert.ok(r.checkpointId);
    assert.equal(vectorList(s,SESS).length, 1);
  });

  it("unicode and emoji messages store and retrieve intact", () => {
    const s = makeStore();
    const text =
      "用户请求：创建 🎉 庆祝页面，包含 café 菜单 — déjà vu! " +
      "日本語テキスト 日本語テキスト 👍🔥";
    const r = compactFull(s, SESS, [makeMsg("user", text)], 1);
    assert.equal(r.skipped, false);
    const stored = vectorList(s,SESS)[0];
    assert.ok(stored);
    const recovered = Buffer.from(stored.compressedOriginal ?? Buffer.alloc(0));
    assert.ok(
      recovered.toString("utf-8").includes("🎉"),
      "emoji recovered from compressedOriginal",
    );
    assert.ok(stored.summary.includes("café") || stored.summary.includes("cafe"));
  });

  it("very large single message (>10k chars) compacts and stores successfully", () => {
    const s = makeStore();
    const big = "bigint ".repeat(2000);
    assert.ok(big.length > 10_000, `message length ${big.length}`);
    const r = compactFull(s, SESS, [makeMsg("user", big)], 1);
    assert.equal(r.skipped, false);
    assert.ok(r.checkpointId);
    assert.equal(vectorList(s,SESS).length, 1);
    const stats = vectorStats(s,SESS);
    assert.ok(stats.totalTokenEstimate > 0);
  });

  it("mixed roles (user/assistant/tool) are included in summary", () => {
    const s = makeStore();
    const messages: EngineMessage[] = [
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "will do", toolName: "Read", input: "src/bug.ts" },
      { role: "tool", text: "", toolName: "Read", output: "function foo() {}" },
      { role: "assistant", text: "fixed it", toolName: "Edit" },
    ];
    const r = compactFull(s, SESS, messages, messages.length);
    assert.equal(r.skipped, false);
    assert.ok(r.summary.length > 0);
    assert.ok(
      r.summary.includes("tool") ||
        r.summary.includes("Read") ||
        r.summary.includes("Edit") ||
        r.summary.includes("user") ||
        r.summary.includes("assistant"),
      "summary should reference roles or tools",
    );
    assert.equal(vectorList(s,SESS).length, 1);
  });
});
