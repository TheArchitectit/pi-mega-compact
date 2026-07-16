/**
 * mega-trim.test.ts — tests for the live compaction view builder (S16).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveTrimmedView } from "./mega-trim.js";
import type { EngineMessage } from "../src/types.js";

function m(role: EngineMessage["role"], text: string, extra: Partial<EngineMessage> = {}): EngineMessage {
  return { role, text, toolName: undefined, input: undefined, output: undefined, ...extra };
}

test("buildLiveTrimmedView: prepends a compacted summary and keeps the recent anchor", () => {
  const view: EngineMessage[] = [
    m("user", "old request one"), m("assistant", "old answer one"),
    m("user", "old request two"), m("assistant", "old answer two"),
    m("user", "recent keep me"), m("assistant", "recent keep me too"),
  ];
  // Compacted region = first 4; recent anchor = last 2.
  const result = buildLiveTrimmedView(view, {
    compactedFrom: 4,        // index where the compacted region ends
    summary: "<summary>earlier work on old requests</summary>",
    anchorUserMessages: 1,
  });
  // First element is the injected compacted summary as a user-role message.
  assert.equal(result[0].role, "user");
  assert.ok(String(result[0].text).includes("earlier work on old requests"));
  // Recent anchor preserved in order, no older messages leak through.
  assert.equal(result.length, 1 + 2, "summary + 2 recent");
  assert.ok(result.slice(1).some((x) => String(x.text).includes("recent keep me")));
});

test("buildLiveTrimmedView: empty summary returns the original view unchanged", () => {
  const view = [m("user", "x"), m("assistant", "y")];
  const result = buildLiveTrimmedView(view, { compactedFrom: 0, summary: "", anchorUserMessages: 1 });
  assert.deepEqual(result, view);
});

test("buildLiveTrimmedView: never splits a toolCall/toolResult pair (PREVENT-PI-002)", () => {
  const view: EngineMessage[] = [
    m("user", "q"), m("assistant", "calls tool", { toolName: "read" }), m("tool", "result"),
    m("user", "keep"), m("assistant", "ok"),
  ];
  // cut=3 would start the preserved run on the orphaned tool result at index 2 —
  // the builder must snap back so the toolCall/toolResult pair is not split.
  const result = buildLiveTrimmedView(view, { compactedFrom: 3, summary: "<summary>s</summary>", anchorUserMessages: 1 });
  // The tool result must never appear preserved WITHOUT its preceding toolCall.
  const preserved = result.slice(1);
  const hasToolResult = preserved.some((x) => x.role === "tool");
  const hasToolCall = preserved.some((x) => x.role === "assistant" && x.toolName);
  // Either the tool pair is kept together, or the tool result is dropped into
  // the compacted region — it is never left orphaned.
  assert.ok(!(hasToolResult && !hasToolCall), "no orphaned tool result in the preserved run");
});

test("buildLiveTrimmedView: honors the anchor floor (PREVENT-PI-001)", () => {
  // cut would leave zero user messages in the anchor — must skip the trim.
  const view: EngineMessage[] = [
    m("user", "old q"), m("assistant", "old a"),
    m("assistant", "only assistant kept"),
  ];
  const result = buildLiveTrimmedView(view, { compactedFrom: 2, summary: "<summary>s</summary>", anchorUserMessages: 1 });
  assert.deepEqual(result, view, "below anchor floor → no trim this call");
});
