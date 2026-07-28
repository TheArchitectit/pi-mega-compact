import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewConversation, type MemoryOp } from "./memory.js";
import type { EngineMessage } from "./types.js";

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

// ---- E5 (docs/specs/s25-memory-db-roundtrip.md): hallucination-guard pins ----

test("E5.3 — truncation pin: long decision truncates to 160 chars and stays message-grounded", () => {
  // collectRecentUserRequests truncates user text at 160 chars before review.
  // A long decision is silently clipped — undocumented before S25; this pins
  // the boundary.
  const long =
    "we decided to use node:sqlite for the authoritative store backend after evaluating better-sqlite3, pglite and libsql and rejecting all three";
  const msgs = [{ role: "user", text: long }] as any;
  const ops = reviewConversation(msgs);
  const add = ops.find((o) => o.op === "add") as Extract<MemoryOp, { op: "add" }> | undefined;
  assert.ok(add, "a decision inside a long user message produces an add");
  assert.ok(
    add!.memory.content.length <= 160,
    "stored content is 160-char truncated",
  );
  assert.ok(
    long.includes(add!.memory.content),
    "truncated content is still verbatim-grounded in the message",
  );
});

test("E5.1 — hallucination guard: every surviving add/replace is verbatim from a real message", () => {
  const msgs = [{ role: "user", text: "the pipeline uses dagster for orchestration" }] as EngineMessage[];
  const ops = reviewConversation(msgs, [{ content: "we use better-sqlite3 for the store" }]);
  for (const o of ops) {
    if (o.op === "remove") continue; // REMOVE is exempt by design (:70-74)
    assert.ok(
      msgs.some((m) => String(m.text ?? "").includes(o.memory.content)),
      "every add/replace content is verbatim from a real message",
    );
  }
  assert.equal(ops.filter((o) => o.op !== "remove").length, 0, "non-decision text produces no add/replace");
});

test("E5.4 — REMOVE over-match pin: single-token topic overlap fires REMOVE", () => {
  const existing = [{ content: "we use redis for the cache" }];
  const msgs = [{ role: "user", text: "stop using redis" }] as any;
  const ops = reviewConversation(msgs, existing);
  assert.ok(
    ops.some((o) => o.op === "remove" && /redis/i.test(o.content)),
    "single-token overlap removes the matching memory (current behavior — KNOWN: weak topic match)",
  );
});
