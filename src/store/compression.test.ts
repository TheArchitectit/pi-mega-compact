/**
 * compression.test.ts — versioned compression tiers + backward compatibility.
 *
 * Proves Sprint 8's root-cause fix: the 0x03 tag collision is impossible because
 * new blobs carry a 2-byte version magic, and legacy blobs (untagged gzip, legacy
 * single-tag incl. the old 0x03=brotli) still decompress.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, brotliCompressSync } from "node:zlib";
import {
  compressSmart,
  decompressSmart,
  compressZstd,
  decompressZstd,
  isVersioned,
  detectFormat,
  decompressSyncAuto,
} from "./compression.js";

const buf = (s: string, n: number) => Buffer.from(s.repeat(n));

test("versioned format: all size tiers roundtrip and are versioned", () => {
  const cases = [
    { label: "tiny", data: buf("x", 100), expectTag: 0x00 },
    { label: "small", data: buf("a", 600), expectTag: 0x01 },
    { label: "medium", data: buf("b", 8000), expectTag: 0x02 },
    { label: "large", data: buf("c", 40000), expectTag: 0x05 },
  ];
  for (const { label, data, expectTag } of cases) {
    const c = compressSmart(data);
    // New 2-byte magic header present.
    assert.ok(isVersioned(c), `${label}: should be versioned (0xEC 0x01)`);
    assert.equal(c[0], 0xec, `${label}: magic hi`);
    assert.equal(c[1], 0x01, `${label}: magic lo (version)`);
    assert.equal(c[2], 0x01, `${label}: format version 1`);
    assert.equal(c[3], expectTag, `${label}: tier tag ${expectTag.toString(16)}`);
    // Roundtrips exactly.
    assert.deepEqual(decompressSmart(c), data, `${label}: roundtrip`);
  }
});

test("large tier actually compresses better than raw (brotli 0x05)", () => {
  const data = buf("this is a long summary of a coding session. ", 900);
  const c = compressSmart(data);
  assert.ok(c.length < data.length, "compressed smaller than raw");
  assert.equal(c[3], 0x05, "tag is brotli-4");
  assert.deepEqual(decompressSmart(c), data);
});

test("legacy untagged gzip (0x1f magic) still decompresses", () => {
  const data = Buffer.from(JSON.stringify({ legacy: true }));
  const legacyGzip = gzipSync(data); // no tag byte, starts with 0x1f
  assert.equal(legacyGzip[0], 0x1f, "gzip magic present");
  assert.equal(detectFormat(legacyGzip), "legacy-gzip");
  assert.deepEqual(JSON.parse(decompressSmart(legacyGzip).toString()), { legacy: true });
});

test("legacy single-tag 0x03=brotli (the collision case) still decompresses", () => {
  const data = buf("legacy brotli payload ", 200);
  // Reconstruct the EXACT v0.1.0 legacy brotli frame: tag 0x03 + brotli payload.
  const legacy = Buffer.concat([Buffer.from([0x03]), brotliCompressSync(data)]);
  assert.equal(detectFormat(legacy), "legacy-tag");
  assert.deepEqual(decompressSmart(legacy), data, "legacy 0x03 brotli roundtrips");
});

test("detectFormat classifies all eras", () => {
  assert.equal(detectFormat(compressSmart(buf("q", 700))), "versioned");
  assert.equal(detectFormat(gzipSync(buf("q", 10))), "legacy-gzip");
  assert.equal(detectFormat(Buffer.from([0x00, 1, 2, 3])), "legacy-tag");
  assert.equal(detectFormat(Buffer.from([0x99, 0x88])), "unknown");
});

test("zstd helper roundtrips (async) and is not sync-decoded", async () => {
  const data = buf("zstd dr export payload ", 1500);
  const c = await compressZstd(data);
  assert.ok(c.length < data.length, "zstd compresses");
  // decompressSyncAuto reports zstd without throwing (caller awaits decompressZstd).
  const auto = decompressSyncAuto(c);
  assert.equal(auto.isZstd, true, "flagged as zstd");
  assert.deepEqual(await decompressZstd(c), data, "zstd roundtrip");
});
