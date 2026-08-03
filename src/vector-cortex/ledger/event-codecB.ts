/**
 * vector-cortex/ledger/event-codecB.ts — EventV2 byte-authority codec, Mode B
 * (VC1A, TRIAD_RESILIENCE).
 *
 * B is a GENUINELY independent raw-byte record implementation of the SAME byte
 * rule as Mode A (`./event-codec.ts`). It shares NO subroutine with A: its own
 * SHA-256 helper, its own base64 helper, its own strict-UTF-8 classifier, and
 * its own raw record — the lesson from VC0B-I09 (a mode-B tested against code
 * identical to A is a tautology). Because the digest of given bytes is a pure
 * function, two independent implementations MUST agree byte-for-byte; the
 * acceptance test asserts `bytesDigest` parity across the fixture corpus.
 *
 * B retains `originalBytes` + `bytesDigest` and classifies strict UTF-8 with no
 * lossy replacement; `canonicalNfc` is derived for valid UTF-8 but never used
 * for identity, digest, or reconstruction.
 *
 * Pure/deterministic — no console, no network, no side effects (PREVENT-PI-004).
 */

import nodeCrypto from "node:crypto";
import type { EventV2 } from "./types.js";

/** Mode-B internal SHA-256 helper (independent of A's — no shared subroutine). */
function digestSha256B(bytes: Uint8Array): string {
  const d = nodeCrypto.createHash("sha256");
  d.update(bytes);
  const hex = d.digest("hex");
  return `sha256:${hex}`;
}

/** Mode-B internal base64 (independent of A's). */
function base64EncodeB(bytes: Uint8Array): string {
  let out = "";
  const buf = Buffer.from(bytes);
  for (let i = 0; i < buf.length; i += 3) {
    const b0 = buf[i];
    const b1 = i + 1 < buf.length ? buf[i + 1] : -1;
    const b2 = i + 2 < buf.length ? buf[i + 2] : -1;
    out += CHARS[(b0 >> 2) & 63];
    out += CHARS[((b0 & 3) << 4) | (b1 < 0 ? 0 : (b1 >> 4) & 15)];
    if (b1 >= 0) out += CHARS[((b1 & 15) << 2) | (b2 < 0 ? 0 : (b2 >> 6) & 3)];
    if (b2 >= 0) out += CHARS[b2 & 63];
  }
  // Padding (independent reconstruction of standard base64).
  const pad = (3 - (buf.length % 3)) % 3;
  for (let i = 0; i < pad; i++) out += "=";
  return out;
}
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Mode-B strict UTF-8 classifier (fatal decode; no replacement). */
function classifyUtf8B(bytes: Uint8Array): { valid: true; text: string } | { valid: false; base64: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { valid: true, text };
  } catch {
    return { valid: false, base64: base64EncodeB(bytes) };
  }
}

/** Mode-B independent raw byte record of an EventV2 occurrence. */
export interface RawByteRecord {
  readonly originalBytes: Uint8Array;
  readonly bytesDigest: string;
  readonly utf8: { valid: true; text: string } | { valid: false; base64: string };
  readonly canonicalNfc?: string;
}

/** Independently digest + classify raw bytes into a B record. */
export function recordRawBytesB(bytes: Uint8Array): RawByteRecord {
  const bytesDigest = digestSha256B(bytes);
  const utf8 = classifyUtf8B(bytes);
  const record: RawByteRecord = { originalBytes: bytes, bytesDigest, utf8 };
  if (utf8.valid) {
    return { originalBytes: bytes, bytesDigest, utf8, canonicalNfc: utf8.text.normalize("NFC") };
  }
  return record;
}

/**
 * Independent digest check: recompute the SHA-256 over an EventV2's
 * `originalBytes` via B's OWN algorithm and compare to the stored digest.
 * Returns the recomputed digest string (parity-checked by the caller).
 */
export function digestCheckB(event: EventV2): string {
  return digestSha256B(event.originalBytes);
}
