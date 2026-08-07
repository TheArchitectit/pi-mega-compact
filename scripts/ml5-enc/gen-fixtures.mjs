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

// ── ENC-0c: encoder-heads-real fixtures ─────────────────────────────────────
// Five real heads on the frozen bge-small trunk: semantic-384, dependency-128,
// contradiction-128, cache-stability-64, payload-routing-32 (ENCODER_HEAD_DIM_ORDER).
const HEAD_ORDER = [
  { name: "semantic", dim: 384 },
  { name: "dependency", dim: 128 },
  { name: "contradiction", dim: 128 },
  { name: "cache-stability", dim: 64 },
  { name: "payload-routing", dim: 32 },
];
const HEADS_FIRE = HEAD_ORDER.map((h) => ({ name: h.name, dim: h.dim, nonConstant: true }));

const HEADS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema#",
  title: "ENC-0c encoder-heads-real fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0c encoder-heads-real fixture validates against. `kind` names the trained-five-head branch exercised; `setup` carries candidate/split/run overrides for the test harness; `expected_outcome` is ok or error; `expected_result` pins the fields the runtime must assert (per-head dim/non-constant, mode, fallback, split digest, determinism delta).",
  required: ["id", "producer", "assertion", "kind", "setup", "expected_outcome", "expected_result"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "heads-fire",
        "flag-off-parity",
        "dim-mismatch",
        "non-finite-weights",
        "split-boundary",
        "determinism",
      ],
    },
    setup: {
      type: "object",
      properties: {
        corpus: { type: "string" },
        flag_off: { type: "boolean" },
        runs: { type: "integer" },
        digest_stable: { type: "boolean" },
        split_groups: {
          type: "object",
          properties: {
            train: { type: "integer" },
            calibration: { type: "integer" },
            test: { type: "integer" },
          },
        },
        candidate: {
          type: "object",
          properties: {
            missing_head_dim: { type: "string" },
            non_finite: { type: "string" },
            digest_mismatch: { type: "boolean" },
          },
        },
      },
    },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
    expected_result: {
      type: "object",
      properties: {
        backend: { type: "string" },
        mode: { type: "string" },
        byteIdentical: { type: "boolean" },
        fallback: { type: "string" },
        rejected: { type: "string" },
        partialLoad: { type: "boolean" },
        forceLoad: { type: "boolean" },
        splitDigest: { type: "string" },
        crossingGroups: { type: "integer" },
        maxAbsDelta: { type: "number" },
        passes: { type: "integer" },
        sha256: { type: "string" },
        heads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              dim: { type: "integer" },
              nonConstant: { type: "boolean" },
            },
          },
        },
      },
    },
  },
};

const headsFixtures = [
  {
    id: "ENC-HEADS-001",
    assertion:
      "all five heads return real, non-constant vectors over synthetic corpus (semantic 384 / dependency 128 / contradiction 128 / cache 64 / payload 32)",
    kind: "heads-fire",
    setup: { corpus: "synthetic", runs: 1 },
    expected_outcome: "ok",
    expected_result: { backend: "wasm", heads: HEADS_FIRE, mode: "A" },
  },
  {
    id: "ENC-HEADS-002",
    assertion:
      "flag-off (MEGACOMPACT_ENC_0C=0) loads no candidate — every head byte-identical to the ENC-0b survivor",
    kind: "flag-off-parity",
    setup: { flag_off: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { byteIdentical: true, fallback: "enc-0b-survivor", mode: "B" },
  },
  {
    id: "ENC-HEADS-003",
    assertion:
      "missing head dim in the candidate -> rejected, fallback to survivor (no partial load)",
    kind: "dim-mismatch",
    setup: { candidate: { missing_head_dim: "payload-routing" } },
    expected_outcome: "error",
    expected_result: { fallback: "enc-0b-survivor", partialLoad: false, rejected: "dim-mismatch" },
  },
  {
    id: "ENC-HEADS-004",
    assertion:
      "non-finite or digest-mismatched candidate -> rejected, fallback (no force-load)",
    kind: "non-finite-weights",
    setup: { candidate: { non_finite: "contradiction-128", digest_mismatch: true } },
    expected_outcome: "error",
    expected_result: { fallback: "enc-0b-survivor", forceLoad: false, rejected: "non-finite-weights" },
  },
  {
    id: "ENC-HEADS-005",
    assertion:
      "synthetic corpus split groups never cross train/calibration/test boundaries; split digest stable",
    kind: "split-boundary",
    setup: { digest_stable: true, split_groups: { train: 3, calibration: 1, test: 1 } },
    expected_outcome: "ok",
    expected_result: { crossingGroups: 0, splitDigest: "stable" },
  },
  {
    id: "ENC-HEADS-006",
    assertion:
      "head-embedding determinism — identical sha256 across 3 forward passes (maxAbsDelta 0)",
    kind: "determinism",
    setup: { runs: 3 },
    expected_outcome: "ok",
    expected_result: { backend: "wasm", maxAbsDelta: 0, passes: 3, sha256: "stable" },
  },
];

// ── ENC-0d: encoder-promotion fixtures ──────────────────────────────────────
// Real-asset promotion gate over the ENC-0c trained candidate + ENC-0b trunk:
// atomic swap with digest verification, byte-preserving rollback-to-previous on
// qualification failure, emit promote/demote/rollback events, flag-off = nothing.
const PROMO_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema#",
  title: "ENC-0d encoder-promotion fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0d encoder-promotion fixture validates against. `kind` names the promotion/digest/rollback branch exercised; `setup` carries the {color} candidate manifest + staged-byte mutation overrides for the gate harness; `expected_outcome` is ok or error; `expected_result` pins the fields the promotion gate must assert (atomic_swap, prior_asset_live, sha256_fail, partial_state, restored_sha256, event, mode, candidate_accepted).",
  required: ["id", "producer", "assertion", "kind", "setup", "expected_outcome", "expected_result"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "green-swap",
        "red-demote",
        "digest-fail-trunk",
        "digest-fail-heads",
        "rollback-stack",
        "flag-off",
      ],
    },
    setup: {
      type: "object",
      properties: {
        color: { type: "string", enum: ["green", "red"] },
        flag_off: { type: "boolean" },
        staged_bytes_mutated: { type: "string" },
        head_digest_mismatch: { type: "boolean" },
        regressed_promoted: { type: "boolean" },
        stack_depth: { type: "integer" },
        runs: { type: "integer" },
      },
    },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
    expected_result: { type: "object" },
  },
};

