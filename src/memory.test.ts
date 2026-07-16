import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewConversation } from "./memory.js";

test("reviewConversation: yields an ADD op for a stated decision", () => {
  const msgs = [
    { role: "user", text: "we use node:sqlite as the store" },
    { role: "assistant", text: "got it, node:sqlite is the source of truth" },
  ] as any;
  const ops = reviewConversation(msgs);
  assert.ok(ops.some((o) => o.op === "add" && /sqlite|store/i.test(o.memory.content)), "adds a decision memory");
});

test("reviewConversation: REPLACE when a later message contradicts an earlier one", () => {
  const msgs = [
    { role: "user", text: "the threshold is 50k" },
    { role: "assistant", text: "ok 50k threshold" },
    { role: "user", text: "actually raise the threshold to 100k" },
  ] as any;
  const ops = reviewConversation(msgs);
  assert.ok(ops.some((o) => o.op === "replace"), "replaces the superseded value");
});

test("reviewConversation: no ops on pure smalltalk (no durable fact)", () => {
  const msgs = [{ role: "user", text: "hi" }, { role: "assistant", text: "hey" }] as any;
  assert.equal(reviewConversation(msgs).length, 0);
});
