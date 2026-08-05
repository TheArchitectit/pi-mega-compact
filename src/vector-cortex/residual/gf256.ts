/**
 * vector-cortex/residual/gf256.ts — GF(2^8) field arithmetic and matrix algebra
 * for the VC4B Reed–Solomon erasure parity.
 *
 * Field: GF(2^8) with primitive polynomial `0x11d`, elements represented as
 * polynomial-basis bytes (RESIDUAL_CODEC §erasure parity). Log/antilog tables
 * are built once from generator 2 and drive constant-time multiply/divide.
 *
 * Matrix inversion and recovery use DETERMINISTIC left-to-right pivot search and
 * GF Gaussian elimination — no randomness, no iteration-order dependence, so
 * every implementation reaches byte-identical results.
 *
 * Pure arithmetic: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

import { GF_PRIMITIVE_POLYNOMIAL } from "./types.js";

const FIELD_SIZE = 256;

/** `EXP[i] = 2^i` in GF(2^8) (doubled length so multiply needs no modulo). */
const EXP = new Uint8Array(FIELD_SIZE * 2);
/** `LOG[x] = i` such that `2^i = x`; `LOG[0]` is unused (0 has no logarithm). */
const LOG = new Uint8Array(FIELD_SIZE);

(function buildTables(): void {
  let x = 1;
  for (let i = 0; i < FIELD_SIZE - 1; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE_POLYNOMIAL;
  }
  // Mirror the cycle so `EXP[a + b]` is valid for a,b <= 254 without a modulo.
  for (let i = FIELD_SIZE - 1; i < EXP.length; i++) {
    EXP[i] = EXP[i - (FIELD_SIZE - 1)]!;
  }
})();

/** GF(2^8) addition (and subtraction) is XOR. */
export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff;
}

/** GF(2^8) multiplication via log/antilog tables. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** GF(2^8) division; dividing by zero is a programming error and throws. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError("gf256: division by zero");
  if (a === 0) return 0;
  return EXP[LOG[a]! + (FIELD_SIZE - 1) - LOG[b]!]!;
}

/** Multiplicative inverse of a non-zero field element. */
export function gfInv(a: number): number {
  if (a === 0) throw new RangeError("gf256: zero has no inverse");
  return EXP[FIELD_SIZE - 1 - LOG[a]!]!;
}

/** `base^exponent` in GF(2^8) (exponent is a non-negative integer). */
export function gfPow(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  if (base === 0) return 0;
  return EXP[(LOG[base]! * exponent) % (FIELD_SIZE - 1)]!;
}

/** A dense row-major GF(2^8) matrix. */
export interface GfMatrix {
  readonly rows: number;
  readonly cols: number;
  readonly data: Uint8Array;
}

/** Allocate a zero matrix. */
export function gfMatrix(rows: number, cols: number): GfMatrix {
  return { rows, cols, data: new Uint8Array(rows * cols) };
}

/** Read `m[r][c]`. */
export function gfAt(m: GfMatrix, r: number, c: number): number {
  return m.data[r * m.cols + c]!;
}

/** Write `m[r][c] = v`. */
export function gfSet(m: GfMatrix, r: number, c: number, v: number): void {
  m.data[r * m.cols + c] = v;
}

/**
 * Build the `rows x cols` Vandermonde matrix `V[r][c] = alpha_r^c` with the
 * distinct evaluation points `alpha_r = r + 1` (RESIDUAL_CODEC: rows r=0..8,
 * columns c=0..5).
 */
export function vandermonde(rows: number, cols: number): GfMatrix {
  const m = gfMatrix(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      gfSet(m, r, c, gfPow((r + 1) & 0xff, c));
    }
  }
  return m;
}

/** Matrix product `a x b` over GF(2^8). */
export function gfMatMul(a: GfMatrix, b: GfMatrix): GfMatrix {
  const out = gfMatrix(a.rows, b.cols);
  for (let r = 0; r < a.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      let acc = 0;
      for (let i = 0; i < a.cols; i++) {
        acc ^= gfMul(gfAt(a, r, i), gfAt(b, i, c));
      }
      gfSet(out, r, c, acc);
    }
  }
  return out;
}

/** Extract the contiguous row range `[start, start+count)` of a matrix. */
export function gfSubRows(m: GfMatrix, start: number, count: number): GfMatrix {
  const out = gfMatrix(count, m.cols);
  out.data.set(m.data.subarray(start * m.cols, (start + count) * m.cols));
  return out;
}

/** Gather the given row indices (in order) into a new matrix. */
export function gfPickRows(m: GfMatrix, indices: readonly number[]): GfMatrix {
  const out = gfMatrix(indices.length, m.cols);
  indices.forEach((src, dest) => {
    out.data.set(m.data.subarray(src * m.cols, (src + 1) * m.cols), dest * m.cols);
  });
  return out;
}

/**
 * Invert a square GF(2^8) matrix by Gauss–Jordan elimination with a
 * DETERMINISTIC left-to-right pivot search (the first row at or below the
 * current column with a non-zero entry). Returns null when the matrix is
 * singular.
 */
export function gfInvert(m: GfMatrix): GfMatrix | null {
  if (m.rows !== m.cols) return null;
  const n = m.rows;
  const work = gfMatrix(n, n);
  work.data.set(m.data);
  const inv = gfMatrix(n, n);
  for (let i = 0; i < n; i++) gfSet(inv, i, i, 1);

  const swapRows = (mat: GfMatrix, a: number, b: number): void => {
    if (a === b) return;
    for (let c = 0; c < mat.cols; c++) {
      const t = gfAt(mat, a, c);
      gfSet(mat, a, c, gfAt(mat, b, c));
      gfSet(mat, b, c, t);
    }
  };

  for (let col = 0; col < n; col++) {
    // Deterministic pivot: the lowest-index row >= col with a non-zero entry.
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (gfAt(work, r, col) !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) return null; // singular
    swapRows(work, col, pivot);
    swapRows(inv, col, pivot);

    // Normalize the pivot row.
    const pivotValue = gfAt(work, col, col);
    if (pivotValue !== 1) {
      const scale = gfInv(pivotValue);
      for (let c = 0; c < n; c++) {
        gfSet(work, col, c, gfMul(gfAt(work, col, c), scale));
        gfSet(inv, col, c, gfMul(gfAt(inv, col, c), scale));
      }
    }
    // Eliminate the column from every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = gfAt(work, r, col);
      if (factor === 0) continue;
      for (let c = 0; c < n; c++) {
        gfSet(work, r, c, gfAdd(gfAt(work, r, c), gfMul(factor, gfAt(work, col, c))));
        gfSet(inv, r, c, gfAdd(gfAt(inv, r, c), gfMul(factor, gfAt(inv, col, c))));
      }
    }
  }
  return inv;
}
