/**
 * vector-cortex/rollout/assign.ts — deterministic stable-bucket assignment.
 *
 * `assignSession(sessionId)` hashes a session id into one of 10,000 stable
 * buckets (0..9999). The assignment is a PURE function of the session id and
 * NEVER changes across process restart: it uses a fixed-seed FNV-1a over the
 * session id bytes, never Date.now / Math.random (PREVENT-PI-004-adjacent
 * determinism contract; the spec's restart-invariance requirement).
 *
 * A bucket `b` is "in" gate `g` (one of [1,5,25,50,100]) iff
 * `b < g * 100`. So gate 1% covers buckets 0..99, gate 100% covers 0..9999.
 *
 * Pure: no I/O, no clock, no network. PREVENT-011: no `any`.
 */

import {
  ROLLOUT_BUCKETS,
  ROLLOUT_GATES,
  type GateIndex,
  type RolloutAssignmentV1,
} from "./types.js";

/**
 * Deterministic 32-bit FNV-1a over the session id (UTF-8 bytes). Fixed seed
 * (2166136261) — restart-invariant by construction. Returns a bucket in
 * 0..(ROLLOUT_BUCKETS-1).
 */
export function assignSession(sessionId: string): RolloutAssignmentV1 {
  const enc = new TextEncoder();
  const bytes = enc.encode(sessionId);
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    // hash *= 16777619 (FNV prime) with 32-bit overflow wrap.
    hash = Math.imul(hash, 0x01000193);
  }
  const bucket = (hash >>> 0) % ROLLOUT_BUCKETS;

  // The bucket's qualifying gate is the HIGHEST gate whose bound it falls under.
  let gateIndex: GateIndex = 0;
  for (let i = 0; i < ROLLOUT_GATES.length; i++) {
    if (bucket < ROLLOUT_GATES[i]! * 100) {
      gateIndex = i as GateIndex;
      break;
    }
  }

  return {
    schema: "rollout-assignment-v1",
    sessionId,
    bucket,
    gateIndex,
  };
}

/**
 * Whether a bucket qualifies for a given gate percentage. Used by the live seam
 * to decide whether a session's bucket is currently exposed to the VC path.
 */
export function bucketInGate(bucket: number, gatePct: number): boolean {
  return bucket < gatePct * 100;
}

/** Current gate percentage for a gate index. */
export function gatePctForIndex(gateIndex: GateIndex): number {
  return ROLLOUT_GATES[gateIndex]!;
}
