#!/usr/bin/env node
/**
 * scripts/dash-consolidation/gen-fixtures.mjs — DASH-0D conformance fixtures.
 *
 * Emits the DASH-0d route-surface conformance fixtures DASH-0D-001..004 under
 * `conformance/vector-cortex/v2/dashboard-consolidation/` in canonical JSON form
 * (UTF-8, NFC keys sorted by UTF-8 bytes, shortest-number repr, final LF) —
 * the exact form `node scripts/vector-cortex-conformance.mjs --check` validates.
 *
 *   - DASH-0D-001: the merged dashboard exposes exactly 7 top-level surfaces.
 *   - DASH-0D-002: every legacy hash deep-link resolves to a live surface.
 *   - DASH-0D-003: flag-off reproduces the 13-surface lazy list byte-identically.
 *   - DASH-0D-004: the a11y audit passes serious/critical-clean on the merged
 *     surfaces (nav-map satisfied).
 *
 * Manifest rows (owner `DASH-0D` + algorithm `dashboard-consolidation`) are
 * registered by the DASH-0d roll-up directly (see the sprint build notes); this
 * script only (re)writes the on-disk fixture bytes so a re-run can never drift.
 *
 * LOCAL ONLY: filesystem writes, zero network (PREVENT-PI-004).
 *
 * Usage: node scripts/dash-consolidation/gen-fixtures.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V2 = join(root, "conformance", "vector-cortex", "v2");
const manifestPath = join(V2, "manifest.json");
const DIR = join(V2, "dashboard-consolidation");
const SCHEMA = "schemas/dashboard-consolidation-fixture.schema.json";
const PRODUCER = "DASH-0d-rollup-accessibility-lazyload-flags";

/** The 7 consolidated surfaces (DASH-0a merge plan / DASH-SURFACE-IDS). */
const SURFACES = [
  "overview", "sessions", "cache-perf", "memory-graph", "diagnostics", "setup", "admin",
];

/** Legacy hash → consolidated surface (DASH-0a DEEP_LINK_TARGETS + release aliases). */
const DEEP_LINK_MAP = {
  sessions: "sessions", turns: "sessions",
  cache: "cache-perf", metrics: "cache-perf",
  "memory-map": "memory-graph", repos: "memory-graph", wiki: "memory-graph",
  "vector-cortex": "diagnostics", events: "diagnostics", health: "diagnostics",
  maintenance: "admin", config: "admin", setup: "setup", overview: "overview",
};

/** Canonical JSON: shortest numbers, keys sorted by UTF-8 code-unit order. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : JSON.stringify(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const FIXTURES = [
  {
    assertion: "the merged dashboard exposes exactly 7 top-level navigational surfaces",
    expected: {
      surfaces: 7,
      expected_surfaces: SURFACES,
    },
  },
  {
    assertion: "every legacy hash deep-link resolves to a live consolidated surface (no dead surface)",
    expected: {
      resolves: true,
      deep_link_matrix: Object.entries(DEEP_LINK_MAP).map(([hash, surface]) => ({
        hash: `#${hash}`,
        surface,
        resolves: true,
      })),
    },
  },
  {
    assertion: "flag-off reproduces the pre-rollup 13-surface lazy list byte-identically",
    expected: {
      flag_enabled: false,
      surfaces: 13,
      byte_identical: true,
    },
  },
  {
    assertion: "the a11y audit passes serious/critical-clean on the merged surfaces (nav map satisfied)",
    expected: {
      surfaces: 7,
      serious_critical_violations: 0,
      nav_map_satisfied: true,
    },
  },
];

mkdirSync(DIR, { recursive: true });

function emit(id, index) {
  const data = {
    id,
    producer: PRODUCER,
    assertion: FIXTURES[index].assertion,
    kind: "dashboard-tab-plan",
    schema: SCHEMA,
    expected: FIXTURES[index].expected,
  };
  const bytes = Buffer.from(canonicalJson(data) + "\n", "utf8");
  const file = join(DIR, `${id}.json`);
  writeFileSync(file, bytes);
  return file;
}

const written = [];
for (let i = 0; i < FIXTURES.length; i++) {
  const id = `DASH-0D-00${i + 1}`;
  written.push(emit(id, i));
}
for (const f of written) console.log(`wrote ${f}`);

// ── Manifest registration (owner +DASH-0D, rows + sha256, canonical write) ──

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
function shaOf(file) {
  // sha256 over the fixture's canonical on-disk bytes (file already ends \n).
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return sha256Hex(Buffer.from(canonicalJson(parsed) + "\n", "utf8"));
}

function registerManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const owners = (manifest.owner ?? "").split(",").map((s) => s.trim());
  if (!owners.includes("DASH-0D")) owners.push("DASH-0D");
  manifest.owner = owners.filter(Boolean).join(",");

  const expectedBy = { "DASH-0D-001": "ok", "DASH-0D-002": "ok", "DASH-0D-003": "flag-off", "DASH-0D-004": "ok" };
  for (const file of written) {
    const id = file.split("/").pop().replace(".json", "");
    const rel = `dashboard-consolidation/${id}.json`;
    const existing = manifest.fixtures.findIndex((f) => f.id === id && f.path === rel);
    const row = {
      algorithm: "dashboard-consolidation",
      expected: expectedBy[id],
      id,
      license: "synthetic",
      path: rel,
      producer: PRODUCER,
      schema: SCHEMA,
      sha256: shaOf(file),
    };
    if (existing >= 0) manifest.fixtures[existing] = row;
    else manifest.fixtures.push(row);
  }

  const bytes = Buffer.from(canonicalJson(manifest) + "\n", "utf8");
  writeFileSync(manifestPath, bytes);
  const total = manifest.fixtures.length;
  console.log(`✓ manifest: owner +DASH-0D, ${manifest.fixtures.length} fixture rows registered (${total - 940 > 0 ? "" : ""}${total}).`);
  return total;
}

const total = registerManifest();
console.log(`✓ DASH-0D: ${FIXTURES.length} fixture(s) written; manifest now lists ${total} fixtures.`);
