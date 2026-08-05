/**
 * vector-cortex/residual/quantize.ts — int16 coefficient quantization + the
 * block-scoped exact correction stream (VC4B).
 *
 * Quantization (RESIDUAL_CODEC §byte scope): signed coefficients are quantized
 * to int16 with a per-block float32 LE scale `max(abs(c))/32767` (an all-zero
 * block has scale 0). Ties round to nearest-even; SATURATION REJECTS the
 * encoding rather than clipping — a value that would land outside
 * [-32767, 32767] returns `RES_QUANTIZE_RANGE`, as does any non-finite input.
 * Dequantization multiplies back by the (float32-rounded) scale.
 *
 * Because quantization may not reproduce the bytes exactly, the encoder appends
 * a block-scoped EXACT correction stream: for each block in ascending u32 LE
 * `blockIndex`, a varint correction count followed by sorted
 * `(u16 offsetWithinBlock, u8 original)` entries. Offsets are 0..4095, duplicate
 * offsets are rejected, and omitted blocks have count zero. Applying the
 * corrections makes post-quantization byte error exactly ZERO.
 *
 * Pure numeric/serialization logic: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { roundHalfToEven } from "./dct.js";
import {
  RESIDUAL_BLOCK_SIZE,
  type BlockCorrectionsV1,
  type CorrectionV1,
  type QuantizedBlockV1,
  type ResidualFailureCode,
} from "./types.js";

/** Int16 quantization limit (symmetric; -32768 is never produced). */
export const INT16_LIMIT = 32767;

/** Quantization result: the block, or the exact rejection code. */
export type QuantizeResult =
  | { ok: true; block: QuantizedBlockV1 }
  | { ok: false; code: ResidualFailureCode };

/**
 * Quantize one block's coefficients to int16 with a per-block float32 scale.
 * Rejects non-finite inputs and any value that would saturate int16 with
 * `RES_QUANTIZE_RANGE` (RESIDUAL_CODEC: saturation rejects encoding).
 */
export function quantizeBlock(coefficients: Float64Array): QuantizeResult {
  let peak = 0;
  for (let i = 0; i < coefficients.length; i++) {
    const c = coefficients[i]!;
    if (!Number.isFinite(c)) return { ok: false, code: "RES_QUANTIZE_RANGE" };
    const a = Math.abs(c);
    if (a > peak) peak = a;
  }
  const out = new Int16Array(coefficients.length);
  if (peak === 0) {
    // All-zero block: scale is exactly 0 and every coefficient stays 0.
    return { ok: true, block: { scale: 0, coefficients: out } };
  }
  // The persisted scale is a float32 — quantize/dequantize with the SAME
  // float32 value the artifact stores so encode and decode agree bit-for-bit.
  const scale = Math.fround(peak / INT16_LIMIT);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { ok: false, code: "RES_QUANTIZE_RANGE" };
  }
  for (let i = 0; i < coefficients.length; i++) {
    const q = roundHalfToEven(coefficients[i]! / scale);
    if (q > INT16_LIMIT || q < -INT16_LIMIT) {
      return { ok: false, code: "RES_QUANTIZE_RANGE" };
    }
    out[i] = q;
  }
  return { ok: true, block: { scale, coefficients: out } };
}

/** Dequantize a block back to float coefficients (`coefficient * scale`). */
export function dequantizeBlock(block: QuantizedBlockV1): Float64Array {
  const out = new Float64Array(block.coefficients.length);
  for (let i = 0; i < block.coefficients.length; i++) {
    out[i] = block.coefficients[i]! * block.scale;
  }
  return out;
}

/**
 * Diff a reconstructed block against the original, producing the sorted
 * correction entries for that block (empty when the reconstruction is exact).
 */
export function diffBlock(
  original: Uint8Array,
  reconstructed: Uint8Array,
): CorrectionV1[] {
  const out: CorrectionV1[] = [];
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== reconstructed[i]) {
      out.push({ offset: i, original: original[i]! });
    }
  }
  return out;
}

