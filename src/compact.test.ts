import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineMessage } from "./types.js";
import {
  formatCompactSummary,
  summarizeMessages,
  mergeCompactSummaries,
  shouldCompact,
  autoCompactCheck,
  collectKeyFiles,
  inferPendingWork,
  extractFileCandidates,
} from "./compact.js";
import { estimateSessionTokens } from "./tokens.js";

function user(text: string): EngineMessage { return { role: "user", text }; }
function assistant(text: string): EngineMessage { return { role: "assistant", text }; }
function toolUse(name: string, input: string): EngineMessage { return { role: "assistant", text: "", toolName: name, input }; }
function toolResult(name: string, output: string): EngineMessage { return { role: "tool", text: "", toolName: name, output }; }

test("formatCompactSummary strips analysis and formats summary block (claw-code parity)", () => {
  const summary = "<analysis>scratch</analysis>\n<summary>Kept work</summary>";
  assert.equal(formatCompactSummary(summary), "Summary:\nKept work");
});

test("leaves small sessions unchanged (shouldCompact false)", () => {
  const messages = [user("hello")];
  assert.equal(shouldCompact(messages, 1, 4), false);
});

test("compacts older messages into a summary with Scope + timeline", () => {
  const messages = [
    user("one ".repeat(200)),
    assistant("two ".repeat(200)),
    toolResult("bash", "ok ".repeat(200)),
    assistant("recent"),
  ];
  assert.equal(shouldCompact(messages, 1, 2), true);
  const summary = summarizeMessages(messages.slice(0, 2));
  const formatted = formatCompactSummary(summary);
  assert.ok(formatted.includes("Scope:"));
  assert.ok(formatted.includes("Key timeline:"));
});

test("merge keeps previous compacted context when compacting again", () => {
  const first = summarizeMessages([
    user("Investigate src/compact.ts"),
    assistant("I will inspect the compact flow."),
  ]);
  const second = summarizeMessages([
    user("Also update src/boundary.ts"),
    assistant("Next: preserve prior summary context."),
  ]);
  const merged = mergeCompactSummaries(first, second);
  assert.ok(merged.includes("Previously compacted context:"));
  assert.ok(merged.includes("Newly compacted context:"));
  assert.ok(merged.includes("src/boundary.ts"));
});

test("infers pending work from recent messages", () => {
  const pending = inferPendingWork([
    user("done"),
    assistant("Next: update tests and follow up on remaining CLI polish."),
  ]);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].includes("Next: update tests"));
});

test("extracts key files from message content", () => {
  const files = collectKeyFiles([
    user("Update src/compact.ts and extensions/mega-compact.ts next."),
  ]);
  assert.ok(files.includes("src/compact.ts"));
  assert.ok(files.includes("extensions/mega-compact.ts"));
});

test("extractFileCandidates ignores plain words and non-interesting extensions", () => {
  const files = extractFileCandidates("look at foo/bar.png and src/x.ts and justaword");
  assert.deepEqual(files, ["src/x.ts"]);
});

test("summarizeMessages lists tool names sorted + deduped", () => {
  const summary = summarizeMessages([toolUse("search", "{}"), toolUse("bash", "{}"), toolResult("search", "ok")]);
  assert.ok(summary.includes("Tools mentioned: bash, search."));
});

test("autoCompactCheck reports utilization and threshold gate", () => {
  const under = autoCompactCheck(10000, 50000);
  assert.equal(under.shouldCompact, false);
  assert.equal(under.utilizationPct, 20);
  const over = autoCompactCheck(60000, 50000);
  assert.equal(over.shouldCompact, true);
});

test("token estimator counts text + tool payloads", () => {
  const total = estimateSessionTokens([user("abcd"), toolResult("bash", "abcd")]);
  // "abcd"/4+1 = 2 for user; tool: name "bash"/4+1=2 plus output "abcd"/4+1=2 => 4
  assert.equal(total, 2 + 4);
});
