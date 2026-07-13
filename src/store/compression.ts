/**
 * compression.ts — versioned, size-adaptive compression for checkpoint blobs.
 *
 * Extracted from store.ts (Sprint 8). Two coordinated compressors:
 *
 *  1. `compressSmart` / `decompressSmart` — SYNCHRONOUS, zlib-based. Used by the
 *     VectorStore write path (which must stay synchronous — see Sprint 8 plan:
 *     better-sqlite3 replaced PGlite precisely to avoid an async cascade).
 *
 *  2. `compressZstd` / `decompressZstd` — ASYNCHRONOUS, via @mongodb-js/zstd.
 *     Optional, used for DR-export / large-blob paths where an await is fine.
 *
 * FORMAT-VERSION PROBLEM (root cause of Sprint 8):
 *   store.ts shipped `0x03` = brotli (legacy single-tag format). PLAN.md reassigns
 *   `0x03` → zstd, which would corrupt every existing checkpoint file. We fix this
 *   with a 2-byte magic header on the NEW format so the tag byte is namespaced and
 *   can never collide with legacy payloads:
 *
 *     NEW (versioned):  0xEC 0x01 [TIER_TAG] [payload]
 *     LEGACY single-tag: [TIER_TAG] [payload]   (tags 0x00..0x03)
 *     LEGACY untagged:   0x1f ...               (plain gzip magic)
 *
 * `0xEC` is chosen because it collides with no zlib output: gzip magic is 0x1f,
 * brotli streams start 0xCE/0xCF, zlib/deflate streams start 0x78/0x05/0x03.
 * decompressSmart detects the magic first, so all three eras roundtrip together.
 */

