import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "../vectorStore.js";
import { dataInvariantStats } from "./sqlite.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-p01-"));

let counter = 0;
function store(opts: { dedupSim?: number } = {}) {
  const dir = join(baseTmp, `run-${counter++}`);
  return { s: new VectorStore({ dedupSim: opts.dedupSim ?? 0.9, stateDir: dir }), dir };
}

// --- Phase 0: data-safety invariant ---------------------------------------

test("Phase 0: every added region retains a compressed-original and deletes nothing", () => {
  const { s, dir } = store();
  s.add({ sessionId: "sess_a", summary: "s1", regionText: "the quick brown fox jumps", tokenEstimate: 5, originalTokenEstimate: 50, timestamp: 1 });
  s.add({ sessionId: "sess_a", summary: "s2", regionText: "a totally different region of work", tokenEstimate: 6, originalTokenEstimate: 60, timestamp: 2 });
  const di = dataInvariantStats(dir);
  assert.equal(di.regionsRetained, 2, "both regions retained");
  assert.ok(di.compressedOriginalBytes > 0, "compressed-original bytes retained");
  assert.equal(di.bytesPermanentlyDeleted, 0, "INVARIANT: nothing permanently deleted");
});

test("Phase 0: dedup collapses a duplicate but original is still retained (not deleted)", () => {
  const { s, dir } = store();
  const text = "identical region content that will dedup on the second add";
  s.add({ sessionId: "sess_b", summary: "s", regionText: text, tokenEstimate: 5, originalTokenEstimate: 50, timestamp: 1 });
  const r2 = s.add({ sessionId: "sess_b", summary: "s", regionText: text, tokenEstimate: 5, originalTokenEstimate: 50, timestamp: 2 });
  assert.equal(r2.deduped, true, "second add deduped");
  const di = dataInvariantStats(dir);
  assert.equal(di.bytesPermanentlyDeleted, 0, "INVARIANT: dedup never deletes data");
  assert.ok(di.regionsRetained >= 1, "survivor region still retained");
});

// --- Phase 1: per-tier progress callback ----------------------------------

test("Phase 1: onTier fires L0→L1→L2→stored for a genuinely new region", () => {
  const { s } = store();
  // Seed one checkpoint so L2 has something to scan against.
  s.add({ sessionId: "sess_c", summary: "seed", regionText: "seed region alpha", timestamp: 1 });
  const events: Array<{ tier: string; status: string }> = [];
  s.add({
    sessionId: "sess_c",
    summary: "new",
    regionText: "a brand new region beta that is not a duplicate",
    timestamp: 2,
    onTier: (ev) => events.push({ tier: ev.tier, status: ev.status }),
  });
  const tiers = events.map((e) => e.tier);
  assert.ok(tiers.includes("L0"), "L0 fired");
  assert.ok(tiers.includes("L1"), "L1 fired");
  assert.ok(tiers.includes("L2"), "L2 fired");
  assert.equal(events.at(-1)?.tier, "new", "final event is the 'new' tier");
  assert.equal(events.at(-1)?.status, "stored", "final status is stored");
});

test("Phase 1: onTier reports a deduped outcome and short-circuits at the matching tier", () => {
  const { s } = store();
  const text = "region that will exact-dedup on the second pass";
  s.add({ sessionId: "sess_d", summary: "s", regionText: text, timestamp: 1 });
  const events: Array<{ tier: string; status: string; detail?: string }> = [];
  const r = s.add({
    sessionId: "sess_d",
    summary: "s",
    regionText: text,
    timestamp: 2,
    onTier: (ev) => events.push(ev),
  });
  assert.equal(r.deduped, true);
  const deduped = events.find((e) => e.status === "deduped");
  assert.ok(deduped, "a deduped event fired");
  assert.equal(deduped?.tier, "L0", "exact duplicate short-circuits at L0");
  // Must NOT reach the final stored event.
  assert.ok(!events.some((e) => e.status === "stored"), "no stored event on dedup");
});

test("Phase 1: onTier is optional (back-compat) — add() works without it", () => {
  const { s } = store();
  const r = s.add({ sessionId: "sess_e", summary: "s", regionText: "no callback here", timestamp: 1 });
  assert.equal(r.deduped, false);
});

process.on("exit", () => { try { rmSync(baseTmp, { recursive: true, force: true }); } catch { /* ignore */ } });
