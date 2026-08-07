/**
 * DASH-0a plan audit test (spec-staleness deviation: the spec placed this test
 * inside the dashboard-client as `dash-consolidation/plan.test.ts`, but the
 * dashboard-client has NO test runner — only `vite build`. So it lives here as
 * a root `node --test` file compiled by root tsc, exactly like every other
 * acceptance/plan test).
 *
 * Pins the DASH-0a contract-plan invariants against the SHIPPED plan module:
 *   - exactly 7 surfaces in DASH_TAB_PLAN;
 *   - every registry TabId appears in exactly one `sources` or
 *     `legacy_sections` bucket (audit-derived total 13);
 *   - every mergedCardId exists in the tabs/ tree by filename regex
 *     `VectorCortex*(Card|Topology).tsx|MaintenanceTab/*|MemoryMapTab/*|WikiTab/*|SetupTab/*`;
 *   - DASH_TAB_COUNT === 7;
 *   - the config sub-tab is recorded under the Setup surface as
 *     `setup_subtabs:["config"]`, NOT under admin (admin is not a TabId).
 *
 * The root build excludes `extensions/dashboard-client`, so the plan.ts module
 * is audited as shipped source text (local file read), not imported — looser
 * than a type import but the right coupling for a contract-planning sprint.
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "extensions", "dashboard-client", "src"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("dashboard-client src not found above " + from);
}
const ROOT = repoRoot(HERE);
const DASH_SRC = join(
  ROOT,
  "extensions",
  "dashboard-client",
  "src",
  "dash-consolidation",
);
const TABS_DIR = join(ROOT, "extensions", "dashboard-client", "src", "tabs");
const planSource = readFileSync(join(DASH_SRC, "plan.ts"), "utf8");
const registrySource = readFileSync(join(TABS_DIR, "registry.ts"), "utf8");

/** Content of a top-level `export const NAME = ...` block up to its terminator. */
function block(name: string): string {
  const idx = planSource.indexOf(name);
  assert.ok(idx >= 0, `plan.ts declares ${name}`);
  return planSource.slice(idx);
}

