/**
 * sprint14.test.ts — Sprint 14 full-pipeline wiring (flags, backfill, monitoring, canary).
 * Hermetic: isolated state dirs, no network, no remote.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./vectorStore.js";
import { defaultEmbedder } from "./embedder.js";
import { loadDedupConfig, type DedupConfigShape } from "./config/dedup.js";
import {
  loadMetrics,
  saveMetrics,
  recordDecision,
  evaluateAlerts,
  fpRate,
  p95,
  type DedupMetrics,
} from "./monitoring.js";
import { backfillPhase, backfillRaptor } from "./store/backfill.js";
import { listCheckpoints, closeStore } from "./store/sqlite.js";
import { CanaryController, runCanary } from "./canary.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-s14-"));

function cfg(over: Partial<DedupConfigShape> = {}): DedupConfigShape {
  return { ...loadDedupConfig(), ...over };
}

function store(over: Partial<DedupConfigShape> = {}, eventsPath?: string): VectorStore {
  const dir = join(baseTmp, `run-${Math.floor(performance.now() * 1000)}-${Math.random()}`);
  return new VectorStore({ stateDir: dir, config: cfg(over), eventsPath });
}

// --- 1. Flag matrix: 16 combos don't crash add()/search() -------------------

test("flag matrix: all 16 L0/L1/L2/RAPTOR enable combos are safe", () => {
  const flags = [false, true];
  let combos = 0;
  for (const l0 of flags)
    for (const l1 of flags)
      for (const l2 of flags)
        for (const raptor of flags) {
          combos++;
          const s = store({ L0_ENABLED: l0, L1_ENABLED: l1, L2_ENABLED: l2, RAPTOR_ENABLED: raptor });
          s.add({ sessionId: "s", summary: "x", regionText: `region A for combo ${combos} about the cache`, timestamp: 1 });
          const r2 = s.add({ sessionId: "s", summary: "x", regionText: `region B for combo ${combos} about the parser`, timestamp: 2 });
          // search must not throw under any combination
          const hits = s.search("s", "cache", 3);
          assert.ok(Array.isArray(hits));
          // With all tiers off, the second add is always "new" (no collapse).
          if (!l0 && !l1 && !l2) assert.equal(r2.deduped, false);
        }
  assert.equal(combos, 16);
});

// --- 2. MARK_ONLY_L1 records but doesn't collapse ---------------------------

test("MARK_ONLY_L1: L1 match is recorded but not collapsed (new checkpoint)", () => {
  // Disable L2 so we isolate L1 behavior (L2 cosine would otherwise catch the near-dup).
  const s = store({ L1_ENABLED: true, MARK_ONLY_L1: true, L2_ENABLED: false });
  const a = s.add({ sessionId: "s", summary: "x", regionText: "the parser optimized the hot loop", timestamp: 1 });
  const b = s.add({ sessionId: "s", summary: "x", regionText: "the parser optimized the hot loops", timestamp: 2 });
  assert.equal(a.deduped, false);
  // MARK_ONLY → b is NOT collapsed into a; both stored as active.
  assert.equal(b.deduped, false);
  const all = listCheckpoints("s", (s as any).stateDir);
  assert.equal(all.length, 2);
  assert.ok(all.every((c) => c.dedupStatus === "active"));
});

test("MARK_ONLY_L1 off: L1 match IS collapsed", () => {
  const s = store({ L1_ENABLED: true, MARK_ONLY_L1: false });
  s.add({ sessionId: "s", summary: "x", regionText: "the parser optimized the hot loop", timestamp: 1 });
  const b = s.add({ sessionId: "s", summary: "x", regionText: "the parser optimized the hot loops", timestamp: 2 });
  assert.equal(b.deduped, true);
  assert.equal(b.reason, "l1MinHash");
});

// --- 3. Backfill resumes after interrupt -------------------------------------

test("backfill L1 resumes after simulated interrupt", () => {
  const dir = join(baseTmp, `bf-${Math.floor(performance.now())}`);
  // Seed 12 checkpoints, 2 per batch of 5.
  const s = new VectorStore({ stateDir: dir, config: cfg() });
  const texts = [
    "The walrus drifted past the lighthouse while the baker kneaded sourdough at dawn",
    "Quantum entanglement linked the two photons across the lab in a cryogenic chamber",
    "A medieval scribe copied the gospel by candlelight atop a windswept cliff",
    "The rover sampled basalt from the crater and transmitted spectra to mission control",
    "Jazz musicians improvised a syncopated triangle rhythm beneath the streetlamp",
    "The glacier calved a towering iceberg into the fjord with a thunderous crack",
    "A botanist cataloged the orchid species thriving in the cloud forest canopy",
    "The blacksmith forged a horseshoe while sparks danced across the anvil",
    "Astronomers imaged a distant nebula glowing with newborn stellar furnaces",
    "The ferry crossed the strait as gulls wheeled above the churning wake",
    "A weaver threaded crimson silk through the loom in the mountain village",
    "The surgeon sutured the incision with steady hands under the theatre lights",
  ];
  for (let i = 0; i < 12; i++) {
    s.add({ sessionId: "sess_bf", summary: `n${i}`, regionText: texts[i], timestamp: i });
  }
  // Interrupt after batch 1 (5 rows).
  const r1 = backfillPhase("L1", "sess_bf", dir, { batchSize: 5, interruptAfterBatches: 1 });
  assert.equal(r1.interrupted, true);
  assert.equal(r1.processed, 5);
  assert.ok(r1.cursor === "chkpt_005" || r1.cursor === "chkpt_05");
  // Resume: should continue from the cursor → process the remaining 7.
  const r2 = backfillPhase("L1", "sess_bf", dir, { batchSize: 5 });
  assert.equal(r2.interrupted, false);
  assert.equal(r2.processed, 12); // total across both runs (cursor-based resume)
  closeStore(dir);
});

// --- 4. Alert fires on injected FP spike -------------------------------------

test("alert: FP spike breaches threshold → MARK_ONLY flagged + warning", () => {
  const config = cfg();
  const m: DedupMetrics = loadMetrics("/dev/null");
  // Inject 100 L1 decisions, 20 false positives → 20% > FP_RATE_L1L2 (5%).
  for (let i = 0; i < 100; i++) {
    recordDecision(m, "L1", i < 20 ? "deduped" : "new", 5, i < 20);
  }
  const res = evaluateAlerts(m, config);
  assert.ok(res.breached.includes("L1"));
  assert.ok(res.warnings.some((w) => w.includes("DEDUP FP BREACH tier=L1")));
  assert.ok(fpRate(m, "L1") > config.FP_RATE_L1L2);
});

test("alert: clean run does NOT breach", () => {
  const config = cfg();
  const m = loadMetrics("/dev/null");
  for (let i = 0; i < 100; i++) recordDecision(m, "L1", "new", 5, false);
  const res = evaluateAlerts(m, config);
  assert.equal(res.breached.length, 0);
});

// --- 5. Canary auto-disables a tier whose p95 exceeds budget ---------------

test("canary: auto-disables a tier whose p95 exceeds budget", () => {
  // Feed where L2 always has high latency (breaches P95_BUDGET_MS).
  const feed = (_step: number, c: DedupConfigShape): DedupMetrics => {
    const m = loadMetrics("/dev/null");
    if (c.L0_ENABLED) recordDecision(m, "L0", "new", 1, false);
    if (c.L1_ENABLED) recordDecision(m, "L1", "new", 1, false);
    if (c.L2_ENABLED) recordDecision(m, "L2", "new", 500, false); // > 100ms budget
    if (c.RAPTOR_ENABLED) recordDecision(m, "RAPTOR", "new", 1, false);
    return m;
  };
  const { controller, disabled } = runCanary(feed, cfg({ P95_BUDGET_MS: 100 }));
  assert.ok(disabled.includes("L2"), `expected L2 auto-disabled, got ${JSON.stringify(disabled)}`);
  assert.equal(controller.config.L2_ENABLED, false);
  // Lower tiers should still be enabled.
  assert.equal(controller.config.L0_ENABLED, true);
});

test("canary: sequential enablement order L0→L1→L2→RAPTOR", () => {
  const c = new CanaryController(cfg());
  assert.deepEqual([...c.getState().enabled], ["L0"]);
  const t1 = c.stepForward();
  assert.equal(t1, "L1");
  assert.equal(c.stepForward(), "L2");
  assert.equal(c.stepForward(), "RAPTOR");
  assert.equal(c.stepForward(), null); // all enabled
});

// --- 6. Monitoring: structured decision events written ----------------------

test("monitoring: add() writes structured decision events to events.log", () => {
  const dir = join(baseTmp, `mon-${Math.floor(performance.now())}`);
  const eventsPath = join(dir, "events.log");
  const s = new VectorStore({
    stateDir: dir,
    config: cfg(),
    eventsPath,
  });
  s.add({ sessionId: "s", summary: "x", regionText: "unique region alpha one", timestamp: 1 });
  s.add({ sessionId: "s", summary: "x", regionText: "unique region alpha one", timestamp: 2 }); // L0 content dup
  assert.ok(existsSync(eventsPath));
  const lines = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2);
  const ev = JSON.parse(lines[0]);
  assert.ok(["L0"].includes(ev.tier));
  assert.ok(["new", "deduped", "mark_only"].includes(ev.result));
  closeStore(dir);
});

// --- 7. RAPTOR backfill builds + persists a tree ---------------------------

test("backfill RAPTOR builds + persists a tree for a session", () => {
  const dir = join(baseTmp, `raptorbf-${Math.floor(performance.now())}`);
  const s = new VectorStore({ stateDir: dir, config: cfg() });
  const texts = [
    "The whale breached beside the research vessel near the polar ice shelf",
    "A potter shaped the clay vessel on the spinning wheel at the riverside studio",
    "The comet streaked across the pre dawn sky witnessed by the hilltop observatory",
    "Lumberjacks felled the ancient cedar while the river carried the logs downstream",
    "The chemist titrated the solution until the indicator turned faint violet",
    "A flock of cranes migrated northward over the thawing wetland at first light",
    "The locksmith picked the stubborn tumbler and opened the oak cabinet",
    "Geologists hammered the schist sample from the canyon wall into the satchel",
    "The chocolatier tempered the couverture until it snapped with a clean gloss",
    "A fisher cast the line into the mist where the trout rose to the fly",
    "The archivist unsealed the parchment scroll recovered from the coastal ruin",
    "Beekeepers harvested the golden comb while the orchard blossoms drifted down",
    "The pilot navigated the canyon winds using only the instrument panel glow",
    "A tailor stitched the velvet cuff with silk thread by the window",
    "The miner extracted the quartz crystal from the vein deep in the shaft",
    "Cartographers plotted the uncharted island onto the worn leather map",
    "The gardener pruned the rosebush and tied the canes to the cedar trellis",
    "A violinist tuned the gut strings until the chamber rang pure and bright",
    "The diver surfaced with the amphora lifted from the sunken galleon",
    "Shepherds guided the flock across the high pasture toward the stone bothy",
  ];
  for (let i = 0; i < 20; i++) {
    s.add({ sessionId: "sess_rb", summary: `n${i}`, regionText: texts[i], timestamp: i });
  }
  const res = backfillRaptor("sess_rb", dir, defaultEmbedder());
  assert.ok(res.processed > 0);
  // Sanity: source checkpoints remain intact (backfill is additive).
  const nodes = listCheckpoints("sess_rb", dir).length;
  assert.ok(nodes >= 20);
  closeStore(dir);
});

// --- 8. dashboard.json metrics round-trip -----------------------------------

test("metrics: dashboard.json persists + p95 computed", () => {
  const path = join(baseTmp, `dash-${Math.floor(performance.now())}.json`);
  const m = loadMetrics(path);
  for (let i = 0; i < 10; i++) recordDecision(m, "L2", "new", i * 10, false);
  saveMetrics(path, m);
  const reloaded = loadMetrics(path);
  assert.equal(reloaded.decisions.L2, 10);
  assert.equal(p95(reloaded.latency.L2), 90); // 95th pct of [0,10,..,90]
});

// --- cleanup ----------------------------------------------------------------

test("Sprint 14 cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
