#!/usr/bin/env node
/**
 * scripts/dash-tab-count.mjs — DASH-0d 7-surface tab-count verifier.
 *
 * Statically reads the dashboard client's consolidated-lazy-list surface set:
 *   - App.tsx `TabContent` switch (the consolidation point),
 *   - tabs/registry.ts `DASH_SURFACE_IDS` (the fixed 7 surface ids) + the
 *     legacy 13-tab `TabId` union,
 * and asserts exactly **7 top-level navigational surfaces** when
 * `MEGACOMPACT_DASH_0D=1` (the default) and **13** when `=0`. Prints the 13→7
 * accounting and the hash deep-link resolution. Exits non-zero on any deviation.
 *
 * Flag contract (DASH-0d): flag-ON renders the 7 consolidated surfaces (the
 * `DASH-0D-CONSOLIDATED` region of the TabContent switch, one branch per
 * DASH_SURFACE_IDS member); flag-OFF reproduces the pre-rollup 13-tab list
 * (the `DASH-0D-LEGACY` region), byte-identical to DASH-0c.
 *
 * LOCAL ONLY: reads the two client source files, zero network (PREVENT-PI-004).
 *
 * Usage: node scripts/dash-tab-count.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(root, "extensions", "dashboard-client", "src", "App.tsx");
const REGISTRY = join(root, "extensions", "dashboard-client", "src", "tabs", "registry.ts");

// ── The authoritative surface sets ─────────────────────────────────────────

/** The 13 pre-rollup top-level TabIds (DASH-0a audit source; flag-off set). */
const LEGACY_13 = [
  "overview", "repos", "events", "setup", "metrics", "cache", "sessions",
  "wiki", "turns", "maintenance", "memory-map", "health", "vector-cortex",
];

/** The 7 consolidated surfaces (DASH-0a merge plan); must match registry. */
const CONSOLIDATED_7 = [
  "overview", "sessions", "cache-perf", "memory-graph", "diagnostics", "setup", "admin",
];

/** Legacy hash → consolidated surface (DASH-0a DEEP_LINK_TARGETS + spec aliases). */
const HASH_TO_SURFACE = {
  overview: "overview", sessions: "sessions", turns: "sessions",
  cache: "cache-perf", metrics: "cache-perf",
  "memory-map": "memory-graph", repos: "memory-graph", wiki: "memory-graph",
  "vector-cortex": "diagnostics", events: "diagnostics", health: "diagnostics",
  setup: "setup", config: "admin", maintenance: "admin",
};

// ── Parsers ────────────────────────────────────────────────────────────────

/** Collect the `activeTab === "<id>"` branch ids within a source region. */
function branchIds(region) {
  const ids = [];
  const re = /activeTab\s*===\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(region)) !== null) ids.push(m[1]);
  return ids;
}

function regionBetween(src, startAnchor, endAnchor) {
  const s = src.indexOf(startAnchor);
  if (s < 0) return null;
  const from = s + startAnchor.length;
  const e = src.indexOf(endAnchor, from);
  if (e < 0) return null;
  return src.slice(from, e);
}

// ── Verify ────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`DASH-TAB-COUNT: ${msg}`);
  process.exitCode = 1;
}

const flagOn = !(process.env.MEGACOMPACT_DASH_0D === "0" || process.env.MEGACOMPACT_DASH_0D === "false");
const expectedCount = flagOn ? 7 : 13;

const appSrc = readFileSync(APP, "utf8");
const regSrc = readFileSync(REGISTRY, "utf8");

// Anchor on the JSX marker COMMENTS so the doc-header prose (which also names
// the regions) never mis-matches. `{/* DASH-0D-LEGACY */}` ≠ `DASH-0D-LEGACY`.
const CONS_START = "{/* DASH-0D-CONSOLIDATED */}";
const CONS_END = "{/* DASH-0D-CONSOLIDATED-END */}";
const LEG_START = "{/* DASH-0D-LEGACY */}";
const LEG_END = "{/* DASH-0D-LEGACY-END */}";

