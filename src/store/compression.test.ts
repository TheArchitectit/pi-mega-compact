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

test("module loads without a top-level zstd import (Fix A: no load crash)", async () => {
  // The extension must load even when the @mongodb-js/zstd native addon is
  // absent (clean/allowScripts-blocked install). The dynamic import() lives
  // inside the helpers, so importing this module must never throw.
  const mod = await import("./compression.js");
  assert.equal(typeof mod.compressSmart, "function", "compressSmart exported");
  assert.equal(typeof mod.compressZstd, "function", "compressZstd exported");
  // The real invariant: no STATIC `import ... from "@mongodb-js/zstd"` at the
  // top level (that's what crashed the whole extension). zstd must be loaded
  // lazily inside the helpers only. Check the source text.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  // Tests run with cwd at repo root (`node --test`), so resolve the source.
  const src = readFileSync(join(process.cwd(), "src/store/compression.ts"), "utf-8");
  const staticImport = /^import\s+.+\s+from\s+["']@mongodb-js\/zstd["'];?$/m;
  assert.equal(
    staticImport.test(src),
    false,
    "no static top-level import of @mongodb-js/zstd (would crash load if binary absent)",
  );
  assert.ok(
    src.includes('await import("@mongodb-js/zstd")'),
    "zstd is loaded lazily via dynamic import() inside the helpers",
  );
});

test("compressSmart escalates brotli quality with pressure (Fix E)", () => {
  // Large (>32KB) payloads hit the brotli tier; higher pressure → brotli-11
  // → smaller output than the default brotli-4, and still decodes.
  const words = Array.from({ length: 6000 }, (_, i) => "word" + ((i * 2654435761) % 9973));
  const big = Buffer.from(words.join(" "));
  const low = compressSmart(big, 0);
  const high = compressSmart(big, 1);
  assert.equal(isVersioned(low), true, "versioned header preserved at p=0");
  assert.equal(isVersioned(high), true, "versioned header preserved at p=1");
  assert.ok(high.length < low.length, "high pressure compresses smaller");
  assert.deepEqual(decompressSmart(low), big, "p=0 roundtrip");
  assert.deepEqual(decompressSmart(high), big, "p=1 roundtrip");
  // Small payloads ignore pressure (gzip tier) but still roundtrip.
  const small = buf("hello world ", 300);
  assert.deepEqual(decompressSmart(compressSmart(small, 1)), small, "small ignores pressure");
  // pressure out of range is clamped (no throw, still versioned + decodable).
  assert.deepEqual(decompressSmart(compressSmart(big, 5)), big, "over-pressure clamped");
  assert.deepEqual(decompressSmart(compressSmart(big, -1)), big, "under-pressure clamped");
});

test("pressureFromPct + preserveRecentForPressure scale with context (Fix E)", async () => {
  const { pressureFromPct, preserveRecentForPressure } = await import("../config.js");
  assert.equal(pressureFromPct(50), 0.5, "pct→pressure");
  assert.equal(pressureFromPct(null), 0, "null pct → 0");
  assert.equal(pressureFromPct(150), 1, "pct clamped");
  // low pressure keeps preserveRecent; high pressure compacts deeper (min floor).
  assert.equal(preserveRecentForPressure(0, 4, 2), 4, "p=0 → preserveRecent");
  assert.equal(preserveRecentForPressure(1, 4, 2), 2, "p=1 → preserveRecentMin");
  assert.equal(preserveRecentForPressure(0.5, 4, 2), 3, "p=0.5 → interpolates");
  assert.ok(preserveRecentForPressure(1, 4, 2) >= 2, "never below floor");
});
