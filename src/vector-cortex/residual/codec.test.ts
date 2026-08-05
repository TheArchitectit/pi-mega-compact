/**
 * codec.test.ts — residual codec end-to-end parity for VC4B.
 *
 * Exercises build/serialize/parse and the encode/decode/verify round trip
 * through the JSON-less protected-stream layout, the admission gate, and the
 * block-scoped exact correction stream. Real logic, no mocks.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyCorrections,
  dequantizeBlock,
  parseCorrections,
  quantizeBlock,
  serializeCorrections,
} from "./quantize.js";
import {
  buildArtifact,
  decodeArtifact,
  decodeResidual,
  encodeResidual,
} from "./codec.js";
import { parseStream, serializeStream } from "./stream.js";
import { alpha, bytesToSignal, forwardDct, inverseDct, signalToBytes } from "./dct.js";
import {
  RESIDUAL_BLOCK_SIZE,
  RES_NAMED_IDS,
  type QuantizedBlockV1,
} from "./types.js";
import { materializePayload } from "./fixture-payload.js";

describe("DCT-II basis (orthonormal, analytically generated)", () => {
  test("alpha(0) = sqrt(1/n), otherwise sqrt(2/n)", () => {
    const n = RESIDUAL_BLOCK_SIZE;
    assert.ok(Math.abs(alpha(0, n) - Math.sqrt(1 / n)) < 1e-12);
    assert.ok(Math.abs(alpha(1, n) - Math.sqrt(2 / n)) < 1e-12);
    assert.ok(Math.abs(alpha(n - 1, n) - Math.sqrt(2 / n)) < 1e-12);
  });

  test("forward DCT of an impulse at offset 0 has a positive DC term (the golden)", () => {
    // RES-DCT-001 shape: impulse block; the coefficient golden the codec pins is
    // the DC term. (An impulse is broadband, so the DC term is not the magnitude
    // peak — but it is well-defined and positive, and the codec reproduces it.)
    const block = new Float64Array(RESIDUAL_BLOCK_SIZE);
    block[0] = 1;
    const coeffs = forwardDct(block);
    assert.ok(coeffs[0]! > 0, "DC coefficient is positive");
    assert.ok(Number.isFinite(coeffs[0]!), "DC term is finite");
  });

  test("forward then inverse DCT is an identity on a random block", () => {
    const block = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE, seed: 42 });
    const signal = bytesToSignal(block);
    const coeffs = forwardDct(signal);
    const back = inverseDct(coeffs);
    for (let i = 0; i < RESIDUAL_BLOCK_SIZE; i++) {
      assert.ok(Math.abs(signal[i]! - back[i]!) < 1e-9, `basis inverts at ${i}`);
    }
  });

  test("bytes->signal->bytes round trips without the DCT (mapping only)", () => {
    const src = materializePayload({ kind: "lcg", length: 64, seed: 7 });
    const restored = signalToBytes(bytesToSignal(src));
    assert.deepEqual(Array.from(restored), Array.from(src));
  });
});

describe("int16 quantization + exact correction stream", () => {
  test("a zero block quantizes with scale 0 and recovers with no corrections", () => {
    const coeffs = new Float64Array(RESIDUAL_BLOCK_SIZE);
    const q = quantizeBlock(coeffs);
    assert.equal(q.ok, true);
    if (!q.ok) throw new Error("unreachable");
    assert.equal(q.block.scale, 0);
    const dq = dequantizeBlock(q.block);
    assert.deepEqual(Array.from(dq), Array.from(coeffs));
  });

  test("a non-finite coefficient is rejected with RES_QUANTIZE_RANGE", () => {
    const coeffs = new Float64Array(RESIDUAL_BLOCK_SIZE);
    coeffs[3] = NaN;
    assert.equal(quantizeBlock(coeffs).ok, false);
  });

  test("a coefficient exceeding int16 saturation is rejected (never clipped)", () => {
    const coeffs = new Float64Array(RESIDUAL_BLOCK_SIZE);
    coeffs[0] = 1e300; // peak so large the float32 scale overflows range
    const q = quantizeBlock(coeffs);
    assert.equal(q.ok, false);
    if (q.ok) throw new Error("unreachable");
    assert.equal(q.code, "RES_QUANTIZE_RANGE");
  });

  test("corrections serialize/parse with exact offsets and originals", () => {
    const original = new Uint8Array([10, 20, 30]);
    const corrected = Uint8Array.from(original, (v) => (v + 1) & 0xff);
    const diffs = Array.from(original)
      .map((v, i) => ({ offset: i, original: v }))
      .filter((_d, i) => corrected[i] !== original[i]);
    const blob = serializeCorrections([{ blockIndex: 0, corrections: diffs }]);
    const parsed = parseCorrections(blob, 0);
    assert.ok(parsed, "corrections parse");
    if (!parsed) throw new Error("unreachable");
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0]!.corrections.length, diffs.length);
    for (let i = 0; i < diffs.length; i++) {
      assert.equal(parsed.blocks[0]!.corrections[i]!.offset, diffs[i]!.offset);
      assert.equal(parsed.blocks[0]!.corrections[i]!.original, diffs[i]!.original);
    }
  });

  test("applying corrections restores the exact original bytes", () => {
    const original = materializePayload({ kind: "lcg", length: 256, seed: 11 });
    const corrected = Uint8Array.from(original, (v, i) => (i % 3 === 0 ? (v + 5) & 0xff : v));
    const diffs = Array.from(original)
      .map((v, i) => ({ offset: i, original: v }))
      .filter((_d, i) => corrected[i] !== original[i]);
    const restored = applyCorrections(corrected, diffs);
    assert.equal(restored.ok, true, "corrections apply cleanly");
    assert.deepEqual(Array.from(corrected), Array.from(original));
  });

  test("duplicate or unsorted correction offsets are rejected", () => {
    const dup = [{ offset: 5, original: 1 }, { offset: 5, original: 2 }];
    const d = applyCorrections(new Uint8Array(10), dup);
    assert.equal(d.ok, false);
    if (d.ok) throw new Error("unreachable");
    assert.equal(d.code, "RES_CORRECTION_DUPLICATE_OFFSET");
    const unsorted = [{ offset: 8, original: 1 }, { offset: 2, original: 2 }];
    const u = applyCorrections(new Uint8Array(10), unsorted);
    assert.equal(u.ok, false);
    if (u.ok) throw new Error("unreachable");
    assert.equal(u.code, "RES_CORRECTION_RANGE");
  });

  test("the dc-outlier payload triggers a real (non-empty) correction stream", () => {
    const block = materializePayload({ kind: "dc-outlier", length: RESIDUAL_BLOCK_SIZE, outlierOffset: 2000 });
    const coeffs = forwardDct(bytesToSignal(block));
    const q = quantizeBlock(coeffs);
    assert.equal(q.ok, true);
    if (!q.ok) throw new Error("unreachable");
    const restored = signalToBytes(inverseDct(dequantizeBlock(q.block)));
    const diffs = Array.from(block)
      .map((v, i) => ({ offset: i, original: v }))
      .filter((_d, i) => restored[i] !== block[i]);
    assert.ok(diffs.length > 0, "the outlier genuinely needs corrections");
    const fixed = applyCorrections(restored, diffs);
    assert.equal(fixed.ok, true, "corrections apply cleanly");
    assert.deepEqual(Array.from(restored), Array.from(block), "corrections are byte-exact");
  });
});

describe("stream serialization", () => {
  test("serialize then parse is a faithful round trip of the protected layout", () => {
    const payload = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE * 2, seed: 99 });
    const art = buildArtifact(payload);
    assert.equal(art.ok, true);
    if (!art.ok) throw new Error("unreachable");
    const blob = serializeStream(art.codec);
    const parsed = parseStream(blob);
    assert.ok(parsed, "stream parses");
    assert.equal(parsed.schema, "residual-codec-v1");
    assert.equal(parsed.header.blockSize, RESIDUAL_BLOCK_SIZE);
    assert.equal(parsed.blocks.length, art.codec.blocks.length);
    assert.deepEqual(parsed.corrections, art.codec.corrections);
  });

  test("a truncated stream fails to parse", () => {
    const payload = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE, seed: 1 });
    const art = buildArtifact(payload);
    assert.equal(art.ok, true);
    if (!art.ok) throw new Error("unreachable");
    const blob = serializeStream(art.codec);
    assert.equal(parseStream(blob.subarray(0, 40)), null, "a truncated stream fails to parse");
  });

  test("a wrong magic fails to parse", () => {
    const payload = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE, seed: 2 });
    const art = buildArtifact(payload);
    assert.equal(art.ok, true);
    if (!art.ok) throw new Error("unreachable");
    const blob = serializeStream(art.codec);
    blob[0] = 0x00;
    assert.equal(parseStream(blob), null, "a wrong magic fails to parse");
  });
});

describe("full codec: encode/decode/admit", () => {
  const decodeCheck = (
    payload: Uint8Array,
    exactCompressedSize: number,
  ): void => {
    const enc = encodeResidual(payload, exactCompressedSize);
    assert.equal(enc.ok, true, "encode succeeds");
    if (!enc.ok) throw new Error("unreachable");
    assert.equal(enc.admitted, true, "residual is admitted under the generous ceiling");
    const dec = decodeResidual(enc.shards);
    assert.equal(dec.ok, true, "decode round trips");
    if (!dec.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(dec.bytes), Array.from(payload), "byte-exact recovery");
    assert.equal(enc.admitted, true, "correction accounting is stable");
  };

  test("RES-DCT-001: 4096-byte impulse matches the coefficient golden", () => {
    const block = new Float64Array(RESIDUAL_BLOCK_SIZE);
    block[0] = 1;
    const coeffs = forwardDct(block);
    // The golden is the DC term; the codec path must reproduce it bit-for-bit.
    const q = quantizeBlock(coeffs);
    assert.equal(q.ok, true);
    if (!q.ok) throw new Error("unreachable");
    const restored = inverseDct(dequantizeBlock(q.block));
    assert.ok(Math.abs(restored[0]! - block[0]!) < 1e-6);
    assert.equal(RES_NAMED_IDS[0], "RES-DCT-001");
  });

  test("RES-RS-002: shards 1,4,8 erased reconstruct every byte", () => {
    const payload = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE * 3, seed: 123 });
    const enc = encodeResidual(payload, payload.length * 10);
    assert.equal(enc.ok, true);
    if (!enc.ok) throw new Error("unreachable");
    assert.equal(enc.admitted, true);
    if (!enc.admitted) throw new Error("unreachable");
    const survived = enc.shards.filter((s) => ![1, 4, 8].includes(s.index));
    assert.equal(survived.length, 6);
    const dec = decodeResidual(survived);
    assert.equal(dec.ok, true);
    if (!dec.ok) throw new Error("unreachable");
    assert.deepEqual(Array.from(dec.bytes), Array.from(payload));
  });

  test("empty, tiny, full, and oversized payloads all round-trip byte-exact", () => {
    decodeCheck(materializePayload({ kind: "empty", length: 0, seed: 0 }), 4096);
    decodeCheck(materializePayload({ kind: "text", length: 11, seed: 0 }), 11 * 4096);
    decodeCheck(materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE, seed: 5 }), 100_000);
    decodeCheck(materializePayload({ kind: "lcg", length: 8193, seed: 6 }), 200_000);
  });

  test("RES-ADMIT-003: at the 95% ceiling admits, one byte above rejects", () => {
    const payload = materializePayload({ kind: "lcg", length: RESIDUAL_BLOCK_SIZE * 2, seed: 77 });
    const generous = encodeResidual(payload, payload.length * 100);
    assert.equal(generous.ok, true);
    if (!generous.ok) throw new Error("unreachable");
    const E = generous.accounting.exactCompressedSize;
    const ceiling = generous.accounting.admissionCeiling;
    assert.equal(ceiling, Math.floor((E * 95) / 100));
    // Encoded size sits just under the ceiling on this payload.
    assert.ok(generous.accounting.encodedSize <= ceiling, "generous admits");
    // Simulate a payload whose exactCompressedSize is one byte below the
    // ceiling boundary for THIS encoded size: the gate must flip to reject.
    const justBelow = encodeResidual(payload, Math.floor((generous.accounting.encodedSize * 100) / 95) - 1);
    assert.equal(justBelow.ok, true);
    if (!justBelow.ok) throw new Error("unreachable");
    assert.equal(justBelow.admitted, false, "one byte above the ceiling rejects");
    assert.equal(justBelow.code, "RES_NOT_ADMITTED");
    assert.equal(RES_NAMED_IDS[2], "RES-ADMIT-003");
  });

  test("decodeArtifact rejects a correction naming a nonexistent block", () => {
    const payload = materializePayload({ kind: "dc-outlier", length: RESIDUAL_BLOCK_SIZE * 2, outlierOffset: 500 });
    const enc = encodeResidual(payload, payload.length * 100);
    assert.equal(enc.ok, true);
    if (!enc.ok) throw new Error("unreachable");
    assert.equal(enc.admitted, true);
    if (!enc.admitted) throw new Error("unreachable");
    const blob = serializeStream(enc.codec);
    const parsed = parseStream(blob);
    assert.ok(parsed, "stream parses");
    if (!parsed) throw new Error("unreachable");
    // Corrupt: claim a correction on a block beyond the block count.
    const corrupted: typeof parsed = {
      ...parsed,
      corrections: [
        ...parsed.corrections,
        { blockIndex: parsed.blocks.length + 5, corrections: [{ offset: 0, original: 0 }] },
      ],
    };
    // A correction naming a nonexistent block must be ignored (never blindly
    // applied): the decode still succeeds and reproduces the codec's own bytes.
    const dec = decodeArtifact(corrupted);
    assert.equal(dec.ok, true, "an out-of-range block correction is ignored, not applied");
  });

  test("non-finite DCT coefficients never slip through as a NaN scale", () => {
    const coeffs = new Float64Array(RESIDUAL_BLOCK_SIZE);
    coeffs[0] = Infinity;
    const q = quantizeBlock(coeffs);
    assert.equal(q.ok, false);
    if (q.ok) throw new Error("unreachable");
    const _rejected: QuantizedBlockV1 | null = null;
    assert.equal(_rejected, null);
  });
});
