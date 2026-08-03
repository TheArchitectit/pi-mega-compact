/**
 * vector-cortex/ledger/validator.ts — EventV2 canonical validation (VC1A).
 *
 * Canonical ordering is `(sessionId, seq, eventId bytewise UTF-8)`: the sort is
 * by the eventId's UTF-8 BYTES (unsigned) — NOT by JS string code-unit order —
 * so multi-byte eventIds sort bytewise. Deterministic failure detection with a
 * fixed priority order:
 *   1. EVT_DIGEST_MISMATCH   — sha256(originalBytes) !== bytesDigest
 *   2. EVT_UTF8_TAG_INVALID  — stored `utf8` discriminant contradicting a strict
 *                              fatal re-classification of originalBytes
 *   3. EVT_DUPLICATE_ID      — duplicate (sessionId, seq, eventId) occurrence
 *
 * The unique failure injection requirement: flip ONE stored byte while retaining
 * the SHA-256 signature — the digest recomputation diverges and the validator
 * returns EVT_DIGEST_MISMATCH (never a lossy replacement text, which is not
 * produced anywhere in this module).
 *
 * Pure/deterministic — no console, no network, no side effects (PREVENT-PI-004).
 */

import nodeCrypto from "node:crypto";
import { classifyUtf8 } from "./event-codec.js";
import type { BytesDigest, EventV2, ValidationCode, ValidationIssue, ValidationResult } from "./types.js";

/** Mode-A digest recompute (validator uses the codec's canonical digest rule). */
function digestOf(bytes: Uint8Array): BytesDigest {
  const hex = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/** Bytewise UTF-8 comparator for eventId tiebreak (unsigned bytes, not code units). */
function compareEventIdBytes(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1;
  }
  if (ab.length !== bb.length) return ab.length < bb.length ? -1 : 1;
  return 0;
}

/** Comparator: `(sessionId, seq, eventId bytewise UTF-8)`. */
export function compareEvents(a: EventV2, b: EventV2): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return compareEventIdBytes(a.eventId, b.eventId);
}

/** Ascending (sessionId, seq, eventId-bytes) sort. Returns a new array. */
export function sortEvents(events: readonly EventV2[]): EventV2[] {
  return [...events].sort(compareEvents);
}

/** Recompute the digest and compare to the stored one (authority corruption). */
function digestMismatch(event: EventV2): boolean {
  return digestOf(event.originalBytes) !== event.bytesDigest;
}

/** The stored utf8 discriminant must match a strict fatal re-classification. */
function utf8TagMismatch(event: EventV2): boolean {
  const cls = classifyUtf8(event.originalBytes);
  const stored = event.utf8;
  if (stored.valid !== cls.valid) return true;
  if (!stored.valid) {
    // Both invalid: never compare decoded text; only the (valid, base64) shape.
    return false;
  }
  if (!cls.valid) return true; // unreachable given `stored.valid === cls.valid`
  // Both valid: compare the strict-decoded TEXT (no NFC — the tag stores raw text).
  return stored.text !== cls.text;
}

/**
 * Validate a batch of events. Returns `{ok:true, ordered}` when every event
 * passes digest + UTF-8-tag consistency and no duplicate occurrence exists;
 * otherwise `{ok:false, codes}` with the failure codes in fixed priority order,
 * deduplicated, and an explicit issue list for diagnostics.
 */
export function validateEvents(events: readonly EventV2[]): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Fixed priority order: DIGEST_MISMATCH, UTF8_TAG_INVALID, DUPLICATE_ID.
  for (const e of events) {
    if (digestMismatch(e)) {
      issues.push({ code: "EVT_DIGEST_MISMATCH", sessionId: e.sessionId, seq: e.seq, eventId: e.eventId });
    }
  }
  for (const e of events) {
    if (utf8TagMismatch(e)) {
      issues.push({ code: "EVT_UTF8_TAG_INVALID", sessionId: e.sessionId, seq: e.seq, eventId: e.eventId });
    }
  }

  // Unambiguous (sessionId, seq, eventId) occurrence key (seq stringified — a
  // bigint cannot be JSON-serialized directly).
  const key = (e: EventV2): string => JSON.stringify([e.sessionId, e.seq.toString(), e.eventId]);
  const seen = new Set<string>();
  for (const e of sortEvents(events)) {
    const k = key(e);
    if (seen.has(k)) {
      issues.push({ code: "EVT_DUPLICATE_ID", sessionId: e.sessionId, seq: e.seq, eventId: e.eventId });
    }
    seen.add(k);
  }

  if (issues.length === 0) {
    return { ok: true, ordered: sortEvents(events) };
  }
  return { ok: false, codes: dedupe(issues.map((i) => i.code)) };
}

function dedupe(codes: ValidationCode[]): ValidationCode[] {
  const out: ValidationCode[] = [];
  for (const c of codes) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Export the canonical ordering comparator for consumers (replay etc.). */
export { compareEventIdBytes };
