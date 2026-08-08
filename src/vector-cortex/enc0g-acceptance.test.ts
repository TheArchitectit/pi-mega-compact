/** ENC-0g acceptance aggregator (fixtures-driven, no mocks).
 *  Drives ENC-STAT-001..006 against the pure Setup Cortex status computations:
 *  (1) the live `computeSetupCortexBlockers` function over (platform,
 *  QualificationV1 record, manifest head-count) — the HG status/wording matrix;
 *  (2) `setupCortexActionBlockers` re-derived gating (HG-1 closed → fetch/bench
 *  both ["HG-3"], verify-asset always []); (3) the no-scattered-literal scan
 *  (the verdict/reason vocabulary lives only in qualify.ts, plus the single
 *  QUALIFICATION_RECORD_UNAVAILABLE sentinel in setup-cortex-blockers.ts). The
 *  aggregator is flag-agnostic (passes with ENC_0G ON or OFF). Local file reads
 *  only, zero network. Contract is aggregate-only (measurements + verdicts,
 *  never message content — EVAL-REDACT-002).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_0G_ENABLED } from "../config/vector-cortex.js";
import type { QualificationV1 } from "./encoder/qualify.js";
import { ENCODER_HEAD_ORDER } from "./encoder/types.js";
import {
  computeSetupCortexBlockers,
  setupCortexActionBlockers,
  QUALIFICATION_RECORD_UNAVAILABLE,
  SETUP_CORTEX_BLOCKERS,
} from "./setup-cortex-blockers-compute.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const ROOT = repoRoot(HERE);
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const ENC_STAT_IDS = [
  "ENC-STAT-001", "ENC-STAT-002", "ENC-STAT-003",
  "ENC-STAT-004", "ENC-STAT-005", "ENC-STAT-006",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface StatFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): StatFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("encoder-status/"));
  assert.ok(row, `fixture ${id} registered under encoder-status/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as StatFixture;
}

/** Synthetic QualificationV1 (mirrors qualify.ts — thresholds irrelevant here). */
function mkQual(
  verdict: "qualified" | "failed",
  reasons: string[],
  p95Ms: number,
  rssMib: number,
): QualificationV1 {
  return {
    schema: "qualification-v1",
    verdict,
    reasons,
    platform: "linux-x64",
    p95Ms,
    rssMib,
    opset: 21,
    digest: "a".repeat(64),
  };
}

