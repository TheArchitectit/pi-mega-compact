/**
 * outcomes/consent.ts — VC8A append-only consent grants/revocations.
 *
 * ConsentV1 is append-only: grants and revocations are appended with an
 * effective sequence number. A session has active explicit consent at time T
 * if its most recent record at or before T is a grant.
 *
 * Dataset inclusion requires active explicit consent at export time. This
 * module provides the pure consent-evaluation functions; the dataset module
 * calls `hasActiveConsent` at export time.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import { CONSENT_SCHEMA_V1, type ConsentV1 } from "./types.js";

/**
 * Evaluate whether a session has active explicit consent at or before the
 * given effective sequence high-water. True if the most recent record at or
 * before `effectiveHighWater` is a grant.
 */
export function hasActiveConsent(
  records: ReadonlyArray<ConsentV1>,
  sessionId: string,
  effectiveHighWater: number,
): boolean {
  const relevant = records
    .filter((r) => r.sessionId === sessionId && r.effectiveSeq <= effectiveHighWater)
    .sort((a, b) => a.effectiveSeq - b.effectiveSeq);
  if (relevant.length === 0) return false;
  return relevant[relevant.length - 1].action === "grant";
}

/**
 * Append a consent grant for a session at the next effective sequence.
 * Returns a new ConsentV1 record (append-only — never mutates the input).
 */
export function appendGrant(
  sessionId: string,
  effectiveSeq: number,
  ts: string,
): ConsentV1 {
  return {
    schema: CONSENT_SCHEMA_V1,
    consentId: `consent-${sessionId}-${effectiveSeq}`,
    sessionId,
    action: "grant",
    effectiveSeq,
    ts,
  };
}

/**
 * Append a consent revocation for a session at the next effective sequence.
 * Returns a new ConsentV1 record (append-only — never mutates the input).
 */
export function appendRevoke(
  sessionId: string,
  effectiveSeq: number,
  ts: string,
): ConsentV1 {
  return {
    schema: CONSENT_SCHEMA_V1,
    consentId: `consent-${sessionId}-${effectiveSeq}`,
    sessionId,
    action: "revoke",
    effectiveSeq,
    ts,
  };
}

/**
 * Get the effective consent high-water for a session — the maximum effectiveSeq
 * across all consent records for that session. Used by the dataset exporter
 * to capture a single consent snapshot at export time.
 */
export function consentHighWater(
  records: ReadonlyArray<ConsentV1>,
  sessionId: string,
): number {
  let max = 0;
  for (const r of records) {
    if (r.sessionId === sessionId && r.effectiveSeq > max) {
      max = r.effectiveSeq;
    }
  }
  return max;
}
