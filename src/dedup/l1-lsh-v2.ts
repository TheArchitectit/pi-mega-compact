/**
 * l1-lsh-v2.ts — Locality-Sensitive Hashing banding over MinHashV2 signatures
 * (VC1C, M4 minhash-v2).
 *
 * Splits the frozen 2048-byte v2 signature (256 x u64 LE slots) into 64 bands
 * of FOUR u64 values each. Each band yields a deterministic bucket key derived
 * from its 4 u64 little-endian bytes (32 bytes) hashed with a 64-bit FNV-1a,
 * scoped by session id and the frozen v2 version tag so buckets never collide
 * across sessions or the v1 path. Deterministic: same (sessionId,
 * signatureBytes) -> same 64 bucket keys, every run, every language.
 *
 * Mixed v1/v2 comparison and bucket mixing is REJECTED upstream with
 * `MINHASH_VERSION_MISMATCH` (see minhash-v2 migration); this module only ever
 * bands a v2 signature.
 *
 * Pure compute, no deps, no storage, no network (PREVENT-PI-004 / PREVENT-011).
 */

import {
  MINHASH_VERSION,
  NUM_HASHES_V2,
  U64_BYTES,
} from "./l1-minhash-v2.js";

/** Number of bands (frozen). */
export const BANDS_V2 = 64 as const;

/** u64 slots per band (frozen): 64 * 4 = 256 total slots. */
export const VALUES_PER_BAND_V2 = 4 as const;

/** Band byte length: 4 u64 LE = 32 bytes. */
export const BAND_BYTES_V2 = VALUES_PER_BAND_V2 * U64_BYTES;

/** Total signature byte length this scheme expects (256 * 8 = 2048). */
export const SIGNATURE_BYTES_EXPECTED_V2 = NUM_HASHES_V2 * U64_BYTES;

const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over a byte buffer. */
function fnv1a64Bytes(buf: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < buf.length; i++) {
    h ^= BigInt(buf[i] ?? 0);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

/**
 * Compute the 64 LSH bucket keys for a v2 signature within a session. `bytes`
 * is the 2048-byte little-endian signature (see encodeSignatureV2). Each bucket
 * key is the hex of an 8-byte little-endian FNV-1a-64 over the band's 32 bytes
 * prefixed by `<sessionId>|v2|band-` — so the "bucket bytes" are deterministic
 * and reproducible across languages.
 */
export function lshBandsV2(
  bytes: Uint8Array,
  sessionId: string,
  version: number = MINHASH_VERSION,
): string[] {
  if (bytes.length !== SIGNATURE_BYTES_EXPECTED_V2) {
    throw new Error(
      `lshBandsV2: expected ${SIGNATURE_BYTES_EXPECTED_V2} signature bytes, got ${bytes.length}`,
    );
  }
  const keys: string[] = [];
  const prefix = Buffer.from(`${sessionId}|v${version}|`, "utf8");
  for (let band = 0; band < BANDS_V2; band++) {
    const start = band * BAND_BYTES_V2;
    const bandBytes = bytes.slice(start, start + BAND_BYTES_V2);
    const combined = Buffer.concat([prefix, Buffer.from(bandBytes)]);
    const h = fnv1a64Bytes(combined);
    const out = Buffer.allocUnsafe(U64_BYTES);
    out.writeBigUInt64LE(h, 0);
    keys.push(`b${band}:${out.toString("hex")}`);
  }
  return keys;
}

/**
 * Derive bands directly from text (convenience for callers without a cached
 * signature). Convenience re-export keeps the delta from the v1 sibling small.
 */
export function bandsForTextV2(signatureBytes: Uint8Array, sessionId: string): string[] {
  return lshBandsV2(signatureBytes, sessionId);
}
