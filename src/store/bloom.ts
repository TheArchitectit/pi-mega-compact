/**
 * bloom.ts — local bloom-filter accelerator for the L0 content-hash dedup tier
 * (Sprint 10).
 *
 * ACCELERATOR ONLY (QA #2 spirit, re-mapped locally): a bloom filter has zero
 * false negatives — a MISS truly means "this content_hash is not present", so we
 * can skip the full SQLite scan on the happy path. A HIT is only a candidate and
 * MUST be confirmed by a SELECT against SQLite, which remains the source of truth
 * (PREVENT-PI-004: in-process, no network; SQLite owns durability).
 *
 * The filter is an in-memory `bloom-filters` Map persisted to
 * `STATE_DIR/bloom.json.gz` so a fresh VectorStore over the same dir reuses the
 * warm filter instead of rebuilding from a scan.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "../store.js";
import { compressSmart, decompressSmart } from "../store.js";

// Fixed bit-array size + hash count sized for a 1K-checkpoint fixture at <1% FP
// (m ≈ -n*ln(p)/ln(2)^2). 8 KiB bits → ~8192 bits, k=7 → well under 1% at 1K.
const BITS = 8192;
const HASHES = 7;
const STORAGE_MARK = 0x42; // 'B' — marks a persisted bloom blob (not versioned)

function fnv1a(data: Buffer, seed: number): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class BloomFilter {
  private bits: Uint8Array;

  constructor(bits?: Uint8Array) {
    this.bits = bits ?? new Uint8Array(BITS);
  }

  private indices(key: string): number[] {
    const data = Buffer.from(key, "utf-8");
    const idx: number[] = [];
    for (let i = 0; i < HASHES; i++) {
      // Double-hashing (Kirsch–Mitzenmacher) to derive k independent positions.
      const h1 = fnv1a(data, 0x9e3779b1 * i);
      const h2 = fnv1a(data, 0x85ebca77 * (i + 1));
      idx.push((h1 + i * h2) % BITS);
    }
    return idx;
  }

  add(key: string): void {
    for (const i of this.indices(key)) this.bits[i >> 3] |= 1 << (i & 7);
  }

  /** A miss is definitive (zero false negatives): false ⇒ definitely absent. */
  maybeHas(key: string): boolean {
    for (const i of this.indices(key)) {
      if ((this.bits[i >> 3] & (1 << (i & 7))) === 0) return false;
    }
    return true;
  }

  toBuffer(): Buffer {
    return Buffer.concat([Buffer.from([STORAGE_MARK]), Buffer.from(this.bits)]);
  }

  /** Raw bit array (for persistence). */
  bytes(): Uint8Array {
    return this.bits;
  }

  static fromBuffer(buf: Buffer): BloomFilter {
    if (buf.length >= 1 && buf[0] === STORAGE_MARK) {
      return new BloomFilter(Uint8Array.from(buf.subarray(1)));
    }
    // Legacy/compressed form: best-effort decompress.
    try {
      const raw = decompressSmart(buf);
      return new BloomFilter(Uint8Array.from(raw));
    } catch {
      return new BloomFilter();
    }
  }
}

const cache = new Map<string, BloomFilter>();

/** Load (or lazily create + cache) the bloom filter for a state dir. */
export function openBloom(stateDir: string = getStateDir()): BloomFilter {
  const existing = cache.get(stateDir);
  if (existing) return existing;
  const path = join(stateDir, "bloom.json.gz");
  let filter = new BloomFilter();
  if (existsSync(path)) {
    try {
      filter = BloomFilter.fromBuffer(readFileSync(path));
    } catch {
      filter = new BloomFilter();
    }
  }
  cache.set(stateDir, filter);
  return filter;
}

/** Persist the bloom filter to disk (additive — does not clear the cache). */
export function saveBloom(stateDir: string = getStateDir()): void {
  const filter = cache.get(stateDir);
  if (!filter) return;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  // Compress the raw bit array for a smaller, versioned-on-disk footprint.
  const blob = compressSmart(Buffer.from(filter.bytes()));
  writeFileSync(join(stateDir, "bloom.json.gz"), blob);
}

/** Evict the cached filter (test teardown only). */
export function closeBloom(stateDir: string): void {
  cache.delete(stateDir);
}
