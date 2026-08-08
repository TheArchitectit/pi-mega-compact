#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures-enc2c.mjs — ENC-2c setup-cortex action fixtures
 * (native onnxruntime lazy-download install action).
 *
 * Sibling of gen-fixtures-vc9b.mjs (VC9B action matrix). Generates the
 * SETUP-CORTEX-034..038 fixtures under conformance/vector-cortex/v2/
 * (setup-dashboard/) and WIDENS the shared setup-cortex-action-fixture schema's
 * `action` enum with "install-native-ort" plus the ENC-2c additive pins
 * (`auto_retest` + `no_url_literal`). Reads the existing v2 manifest, appends its
 * rows, adds the ENC-2c owner + native-ort-install-action domain seam, re-sorts,
 * and rewrites the manifest — leaving every pre-existing fixture file + sha256
 * untouched.
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. REGENERATION: run `node scripts/vc9-setup-dashboard/gen-fixtures-enc2c.mjs`
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

export const producer = "vc9-setup-dashboard/gen-fixtures-enc2c.mjs";

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

// ── Action fixture schema (widened for ENC-2c) ───────────────────────────────

const ACTION_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC9B setup-cortex action fixture envelope",
  type: "object",
  description:
    "Common structure every VC9B setup-cortex action fixture validates against. `flag_enabled` pins the VC9B flag state; `action` pins the driver action kind; `confirm` pins the required confirm:true gate; `expected_status_code` pins the HTTP status the route returns; `error` pins the machine error code (or null on success); `blocker_ids` pins the open hard-gate ids surfaced when the action is blocked; `no_spawn` pins that a subprocess must NOT be spawned; `expected_body_shape` pins the body class (action-result / blocked / confirm-rejected / disabled / method-not-allowed / log-tail); `log_tail_bounded_kib` + `log_redacted` pin the log-tail endpoint guarantees. ENC-2c: the `action` enum adds `install-native-ort` (the confirm-gated lazy-download native install); `enc2c_off` pins the ENC-2c flag-off (invalid_action) branch; `auto_retest` pins that the install action always re-qualifies via the ENC-2b retest; `no_url_literal` pins the no-network/URL-literal guarantee of the driver.",
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
    action: {
      type: "string",
      enum: ["fetch-model", "bench", "verify-asset", "install-native-ort"],
    },
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
    enc2c_off: { type: "boolean" },
    auto_retest: { type: "boolean" },
    no_url_literal: { type: "boolean" },
  },
};

// ── ENC-2c fixtures (SETUP-CORTEX-034..038) ─────────────────────────────────

const fixtures = [
  {
    id: "SETUP-CORTEX-034",
    assertion:
      "ENC-2c: install-native-ort with confirm:true is gated by the open HG-3 install-budget hard gate — 423 action_blocked_by_open_item, HG-3 surfaced, NO install subprocess spawns",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "install-native-ort",
    confirm: true,
    expected_status_code: 423,
    error: "action_blocked_by_open_item",
    blocker_ids: ["HG-3"],
    no_spawn: true,
    expected_body_shape: "blocked",
  },
  {
    id: "SETUP-CORTEX-035",
    assertion:
      "ENC-2c: install-native-ort with confirm:false yields 400 confirmation_required and does NOT spawn the install subprocess",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "install-native-ort",
    confirm: false,
    expected_status_code: 400,
    error: "confirmation_required",
    blocker_ids: [],
    no_spawn: true,
    expected_body_shape: "confirm-rejected",
  },
  {
    id: "SETUP-CORTEX-036",
    assertion:
      "ENC-2c flag-off (MEGACOMPACT_ENC_2C=0): install-native-ort is unrecognized — 400 invalid_action, byte-identical to the ENC-2b predecessor (no install action exists)",
    kind: "setup-cortex-action",
    flag_enabled: true,
    enc2c_off: true,
    action: "install-native-ort",
    confirm: true,
    expected_status_code: 400,
    error: "invalid_action",
    blocker_ids: [],
    no_spawn: true,
    expected_body_shape: "confirm-rejected",
  },
  {
    id: "SETUP-CORTEX-037",
    assertion:
      "ENC-2c success: once HG-3 is closed, install-native-ort with confirm:true runs the local npm-delegated install then ALWAYS re-qualifies via the ENC-2b retest (auto_retest) — result is action-result with the retest fields; the driver carries NO URL literals",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "install-native-ort",
    confirm: true,
    expected_status_code: 200,
    error: null,
    blocker_ids: [],
    no_spawn: false,
    auto_retest: true,
    no_url_literal: true,
    expected_body_shape: "action-result",
  },
  {
    id: "SETUP-CORTEX-038",
    assertion:
      "ENC-2c no-network guard: the install-native-ort driver source (setup-cortex-actions-native-ort.ts) contains NO URL literals and no fetch — the install is npm-delegated to the committed local script (PREVENT-PI-004 opt-in exemption)",
    kind: "setup-cortex-action",
    flag_enabled: true,
    action: "install-native-ort",
    confirm: true,
    expected_status_code: 423,
    error: "action_blocked_by_open_item",
    blocker_ids: ["HG-3"],
    no_spawn: true,
    no_url_literal: true,
    expected_body_shape: "blocked",
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
  setOwnerCsv("owner", "ENC-2c");
  const setDomainCsv = (field, token) => {
    const list = manifest[field].split(";").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(";");
  };
  setDomainCsv("domain", "native-ort-install-action");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-enc2c.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`vc9-setup-dashboard/enc2c: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
