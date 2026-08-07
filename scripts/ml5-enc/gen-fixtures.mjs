#!/usr/bin/env node
/**
 * ml5-enc/gen-fixtures.mjs — ENC-0a encoder-decision conformance fixtures.
 *
 * Standalone generator for the ENC-DEC-001..006 fixtures + the
 * encoder-decision-fixture schema, committed under conformance/vector-cortex/v2/
 * (encoder-decision/ + schemas/). The shared coordinate with
 * vector-cortex-gen-fixtures.mjs is manifest.json: this script READS the
 * existing v2 manifest, appends its rows (the 6 fixtures + 1 schema row),
 * updates the manifest's domain/schemaVersion/owner strings to include this
 * sprint's seam, re-sorts by id, and rewrites the manifest — leaving every
 * pre-existing fixture file and its sha256 untouched (strictly additive).
 *
 * Canonical form (CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes,
 * shortest number representation, final LF, SHA-256 over the declared canonical
 * bytes. The conformance --check gate verifies the committed bytes are exactly
 * these. The canonical/sha256 helpers are IMPORTED from the VC9 setup generator
 * (not copy-pasted) so one byte-identical algorithm stays authoritative.
 *
 * REGENERATION: run `node scripts/ml5-enc/gen-fixtures.mjs`, then commit the
 * emitted files. The committed files are authoritative.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../vc9-setup-dashboard/gen-fixtures.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ml5-enc/ -> repo root -> conformance/vector-cortex/v2
const ROOT = join(scriptDir, "..", "..");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const ENC_DIR = join(V2, "encoder-decision");
const SCHEMA_DIR = join(V2, "schemas");

export const producer = "ml5-enc/gen-fixtures.mjs";

// ── Recorded degradation constants (must mirror the resolver + decision) ─────
const WASM_SHELL_MIB = 9.5;
const BGE_INT8_MIB = 23;
// Real sha256 of the committed placeholder model.onnx + tokenizer.json (from
// assets/vector-cortex/encoder-v1/manifest.json) — the recorded supply-chain
// pin baseline. The definitive bge-small int8 digests re-pin at ENC-0b.
const MODEL_PIN = "01cbed8b0b301609542ff8c392c3e7d927b0d848ac53a768dfffd33bfe6005ff";
const TOKENIZER_PIN = "ada18e5c4dfcb5c369c05f4ffc10bc40298ce707e78f16135c6d33019f6db8cd";
const PER_PLATFORM_INSTALL_MIB = Math.ceil(WASM_SHELL_MIB + BGE_INT8_MIB); // 33 MiB

// ── Platform matrix (wasm-leading-candidate snapshot; EncoderPlatform values) ──
const PLATFORM_ROWS = {
  "linux-x64": { runtime: "onnxruntime-web", installMiB: PER_PLATFORM_INSTALL_MIB, demotion: "none" },
  "linux-arm64": { runtime: "onnxruntime-web", installMiB: PER_PLATFORM_INSTALL_MIB, demotion: "none" },
  "darwin-x64": { runtime: "onnxruntime-web", installMiB: PER_PLATFORM_INSTALL_MIB, demotion: "wasm" },
  "darwin-arm64": { runtime: "onnxruntime-web", installMiB: PER_PLATFORM_INSTALL_MIB, demotion: "none" },
  "win32-x64": { runtime: "onnxruntime-web", installMiB: PER_PLATFORM_INSTALL_MIB, demotion: "none" },
};

const LICENSE = { spdx: "MIT", redistribution: true };

function artifactsOf(modelBytes, tokenizerBytes) {
  return {
    model: { path: "model.onnx", bytes: modelBytes, sha256: MODEL_PIN },
    tokenizer: { path: "tokenizer.json", bytes: tokenizerBytes, sha256: TOKENIZER_PIN },
  };
}

// Passing WASM bench input: p95 <= 40, model+tokenizer <= 80 MiB, pinned digests.
const PASS_BENCH = {
  measured_p95_ms: 18.2,
  install_bytes_model: 24117248, // 23 MiB int8 model
  install_bytes_tokenizer: 50000,
  model_sha256: MODEL_PIN,
  tokenizer_sha256: TOKENIZER_PIN,
  platform: "linux-x64",
};
const PASS_DECISION = {
  schema: "encoder-backend-decision-v1",
  backend: "wasm",
  budgetOk: true,
  opset: 21,
  platformMatrix: PLATFORM_ROWS,
  license: LICENSE,
  artifacts: artifactsOf(PASS_BENCH.install_bytes_model, PASS_BENCH.install_bytes_tokenizer),
  p95Ms: PASS_BENCH.measured_p95_ms,
  blockedBy: [],
};

const DEGRADED_BLOCKED =
  "p95-unmeasured: bge-small int8 was never benchmarked under transformers.js (ENC-0a bench gap)";
// Degraded-baseline artifact bytes reflect the REAL bge-small int8 asset: the
// ~23 MiB model is the model, the ~50 KB tokenizer is the tokenizer. The 9.5 MiB
// wasm shell is a RUNTIME install footprint captured per-platform in
// PER_PLATFORM_INSTALL_MIB, not a model file byte-count (mirrors the resolver).
const TOKENIZER_JSON_BYTES = 50000;
const DEGRADED_MODEL_BYTES = Math.round(BGE_INT8_MIB * 1048576);
const DEGRADED_TOKENIZER_BYTES = TOKENIZER_JSON_BYTES;

// ── The 6 ENC-DEC fixtures ───────────────────────────────────────────────────
const fixtures = [
  {
    id: "ENC-DEC-001",
    assertion:
      "budget-viable WASM: measured p95 <= 40 ms AND shipped bytes <= 80 MiB -> backend wasm, budgetOk true (Option W, the leading candidate)",
    kind: "wasm-qualified",
    bench_input: PASS_BENCH,
    expected_decision: PASS_DECISION,
    expected_outcome: "ok",
  },
  {
    id: "ENC-DEC-002",
    assertion:
      "budget-exceeding WASM: measured p95 > 40 ms -> backend native, budgetOk false (native ships > 80 MiB; 258 MiB total install recorded)",
    kind: "native-amended",
    bench_input: { ...PASS_BENCH, measured_p95_ms: 54.7 },
    expected_decision: {
      ...PASS_DECISION,
      backend: "native",
      budgetOk: false,
      p95Ms: 54.7,
    },
    expected_outcome: "ok",
  },
  {
    id: "ENC-DEC-003",
    assertion:
      "opset baseline pinned to 21 (not 17) across the decision record and the artifact rows — the 2026-08-05 re-baseline",
    kind: "opset-pinned",
    bench_input: { ...PASS_BENCH, measured_p95_ms: 21.3 },
    expected_decision: {
      ...PASS_DECISION,
      opset: 21,
      p95Ms: 21.3,
    },
    expected_outcome: "ok",
  },
  {
    id: "ENC-DEC-004",
    assertion:
      "per-platform install matrix resolves a runtime+demotion row for every EncoderPlatform, incl. darwin-x64 -> demotion wasm (HG-4; action ships in ENC-0e)",
    kind: "platform-matrix",
    bench_input: { ...PASS_BENCH, measured_p95_ms: 17.9 },
    expected_decision: {
      ...PASS_DECISION,
      p95Ms: 17.9,
      platformMatrix: {
        "linux-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "linux-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "darwin-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "wasm" },
        "darwin-arm64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
        "win32-x64": { runtime: "onnxruntime-web", installMiB: 33, demotion: "none" },
      },
    },
    expected_outcome: "ok",
  },
  {
    id: "ENC-DEC-005",
    assertion:
      "bench-input model_sha256 mismatch fails the resolver (supply-chain guard): the recorded digest is authoritative, the bench is untrusted",
    kind: "sha256-mismatch",
    bench_input: { ...PASS_BENCH, model_sha256: "0".repeat(64) },
    expected_decision: null,
    expected_outcome: "error",
  },
  {
    id: "ENC-DEC-006",
    assertion:
      "no measured bench present -> resolver degrades to the recorded vc2-model-prep table and still emits a decision (never blocks on absent measurement)",
    kind: "degraded-baseline",
    bench_input: null,
    expected_decision: {
      schema: "encoder-backend-decision-v1",
      backend: "wasm",
      budgetOk: true,
      opset: 21,
      platformMatrix: PLATFORM_ROWS,
      license: LICENSE,
      artifacts: artifactsOf(DEGRADED_MODEL_BYTES, DEGRADED_TOKENIZER_BYTES),
      p95Ms: null,
      blockedBy: [DEGRADED_BLOCKED],
    },
    expected_outcome: "ok",
  },
];

// ── Schema ──────────────────────────────────────────────────────────────────
const ENC_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "ENC-0a encoder-decision fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0a encoder-decision fixture validates against. `kind` names the decision branch exercised; `bench_input` is the JSONL row that feeds the resolver (null for the degraded baseline); `expected_decision` pins the full EncoderBackendDecisionV1 the resolver must emit (null when the branch is expected to error); `expected_outcome` is ok or error.",
  required: [
    "id",
    "producer",
    "assertion",
    "kind",
    "bench_input",
    "expected_decision",
    "expected_outcome",
  ],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "wasm-qualified",
        "native-amended",
        "opset-pinned",
        "platform-matrix",
        "sha256-mismatch",
        "degraded-baseline",
      ],
    },
    bench_input: { type: ["object", "null"] },
    expected_decision: { type: ["object", "null"] },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
  },
};

// ── ENC-0b: encoder-trunk fixtures ───────────────────────────────────────────
// Real bge-small-en-v1.5 ONNX digests (pinned in assets/.../manifest.json)
const TRUNK_MODEL_SHA = "913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2";
const TRUNK_TOKENIZER_SHA = "ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9";
const TRUNK_MODEL_BYTES = 33793354;
const TRUNK_TOKENIZER_BYTES = 535343;

const TRUNK_SCHEMA = {
  $schema: "https://json-schema.org/draft-07/schema#",
  title: "ENC-0b encoder-trunk fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0b encoder-trunk fixture validates against. `kind` names the inference/mutation branch exercised; `setup` carries asset overrides for the test harness; `expected_outcome` is ok or error; `expected_result` pins the fields the runtime must assert (digest, mode, opset, version, delta).",
  required: [
    "id",
    "producer",
    "assertion",
    "kind",
    "setup",
    "expected_outcome",
    "expected_result",
  ],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "onnx-session",
        "flag-off-parity",
        "digest-mutation",
        "opset-mismatch",
        "determinism",
        "model-card-version",
      ],
    },
    setup: {
      type: "object",
      properties: {
        manifest_override: { type: "object" },
        model_bytes_mutated: { type: "boolean" },
        opset_override: { type: "integer" },
        runs: { type: "integer" },
      },
    },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
    expected_result: {
      type: "object",
      properties: {
        backend: { type: "string" },
        maxAbsDelta: { type: "number" },
        mode: { type: "string" },
        modelVersion: { type: "string" },
        opset: { type: "integer" },
        sha256: { type: "string" },
      },
    },
  },
};

const trunkFixtures = [
  {
    id: "ENC-TRUNK-001",
    assertion:
      "real ONNX session builds with the staged asset: digest matches, opset 21, model-card-v1 present",
    kind: "onnx-session",
    setup: {},
    expected_outcome: "ok",
    expected_result: {
      backend: "wasm",
      mode: "A",
      modelVersion: "encoder-v1",
      opset: 21,
      sha256: TRUNK_MODEL_SHA,
    },
  },
  {
    id: "ENC-TRUNK-002",
    assertion:
      "flag-off parity: MEGACOMPACT_ENC_0B=0 LCG output is byte-identical to pre-sprint mode-B serving",
    kind: "flag-off-parity",
    setup: { runs: 1 },
    expected_outcome: "ok",
    expected_result: { backend: "wasm", mode: "B", modelVersion: "encoder-v1" },
  },
  {
    id: "ENC-TRUNK-003",
    assertion:
      "digest mutation: one-byte model.onnx change triggers ENC_DIGEST_MISMATCH -> mode B (LCG fallback)",
    kind: "digest-mutation",
    setup: { model_bytes_mutated: true },
    expected_outcome: "error",
    expected_result: { mode: "B" },
  },
  {
    id: "ENC-TRUNK-004",
    assertion:
      "opset mismatch: manifest opset != 21 triggers ENC_OPSET_INVALID -> mode B (LCG fallback)",
    kind: "opset-mismatch",
    setup: { opset_override: 17 },
    expected_outcome: "error",
    expected_result: { mode: "B", opset: 17 },
  },
  {
    id: "ENC-TRUNK-005",
    assertion:
      "determinism: identical embedding output across 3 runs (maxAbsDelta 0)",
    kind: "determinism",
    setup: { runs: 3 },
    expected_outcome: "ok",
    expected_result: { backend: "wasm", maxAbsDelta: 0, mode: "A" },
  },
  {
    id: "ENC-TRUNK-006",
    assertion:
      'model-card version: modelVersion is "encoder-v1" (not "-placeholder")',
    kind: "model-card-version",
    setup: {},
    expected_outcome: "ok",
    expected_result: { modelVersion: "encoder-v1" },
  },
];

// ── Main (mirrors the VC9 setup generator coordinate with manifest.json) ─────
export function writeAll() {
  mkdirSync(ENC_DIR, { recursive: true });
  mkdirSync(SCHEMA_DIR, { recursive: true });

  const manifestPath = join(V2, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const rows = [];

  // The ENC-DEC schema row.
  const schemaBytes = Buffer.from(canonicalJson(ENC_SCHEMA), "utf8");
  const schemaRel = "schemas/encoder-decision-fixture.schema.json";
  writeFileSync(join(V2, schemaRel), schemaBytes);
  rows.push({
    id: "encoder-decision-fixture",
    path: schemaRel,
    sha256: sha256Hex(schemaBytes),
    schema: schemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-DEC fixture rows + on-disk files.
  for (const fx of fixtures) {
    const obj = { ...fx, schema: schemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-decision/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: schemaRel,
      algorithm: "encoder-decision",
      producer,
      expected: fx.expected_outcome,
      license: "synthetic",
    });
  }

  // The ENC-TRUNK schema row.
  const trunkSchemaBytes = Buffer.from(canonicalJson(TRUNK_SCHEMA), "utf8");
  const trunkSchemaRel = "schemas/encoder-trunk-fixture.schema.json";
  writeFileSync(join(V2, trunkSchemaRel), trunkSchemaBytes);
  rows.push({
    id: "encoder-trunk-fixture",
    path: trunkSchemaRel,
    sha256: sha256Hex(trunkSchemaBytes),
    schema: trunkSchemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-TRUNK fixture rows + on-disk files.
  const trunkDir = join(V2, "encoder-trunk");
  mkdirSync(trunkDir, { recursive: true });
  for (const fx of trunkFixtures) {
    const obj = { ...fx, schema: trunkSchemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-trunk/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: trunkSchemaRel,
      algorithm: "encoder-trunk",
      producer,
      expected: fx.expected_outcome,
      license: "synthetic",
    });
  }

  // Merge into the existing manifest (id-dedupe so re-runs are idempotent) and
  // re-sort the whole fixtures array by id.
  const existing = manifest.fixtures.filter((r) => !rows.some((n) => n.id === r.id));
  manifest.fixtures = [...existing, ...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Update the seam header strings to include this sprint's domain/schema/owner.
  const setCsv = (field, token) => {
    const list = manifest[field].split(";").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(";");
  };
  const setOwnerCsv = (field, token) => {
    const list = manifest[field].split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.includes(token)) list.push(token);
    manifest[field] = list.sort().join(",");
  };
  setCsv("domain", "encoder-decision");
  setCsv("schemaVersion", "encoder-decision-fixture");
  setOwnerCsv("owner", "ENC-0a");
  setCsv("domain", "encoder-trunk");
  setCsv("schemaVersion", "encoder-trunk-fixture");
  setOwnerCsv("owner", "ENC-0b");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return { fixtureCount: fixtures.length + trunkFixtures.length, schemaCount: 2 };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`ml5-enc: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