const promotionFixtures = [
  {
    id: "ENC-PROMO-001",
    assertion:
      "green digest-verified {color:green} candidate -> atomic swap of the shipped encoder-v1 manifest to the trained asset, event vector_cortex_asset_promoted, runtime mode A",
    kind: "green-swap",
    setup: { color: "green", runs: 1 },
    expected_outcome: "ok",
    expected_result: { atomic_swap: true, event: "vector_cortex_asset_promoted", mode: "A" },
  },
  {
    id: "ENC-PROMO-002",
    assertion:
      "red candidate (threshold/holdout miss) -> no swap, prior asset stays live, event vector_cortex_asset_demoted",
    kind: "red-demote",
    setup: { color: "red", runs: 1 },
    expected_outcome: "ok",
    expected_result: { atomic_swap: false, event: "vector_cortex_asset_demoted", prior_asset_live: true },
  },
  {
    id: "ENC-PROMO-003",
    assertion:
      "one-byte staged model.onnx mutation -> sha256 fail -> no swap, no partial state (temp-write-then-rename never in-place)",
    kind: "digest-fail-trunk",
    setup: { color: "green", staged_bytes_mutated: "model.onnx", runs: 1 },
    expected_outcome: "error",
    expected_result: { atomic_swap: false, partial_state: false, sha256_fail: true },
  },
  {
    id: "ENC-PROMO-004",
    assertion:
      "digest-mismatched head weights -> no swap, prior asset preserved byte-for-byte",
    kind: "digest-fail-heads",
    setup: { color: "green", head_digest_mismatch: true, runs: 1 },
    expected_outcome: "error",
    expected_result: { atomic_swap: false, prior_preserved_bytes: true, sha256_fail: true },
  },
  {
    id: "ENC-PROMO-005",
    assertion:
      "regressed previously-promoted asset -> atomic rollback to previous assetDigestStack entry (O(1) by sha256), event vector_cortex_asset_rollback_back, restored digest + o1 lookup",
    kind: "rollback-stack",
    setup: { color: "green", regressed_promoted: true, stack_depth: 2, runs: 1 },
    expected_outcome: "ok",
    expected_result: { event: "vector_cortex_asset_rollback_back", o1_lookup: true, restored_sha256: true },
  },
  {
    id: "ENC-PROMO-006",
    assertion:
      "flag-off (MEGACOMPACT_ENC_0D=0) -> no candidate accepted, no swap, no events — byte-identical predecessor",
    kind: "flag-off",
    setup: { flag_off: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { atomic_swap: false, candidate_accepted: false, events: 0 },
  },
];

// ── ENC-0e: encoder-demotion fixtures ────────────────────────────────────────
// darwin-x64 explicit demotion reason (HG-4): on an Intel Mac the runtime
// demotes to mode-B WASM (no native binary upstream); ENC-0e surfaces a
// deterministic demotionReason on the runtime-selection event and the Setup
// Cortex blockers card. Fixtures pin the darwin-demoted / non-darwin-control /
// flag-off-event / flag-off-card / card-renders-reason / contract-additive set.
const DEMO_REASON = "darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4";
const DEMO_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema#",
  title: "ENC-0e encoder-demotion fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0e encoder-demotion fixture validates against. `kind` names the demotion/control/flag-off/card/contract branch exercised; `setup` carries {platform, flag_off, card_payload, contract_additive}; `expected_outcome` is ok or error; `expected_result` pins the fields the sprint asserts (backend, demotionReason on the event, absence of demotionReason on the event/card, demoted, reason, card_demotion_row).",
  required: ["id", "producer", "assertion", "kind", "setup", "expected_outcome", "expected_result"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "darwin-demoted",
        "non-darwin-control",
        "flag-off-event",
        "flag-off-card",
        "card-renders-reason",
        "contract-additive",
      ],
    },
    setup: {
      type: "object",
      properties: {
        platform: { type: "string" },
        flag_off: { type: "boolean" },
        card_payload: { type: "boolean" },
        contract_additive: { type: "boolean" },
        runs: { type: "integer" },
      },
    },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
    expected_result: { type: "object" },
  },
};