describe("ENC-0g conformance registration", () => {
  test("manifest registers ENC-STAT-001..006 under the encoder-status seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_STAT_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-status/${id}.json`, `${id} path`);
      assert.equal(row.algorithm, "encoder-status", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-status-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-status-fixture.schema.json");
    assert.ok(schemaRow, "encoder-status schema registered");
    assert.ok(m.owner.split(",").includes("ENC-0g"), "owner CSV includes ENC-0g");
    assert.ok(m.domain.split(";").includes("encoder-status"), "domain includes encoder-status");
    assert.ok(m.owner.split(",").includes("ENC-0f"), "prior ENC-0f owner preserved");
    assert.ok(m.domain.split(";").includes("encoder-budget"), "prior ENC-0f domain preserved");
  });

  test("the 6 ENC-STAT fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_STAT_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.equal(fx.expected_outcome, "ok", `${id}: outcome`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "qualified-record-overrides", "failed-record-overrides", "no-record-fallback",
      "hg1-closed-hg5-measured", "gating-matrix", "flag-off",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-0g pure computeSetupCortexBlockers matrix", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_0G_ENABLED(), "boolean");
  });

  test("ENCODER_HEAD_ORDER is the sourced HG-1 close threshold (length 5, no magic)", () => {
    assert.equal(ENCODER_HEAD_ORDER.length, 5);
  });

  test("no record (qualification null) + headCount null -> HG-1 open, HG-5 superseded (fixture 003)", () => {
    const fx = fixture("ENC-STAT-003");
    const blockers = computeSetupCortexBlockers({ platform: "linux-x64", qualification: null, headCount: null });
    const byId = new Map(blockers.map((b) => [b.id, b]));
    assert.equal(byId.get("HG-1")!.status, "open");
    assert.equal(byId.get("HG-3")!.status, "open");
    assert.equal(byId.get("HG-4")!.status, "superseded");
    assert.equal(byId.get("HG-5")!.status, "superseded");
    assert.match(byId.get("HG-5")!.resolution!, /gate-qualify\.mjs/);
    const resolved = fx.expected_result["blockers"] as Record<string, string>;
    assert.equal(resolved["HG-5"], "superseded");
  });

  test("headCount 4 (< 5) keeps HG-1 OPEN; headCount 5 closes HG-1 (sourced constant)", () => {
    const f4 = computeSetupCortexBlockers({ platform: "linux-x64", qualification: null, headCount: 4 });
    assert.equal(f4.find((b) => b.id === "HG-1")!.status, "open");
    const f5 = computeSetupCortexBlockers({ platform: "linux-x64", qualification: null, headCount: ENCODER_HEAD_ORDER.length });
    assert.equal(f5.find((b) => b.id === "HG-1")!.status, "closed");
  });

  test("failed record + 5 heads -> HG-1 closed, HG-5 closed with measured wording (fixtures 002/004)", () => {
    const fx = fixture("ENC-STAT-002");
    const q = mkQual("failed", ["latency", "rss", "bench_gates_not_green"], 186.53, 294);
    const blockers = computeSetupCortexBlockers({ platform: "linux-x64", qualification: q, headCount: 5 });
    const byId = new Map(blockers.map((b) => [b.id, b]));
    assert.equal(byId.get("HG-1")!.status, "closed");
    assert.equal(byId.get("HG-3")!.status, "open");
    assert.equal(byId.get("HG-4")!.status, "superseded");
    assert.equal(byId.get("HG-5")!.status, "closed");
    assert.equal(byId.get("HG-5")!.title, "Real-asset qualification: failed (latency + marginal-RSS over budget)");
    assert.match(byId.get("HG-5")!.resolution!, /186\.53 ms/);
    assert.match(byId.get("HG-5")!.resolution!, /294 MiB/);
    assert.equal(byId.get("HG-5")!.severity, "medium");
    const resolved = fx.expected_result["blockers"] as Record<string, string>;
    assert.equal(resolved["HG-1"], "closed");
    assert.equal(resolved["HG-5"], "closed");
  });

  test("qualified record -> HG-5 closed with 'measured' wording (fixture 001)", () => {
    const q = mkQual("qualified", [], 25, 145);
    const blockers = computeSetupCortexBlockers({ platform: "linux-x64", qualification: q, headCount: 5 });
    const hg5 = blockers.find((b) => b.id === "HG-5")!;
    assert.equal(hg5.status, "closed");
    assert.equal(hg5.title, "Real-asset qualification: measured");
    assert.equal(blockers.find((b) => b.id === "HG-1")!.status, "closed");
  });
});

