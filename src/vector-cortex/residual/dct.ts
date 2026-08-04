/**
 * vector-cortex/residual/dct.ts — orthonormal DCT-II basis V1 (VC4B).
 *
 * Basis V1 is the orthonormal DCT-II matrix generated ANALYTICALLY and never
 * learned or stored (RESIDUAL_CODEC §byte scope):
 *
 *   alpha(0) = sqrt(1/n),  alpha(k>0) = sqrt(2/n)
 *   C[k][i]  = alpha(k) * cos(pi * (2i + 1) * k / (2n))
 *
 * Forward coefficients are the dot product with each basis row (the orthonormal
 * least-squares solve); the inverse is the transpose applied to the coefficient
 * vector. Byte mapping is `x = (byte - 127.5) / 127.5`; the inverse maps back
 * with round-to-nearest-even and clamps to 0..255.
 *
 * The full 4096x4096 matrix is ~134 MB of float64, so it is NEVER materialized.
 * Instead the cosine argument `pi*(2i+1)*k/(2n)` is reduced modulo `2n` against
 * a precomputed half-period table of length `2n` — this is EXACTLY the same set
 * of cosine values the matrix would hold (cos is sampled only at the `2n`
 * distinct arguments `pi*j/(2n)`, j = 0..2n-1), so the transform is bit-stable
 * and table-generation is O(n) rather than O(n^2).
 *
 * Pure numeric transform: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

import { RESIDUAL_BLOCK_SIZE } from "./types.js";

/** Byte-to-signal mapping midpoint / half-range (RESIDUAL_CODEC §transform). */
const BYTE_MIDPOINT = 127.5;

/**
 * Cosine table cache keyed by block length. `table[j] = cos(pi * j / (2n))` for
 * j = 0..2n-1; every DCT argument `pi*(2i+1)*k/(2n)` reduces to one of these
 * entries (with a sign) because cos has period `2*pi` = index period `4n`.
 */
const cosTables = new Map<number, Float64Array>();

/** Build (or fetch) the `4n`-entry cosine table for block length `n`. */
function cosTable(n: number): Float64Array {
  const cached = cosTables.get(n);
  if (cached) return cached;
  const period = 4 * n;
  const table = new Float64Array(period);
  for (let j = 0; j < period; j++) {
    table[j] = Math.cos((Math.PI * j) / (2 * n));
  }
  cosTables.set(n, table);
  return table;
}

/** Orthonormal DCT-II row scale: alpha(0)=sqrt(1/n), else sqrt(2/n). */
export function alpha(k: number, n: number): number {
  return k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
}

/**
 * Map a padded byte block to the signal domain: `x = (byte - 127.5) / 127.5`.
 * The input must be exactly `n` bytes (the caller zero-pads the final block).
 */
export function bytesToSignal(block: Uint8Array): Float64Array {
  const out = new Float64Array(block.length);
  for (let i = 0; i < block.length; i++) {
    out[i] = (block[i]! - BYTE_MIDPOINT) / BYTE_MIDPOINT;
  }
  return out;
}

/**
 * Map a reconstructed signal back to bytes: invert the affine map, round to
 * nearest with ties-to-even, and clamp to 0..255 (RESIDUAL_CODEC §transform).
 */
export function signalToBytes(signal: Float64Array): Uint8Array {
  const out = new Uint8Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i]! * BYTE_MIDPOINT + BYTE_MIDPOINT;
    const r = roundHalfToEven(v);
    out[i] = r < 0 ? 0 : r > 255 ? 255 : r;
  }
  return out;
}

/**
 * Round to nearest, ties to even (banker's rounding). `Math.round` rounds ties
 * toward +Infinity, which is NOT the rule RESIDUAL_CODEC mandates.
 */
export function roundHalfToEven(v: number): number {
  const floor = Math.floor(v);
  const diff = v - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exact tie: pick the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Forward orthonormal DCT-II over one block of length `n` (default 4096).
 * `coefficients[k] = alpha(k) * sum_i x[i] * cos(pi*(2i+1)*k/(2n))`, emitted in
 * ascending frequency order `k = 0..n-1` (the exact RESIDUAL_CODEC coefficient
 * order).
 */
export function forwardDct(signal: Float64Array): Float64Array {
  const n = signal.length;
  const table = cosTable(n);
  const period = 4 * n;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    // Argument index advances by 2k each step, starting at k (i=0 gives
    // (2*0+1)*k = k). Reduce modulo the 4n-entry period.
    let idx = k % period;
    const step = (2 * k) % period;
    for (let i = 0; i < n; i++) {
      sum += signal[i]! * table[idx]!;
      idx += step;
      if (idx >= period) idx -= period;
    }
    out[k] = alpha(k, n) * sum;
  }
  return out;
}

/**
 * Inverse orthonormal DCT (the transpose of the forward matrix):
 * `x[i] = sum_k alpha(k) * c[k] * cos(pi*(2i+1)*k/(2n))`.
 */
export function inverseDct(coefficients: Float64Array): Float64Array {
  const n = coefficients.length;
  const table = cosTable(n);
  const period = 4 * n;
  // Pre-scale each coefficient by its row alpha so the inner loop is a plain
  // dot product (identical arithmetic to scaling inside the loop for k, and it
  // keeps the per-i accumulation order stable).
  const scaled = new Float64Array(n);
  for (let k = 0; k < n; k++) scaled[k] = alpha(k, n) * coefficients[k]!;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const step = (2 * i + 1) % period;
    let idx = 0;
    for (let k = 0; k < n; k++) {
      sum += scaled[k]! * table[idx]!;
      idx += step;
      if (idx >= period) idx -= period;
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Split a payload into fixed 4096-byte blocks, zero-padding ONLY the final
 * block. The original length is retained by the caller (the header) so the
 * padding is dropped on decode.
 */
export function splitBlocks(
  payload: Uint8Array,
  blockSize: number = RESIDUAL_BLOCK_SIZE,
): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += blockSize) {
    const block = new Uint8Array(blockSize);
    block.set(payload.subarray(off, Math.min(off + blockSize, payload.length)));
    blocks.push(block);
  }
  return blocks;
}
