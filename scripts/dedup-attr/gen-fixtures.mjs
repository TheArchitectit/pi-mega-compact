#!/usr/bin/env node
/**
 * dedup-attr/gen-fixtures.mjs — DEDUP-ATTR tier-attribution fixtures.
 *
 * Generates the DEDUP-ATTR-001..004 fixtures + the dedup-attribution-fixture
 * schema under conformance/vector-cortex/v2/ (dedup-attribution/ + schemas/).
 * This script READS the existing v2 manifest, appends its rows (4 fixtures +
 * 1 schema row), updates the manifest's domain + owner strings to include this
 * sprint's seam, re-sorts, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (same id-dedupe +
 * seam-header convention as the vc9b generator).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these, so regeneration is idempotent (re-running reproduces byte-identical
 * output).
 *
 * REGENERATION: run `node scripts/dedup-attr/gen-fixtures.mjs`, then commit the
 * emitted files. The committed files are authoritative.
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
const DEDUP_DIR = join(V2, "dedup-attribution");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "scripts/dedup-attr/gen-fixtures.mjs";

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

// ── Dedup-attribution fixture schema ─────────────────────────────────────────

const DEDUP_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "DEDUP-ATTR tier-attribution fixture envelope",
  type: "object",
  description:
    "Common structure every DEDUP-ATTR fixture validates against. `scenario` pins the failure-triad/reasoning case the fixture documents (non-empty / empty / flag-off / pure); `total_decisions` pins the rolled-up window decision count; `shares_sum_to_one` pins whether the l0+l1+l2 shares of that window sum to exactly 1.0; `expected_status` pins the shared deriveVcStatus status the endpoint reports for the case; `kind` pins the algorithm.",
  required: ["id", "producer", "assertion", "kind", "scenario"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    schema: { type: "string" },
    kind: { type: "string", enum: ["dedup-attribution"] },
    scenario: {
      type: "string",
      enum: ["non-empty", "empty", "flag-off", "pure"],
    },
    total_decisions: { type: "integer" },
    shares_sum_to_one: { type: "boolean" },
    expected_status: {
      type: "string",
      enum: ["live", "awaiting_data", "off"],
    },
  },
};

// ── Fixtures (DEDUP-ATTR-001..004) ───────────────────────────────────────────

const fixtures = [
  {
    id: "DEDUP-ATTR-001",
    assertion:
      "non-empty window returns shares summing to 1.0 with status live — the endpoint reports real parsed tiers, not zeros",
    kind: "dedup-attribution",
    scenario: "non-empty",
    total_decisions: 4,
    shares_sum_to_one: true,
    expected_status: "live",
  },
  {
    id: "DEDUP-ATTR-002",
    assertion:
      "empty window returns totalDecisions 0 + zero shares + status awaiting_data — NOT a fabricated zero-share table presented as real (blocks the dashboards-zero bug class)",
    kind: "dedup-attribution",
    scenario: "empty",
    total_decisions: 0,
    shares_sum_to_one: false,
    expected_status: "awaiting_data",
  },
  {
    id: "DEDUP-ATTR-003",
    assertion:
      "flag-off returns 404 with no rollup cache file write — byte-identical to the predecessor",
    kind: "dedup-attribution",
    scenario: "flag-off",
    total_decisions: 0,
    shares_sum_to_one: false,
    expected_status: "off",
  },
  {
    id: "DEDUP-ATTR-004",
    assertion:
      "rollup is pure — two calls with the same events + window + now are deep-equal (determinism)",
    kind: "dedup-attribution",
    scenario: "pure",
    total_decisions: 4,
    shares_sum_to_one: true,
    expected_status: "live",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(DEDUP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(DEDUP_SCHEMA), "utf8");
  const schemaRel = "schemas/dedup-attribution-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "dedup-attribution-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = {
      ...fx,
      schema: "schemas/dedup-attribution-fixture.schema.json",
      producer,
    };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `dedup-attribution/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "dedup-attribution",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const setCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setCsv("domain", "dedup-attribution");
  setCsv("owner", "DEDUP-ATTR");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(
    `dedup-attr: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`,
  );
}
