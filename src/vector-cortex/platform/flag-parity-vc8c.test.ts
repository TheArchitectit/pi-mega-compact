/**
 * platform/flag-parity-vc8c.test.ts — VC8C flag parity.
 *
 * Mirrors the VC8B flag-parity-vc8b.test.ts pattern: verifies that the
 * pure selector and cross-read arithmetic produce IDENTICAL results
 * regardless of the MEGACOMPACT_VC8C flag state, and that the flag gates
 * ONLY the reporter seam (emit.ts), never the core arithmetic.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectEngine } from "./select.js";
import { encodeNeutralFrame, decodeNeutralFrame } from "./cross-read.js";
import { ABI_VERSION } from "./types.js";
import type { EngineAbiV1, ParityReportV1 } from "./types.js";
import type { NeutralRecord as NR } from "./cross-read.js";

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

function okReport(): ParityReportV1 {
  return {
    schema: "parity-report-v1",
    artifactUrl: "file:///local/rad-artifact",
    commit: COMMIT_40,
    cargoLockDigest: SHA_64,
    artifactCargoLockDigest: SHA_64,
    platform: "linux-x64",
    matrix: Array.from({ length: 30 }, (_, i) => ({
      fixtureId: `RUST-${String(i + 1).padStart(3, "0")}`,
      ok: true,
      code: null,
    })),
  };
}

const RECORD: NR = {
  fixtureId: "RUST-ABI-001",
  outputBytes: "cafebabe",
  failureCode: null,
};

describe("VC8C flag parity", () => {
  test("selectEngine produces the same result regardless of flag state", () => {
    const orig = process.env.MEGACOMPACT_VC8C;
    process.env.MEGACOMPACT_VC8C = "1";
    const onResult = selectEngine(okAbi(), okReport(), "linux-x64");
    process.env.MEGACOMPACT_VC8C = "0";
    const offResult = selectEngine(okAbi(), okReport(), "linux-x64");
    if (orig === undefined) delete process.env.MEGACOMPACT_VC8C;
    else process.env.MEGACOMPACT_VC8C = orig;
    assert.deepEqual(onResult, offResult);
  });

  test("cross-read framing is identical regardless of flag state", () => {
    const orig = process.env.MEGACOMPACT_VC8C;
    process.env.MEGACOMPACT_VC8C = "1";
    const onEncoded = encodeNeutralFrame([RECORD]);
    const onDecoded = decodeNeutralFrame(onEncoded);
    process.env.MEGACOMPACT_VC8C = "0";
    const offEncoded = encodeNeutralFrame([RECORD]);
    const offDecoded = decodeNeutralFrame(offEncoded);
    if (orig === undefined) delete process.env.MEGACOMPACT_VC8C;
    else process.env.MEGACOMPACT_VC8C = orig;
    assert.deepEqual(Array.from(onEncoded), Array.from(offEncoded));
    assert.deepEqual(onDecoded, offDecoded);
  });

  test("the flag gates only the emit seam, never the selector", () => {
    const orig = process.env.MEGACOMPACT_VC8C;
    process.env.MEGACOMPACT_VC8C = "0";
    const sel = selectEngine(okAbi(), okReport(), "linux-x64");
    if (orig === undefined) delete process.env.MEGACOMPACT_VC8C;
    else process.env.MEGACOMPACT_VC8C = orig;
    assert.equal(sel.mode, "A");
    assert.notEqual(sel.artifact, null);
  });
});
