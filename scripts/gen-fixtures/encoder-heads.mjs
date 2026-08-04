// VC2B multi-head encoder fixtures
// (`conformance/vector-cortex/v2/encoder-heads/`).
//
// Owner VC2B (VectorSetV1 / HeadCalibrationDraft). Each fixture declares a head
// emission/fallback scenario the acceptance test executes against the REAL
// heads/trigram/lexical producers (no mocks). `input.scenario` names the
// condition; `expected.ok` pins a success with optional `heads`/`dims`/`width`
// shape facts; a false row pins the exact failure `code`.
//
// ENC-009..016 are the registered VC2B conformance rows; the three NAMED rows
// (ENC-HEAD-001 / ENC-ZERO-002 / ENC-FALLBACK-003) pin the sprint's headline
// assertions (shape parity, zero-norm safety, asset-free trigram-B).

import { producer } from "./common.mjs";

const ENC_SCHEMA = "schemas/encoder-heads-fixture.schema.json";

function encFixture(id, assertion, input, expected) {
  return { id, schema: ENC_SCHEMA, producer, assertion, kind: "encoder-heads", input, expected };
}

export const fixtures = [
  // ENC-009 — a full VectorSetV1 emits all five heads in stable order.
  encFixture(
    "ENC-009",
    "a full VectorSetV1 emits all five heads in stable order with dims 384/128/128/64/32",
    { scenario: "full-set" },
    { ok: true, heads: 5, dims: [384, 128, 128, 64, 32] },
  ),
  // ENC-010 — the semantic head emits 384 dims.
  encFixture(
    "ENC-010",
    "the semantic head emits a 384-dim L2-normalized vector",
    { scenario: "head", head: "semantic" },
    { ok: true, head: "semantic", dim: 384 },
  ),
  // ENC-011 — the dependency head emits 128 dims.
  encFixture(
    "ENC-011",
    "the dependency head emits a 128-dim L2-normalized vector",
    { scenario: "head", head: "dependency" },
    { ok: true, head: "dependency", dim: 128 },
  ),
  // ENC-012 — the contradiction head emits 128 dims.
  encFixture(
    "ENC-012",
    "the contradiction head emits a 128-dim L2-normalized vector",
    { scenario: "head", head: "contradiction" },
    { ok: true, head: "contradiction", dim: 128 },
  ),
  // ENC-013 — the cacheStability head emits 64 dims.
  encFixture(
    "ENC-013",
    "the cacheStability head emits a 64-dim L2-normalized vector",
    { scenario: "head", head: "cacheStability" },
    { ok: true, head: "cacheStability", dim: 64 },
  ),
  // ENC-014 — the payloadRouting head emits 32 dims.
  encFixture(
    "ENC-014",
    "the payloadRouting head emits a 32-dim L2-normalized vector",
    { scenario: "head", head: "payloadRouting" },
    { ok: true, head: "payloadRouting", dim: 32 },
  ),
  // ENC-015 — empty input produces a finite all-zero VectorSetV1.
  encFixture(
    "ENC-015",
    "empty input produces finite all-zero vectors for every head",
    { scenario: "zero-input" },
    { ok: true, heads: 5, zero: true },
  ),
  // ENC-016 — the asset-free trigram B emits 512 dims.
  encFixture(
    "ENC-016",
    "the asset-free trigram B emits a 512-dim vector",
    { scenario: "trigram-b" },
    { ok: true, mode: "B", width: 512 },
  ),
];

export const named = [
  // ENC-HEAD-001 — all five output shapes match the ordered dims.
  encFixture(
    "ENC-HEAD-001",
    "all five output shapes match ordered dims 384/128/128/64/32",
    { scenario: "full-set" },
    { ok: true, heads: 5, dims: [384, 128, 128, 64, 32] },
  ),
  // ENC-ZERO-002 — empty input produces finite zero vectors.
  encFixture(
    "ENC-ZERO-002",
    "empty input produces finite all-zero vectors",
    { scenario: "zero-input" },
    { ok: true, heads: 5, zero: true },
  ),
  // ENC-FALLBACK-003 — removed model still yields the 512d trigram B.
  encFixture(
    "ENC-FALLBACK-003",
    "a removed learned model still yields the 512d trigram B (asset-free)",
    { scenario: "trigram-b" },
    { ok: true, mode: "B", width: 512 },
  ),
];
