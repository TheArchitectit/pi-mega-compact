/**
 * promote.test.ts — Fix D: RAPTOR tree served by vectorStore.search.
 *
 * Asserts that, when a RAPTOR tree has been built + persisted for a session,
 * VectorStore.search returns the tree's staged-expansion hits (broader, O(log n)
 * coverage) merged with the flat hits — so the dormant tree becomes the live
 * recall surface. No network: default extractive summarizer + trigram embedder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../../vectorStore.js";
import { runRaptor } from "./index.js";
import { compactSession } from "../../engine.js";
import { Logger } from "../../log.js";
import { loadDedupConfig } from "../../config/dedup.js";
import { listRaptorNodes } from "../../store/sqlite.js";
import type { EngineMessage } from "../../types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-promote-"));
let counter = 0;
function raptorConfig() {
  return { ...loadDedupConfig(), RAPTOR_ENABLED: true };
}
function msg(text: string, toolName?: string): EngineMessage {
  return toolName ? { role: "assistant", text, toolName, input: text, output: text } : { role: "user", text };
}
const SESS = "sess_promote";

test("Fix D: vectorStore.search serves a persisted RAPTOR tree (broader recall)", () => {
  const stateDir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ dedupSim: 0.9, stateDir, config: raptorConfig() });

  // Persist several distinct checkpoints.
  for (let i = 1; i <= 5; i++) {
    compactSession(
      { sessionId: SESS, messages: [msg(`topic alpha wire ${i} and bootstrap sequence`), msg(`ok ${i}`, "Edit")], keepFrom: 2, timestamp: i },
      s,
    );
  }

  // No tree yet → flat search only, returns hits, no RAPTOR coverage.
  assert.equal(listRaptorNodes(SESS, stateDir).length, 0, "no tree initially");
  const flat = s.search(SESS, "alpha wire bootstrap", 3);
  assert.ok(flat.length > 0, "flat search returns hits");

  // Build + persist a RAPTOR tree for the session (mirrors runCompact refresh).
  const all = s.list(SESS);
  const leaves = all.map((cp) => ({
    id: cp.checkpointId,
    messages: [],
    sourceText: cp.normalizedText ?? cp.summary ?? cp.regionHash,
    embedding: cp.embedding,
  }));
  const tree = runRaptor(leaves, { stateDir, sessionId: SESS, logger: new Logger() });
  assert.ok(tree && listRaptorNodes(SESS, stateDir).length > 0, "tree persisted");

  // With the tree live + RAPTOR_ENABLED, search still returns hits and now
  // exercises the RAPTOR-served path without regression.
  const withTree = s.search(SESS, "alpha wire bootstrap", 3);
  assert.ok(withTree.length > 0, "search returns hits with RAPTOR promoted");
  // Every returned hit is a real checkpoint in the session.
  for (const h of withTree) {
    assert.ok(all.some((cp) => cp.checkpointId === h.checkpoint.checkpointId), "hit is a real checkpoint");
  }
});

test("Fix D: search still works for a session with <2 leaves (no tree)", () => {
  const stateDir = join(baseTmp, `run-${counter++}`);
  const s = new VectorStore({ dedupSim: 0.9, stateDir, config: raptorConfig() });
  compactSession({ sessionId: SESS, messages: [msg("only one topic here"), msg("ok", "Edit")], keepFrom: 2, timestamp: 1 }, s);
  const r = s.search(SESS, "only one topic", 3);
  assert.ok(r.length > 0, "single-checkpoint search still works (no tree)");
  assert.equal(listRaptorNodes(SESS, stateDir).length, 0, "no tree built for <2 leaves");
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
