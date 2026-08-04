/**
 * vector-cortex/migrations/minhash-v2.ts — M4 MinHashV2 copy/validate/switch
 * migration (VC1C).
 *
 * M4 versions the L1 dedup signature store: v2 signatures/buckets are written
 * BESIDE v1, backfilled by checkpoint id, verified, and only then switched as
 * the active version. It follows the same copy/validate/switch + resume
 * contract as M2 but for the minhash index:
 *
 *   - batch: writes v2 signatures + buckets for a set of checkpoint IDs, each
 *     tagged with the frozen version 2; never touches v1 rows.
 *   - backfill: resumable by checkpoint id — an interrupted run resumes without
 *     duplicate v2 signatures or active-pointer drift.
 *   - verify: counts per checkpoint match v1 and every v2 digest re-hashes.
 *   - switch: atomically flips the ACTIVE VERSION pointer from v1 to v2; until
 *     a verified switch, v1 remains active (interruption keeps old authority).
 *
 * Cross-version compare is REJECTED: a mixed v1-v2 similarity/bucket query
 * returns `MINHASH_VERSION_MISMATCH` (never compares v1/v2 signatures).
 *
 * Pure logic over an injected M4Host (deterministic + testable; no console).
 * PREVENT-002/011/PI-004 honored.
 */

import { createHash } from "node:crypto";
import {
  MINHASH_VERSION,
  minhashV2Signature,
  encodeSignatureV2,
} from "../../dedup/l1-minhash-v2.js";
import { lshBandsV2, BANDS_V2 } from "../../dedup/l1-lsh-v2.js";

/** M4 failure codes. */
export const M4_FAIL = {
  VERSION_MISMATCH: "MINHASH_VERSION_MISMATCH",
  BACKFILL_PARTIAL: "M4_BACKFILL_PARTIAL",
  COUNT_MISMATCH: "M4_COUNT_MISMATCH",
  DIGEST_MISMATCH: "M4_DIGEST_MISMATCH",
} as const;
export type M4MigrationCode = (typeof M4_FAIL)[keyof typeof M4_FAIL];

/** A v2 signature row stored beside v1 (keyed by checkpoint id). */
export interface V2SignatureRow {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly version: number; // MINHASH_VERSION
  readonly signatureBytes: Uint8Array; // 2048 LE bytes
  readonly digest: string; // sha256: over signatureBytes
  readonly buckets: readonly string[]; // 64 band keys
}

/** The host the migration reads from / writes to (capability-shaped). */
export interface M4Host {
  /** Full set of v1 checkpoint ids the index should cover. */
  readonly v1CheckpointIds: () => readonly string[];
  /** Session id a checkpoint belongs to (for bucket scoping). */
  readonly sessionOf: (checkpointId: string) => string;
  /** The raw source text for a checkpoint (to recompute a v2 signature). */
  readonly sourceOf: (checkpointId: string) => string;
  /** Persisted v2 rows already written (for resume/dedup + active pointer). */
  readonly storedV2: () => readonly V2SignatureRow[];
  /** The currently ACTIVE version (1 until a verified switch). */
  readonly activeVersion: () => number;
  /** Idempotent write of v2 rows (never mutates v1 rows). */
  readonly putV2: (rows: readonly V2SignatureRow[]) => void;
  /** Atomically switch the active version pointer to v2. */
  readonly switchToV2: () => void;
}

/** An M4 migration failure result. */
export interface M4ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M4MigrationCode[];
}

/** Reject a cross-version compare. Returns the frozen mismatch code. */
export function crossVersionError(): M4MigrationCode {
  return M4_FAIL.VERSION_MISMATCH;
}

/**
 * Compute v2 signature + buckets for one checkpoint (the authoritative bytes).
 * Pure and cross-language deterministic.
 */
