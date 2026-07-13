import { test } from "node:test";
import assert from "node:assert/strict";
import { extractiveSummarize } from "./extractive.js";
import type { EngineMessage } from "./types.js";

function msg(role: EngineMessage["role"], text: string, toolName?: string): EngineMessage {
  return toolName ? { role, text, toolName, input: text, output: text } : { role, text };
}

// ---- Determinism -----------------------------------------------------------

test("extractive summary is deterministic", () => {
  const messages: EngineMessage[] = [
    msg("user", "please write src/index.ts"),
    msg("assistant", "I'll write src/index.ts now."),
    msg("tool", '{"file_path":"src/index.ts"}', "write"),
    msg("assistant", "Done."),
  ];
  const s1 = extractiveSummarize(messages);
  const s2 = extractiveSummarize(messages);
  assert.deepStrictEqual(s1, s2);
});

// ---- Compression -----------------------------------------------------------

test("extractive summary produces small output", () => {
  // Build 70 messages (simulating a session)
  const messages: EngineMessage[] = [];
  for (let i = 0; i < 70; i++) {
    messages.push(msg("user", `request ${i}: please help with feature ${i}`));
    messages.push(msg("assistant", `working on feature ${i} in src/file${i % 5}.ts`));
    messages.push(msg("tool", `{"file_path":"src/file${i % 5}.ts","content":"..."}`, "write"));
    messages.push(msg("assistant", `done with feature ${i}`));
  }
  const rawText = messages.map((m) => m.text).join("\n");
  const rawTokens = Math.ceil(rawText.length / 4);

  const summary = extractiveSummarize(messages);
  const ratio = rawTokens / summary.tokenEstimate;

  // Compression should be at least 5:1 (target is 35:1)
  assert.ok(ratio >= 5, `compression ratio ${ratio.toFixed(1)}:1 is less than 5:1`);
  assert.ok(summary.tokenEstimate < 5000, `summary is ${summary.tokenEstimate} tokens (expected < 5000)`);
});

// ---- Empty input ------------------------------------------------------------

test("empty messages returns minimal summary", () => {
  const summary = extractiveSummarize([]);
  assert.equal(summary.topicSummary, "(empty)");
  assert.equal(summary.keyDecisions.length, 0);
  assert.equal(summary.nextSteps.length, 0);
  assert.equal(summary.filesModified.length, 0);
  assert.equal(summary.tokenEstimate, 0);
});

// ---- Key decisions ----------------------------------------------------------

test("extracts decisions from assistant messages", () => {
  const messages: EngineMessage[] = [
    msg("user", "which database should we use?"),
    msg("assistant", "I recommend using better-sqlite3 for the local vector store."),
    msg("assistant", "Let's go with the Trident pipeline architecture."),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.keyDecisions.length >= 1, "should extract at least 1 decision");
  assert.ok(
    summary.keyDecisions.some((d) => d.includes("better-sqlite3")),
    `decisions: ${JSON.stringify(summary.keyDecisions)}`,
  );
});

test("no decisions in tool messages", () => {
  const messages: EngineMessage[] = [
    msg("tool", "I recommend something", "bash"),
  ];
  const summary = extractiveSummarize(messages);
  // Tool messages should not be checked for decisions
  assert.equal(summary.keyDecisions.length, 0);
});

// ---- Files modified ---------------------------------------------------------

test("extracts files from write/edit tool calls", () => {
  const messages: EngineMessage[] = [
    msg("tool", '{"file_path":"/home/user/project/src/index.ts","content":"..."}', "write"),
    msg("tool", '{"file_path":"/home/user/project/README.md","content":"..."}', "edit"),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.filesModified.includes("/home/user/project/src/index.ts"));
  assert.ok(summary.filesModified.includes("/home/user/project/README.md"));
});

test("extracts files from git commands in bash", () => {
  const messages: EngineMessage[] = [
    msg("tool", "git add src/index.ts src/types.ts", "bash"),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.filesModified.some((f) => f.includes("index.ts")));
});

// ---- Pending work -----------------------------------------------------------

test("extracts pending work markers", () => {
  const messages: EngineMessage[] = [
    msg("user", "run the tests"),
    msg("assistant", "Tests pass. TODO: add integration tests for the dedup path."),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.nextSteps.length >= 1, "should find TODO");
  assert.ok(summary.nextSteps.some((s) => /integration tests/i.test(s)));
});

// ---- topicSummary structure -------------------------------------------------

test("topicSummary contains scope line", () => {
  const messages: EngineMessage[] = [
    msg("user", "hello"),
    msg("assistant", "hi there"),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.topicSummary.includes("Conversation: 2 messages"));
  assert.ok(summary.topicSummary.includes("1 user"));
  assert.ok(summary.topicSummary.includes("1 assistant"));
});

test("topicSummary includes tools when present", () => {
  const messages: EngineMessage[] = [
    msg("tool", "ok", "write"),
    msg("tool", "ok", "bash"),
  ];
  const summary = extractiveSummarize(messages);
  assert.ok(summary.topicSummary.includes("Tools:"));
  assert.ok(summary.topicSummary.includes("write"));
  assert.ok(summary.topicSummary.includes("bash"));
});

// ---- Same messages produce same summary ------------------------------------

test("deterministic across invocations with complex input", () => {
  const messages: EngineMessage[] = [
    msg("user", "help me refactor the auth module"),
    msg("assistant", "I'll look at the current auth implementation."),
    msg("tool", '{"file_path":"src/auth.ts"}', "read"),
    msg("assistant", "I recommend splitting auth.ts into separate files."),
    msg("user", "sounds good, go ahead"),
    msg("assistant", "I'll create src/auth/login.ts and src/auth/register.ts."),
    msg("tool", '{"file_path":"src/auth/login.ts","content":"..."}', "write"),
    msg("tool", '{"file_path":"src/auth/register.ts","content":"..."}', "write"),
    msg("assistant", "Done. TODO: update the import paths in main.ts."),
  ];
  const results = Array.from({ length: 5 }, () => extractiveSummarize(messages));
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i], results[0], `run ${i} differs from run 0`);
  }
});
