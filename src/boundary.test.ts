import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineMessage } from "./types.js";
import { computeDropRange, isBoundarySafe, dropBefore } from "./boundary.js";

function user(t: string): EngineMessage { return { role: "user", text: t }; }
function assistant(t: string): EngineMessage { return { role: "assistant", text: t }; }
function toolUse(n: string, i = "{}"): EngineMessage { return { role: "assistant", text: "", toolName: n, input: i }; }
function toolResult(n: string, o = "ok"): EngineMessage { return { role: "tool", text: "", toolName: n, output: o }; }
function custom(t: string): EngineMessage { return { role: "custom", text: t }; }

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

test("isBoundarySafe: cut that drops a toolCall but keeps its toolResult is unsafe (PREVENT-PI-002)", () => {
  const messages = [user("a"), toolUse("search"), toolResult("search")];
  // keepFrom=2 drops the toolUse at index 1 but keeps the toolResult at index 2 →
  // the preserved run starts on an orphaned tool result. This is the shape the old
  // check mis-validated (it only compared messages[keepFrom] to messages[keepFrom-1]).
  assert.equal(isBoundarySafe(messages, 2), false);
  // keepFrom=1 keeps the toolCall together with its toolResult → safe.
  assert.equal(isBoundarySafe(messages, 1), true);
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

// --- PREVENT-PI-002 regression cases for arbitrary interleavings ---

test("interleaved custom message between toolCall and toolResult: walk-back keeps the call", () => {
  // [user, assistant(tc=read), custom/bashExecution, tool(read-result)] with
  // desired keepFrom=3. The old walk-back saw messages[2] was not a toolUse and
  // broke at k=2, dropping the assistant toolCall at index 1 while KEEPING its
  // tool result at index 3 → orphaned tool result → provider 400.
  const messages = [
    user("Search for files"),
    toolUse("read"),
    custom("bash: ls -la"),
    toolResult("read", "file contents"),
    assistant("Done."),
  ];
  const [start, end] = computeDropRange(messages, 3, 0);
  assert.equal(start, 0);
  assert.equal(end, 1); // keep the assistant toolCall at index 1 with its result
  const kept = messages.slice(end);
  assert.equal(kept[0].toolName, "read"); // assistant tool-call preserved
  assert.ok(kept.some((m) => m.role === "tool" && m.toolName === "read"));
  // The toolCall and its toolResult are both in the kept run.
  const callIdx = kept.findIndex((m) => m.role === "assistant" && m.toolName === "read");
  const resultIdx = kept.findIndex((m) => m.role === "tool" && m.toolName === "read");
  assert.ok(callIdx !== -1 && resultIdx !== -1 && callIdx < resultIdx);
});

test("consecutive tool results sharing one call: no-op when the call cannot be kept", () => {
  // [assistant(tc), T1, T2] with keepFrom=1: dropping the call orphans BOTH T1
  // and T2. No pair-safe positive cut exists below keepFrom → no-op compaction
  // (the [start,end) contract preserves a non-zero result only when one exists).
  const messages = [toolUse("multi"), toolResult("multi", "r1"), toolResult("multi", "r2")];
  const [start, end] = computeDropRange(messages, 1, 0);
  assert.equal(start, 0);
  assert.equal(end, 0); // no-op — pair rule outranks dropping
  assert.equal(dropBefore(messages, 1, 0), messages);
});

test("consecutive tool results sharing one call: safe cut keeps the call with both results", () => {
  // [user, assistant(tc), T1, T2, user2] — keepFrom=3 would orphan T2; the guard
  // walks back to keep the call (dropEnd=1, only the first user is dropped).
  const messages = [
    user("u1"),
    toolUse("multi"),
    toolResult("multi", "r1"),
    toolResult("multi", "r2"),
    user("u2"),
  ];
  const [start, end] = computeDropRange(messages, 3, 0);
  assert.equal(start, 0);
  assert.equal(end, 1); // keep [assistant(tc), T1, T2, user2]
  const kept = messages.slice(end);
  const callIdx = kept.findIndex((m) => m.role === "assistant" && m.toolName === "multi");
  const r1Idx = kept.findIndex((m) => m.role === "tool" && m.output === "r1");
  const r2Idx = kept.findIndex((m) => m.role === "tool" && m.output === "r2");
  assert.ok(callIdx < r1Idx && r1Idx < r2Idx);
});

test("consecutive shared-call results: dropping call + all results together is safe", () => {
  // keepFrom=4 preserves only the trailing user — the call and BOTH results are
  // dropped together, so nothing is orphaned.
  const messages = [
    user("u1"),
    toolUse("multi"),
    toolResult("multi", "r1"),
    toolResult("multi", "r2"),
    user("u2"),
  ];
  const [start, end] = computeDropRange(messages, 4, 0);
  assert.equal(start, 0);
  assert.equal(end, 4);
  assert.deepEqual(messages.slice(end), [user("u2")]);
});

test("keepFrom landing on a call whose results follow is safe", () => {
  // [user, assistant(tc1), T1, assistant(tc2), T2, user2] keepFrom=3 → preserved
  // run starts on assistant(tc2) at index 3, whose result T2 follows. Safe.
  const messages = [
    user("u1"),
    toolUse("read"),
    toolResult("read", "r1"),
    toolUse("write"),
    toolResult("write", "r2"),
    user("u2"),
  ];
  const [start, end] = computeDropRange(messages, 3, 0);
  assert.equal(start, 0);
  assert.equal(end, 3);
  const kept = messages.slice(end);
  assert.equal(kept[0].role, "assistant");
  assert.equal(kept[0].toolName, "write");
  assert.ok(kept.some((m) => m.role === "tool" && m.toolName === "write"));
});

test("anchor floor + pair-rule conflict: pair rule wins, drop less", () => {
  // [assistant(tc), user, T] with anchor=1: the anchor floor wants dropEnd<=1
  // (keep the user at index 1), but keeping from index 1 orphans T (its owner at
  // index 0 would be dropped). The pair rule outranks the floor — we drop LESS,
  // keeping everything (no-op) rather than cross a pair.
  const messages = [toolUse("read"), user("keep me"), toolResult("read", "r")];
  const out = dropBefore(messages, 2, 1);
  assert.equal(out, messages, "anchor floor would orphan the tool result → no-op");
});

test("isBoundarySafe: interleaved custom between call and result is detected unsafe", () => {
  const messages = [user("a"), toolUse("read"), custom("bash"), toolResult("read", "r")];
  // keepFrom=3 drops the call at index 1, keeps the result at index 3 → unsafe.
  assert.equal(isBoundarySafe(messages, 3), false);
  // keepFrom=2 ALSO drops the call at index 1 (drop [0,2) = [user, toolUse]) and
  // keeps the result at index 3 → still orphaned → unsafe.
  assert.equal(isBoundarySafe(messages, 2), false);
  // keepFrom=1 keeps the call (index 1) together with its result at index 3 → safe.
  assert.equal(isBoundarySafe(messages, 1), true);
});

test("isBoundarySafe: cut before any tool result is safe", () => {
  const messages = [user("a"), toolUse("read"), toolResult("read", "r"), assistant("done")];
  assert.equal(isBoundarySafe(messages, 0), true); // out of range → safe
  assert.equal(isBoundarySafe(messages, messages.length), true); // out of range → safe
});
