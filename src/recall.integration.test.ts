import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { compactSession } from "./engine.js";
import { recallAndInline } from "./recall.js";
import type { EngineMessage } from "./types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-resume-"));
let counter = 0;
/** Two instances, SAME disk dir — simulates a fresh process / resumed session. */
function storeForDir(dir: string) {
  return new VectorStore({ dedupSim: 0.9, stateDir: dir });
}
function msg(role: EngineMessage["role"], text: string, toolName?: string): EngineMessage {
  return toolName ? { role, text, toolName, input: text, output: text } : { role, text };
}
const SESS = "sess_resume";

/**
 * Simulate the extension's `recentUserQuery`: the resume query is built from the
 * newest user message in the (re-loaded) session. We model "newest user msg"
 * directly rather than going through pi's session manager.
 */
function latestUserQuery(messages: EngineMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].text;
  }
  return "";
}

test("resume contract: compact in one process, recall in a fresh one from disk", () => {
  const dir = join(baseTmp, `run-${counter++}`);

  // --- Process 1: the original session compacts ---
  const writer = storeForDir(dir);
  const session: EngineMessage[] = [
    msg("user", "investigated src/compact.ts and added a truncate helper"),
    msg("assistant", "added truncate", "Edit"),
    msg("user", "then wired it into the summary pipeline"),
    msg("assistant", "wired it in", "Edit"),
  ];
  const ran = compactSession(
    { sessionId: SESS, messages: session, keepFrom: session.length, timestamp: 1 },
    writer,
  );
  assert.equal(ran.skipped, false);
  assert.ok(ran.checkpointId, "a checkpoint was persisted");

  // --- Process 2: pi restarts, session resumes from disk ---
  const reader = storeForDir(dir); // brand new instance, same dir
  const resumeQuery = latestUserQuery(session); // newest user msg
  const r = recallAndInline(
    { sessionId: SESS, query: resumeQuery, limit: 3, source: "resume" },
    reader,
  );

  assert.equal(r.empty, false, "resume must re-surface the compacted context");
  assert.equal(r.toInject.length, 1);
  assert.equal(r.toInject[0].checkpoint.checkpointId, ran.checkpointId);
  assert.ok(r.block.includes("Recalled context"), "block is model-visible system-prompt text");
});

test("resume contract: nothing to recall for a brand-new session", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const fresh = storeForDir(dir);
  const r = recallAndInline(
    { sessionId: "sess_never_seen", query: "anything at all", limit: 3, source: "resume" },
    fresh,
  );
  assert.equal(r.empty, true);
  assert.equal(r.block, "");
});

test("resume contract: re-inject is deduped after the first recall", () => {
  const dir = join(baseTmp, `run-${counter++}`);
  const writer = storeForDir(dir);
  const session: EngineMessage[] = [
    msg("user", "built the trigram embedder for the vector store"),
    msg("assistant", "built it", "Edit"),
  ];
  compactSession({ sessionId: SESS, messages: session, keepFrom: 2, timestamp: 1 }, writer);

  const reader = storeForDir(dir);
  const q = latestUserQuery(session);
  const first = recallAndInline({ sessionId: SESS, query: q, limit: 3, source: "resume" }, reader);
  const second = recallAndInline({ sessionId: SESS, query: q, limit: 3, source: "resume" }, reader);
  assert.equal(first.empty, false);
  assert.equal(second.empty, true, "second resume does not re-inject (sentinel)");
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