/** Pull the registry TabId union literals from registry.ts. */
function registryTabIds(): string[] {
  const start = registrySource.indexOf("export type TabId =");
  const union = registrySource.slice(start, start + registrySource.slice(start).indexOf(";"));
  const ids = [...union.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  assert.equal(ids.length, 13, "registry exposes exactly 13 TabIds");
  return ids;
}
const ALL_TAB_IDS = registryTabIds();

/** Each `{ surface: ..., sources: [...], ... }` object inside DASH_TAB_PLAN. */
function planSurfaceObjects(): { surface: string; sources: string[]; blocked: string }[] {
  const planBlock = block("DASH_TAB_PLAN: readonly DashSurfacePlan[] = [");
  const objs = [...planBlock.matchAll(/\{\s*\n\s*surface: "([a-z-]+)",[\s\S]*?\n\s*\}/g)];
  const out: { surface: string; sources: string[]; blocked: string }[] = [];
  for (const m of objs) {
    const objText = m[0];
    const sources =
      objText.match(/sources:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const srcIds = [...sources.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    out.push({ surface: m[1], sources: srcIds, blocked: m[0] });
  }
  return out;
}

/** Legacy section ids recorded in DASH_LEGACY_SECTIONS. */
function legacySectionIds(): string[] {
  const blockText = block("DASH_LEGACY_SECTIONS: readonly LegacySection[] = [");
  return [...blockText.matchAll(/id: "([a-z-]+)",/g)].map((x) => x[1]);
}

/** Deep-link target keys (all TabIds) in DEEP_LINK_TARGETS. */
function deepLinkKeys(): string[] {
  const dl = block("DEEP_LINK_TARGETS: Readonly<Record");
  const prefix = dl.indexOf("= {");
  const obj = dl.slice(prefix);
  const close = obj.indexOf("\n};");
  return [...obj.slice(0, close).matchAll(/^\s{2}"?([a-z-]+)"?: \{ surface:/gm)].map((x) => x[1]);
}

/** Every file basename under tabs/ (recursive) matching the plan card regex. */
function cardCandidates(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tsx")) out.add(name.replace(/\.tsx$/, ""));
    }
  };
  walk(TABS_DIR);
  return out;
}

describe("DASH-0a plan totals", () => {
  test("DASH_TAB_COUNT is exactly 7", () => {
    const m = /DASH_TAB_COUNT\s*=\s*(\d+)/.exec(planSource);
    assert.ok(m, "DASH_TAB_COUNT literal present");
    assert.equal(Number(m![1]), 7, "DASH_TAB_COUNT === 7");
  });

  test("DASH_TAB_PLAN declares exactly the 7 fixed surfaces", () => {
    const surfaces = planSurfaceObjects().map((o) => o.surface).sort();
    assert.deepEqual(surfaces.sort(), [
      "admin",
      "cache-perf",
      "diagnostics",
      "memory-graph",
      "overview",
      "sessions",
      "setup",
    ]);
    assert.equal(surfaces.length, 7, "7 surfaces");
  });

  test("DASH_TAB_COUNT matches the number of plan surfaces", () => {
    assert.equal(planSurfaceObjects().length, 7, "7 surfaces");
  });
});

describe("DASH-0a audit totality", () => {
  test("every current TabId appears in exactly one sources/legacy bucket (13 total)", () => {
    const surfaced = planSurfaceObjects().flatMap((o) => o.sources);
    const legacy = legacySectionIds();
    // No duplicate source TabIds, exactly the 13 registry TabIds covered.
    assert.equal(new Set(surfaced).size, surfaced.length, "no repeated source TabId");
    for (const id of ALL_TAB_IDS) {
      assert.ok(surfaced.includes(id), `current TabId not in any sources bucket: ${id}`);
    }
    // Legacy sections (topics/achievements/game) are extra kept-but-folded
    // non-surface sections — they are NOT TabIds and must not shadow a source.
    for (const id of legacy) {
      assert.ok(!ALL_TAB_IDS.includes(id), `legacy id ${id} collides with a TabId`);
      assert.ok(!surfaced.includes(id), `legacy id ${id} also listed as a source`);
    }
    assert.equal(surfaced.length, ALL_TAB_IDS.length, "13 source TabIds, each exactly once");
  });

  test("no surface collides on sources and no source is dropped", () => {
    const surfaces = planSurfaceObjects();
    const seen = new Set<string>();
    for (const o of surfaces) {
      for (const s of o.sources) {
        assert.ok(!seen.has(s), `source ${s} listed in two surfaces`);
        seen.add(s);
      }
    }
    const dropped = ALL_TAB_IDS.filter(
      (id) => !seen.has(id) && !legacySectionIds().includes(id),
    );
    assert.deepEqual(dropped, [], "no dropped source TabIds");
  });

  test("admin is NOT a registry TabId (it is a surface, not a source)", () => {
    assert.ok(!ALL_TAB_IDS.includes("admin"), "admin is not a source TabId");
    assert.ok(
      !planSurfaceObjects().flatMap((o) => o.sources).includes("admin"),
      "no surface lists admin as a source",
    );
  });
});

describe("DASH-0a deep-link coverage", () => {
  test("DEEP_LINK_TARGETS covers all 13 current TabIds as keys", () => {
    const keys = deepLinkKeys();
    for (const id of ALL_TAB_IDS) {
      assert.ok(keys.includes(id), `deep-link target missing for ${id}`);
    }
    assert.equal(new Set(keys).size, 13, "13 deep-link targets");
  });
});

describe("DASH-0a merged card provenance", () => {
  test("every mergedCardId exists as a source file by filename regex", () => {
    const candidates = cardCandidates();
    for (const o of planSurfaceObjects()) {
      const ids = [
        ...(o.blocked.match(/mergedCardIds:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
          /"([^"]+)"/g,
        ),
      ].map((x) => x[1]);
      for (const id of ids) {
        assert.ok(
          candidates.has(id) &&
            /^(VectorCortex[A-Za-z]*|MemoryMapView|RaptorTreeView|WikiPage|WikiPageControls|TopicTimeline|TopicEvolutionView|TopicEvolutionGraph|ActionsCard|DbStatsCard|DebugBundleCard|HealthMitigationCard|SchemaHealthCard|SettingsPanel|SettingsSection|ThresholdsPanel|CortexSetup|EmbedderSetup|CortexActionsCard|CortexBlockersCard|CortexEncoderCard|CortexRuntimeCard|EmbedderHealthCard|RagHealthCard|CustomEndpointSection|VectorCortexCosineFpCard|VectorCortexRepoCorpusCard)$/.test(
            id,
          ),
          `plan card id not found on disk: ${id} (${o.surface})`,
        );
      }
    }
  });
});

describe("DASH-0a setup sub-tab placement", () => {
  test("config sub-tab recorded under the Setup surface as setup_subtabs, NOT admin", () => {
    const setup = planSurfaceObjects().find((o) => o.surface === "setup");
    assert.ok(setup, "setup surface present");
    assert.match(setup!.blocked, /setup_subtabs:\s*\["config"\]/, "setup_subtabs:[\"config\"]");
    const admin = planSurfaceObjects().find((o) => o.surface === "admin");
    assert.ok(admin, "admin surface present");
    assert.doesNotMatch(
      admin!.blocked,
      /setup_subtabs/,
      "admin does not own setup sub-tabs",
    );
  });
});
