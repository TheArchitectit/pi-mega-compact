#!/usr/bin/env node
/**
 * ml5/gen-fixtures-ml5a.mjs — ML5-A five-head training + calibration-corpus fixtures.
 *
 * Sibling of gen-fixtures.mjs (base) and vc9-setup-dashboard/gen-fixtures-vc9c.mjs
 * (VC9C). Generates the ML5-TRAIN-001..006 fixtures + the ml5-fixture schema under
 * conformance/vector-cortex/v2/ (trained-heads/ + schemas/). This script READS the
 * existing v2 manifest, appends its rows (6 fixtures + 1 schema row), updates the
 * manifest's owner strings to include this sprint's seam, adds the ml5-fixture
 * schema name to schemaVersion, re-sorts, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (same id-dedupe + seam-header
 * convention as the siblings).
 *
 * Each fixture pins a SEMANTIC property set that drives the ML5-A acceptance
 * contract (verified by ml5a-acceptance.test.ts + the training pipeline):
 *   - 001: corpus sourcing (context_chunks/turns/conversations, redacted-only,
 *     session-never-split) plus both held-out splits > 0.
 *   - 002: deterministic export (seed 1729, opset 17, int8 quantization) with a
 *     stable SHA-256 across runs.
 *   - 003: flag-off demotion path (mode B, placeholder heads/calibration, empty
 *     corpus is a no-op).
 *   - 004: lossWeights sum to exactly 1.0 (.35/.20/.20/.15/.10).
 *   - 005: deterministic seeding everywhere (python/numpy/torch/export all seed 1729).
 *   - 006: CalibrationV1 shape, a deterministic corpus digest sha256, and head dims
 *     384/128/128/64/32.
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes, shortest
 * number representation, final LF, SHA-256 over the declared canonical bytes. The
 * conformance --check gate verifies the committed bytes are exactly these.
 *
 * REGENERATION: run `node scripts/ml5/gen-fixtures-ml5a.mjs`, then commit the
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
const TRAINED_DIR = join(V2, "trained-heads");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "scripts/ml5/gen-fixtures-ml5a.mjs";

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

// ── Deterministic synthetic corpus digest ────────────────────────────────────
// Shares the canonical-JSON + SHA-256 scheme with the training pipeline's
// group_list_digest so the acceptance test can recompute it in JS and cross-check
// the committed fixture value (see headDims in ML5-TRAIN-006).
const CANONICAL_GROUPS = [
  { repo_id: "repo-a", session_key: "s1", n: 3, redacted: true },
  { repo_id: "repo-a", session_key: "s2", n: 3, redacted: true },
  { repo_id: "repo-b", session_key: "s3", n: 3, redacted: true },
  { repo_id: "repo-b", session_key: "s4", n: 3, redacted: true },
  { repo_id: "repo-c", session_key: "s5", n: 2, redacted: true },
  { repo_id: "repo-c", session_key: "s6", n: 2, redacted: true },
];

export const corpusDigestSha256 = sha256Hex(Buffer.from(canonicalJson({ groups: CANONICAL_GROUPS }), "utf8"));

// ── ML5-A fixture schema ─────────────────────────────────────────────────────
const HEAD_NAMES = ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"];

const ML5_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "ML5-A five-head training fixture envelope",
  type: "object",
  description:
    "Common structure every ML5-A trained-heads fixture validates against. These are SEMANTIC envelopes pinning the training + calibration contract (five projection heads, deterministic export, calibration shape) that ml5a-acceptance.test.ts and the training pipeline execute against. `flag`/`flag_enabled` pin the MEGACOMPACT_ML5_A gate state; `corpus_source`/`redacted_only`/`session_never_split`/`splits` pin the held-out corpus policy; `seed`/`opset`/`quantized`/`sha256_stable_across_runs` pin determinism; `heads_placeholder`/`calibrate_placeholder`/`mode` pin the flag-off demotion shape.",
  required: ["id", "producer", "assertion", "kind"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: { type: "string", enum: ["ml5-train"] },
    flag: { type: "string" },
    flag_enabled: { type: "boolean" },
    corpus_source: { type: "array", items: { type: "string" } },
    redacted_only: { type: "boolean" },
    session_never_split: { type: "boolean" },
    splits: {
      type: "object",
      properties: {
        train: { type: "string" },
        calibration: { type: "string" },
        test: { type: "string" },
      },
    },
    seed: { type: "integer" },
    opset: { type: "integer" },
    quantized: { type: "string", enum: ["int8", "fp32"] },
    sha256_stable_across_runs: { type: "boolean" },
    heads_placeholder: { type: "boolean" },
    calibrate_placeholder: { type: "boolean" },
    mode: { type: "string", enum: ["A", "B", "C"] },
    loss_weights: {
      type: "object",
      additionalProperties: false,
      required: HEAD_NAMES,
      properties: Object.fromEntries(HEAD_NAMES.map((h) => [h, { type: "number" }])),
    },
    loss_sum: { type: "number" },
    python_seed: { type: "boolean" },
    numpy_seed: { type: "boolean" },
    torch_seed: { type: "boolean" },
    export_seed: { type: "boolean" },
    calibration_shape: { type: "string" },
    corpus_digest_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    head_dims: {
      type: "object",
      additionalProperties: false,
      required: HEAD_NAMES,
      properties: Object.fromEntries(HEAD_NAMES.map((h) => [h, { type: "integer" }])),
    },
  },
};

// ── Fixtures (ML5-TRAIN-001..006) ────────────────────────────────────────────

const fixtures = [
  {
    id: "ML5-TRAIN-001",
    assertion:
      "the training corpus is sourced from context_chunks/turns/conversations, redacted-only, sessions are never split across the held-out boundary, and both the train and calibration splits are populated (>0)",
    kind: "ml5-train",
    flag: "MEGACOMPACT_ML5_A",
    flag_enabled: true,
    corpus_source: ["context_chunks", "turns", "conversations"],
    redacted_only: true,
    session_never_split: true,
    splits: { train: ">0", calibration: ">0", test: "0" },
  },
  {
    id: "ML5-TRAIN-002",
    assertion:
      "the ONNX export is deterministic and reproducible: seed 1729, opset 17, int8 quantization, and a byte-stable SHA-256 across repeated runs",
    kind: "ml5-train",
    seed: 1729,
    opset: 17,
    quantized: "int8",
    sha256_stable_across_runs: true,
  },
  {
    id: "ML5-TRAIN-003",
    assertion:
      "flag-off (MEGACOMPACT_ML5_A=0) demotes the head to the placeholder shape: mode B, placeholder heads + calibration, and an empty corpus is a no-op (no asset emitted)",
    kind: "ml5-train",
    flag: "MEGACOMPACT_ML5_A",
    flag_enabled: false,
    heads_placeholder: true,
    calibrate_placeholder: true,
    mode: "B",
    corpus_source: [],
  },
  {
    id: "ML5-TRAIN-004",
    assertion:
      "the per-head loss weights (semantic/dependency/contradiction/cacheStability/payloadRouting = .35/.20/.20/.15/.10) sum to exactly 1.0",
    kind: "ml5-train",
    loss_weights: {
      semantic: 0.35,
      dependency: 0.2,
      contradiction: 0.2,
      cacheStability: 0.15,
      payloadRouting: 0.1,
    },
    loss_sum: 1.0,
  },
  {
    id: "ML5-TRAIN-005",
    assertion:
      "determinism is seeded everywhere: the python RNG, numpy, torch, and ONNX export all use the single seed 1729 (no Math.random / numpy default unseeded draws)",
    kind: "ml5-train",
    seed: 1729,
    python_seed: true,
    numpy_seed: true,
    torch_seed: true,
    export_seed: true,
  },
  {
    id: "ML5-TRAIN-006",
    assertion:
      "the calibration output is CalibrationV1-shaped with a deterministic corpus digest sha256 and the five-head dims 384/128/128/64/32",
    kind: "ml5-train",
    calibration_shape: "CalibrationV1",
    corpus_digest_sha256: corpusDigestSha256,
    head_dims: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 },
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

export function writeAll() {
  mkdirSync(TRAINED_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  const schemaBytes = Buffer.from(canonicalJson(ML5_SCHEMA), "utf8");
  const schemaRel = "schemas/ml5-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "ml5-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  for (const fx of fixtures) {
    const obj = { ...fx, schema: "schemas/ml5-fixture.schema.json", producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `trained-heads/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: obj.schema,
      algorithm: "ml5-train",
      producer,
      expected: "ok",
      license: "synthetic",
    });
  }

  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const setCsv = (field, token, sep) => {
    const list = manifest[field].split(sep).map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(sep);
  };
  setCsv("owner", "ML5-A", ",");
  setCsv("schemaVersion", "ml5-fixture", ";");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length, schemaCount: 1, corpusDigestSha256 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures-ml5a.mjs")) {
  const { fixtureCount, schemaCount, corpusDigestSha256 } = writeAll();
  console.log(`ml5/gen-fixtures-ml5a: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
  console.log(`corpus digest sha256: ${corpusDigestSha256}`);
}
