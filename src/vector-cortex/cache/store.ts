/**
 * vector-cortex/cache/store.ts — content-addressed, write-once crystal store
 * (VC7A).
 *
 * WRITE ONCE, NEVER OVERWRITE. A key that already holds bytes is final. Writing
 * the SAME bytes again is accepted and idempotent (two concurrent renders raced;
 * both are right). Writing DIFFERENT bytes under the same key returns
 * `CRY_KEY_COLLISION` and the stored crystal is left exactly as it was.
 *
 * Why refuse rather than take the newer bytes? Because the key already names
 * everything the render depended on — covered ranges, their digest, the validated
 * dependency high-water, the renderer, the profile. If two renders of that same
 * identity disagree, the renderer is NOT deterministic, and that is a bug to
 * surface loudly, not to paper over by picking a winner. Last-write-wins would
 * make the failure invisible and let a corrupted render silently displace a good
 * one. So the store is a one-way ratchet per key.
 *
 * CONTENT ADDRESSED. Every crystal carries the SHA-256 of exactly its own bytes
 * (bare lowercase hex, matching `ExactShardV1.digest`), recomputed HERE from the
 * bytes rather than trusted from the caller — a caller-supplied digest would let
 * a mismatched pair be stored and later "verify" against itself.
 *
 * ATOMIC COMMIT (the crash invariant). Writes go through a staging slot and are
 * only published by `commit`. A write interrupted before commit leaves the
 * staging entry orphaned and the visible map untouched, so `read` can never
 * observe a partial crystal. On restart, `recover()` DISCARDS staged entries —
 * it never promotes them — and a fresh write then produces exactly one valid
 * crystal. This models the real filesystem shape (write temp file → fsync →
 * rename) without doing any I/O here: persistence is the runtime's job, and
 * `src/` stays storage-free and pure (PREVENT-PI-004).
 *
 * MODE C. `setAvailable(false)` marks the store unavailable: reads serve nothing
 * and writes refuse with `CRY_STORE_UNAVAILABLE`. Mode C is a real triad state,
 * not an error path — the caller must fall back to a fresh render and disclose
 * that nothing came from cache.
 *
 * No console, no network (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

import type {
  CrystalMode,
  CrystalStoreStats,
  CrystalV1,
  CrystalWriteResult,
} from "./types.js";

/** SHA-256 over bytes, BARE lowercase hex (the content address). */
export function contentAddress(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Byte equality without allocating — a length check first, then a scan. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * An in-memory, content-addressed, write-once crystal store.
 *
 * Deliberately holds no filesystem handle: the process-local map IS the store as
 * far as `src/` is concerned, and durability is layered on by the runtime. That
 * keeps the write-once/collision arithmetic testable end-to-end with real
 * modules and no I/O mocking.
 */
export class CrystalStore {
  /** Published crystals, keyed by canonical key digest. */
  private readonly committed = new Map<string, CrystalV1>();
  /** Staged-but-uncommitted writes — invisible to `read` until committed. */
  private readonly staged = new Map<string, CrystalV1>();
  private available = true;
  private hits = 0;
  private misses = 0;
  private hitBytes = 0;
  private writes = 0;
  private duplicateWrites = 0;
  private collisions = 0;

  /** Freeze a crystal object for a key/bytes pair (digest computed here). */
  static freeze(keyDigest: string, bytes: Uint8Array, key: CrystalV1["key"]): CrystalV1 {
    const copy = new Uint8Array(bytes);
    return {
      schema: "crystal-v1",
      keyDigest,
      bytes: copy,
      contentDigest: contentAddress(copy),
      byteCount: copy.length,
      key,
    };
  }

  /** Toggle store availability (mode C when false). */
  setAvailable(value: boolean): void {
    this.available = value;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Stage a write without publishing it. Returns the staging handle (the key
   * digest) so a test — or a crash — can leave it uncommitted.
   */
  stage(crystal: CrystalV1): CrystalWriteResult {
    if (!this.available) {
      return { ok: false, code: "CRY_STORE_UNAVAILABLE", contentDigest: crystal.contentDigest };
    }
    this.staged.set(crystal.keyDigest, crystal);
    return { ok: true, written: false, contentDigest: crystal.contentDigest };
  }

  /**
   * Publish a staged write. Enforces write-once at the commit point: an existing
   * key with identical bytes is idempotent, with different bytes is a collision
   * and is NEVER overwritten.
   */
  commit(keyDigest: string): CrystalWriteResult {
    const pending = this.staged.get(keyDigest);
    if (pending === undefined) {
      return { ok: false, code: "CRY_STORE_UNAVAILABLE", contentDigest: "" };
    }
    this.staged.delete(keyDigest);
    if (!this.available) {
      return { ok: false, code: "CRY_STORE_UNAVAILABLE", contentDigest: pending.contentDigest };
    }
    const existing = this.committed.get(keyDigest);
    if (existing !== undefined) {
      if (bytesEqual(existing.bytes, pending.bytes)) {
        this.duplicateWrites += 1;
        return { ok: true, written: false, contentDigest: existing.contentDigest };
      }
      this.collisions += 1;
      return { ok: false, code: "CRY_KEY_COLLISION", contentDigest: existing.contentDigest };
    }
    this.committed.set(keyDigest, pending);
    this.writes += 1;
    return { ok: true, written: true, contentDigest: pending.contentDigest };
  }

  /** Stage + commit in one step (the normal path). */
  write(crystal: CrystalV1): CrystalWriteResult {
    const staged = this.stage(crystal);
    if (!staged.ok) return staged;
    return this.commit(crystal.keyDigest);
  }

  /**
   * Restart recovery: DISCARD every staged entry. A write interrupted before
   * commit is never promoted — a fresh write afterwards produces exactly one
   * valid crystal. Returns how many partial writes were dropped.
   */
  recover(): number {
    const dropped = this.staged.size;
    this.staged.clear();
    return dropped;
  }

  /** Read a committed crystal. Mode C (unavailable) serves nothing. */
  read(keyDigest: string): CrystalV1 | undefined {
    if (!this.available) {
      this.misses += 1;
      return undefined;
    }
    const found = this.committed.get(keyDigest);
    if (found === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.hitBytes += found.byteCount;
    return found;
  }

  /** Whether a key holds a committed crystal (does not count as a read). */
  has(keyDigest: string): boolean {
    return this.available && this.committed.has(keyDigest);
  }

  /** Number of writes staged but not yet committed (0 after `recover`). */
  pendingCount(): number {
    return this.staged.size;
  }

  /**
   * The triad mode the store is currently in: C when unavailable, A once a read
   * has been served from the store, B while every read has forced a fresh render.
   */
  mode(): CrystalMode {
    if (!this.available) return "C";
    return this.hits > 0 ? "A" : "B";
  }

  /** Reader-only aggregate for the dashboard seam — counts and bytes only. */
  stats(): CrystalStoreStats {
    let totalBytes = 0;
    for (const c of this.committed.values()) totalBytes += c.byteCount;
    return {
      mode: this.mode(),
      crystalCount: this.committed.size,
      totalBytes,
      hits: this.hits,
      misses: this.misses,
      hitBytes: this.hitBytes,
      writes: this.writes,
      duplicateWrites: this.duplicateWrites,
      collisions: this.collisions,
    };
  }
}
