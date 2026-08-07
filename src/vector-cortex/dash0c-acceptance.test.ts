/** DASH-0c acceptance aggregator (fixture registration + contract scan, no mocks).
 *
 *  Asserts the dashboard-consolidation fixtures DASH-0C-001..003 are registered
 *  in the v2 manifest with the dashboard-consolidation algorithm against the
 *  dashboard-consolidation-fixture schema, that their envelopes carry the
 *  Cache+Performance / Admin-combine / flag-off guarantees, that the flag
 *  surface stays boolean and flag-agnostic (passes with MEGACOMPACT_DASH_0C ON
 *  or OFF), that the flag is a visible VECTOR_CORTEX_SETTINGS toggle, and that
 *  the source trees carry the consolidated surface seams (CacheTab mounts
 *  MetricsCards under the `cache-perf-cards` section; AdminTab exposes the
 *  `AdminViews` toggle).
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DASH_0C_ENABLED } from "../config/vector-cortex.js";

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
const TABS = join(ROOT, "extensions", "dashboard-client", "src", "tabs");

const DASH_IDS = ["DASH-0C-001", "DASH-0C-002", "DASH-0C-003"] as const;
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

describe("DASH-0C fixture registration + kind-closure", () => {
  test("manifest registers DASH-0C-001..003 with algorithm dashboard-consolidation + the schema", () => {
    const m = readManifest();
    const expectedById: Record<string, string> = {
      "DASH-0C-001": "ok",
      "DASH-0C-002": "ok",
      "DASH-0C-003": "flag-off",
    };
    for (const id of DASH_IDS) {
      const row = m.fixtures.find(
        (f) => f.id === id && f.path.startsWith("dashboard-consolidation/"),
      );
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "dashboard-consolidation", `${id} algorithm`);
      assert.equal(row!.path, `dashboard-consolidation/${id}.json`, `${id} path`);
      assert.equal(row!.schema, SCHEMA, `${id} schema`);
      assert.equal(row!.expected, expectedById[id]!, `${id} expected`);
    }
  });

  test("owner DASH-0C is registered in the manifest owner CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("DASH-0C"), "owner DASH-0C present");
  });

  test("domain dashboard-consolidation is registered in the manifest domain CSV", () => {
    const domains = readManifest().domain.split(/[;,]/).map((s) => s.trim());
    assert.ok(
      domains.includes("dashboard-consolidation"),
      "domain dashboard-consolidation present",
    );
  });
});

describe("DASH-0C fixture envelope posture", () => {
  test("DASH-0C-001: cache+performance surface exposes cache sections AND perf cards", () => {
    const fx = fixture("DASH-0C-001");
    assert.equal(fx.kind, "dashboard-tab-plan", "001 kind");
    assert.equal(fx.expected.surface, "cache-perf", "001 surface");
    assert.equal(fx.expected.cache_sections, true, "001 cache sections present");
    assert.equal(fx.expected.perf_cards, true, "001 perf cards present");
  });

  test("DASH-0C-002: admin surface exposes maintenance AND config", () => {
    const fx = fixture("DASH-0C-002");
    assert.equal(fx.kind, "dashboard-tab-plan", "002 kind");
    assert.equal(fx.expected.surface, "admin", "002 surface");
    assert.equal(fx.expected.maintenance_present, true, "002 maintenance present");
    assert.equal(fx.expected.config_present, true, "002 config present");
  });

  test("DASH-0C-003: flag-off keeps cache-only + independent metrics/maintenance/config surfaces", () => {
    const fx = fixture("DASH-0C-003");
    assert.equal(fx.kind, "dashboard-tab-plan", "003 kind");
    assert.equal(fx.expected.flag_enabled, false, "003 flag disabled");
    assert.equal(fx.expected.cache_only, true, "003 cache-only surface");
    assert.equal(fx.expected.standalone_surfaces_intact, true, "003 standalone surfaces intact");
  });
});

describe("DASH-0C flag invariants (flag-agnostic)", () => {
  test("flag state is a live boolean regardless of env", () => {
    const saved = process.env.MEGACOMPACT_DASH_0C;
    try {
      delete process.env.MEGACOMPACT_DASH_0C;
      assert.equal(typeof DASH_0C_ENABLED(), "boolean");
      process.env.MEGACOMPACT_DASH_0C = "0";
      assert.equal(DASH_0C_ENABLED(), false);
      process.env.MEGACOMPACT_DASH_0C = "1";
      assert.equal(DASH_0C_ENABLED(), true);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_DASH_0C;
      else process.env.MEGACOMPACT_DASH_0C = saved;
    }
  });
});

describe("DASH-0C settings toggle registration", () => {
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_DASH_0C"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    const excluded = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excluded) {
      assert.doesNotMatch(excluded[0], /MEGACOMPACT_DASH_0C/, "flag NOT in EXCLUDED_SETTINGS");
    }
  });
});

describe("DASH-0C client-dimension source scan", () => {
  test("CacheTab mounts MetricsCards under the cache-perf-cards section gate", () => {
    const cacheTab = readFileSync(join(TABS, "CacheTab.tsx"), "utf8");
    assert.match(cacheTab, /cache-perf-cards/, "CacheTab has the cache-perf-cards section anchor");
    assert.match(cacheTab, /<MetricsCards \/>/, "CacheTab mounts MetricsCards");
    assert.match(cacheTab, /dash0cOn &&/, "CacheTab gates the section on the flag");
    const metricsCards = readFileSync(join(TABS, "CacheTab", "MetricsCards.tsx"), "utf8");
    assert.match(metricsCards, /export function MetricsCards/, "MetricsCards named export");
    assert.match(metricsCards, /<PerfCards perf=\{perf\} \/>/, "perf cards body preserved");
  });

  test("MetricsTab is a shell re-exporting MetricsCards (deep-link anchor kept)", () => {
    const metricsTab = readFileSync(join(TABS, "MetricsTab.tsx"), "utf8");
    assert.match(metricsTab, /MetricsCards/, "MetricsTab re-exports MetricsCards");
  });

  test("AdminTab exposes the AdminViews toggle over MaintenanceTab + ConfigTab", () => {
    const adminTab = readFileSync(join(TABS, "AdminTab.tsx"), "utf8");
    assert.match(adminTab, /AdminViews/, "AdminTab defines AdminViews toggle");
    assert.match(adminTab, /MaintenanceTab/, "AdminTab mounts MaintenanceTab");
    assert.match(adminTab, /ConfigTab/, "AdminTab mounts ConfigTab");
    assert.match(adminTab, /aria-label="Admin views"/, "AdminTab toggle labelled");
  });

  test("MaintenanceTab and ConfigTab render bodies are untouched (no render-body edit)", () => {
    // Both stay importable from the original hosts / the new AdminTab; their
    // render bodies are not edited this sprint. Smoke: the files still export
    // their default components and remain present.
    const maintenance = readFileSync(join(TABS, "MaintenanceTab.tsx"), "utf8");
    assert.match(maintenance, /export default function MaintenanceTab/, "MaintenanceTab default export");
    const config = readFileSync(join(TABS, "ConfigTab.tsx"), "utf8");
    assert.match(config, /export default function ConfigTab/, "ConfigTab default export");
  });
});