// 1) Registry: the 7 consolidated surface ids must be declared.
const dashSurfaceIds = CONSOLIDATED_7.filter((id) =>
  new RegExp(`"${id}"`).test(regionBetween(regSrc, "DASH_SURFACE_IDS", "];") ?? ""),
);
for (const id of CONSOLIDATED_7) {
  if (!dashSurfaceIds.includes(id)) fail(`registry DASH_SURFACE_IDS missing "${id}"`);
}

// 2) TabContent flag-ON consolidated region: exactly the 7 surfaces.
const consolidatedRegion = regionBetween(appSrc, CONS_START, CONS_END);
if (!consolidatedRegion) {
  fail('App.tsx TabContent missing the DASH-0D-CONSOLIDATED region');
} else {
  const cons = [...new Set(branchIds(consolidatedRegion))];
  for (const id of CONSOLIDATED_7) {
    if (!cons.includes(id)) fail(`consolidated TabContent missing surface "${id}"`);
  }
  for (const id of cons) {
    if (!CONSOLIDATED_7.includes(id)) fail(`consolidated TabContent has EXTRA surface "${id}"`);
  }
  if (cons.length !== 7) fail(`consolidated TabContent has ${cons.length} surfaces (expected 7)`);
}

// 3) TabContent flag-OFF legacy region: the 13 pre-rollup surfaces.
const legacyRegion = regionBetween(appSrc, LEG_START, LEG_END);
if (!legacyRegion) {
  fail('App.tsx TabContent missing the DASH-0D-LEGACY region');
} else {
  const legacy = [...new Set(branchIds(legacyRegion))];
  for (const id of LEGACY_13) {
    if (!legacy.includes(id)) fail(`legacy TabContent missing tab "${id}"`);
  }
  for (const id of legacy) {
    if (!LEGACY_13.includes(id)) fail(`legacy TabContent has EXTRA tab "${id}"`);
  }
  if (legacy.length !== 13) fail(`legacy TabContent has ${legacy.length} tabs (expected 13)`);
}

// 4) Flag-agnostic deep-link audit: every legacy tab resolves to a live surface.
const deepLinkTable = Object.entries(HASH_TO_SURFACE).map(([hash, surface]) => {
  const live = CONSOLIDATED_7.includes(surface);
  if (!live) fail(`deep-link #${hash} resolves to retired surface "${surface}"`);
  return `#${hash.padEnd(13)} → ${surface}${live ? "" : " (DEAD)"}`;
});

// ── Report ────────────────────────────────────────────────────────────────

console.log(`DASH-TAB-COUNT: MEGACOMPACT_DASH_0D=${flagOn ? 1 : 0}`);
console.log(`  consolidated surfaces (flag-ON):  ${CONSOLIDATED_7.join(", ")}`);
console.log(`  legacy tabs (flag-OFF):           ${LEGACY_13.length}`);
console.log(`  expected count for this flag:     ${expectedCount}`);
console.log("");
console.log("  13 → 7 accounting:");
const merged = [
  ["overview", "overview"],
  ["sessions, turns", "sessions"],
  ["cache, metrics", "cache-perf"],
  ["memory-map, repos, wiki", "memory-graph"],
  ["vector-cortex, events, health", "diagnostics"],
  ["setup", "setup"],
  ["maintenance", "admin"],
];
for (const [from, to] of merged) {
  const n = from.split(",").map((s) => s.trim()).filter(Boolean).length;
  console.log(`    ${n} → 1  (${from})  →  ${to}`);
}
console.log("");
console.log("  deep-link resolution (all legacy hashes):");
for (const line of deepLinkTable) console.log(`    ${line}`);

if (process.exitCode) {
  console.error(`DASH-TAB-COUNT: FAILED (flag-${flagOn ? "ON" : "OFF"} expected ${expectedCount} surfaces)`);
  process.exit(1);
}
console.log(`✓ DASH-TAB-COUNT: exactly ${expectedCount} surface(s) under MEGACOMPACT_DASH_0D=${flagOn ? 1 : 0}.`);
