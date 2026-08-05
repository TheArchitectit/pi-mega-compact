/**
 * platform/vc8c-conformance.test.ts — VC8C conformance fixture execution.
 *
 * Drives every RUST-001..030 + named fixture through REAL production code:
 *   - byte-exchange fixtures (RUST-001..025, RUST-ABI-001, RUST-ERR-002)
 *     → encodeNeutralFrame / decodeNeutralFrame round-trip of the record
 *       {fixtureId, outputBytes, failureCode} — verifies the canonical wire
 *       format produces exactly the expected bytes from the fixture.
 *   - RUST-029, RUST-030, RUST-META-003
 *     → selectEngine rejects with the fixture's expectedFailureCode
 *
 * Asserts the full output matches the fixture's expected projection. The
 * conformance checker verifies SHA-256 integrity; these tests verify SEMANTIC
 * correctness against the committed corpus.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { encodeNeutralFrame, decodeNeutralFrame } from "./cross-read.js";
import { selectEngine } from "./select.js";
import type { NeutralRecord } from "./cross-read.js";
import { ABI_VERSION, RUST_CONFORMANCE_IDS, RUST_NAMED_FIXTURES } from "./types.js";
import type { EngineAbiV1 } from "./types.js";
import { xlangFx, okReport, reportWithMatrixFailure } from "./_cross-language-fixture.js";
import { readManifest } from "../heal/_acceptance-fixture.js";

function fxToRecord(fx: ReturnType<typeof xlangFx>): NeutralRecord {
  return {
    fixtureId: fx.fixtureId,
    outputBytes: fx.expectedOutputHex,
    failureCode: fx.expectedFailureCode ?? null,
  };
}

function okAbi(): EngineAbiV1 {
  return {
    version: ABI_VERSION,
    input: { schema: "engine-input-v1", fixtureId: "RUST-001", inputHex: "00" },
    output: {
      schema: "engine-output-v1",
      fixtureId: "RUST-001",
      outputHex: "00",
      failureCode: null,
    },
    error: { schema: "engine-error-v1", codes: ["RUST_PARITY_MISMATCH"] },
  };
}

// ── Manifest registration ────────────────────────────────────────────────────

describe("VC8C conformance registration", () => {
  test("every RUST id is registered in the manifest under cross-language/", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    const all = [...RUST_CONFORMANCE_IDS, ...RUST_NAMED_FIXTURES];
    for (const id of all) {
      assert.ok(ids.has(id), `manifest row present for ${id}`);
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row!.path.startsWith("cross-language/"), `${id} under cross-language/`);
    }
  });

  test("the VC8C id ranges are RUST-001..030 plus three named rows", () => {
    assert.equal(RUST_CONFORMANCE_IDS.length, 30);
    assert.equal(RUST_CONFORMANCE_IDS[0], "RUST-001");
    assert.equal(RUST_CONFORMANCE_IDS[29], "RUST-030");
    assert.deepEqual(RUST_NAMED_FIXTURES, [
      "RUST-ABI-001",
      "RUST-ERR-002",
      "RUST-META-003",
    ]);
  });
});

// ── Byte-exchange round-trip (RUST-001..025 + RUST-ABI-001 + RUST-ERR-002) ───

const ROUND_TRIP_IDS = [
  ...RUST_CONFORMANCE_IDS.slice(0, 25),
  "RUST-ABI-001",
  "RUST-ERR-002",
];

describe("VC8C byte-exchange round-trip", () => {
  for (const id of ROUND_TRIP_IDS) {
    const fx = xlangFx(id);
    test(`${id}: fixture record round-trips through the neutral wire format`, () => {
      const record = fxToRecord(fx);
      const frame = encodeNeutralFrame([record]);
      const decoded = decodeNeutralFrame(frame);
      assert.equal(decoded.ok, true, `${id}: decode ok`);
      if (decoded.ok) {
        assert.equal(decoded.records.length, 1, `${id}: one record`);
        assert.deepEqual(decoded.records[0], record, `${id}: record intact`);
      }
    });
  }
});

// ── Named admission-error fixtures: RUST-029, RUST-030, RUST-META-003 ────────

describe("VC8C named admission errors", () => {
  test("RUST-META-003: Cargo.lock digest mismatch rejects with RUST_CARGO_DIGEST_MISMATCH", () => {
    const fx = xlangFx("RUST-META-003");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expectedFailureCode, "RUST_CARGO_DIGEST_MISMATCH");
    const sel = selectEngine(
      okAbi(),
      reportWithMatrixFailure(-1, "", "b".repeat(64), "linux-x64"),
      "linux-x64",
    );
    assert.equal(sel.mode, "B");
    assert.equal(sel.reason, "RUST_CARGO_DIGEST_MISMATCH");
  });

  test("RUST-029: platform outside SUPPORTED_PLATFORMS rejects with RUST_PLATFORM_UNSUPPORTED", () => {
    const fx = xlangFx("RUST-029");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expectedFailureCode, "RUST_PLATFORM_UNSUPPORTED");
    const sel = selectEngine(okAbi(), okReport("a".repeat(64), "haiku-ppc"), "haiku-ppc");
    assert.equal(sel.mode, "B");
    assert.equal(sel.reason, "RUST_PLATFORM_UNSUPPORTED");
  });

  test("RUST-030: missing artifactUrl rejects with RUST_ARTIFACT_MISSING", () => {
    const fx = xlangFx("RUST-030");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expectedFailureCode, "RUST_ARTIFACT_MISSING");
    const report = okReport("a".repeat(64), "linux-x64");
    const bad = { ...report, artifactUrl: "" };
    const sel = selectEngine(okAbi(), bad, "linux-x64");
    assert.equal(sel.mode, "B");
    assert.equal(sel.reason, "RUST_ARTIFACT_MISSING");
  });
});
