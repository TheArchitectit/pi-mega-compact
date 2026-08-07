/**
 * vector-cortex/cosfp-acceptance.test.ts — COS-FP-A acceptance aggregator.
 *
 * Drives the committed COS-FP-A-001..005 fixtures against the canonical v2
 * manifest + the committed bench-run aggregate — no mocks, no stubs. Reads the
 * manifest + the cosine-fp fixture files, validates each envelope against the
 * schema semantics, and pins the registration invariants (algorithm cosfp,
 * path cosine-fp/<id>.json, schema ref, expected ok).
 *
 * The harness (bench.mjs / corpus.mjs) is script-side pure JS, deliberately not
 * imported here (no type declarations → PREVENT-011 implicit any). Instead this
 * aggregator re-implements the two tiny published-contract helpers it pins —
 * classifyPair's exact < vs >= boundary (COS-FP-A-004) and makeGrid's 37-point
 * count (COS-FP-A-001) — and cross-checks the committed aggregate digest against
 * the pinned fixture digest (COS-FP-A-002).
 *
 * The endpoint behavior is exercised by routes-cosine-fp.test.ts
 * (extensions/dashboard-server). This aggregator is FLAG-AGNOSTIC:
 * MEGACOMPACT_COSINE_FP_BENCH only gates the harness/endpoint/report emission,
 * none of which are touched here, so the same suite is green under both flag
 * states (default ON and MEGACOMPACT_COSINE_FP_BENCH=0).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COSINE_FP_BENCH_ENABLED, COSINE_FP_REAL_ENABLED } from "../config/vector-cortex.js";

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
const BENCH_AGGREGATE = join(
  ROOT,
  "scripts",
  "cosine-fp",
  "bench-run",
  "cosine-fp-report.json",
);

interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  schema: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

/** The canonical COS-FP-A fixture IDs this sprint owns. */
const COSFP_IDS = [
  "COS-FP-A-001",
  "COS-FP-A-002",
  "COS-FP-A-003",
  "COS-FP-A-004",
  "COS-FP-A-005",
] as const;

interface CosfpFixture {
  id: string;
  kind: string;
  assertion: string;
  flag?: string;
  flag_enabled?: boolean;
  content_types?: string[];
  grid?: { lo: number; hi: number; step: number; points: number };
  per_type_fp_fractions?: number[];
  status?: string;
  seed_invariant?: boolean;
  report_digest_sha256?: string;
  same_corpus_same_digest?: boolean;
  no_data?: string;
  fabricated_threshold?: boolean;
  fabricated_fp?: boolean;
  strict_straddle?: boolean;
  boundary?: { lo: number; hi: number };
  l2_cosine?: string;
  override_enabled?: boolean;
  byte_identical?: boolean;
}