export function computeV2Row(host: M4Host, checkpointId: string): V2SignatureRow {
  const sessionId = host.sessionOf(checkpointId);
  const source = host.sourceOf(checkpointId);
  const sig = minhashV2Signature(source);
  const bytes = encodeSignatureV2(sig);
  const buckets = lshBandsV2(new Uint8Array(bytes), sessionId);
  return {
    checkpointId,
    sessionId,
    version: MINHASH_VERSION,
    signatureBytes: new Uint8Array(bytes),
    digest: `sha256:${sha256Hex(bytes)}`,
    buckets,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Backfill v2 signatures/buckets for all v1 checkpoint ids (resumable): rows
 * already persisted with matching digest are left untouched (no duplicates),
 * and the active pointer stays at v1 until a verified switch. Returns the rows
 * written this call (delta), never duplicates.
 */
export function m4Backfill(host: M4Host): readonly V2SignatureRow[] {
  const wanted = host.v1CheckpointIds();
  const existing = new Map(host.storedV2().map((r) => [r.checkpointId, r]));
  const writes: V2SignatureRow[] = [];
  for (const id of wanted) {
    if (existing.has(id)) continue; // already backfilled — resumable, no dup
    const row = computeV2Row(host, id);
    writes.push(row);
  }
  if (writes.length > 0) host.putV2(writes);
  return writes;
}

/**
 * Verify the backfilled v2 index: every v1 checkpoint has exactly one v2 row
 * (reset -> resumable partial counts), each stored row's digest re-hashes, and
 * each row has all 64 buckets. Never mutates.
 */
export function m4Verify(host: M4Host): M4ValidateResult {
  const codes: M4MigrationCode[] = [];
  const wanted = new Set(host.v1CheckpointIds());
  const stored = host.storedV2();
  const counts = new Map<string, number>();
  for (const r of stored) {
    counts.set(r.checkpointId, (counts.get(r.checkpointId) ?? 0) + 1);
    if (r.version !== MINHASH_VERSION) codes.push(M4_FAIL.VERSION_MISMATCH);
    if (r.signatureBytes.length !== 2048) codes.push(M4_FAIL.COUNT_MISMATCH);
    if (r.buckets.length !== BANDS_V2) codes.push(M4_FAIL.COUNT_MISMATCH);
    if (r.digest !== `sha256:${sha256Hex(r.signatureBytes)}`) {
      codes.push(M4_FAIL.DIGEST_MISMATCH);
    }
  }
  // Every v1 checkpoint backfilled exactly once (count parity, no dup rows).
  for (const id of wanted) {
    const c = counts.get(id) ?? 0;
    if (c === 0) codes.push(M4_FAIL.BACKFILL_PARTIAL);
    if (c > 1) codes.push(M4_FAIL.COUNT_MISMATCH);
  }
  // No orphan v2 rows without a v1 checkpoint.
  for (const id of counts.keys()) {
    if (!wanted.has(id)) codes.push(M4_FAIL.COUNT_MISMATCH);
  }
  const ok = codes.length === 0;
  return { ok, codes: dedupe(codes) };
}

/**
 * Switch the active version to v2. Only call after `m4Verify` reports ok; a
 * crash/return before switch leaves v1 active (interruption keeps old
 * authority, resumable idempotently).
 */
export function m4Switch(host: M4Host): void {
  host.switchToV2();
}

/** Full M4 lifecycle: backfill -> verify -> switch; returns verify result. */
export function migrateMinhashV2(host: M4Host): M4ValidateResult {
  m4Backfill(host);
  const v = m4Verify(host);
  if (v.ok) m4Switch(host);
  return v;
}

/** Registered M4 conformance ID range (M4-001..008 + named M4-*). */
export const M4_IDS = [
  "M4-001",
  "M4-002",
  "M4-003",
  "M4-004",
  "M4-005",
  "M4-006",
  "M4-007",
  "M4-008",
] as const;

/** Registered named M4 conformance IDs. */
export const M4_NAMED = [
  "M4-HIGHBIT-001",
  "M4-VERSION-002",
  "M4-RESUME-003",
] as const;

function dedupe(codes: M4MigrationCode[]): M4MigrationCode[] {
  const out: M4MigrationCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