const demotionFixtures = [
  {
    id: "ENC-DEMO-001",
    assertion:
      "platform darwin-x64 -> backend wasm + concrete demotionReason on the event",
    kind: "darwin-demoted",
    setup: { platform: "darwin-x64", runs: 1 },
    expected_outcome: "ok",
    expected_result: {
      backend: "wasm",
      demotionReason: DEMO_REASON,
      event: "vector_cortex_runtime_selected",
    },
  },
  {
    id: "ENC-DEMO-002",
    assertion:
      "linux-x64/darwin-arm64 -> no demotionReason, existing WASM/native rule unchanged",
    kind: "non-darwin-control",
    setup: { platform: "linux-x64", runs: 1 },
    expected_outcome: "ok",
    expected_result: { backend: "native", demotionReason: null },
  },
  {
    id: "ENC-DEMO-003",
    assertion:
      "flag-off -> event carries no demotionReason (byte-identical predecessor)",
    kind: "flag-off-event",
    setup: { platform: "darwin-x64", flag_off: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { backend: "wasm", demotionReason: null },
  },
  {
    id: "ENC-DEMO-004",
    assertion:
      "flag-off -> /api/setup-cortex-status has no darwinX64 reason; card unchanged",
    kind: "flag-off-card",
    setup: { platform: "darwin-x64", flag_off: true, card_payload: false, runs: 1 },
    expected_outcome: "ok",
    expected_result: { darwinX64_absent: true, card_demotion_row: false },
  },
  {
    id: "ENC-DEMO-005",
    assertion:
      "status payload darwinX64:{demoted:true,reason} renders the diagnosed blocker row",
    kind: "card-renders-reason",
    setup: { platform: "darwin-x64", card_payload: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { demoted: true, card_demotion_row: true },
  },
  {
    id: "ENC-DEMO-006",
    assertion:
      "contract field is additive — non-darwin hosts omit darwinX64, still validate",
    kind: "contract-additive",
    setup: { platform: "linux-x64", contract_additive: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { darwinX64_absent: true, contract_validates: true },
  },
];

// ── ENC-0f: encoder-budget fixtures ───────────────────────────────────────────
// Real-asset qualification gate: p95 ≤ 40 ms @ 512/4 threads + marginal RSS ≤
// 150 MiB (ENCODER_RSS_BUDGET_BYTES, baseline-subtracted) + determinism
// (distinct_digests == 1) + opset-21 handshake. On pass the gate emits a
// QualificationV1 record that flips runtime to qualified mode A; on any failure
// the asset stays demoted to mode B. Flag-off = no gate, no record, byte-identical.
const BUDG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema#",
  title: "ENC-0f encoder-budget fixture envelope",
  type: "object",
  description:
    "Common structure every ENC-0f encoder-budget fixture validates against. `kind` names the qualification/latency/rss/determinism/flag-off branch exercised; `setup` carries the bench input + flag_off override for the gate harness; `expected_outcome` is ok or error; `expected_result` pins the fields the qualification gate must assert (verdict, reasons, p95Ms, rssMib, opset, record_written, events).",
  required: ["id", "producer", "assertion", "kind", "setup", "expected_outcome", "expected_result"],
  properties: {
    id: { type: "string" },
    producer: { type: "string" },
    assertion: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "fully-passing",
        "p95-breach",
        "rss-breach",
        "determinism-opset",
        "determinism-fail",
        "flag-off",
      ],
    },
    setup: {
      type: "object",
      properties: {
        p95_ms: { type: "number" },
        rss_marginal_mib: { type: "number" },
        deterministic: { type: "boolean" },
        distinct_digests: { type: "integer" },
        opset: { type: "integer" },
        flag_off: { type: "boolean" },
        gates_all: { type: "boolean" },
        runs: { type: "integer" },
      },
    },
    expected_outcome: { type: "string", enum: ["ok", "error"] },
    expected_result: { type: "object" },
  },
};

