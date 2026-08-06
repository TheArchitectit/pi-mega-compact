#!/usr/bin/env node
/**
 * vc9-setup-dashboard/gen-fixtures-vc9d.mjs — VC9D embedder-detect consolidation
 * fixtures.
 *
 * Sibling of gen-fixtures.mjs (VC9A), gen-fixtures-vc9b.mjs (VC9B) and
 * gen-fixtures-vc9c.mjs (VC9C). Generates the SETUP-CORTEX-030..033 detect
 * fixtures + the setup-cortex-detect-fixture schema under
 * conformance/vector-cortex/v2/ (setup-dashboard/ + schemas/), updates the v2
 * manifest with the 4 new fixture rows + 1 schema row + the VC9D owner token,
 * re-sorts, and rewrites the manifest — leaving every pre-existing fixture file
 * and its sha256 untouched (same id-dedupe + seam-header convention as the
 * siblings).
 *
 * Each fixture is a SEMANTIC envelope pinning the VC9D detect-cache contract:
 *   - 030: a memoized detect returns identical results on a second call with an
 *     unchanged key (cache hit, no recompute).
 *   - 031: a memoized detect recomputes when the mutable input changes (cache
 *     miss on key mutation — e.g. binary path or mtime).
 *   - 032: MEGACOMPACT_VC9D=0 restores per-request fresh spawn (byte-identical
 *     to the VC9C-era behavior, no caching).
 *   - 033: the embedder + cortex sub-tabs are BOTH present in SUB_TABS
 *     simultaneously (the consolidation keeps both surfaces live).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these.
 *
 * REGENERATION: run `node scripts/vc9-setup-dashboard/gen-fixtures-vc9d.mjs`,
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

export const producer = "vc9-setup-dashboard/gen-fixtures-vc9d.mjs";

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

// ── Detect-fixture schema ───────────────────────────────────────────────────

const DETECT_DETECT_TARGETS = ["ollama", "llamaCpp", "onnx"];
const DETECT_CALL_KINDS = ["cache_hit", "cache_miss"];

const DETECT_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "VC9D setup-cortex detect-consolidation fixture envelope",
  type: "object",
  description:
    "Common structure every VC9D setup-cortex detect-consolidation fixture validates against. These are SEMANTIC envelopes pinning the memoized-detect contract. `target` names the detect being memoized; `calls` is how many runs the scenario exercises; `second_call` pins the cache outcome of the second run (cache_hit / cache_miss); `input_mutation` describes the mutable-input change that produced the miss; `result_identical` pins whether the two runs returned the identical object; `flag_enabled` pins the VC9D flag state; `caching_active` pins whether memoization is in effect; `mode` pins the fresh_spawn / cached detection mode; `sub_tabs` pins the SetupTab SUB_TABS membership for the dual-sub-tab surface.",
  required: ["id", "producer", "assertion", "kind"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["setup-cortex-detect"] },
    target: { type: "string", enum: DETECT_DETECT_TARGETS },
    calls: { type: "integer", minimum: 1 },
    second_call: { type: ["string", "null"], enum: [...DETECT_CALL_KINDS, null] },
    input_mutation: { type: ["string", "null"] },
    result_identical: { type: "boolean" },
    flag_enabled: { type: "boolean" },
    caching_active: { type: "boolean" },
    mode: { type: "string", enum: ["cached", "fresh_spawn"] },
    sub_tabs: { type: "array", items: { type: "string", enum: ["embedder", "cortex"] } },
    expected_subtabs_present: { type: "string", enum: ["both"] },
  },
};

// ── Fixtures (SETUP-CORTEX-030..033) ────────────────────────────────────────

const fixtures = [
  {
    id: "SETUP-CORTEX-030",
    assertion:
      "a memoized detect returns identical results on a second call with an unchanged key: the second run is a cache hit and does NOT re-run the expensive compute (result_identical:true)",
    kind: "setup-cortex-detect",
    target: "ollama",
    calls: 2,
    second_call: "cache_hit",
    input_mutation: null,
    result_identical: true,
  },
  {
    id: "SETUP-CORTEX-031",
    assertion:
      "a memoized detect invalidates when the mutable input changes: a binary-path-or-mtime mutation forces a recompute, so the second run is a cache miss and produces a fresh (different) result",
    kind: "setup-cortex-detect",
    target: "llamaCpp",
    calls: 2,
    second_call: "cache_miss",
    input_mutation: "binary_path_or_mtime",
    result_identical: false,
  },
  {
    id: "SETUP-CORTEX-032",
    assertion:
      "flag-off restores per-request fresh spawn: with MEGACOMPACT_VC9D=0 the detect path runs fresh on every call (mode fresh_spawn, caching inactive), byte-identical to the VC9C-era behavior",
    kind: "setup-cortex-detect",
    target: "onnx",
    calls: 2,
    second_call: null,
    flag_enabled: false,
    caching_active: false,
    mode: "fresh_spawn",
  },
  {
    id: "SETUP-CORTEX-033",
    assertion:
      "the embedder + cortex sub-tabs are BOTH present in SUB_TABS simultaneously after the VC9D consolidation — the Setup tab keeps both surfaces live",
    kind: "setup-cortex-detect",
    sub_tabs: ["embedder", "cortex"],
    expected_subtabs_present: "both",
    flag_enabled: true,
    caching_active: true,
    mode: "cached",
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(SETUP_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(DETECT_SCHEMA), "utf8");
  const schemaRel = "schemas/setup-cortex-detect-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "setup-cortex-detect-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/setup-cortex-detect-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `setup-dashboard/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "setup-cortex-detect",
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
  setOwnerCsv("owner", "VC9D");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-vc9d.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`vc9-setup-dashboard/vc9d: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
