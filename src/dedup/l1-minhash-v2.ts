/**
 * l1-minhash-v2.ts — MinHash V2 signatures (VC1C, M4 minhash-v2).
 *
 * The v1 path (l1-minhash.ts) uses 32-bit universal hashing with `p=2^31-1`
 * and Number math, which is exact because a*x < 2^62 can overflow double
 * precision (>= 2^53) and is reduced too eagerly. MinHashV2 freezes a v2
 * scheme that is CROSS-LANGUAGE deterministic and byte-exact:
 *
 *   - normalization: the stable `normalize()` from normalize.ts (NFC, NFKC
 *     case-fold, CRLF->LF, whitespace collapse, 32K cap);
 *   - shingles: windows of FIVE CODE POINTS over the normalized text
 *     (SHINGLE_CP=5), each shingle hashed to a u64 with 64-bit FNV-1a over its
 *     UTF-8 bytes;
 *   - 256 PUBLISHED unsigned (a_i, b_i) seed pairs, derived deterministically
 *     via splitmix64 and listed in
 *     conformance/vector-cortex/v2/minhash/seeds-v2.json;
 *   - p = 2^61 - 1 (2305843009213693951), EXACT BigInt multiply/modulo — a_i*x
 *     can reach ~2^124 so Number math would silently corrupt high-bit products;
 *   - signature = 256 slots, slot i = min over shingles of (a_i*x + b_i) mod p;
 *     the empty signature is all-`p` sentinel slots;
 *   - encoding: 256 x u64 LITTLE-ENDIAN bytes (2048 bytes total);
 *   - bands: 64 bands of FOUR u64 slots each (256 total), see l1-lsh-v2.ts.
 *
 * NEVER compares a v2 signature against a v1 signature — cross-version compare
 * is rejected with `MINHASH_VERSION_MISMATCH` (see minhash-v2 migration).
 *
 * Pure compute, no deps, no storage, no network (PREVENT-PI-004 / PREVENT-011).
 */

import { normalize } from "./normalize.js";

/** MinHashV2 scheme version tag (frozen). */
export const MINHASH_VERSION = 2 as const;

/** The published count of slots / seed pairs (frozen). */
export const NUM_HASHES_V2 = 256 as const;

/** Five-code-point shingle length (frozen). */
export const SHINGLE_CP = 5 as const;

/** p = 2^61 - 1 (Mersenne prime), as exact BigInt. */
export const P_V2 = (1n << 61n) - 1n;

/** Little-endian bytes per u64 signature slot. */
export const U64_BYTES = 8 as const;

/** Signature byte length: 256 slots x 8 LE bytes. */
export const SIGNATURE_BYTES_V2 = NUM_HASHES_V2 * U64_BYTES;

/** Fixed splitmix64 initial state so the seed table is reproducible everywhere. */
export const SEED_STATE_INIT = 0x5eedc0de_f001_ba11n & 0xffffffffffffffffn;

/** splitmix64 mixing constants (frozen). */
const SM_GOLDEN = 0x9e3779b97f4a7c15n;
const SM_M1 = 0xbf58476d1ce4e5b9n;
const SM_M2 = 0x94d049bb133111ebn;
const MASK64 = 0xffffffffffffffffn;

function mix(z0: bigint): bigint {
  let z = z0;
  z = (z ^ (z >> 30n)) * SM_M1;
  z &= MASK64;
  z = (z ^ (z >> 27n)) * SM_M2;
  z &= MASK64;
  return z ^ (z >> 31n);
}

/** A splitmix64 PRNG yielding unsigned 64-bit values as BigInt. */
export type SplitMix64 = () => bigint;

/** Create a splitmix64 PRNG from a fixed unsigned 64-bit state. */
export function splitmix64(state: bigint = SEED_STATE_INIT): SplitMix64 {
  let s = state & MASK64;
  return () => {
    s = (s + SM_GOLDEN) & MASK64;
    return mix(s) & MASK64;
  };
}

export interface MinHashSeedPair {
  readonly a: bigint;
  readonly b: bigint;
}

/**
 * Derive the frozen 256 published (a_i, b_i) seed pairs. Each pair maps two
 * splitmix64 draws into [1, p-1]. Deterministic and cross-language reproducible
 * from SEED_STATE_INIT — mirrors `seeds-v2.json`.
 */
export function minhashV2Seeds(
  count: number = NUM_HASHES_V2,
): MinHashSeedPair[] {
  const prng = splitmix64();
  const pairs: MinHashSeedPair[] = [];
  for (let i = 0; i < count; i++) {
    const a = (prng() % (P_V2 - 1n)) + 1n;
    const b = (prng() % (P_V2 - 1n)) + 1n;
    pairs.push({ a, b });
  }
  return pairs;
}

/** 64-bit FNV-1a over a UTF-8 string (for shingle hashing). */
function fnv1a64String(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const bytes = Buffer.from(s, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i] ?? 0);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

/**
 * Five-code-point shingle set (deduped, capped) of normalized text as u64
 * hashes. Iterates over code points (not UTF-16 code units) so astral-plane
 * characters do not split a shingle.
 */
export function shinglesV2(
  text: string,
  shingleCp: number = SHINGLE_CP,
  maxShingles = 50_000,
): bigint[] {
  const norm = normalize(text);
  if (norm.length === 0) return [];
  const cps = Array.from(norm); // code points
  const set = new Set<bigint>();
  if (cps.length < shingleCp) {
    set.add(fnv1a64String(norm));
  } else {
    for (let i = 0; i + shingleCp <= cps.length; i++) {
      const sh = cps.slice(i, i + shingleCp).join("");
      set.add(fnv1a64String(sh));
      if (set.size >= maxShingles) break;
    }
  }
  return [...set];
}

/**
 * Compute the 256-slot MinHashV2 signature of a text as an array of exact u64
 * BigInt values (each in [0, p], p = sentinel when empty). Uses EXACT BigInt
 * multiply/modulo so high-bit products (a*x ~ up to 2^124) are never corrupted.
 */
export function minhashV2Signature(text: string): bigint[] {
  const grams = shinglesV2(text);
  const seeds = minhashV2Seeds();
  const sig = new Array<bigint>(NUM_HASHES_V2).fill(P_V2);
  if (grams.length === 0) return sig;
  for (let i = 0; i < NUM_HASHES_V2; i++) {
    const { a, b } = seeds[i] as MinHashSeedPair;
    let min = P_V2;
    for (const x of grams) {
      const h = (a * x + b) % P_V2;
      if (h < min) min = h;
    }
    sig[i] = min;
  }
  return sig;
}

/** Encode a 256-slot signature to 2048 bytes as 256 x u64 little-endian. */
export function encodeSignatureV2(sig: readonly bigint[]): Uint8Array {
  if (sig.length !== NUM_HASHES_V2) {
    throw new Error(
      `encodeSignatureV2: expected ${NUM_HASHES_V2} slots, got ${sig.length}`,
    );
  }
  const buf = Buffer.allocUnsafe(SIGNATURE_BYTES_V2);
  for (let i = 0; i < NUM_HASHES_V2; i++) {
    buf.writeBigUInt64LE(sig[i] as bigint, i * U64_BYTES);
  }
  return new Uint8Array(buf);
}

/**
 * Estimated Jaccard similarity of two v2 signatures (fraction of equal slots).
 * v1/v2 cross-version compare MUST NOT reach here — callers reject the mixed
 * version with `MINHASH_VERSION_MISMATCH` first (minhash-v2 migration).
 */
export function signatureSimilarityV2(a: readonly bigint[], b: readonly bigint[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let equal = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) equal++;
  return equal / n;
}
