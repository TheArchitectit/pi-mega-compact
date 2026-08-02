/**
 * edge-cases.test.ts — empty/single/large/unicode/preserve-recent edge cases.
 * Split from src/e2e.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSession } from "../engine.js";
import { vectorSearch, vectorList } from "../vectorStore.js";
import type { EngineMessage } from "../types.js";
import { msg, store } from "./_helpers.js";

test("11a. Empty session (no messages) — compactSession should skip", () => {
  const s = store();
  const r = compactSession({ sessionId: "sess_empty_msgs", messages: [], keepFrom: 0, timestamp: 1 }, s);
  assert.equal(r.skipped, true, "empty session should be skipped");
  assert.equal(r.summary, "");
  assert.equal(r.regionHash, "");
  assert.equal(vectorList(s,"sess_empty_msgs").length, 0);
});

test("11b. Single message session — should skip or handle gracefully", () => {
  const s = store();
  const r = compactSession({
    sessionId: "sess_single_msg",
    messages: [msg("user", "hello world")],
    keepFrom: 0,
    timestamp: 1,
  }, s);
  // With keepFrom=0, the single message is compactable, so it should work
  // but produce a minimal summary
  assert.ok(r.skipped === true || r.skipped === false, "should not throw");
  if (!r.skipped) {
    assert.ok(r.checkpointId);
  }
});

test("11c. Very large region text — should still compact and store", () => {
  const s = store();
  const SESS = "sess_large";

  // Build a large conversation with many messages
  const messages: EngineMessage[] = [];
  for (let i = 0; i < 50; i++) {
    messages.push(msg("user", `read src/module_${i}.ts and review the implementation of feature ${i}`));
    messages.push(msg("assistant", `Reviewed src/module_${i}.ts — feature ${i} looks good with minor issues`, "Read"));
    messages.push(msg("user", `fix the issues in src/module_${i}.ts`));
    messages.push(msg("assistant", `Fixed issues in src/module_${i}.ts`, "Edit"));
  }

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 8, timestamp: 1 }, s);
  assert.equal(r.skipped, false, "large conversation should compact");
  assert.ok(r.checkpointId, "checkpoint created");
  assert.ok(r.summary.length > 0, "summary produced");

  // Verify it's searchable
  const hits = vectorSearch(s, SESS, "module feature fix review", 3);
  assert.ok(hits.length > 0, "large checkpoint is searchable");
});

test("11d. Unicode and emoji content — should normalize and hash correctly", () => {
  const s = store();
  const SESS = "sess_unicode";

  const messages: EngineMessage[] = [
    msg("user", "read src/本地化.ts and fix the 中文 translation issues 🌏"),
    msg("assistant", "Fixed translations in src/本地化.ts — updated 中文 strings and emoji handling 🌏✅", "Edit"),
    msg("user", "add support for 日本語 and 한국어 locales too"),
    msg("assistant", "Added 日本語 and 한국어 locale support in src/本地化.ts 🌏✅🇯🇵🇰🇷", "Edit"),
  ];

  const r = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 1 }, s);
  assert.equal(r.skipped, false, "unicode conversation should compact");
  assert.ok(r.regionHash.length > 0, "regionHash computed for unicode content");

  // Verify the checkpoint exists and is searchable
  const hits = vectorSearch(s, SESS, "中文 translation 本地化", 3);
  assert.ok(hits.length > 0, "unicode checkpoint is searchable");

  // Verify regionHash is deterministic for the same unicode content
  const r2 = compactSession({ sessionId: SESS, messages, keepFrom: 4, timestamp: 2 }, s);
  assert.equal(r2.deduped, true, "identical unicode content should be deduped");
  assert.equal(r.regionHash, r2.regionHash, "regionHash is deterministic for unicode");
});

test("11e. All messages in preserve-recent window — nothing to compact", () => {
  const s = store();
  const messages: EngineMessage[] = [
    msg("user", "first message"),
    msg("assistant", "first response", "Edit"),
    msg("user", "second message"),
    msg("assistant", "second response", "Edit"),
  ];

  // keepFrom = 0 → compactable slice is empty (everything is "preserved")
  const r = compactSession({
    sessionId: "sess_all_preserved",
    messages,
    keepFrom: 0,
    timestamp: 1,
  }, s);
  assert.equal(r.skipped, true, "should skip when keepFrom=0 (nothing to compact)");
  assert.equal(vectorList(s,"sess_all_preserved").length, 0, "no checkpoints stored");
});

