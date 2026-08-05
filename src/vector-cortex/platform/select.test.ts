/**
 * platform/select.test.ts — VC8C engine selector tests.
 *
 * Mirrors the VC8B policy.test.ts pattern: every test feeds REAL inputs into
 * the REAL `selectEngine` function (no mocks), verifies the six admission
 * checks, and confirms the failure triad demotes correctly.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selectEngine,
  validateAbi,
  isSupportedPlatform,
  matrixAllOk,
} from "./select.js";
import { ABI_VERSION, RUST_PARITY_MISMATCH } from "./types.js";
import type {
  EngineAbiV1,
  ParityReportV1,
  ParityFixtureResult,
} from "./types.js";

const SHA_64 = "a".repeat(64);
const COMMIT_40 = "0".repeat(40);

function okAbi(): EngineAbiV1 {
  return {
    version: ABI_VERSION,
    input: { schema: "engine-input-v1", fixtureId: "RUST-001", inputHex: "00" },
    output: { schema: "engine-output-v1", fixtureId: "RUST-001", outputHex: "00", failureCode: null },
    error: { schema: "engine-error-v1", codes: ["RUST_PARITY_MISMATCH"] },
  };
}

function okMatrix(): ParityFixtureResult[] {
  return Array.from({ length: 30 }, (_, i) => ({
    fixtureId: `RUST-${String(i + 1).padStart(3, "0")}`,
    ok: true,
    code: null,
  }));
}

function okReport(): ParityReportV1 {
  return {
    schema: "parity-report-v1",
    artifactUrl: "file:///local/rad-artifact",
    commit: COMMIT_40,
    cargoLockDigest: SHA_64,
    artifactCargoLockDigest: SHA_64,
    platform: "linux-x64",
    matrix: okMatrix(),
  };
}

describe("selectEngine", () => {
  test("RUST-001: a fully qualified artifact admits mode A", () => {
    const sel = selectEngine(okAbi(), okReport(), "linux-x64");
    assert.equal(sel.mode, "A");
    assert.equal(sel.reason, "qualified");
    assert.notEqual(sel.artifact, null);
    assert.equal(sel.artifact!.qualified, true);
  });

  test("RUST-002: ABI version mismatch demotes to B", () => {
    const abi = okAbi();
    const bad = { ...abi, version: "engine-abi-v0" as typeof ABI_VERSION };
    const sel = selectEngine(bad, okReport(), "linux-x64");
    assert.equal(sel.mode, "B");
    assert.equal(sel.artifact, null);
  });

  test("RUST-003: missing artifact URL demotes to B", () => {
    const report = okReport();
    const bad = { ...report, artifactUrl: "" };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
    assert.notEqual(sel.reason, "qualified");
  });

  test("RUST-004: bad commit hash demotes to B", () => {
    const report = okReport();
    const bad = { ...report, commit: "not-a-hash" };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
  });

  test("RUST-META-003: Cargo.lock digest mismatch demotes to B", () => {
    const report = okReport();
    const bad = { ...report, artifactCargoLockDigest: "b".repeat(64) };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
    assert.ok(sel.reason.includes("CARGO") || sel.reason.includes("MISMATCH"));
  });

  test("RUST-005: unsupported platform demotes to B", () => {
    const sel = selectEngine(okAbi(), okReport(), "solaris-sparc");
    assert.equal(sel.mode, "B");
    assert.ok(sel.reason.includes("PLATFORM"));
  });

  test("RUST-006: platform mismatch (report says arm64, host is x64) demotes to B", () => {
    const report = okReport();
    const bad = { ...report, platform: "linux-arm64" };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
  });

  test("RUST-007: matrix with a failure demotes to B", () => {
    const report = okReport();
    const matrix = okMatrix();
    matrix[14] = { fixtureId: "RUST-015", ok: false, code: RUST_PARITY_MISMATCH };
    const bad = { ...report, matrix };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
  });

  test("RUST-008: empty matrix demotes to B (no evidence)", () => {
    const report = okReport();
    const bad = { ...report, matrix: [] };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
  });

  test("RUST-009: allowLegacy=true demotes all the way to C", () => {
    const sel = selectEngine(okAbi(), okReport(), "solaris-sparc", true);
    assert.equal(sel.mode, "C");
    assert.equal(sel.artifact, null);
  });

  test("RUST-010: allowLegacy=true on a qualified artifact still admits A", () => {
    const sel = selectEngine(okAbi(), okReport(), "linux-x64", true);
    assert.equal(sel.mode, "A");
  });

  test("RUST-011: validateAbi throws on version mismatch", () => {
    const abi = okAbi();
    const bad = { ...abi, version: "wrong" as typeof ABI_VERSION };
    assert.throws(() => validateAbi(bad));
  });

  test("RUST-012: isSupportedPlatform recognizes all supported platforms", () => {
    assert.ok(isSupportedPlatform("linux-x64"));
    assert.ok(isSupportedPlatform("linux-arm64"));
    assert.ok(isSupportedPlatform("darwin-x64"));
    assert.ok(isSupportedPlatform("darwin-arm64"));
    assert.ok(isSupportedPlatform("win32-x64"));
    assert.ok(!isSupportedPlatform("solaris-sparc"));
  });

  test("RUST-013: matrixAllOk returns false for empty matrix", () => {
    const report = okReport();
    const empty = { ...report, matrix: [] };
    assert.equal(matrixAllOk(empty), false);
  });

  test("RUST-014: matrixAllOk returns false when a fixture has a code", () => {
    const report = okReport();
    const matrix = okMatrix();
    matrix[0] = { fixtureId: "RUST-001", ok: true, code: "some_code" };
    const bad = { ...report, matrix };
    assert.equal(matrixAllOk(bad), false);
  });

  test("RUST-015: selection is deterministic (same inputs, same output)", () => {
    const sel1 = selectEngine(okAbi(), okReport(), "linux-x64");
    const sel2 = selectEngine(okAbi(), okReport(), "linux-x64");
    assert.deepEqual(sel1, sel2);
  });

  test("RUST-029: a platform outside SUPPORTED_PLATFORMS rejects with RUST_PLATFORM_UNSUPPORTED", () => {
    const sel = selectEngine(okAbi(), okReport(), "haiku-ppc");
    assert.equal(sel.mode, "B");
    assert.equal(sel.reason, "RUST_PLATFORM_UNSUPPORTED");
  });

  test("RUST-030: an empty artifactUrl rejects with RUST_ARTIFACT_MISSING", () => {
    const report = okReport();
    const bad = { ...report, artifactUrl: "" };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
    assert.equal(sel.reason, "RUST_ARTIFACT_MISSING");
  });
});
