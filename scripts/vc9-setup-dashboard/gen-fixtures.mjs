#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures.mjs — VC9A setup-cortex conformance fixtures.
 *
 * Standalone generator for the SETUP-CORTEX-001..009 fixtures + the
 * setup-cortex-fixture schema, committed under conformance/vector-cortex/v2/
 * (setup-dashboard/ + schemas/). Unlike the domain generators that rebuild the
 * whole corpus, the main coordinate with vector-cortex-gen-fixtures.mjs is the
 * shared manifest.json: this script READS the existing v2 manifest, appends
 * its rows (the 9 fixtures + 1 schema row), updates the manifest's
 * domain/schemaVersion/owner strings to include this sprint's seam, re-sorts,
 * and rewrites the manifest — leaving every pre-existing fixture file and its
 * sha256 untouched.
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/vc9-setup-dashboard/gen-fixtures.mjs`, then
 * commit the emitted files. The committed files are authoritative.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/vc9-setup-dashboard/ -> repo root -> conformance/vector-cortex/v2
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const SETUP_DIR = join(V2, "setup-dashboard");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "vc9-setup-dashboard/gen-fixtures.mjs";

// ── Canonical JSON (byte-identical algorithm to the rest of the corpus) ─────

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

// ── Schema ──────────────────────────────────────────────────────────────────

const SETUP_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC9A setup-cortex fixture envelope",
  type: "object",
  description:
    "Common structure every VC9A setup-cortex fixture validates against. `mode` pins the effective encoder triad mode the read path projects; `flag_enabled` pins the VC9A flag state; `asset_digest_prefix` is the first-12 hex of the asset-manifest digest (null when absent / flag-off); `qualification_verdict` pins the reader-only qualification projection (qualified / demoted / unavailable); `threshold_failures` lists the demotion codes surfaced; `blocker_ids` pins the canonical open hard-gate blocker set; `expected_status` pins the deriveVcStatus result; `expected_body_shape` pins the body-shape class (full / flag-off / blockers-only / payload-free).",
  required: [
    "id",
    "producer",
    "assertion",
    "kind",
    "mode",
    "flag_enabled",
    "qualification_verdict",
    "threshold_failures",
    "blocker_ids",
    "expected_status",
    "expected_body_shape",
  ],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["setup-cortex"] },
    mode: { type: "string", enum: ["A", "B", "C"] },
    flag_enabled: { type: "boolean" },
    asset_digest_prefix: { type: ["string", "null"] },
    qualification_verdict: {
      type: "string",
      enum: ["qualified", "demoted", "unavailable"],
    },
    threshold_failures: { type: "array", items: { type: "string" } },
    blocker_ids: { type: "array", items: { type: "string" } },
    expected_status: {
      type: "string",
      enum: ["structural", "off", "live", "awaiting_data", "deferred"],
    },
    expected_body_shape: {
      type: "string",
      enum: ["full", "flag-off", "blockers-only", "payload-free"],
    },
  },
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_BLOCKERS = ["HG-1", "HG-3", "HG-4", "HG-5"];

const fixtures = [
  {
    id: "SETUP-CORTEX-001",
    assertion: "mode A projects qualified with the 4 canonical open blockers and a structural status",
    kind: "setup-cortex",
    mode: "A",
    flag_enabled: true,
    asset_digest_prefix: "0123456789ab",
    qualification_verdict: "qualified",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "full",
  },
  {
    id: "SETUP-CORTEX-002",
    assertion: "mode B demotion projects a non-empty threshold failure and a structural status",
    kind: "setup-cortex",
    mode: "B",
    flag_enabled: true,
    asset_digest_prefix: "0123456789ab",
    qualification_verdict: "demoted",
    threshold_failures: ["ENC_DIGEST_MISMATCH"],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "full",
  },
  {
    id: "SETUP-CORTEX-003",
    assertion: "mode C asset-missing projects unavailable with a null digest prefix",
    kind: "setup-cortex",
    mode: "C",
    flag_enabled: true,
    asset_digest_prefix: null,
    qualification_verdict: "unavailable",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "full",
  },
  {
    id: "SETUP-CORTEX-004",
    assertion: "flag-off projects enabled false, mode C, empty blockers, off status",
    kind: "setup-cortex",
    mode: "C",
    flag_enabled: false,
    asset_digest_prefix: null,
    qualification_verdict: "unavailable",
    threshold_failures: [],
    blocker_ids: [],
    expected_status: "off",
    expected_body_shape: "flag-off",
  },
  {
    id: "SETUP-CORTEX-005",
    assertion: "the blockers set is canonical: HG-1, HG-3, HG-4, HG-5 (opset removed)",
    kind: "setup-cortex",
    mode: "B",
    flag_enabled: true,
    asset_digest_prefix: null,
    qualification_verdict: "demoted",
    threshold_failures: ["ENC_PLATFORM_UNSUPPORTED"],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "blockers-only",
  },
  {
    id: "SETUP-CORTEX-006",
    assertion: "each canonical blocker row carries a blocker/high/medium severity and stays open",
    kind: "setup-cortex",
    mode: "B",
    flag_enabled: true,
    asset_digest_prefix: null,
    qualification_verdict: "demoted",
    threshold_failures: ["ENC_OPSET_INVALID"],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "blockers-only",
  },
  {
    id: "SETUP-CORTEX-007",
    assertion: "the qualification verdict enum is closed to qualified/demoted/unavailable",
    kind: "setup-cortex",
    mode: "A",
    flag_enabled: true,
    asset_digest_prefix: "fedcba987654",
    qualification_verdict: "qualified",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "full",
  },
  {
    id: "SETUP-CORTEX-008",
    assertion: "flag-on keeps the hard-gate blockers surfaced regardless of mode",
    kind: "setup-cortex",
    mode: "C",
    flag_enabled: true,
    asset_digest_prefix: null,
    qualification_verdict: "unavailable",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "blockers-only",
  },
  {
    id: "SETUP-CORTEX-009",
    assertion: "the setup-cortex read body is payload-free (digest prefixes + codes only)",
    kind: "setup-cortex",
    mode: "A",
    flag_enabled: true,
    asset_digest_prefix: "0123456789ab",
    qualification_verdict: "qualified",
    threshold_failures: [],
    blocker_ids: CANONICAL_BLOCKERS,
    expected_status: "structural",
    expected_body_shape: "payload-free",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(SETUP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  // The schema row.
  const schemaBytes = Buffer.from(canonicalJson(SETUP_SCHEMA), "utf8");
  const schemaRel = "schemas/setup-cortex-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "setup-cortex-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 9 fixture rows + on-disk files.
  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/setup-cortex-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `setup-dashboard/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "setup-cortex",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  // Merge into the existing manifest (id-dedupe so re-runs are idempotent).
  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Update the seam header strings to include this sprint's domain.
  const setCsv = (field, token) => {
    const list = manifest[field].split(";").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    // Keep a canonical order for readability: sort the seam tokens.
    manifest[field] = list.sort().join(";");
  };
  const setOwnerCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setCsv("domain", "setup-dashboard");
  setCsv("schemaVersion", "setup-cortex-fixture");
  setOwnerCsv("owner", "VC9A");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`vc9-setup-dashboard: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
