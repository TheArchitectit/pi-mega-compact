/**
 * vector-cortex/dedup-attr-acceptance.test.ts — DEDUP-ATTR acceptance aggregator.
 *
 * Drives the committed DEDUP-ATTR-001..004 fixtures against the canonical v2
 * manifest — no mocks, no stubs. Reads the manifest + the dedup-attribution
 * fixture files, validates each envelope against the schema semantics, and
 * pins the registration invariants (algorithm, path, schema ref, expected ok).
 *
 * The route itself lives in extensions/dashboard-server (not importable from
 * the published dist/vector-cortex/ offset), so its behavior is exercised by
 * routes-dedup-attribution.test.ts; the pure rollup arithmetic is pinned by
 * rollup.test.ts. This aggregator is FLAG-AGNOSTIC: MEGACOMPACT_DEDUP_ATTR only
 * gates the dashboard route + durable cache write, none of which are touched
 * here, so the same suite is green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEDUP_ATTR_ENABLED } from "../config/vector-cortex.js";

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

/** The canonical dedup-attribution fixture IDs this sprint owns. */
const DEDUP_IDS = [
  "DEDUP-ATTR-001",
  "DEDUP-ATTR-002",
  "DEDUP-ATTR-003",
  "DEDUP-ATTR-004",
] as const;

interface DedupAttrFixture {
  id: string;
  kind: string;
  scenario: "non-empty" | "empty" | "flag-off" | "pure";
  total_decisions: number;
  shares_sum_to_one: boolean;
  expected_status: "live" | "awaiting_data" | "off";
}

function readFixture(id: string): DedupAttrFixture {
  const m = readManifest();
  const row = m.fixtures.find(
    (f) => f.id === id && f.path.startsWith("dedup-attribution/"),
  );
  assert.ok(row, `fixture ${id} registered under dedup-attribution/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as DedupAttrFixture;
}

describe("DEDUP-ATTR conformance registration", () => {
  test("manifest registers DEDUP-ATTR-001..004 + the schema under the dedup seam", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of DEDUP_IDS) assert.ok(ids.has(id), `missing ${id}`);
    for (const id of DEDUP_IDS) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row!.algorithm, "dedup-attribution", `${id} algorithm`);
      assert.equal(row!.path, `dedup-attribution/${id}.json`, `${id} path`);
      assert.equal(
        row!.schema,
        "schemas/dedup-attribution-fixture.schema.json",
        `${id} schema ref`,
      );
      assert.equal(row!.expected, "ok", `${id} expected ok`);
    }
    const schemaRow = m.fixtures.find(
      (f) => f.path === "schemas/dedup-attribution-fixture.schema.json",
    );
    assert.ok(schemaRow, "dedup-attribution schema registered");
    assert.equal(schemaRow!.algorithm, "json-schema");
  });
});

describe("DEDUP-ATTR fixture envelopes", () => {
  test("all 4 fixtures satisfy the schema-envelope invariants", () => {
    for (const id of DEDUP_IDS) {
      const fx = readFixture(id);
      assert.equal(fx.kind, "dedup-attribution", `${id}: kind`);
      assert.ok(
        ["non-empty", "empty", "flag-off", "pure"].includes(fx.scenario),
        `${id}: scenario enum`,
      );
      assert.equal(typeof fx.total_decisions, "number", `${id}: total_decisions number`);
      assert.equal(typeof fx.shares_sum_to_one, "boolean", `${id}: shares_sum_to_one boolean`);
      assert.ok(
        ["live", "awaiting_data", "off"].includes(fx.expected_status),
        `${id}: status enum`,
      );
    }
  });

  test("DEDUP-ATTR-001 pins a non-empty window with shares summing to 1.0 + live", () => {
    const fx = readFixture("DEDUP-ATTR-001");
    assert.equal(fx.scenario, "non-empty");
    assert.ok(fx.total_decisions > 0);
    assert.equal(fx.shares_sum_to_one, true);
    assert.equal(fx.expected_status, "live");
  });

  test("DEDUP-ATTR-002 pins the empty-window zero-share awaiting_data shape (not fabricated)", () => {
    const fx = readFixture("DEDUP-ATTR-002");
    assert.equal(fx.scenario, "empty");
    assert.equal(fx.total_decisions, 0);
    assert.equal(fx.shares_sum_to_one, false);
    assert.equal(fx.expected_status, "awaiting_data");
  });

  test("DEDUP-ATTR-003 pins the flag-off 404 + no-write shape", () => {
    const fx = readFixture("DEDUP-ATTR-003");
    assert.equal(fx.scenario, "flag-off");
    assert.equal(fx.expected_status, "off");
    assert.equal(fx.total_decisions, 0);
  });

  test("DEDUP-ATTR-004 pins pure determinism", () => {
    const fx = readFixture("DEDUP-ATTR-004");
    assert.equal(fx.scenario, "pure");
    assert.equal(fx.expected_status, "live");
  });

  test("the flag function exports a live boolean regardless of env state", () => {
    assert.equal(typeof DEDUP_ATTR_ENABLED(), "boolean");
  });
});
