/** DASH-0d acceptance aggregator (fixture registration + contract scan, no mocks).
 *
 *  Asserts the dashboard-consolidation fixtures DASH-0D-001..004 are registered
 *  in the v2 manifest with the dashboard-consolidation algorithm against the
 *  dashboard-consolidation-fixture schema; that their envelopes carry the
 *  7-surface / deep-link-resolve / flag-off-13 / a11y-clean guarantees; that the
 *  flag surface stays boolean and flag-agnostic (passes with MEGACOMPACT_DASH_0D
 *  ON or OFF); that the flag is a visible VECTOR_CORTEX_SETTINGS toggle; and
 *  that the client carries the roll-up seams: App.tsx consolidates its TabContent
 *  onto the 7 surfaces with an additive hash router, TurnsTab is a shell over
 *  TurnMemoryView, and the dash-tab-count/dashboard-audit verifiers exist.
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DASH_0D_ENABLED } from "../config/vector-cortex.js";

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
const APP = join(ROOT, "extensions", "dashboard-client", "src", "App.tsx");

const DASH_IDS = ["DASH-0D-001", "DASH-0D-002", "DASH-0D-003", "DASH-0D-004"] as const;
const SCHEMA = "schemas/dashboard-consolidation-fixture.schema.json";

/** The fixed 7 consolidated surfaces (DASH-0a merge plan). */
const CONSOLIDATED_7 = [
  "overview", "sessions", "cache-perf", "memory-graph", "diagnostics", "setup", "admin",
];

/** Legacy hash → consolidated surface (DASH-0a DEEP_LINK_TARGETS + aliases). */
const DEEP_LINK_MAP: Record<string, string> = {
  sessions: "sessions", turns: "sessions",
  cache: "cache-perf", metrics: "cache-perf",
  "memory-map": "memory-graph", repos: "memory-graph", wiki: "memory-graph",
  "vector-cortex": "diagnostics", events: "diagnostics", health: "diagnostics",
  maintenance: "admin", config: "admin", setup: "setup", overview: "overview",
};

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

describe("DASH-0D fixture registration + kind-closure", () => {
  test("manifest registers DASH-0D-001..004 with algorithm dashboard-consolidation + the schema", () => {
    const m = readManifest();
    const expectedById: Record<string, string> = {
      "DASH-0D-001": "ok",
      "DASH-0D-002": "ok",
      "DASH-0D-003": "flag-off",
      "DASH-0D-004": "ok",
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
    // Roll-up target: at least 944 fixtures (PREVENT-SPEC-DRIFT-001 — derive from
    // manifest, not a prior-sprint literal that drifts when other sprints add rows).
    // DASH-0D shipped at 944 (940 + 4 new); concurrent sprints may push it higher.
    assert.ok(
      m.fixtures.length >= 944,
      `manifest carries at least 944 fixtures, got ${m.fixtures.length}`,
    );
  });

  test("owner DASH-0D is registered in the manifest owner CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("DASH-0D"), "owner DASH-0D present");
  });

  test("domain dashboard-consolidation is registered in the manifest domain CSV", () => {
    const domains = readManifest().domain.split(/[;,]/).map((s) => s.trim());
    assert.ok(
      domains.includes("dashboard-consolidation"),
      "domain dashboard-consolidation present",
    );
  });
});

describe("DASH-0D fixture envelope posture", () => {
  test("DASH-0D-001: the merged dashboard exposes exactly 7 top-level surfaces", () => {
    const fx = fixture("DASH-0D-001");
    assert.equal(fx.kind, "dashboard-tab-plan", "001 kind");
    assert.equal(fx.expected.surfaces, 7, "001 surfaces === 7");
    const expected = fx.expected.expected_surfaces as string[];
    assert.deepEqual(
      [...expected].sort(),
      [...CONSOLIDATED_7].sort(),
      "001 expected_surfaces match the 7-surface set",
    );
  });

  test("DASH-0D-002: every legacy hash deep-link resolves to a live surface", () => {
    const fx = fixture("DASH-0D-002");
    assert.equal(fx.kind, "dashboard-tab-plan", "002 kind");
    assert.equal(fx.expected.resolves, true, "002 resolves");
    const matrix = fx.expected.deep_link_matrix as Array<{
      hash: string; surface: string; resolves: boolean;
    }>;
    assert.ok(Array.isArray(matrix) && matrix.length > 0, "002 deep-link matrix present");
    for (const row of matrix) {
      assert.equal(row.resolves, true, `${row.hash} resolves`);
      assert.ok(
        CONSOLIDATED_7.includes(row.surface),
        `${row.hash} maps to live surface ${row.surface}`,
      );
    }
    // The 13 legacy hashes named in the release set must ALL resolve.
    const legacyHashes = [
      "#sessions", "#turns", "#cache", "#metrics", "#repos", "#wiki", "#memory-map",
      "#events", "#health", "#vector-cortex", "#maintenance", "#config", "#overview",
    ];
    for (const h of legacyHashes) {
      assert.ok(
        matrix.some((r) => r.hash === h),
        `legacy hash ${h} present in the resolve matrix`,
      );
    }
  });

  test("DASH-0D-003: flag-off reproduces the 13-surface lazy list byte-identically", () => {
    const fx = fixture("DASH-0D-003");
    assert.equal(fx.kind, "dashboard-tab-plan", "003 kind");
    assert.equal(fx.expected.flag_enabled, false, "003 flag disabled");
    assert.equal(fx.expected.surfaces, 13, "003 flag-off surfaces === 13");
    assert.equal(fx.expected.byte_identical, true, "003 byte-identical flag-off");
  });

  test("DASH-0D-004: a11y audit passes serious/critical-clean on the merged surfaces", () => {
    const fx = fixture("DASH-0D-004");
    assert.equal(fx.kind, "dashboard-tab-plan", "004 kind");
    assert.equal(fx.expected.surfaces, 7, "004 surfaces === 7");
    assert.equal(fx.expected.serious_critical_violations, 0, "004 zero serious/critical");
    assert.equal(fx.expected.nav_map_satisfied, true, "004 nav map satisfied");
  });
});

