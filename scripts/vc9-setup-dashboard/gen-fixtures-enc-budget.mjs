#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures-enc-budget.mjs — ENC-2a native install
 * budget knob conformance fixtures.
 *
 * Sibling of gen-fixtures-vc9a..vc9d.mjs. Generates the ENC-BUDGET-001..004
 * fixtures under conformance/vector-cortex/v2/enc-budget/ against the SHARED
 * `schemas/enc-budget-fixture.schema.json`.
 *
 * Pins the four behaviors of the operator-configurable
 * `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` knob:
 *   - 001: default fallback when unset → 300 MiB (installBudgetMib() resolves
 *          to the default).
 *   - 002: operator override honored within clamp (e.g. 512).
 *   - 003: out-of-clamp input (9000) falls back to the default.
 *   - 004: non-numeric input ("abc") falls back to the default.
 *
 * Registers owner `ENC-2a` in the v2 manifest and re-sorts to canonical form.
 * Idempotent: re-running reproduces byte-identical committed fixtures and does
 * not drift the manifest sha256s for unrelated rows.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/vc9-setup-dashboard/gen-fixtures-enc-budget.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const BUDGET_DIR = join(V2, "enc-budget");
const SCHEMA_REL = "schemas/enc-budget-fixture.schema.json";

export const producer = "scripts/vc9-setup-dashboard/gen-fixtures-enc-budget.mjs";

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

// ── ENC-2a enc-budget fixtures ──────────────────────────────────────────────

const fixtures = [
  {
    id: "ENC-BUDGET-001",
    kind: "default-fallback",
    flag: "MEGACOMPACT_ENC_2BUDGET",
    env_state: null,
    expected_effective_mib: 300,
    assertion:
      "installBudgetMib() resolves to the 300 MiB default when MEGACOMPACT_NATIVE_ORT_BUDGET_MIB is unset",
  },
  {
    id: "ENC-BUDGET-002",
    kind: "operator-override",
    flag: "MEGACOMPACT_ENC_2BUDGET",
    env_state: "512",
    expected_effective_mib: 512,
    assertion:
      "installBudgetMib() honors a positive-integer operator override within the 8192 clamp (512 → 512)",
  },
  {
    id: "ENC-BUDGET-003",
    kind: "out-of-clamp-fallback",
    flag: "MEGACOMPACT_ENC_2BUDGET",
    env_state: "9000",
    expected_effective_mib: 300,
    assertion:
      "installBudgetMib() rejects input over the 8192 clamp (9000 → 300 default fallback)",
  },
  {
    id: "ENC-BUDGET-004",
    kind: "non-numeric-fallback",
    flag: "MEGACOMPACT_ENC_2BUDGET",
    env_state: "abc",
    expected_effective_mib: 300,
    assertion:
      "installBudgetMib() rejects non-numeric input (abc → 300 default fallback)",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(BUDGET_DIR, { recursive: true });

  // Write the schema (a stable canonical JSON document).
  const schema = {
    $schema: "https://json-schema.org/draft-07/schema#",
    title: "ENC-2a native install budget fixture envelope",
    description:
      "Common structure every ENC-2a enc-budget fixture validates against. `kind` names the knob behavior exercised; `env_state` is the raw string value of MEGACOMPACT_NATIVE_ORT_BUDGET_MIB (null when unset); `expected_effective_mib` pins the integer installBudgetMib() must resolve to.",
    type: "object",
    required: [
      "id",
      "producer",
      "assertion",
      "kind",
      "flag",
      "env_state",
      "expected_effective_mib",
    ],
    properties: {
      id: { type: "string" },
      producer: { type: "string" },
      assertion: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "default-fallback",
          "operator-override",
          "out-of-clamp-fallback",
          "non-numeric-fallback",
        ],
      },
      flag: { type: "string" },
      env_state: { type: ["string", "null"] },
      expected_effective_mib: { type: "integer", minimum: 1, maximum: 8192 },
    },
  };
  const schemaPath = join(V2, SCHEMA_REL);
  const schemaBytes = Buffer.from(canonicalJson(schema), "utf8");
  writeFileSync(schemaPath, schemaBytes);

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];

  // Register the schema in the manifest.
  {
    const existing = manifest.fixtures.find((r) => r.path === SCHEMA_REL);
    if (existing) existing.sha256 = sha256Hex(schemaBytes);
    else {
      manifest.fixtures.push({
        id: "enc-budget-fixture",
        path: SCHEMA_REL,
        sha256: sha256Hex(schemaBytes),
        schema: "self",
        algorithm: "schema",
        producer,
        expected: "ok",
        license: "synthetic",
      });
    }
  }

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REL, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `enc-budget/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "enc-budget",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const setSem = (field, token) => {
    const list = manifest[field].split(";").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(";");
  };
  const setOwnerCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setOwnerCsv("owner", "ENC-2a");
  setSem("domain", "enc-budget");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-enc-budget.mjs")) {
  const { fixtureCount } = writeAll();
  console.log(`vc9-setup-dashboard/enc-budget: wrote ${fixtureCount} fixtures + 1 schema, manifest updated.`);
}
