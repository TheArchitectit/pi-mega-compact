// VC1C MinHashV2 fixtures (`conformance/vector-cortex/v2/minhash/`).
// Mirrors the frozen MinHashV2 algorithm in src/dedup/l1-minhash-v2.ts /
// l1-lsh-v2.ts exactly (same splitmix64, same 5-code-point shingles, same
// p=2^61-1 BigInt arithmetic, same 256 x u64 LE bytes, same 64-band buckets)
// so the PUBLISHED bytes are authoritative and reproducible cross-language.
// Owner VC1C. Also emits the frozen seed table `seeds-v2.json`.

import { createHash } from "node:crypto";
import { producer } from "./common.mjs";

const MINHASH_SCHEMA = "schemas/minhash-fixture.schema.json";
const NUM = 256;
const P = (1n << 61n) - 1n; // 2^61 - 1
const MASK64 = 0xffffffffffffffffn;
const SEED_STATE_INIT = (0x5eedc0def001ba11n) & MASK64;

// ── splitmix64 (mirror of l1-minhash-v2.ts) ────────────────────────────────
function splitmix64(seed) {
  let s = BigInt(seed) & MASK64;
  const golden = 0x9e3779b97f4a7c15n;
  const m1 = 0xbf58476d1ce4e5b9n;
  const m2 = 0x94d049bb133111ebn;
  const mix = (z0) => {
    let z = z0;
    z = (z ^ (z >> 30n)) * m1;
    z &= MASK64;
    z = (z ^ (z >> 27n)) * m2;
    z &= MASK64;
    z = z ^ (z >> 31n);
    return z & MASK64;
  };
  return () => {
    s = (s + golden) & MASK64;
    return mix(s);
  };
}

export function minhashV2Seeds() {
  const prng = splitmix64(SEED_STATE_INIT);
  const pairs = [];
  for (let i = 0; i < NUM; i++) {
    const a = (prng() % (P - 1n)) + 1n;
    const b = (prng() % (P - 1n)) + 1n;
    pairs.push({ a, b });
  }
  return pairs;
}

// Normalize text (mirror of src/dedup/normalize.ts — stable, shared).
function normalize(text) {
  if (!text) return "";
  let out = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); // strip ANSI
  out = out.normalize("NFC");
  out = out.toLowerCase();
  out = out.replace(/\r\n?/g, "\n");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > 32768) out = out.slice(0, 32768);
  return out;
}