/** Apply a block's corrections in place over a reconstructed block. */
export function applyCorrections(
  reconstructed: Uint8Array,
  corrections: readonly CorrectionV1[],
): { ok: true } | { ok: false; code: ResidualFailureCode } {
  let previous = -1;
  for (const c of corrections) {
    if (!Number.isInteger(c.offset) || c.offset < 0 || c.offset >= reconstructed.length) {
      return { ok: false, code: "RES_CORRECTION_RANGE" };
    }
    if (!Number.isInteger(c.original) || c.original < 0 || c.original > 255) {
      return { ok: false, code: "RES_CORRECTION_RANGE" };
    }
    // Entries are sorted ascending with no duplicate offset.
    if (c.offset === previous) {
      return { ok: false, code: "RES_CORRECTION_DUPLICATE_OFFSET" };
    }
    if (c.offset < previous) return { ok: false, code: "RES_CORRECTION_RANGE" };
    previous = c.offset;
    reconstructed[c.offset] = c.original;
  }
  return { ok: true };
}

// ── varint (LEB128, unsigned) ───────────────────────────────────────────────

/** Encode an unsigned integer as LEB128 varint bytes. */
export function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("varint requires a non-negative integer");
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}

/** Decode an LEB128 varint at `offset`; returns the value and the next offset. */
export function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (; i < bytes.length; i++) {
    const byte = bytes[i]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift *= 128;
    if (shift > Number.MAX_SAFE_INTEGER) return null;
  }
  return null;
}

// ── correction stream serialization ─────────────────────────────────────────

/**
 * Serialize the block-scoped correction stream: a varint block count, then for
 * each NON-EMPTY block in ascending order a u32 LE blockIndex, a varint
 * correction count, and the sorted `(u16 LE offset, u8 original)` entries.
 * Omitted blocks have an implicit count of zero.
 */
export function serializeCorrections(
  blocks: readonly BlockCorrectionsV1[],
): Uint8Array {
  const present = blocks
    .filter((b) => b.corrections.length > 0)
    .slice()
    .sort((a, b) => a.blockIndex - b.blockIndex);
  const out: number[] = [];
  out.push(...encodeVarint(present.length));
  for (const b of present) {
    out.push(
      b.blockIndex & 0xff,
      (b.blockIndex >>> 8) & 0xff,
      (b.blockIndex >>> 16) & 0xff,
      (b.blockIndex >>> 24) & 0xff,
    );
    out.push(...encodeVarint(b.corrections.length));
    for (const c of b.corrections) {
      out.push(c.offset & 0xff, (c.offset >>> 8) & 0xff, c.original & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Parse a serialized correction stream. Returns null on any malformed input. */
export function parseCorrections(
  bytes: Uint8Array,
  offset: number,
): { blocks: BlockCorrectionsV1[]; next: number } | null {
  const head = decodeVarint(bytes, offset);
  if (!head) return null;
  let pos = head.next;
  const blocks: BlockCorrectionsV1[] = [];
  let previousIndex = -1;
  for (let b = 0; b < head.value; b++) {
    if (pos + 4 > bytes.length) return null;
    const blockIndex =
      bytes[pos]! |
      (bytes[pos + 1]! << 8) |
      (bytes[pos + 2]! << 16) |
      (bytes[pos + 3]! << 24);
    pos += 4;
    if (blockIndex < 0 || blockIndex <= previousIndex) return null;
    previousIndex = blockIndex;
    const count = decodeVarint(bytes, pos);
    if (!count) return null;
    pos = count.next;
    const corrections: CorrectionV1[] = [];
    let previousOffset = -1;
    for (let i = 0; i < count.value; i++) {
      if (pos + 3 > bytes.length) return null;
      const off = bytes[pos]! | (bytes[pos + 1]! << 8);
      const original = bytes[pos + 2]!;
      pos += 3;
      if (off >= RESIDUAL_BLOCK_SIZE) return null;
      if (off <= previousOffset) return null; // duplicate or unsorted
      previousOffset = off;
      corrections.push({ offset: off, original });
    }
    blocks.push({ blockIndex, corrections });
  }
  return { blocks, next: pos };
}
