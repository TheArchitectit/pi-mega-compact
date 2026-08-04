// VC2A encoder-runtime fixtures (`conformance/vector-cortex/v2/encoder-runtime/`).
//
// Owner VC2A (ModelManifestV1 / EncoderRuntime). Each fixture declares a load
// scenario the acceptance test executes against a TEMP asset dir (so the
// committed corpus stays canonical and digest-free): a valid opset-17/batch-1/
// max-512 manifest + matching file digests demote to a mode-A qualified load;
// any mutation/constraint break returns the exact `expected.code`.
//
// ENC-001..008 are the registered VC2A conformance rows; the three NAMED rows
// (ENC-ASSET-001 / ENC-DIGEST-002 / ENC-PLATFORM-003) pin the sprint's headline
// assertions.

import { producer } from "./common.mjs";

const ENC_SCHEMA = "schemas/encoder-runtime-fixture.schema.json";

function encFixture(id, assertion, input, expected) {
  return { id, schema: ENC_SCHEMA, producer, assertion, kind: "encoder-runtime", input, expected };
}

export const fixtures = [
  // ENC-001 — a valid opset-17 manifest + matching digests verify (mode A).
  encFixture(
    "ENC-001",
    "a valid opset17/batch1/max512 manifest with matching digests verifies",
    { scenario: "valid" },
    { ok: true, mode: "A" },
  ),
  // ENC-002 — one-byte ONNX mutation demotes ENC_DIGEST_MISMATCH.
  encFixture(
    "ENC-002",
    "a one-byte model mutation demotes before load with ENC_DIGEST_MISMATCH",
    { scenario: "mutate-onnx" },
    { ok: false, code: "ENC_DIGEST_MISMATCH" },
  ),
  // ENC-003 — a manifest beyond max tokens (513) demotes ENC_TOKENS_EXCEEDED.
  encFixture(
    "ENC-003",
    "a manifest declaring 513 max tokens demotes ENC_TOKENS_EXCEEDED",
    { scenario: "max-tokens-513" },
    { ok: false, code: "ENC_TOKENS_EXCEEDED" },
  ),
  // ENC-004 — opset != 17 demotes ENC_OPSET_INVALID.
  encFixture(
    "ENC-004",
    "an opset-16 manifest demotes ENC_OPSET_INVALID",
    { scenario: "opset-16" },
    { ok: false, code: "ENC_OPSET_INVALID" },
  ),
  // ENC-005 — batch != 1 demotes ENC_BATCH_INVALID.
  encFixture(
    "ENC-005",
    "a batch-2 manifest demotes ENC_BATCH_INVALID",
    { scenario: "batch-2" },
    { ok: false, code: "ENC_BATCH_INVALID" },
  ),
  // ENC-006 — a truncated/unreadable ONNX demotes ENC_ASSET_UNREADABLE.
  encFixture(
    "ENC-006",
    "a truncated/unreadable ONNX during digest read demotes ENC_ASSET_UNREADABLE",
    { scenario: "missing-onnx" },
    { ok: false, code: "ENC_ASSET_UNREADABLE" },
  ),
  // ENC-007 — an unsupported platform selects trigram B (ENC_PLATFORM_UNSUPPORTED).
  encFixture(
    "ENC-007",
    "an unsupported platform selects trigram B with ENC_PLATFORM_UNSUPPORTED",
    { scenario: "unsupported-platform" },
    { ok: false, code: "ENC_PLATFORM_UNSUPPORTED", mode: "B" },
  ),
  // ENC-008 — an allocator failure after verification demotes ENC_ASSET_UNREADABLE.
  encFixture(
    "ENC-008",
    "an allocator failure after verification demotes with ENC_ASSET_UNREADABLE",
    { scenario: "allocator-fail" },
    { ok: false, code: "ENC_ASSET_UNREADABLE" },
  ),
];

export const named = [
  // ENC-ASSET-001 — opset17 manifest + digest load successfully.
  encFixture(
    "ENC-ASSET-001",
    "an opset17 manifest and matching digest load successfully",
    { scenario: "valid" },
    { ok: true, mode: "A" },
  ),
  // ENC-DIGEST-002 — one-byte model mutation demotes before load.
  encFixture(
    "ENC-DIGEST-002",
    "a one-byte model mutation demotes before load",
    { scenario: "mutate-onnx" },
    { ok: false, code: "ENC_DIGEST_MISMATCH" },
  ),
  // ENC-PLATFORM-003 — unsupported architecture selects trigram B.
  encFixture(
    "ENC-PLATFORM-003",
    "an unsupported architecture selects trigram B",
    { scenario: "unsupported-platform" },
    { ok: false, code: "ENC_PLATFORM_UNSUPPORTED", mode: "B" },
  ),
];