/** 64-bit FNV-1a over a UTF-8 string (mirror of l1-minhash-v2.ts). */
export function fnv1a64String(s) {
  let h = 0xcbf29ce484222325n;
  const bytes = Buffer.from(s, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

/** 5-code-point shingle u64 hashes (deduped, capped) of normalized text. */
export function shinglesV2(text, shingleCp = 5, max = 50000) {
  const norm = normalize(text);
  if (norm.length === 0) return [];
  const cps = Array.from(norm);
  const set = new Set();
  if (cps.length < shingleCp) {
    set.add(fnv1a64String(norm));
  } else {
    for (let i = 0; i + shingleCp <= cps.length; i++) {
      set.add(fnv1a64String(cps.slice(i, i + shingleCp).join("")));
      if (set.size >= max) break;
    }
  }
  return [...set];
}

/** 256-slot signature as BigInt array (exact BigInt multiply/modulo). */
export function minhashV2Signature(text) {
  const grams = shinglesV2(text);
  const seeds = minhashV2Seeds();
  const sig = new Array(NUM).fill(P);
  if (grams.length === 0) return sig;
  for (let i = 0; i < NUM; i++) {
    const { a, b } = seeds[i];
    let min = P;
    for (const x of grams) {
      const h = (a * x + b) % P;
      if (h < min) min = h;
    }
    sig[i] = min;
  }
  return sig;
}

/** Encode a signature to 256 x u64 little-endian bytes (2048 bytes). */
export function encodeSignatureV2(sig) {
  const buf = Buffer.allocUnsafe(NUM * 8);
  for (let i = 0; i < NUM; i++) buf.writeBigUInt64LE(sig[i], i * 8);
  return new Uint8Array(buf);
}

/** 64-band buckets over the 2048 LE signature bytes. */
export function lshBandsV2(bytes, sessionId, version = 2) {
  const keys = [];
  const prefix = Buffer.from(`${sessionId}|v${version}|`, "utf8");
  for (let band = 0; band < 64; band++) {
    const start = band * 32;
    const bandBytes = bytes.slice(start, start + 32);
    const combined = Buffer.concat([prefix, Buffer.from(bandBytes)]);
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < combined.length; i++) {
      h ^= BigInt(combined[i]);
      h = (h * 0x100000001b3n) & MASK64;
    }
    const out = Buffer.allocUnsafe(8);
    out.writeBigUInt64LE(h, 0);
    keys.push(`b${band}:${out.toString("hex")}`);
  }
  return keys;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The maximum product a_i*x over all (seed, shingle) pairs — the "high-bit"
 * witness that products exceed 2^53 (M4-HIGHBIT-001). The generator computes it
 * with exact BigInt so the fixture can assert it is above Number.MAX_SAFE_INTEGER.
 */
export function maxHighBitProduct(text) {
  const grams = shinglesV2(text);
  const seeds = minhashV2Seeds();
  let max = 0n;
  for (const { a } of seeds) {
    for (const x of grams) {
      const prod = a * x;
      if (prod > max) max = prod;
    }
  }
  return max;
}

// ── Fixture rows (domain `minhash`) ────────────────────────────────────────

function minhashFixture(id, assertion, input, expected) {
  return { id, schema: MINHASH_SCHEMA, producer, assertion, kind: "minhash-v2", input, expected };
}

// M4-HIGHBIT-001: products above 2^53 must be computed EXACTLY (BigInt); the
// published 2048-byte signature and all 64 bucket bytes are the authority.
const highbitText =
  "the quick brown fox jumps over the lazy dog and then the quick brown " +
  "fox jumps again aaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbb";
const highbitSig = minhashV2Signature(highbitText);
const highbitBytes = encodeSignatureV2(highbitSig);
const m4Highbit = minhashFixture(
  "M4-HIGHBIT-001",
  "products above 2^53 match the published exact u64 signature and all 64 bucket bytes",
  { text: highbitText, session: "m4-highbit" },
  {
    ok: true,
    maxProduct: maxHighBitProduct(highbitText).toString(),
    signatureBytesHex: Buffer.from(highbitBytes).toString("hex"),
    signatureDigest: sha256Hex(highbitBytes),
    buckets: lshBandsV2(highbitBytes, "m4-highbit"),
  },
);

// M4-VERSION-002: a v1-v2 comparison must fail with MINHASH_VERSION_MISMATCH.
const m4Version = minhashFixture(
  "M4-VERSION-002",
  "a v1-v2 cross-version comparison fails with MINHASH_VERSION_MISMATCH",
  { textA: "hello world", textB: "hell0 world", v1: true, v2: true },
  { ok: false, code: "MINHASH_VERSION_MISMATCH" },
);

export const fixtures = [m4Highbit, m4Version];
export const named = [];


// seeds-v2.json — the frozen 256 published (a,b) pairs as DECIMAL STRINGS
// (values exceed 2^53, so strings preserve exactness) + p as a decimal string.
export function seedsJson() {
  const pairs = minhashV2Seeds();
  return {
    schema: "schemas/minhash-seeds.schema.json",
    p: P.toString(),
    count: NUM,
    shingleCodePoints: 5,
    signatureBytes: NUM * 8,
    bands: 64,
    valuesPerBand: 4,
    seedPairs: pairs.map((pair) => ({
      a: pair.a.toString(),
      b: pair.b.toString(),
    })),
  };
}
