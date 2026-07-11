import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineMessage } from "./types.js";
import { computeDropRange, isBoundarySafe, dropBefore } from "./boundary.js";

function user(t: string): EngineMessage { return { role: "user", text: t }; }
function assistant(t: string): EngineMessage { return { role: "assistant", text: t }; }
function toolUse(n: string, i = "{}"): EngineMessage { return { role: "assistant", text: "", toolName: n, input: i }; }
function toolResult(n: string, o = "ok"): EngineMessage { return { role: "tool", text: "", toolName: n, output: o }; }

test("walks back so first preserved message is not an orphaned tool result", () => {
  const messages = [
    user("Search for files"),
    toolUse("search"),
    toolResult("search", "found 5 files"),
    assistant("Done."),
  ];
  // keepFrom=2 would start the preserved run on the tool result at index 2,
  // orphaning it. The guard walks back to include the assistant tool-call.
  const [start, end] = computeDropRange(messages, 2, 0);
  assert.equal(start, 0);
  assert.equal(end, 1);
  const kept = messages.slice(end);
  assert.notEqual(kept[0].role, "tool");
  assert.equal(kept[0].toolName, "search"); // assistant tool-call preserved
});

test("isBoundarySafe: tool result at boundary with preceding tool use is safe", () => {
  const messages = [user("a"), toolUse("search"), toolResult("search")];
  assert.equal(isBoundarySafe(messages, 2), true);
});

test("isBoundarySafe: orphaned tool result without preceding tool use is unsafe", () => {
  const messages = [user("a"), toolResult("search", "orphan")];
  assert.equal(isBoundarySafe(messages, 1), false);
});

test("anchor floor preserves the last N user messages", () => {
  const messages = [
    user("u1"), user("u2"), user("u3"),
    assistant("a1"), assistant("a2"), assistant("a3"), assistant("a4"), assistant("a5"),
  ];
  // Caller wants to keep from index 2 (would drop u2). Anchor=2 forces keeping
  // from u2 (index 1) onward.
  const out = dropBefore(messages, 2, 2);
  assert.ok(out.some((m) => m.text === "u2"));
  assert.ok(out.some((m) => m.text === "u3"));
});

test("anchor floor is a no-op when fewer users than anchor", () => {
  const messages = [user("u1"), assistant("a1"), assistant("a2"), assistant("a3")];
  const out = dropBefore(messages, 1, 2);
  // only 1 user, anchor=2 → no floor; keep from index 1 (drop the user)
  assert.ok(!out.some((m) => m.text === "u1"));
  assert.equal(out.length, 3);
});

test("dropBefore returns original when range is empty", () => {
  const messages = [user("a"), assistant("b")];
  assert.equal(dropBefore(messages, 0, 1), messages);
});