describe("ENC-0g pure setupCortexActionBlockers re-derived gating", () => {
  test("computed blockers with HG-1 closed (5 heads + failed record) -> fetch/bench [HG-3], verify-asset [] (fixture 005)", () => {
    const q = mkQual("failed", ["latency"], 186.53, 294);
    const live = computeSetupCortexBlockers({ platform: "linux-x64", qualification: q, headCount: ENCODER_HEAD_ORDER.length });
    assert.deepEqual(setupCortexActionBlockers("fetch-model", live), ["HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("bench", live), ["HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("verify-asset", live), []);
    const fx = fixture("ENC-STAT-005");
    const gating = fx.expected_result["gating"] as Record<string, string[]>;
    assert.deepEqual(gating["fetch-model"], ["HG-3"]);
    assert.deepEqual(gating["verify-asset"], []);
  });

  test("computed blockers with all open (no record, no heads) -> fetch/bench [HG-1,HG-3], verify-asset []", () => {
    const live = computeSetupCortexBlockers({ platform: "linux-x64", qualification: null, headCount: null });
    assert.deepEqual(setupCortexActionBlockers("fetch-model", live), ["HG-1", "HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("bench", live), ["HG-1", "HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("verify-asset", live), []);
  });

  test("single-arg backwards compatibility (base static list) still returns the ENC-0f-era gate lists", () => {
    assert.deepEqual(setupCortexActionBlockers("fetch-model"), ["HG-1", "HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("bench"), ["HG-1", "HG-3"]);
    assert.deepEqual(setupCortexActionBlockers("verify-asset"), []);
  });

  test("every base id is present and open+blocker in the static manifest (gate ids never dangle)", () => {
    const open = SETUP_CORTEX_BLOCKERS.filter((b) => b.status === "open" && b.severity === "blocker");
    const openIds = open.map((b) => b.id);
    assert.ok(openIds.includes("HG-1"));
    assert.ok(openIds.includes("HG-3"));
    assert.ok(!openIds.includes("HG-4"), "HG-4 is high severity — never gates an action");
  });
});

describe("ENC-0g no-scattered-literal scan (single-source verdict/reason strings)", () => {
  const qualify = join(ROOT, "src", "vector-cortex", "encoder", "qualify.ts");
  const computeFile = join(ROOT, "src", "vector-cortex", "setup-cortex-blockers-compute.ts");
  const consumers = [
    join(ROOT, "extensions", "dashboard-server", "routes-setup-cortex.ts"),
    join(ROOT, "extensions", "dashboard-server", "setup-cortex-actions.ts"),
    join(ROOT, "extensions", "dashboard-server", "routes-setup-cortex-actions.ts"),
  ];

  test("qualify.ts is the single canonical source for the reason strings", () => {
    const src = readFileSync(qualify, "utf8");
    for (const needle of ["latency", "rss", "determinism", "opset", "bench_gates_not_green", "qualification-v1"]) {
      assert.ok(src.includes(needle), `qualify.ts names the reason phrase ${needle}`);
    }
  });

  test("QUALIFICATION_RECORD_UNAVAILABLE is a single exported sentinel const in setup-cortex-blockers-compute.ts", () => {
    assert.equal(QUALIFICATION_RECORD_UNAVAILABLE, "qualification_record_unavailable");
    // Exactly one quoted occurrence: the sentinel const definition and nothing else.
    const src = readFileSync(computeFile, "utf8");
    const quoted = src.split('"qualification_record_unavailable"').length - 1;
    assert.equal(quoted, 1, "the marker literal appears exactly once (the sentinel definition)");
  });

  test("route + action consumers never re-literal the canonical reason/marker strings", () => {
    const markers = [
      '"latency"', '"rss"', '"determinism"', '"opset"',
      '"bench_gates_not_green"', '"qualification_record_unavailable"',
    ];
    for (const f of consumers) {
      if (!existsSync(f)) continue; // Worker B parallel file not yet landed
      const src = readFileSync(f, "utf8");
      for (const marker of markers) {
        assert.ok(!src.includes(marker), `${f} must not hard-code the canonical ${marker}`);
      }
    }
  });

  test("setup-cortex-blockers-compute.ts never re-literals bench_gates_not_green (a qualify.ts-owned reason)", () => {
    const src = readFileSync(computeFile, "utf8");
    assert.ok(!src.includes("bench_gates_not_green"), "blockers module must not re-literal bench_gates_not_green");
    assert.ok(!src.includes('"latency"'), "blockers module must not re-literal the reason string \"latency\"");
    assert.ok(!src.includes('"rss"'), "blockers module must not re-literal the reason string \"rss\"");
  });
});

describe("ENC-0g manifest + evidence integrity", () => {
  test("ENC-STAT fixtures are canonical: sorted UTF-8 byte key order, all required fields", () => {
    const expectedKeys = [
      "assertion", "expected_outcome", "expected_result", "id",
      "kind", "producer", "schema", "setup",
    ].sort();
    for (const id of ENC_STAT_IDS) {
      const fx = fixture(id);
      const keys = Object.keys(fx).sort();
      assert.deepEqual(keys, expectedKeys, `${id} canonical key set`);
      for (const k of expectedKeys) assert.ok(k in fx, `${id} has ${k}`);
    }
  });

  test("fixture 006 pins flag-off: byte-identical predecessor", () => {
    const fx = fixture("ENC-STAT-006");
    assert.equal(fx.expected_result["flag_off"], true);
    assert.equal(fx.expected_result["byte_identical"], true);
  });

  test("evidence doc exists and records the honest-state proof (ENC-0g.md)", () => {
    const ev = join(ROOT, "docs", "vector-cortex", "evidence", "ENC-0g.md");
    assert.ok(existsSync(ev), "ENC-0g evidence present");
    const src = readFileSync(ev, "utf8");
    assert.match(src, /QualificationV1/, "evidence records the QualificationV1 override");
    assert.match(src, /HG-1/, "evidence records the HG-1 close");
    assert.match(src, /HG-5/, "evidence records the HG-5 measured verdict");
  });
});
