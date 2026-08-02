/**
 * stats-tokens.test.ts — vectorStats, tokensSaved, repoStats, empty session stats.
 * Split from src/vectorStore.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VectorStore, vectorStats, vectorMarkInjected, vectorRepoStats } from "../vectorStore.js";
import { store, nextDir } from "./_helpers.js";

test("stats reports counts, last checkpoint, and dedup rate", () => {
  const s = store();
  s.add({
    sessionId: "sess_stats",
    summary: "alpha",
    regionText: "region alpha text",
    tokenEstimate: 500,
    timestamp: 1,
  });
  s.add({
    sessionId: "sess_stats",
    summary: "beta",
    regionText: "region beta text",
    tokenEstimate: 700,
    timestamp: 2,
  });
  const st1 = vectorStats(s,"sess_stats");
  assert.equal(st1.checkpointCount, 2);
  assert.equal(st1.lastCheckpointId, "chkpt_002");
  assert.equal(st1.totalTokenEstimate, 1200);
  assert.equal(st1.injectedCount, 0);
  assert.equal(st1.dedupHitRate, 0);

  vectorMarkInjected(s,"sess_stats", "chkpt_001");
  const st2 = vectorStats(s,"sess_stats");
  assert.equal(st2.injectedCount, 1);
  assert.ok(Math.abs(st2.dedupHitRate - 0.5) < 1e-9);
});

test("tokensSaved = original − stored per session; deduped add saves the whole region", () => {
  const s = store();
  s.add({ sessionId: "sess_saved", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 1 });
  s.add({ sessionId: "sess_saved", summary: "beta", regionText: "region beta text", tokenEstimate: 700, originalTokenEstimate: 3000, timestamp: 2 });
  const st = vectorStats(s,"sess_saved");
  assert.equal(st.totalTokenEstimate, 1200, "Σ stored summaries");
  assert.equal(st.originalTokens, 5000, "Σ original region tokens");
  assert.equal(st.tokensSaved, 3800, "per-session saved = Σ(original − stored) = 1500 + 2300");
  assert.equal(st.dedupCollapsed, 0);
  assert.equal(st.dedupAttempts, 2);

  const deduped = s.add({ sessionId: "sess_saved", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 3 });
  assert.ok(deduped.deduped, "identical region should dedup");
  const st3 = vectorStats(s,"sess_saved");
  assert.equal(st3.tokensSaved, 3800, "per-session DB sum unchanged by deduped add");
  assert.equal(st3.dedupCollapsed, 1, "deduped collapse counted");
  assert.equal(st3.dedupAttempts, 3);
  assert.equal(vectorRepoStats(s).tokensSaved, 3800 + 2000, "repo saved includes deduped original");
});

test("repoStats aggregates every session + counts deduped original tokens", () => {
  const dir = nextDir();
  const a = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  const b = new VectorStore({ dedupSim: 0.9, stateDir: dir });
  a.add({ sessionId: "sess_a", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 1 });
  b.add({ sessionId: "sess_b", summary: "beta", regionText: "region beta text", tokenEstimate: 700, originalTokenEstimate: 3000, timestamp: 2 });

  const repo = vectorRepoStats(a);
  assert.equal(repo.checkpointCount, 2, "checkpoints across both sessions");
  assert.equal(repo.sessionCount, 2, "two distinct sessions");
  assert.equal(repo.totalTokenEstimate, 1200, "Σ stored");
  assert.equal(repo.originalTokens, 5000, "Σ original");
  assert.equal(repo.tokensSaved, 3800, "repo saved = Σ(original − stored) = 1500 + 2300");
  assert.equal(repo.dedupCollapsed, 0);

  const deduped = a.add({ sessionId: "sess_a", summary: "alpha", regionText: "region alpha text", tokenEstimate: 500, originalTokenEstimate: 2000, timestamp: 3 });
  assert.ok(deduped.deduped);
  const repo2 = vectorRepoStats(a);
  assert.equal(repo2.tokensSaved, 3800 + 2000, "deduped collapse adds full original region to repo saved");
  assert.equal(repo2.dedupCollapsed, 1);
  assert.equal(repo2.checkpointCount, 2, "still two stored checkpoints");
});

test("stats on empty session returns zeros and nulls", () => {
  const s = store();
  const st = vectorStats(s,"sess_empty");
  assert.equal(st.checkpointCount, 0);
  assert.equal(st.lastCheckpointId, undefined);
  assert.equal(st.totalTokenEstimate, 0);
  assert.equal(st.dedupHitRate, 0);
});
