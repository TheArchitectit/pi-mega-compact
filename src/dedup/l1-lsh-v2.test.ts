/**
 * l1-lsh-v2.test.ts — LSH banding unit tests (VC1C).
 *
 * Verifies 64-band / 4-slot banding over the frozen 2048-byte v2 signature:
 * deterministic bucket keys, session scoping, and version-tagged bucket keys so
 * v1 and v2 never share buckets (cross-version mixing is rejected upstream).
 *
 * Pure compute — no storage, no network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BANDS_V2,
  VALUES_PER_BAND_V2,
  BAND_BYTES_V2,
  SIGNATURE_BYTES_EXPECTED_V2,
  lshBandsV2,
  bandsForTextV2,
} from "./l1-lsh-v2.js";
import {
  NUM_HASHES_V2,
  U64_BYTES,
  SIGNATURE_BYTES_V2,
  minhashV2Signature,
  encodeSignatureV2,
} from "./l1-minhash-v2.js";

describe("LSH banding constants", () => {
  test("band geometry is frozen and consistent with the signature", () => {
    assert.equal(BANDS_V2, 64);
    assert.equal(VALUES_PER_BAND_V2, 4);
    assert.equal(BAND_BYTES_V2, 32); // 4 u64 LE
    assert.equal(SIGNATURE_BYTES_EXPECTED_V2, 2048);
    assert.equal(SIGNATURE_BYTES_V2, NUM_HASHES_V2 * U64_BYTES);
    assert.equal(BANDS_V2 * VALUES_PER_BAND_V2, NUM_HASHES_V2, "64*4 = 256 slots");
  });
});

describe("LSH banding over a v2 signature", () => {
  test("bands are deterministic: same bytes + session -> same 64 keys", () => {
    const bytes = encodeSignatureV2(minhashV2Signature("banding determinism"));
    const a = lshBandsV2(bytes, "s1");
    const b = lshBandsV2(bytes, "s1");
    assert.equal(a.length, 64);
    assert.deepEqual(a, b);
    for (let i = 0; i < 64; i++) assert.ok(a[i]!.startsWith(`b${i}:`), `bucket ${i} named`);
  });

  test("different sessions never share bucket keys (session scoping)", () => {
    const bytes = encodeSignatureV2(minhashV2Signature("scoped"));
    const s1 = lshBandsV2(bytes, "sessionA");
    const s2 = lshBandsV2(bytes, "sessionB");
    assert.deepEqual(
      s1.filter((k) => s2.includes(k)),
      [],
      "session-scoped keys do not collide",
    );
  });

  test("the v2 version tag is part of every bucket key (v1 never shares)", () => {
    const bytes = encodeSignatureV2(minhashV2Signature("versioned"));
    const v1 = lshBandsV2(bytes, "s", 1);
    const v2 = lshBandsV2(bytes, "s", 2);
    assert.deepEqual(v1.filter((k) => v2.includes(k)), [], "version-tagged keys never collide");
  });

  test("bandsForTextV2 is a deterministic convenience wrapper", () => {
    const bytes = encodeSignatureV2(minhashV2Signature("wrapper"));
    assert.deepEqual(bandsForTextV2(bytes, "s"), lshBandsV2(bytes, "s"));
  });

  test("wrong signature length is rejected", () => {
    assert.throws(() => lshBandsV2(new Uint8Array(10), "s"), /expected 2048 signature bytes/);
  });
});
