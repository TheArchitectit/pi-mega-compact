/**
 * l1-minhash.ts — MinHash signatures for L1 near-duplicate detection (Sprint 11).
 *
 * Uses UNIVERSAL HASHING (QA #3), not the broken permutation scheme from the
 * generic dedup plan. Each of the 256 hash functions is `h_i(x) = (a_i·x + b_i)
 * mod p` with a fixed prime `p` and per-index coefficients derived from a pinned
 * seed (0xDEADBEEF). This makes signatures DETERMINISTIC across process restarts
 * (a hard requirement — non-determinism silently breaks dedup).
 *
 * `signatureVersion` lets Sprint 12+ swap the scheme without invalidating stored
 * signatures: old buckets keep their version, new ones get the new one.
 *
 * Pure compute, no deps, no network (PREVENT-PI-004).
 */

import { normalize } from "./normalize.js";

export const SIGNATURE_VERSION = 1;
export const NUM_HASHES = 256;
export const SHINGLE_SIZE = 5; // char 5-grams
const MAX_SHINGLES = 50_000; // QA #7/#15 complexity cap
const SEED = 0xdeadbeef;
const P = 2147483647; // 2^31 - 1, Mersenne prime
const PBigInt = 2147483647n; // BigInt twin of P for overflow-safe modular reduction

/** Per-index universal-hashing coefficients, derived deterministically from SEED. */
function coeffA(i: number): number {
  return (SEED + i * 2 + 1) % P;
}
function coeffB(i: number): number {
  return (SEED * 3 + i * 7 + 13) % P;
}

/** Stable 32-bit FNV-1a of a shingle (the `x` fed to the universal hashes). */
function shingleHash(gram: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < gram.length; k++) {
    h ^= gram.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Char n-gram shingle set (deduped) of normalized text, capped at MAX_SHINGLES. */
export function shingles(text: string, size = SHINGLE_SIZE): number[] {
  const norm = normalize(text);
  if (norm.length === 0) return [];
  const set = new Set<number>();
  if (norm.length < size) {
    set.add(shingleHash(norm));
  } else {
    for (let i = 0; i + size <= norm.length; i++) {
      set.add(shingleHash(norm.slice(i, i + size)));
      if (set.size >= MAX_SHINGLES) break;
    }
  }
  return [...set];
}

/**
 * Compute the 256-element MinHash signature of a text. Each slot is the minimum,
 * over all shingles, of the i-th universal hash. Empty text → all-P sentinel.
 */
export function minhashSignature(text: string): number[] {
  const grams = shingles(text);
  const sig = new Array<number>(NUM_HASHES).fill(P);
  if (grams.length === 0) return sig;
  for (let i = 0; i < NUM_HASHES; i++) {
    const a = coeffA(i);
    const b = coeffB(i);
    let min = P;
    for (const x of grams) {
      // (a*x + b) mod p. a, x < 2^31 (p = 2^31-1), so a*x < 2^62 — EXCEEDS the
      // double-precision safe-integer range (2^53). A naive `(a * (x % P)) % P`
      // loses precision and yields a deterministic-but-mathematically-wrong
      // signature (verified: a=x=p-1 → lossy 2147483644 vs exact 1), which
      // degrades LSH bucketing away from the theoretical Jaccard curve. Compute
      // in BigInt then coerce back — correct by construction, and cheap (~5ms for
      // a full 256-hash × 500-shingle signature; minhash runs only on compaction).
      const h = Number((BigInt(a) * BigInt(x % P) + BigInt(b)) % PBigInt);
      if (h < min) min = h;
    }
    sig[i] = min;
  }
  return sig;
}

/** Estimated Jaccard similarity of two signatures (fraction of equal slots). */
export function signatureSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let equal = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) equal++;
  return equal / n;
}
