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

test("reviewConversation: emits REMOVE when a user asks to drop an existing memory", () => {
  const existing = [{ content: "we use node:sqlite as the store" }];
  // Plain drop statement — no "switch to …" phrasing so we don't accidentally
  // match DECISION_PATTERNS and route into the replace branch instead.
  const msgs = [
    { role: "user", text: "stop using node:sqlite for the store — drop it from memory" },
    { role: "assistant", text: "ok dropped" },
  ] as any;
  const ops = reviewConversation(msgs, existing);
  assert.ok(ops.some((o) => o.op === "remove" && /sqlite/i.test(o.content)), "emits a remove op targeting the old memory");
});

test("reviewConversation: REMOVE requires topic overlap (no accidental drop)", () => {
  const existing = [{ content: "the timezone is America/Los_Angeles" }];
  const msgs = [{ role: "user", text: "drop it" }] as any;
  const ops = reviewConversation(msgs, existing);
  assert.equal(ops.filter((o) => o.op === "remove").length, 0, "vague 'drop it' with no topic overlap does not remove anything");
});
