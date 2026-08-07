/** DASH-0b acceptance aggregator (fixture registration + contract scan, no mocks).
 *
 *  Asserts the dashboard-consolidation fixtures DASH-0B-001..003 are registered
 *  in the v2 manifest with the dashboard-consolidation algorithm against the
 *  dashboard-consolidation-fixture schema, that their envelopes carry the
 *  expected Sessions-merge / 18→4 Cortex-section bijection / flag-off
 *  guarantees, that the flag surface stays boolean and flag-agnostic (passes
 *  with MEGACOMPACT_DASH_0B ON or OFF), and that the flag is a visible
 *  VECTOR_CORTEX_SETTINGS toggle.
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DASH_0B_ENABLED } from "../config/vector-cortex.js";

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

const DASH_IDS = ["DASH-0B-001", "DASH-0B-002", "DASH-0B-003"] as const;
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

/** The 18 cards the sectioned VectorCortexTab/sections.tsx groups (bijective).
 *  A card is a `<VectorCortexXCard` (or `<Vc0cHealthCard` / `<ModelImprovementCard`)
 *  JSX usage. The VC0C health envelope is a local `Vc0cHealthCard` component moved
 *  verbatim into sections.tsx, so its usage tag is the 18th card mark. */
const CORTEX_CARDS: readonly string[] = [
  "VectorCortexTopologyCard",
  "VectorCortexShardsCard",
  "VectorCortexReconstructCard",
  "VectorCortexPlansCard",
  "VectorCortexRenderCard",
  "VectorCortexRolloutCard",
  "VectorCortexClosureCard",
  "VectorCortexRestoreCard",
  "VectorCortexRepairCard",
  "VectorCortexCrystalsCard",
  "VectorCortexEconomicsCard",
  "VectorCortexDiagnosticsCard",
  "VectorCortexOutcomesCard",
  "VectorCortexPolicyCard",
  "VectorCortexPlatformCard",
  "VectorCortexLedgerCard",
  "ModelImprovementCard",
  "Vc0cHealthCard",
];
const CORTEX_SECTIONS: readonly string[] = [
  "cortex-status",
  "cortex-repair",
  "cortex-cache",
  "cortex-adaptive",
];

describe("DASH-0B fixture registration + kind-closure", () => {
  test("manifest registers DASH-0B-001..003 with algorithm dashboard-consolidation + the schema", () => {
    const m = readManifest();
    const expectedById: Record<string, string> = {
      "DASH-0B-001": "ok",
      "DASH-0B-002": "ok",
      "DASH-0B-003": "flag-off",
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

  test("owner DASH-0B is registered in the manifest owner CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("DASH-0B"), "owner DASH-0B present");
  });

  test("domain dashboard-consolidation is registered in the manifest domain CSV", () => {
    const domains = readManifest().domain.split(/[;,]/).map((s) => s.trim());
    assert.ok(
      domains.includes("dashboard-consolidation"),
      "domain dashboard-consolidation present",
    );
  });
});

describe("DASH-0B fixture envelope posture", () => {
  test("DASH-0B-001: sessions surface shows the sessions body AND the turns drill-down", () => {
    const fx = fixture("DASH-0B-001");
    assert.equal(fx.kind, "dashboard-tab-plan", "001 kind");
    assert.equal(fx.expected.surface, "sessions", "001 surface");
    assert.equal(fx.expected.shows_sessions, true, "001 shows sessions body");
    assert.equal(fx.expected.shows_turns_drilldown, true, "001 shows turns drill-down");
  });

  test("DASH-0B-002: all 18 cortex cards under exactly one of the 4 sections (bijective)", () => {
    const fx = fixture("DASH-0B-002");
    assert.equal(fx.kind, "dashboard-tab-plan", "002 kind");
    assert.equal(fx.expected.sections, 4, "002 sections === 4");
    assert.equal(fx.expected.cards, 18, "002 cards === 18");
    assert.equal(fx.expected.card_section_assignment, "bijective", "002 assignment");

    // Deterministic source scan of the sectioned layout: every one of the 18
    // card marks appears in EXACTLY one `<section aria-labelledby>` block, and
    // the 4 section heading ids are distinct (unique-failure-injectable: a
    // duplicated heading id or a card in two sections fails here).
    const sectionsSrc = readFileSync(
      join(ROOT, "extensions", "dashboard-client", "src", "tabs", "VectorCortexTab", "sections.tsx"),
      "utf8",
    );
    assert.equal(CORTEX_CARDS.length, 18, "18 card marks enumerated");
    const blocks: string[] = [];
    for (const id of CORTEX_SECTIONS) {
      const re = new RegExp(`<section aria-labelledby="${id}"[\\s\\S]*?<\\/section>`);
      const m = re.exec(sectionsSrc);
      assert.ok(m, `section ${id} present`);
      blocks.push(m[0]);
    }
    for (const card of CORTEX_CARDS) {
      const needle = `<${card}`;
      const inSections = blocks.filter((b) => b.includes(needle)).length;
      assert.equal(inSections, 1, `card ${card} in exactly one section (got ${inSections})`);
    }
  });

  test("DASH-0B-003: flag-off renders the two prior surfaces independently (sessions + standalone turns)", () => {
    const fx = fixture("DASH-0B-003");
    assert.equal(fx.kind, "dashboard-tab-plan", "003 kind");
    assert.equal(fx.expected.flag_enabled, false, "003 flag disabled");
    assert.equal(fx.expected.sessions_self_contained, true, "003 sessions self-contained");
    assert.equal(fx.expected.turns_standalone, true, "003 standalone turns untouched");
  });
});

describe("DASH-0B flag invariants (flag-agnostic)", () => {
  test("flag state is a live boolean regardless of env", () => {
    const saved = process.env.MEGACOMPACT_DASH_0B;
    try {
      delete process.env.MEGACOMPACT_DASH_0B;
      assert.equal(typeof DASH_0B_ENABLED(), "boolean");
      process.env.MEGACOMPACT_DASH_0B = "0";
      assert.equal(DASH_0B_ENABLED(), false);
      process.env.MEGACOMPACT_DASH_0B = "1";
      assert.equal(DASH_0B_ENABLED(), true);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_DASH_0B;
      else process.env.MEGACOMPACT_DASH_0B = saved;
    }
  });
});

describe("DASH-0B settings toggle registration", () => {
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_DASH_0B"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    const excluded = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excluded) {
      assert.doesNotMatch(excluded[0], /MEGACOMPACT_DASH_0B/, "flag NOT in EXCLUDED_SETTINGS");
    }
  });
});