describe("DASH-0D flag invariants (flag-agnostic)", () => {
  test("flag state is a live boolean regardless of env", () => {
    const saved = process.env.MEGACOMPACT_DASH_0D;
    try {
      delete process.env.MEGACOMPACT_DASH_0D;
      assert.equal(typeof DASH_0D_ENABLED(), "boolean");
      process.env.MEGACOMPACT_DASH_0D = "0";
      assert.equal(DASH_0D_ENABLED(), false);
      process.env.MEGACOMPACT_DASH_0D = "1";
      assert.equal(DASH_0D_ENABLED(), true);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_DASH_0D;
      else process.env.MEGACOMPACT_DASH_0D = saved;
    }
  });
});

describe("DASH-0D settings toggle registration", () => {
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_DASH_0D"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    const excluded = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excluded) {
      assert.doesNotMatch(excluded[0], /MEGACOMPACT_DASH_0D/, "flag NOT in EXCLUDED_SETTINGS");
    }
  });
});

describe("DASH-0D client-dimension source scan", () => {
  test("registry declares DASH_SURFACE_IDS (7) + DashTabId + DASH_TAB_COUNT", () => {
    const reg = readFileSync(join(TABS, "registry.ts"), "utf8");
    assert.match(reg, /DASH_SURFACE_IDS/, "registry DASH_SURFACE_IDS");
    for (const id of CONSOLIDATED_7) {
      assert.match(reg, new RegExp(`"${id}"`), `registry lists ${id}`);
    }
    assert.match(reg, /export type DashTabId/, "DashTabId type");
    assert.match(reg, /export const DASH_TAB_COUNT/, "DASH_TAB_COUNT constant");
  });

  test("App.tsx TabContent has both the consolidated 7-surface region and the 13-tab legacy region", () => {
    const app = readFileSync(APP, "utf8");
    assert.match(app, /\{\/\* DASH-0D-CONSOLIDATED \*\/\}/, "consolidated region marker");
    assert.match(app, /\{\/\* DASH-0D-CONSOLIDATED-END \*\/\}/, "consolidated end marker");
    assert.match(app, /\{\/\* DASH-0D-LEGACY \*\/\}/, "legacy region marker");
    assert.match(app, /\{\/\* DASH-0D-LEGACY-END \*\/\}/, "legacy end marker");
    // The consolidated branch covers all 7 surfaces.
    const cons = app.slice(
      app.indexOf("{/* DASH-0D-CONSOLIDATED */}"),
      app.indexOf("{/* DASH-0D-CONSOLIDATED-END */}"),
    );
    for (const id of CONSOLIDATED_7) {
      assert.match(cons, new RegExp(`activeTab === "${id}"`), `consolidated branch ${id}`);
    }
  });

  test("dashHashRouter maps the full legacy deep-link set (no dead hash)", () => {
    const router = readFileSync(join(TABS, "dashHashRouter.ts"), "utf8");
    assert.match(router, /export function useHashTab/, "useHashTab hook exported");
    assert.match(router, /window\.addEventListener\(["']hashchange/, "hashchange listener");
    assert.match(router, /export function resolveHashToSurface/, "resolveHashToSurface exported");
    for (const [hash, surface] of Object.entries(DEEP_LINK_MAP)) {
      // registry keys may be quoted (e.g. "memory-map") — allow optional quotes.
      assert.match(
        router,
        new RegExp(`["']?${hash}["']?:\\s*"${surface}"`),
        `router maps #${hash} → ${surface}`,
      );
    }
  });

  test("TurnsTab is a thin shell over TurnMemoryView (no duplicated body)", () => {
    const turnsTab = readFileSync(join(TABS, "TurnsTab.tsx"), "utf8");
    assert.match(turnsTab, /TurnMemoryView/, "TurnsTab re-exports TurnMemoryView");
    assert.doesNotMatch(turnsTab, /Turn-by-turn memory tracking \+ recall/, "no duplicated body");
  });

  test("dash-tab-count.mjs and dashboard-audit.mjs verifiers exist", () => {
    assert.ok(
      existsSync(join(ROOT, "scripts", "dash-tab-count.mjs")),
      "scripts/dash-tab-count.mjs exists",
    );
    assert.ok(
      existsSync(join(ROOT, "scripts", "dashboard-audit.mjs")),
      "scripts/dashboard-audit.mjs exists",
    );
  });
});