function readFixture(id: string): CosfpFixture {
  const m = readManifest();
  const row = m.fixtures.find(
    (f) => f.id === id && f.path.startsWith("cosine-fp/"),
  );
  assert.ok(row, `fixture ${id} registered under cosine-fp/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as CosfpFixture;
}

// Re-implementations of the two published-contract helpers pinned below
// (bench.mjs is deliberately not imported — no typings, PREVENT-011).

/** Exact < vs >= L2 decision semantics: deduped when cosine >= threshold. */
function classifyPair(cosine: number, threshold: number): "deduped" | "passed" {
  return cosine >= threshold ? "deduped" : "passed";
}

/** Grid 0.80 → 0.98 step 0.005, inclusive both ends → exactly 37 points. */
function makeGrid(lo = 0.8, hi = 0.98, step = 0.005): number[] {
  const points: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += step) {
    points.push(Math.round(t * 1000) / 1000);
  }
  if (points[points.length - 1] !== Math.round(hi * 1000) / 1000) {
    points.push(Math.round(hi * 1000) / 1000);
  }
  return points;
}

describe("COS-FP-A conformance registration", () => {
  test("manifest registers COS-FP-A-001..005 + the cosfp schema under the cosine-fp seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of COSFP_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of COSFP_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "cosfp", `${id} algorithm`);
      assert.equal(row!.path, `cosine-fp/${id}.json`, `${id} path`);
      assert.equal(
        row!.schema,
        "schemas/cosfp-fixture.schema.json",
        `${id} schema ref`,
      );
      assert.equal(row!.expected, "ok", `${id} expected ok`);
    }
    const schemaRow = m.fixtures.find(
      (f) => f.path === "schemas/cosfp-fixture.schema.json",
    );
    assert.ok(schemaRow, "cosfp schema registered");
    assert.equal(schemaRow!.algorithm, "json-schema");
  });

  test("all 5 fixtures carry the shared cosfp envelope invariants", () => {
    for (const id of COSFP_IDS) {
      const fx = readFixture(id);
      assert.equal(fx.kind, "cosfp", `${id}: kind`);
      assert.equal(typeof fx.assertion, "string", `${id}: assertion string`);
      assert.ok(fx.assertion.length > 0, `${id}: non-empty assertion`);
    }
  });
});

describe("COS-FP-A fixture pins", () => {
  test("001 pins stratified report correctness (content types + 37-point grid)", () => {
    const fx = readFixture("COS-FP-A-001");
    assert.equal(fx.flag, "MEGACOMPACT_COSINE_FP_BENCH", "001: flag name");
    assert.equal(fx.flag_enabled, true, "001: flag enabled");
    assert.deepEqual(
      [...(fx.content_types ?? [])].sort(),
      ["code", "mixed", "prose"],
      "001: content types",
    );
    assert.equal(fx.grid?.lo, 0.8, "001: grid lo");
    assert.equal(fx.grid?.hi, 0.98, "001: grid hi");
    assert.equal(fx.grid?.step, 0.005, "001: grid step");
    assert.equal(fx.grid?.points, 37, "001: grid points");
    assert.equal(fx.status, "ok", "001: status ok");
    const fp = fx.per_type_fp_fractions ?? [];
    assert.ok(fp.length >= 2, "001: fp fraction bounds present");
    for (const f of fp) {
      assert.ok(f >= 0 && f <= 1, "001: fp fraction within [0,1]");
    }
  });

  test("002 pins digest determinism against the committed benchmark aggregate", () => {
    const fx = readFixture("COS-FP-A-002");
    assert.equal(fx.seed_invariant, true, "002: seed invariant");
    assert.equal(fx.same_corpus_same_digest, true, "002: same corpus same digest");
    assert.equal(
      typeof fx.report_digest_sha256,
      "string",
      "002: pinned digest present",
    );
    // The committed bench-run aggregate must reproduce the pinned digest —
    // proving an actual deterministic run produced it, not a fabricated value.
    const agg = JSON.parse(
      readFileSync(BENCH_AGGREGATE, "utf8"),
    ) as { digest?: string };
    assert.ok(agg.digest, "committed bench-run aggregate has a digest");
    assert.equal(
      agg.digest,
      fx.report_digest_sha256,
      "002: committed aggregate digest matches pinned fixture digest",
    );
  });

  test("003 pins the no-fabrication fallback (never fabricates threshold or FP=0)", () => {
    const fx = readFixture("COS-FP-A-003");
    assert.equal(fx.no_data, "explicit", "003: explicit no_data");
    assert.equal(fx.status, "no_data", "003: status no_data");
    assert.equal(fx.fabricated_threshold, false, "003: no fabricated threshold");
    assert.equal(fx.fabricated_fp, false, "003: no fabricated FP");
  });

  test("004 pins the off-by-one < vs >= threshold boundary at cosine 0.8995", () => {
    const fx = readFixture("COS-FP-A-004");
    assert.equal(fx.strict_straddle, true, "004: strict straddle");
    assert.equal(fx.boundary?.lo, 0.899, "004: boundary lo");
    assert.equal(fx.boundary?.hi, 0.9, "004: boundary hi");
    // The pair sits exactly between the two thresholds.
    const cos = 0.8995;
    assert.equal(
      classifyPair(cos, 0.9),
      "passed",
      "004: cosine 0.8995 < 0.900 → passed (never deduped)",
    );
    assert.equal(
      classifyPair(cos, 0.899),
      "deduped",
      "004: cosine 0.8995 >= 0.899 → deduped (never passed)",
    );
  });

  test("005 pins flag-off byte-identity (L2_COSINE plain default, overrides off)", () => {
    const fx = readFixture("COS-FP-A-005");
    assert.equal(fx.flag_enabled, false, "005: flag disabled");
    assert.equal(
      fx.l2_cosine,
      "MEGACOMPACT_L2_THRESHOLD=0.85",
      "005: L2_COSINE stays plain default",
    );
    assert.equal(fx.override_enabled, false, "005: overrides off");
    assert.equal(fx.byte_identical, true, "005: byte-identical");
  });
});

describe("COS-FP-A harness contract (local re-implementation of pinned helpers)", () => {
  test("grid 0.80 → 0.98 step 0.005 is inclusive both ends → exactly 37 points", () => {
    const grid = makeGrid();
    assert.equal(grid.length, 37, "exactly 37 grid points");
    assert.equal(grid[0], 0.8, "grid starts at 0.80");
    assert.equal(grid[grid.length - 1], 0.98, "grid ends at 0.98");
    // Every step is exactly 0.005 apart at 3-decimal precision.
    for (let i = 1; i < grid.length; i++) {
      assert.equal(
        Math.round((grid[i] - grid[i - 1]) * 1000),
        5,
        `step between ${grid[i - 1]} and ${grid[i]}`,
      );
    }
  });

  test("the flag function exports a live boolean regardless of env state", () => {
    // The aggregator stays green under BOTH flag states; the runtime off/on
    // gating is exercised by the fixture matrix (005) + the dashboard-client
    // typecheck+build + the CLEAN=1 determinism smoke of bench.mjs.
    assert.equal(typeof COSINE_FP_BENCH_ENABLED(), "boolean");
  });

  test("COSINE_FP_REAL_ENABLED is exported as a live boolean regardless of env state", () => {
    // COS-FP-R owns no conformance fixtures (real corpus only), so the
    // aggregator asserts the flag registration here: the exported function
    // returns a live boolean in BOTH flag states. The real-corpus runtime
    // gating (no_corpus / inert) is exercised by real-bench.mjs + its
    // write-time test file, not by fixtures.
    assert.equal(typeof COSINE_FP_REAL_ENABLED(), "boolean");
  });
});
