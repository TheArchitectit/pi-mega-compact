#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures-vc9c.mjs — VC9C SetupTab Cortex UI fixtures.
 *
 * Sibling of gen-fixtures.mjs (VC9A) and gen-fixtures-vc9b.mjs (VC9B). Generates
 * the SETUP-CORTEX-020..022 UI fixtures + the setup-cortex-ui-fixture schema
 * under conformance/vector-cortex/v2/ (setup-dashboard/ + schemas/). This script
 * READS the existing v2 manifest, appends its rows (3 fixtures + 1 schema row),
 * updates the manifest's owner strings to include this sprint's seam, re-sorts,
 * and rewrites the manifest — leaving every pre-existing fixture file and its
 * sha256 untouched (same id-dedupe + seam-header convention as the siblings).
 *
 * Each fixture is a SEMANTIC UI envelope driving the SetupTab Cortex sub-tab's
 * render / hide / badge rules from committed data:
 *   - 020: the sub-tab renders mode A/B/C deterministically (drives the
 *     encoder-card projection) — render_modes + a representative projection.
 *   - 021: flag-off hides the sub-tab (off/disabled shape -> filtered from
 *     SUB_TABS) — status:"off" / enabled:false -> expected_subtab_visible:false.
 *   - 022: the poll hook drives the VcStatusBadge correctly across the
 *     live/awaiting_data/deferred/off status values (status_badge_pairs matrix).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/vc9-setup-dashboard/gen-fixtures-vc9c.mjs`,
 * then commit the emitted files. The committed files are authoritative.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const SETUP_DIR = join(V2, "setup-dashboard");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "vc9-setup-dashboard/gen-fixtures-vc9c.mjs";

export function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number") return String(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return canonicalValue(value) + "\n";
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── UI-fixture schema ────────────────────────────────────────────────────────

const UI_STATUS_ENUM = ["live", "awaiting_data", "deferred", "structural", "off"];

const UI_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC9C SetupTab Cortex UI-fixture envelope",
  type: "object",
  description:
    "Common structure every VC9C SetupTab Cortex UI fixture validates against. These are SEMANTIC envelpes driving the Cortex sub-tab's render / hide / badge rules from committed data. `mode` pins the effective encoder triad mode the sub-tab projects; `flag_enabled` pins the VC9C/VC9A flag state; `status` pins the deriveVcStatus status field the badge consumes; `expected_subtab_visible` pins whether the sub-tab is listed in SUB_TABS; `expected_badge` pins the VcStatusBadge the poll hook drives; `verdict`/`threshold_failures`/`blocker_ids` pin the encoder-card projection; `render_modes` pins the mode A/B/C set the sub-tab renders deterministically; `status_badge_pairs` pins the status -> badge matrix the poll hook must satisfy.",
  required: ["id", "producer", "assertion", "kind"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["setup-cortex-ui"] },
    mode: { type: "string", enum: ["A", "B", "C"] },
    flag_enabled: { type: "boolean" },
    status: { type: "string", enum: UI_STATUS_ENUM },
    expected_subtab_visible: { type: "boolean" },
    expected_badge: { type: ["string", "null"] },
    verdict: { type: "string", enum: ["qualified", "demoted", "unavailable"] },
    threshold_failures: { type: "array", items: { type: "string" } },
    blocker_ids: { type: "array", items: { type: "string" } },
    render_modes: {
      type: "array",
      items: { type: "string", enum: ["A", "B", "C"] },
    },
    status_badge_pairs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          status: { type: "string", enum: UI_STATUS_ENUM },
          expected_badge: { type: "string", enum: UI_STATUS_ENUM },
        },
      },
    },
  },
};

const CANONICAL_BLOCKERS = ["HG-1", "HG-3", "HG-4", "HG-5"];

// ── Fixtures (SETUP-CORTEX-020..022) ────────────────────────────────────────

const fixtures = [
  {
    id: "SETUP-CORTEX-020",
    assertion:
      "the Cortex sub-tab renders mode A/B/C deterministically: the encoder-card projection (mode, verdict, threshold failures) is stable and the sub-tab stays visible",
    kind: "setup-cortex-ui",
    mode: "A",
    flag_enabled: true,
    status: "structural",
    expected_subtab_visible: true,
    expected_badge: "structural",
    verdict: "qualified",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    render_modes: ["A", "B", "C"],
  },
  {
    id: "SETUP-CORTEX-021",
    assertion:
      "flag-off hides the Cortex sub-tab: the off/disabled shape (status:off, enabled:false) filters the sub-tab from SUB_TABS and leaks no blockers",
    kind: "setup-cortex-ui",
    mode: "C",
    flag_enabled: false,
    status: "off",
    expected_subtab_visible: false,
    expected_badge: "off",
    verdict: "unavailable",
    threshold_failures: [],
    blocker_ids: [],
    render_modes: [],
  },
  {
    id: "SETUP-CORTEX-022",
    assertion:
      "the poll hook drives the VcStatusBadge correctly across the live/awaiting_data/deferred/off status values (the badge mirrors the status field)",
    kind: "setup-cortex-ui",
    mode: "C",
    flag_enabled: true,
    status: "off",
    expected_subtab_visible: false,
    expected_badge: "off",
    status_badge_pairs: [
      { status: "live", expected_badge: "live" },
      { status: "awaiting_data", expected_badge: "awaiting_data" },
      { status: "deferred", expected_badge: "deferred" },
      { status: "off", expected_badge: "off" },
    ],
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(SETUP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(UI_SCHEMA), "utf8");
  const schemaRel = "schemas/setup-cortex-ui-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "setup-cortex-ui-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/setup-cortex-ui-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `setup-dashboard/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "setup-cortex-ui",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const setOwnerCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setOwnerCsv("owner", "VC9C");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-vc9c.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`vc9-setup-dashboard/vc9c: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
