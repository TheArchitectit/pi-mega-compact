#!/usr/bin/env node
/**
 * ml5/gen-fixtures-ml5c.mjs — ML5-C runtime-choice conformance fixtures.
 *
 * Sibling of gen-fixtures-ml5a.mjs + gen-fixtures-ml5b.mjs. Generates the
 * ML5-RUNTIME-001..005 fixtures under conformance/vector-cortex/v2/runtime-choice/
 * against the SHARED `schemas/ml5-fixture.schema.json` (the `kind` enum is
 * extended additively from `["ml5-train","bench-heads"]` to include
 * `"runtime-choice"` — backward-compatible; the six ML5-TRAIN-* and four
 * ML5-BENCH-* fixtures are untouched and still validate).
 *
 * Registers owner `ML5-C` in the v2 manifest and re-sorts to canonical form.
 * Idempotent: re-running reproduces byte-identical committed fixtures and does
 * not drift the manifest sha256s for unrelated rows.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/gen-fixtures-ml5c.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const CHOICE_DIR = join(V2, "runtime-choice");
const SCHEMA_REL = "schemas/ml5-fixture.schema.json";

export const producer = "scripts/ml5/gen-fixtures-ml5c.mjs";

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

// ── ML5-C runtime-choice fixtures ───────────────────────────────────────────

const fixtures = [
  {
    id: "ML5-RUNTIME-001",
    kind: "runtime-choice",
    flag: "MEGACOMPACT_ML5_C",
    backend: "native", // measured native p95 22.4ms but WASM is 75.4ms — the rule picks native
    budget_mib: 300,             // operator-configurable default (MEGACOMPACT_NATIVE_ORT_BUDGET_MIB)
    byte_count_le_budget: true,  // shipped 5-platform ~160 MiB fits within the 300 MiB default
    amended_budget_mib: null,    // no amendment at the default 300; an operator lowering the budget below 160 would flip this
    assertion: "install budget byte-count compliance for the chosen backend: at the default 300 MiB budget, native's shipped ~160 MiB fits → byte_count_le_budget:true; an operator lowering MEGACOMPACT_NATIVE_ORT_BUDGET_MIB below 160 flips budgetOk to false",
  },
  {
    id: "ML5-RUNTIME-002",
    kind: "runtime-choice",
    flag: "MEGACOMPACT_ML5_C",
    platforms: ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64", "linux-arm64"],
    matrix_complete: true,
    no_missing_optional_dep: true,
    assertion: "per-platform install matrix resolves completely: every Node platform resolves to a concrete package/size row with no missing optionalDependency",
  },
  {
    id: "ML5-RUNTIME-003",
    kind: "runtime-choice",
    flag: "MEGACOMPACT_ML5_C",
    opset: 21,
    handshake: "ok",
    assertion: "opset 21 session handshake: the selected session's opset_import declares 21 and the handshake records OK (ENC-0a re-baselined from 17 to 21)",
  },
  {
    id: "ML5-RUNTIME-004",
    kind: "runtime-choice",
    flag: "MEGACOMPACT_ML5_C",
    asset_present: false,
    native_opt_in: false,
    fallback: "mode_B_trigram",
    assertion: "stub-fallback to mode B when WASM artifact absent: MEGACOMPACT_ML5_C=1 + no WASM asset routes through the mode-B trigram fallback without any runtime load",
  },
  {
    id: "ML5-RUNTIME-005",
    kind: "runtime-choice",
    flag: "MEGACOMPACT_ML5_C",
    native_opt_in: true,
    backend: "runtime-native",
    native_opt_in_default: false,
    backend_default: "runtime-wasm",
    assertion: "native opt-in routes through onnxruntime-node; the default (native_opt_in=false) routes through runtime-wasm",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(CHOICE_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];

  // Extend the shared ml5-fixture schema's `kind` enum additively so the
  // runtime-choice envelope validates while ml5-train + bench-heads are untouched.
  const schemaPath = join(V2, SCHEMA_REL);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const kindEnum = schema.properties?.kind?.enum;
  if (!Array.isArray(kindEnum)) throw new Error("ml5-fixture schema has no kind enum");
  if (!kindEnum.includes("runtime-choice")) kindEnum.push("runtime-choice");
  const schemaBytes = Buffer.from(canonicalJson(schema), "utf8");
  writeFileSync(schemaPath, schemaBytes);
  {
    const existing = manifest.fixtures.find((r) => r.path === SCHEMA_REL);
    if (existing) existing.sha256 = sha256Hex(schemaBytes);
  }

  for (const fx of fixtures) {
    const obj = { ...fx, schema: SCHEMA_REL, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `runtime-choice/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "runtime-choice",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const setCsv = (field, token, sep) => {
    const list = manifest[field].split(sep).map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(sep);
  };
  setCsv("owner", "ML5-C", ",");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaKind: kindEnum };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-ml5c.mjs")) {
  const { fixtureCount, schemaKind } = writeAll();
  console.log(`ml5/gen-fixtures-ml5c: wrote ${fixtureCount} fixtures, manifest updated.`);
  console.log(`ml5-fixture schema kind enum: [${schemaKind.join(", ")}]`);
}
