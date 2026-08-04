// VC2C encoder-qualification fixtures
// (`conformance/vector-cortex/v2/encoder-qualification/`).
//
// Owner VC2C (QualifiedEncoderV1 / CalibrationV1). Each fixture declares a
// qualification/calibration scenario the acceptance test executes against the
// REAL calibrate/select/fallback producers (no mocks). `input.scenario` names
// the condition; `expected.ok` pins a mode-A qualification (with the calibration
// split digest honored) or the exact demotion `code`.
//
// ENC-017..020 are the registered VC2C conformance rows; the three NAMED rows
// (ENC-CAL-001 / ENC-ATOMIC-002 / ENC-PACK-003) pin the sprint's headline
// assertions (calibration held-out exclusion, atomic A demotion, package listing).

import { producer } from "./common.mjs";

const ENC_SCHEMA = "schemas/encoder-qualification-fixture.schema.json";

function encFixture(id, assertion, input, expected) {
  return { id, schema: ENC_SCHEMA, producer, assertion, kind: "encoder-qualification", input, expected };
}

export const fixtures = [
  // ENC-017 — a fully satisfactory held-out set qualifies as mode A.
  encFixture(
    "ENC-017",
    "a fully satisfactory held-out metrics set qualifies the asset as mode A",
    { scenario: "qualified" },
    { ok: true, mode: "A" },
  ),
  // ENC-018 — a calibration split digest is produced and held-out labels excluded.
  encFixture(
    "ENC-018",
    "calibration fit produces a split digest and excludes held-out labels from the fit",
    { scenario: "calibration-fit" },
    { ok: true, mode: "A" },
  ),
  // ENC-019 — one failed causal head demotes the entire A (atomic).
  encFixture(
    "ENC-019",
    "one failed causal head (dependency) demotes the entire A",
    { scenario: "one-failed-causal-head" },
    { ok: false, code: "ENC_QUALIFICATION_THRESHOLD_FAILED", mode: "B" },
  ),
  // ENC-020 — corrupt qualification manifest after calibration demotes A to B.
  encFixture(
    "ENC-020",
    "a corrupt qualification manifest after calibration demotes A with ENC_QUALIFICATION_DIGEST_MISMATCH",
    { scenario: "qualification-digest-mismatch" },
    { ok: false, code: "ENC_QUALIFICATION_DIGEST_MISMATCH", mode: "B" },
  ),
];

export const named = [
  // ENC-CAL-001 — calibration fit excludes held-out fixture IDs.
  encFixture(
    "ENC-CAL-001",
    "calibration fit excludes held-out fixture IDs from fit inputs",
    { scenario: "held-out-exclusion" },
    { ok: true, mode: "A" },
  ),
  // ENC-ATOMIC-002 — one failed causal head demotes every field of A.
  encFixture(
    "ENC-ATOMIC-002",
    "one failed causal head demotes the entire A (no partial A)",
    { scenario: "one-failed-causal-head" },
    { ok: false, code: "ENC_QUALIFICATION_THRESHOLD_FAILED", mode: "B" },
  ),
  // ENC-PACK-003 — clean package listing contains the manifest and ONNX under 35MiB.
  encFixture(
    "ENC-PACK-003",
    "clean package listing contains the qualification manifest and ONNX under 35MiB",
    { scenario: "package-listing" },
    { ok: true, budgetBytes: 35 * 1024 * 1024 },
  ),
];