import {
  gzipSync,
  gunzipSync,
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import zstd from "@mongodb-js/zstd";

// --- Versioned format markers ----------------------------------------------
const MAGIC_HI = 0xec;
const MAGIC_LO = 0x01; // format version 1

// Tier tags (only meaningful inside the 0xEC 0x01 versioned frame).
const TAG_RAW = 0x00; // no compression (< 512 bytes)
const TAG_GZIP_1 = 0x01; // gzip level 1 (fast, 512B–4KB)
const TAG_GZIP_6 = 0x02; // gzip level 6 (default, 4KB–32KB)
const TAG_BROTLI_4 = 0x05; // brotli level 4 (> 32KB, best text ratio, sync)

// Reserved for the async zstd helper (see compressZstd). Not used by the sync path.
const TAG_ZSTD_3 = 0x03;
const TAG_ZSTD_9 = 0x04;

/** Gzip magic byte — used to detect legacy untagged files. */
const GZIP_MAGIC = 0x1f;

const SIZE_TINY = 512;
const SIZE_SMALL = 4096;
const SIZE_MEDIUM = 32768;

function header(ver: number, tag: number): Buffer {
  return Buffer.from([MAGIC_HI, MAGIC_LO, ver, tag]);
}

/**
 * Compress synchronously using the best zlib tier for the payload size.
 *
 * Tiers (all synchronous — no network, no async, PREVENT-PI-004):
 *   < 512 B  → raw         (tag 0x00)
 *   512B–4KB → gzip level 1 (tag 0x01)
 *   4KB–32KB → gzip level 6 (tag 0x02)
 *   > 32 KB  → brotli 4     (tag 0x05)
 *
 * Writes the versioned header so readers disambiguate from legacy blobs.
 */
export function compressSmart(data: Buffer): Buffer {
  const len = data.length;
  if (len < SIZE_TINY) {
    return Buffer.concat([header(1, TAG_RAW), data]);
  }
  if (len < SIZE_SMALL) {
    return Buffer.concat([header(1, TAG_GZIP_1), gzipSync(data, { level: 1 })]);
  }
  if (len < SIZE_MEDIUM) {
    return Buffer.concat([header(1, TAG_GZIP_6), gzipSync(data, { level: 6 })]);
  }
  const compressed = brotliCompressSync(data, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  return Buffer.concat([header(1, TAG_BROTLI_4), compressed]);
}

/** True when `buf` is a versioned-format blob (0xEC 0x01 …). */
export function isVersioned(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === MAGIC_HI && buf[1] === MAGIC_LO;
}

/** Detect which format era a buffer belongs to (for tests/telemetry). */
export type CompressedFormat = "versioned" | "legacy-tag" | "legacy-gzip" | "unknown";
export function detectFormat(buf: Buffer): CompressedFormat {
  if (isVersioned(buf)) return "versioned";
  if (buf[0] === GZIP_MAGIC) return "legacy-gzip";
  // Legacy single-tag: first byte is a known legacy tag.
  if (buf[0] === 0x00 || buf[0] === 0x01 || buf[0] === 0x02 || buf[0] === 0x03) {
    return "legacy-tag";
  }
  return "unknown";
}

/**
 * Decompress a buffer written by `compressSmart` (versioned) OR any legacy
 * format still on disk (legacy single-tag, legacy untagged gzip). SYNCHRONOUS.
 *
 * Throws on zstd blobs — those must go through the async `decompressZstd`,
 * because zstd decompression cannot be awaited inside this sync path.
 */
export function decompressSmart(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;

  // New versioned format — dispatch on the namespaced tier tag.
  if (isVersioned(buf)) {
    const tag = buf[3];
    const payload = buf.subarray(4);
    switch (tag) {
      case TAG_RAW:
        return payload;
      case TAG_GZIP_1:
      case TAG_GZIP_6:
        return gunzipSync(payload);
      case TAG_BROTLI_4:
        return brotliDecompressSync(payload);
      case TAG_ZSTD_3:
      case TAG_ZSTD_9:
        throw new Error(
          "decompressSmart cannot read zstd blobs (async only) — use decompressZstd",
        );
      default:
        throw new Error(`decompressSmart: unknown versioned tier tag 0x${tag.toString(16)}`);
    }
  }

  // Legacy untagged gzip file (old writeGzJson with no tag byte).
  if (buf[0] === GZIP_MAGIC) {
    return gunzipSync(buf);
  }

  // Legacy single-tag format (store.ts v0.1.0): tags 0x00..0x03.
  const tag = buf[0];
  const payload = buf.subarray(1);
  switch (tag) {
    case 0x00: // TAG_RAW (legacy)
      return payload;
    case 0x01: // TAG_GZIP_1 (legacy)
    case 0x02: // TAG_GZIP_6 (legacy)
      return gunzipSync(payload);
    case 0x03: // TAG_BROTLI (legacy) — the very collision this format fixes
      return brotliDecompressSync(payload);
    default:
      // Unknown legacy tag — last-ditch try plain gzip.
      return gunzipSync(buf);
  }
}

// --- Optional async zstd path (DR export / large blobs) --------------------
// Self-describing: own 2-byte marker so it never routes through decompressSmart.
const ZSTD_MAGIC_HI = 0x5a; // 'Z'
const ZSTD_MAGIC_LO = 0x53; // 'S'

async function compressZstdWithLevel(data: Buffer, level: number): Promise<Buffer> {
  const compressed = await zstd.compress(data, level);
  return Buffer.concat([Buffer.from([ZSTD_MAGIC_HI, ZSTD_MAGIC_LO]), compressed]);
}

/** Compress with zstd level 3 (fast, balanced). Async. */
export function compressZstd(data: Buffer): Promise<Buffer> {
  return compressZstdWithLevel(data, 3);
}

/** Compress with zstd level 9 (max ratio). Async. */
export function compressZstdMax(data: Buffer): Promise<Buffer> {
  return compressZstdWithLevel(data, 9);
}

/** True when a buffer is a zstd-compressed blob from this helper. */
export function isZstd(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === ZSTD_MAGIC_HI && buf[1] === ZSTD_MAGIC_LO;
}

/** Decompress a zstd blob produced by compressZstd/compressZstdMax. Async. */
export async function decompressZstd(buf: Buffer): Promise<Buffer> {
  if (buf.length === 0) return buf;
  if (!isZstd(buf)) {
    throw new Error("decompressZstd: buffer is not a zstd blob (missing ZS marker)");
  }
  return zstd.decompress(buf.subarray(2));
}

/**
 * Decompress anything we can WITHOUT awaiting: versioned + legacy zlib formats.
 * zstd blobs are detected and reported (not thrown blindly) so callers can
 * decide whether to await decompressZstd.
 */
export function decompressSyncAuto(buf: Buffer): { data: Buffer; isZstd: boolean } {
  if (isZstd(buf)) return { data: buf, isZstd: true };
  return { data: decompressSmart(buf), isZstd: false };
}
