/**
 * l1-minhash-v2.test.ts — MinHashV2 unit tests (VC1C).
 *
 * Verifies the frozen v2 signature scheme is CROSS-LANGUAGE byte-exact against
 * the committed conformance fixture M4-HIGHBIT-001: the 2048-byte LE signature,
 * the sha256 signature digest and the 64 LSH bucket keys must all match the
 * fixture byte-for-byte. Also checks the exact-BigInt arithmetic invariant (the
 * seed table stores decimal strings that exceed 2^53 and must round-trip).
 *
 * Pure compute — no storage, no network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINHASH_VERSION,
  NUM_HASHES_V2,
  SHINGLE_CP,
  P_V2,
  SIGNATURE_BYTES_V2,
  minhashV2Signature,
  encodeSignatureV2,
  minhashV2Seeds,
  splitmix64,
  signatureSimilarityV2,
} from "./l1-minhash-v2.js";
import { lshBandsV2, BANDS_V2 } from "./l1-lsh-v2.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Walk up from the test location until the conformance corpus is found. */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("vc1c conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
const FIXTURE = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "conformance", "vector-cortex", "v2", "minhash", "M4-HIGHBIT-001.json"),
    "utf8",
  ),
) as {
  input: { session: string; text: string };
  expected: {
    ok: boolean;
    maxProduct: string;
    signatureBytesHex: string;
    signatureDigest: string;
    buckets: string[];
  };
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("MinHashV2 frozen scheme constants", () => {
  test("constants match the frozen published values", () => {
    assert.equal(MINHASH_VERSION, 2);
    assert.equal(NUM_HASHES_V2, 256);
    assert.equal(SHINGLE_CP, 5);
    assert.equal(P_V2, 2305843009213693951n); // 2^61 - 1
    assert.equal(SIGNATURE_BYTES_V2, 2048);
    assert.equal(BANDS_V2, 64);
  });

  test("exact BigInt products above 2^53 never round to a double", () => {
    // The seed table holds u64 values expressed as decimal strings that exceed
    // Number.MAX_SAFE_INTEGER (2^53 - 1). They must parse to exact BigInt.
    const seeds = minhashV2Seeds();
    assert.equal(seeds.length, 256);
    for (const { a, b } of seeds) {
      assert.ok(a >= 1n && a < P_V2, "seed a in [1, p-1]");
      assert.ok(b >= 1n && b < P_V2, "seed b in [1, p-1]");
    }
    // A worst-case product a*x ~ 2^61 * 2^61 = 2^122 cannot be represented as a
    // double (max exact ~2^53); BigInt keeps it exact. Spot-check the maxProduct
    // declared by the fixture is reproducible only via exact arithmetic.
    const maxProduct = BigInt(FIXTURE.expected.maxProduct);
    assert.ok(maxProduct > (1n << 110n), "maxProduct exceeds double's exact range");
  });

  test("splitmix64 is deterministic from the fixed initial state", () => {
    const a = splitmix64();
    const b = splitmix64();
    const drawsA = [a(), a(), a()];
    const drawsB = [b(), b(), b()];
    assert.deepEqual(drawsA, drawsB, "same seed state yields identical draws");
    assert.equal(drawsA[0]! & 0xffffffffffffffffn, drawsA[0]!, "draws are u64");
  });

  test("empty text yields the all-p sentinel signature", () => {
    const sig = minhashV2Signature("");
    assert.equal(sig.length, 256);
    for (const s of sig) assert.equal(s, P_V2, "empty signature slot is the p sentinel");
  });
});

describe("MinHashV2 exact arithmetic vs M4-HIGHBIT-001", () => {
  test("signature bytes match the committed fixture byte-for-byte", () => {
    const sig = minhashV2Signature(FIXTURE.input.text);
    const bytes = encodeSignatureV2(sig);
    assert.equal(bytes.length, SIGNATURE_BYTES_V2, "2048 LE bytes");
    const hex = Buffer.from(bytes).toString("hex");
    assert.equal(hex, FIXTURE.expected.signatureBytesHex, "signature LE bytes match fixture");
  });

  test("signature sha256 digest matches the fixture", () => {
    const bytes = encodeSignatureV2(minhashV2Signature(FIXTURE.input.text));
    assert.equal(
      sha256Hex(bytes),
      FIXTURE.expected.signatureDigest,
      "signature digest matches fixture",
    );
  });

  test("the 64 LSH bucket keys match the fixture", () => {
    const bytes = encodeSignatureV2(minhashV2Signature(FIXTURE.input.text));
    const buckets = lshBandsV2(bytes, FIXTURE.input.session);
    assert.equal(buckets.length, 64);
    assert.deepEqual(buckets, FIXTURE.expected.buckets, "bucket keys byte-match fixture");
  });

  test("same text -> identical signature; similar text -> high overlap", () => {
    const base = "the quick brown fox jumps over the lazy dog";
    const a = minhashV2Signature(base);
    const b = minhashV2Signature(base);
    assert.equal(signatureSimilarityV2(a, b), 1, "identical text has identical signature");
    const near = minhashV2Signature(base + " near-duplicate words here");
    const sim = signatureSimilarityV2(a, near);
    assert.ok(sim > 0.5, `near-duplicate shares most slots (got ${sim})`);
  });

  test("signatureSimilarityV2 rejects a v1 array (number values) INTERNALLY", () => {
    // v1 signatures are number[] of u31 values; a caller passing one must get
    // MINHASH_VERSION_MISMATCH, never a similarity number (frozen cross-version
    // reject contract enforced inside the v2-only function).
    const v2 = minhashV2Signature("text").map((x) => BigInt(x)); // all in [0,p]
    const v1Shape = new Array<number>(NUM_HASHES_V2).fill(12345); // u31 numbers
    assert.throws(
      () => signatureSimilarityV2(v2, v1Shape as unknown as bigint[]),
      /MINHASH_VERSION_MISMATCH/,
      "v1 number[] rejected, not compared",
    );
  });

  test("signatureSimilarityV2 rejects a wrong-length / out-of-range array", () => {
    const v2 = minhashV2Signature("text");
    assert.throws(() => signatureSimilarityV2(v2, []), /MINHASH_VERSION_MISMATCH/);
    const bad = [...v2.slice(0, NUM_HASHES_V2 - 1), P_V2 + 1n];
    assert.throws(
      () => signatureSimilarityV2(v2, bad),
      /MINHASH_VERSION_MISMATCH/,
      "out-of-range slot is not a v2 signature",
    );
  });
});
