/**
 * conformance/triadB-reader.ts — TRIAD-B independent exact reader (VC1C).
 *
 * Deliberately shares NO code and NO cached-seed instance with the runner
 * modules (l1-minhash-v2.ts / l1-lsh-v2.ts). It re-derives the minhash-v2
 * signature and 64 bucket keys from first principles, using only the PUBLISHED
 * (a,b) seed pairs passed in (read by the caller from
 * conformance/.../minhash/seeds-v2.json — the table authored independently by
 * scripts/gen-fixtures/minhash.mjs, the same process that produced the frozen
 * fixture bytes). Because B shares no subroutine with the runner, a systematic
 * error in the runner's splitmix64 / seed-derivation / signature arithmetic
 * cannot satisfy both triad A and triad B.
 *
 * Pure compute, no deps, no storage, no network (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

const MASK64 = 0xffffffffffffffffn;
const P = (1n << 61n) - 1n; // 2^61 - 1
const SLOTS = 256;
const U64 = 8;
const BANDS = 64;

/** A published (a, b) seed pair as decimal strings (exactness beyond 2^53). */
export interface PublishedSeedPair {
  readonly a: string;
  readonly b: string;
}

/** 64-bit FNV-1a over UTF-8 bytes or a raw byte buffer (own, independent loop). */
function fnv1a64(input: string | Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(input)) {
    h = ((h ^ BigInt(b)) * 0x100000001b3n) & MASK64;
  }
  return h;
}

/**
 * Re-derive the 2048-byte minhash-v2 signature and (optionally) the 64 LSH
 * bucket keys for `text` within `session`, from published seed pairs only —
 * never the runner module.
 */
export function independentReaderV2(
  text: string,
  session: string,
  seedPairs: readonly PublishedSeedPair[],
  withBuckets: boolean,
): { bytes: Uint8Array; digest: string; buckets: string[] } {
  // Normalization: ANSI-strip, NFC, case-fold, CRLF->LF, whitespace collapse,
  // 32K cap — mirrored from the frozen VC1C spec.
  let norm = (text || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (norm.length > 32768) norm = norm.slice(0, 32768);

  // Five-code-point shingles (deduped, capped at 50_000).
  const grams: bigint[] = [];
  if (norm.length > 0) {
    const cps = Array.from(norm);
    const seen = new Set<bigint>();
    const short = cps.length < 5;
    for (let i = 0; i < (short ? 1 : cps.length - 4); i++) {
      const h = short ? fnv1a64(norm) : fnv1a64(cps.slice(i, i + 5).join(""));
      if (!seen.has(h)) {
        seen.add(h);
        grams.push(h);
      }
      if (!short && seen.size >= 50000) break;
    }
  }

  // Signature: slot i = min over shingles of (a_i*x + b_i) mod p (exact BigInt).
  const sig = new Array<bigint>(SLOTS).fill(P);
  for (let i = 0; i < SLOTS && grams.length > 0; i++) {
    const pair = seedPairs[i] as PublishedSeedPair;
    const a = BigInt(pair.a);
    const b = BigInt(pair.b);
    let min = P;
    for (const x of grams) {
      const h = (a * x + b) % P;
      if (h < min) min = h;
    }
    sig[i] = min;
  }

  // Own 256 x u64 little-endian encoder.
  const buf = Buffer.allocUnsafe(SLOTS * U64);
  for (let i = 0; i < SLOTS; i++) buf.writeBigUInt64LE(sig[i] as bigint, i * U64);
  const bytes = new Uint8Array(buf);
  const digest = createHash("sha256").update(bytes).digest("hex");

  // 64 buckets: FNV-1a over `<session>|v2|` + each 32-byte band (LE hex).
  const buckets: string[] = [];
  if (withBuckets) {
    const prefix = Buffer.from(`${session}|v2|`, "utf8");
    for (let band = 0; band < BANDS; band++) {
      const bandBytes = Buffer.from(bytes.slice(band * 32, band * 32 + 32));
      const out = Buffer.allocUnsafe(U64);
      out.writeBigUInt64LE(fnv1a64(Buffer.concat([prefix, bandBytes])), 0);
      buckets.push(`b${band}:${out.toString("hex")}`);
    }
  }
  return { bytes, digest, buckets };
}
