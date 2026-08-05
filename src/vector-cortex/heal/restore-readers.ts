/**
 * vector-cortex/heal/restore-readers.ts — the two EXACT source readers (VC6B).
 *
 * Split out of `restore.ts` so the orchestrator stays a short, readable policy
 * file and each reader can be reasoned about on its own (PRACTICES: split at the
 * 300-line soft limit, delegate-shell + impl).
 *
 * Both readers share one discipline: they return bytes ONLY after recomputing
 * SHA-256 over the bytes they actually hold and comparing it to the digest the
 * REQUEST pinned. Neither reader trusts the digest recorded alongside its own
 * source — an `ExactShardV1.digest` is metadata that lives in the same file as
 * the bytes, so a swapped file carries a matching (wrong) pair. Only the
 * caller-supplied digest is authoritative, and only a fresh hash of the fetched
 * bytes can be checked against it.
 *
 * Pure/deterministic/local: `node:crypto` only (a Node built-in, not a network
 * call), no storage, no console (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

import type { EventV2, ExactShardV1, ShardRange } from "./restore-types.js";

/**
 * SHA-256 over bytes as LOWERCASE HEX with NO `sha256:` prefix — the
 * `ExactShardV1.digest` / `ReconstructionSpan.digest` / `RestoreSpanRequest`
 * convention. `EventV2.bytesDigest` prefixes this same value with `sha256:`.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Strip the `sha256:` prefix from an `EventV2.bytesDigest` so it can be compared
 * against a bare hex digest. A value that does not carry the prefix is returned
 * unchanged rather than mangled — the comparison then simply fails, which is the
 * correct outcome for a malformed record.
 */
export function bareHex(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

/**
 * Structural range equality. All five components must match: two spans over the
 * same seq window but different byte offsets are DIFFERENT spans (a re-encoded
 * or re-offset stream is not the stream that was requested).
 */
export function rangeEquals(a: ShardRange, b: ShardRange): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.seqStart === b.seqStart &&
    a.seqEnd === b.seqEnd &&
    a.byteStart === b.byteStart &&
    a.byteEnd === b.byteEnd
  );
}

/** What a reader attempt produced: bytes, a stated failure, or simply nothing. */
export type ReadOutcome =
  /** Bytes fetched AND verified against the request digest. */
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /** A source existed but its bytes did not hash to the pinned digest. */
  | { readonly kind: "digest-mismatch" }
  /** No source of this tier covers the span; try the next tier. */
  | { readonly kind: "absent" };

/**
 * Mode A — indexed exact-shard read.
 *
 * Selection is by RANGE identity plus the shard's own recorded digest, which
 * narrows the candidate set the way a real index lookup would. The accepted
 * candidate is then re-hashed from its `originalBytes`: this second check is
 * what catches a shard whose bytes were swapped AFTER the index lookup resolved
 * (the sprint's unique failure injection). A candidate that matches by range but
 * fails either digest check reports `digest-mismatch` — it does NOT silently fall
 * through to the ledger, because a corrupt exact shard is a fact worth surfacing.
 */
export function readExactShard(
  shards: readonly ExactShardV1[],
  range: ShardRange,
  digest: string,
): ReadOutcome {
  const byRange = shards.filter((s) => rangeEquals(s.range, range));
  if (byRange.length === 0) return { kind: "absent" };

  const candidate = byRange.find((s) => s.digest === digest);
  if (candidate === undefined) return { kind: "digest-mismatch" };

  // Defense in depth: the shard's recorded digest is metadata, the bytes are the
  // authority. Re-hash what we actually hold.
  const bytes = candidate.originalBytes;
  if (sha256Hex(bytes) !== digest) return { kind: "digest-mismatch" };
  return { kind: "bytes", bytes };
}

/**
 * Mode B — ledger range scan.
 *
 * An INDEPENDENT path from mode A: no shard index is consulted. The occurrence
 * records covering `[seqStart..seqEnd]` are selected, sorted ascending by seq
 * (the caller's array order is untrusted — a scan that concatenated records in
 * arrival order would produce plausible-looking but wrong bytes), each record's
 * own `bytesDigest` is verified, and the concatenation is hashed against the
 * span digest.
 *
 * Both checks matter. Per-record verification localizes corruption to a single
 * occurrence; the span-level hash catches a scan that is individually valid but
 * collectively wrong — a missing record in the middle of the range, or a range
 * that covers different content than the requester believed.
 */
export function readLedgerSpan(
  events: readonly EventV2[],
  range: ShardRange,
  digest: string,
): ReadOutcome {
  const covering = events
    .filter(
      (e) =>
        e.sessionId === range.sessionId &&
        e.seq >= range.seqStart &&
        e.seq <= range.seqEnd,
    )
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  if (covering.length === 0) return { kind: "absent" };

  // Per-record byte authority (VC1A): a record whose own digest disagrees with
  // its bytes is corrupt, and a corrupt record can never contribute to a restore.
  for (const e of covering) {
    if (sha256Hex(e.originalBytes) !== bareHex(e.bytesDigest)) {
      return { kind: "digest-mismatch" };
    }
  }

  const total = covering.reduce((sum, e) => sum + e.originalBytes.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const e of covering) {
    bytes.set(e.originalBytes, offset);
    offset += e.originalBytes.length;
  }

  if (sha256Hex(bytes) !== digest) return { kind: "digest-mismatch" };
  return { kind: "bytes", bytes };
}
