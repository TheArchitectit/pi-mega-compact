/**
 * l1-lsh.ts — Locality-Sensitive Hashing banding over MinHash signatures
 * (Sprint 11).
 *
 * Splits the 256-slot signature into `BANDS` bands of `ROWS_PER_BAND` rows. Each
 * band is hashed into a bucket key; rows sharing a band are likely near-duplicates.
 * The bucket key INCLUDES the session_id so candidates are scoped per session
 * (deterministic, no cross-session leakage — QA determinism fix).
 *
 * All hashing is deterministic given the signature + seed (PREVENT-PI-004, pure).
 */

import { SIGNATURE_VERSION, NUM_HASHES } from "./l1-minhash.js";

export const BANDS = 64;
export const ROWS_PER_BAND = 4; // 64 * 4 = 256 slots (matches minhashSignature length)

/** Stable 32-bit FNV-1a (buffer form) for band hashing. */
function fnv1aBuf(buf: Buffer): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Compute the list of LSH bucket keys for a signature within a session.
 * Deterministic: same (session_id, signature) → same keys, every run.
 */
export function lshBands(
  signature: number[],
  sessionId: string,
  version: number = SIGNATURE_VERSION,
): string[] {
  if (signature.length < BANDS * ROWS_PER_BAND) {
    throw new Error(
      `lshBands: signature length ${signature.length} < required ${BANDS * ROWS_PER_BAND}`,
    );
  }
  const keys: string[] = [];
  const seedPrefix = Buffer.from(`${sessionId}|${version}|`, "utf-8");
  for (let band = 0; band < BANDS; band++) {
    const start = band * ROWS_PER_BAND;
    const slice = signature.slice(start, start + ROWS_PER_BAND);
    const body = Buffer.allocUnsafe(ROWS_PER_BAND * 4);
    for (let r = 0; r < ROWS_PER_BAND; r++) {
      body.writeUInt32LE(slice[r] >>> 0, r * 4);
    }
    const combined = Buffer.concat([seedPrefix, body]);
    keys.push(`b${band}:${fnv1aBuf(combined).toString(16)}`);
  }
  return keys;
}

/** Convenience: derive bands directly from text (used by callers without a cached sig). */
export function bandsForText(
  signature: number[],
  sessionId: string,
  version: number = SIGNATURE_VERSION,
): string[] {
  if (signature.length !== NUM_HASHES) {
    throw new Error(`bandsForText: expected signature length ${NUM_HASHES}, got ${signature.length}`);
  }
  return lshBands(signature, sessionId, version);
}
