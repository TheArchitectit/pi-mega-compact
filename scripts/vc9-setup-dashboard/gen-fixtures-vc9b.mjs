#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures-vc9b.mjs — VC9B setup-cortex action fixtures.
 *
 * Sibling of gen-fixtures.mjs (VC9A). Generates the SETUP-CORTEX-010..013
 * fixtures + the setup-cortex-action-fixture schema under
 * conformance/vector-cortex/v2/ (setup-dashboard/ + schemas/). This script READS
 * the existing v2 manifest, appends its rows (4 fixtures + 1 schema row),
 * updates the manifest's owner strings to include this sprint's seam, re-sorts,
 * and rewrites the manifest — leaving every pre-existing fixture file and its
 * sha256 untouched (same id-dedupe + seam-header convention as gen-fixtures.mjs).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/vc9-setup-dashboard/gen-fixtures-vc9b.mjs`,
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

export const producer = "vc9-setup-dashboard/gen-fixtures-vc9b.mjs";

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

// ── Action fixture schema ────────────────────────────────────────────────────

const ACTION_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC9B setup-cortex action fixture envelope",
  type: "object",
  description:
    "Common structure every VC9B setup-cortex action fixture validates against. `flag_enabled` pins the VC9B flag state; `action` pins the driver action kind; `confirm` pins the required confirm:true gate; `expected_status_code` pins the HTTP status the route returns; `error` pins the machine error code (or null on success); `blocker_ids` pins the open hard-gate ids surfaced when the action is blocked; `no_spawn` pins that a subprocess must NOT be spawned; `expected_body_shape` pins the body class (action-result / blocked / confirm-rejected / disabled / method-not-allowed / log-tail); `log_tail_bounded_kib` + `log_redacted` pin the log-tail endpoint guarantees.",
  required: [
    "id",
    "producer",
    "assertion",
    "kind",
    "flag_enabled",
    "expected_body_shape",
  ],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["setup-cortex-action"] },
    flag_enabled: { type: "boolean" },
    action: { type: "string", enum: ["fetch-model", "bench", "verify-asset"] },
    confirm: { type: "boolean" },
    expected_status_code: {
      type: "integer",
      enum: [200, 400, 405, 423, 404],
    },
    error: { type: ["string", "null"] },
    blocker_ids: { type: "array", items: { type: "string" } },
    no_spawn: { type: "boolean" },
    expected_body_shape: {
      type: "string",
      enum: [
        "action-result",
        "blocked",
        "confirm-rejected",
        "disabled",
        "method-not-allowed",
        "log-tail",
      ],
    },
    log_tail_bounded_kib: { type: "integer" },
    log_redacted: { type: "boolean" },
  },
};

// ── Fixtures (SETUP-CORTEX-010..013) ────────────────────────────────────────

const fixtures = [
  {
    id: "SETUP-CORTEX-010",
    assertion:
      "action matrix: fetch-model/bench are gated by open HG-1+HG-3 (no spawn); verify-asset is ungated and runs the real asset-verify seam",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "verify-asset",
    confirm: true,
    expected_status_code: 200,
    error: null,
    blocker_ids: [],
    no_spawn: false,
    expected_body_shape: "action-result",
  },
  {
    id: "SETUP-CORTEX-011",
    assertion:
      "missing confirm:true yields 400 confirmation_required and does not spawn",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "bench",
    confirm: false,
    expected_status_code: 400,
    error: "confirmation_required",
    blocker_ids: [],
    no_spawn: true,
    expected_body_shape: "confirm-rejected",
  },
  {
    id: "SETUP-CORTEX-012",
    assertion:
      "a hard-gate-blocked action (fetch-model) returns 423 action_blocked_by_open_item with HG-1/HG-3 and does NOT spawn",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "fetch-model",
    confirm: true,
    expected_status_code: 423,
    error: "action_blocked_by_open_item",
    blocker_ids: ["HG-1", "HG-3"],
    no_spawn: true,
    expected_body_shape: "blocked",
  },
  {
    id: "SETUP-CORTEX-013",
    assertion:
      "the action-log tail is bounded at 8 KiB and redacted (digest prefixes + codes only, never payload bytes)",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "verify-asset",
    confirm: true,
    expected_status_code: 200,
    error: null,
    blocker_ids: [],
    no_spawn: false,
    log_tail_bounded_kib: 8,
    log_redacted: true,
    expected_body_shape: "log-tail",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(SETUP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(ACTION_SCHEMA), "utf8");
  const schemaRel = "schemas/setup-cortex-action-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "setup-cortex-action-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/setup-cortex-action-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `setup-dashboard/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "setup-cortex-action",
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
  setOwnerCsv("owner", "VC9B");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-vc9b.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`vc9-setup-dashboard/vc9b: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