const budgetFixtures = [
  {
    id: "ENC-BUDG-001",
    assertion:
      "fully-passing bench: p95 25ms ≤ 40, marginal RSS 145 MiB ≤ 150, deterministic, opset 21 -> qualified mode A",
    kind: "fully-passing",
    setup: { p95_ms: 25, rss_marginal_mib: 145, deterministic: true, distinct_digests: 1, opset: 21, gates_all: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { verdict: "qualified", reasons: [], p95Ms: 25, rssMib: 145, opset: 21, record_written: true, events: ["vector_cortex_encoder_qualified"] },
  },
  {
    id: "ENC-BUDG-002",
    assertion:
      "p95 75.4ms > 40 (vc2-model-prep measured WASM failure) -> failed (latency), mode B stays",
    kind: "p95-breach",
    setup: { p95_ms: 75.4, rss_marginal_mib: 120, deterministic: true, distinct_digests: 1, opset: 21, gates_all: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { verdict: "failed", reasons: ["latency"], p95Ms: 75.4, rssMib: 120, opset: 21, record_written: true, events: ["vector_cortex_encoder_qualification_failed"] },
  },
  {
    id: "ENC-BUDG-003",
    assertion:
      "marginal RSS 241 MiB > 150 (vc2-model-prep measured) -> failed (rss), mode B stays",
    kind: "rss-breach",
    setup: { p95_ms: 22, rss_marginal_mib: 241, deterministic: true, distinct_digests: 1, opset: 21, gates_all: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { verdict: "failed", reasons: ["rss"], p95Ms: 22, rssMib: 241, opset: 21, record_written: true, events: ["vector_cortex_encoder_qualification_failed"] },
  },
  {
    id: "ENC-BUDG-004",
    assertion:
      "determinism + opset: three-run identical digest (maxAbsDelta 0), opset 21 -> qualified",
    kind: "determinism-opset",
    setup: { p95_ms: 30, rss_marginal_mib: 100, deterministic: true, distinct_digests: 1, opset: 21, gates_all: true, runs: 3 },
    expected_outcome: "ok",
    expected_result: { verdict: "qualified", reasons: [], p95Ms: 30, rssMib: 100, opset: 21, maxAbsDelta: 0, record_written: true, events: ["vector_cortex_encoder_qualified"] },
  },
  {
    id: "ENC-BUDG-005",
    assertion:
      "distinct_digests 2 -> failed (determinism), mode B stays",
    kind: "determinism-fail",
    setup: { p95_ms: 28, rss_marginal_mib: 90, deterministic: false, distinct_digests: 2, opset: 21, gates_all: true, runs: 3 },
    expected_outcome: "ok",
    expected_result: { verdict: "failed", reasons: ["determinism"], p95Ms: 28, rssMib: 90, opset: 21, record_written: true, events: ["vector_cortex_encoder_qualification_failed"] },
  },
  {
    id: "ENC-BUDG-006",
    assertion:
      "flag-off -> no QualificationV1 written, no events, byte-identical predecessor",
    kind: "flag-off",
    setup: { flag_off: true, p95_ms: 25, rss_marginal_mib: 145, deterministic: true, distinct_digests: 1, opset: 21, gates_all: true, runs: 1 },
    expected_outcome: "ok",
    expected_result: { verdict: null, record_written: false, events: [] },
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

  // The ENC-HEADS schema row.
  const headsSchemaBytes = Buffer.from(canonicalJson(HEADS_SCHEMA), "utf8");
  const headsSchemaRel = "schemas/encoder-heads-real-fixture.schema.json";
  writeFileSync(join(V2, headsSchemaRel), headsSchemaBytes);
  rows.push({
    id: "encoder-heads-real-fixture",
    path: headsSchemaRel,
    sha256: sha256Hex(headsSchemaBytes),
    schema: headsSchemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-HEADS fixture rows + on-disk files.
  const headsDir = join(V2, "encoder-heads-real");
  mkdirSync(headsDir, { recursive: true });
  for (const fx of headsFixtures) {
    const obj = { ...fx, schema: headsSchemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-heads-real/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: headsSchemaRel,
      algorithm: "encoder-heads-real",
      producer,
      expected: fx.expected_outcome,
      license: "synthetic",
    });
  }

  // The ENC-PROMO schema row.
  const promoSchemaBytes = Buffer.from(canonicalJson(PROMO_SCHEMA), "utf8");
  const promoSchemaRel = "schemas/encoder-promotion-fixture.schema.json";
  writeFileSync(join(V2, promoSchemaRel), promoSchemaBytes);
  rows.push({
    id: "encoder-promotion-fixture",
    path: promoSchemaRel,
    sha256: sha256Hex(promoSchemaBytes),
    schema: promoSchemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-PROMO fixture rows + on-disk files.
  const promoDir = join(V2, "encoder-promotion");
  mkdirSync(promoDir, { recursive: true });
  for (const fx of promotionFixtures) {
    const obj = { ...fx, schema: promoSchemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-promotion/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: promoSchemaRel,
      algorithm: "encoder-promotion",
      producer,
      expected: fx.expected_outcome,
      license: "synthetic",
    });
  }

  // The ENC-DEMO schema row.
  const demoSchemaBytes = Buffer.from(canonicalJson(DEMO_SCHEMA), "utf8");
  const demoSchemaRel = "schemas/encoder-demotion-fixture.schema.json";
  writeFileSync(join(V2, demoSchemaRel), demoSchemaBytes);
  rows.push({
    id: "encoder-demotion-fixture",
    path: demoSchemaRel,
    sha256: sha256Hex(demoSchemaBytes),
    schema: demoSchemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-DEMO fixture rows + on-disk files.
  const demoDir = join(V2, "encoder-demotion");
  mkdirSync(demoDir, { recursive: true });
  for (const fx of demotionFixtures) {
    const obj = { ...fx, schema: demoSchemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-demotion/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: demoSchemaRel,
      algorithm: "encoder-demotion",
      producer,
      expected: fx.expected_outcome,
      license: "synthetic",
    });
  }

  // The ENC-BUDG schema row.
  const budgSchemaBytes = Buffer.from(canonicalJson(BUDG_SCHEMA), "utf8");
  const budgSchemaRel = "schemas/encoder-budget-fixture.schema.json";
  writeFileSync(join(V2, budgSchemaRel), budgSchemaBytes);
  rows.push({
    id: "encoder-budget-fixture",
    path: budgSchemaRel,
    sha256: sha256Hex(budgSchemaBytes),
    schema: budgSchemaRel,
    algorithm: "json-schema",
    producer,
    expected: "schema",
    license: "synthetic",
  });

  // The 6 ENC-BUDG fixture rows + on-disk files.
  const budgDir = join(V2, "encoder-budget");
  mkdirSync(budgDir, { recursive: true });
  for (const fx of budgetFixtures) {
    const obj = { ...fx, schema: budgSchemaRel, producer };
    const bytes = Buffer.from(canonicalJson(obj), "utf8");
    const rel = `encoder-budget/${fx.id}.json`;
    writeFileSync(join(V2, rel), bytes);
    rows.push({
      id: fx.id,
      path: rel,
      sha256: sha256Hex(bytes),
      schema: budgSchemaRel,
      algorithm: "encoder-budget",
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
  setCsv("domain", "encoder-heads-real");
  setCsv("schemaVersion", "encoder-heads-real-fixture");
  setOwnerCsv("owner", "ENC-0c");
  setCsv("domain", "encoder-promotion");
  setCsv("schemaVersion", "encoder-promotion-fixture");
  setOwnerCsv("owner", "ENC-0d");
  setCsv("domain", "encoder-demotion");
  setCsv("schemaVersion", "encoder-demotion-fixture");
  setOwnerCsv("owner", "ENC-0e");
  setCsv("domain", "encoder-budget");
  setCsv("schemaVersion", "encoder-budget-fixture");
  setOwnerCsv("owner", "ENC-0f");

  writeFileSync(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));

  return {
    fixtureCount:
      fixtures.length +
      trunkFixtures.length +
      headsFixtures.length +
      promotionFixtures.length +
      demotionFixtures.length +
      budgetFixtures.length,
    schemaCount: 6,
  };
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const { fixtureCount, schemaCount } = writeAll();
  console.log(`ml5-enc: wrote ${fixtureCount} fixtures + ${schemaCount} schema, manifest updated.`);
}
