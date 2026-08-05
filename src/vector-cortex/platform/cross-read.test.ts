/**
 * platform/cross-read.test.ts — VC8C neutral framing tests.
 *
 * Mirrors the VC8B shadow.test.ts pattern: every test feeds REAL inputs into
 * the REAL encode/decode/compare functions (no mocks), verifying the
 * length-framed neutral wire format is byte-exact and round-trip stable.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  encodeNeutralFrame,
  decodeNeutralFrame,
  compareFixtureOutput,
  encodeRecordJson,
} from "./cross-read.js";
import { RUST_FRAME_TRUNCATED, RUST_PARITY_MISMATCH } from "./types.js";
import type { NeutralRecord } from "./cross-read.js";

const FIXTURE_A: NeutralRecord = {
  fixtureId: "RUST-ABI-001",
  outputBytes: "cafebabe",
  failureCode: null,
};

const FIXTURE_B: NeutralRecord = {
  fixtureId: "RUST-ERR-002",
  outputBytes: "deadbeef",
  failureCode: "RUST_PARITY_MISMATCH",
};

describe("cross-read framing", () => {
  test("RUST-016: encode + decode round-trips a single record", () => {
    const encoded = encodeNeutralFrame([FIXTURE_A]);
    const decoded = decodeNeutralFrame(encoded);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.records.length, 1);
      assert.deepEqual(decoded.records[0], FIXTURE_A);
    }
  });

  test("RUST-017: encode + decode round-trips multiple records", () => {
    const encoded = encodeNeutralFrame([FIXTURE_A, FIXTURE_B]);
    const decoded = decodeNeutralFrame(encoded);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.records.length, 2);
      assert.deepEqual(decoded.records[0], FIXTURE_A);
      assert.deepEqual(decoded.records[1], FIXTURE_B);
    }
  });

  test("RUST-018: decode of an empty byte array returns zero records", () => {
    const decoded = decodeNeutralFrame(new Uint8Array(0));
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.records.length, 0);
    }
  });

  test("RUST-019: decode of a truncated frame returns RUST_FRAME_TRUNCATED", () => {
    const encoded = encodeNeutralFrame([FIXTURE_A]);
    const truncated = encoded.subarray(0, encoded.length - 2);
    const decoded = decodeNeutralFrame(truncated);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) {
      assert.equal(decoded.code, RUST_FRAME_TRUNCATED);
    }
  });

  test("RUST-020: decode of a partial header (fewer than 4 bytes) returns TRUNCATED", () => {
    const partial = new Uint8Array([0, 0]);
    const decoded = decodeNeutralFrame(partial);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) {
      assert.equal(decoded.code, RUST_FRAME_TRUNCATED);
    }
  });

  test("RUST-021: decode of corrupt JSON body returns TRUNCATED", () => {
    const body = new TextEncoder().encode("{not json");
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, body.length, false);
    const frame = new Uint8Array([...header, ...body]);
    const decoded = decodeNeutralFrame(frame);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) {
      assert.equal(decoded.code, RUST_FRAME_TRUNCATED);
    }
  });

  test("RUST-022: compareFixtureOutput passes on identical records", () => {
    const result = compareFixtureOutput(FIXTURE_A, FIXTURE_A);
    assert.equal(result.ok, true);
  });

  test("RUST-023: compareFixtureOutput fails on different fixtureId", () => {
    const actual: NeutralRecord = { ...FIXTURE_A, fixtureId: "RUST-999" };
    const result = compareFixtureOutput(FIXTURE_A, actual);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, RUST_PARITY_MISMATCH);
    }
  });

  test("RUST-024: compareFixtureOutput fails on different outputBytes", () => {
    const actual: NeutralRecord = { ...FIXTURE_A, outputBytes: "0000" };
    const result = compareFixtureOutput(FIXTURE_A, actual);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, RUST_PARITY_MISMATCH);
    }
  });

  test("RUST-025: compareFixtureOutput fails on different failureCode", () => {
    const actual: NeutralRecord = { ...FIXTURE_A, failureCode: "some_code" };
    const result = compareFixtureOutput(FIXTURE_A, actual);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, RUST_PARITY_MISMATCH);
    }
  });

  test("RUST-026: encodeRecordJson produces canonical JSON", () => {
    const record: NeutralRecord = { fixtureId: "x", outputBytes: "ab", failureCode: null };
    const bytes = encodeRecordJson(record);
    const text = new TextDecoder().decode(bytes);
    assert.equal(text, JSON.stringify(record));
  });

  test("RUST-027: encode is deterministic (same input, same bytes)", () => {
    const e1 = encodeNeutralFrame([FIXTURE_A, FIXTURE_B]);
    const e2 = encodeNeutralFrame([FIXTURE_A, FIXTURE_B]);
    assert.deepEqual(Array.from(e1), Array.from(e2));
  });

  test("RUST-028: a record with a failure code round-trips", () => {
    const encoded = encodeNeutralFrame([FIXTURE_B]);
    const decoded = decodeNeutralFrame(encoded);
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.records[0].failureCode, "RUST_PARITY_MISMATCH");
    }
  });
});
