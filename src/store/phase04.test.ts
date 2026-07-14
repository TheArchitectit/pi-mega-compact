import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";
import { listCheckpoints, dataInvariantStats } from "./sqlite.js";
import { decompressSmart, compressSmart } from "./compression.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-p04-"));

let counter = 0;
function store(opts: { dedupSim?: number } = {}) {
  const dir = join(baseTmp, `run-${counter++}`);
  return { s: new VectorStore({ dedupSim: opts.dedupSim ?? 0.9, stateDir: dir }), dir };
}

test("Phase 4: added checkpoint is listed and its compressed-original round-trips", () => {
  const { s, dir } = store();
  const original = "the original region text that gets compacted and must be restorable verbatim";
  const r = s.add({ sessionId: "sess_a", summary: "s", regionText: original, tokenEstimate: 5, originalTokenEstimate: 60, timestamp: 1 });
  const all = listCheckpoints("sess_a", dir);
  assert.equal(all.length, 1, "one checkpoint listed");
  const cp = all[0];
  assert.ok(cp.compressedOriginal, "compressed-original blob present");
  // The DR/restore path: decompressSmart must return the exact original.
  const restored = decompressSmart(cp.compressedOriginal!).toString("utf-8");
  assert.equal(restored, original, "restored verbatim === original");
  assert.equal(cp.checkpointId, r.checkpoint.checkpointId);
});

test("Phase 4: findCheckpoint-by-id resolves a listed checkpoint", () => {
  const { s, dir } = store();
  s.add({ sessionId: "sess_b", summary: "s1", regionText: "region one text content here", tokenEstimate: 4, originalTokenEstimate: 40, timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_b", summary: "s2", regionText: "region two text content here different", tokenEstimate: 4, originalTokenEstimate: 45, timestamp: 2 });
  const all = listCheckpoints("sess_b", dir);
  assert.equal(all.length, 2);
  const wanted = all.find((c) => c.checkpointId === r2.checkpoint.checkpointId)!;
  assert.ok(wanted, "checkpoint resolved by id");
  assert.ok(wanted.compressedOriginal, "has restorable original");
});

test("Phase 4: dataInvariantStats sanity for restore trust (0 deleted)", () => {
  const { s, dir } = store();
  s.add({ sessionId: "sess_c", summary: "s", regionText: "retained region body text", tokenEstimate: 5, originalTokenEstimate: 50, timestamp: 1 });
  const di = dataInvariantStats(dir);
  assert.equal(di.regionsRetained, 1);
  assert.ok(di.compressedOriginalBytes > 0);
  assert.equal(di.bytesPermanentlyDeleted, 0);
});

test("Phase 4: compressSmart/decompressSmart round-trips arbitrary text", () => {
  const text = "x".repeat(2000);
  const back = decompressSmart(compressSmart(Buffer.from(text, "utf-8"))).toString("utf-8");
  assert.equal(back, text);
});

process.on("exit", () => { try { rmSync(baseTmp, { recursive: true, force: true }); } catch { /* ignore */ } });
