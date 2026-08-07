/** DASH-0a acceptance aggregator (fixture registration + contract scan, no mocks).
 *
 *  Asserts the dashboard-consolidation fixtures DASH-0A-001..003 are registered
 *  in the v2 manifest with the dashboard-tab-plan algorithm against the
 *  dashboard-consolidation-fixture schema, that their envelopes carry the
 *  expected flat-coverage / no-collision / flag-off guarantees, that the flag
 *  surface stays boolean and flag-agnostic (passes with MEGACOMPACT_DASH_0A ON
 *  or OFF), and that the flag is a visible VECTOR_CORTEX_SETTINGS toggle.
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DASH_0A_ENABLED } from "../config/vector-cortex.js";

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

const DASH_IDS = ["DASH-0A-001", "DASH-0A-002", "DASH-0A-003"] as const;
const SCHEMA = "schemas/dashboard-consolidation-fixture.schema.json";

interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  schema?: string;
  expected: string;
}
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface DashFixture {
  id: string;
  producer: string;
  assertion: string;
  kind: string;
  schema?: string;
  expected: Record<string, unknown>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): DashFixture {
  const row = readManifest().fixtures.find(
    (f) => f.id === id && f.path.startsWith("dashboard-consolidation/"),
  );
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  const path = join(V2, row.path);
  return JSON.parse(readFileSync(path, "utf8")) as DashFixture;
}

describe("DASH-0A fixture registration + kind-closure", () => {
  test("manifest registers DASH-0A-001..003 with algorithm dashboard-tab-plan + the schema", () => {
    const m = readManifest();
    const expectedById: Record<string, string> = {
      "DASH-0A-001": "ok",
      "DASH-0A-002": "ok",
      "DASH-0A-003": "flag-off",
    };
    for (const id of DASH_IDS) {
      const row = m.fixtures.find(
        (f) => f.id === id && f.path.startsWith("dashboard-consolidation/"),
      );
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "dashboard-tab-plan", `${id} algorithm`);
      assert.equal(row!.path, `dashboard-consolidation/${id}.json`, `${id} path`);
      assert.equal(row!.schema, SCHEMA, `${id} schema`);
      assert.equal(row!.expected, expectedById[id]!, `${id} expected`);
    }
  });

  test("owner DASH-0A is registered in the manifest owner CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("DASH-0A"), "owner DASH-0A present");
  });

  test("domain dashboard-consolidation is registered in the manifest domain CSV", () => {
    const domains = readManifest().domain.split(/[;,]/).map((s) => s.trim());
    assert.ok(
      domains.includes("dashboard-consolidation"),
      "domain dashboard-consolidation present",
    );
  });
});

describe("DASH-0A fixture envelope posture", () => {
  test("DASH-0A-001: 7 surfaces covering 13 source TabIds, each mapped once", () => {
    const fx = fixture("DASH-0A-001");
    assert.equal(fx.kind, "dashboard-tab-plan", "001 kind");
    assert.equal(fx.expected.surfaces, 7, "001 surfaces === 7");
    assert.equal(fx.expected.source_tab_ids, 13, "001 source_tab_ids === 13");
    assert.equal(fx.expected.each_mapped_once, true, "001 each mapped once");
  });

  test("DASH-0A-002: no collision and no dropped source", () => {
    const fx = fixture("DASH-0A-002");
    assert.equal(fx.kind, "dashboard-tab-plan", "002 kind");
    assert.equal(fx.expected.collision, false, "002 collision false");
    assert.deepEqual(fx.expected.dropped_sources, [], "002 dropped_sources empty");
  });

  test("DASH-0A-003: flag-off — shell untouched, routing unchanged", () => {
    const fx = fixture("DASH-0A-003");
    assert.equal(fx.kind, "dashboard-tab-plan", "003 kind");
    assert.equal(fx.expected.flag_enabled, false, "003 flag disabled");
    assert.equal(fx.expected.routing_changed, false, "003 routing unchanged");
    assert.equal(fx.expected.shell_touched, false, "003 shell untouched");
  });
});

describe("DASH-0A flag invariants (flag-agnostic)", () => {
  test("flag state is a live boolean regardless of env", () => {
    const saved = process.env.MEGACOMPACT_DASH_0A;
    try {
      delete process.env.MEGACOMPACT_DASH_0A;
      assert.equal(typeof DASH_0A_ENABLED(), "boolean");
      process.env.MEGACOMPACT_DASH_0A = "0";
      assert.equal(DASH_0A_ENABLED(), false);
      process.env.MEGACOMPACT_DASH_0A = "1";
      assert.equal(DASH_0A_ENABLED(), true);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_DASH_0A;
      else process.env.MEGACOMPACT_DASH_0A = saved;
    }
  });
});

describe("DASH-0A settings toggle registration", () => {
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_DASH_0A"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    const excluded = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excluded) {
      assert.doesNotMatch(excluded[0], /MEGACOMPACT_DASH_0A/, "flag NOT in EXCLUDED_SETTINGS");
    }
  });
});
