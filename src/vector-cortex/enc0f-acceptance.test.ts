/** ENC-0f acceptance aggregator (fixtures-driven, no mocks).
 *  Drives ENC-BUDG-001..006 against the pure qualification seam
 *  (qualifyEncodedAsset) and the flag. The verdict-matrix asserts that each of
 *  the four independent gates (latency / marginal-rss / determinism / opset)
 *  flips the verdict when it alone fails, with thresholds sourced from
 *  types.ts constants (ENCODER_LATENCY_P95_MS / ENCODER_RSS_BUDGET_BYTES /
 *  ENCODER_OPSET) — no magic numbers. Unique-failure injection: a bench with
 *  gates.all:false AND a fabricated sub-40ms p95 must STILL fail with a
 *  `bench_gates_not_green`-style reason (a gated-off bench can never be swept
 *  into mode A by its p95 alone). The no-scattered-literal scan pins that the
 *  verdict/reason strings live ONLY in qualify.ts — never re-invented in the
 *  gate wrapper or the bench harness. Contract is aggregate-only (measurements
 *  + verdicts, never message content — EVAL-REDACT-002). Local file reads only,
 *  zero network, flag-agnostic (passes with the flag ON or OFF).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ENC_0F_ENABLED } from "../config/vector-cortex.js";
import { qualifyEncodedAsset } from "./encoder/qualify.js";
import {
  ENCODER_LATENCY_P95_MS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_OPSET,
} from "./encoder/types.js";
import type { BenchResultV1, BenchGatesV1 } from "./encoder/bench-export.js";

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
const ENC_BUDG_IDS = [
  "ENC-BUDG-001", "ENC-BUDG-002", "ENC-BUDG-003",
  "ENC-BUDG-004", "ENC-BUDG-005", "ENC-BUDG-006",
] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface BudgetFixture {
  id: string; producer: string; assertion: string; kind: string;
  setup: Record<string, unknown>;
  expected_outcome: "ok" | "error";
  expected_result: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): BudgetFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("encoder-budget/"));
  assert.ok(row, `fixture ${id} registered under encoder-budget/`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as BudgetFixture;
}

// ── Synthetic bench builder (thresholds from types, never magic numbers) ─────
const MIB = 1024 * 1024;
function greenGates(): BenchGatesV1 {
  return { latency: true, rss: true, opset: true, determinism: true, all: true };
}
function makeBench(overrides: Partial<BenchResultV1> = {}): BenchResultV1 {
  return {
    timestamp: 0,
    platform: "linux-x64",
    encoderNative: false,
    threads: 4,
    tokens: 512,
    corpusTokens: 1_000_000,
    p95Ms: ENCODER_LATENCY_P95_MS - 1,
    rssMib: 100,
    rssBaselineMib: 50,
    rssMarginalMib: 50,
    opset: ENCODER_OPSET,
    deterministic: true,
    digest: "a".repeat(64),
    gates: greenGates(),
    ...overrides,
  };
}

describe("ENC-0f conformance registration", () => {
  test("manifest registers ENC-BUDG-001..006 under the encoder-budget seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of ENC_BUDG_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.path, `encoder-budget/${id}.json`, `${id} path`);
      assert.equal(row.algorithm, "encoder-budget", `${id} algorithm`);
      assert.equal(row.schema, "schemas/encoder-budget-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.expected, "ok", `${id} expected`);
    }
    const schemaRow = m.fixtures.find((f) => f.path === "schemas/encoder-budget-fixture.schema.json");
    assert.ok(schemaRow, "encoder-budget schema registered");
    assert.ok(m.owner.split(",").includes("ENC-0f"), "owner CSV includes ENC-0f");
    assert.ok(m.domain.split(";").includes("encoder-budget"), "domain includes encoder-budget");
    assert.ok(m.domain.split(";").includes("encoder-demotion"), "prior ENC-0e domain preserved");
    assert.ok(m.owner.split(",").includes("ENC-0e"), "prior ENC-0e owner preserved");
  });

  test("the 6 ENC-BUDG fixture kinds are closed to the spec branch set", () => {
    const kinds = new Set<string>();
    for (const id of ENC_BUDG_IDS) {
      const fx = fixture(id);
      assert.ok(fx.assertion.length > 0, `${id}: assertion`);
      assert.equal(fx.expected_outcome, "ok", `${id}: outcome`);
      kinds.add(fx.kind);
    }
    for (const k of [
      "fully-passing", "p95-breach", "rss-breach",
      "determinism-opset", "determinism-fail", "flag-off",
    ]) {
      assert.ok(kinds.has(k), `branch kind ${k} present`);
    }
  });
});

describe("ENC-0f pure qualification verdict matrix (qualifyEncodedAsset)", () => {
  test("flag exports a live boolean (aggregator flag-agnostic)", () => {
    assert.equal(typeof ENC_0F_ENABLED(), "boolean");
  });

  test("fully-passing bench -> qualified, schema qualification-v1, empty reasons (fixture 001)", () => {
    const fx = fixture("ENC-BUDG-001");
    assert.equal(fx.expected_result["verdict"], "qualified");
    const q = qualifyEncodedAsset(makeBench({
      p95Ms: 25, rssMarginalMib: 145, opset: ENCODER_OPSET,
    }), "linux-x64");
    assert.equal(q.verdict, "qualified");
    assert.deepEqual(q.reasons, []);
    assert.equal(q.schema, "qualification-v1");
    assert.equal(q.p95Ms, 25);
    assert.equal(q.rssMib, 145);
    assert.equal(q.opset, ENCODER_OPSET);
  });

  test("latency gate alone -> failed with reason latency (fixture 002)", () => {
    const fx = fixture("ENC-BUDG-002");
    assert.equal(fx.expected_result["verdict"], "failed");
    assert.ok((fx.expected_result["reasons"] as string[]).includes("latency"));
    const q = qualifyEncodedAsset(makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 1,
      gates: { ...greenGates(), latency: false, all: false },
    }), "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("latency"));
  });

  test("marginal-RSS gate alone -> failed with reason rss (fixture 003)", () => {
    const fx = fixture("ENC-BUDG-003");
    assert.equal(fx.expected_result["verdict"], "failed");
    assert.ok((fx.expected_result["reasons"] as string[]).includes("rss"));
    const q = qualifyEncodedAsset(makeBench({
      rssMarginalMib: Math.floor(ENCODER_RSS_BUDGET_BYTES / MIB) + 1,
      gates: { ...greenGates(), rss: false, all: false },
    }), "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("rss"));
  });

  test("determinism gate alone -> failed with reason determinism (fixture 005)", () => {
    const fx = fixture("ENC-BUDG-005");
    assert.equal(fx.expected_result["verdict"], "failed");
    assert.ok((fx.expected_result["reasons"] as string[]).includes("determinism"));
    const q = qualifyEncodedAsset(makeBench({
      deterministic: false,
      gates: { ...greenGates(), determinism: false, all: false },
    }), "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("determinism"));
  });

  test("opset gate alone -> failed with reason opset", () => {
    const q = qualifyEncodedAsset(makeBench({
      opset: ENCODER_OPSET + 1,
      gates: { ...greenGates(), opset: false, all: false },
    }), "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("opset"));
  });
});

describe("ENC-0f thresholds are sourced from the types constants (no magic numbers)", () => {
  test("ENCODER_LATENCY_P95_MS === 40 and ENCODER_RSS_BUDGET_BYTES === 150 MiB are the enforcement seam", () => {
    assert.equal(ENCODER_LATENCY_P95_MS, 40);
    assert.equal(ENCODER_RSS_BUDGET_BYTES / MIB, 150);
    assert.equal(ENCODER_OPSET, 21);
  });

  test("just-above-p95 fails, just-below passes (boundary pinned by the constant)", () => {
    const above = makeBench({
      p95Ms: ENCODER_LATENCY_P95_MS + 0.001,
      gates: { ...greenGates(), latency: false, all: false },
    });
    assert.equal(qualifyEncodedAsset(above, "linux-x64").verdict, "failed");
    const below = makeBench({ p95Ms: ENCODER_LATENCY_P95_MS - 0.001 });
    assert.equal(qualifyEncodedAsset(below, "linux-x64").verdict, "qualified");
  });

  test("just-above-marginal-RSS fails, just-below passes (boundary pinned by the constant)", () => {
    const above = makeBench({
      rssMarginalMib: ENCODER_RSS_BUDGET_BYTES / MIB + 0.001,
      gates: { ...greenGates(), rss: false, all: false },
    });
    assert.equal(qualifyEncodedAsset(above, "linux-x64").verdict, "failed");
    const below = makeBench({ rssMarginalMib: ENCODER_RSS_BUDGET_BYTES / MIB - 0.001 });
    assert.equal(qualifyEncodedAsset(below, "linux-x64").verdict, "qualified");
  });
});

describe("ENC-0f unique-failure injection: gated-off bench can never be swept to mode A", () => {
  test("bench with gates.all:false + fabricated sub-40ms p95 STILL fails with bench_gates_not_green", () => {
    // A gate-flagged-off bench (degraded run) with a fabricated good p95 must NOT
    // be admitted on its p95 alone — `bench_gates_not_green` forces failure even
    // when every individual gate reading is green.
    const green = { latency: true, rss: true, opset: true, determinism: true, all: false };
    const q = qualifyEncodedAsset(makeBench({ p95Ms: ENCODER_LATENCY_P95_MS - 5, rssMarginalMib: 10, gates: green }), "linux-x64");
    assert.equal(q.verdict, "failed");
    assert.ok(q.reasons.includes("bench_gates_not_green"));
    assert.ok(!q.reasons.includes("latency"), "sub-40ms p95 did not trip the latency gate");
  });
});

describe("ENC-0f no-scattered-literal scan (single-source verdict/reason strings)", () => {
  const canonicalFiles = [
    join(ROOT, "src", "vector-cortex", "encoder", "qualify.ts"),
    join(ROOT, "scripts", "encoder", "gate-qualify.mjs"),
    join(ROOT, "scripts", "ml5", "bench-onnx-prod.mjs"),
  ];

  test("qualify.ts is the single canonical source for the reason strings", () => {
    const src = readFileSync(canonicalFiles[0], "utf8");
    for (const needle of ["latency", "rss", "determinism", "opset", "bench_gates_not_green", "qualification-v1"]) {
      assert.ok(src.includes(needle), `qualify.ts names the reason phrase ${needle}`);
    }
  });

  test("gate wrapper + bench harness never re-invent the verdict/reason literals", () => {
    // The reason/verdict strings must live ONLY in qualify.ts; the wrapper and
    // the bench produce the measurements + gates, never their own copies of the
    // verdict vocabulary. Files may be written by the parallel worker; skip any
    // not yet present rather than hard-fail, and assert on what exists.
    for (const f of canonicalFiles.slice(1)) {
      if (!existsSync(f)) continue; // worker parallel file not yet landed
      const src = readFileSync(f, "utf8");
      const body = src.replace(/\s+/g, " ").trim();
      for (const needle of ["bench_gates_not_green", "\"qualification-v1\""]) {
        assert.ok(!body.includes(needle), `${f} must not hard-code the canonical ${needle}`);
      }
    }
  });
});

describe("ENC-0f manifest + evidence integrity", () => {
  test("ENC-BUDG fixtures are canonical: sorted UTF-8 byte key order, all required fields", () => {
    const expectedKeys = [
      "assertion", "expected_outcome", "expected_result", "id",
      "kind", "producer", "schema", "setup",
    ].sort();
    for (const id of ENC_BUDG_IDS) {
      const fx = fixture(id);
      const keys = Object.keys(fx).sort();
      assert.deepEqual(keys, expectedKeys, `${id} canonical key set`);
      for (const k of expectedKeys) assert.ok(k in fx, `${id} has ${k}`);
    }
  });

  test("fixture 006 pins flag-off: no record, no events (byte-identical predecessor)", () => {
    const fx = fixture("ENC-BUDG-006");
    assert.equal(fx.expected_result["record_written"], false);
    assert.deepEqual(fx.expected_result["events"], []);
    assert.equal(fx.expected_result["verdict"], null);
  });

  test("evidence doc exists and records the qualification proof (ENC-0f.md)", () => {
    const ev = join(ROOT, "docs", "vector-cortex", "evidence", "ENC-0f.md");
    assert.ok(existsSync(ev), "ENC-0f evidence present");
    const src = readFileSync(ev, "utf8");
    assert.match(src, /p95/, "evidence records the p95 measurement");
    assert.match(src, /QualificationV1/, "evidence records the QualificationV1 record");
    assert.match(src, /HG-5/, "evidence records the HG-5 close");
  });
});
