/**
 * vector-cortex/cache/crystal.ts — canonical crystal key encoding (VC7A).
 *
 * Turns a `CrystalKeyV1` into a single stable digest. Everything about the
 * encoding exists to make two properties simultaneously true:
 *
 *   1. IDENTICAL INPUTS ⇒ IDENTICAL KEY, regardless of how the caller ordered
 *      its ranges or which host produced them. Hence the explicit sort and the
 *      length-prefixed field framing below.
 *   2. ANY IDENTITY CHANGE ⇒ DIFFERENT KEY, with no accidental aliasing. Hence
 *      length prefixes rather than delimiters: a delimiter-joined encoding lets
 *      an attacker (or an unlucky session name) push a separator into a field
 *      and forge a collision — `("a|b", "c")` and `("a", "b|c")` hash the same.
 *      Prefixing every variable-length field with its byte length makes the
 *      encoding injective, so a collision requires an actual SHA-256 collision.
 *
 * WHAT IS DELIBERATELY ABSENT. The global ledger frontier. It is not a
 * parameter, it is not readable from here, and there is no code path that could
 * fold it in. An unrelated append advances the frontier constantly; including it
 * would invalidate every crystal on every turn and the cache would never hit.
 * The key covers what the render DEPENDED ON, not what the world has since done.
 *
 * OVERLAP IS REJECTED, NOT MERGED. Two overlapping ranges in the same session
 * make "the covered bytes" ambiguous: the overlap region would be hashed twice,
 * and if the two spans pinned different digests the key would silently encode a
 * contradiction. `CRY_RANGE_OVERLAP` fails the key closed instead. Ranges in
 * DIFFERENT sessions never conflict — they cover disjoint byte streams by
 * construction — so cross-session keys are legal and common.
 *
 * PURE. No clock, no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011). Runs identically with `MEGACOMPACT_VC7A` on or off — the flag
 * gates only the reporter/dashboard seam in `crystal-emit.ts`.
 */

import { createHash } from "node:crypto";

import {
  CRYSTAL_LIMIT_BYTES,
  CRYSTAL_LIMIT_RANGES,
  type CrystalFailureCode,
  type CrystalKeyResult,
  type CrystalKeyV1,
  type DagSpan,
} from "./types.js";

/** Encoding version, folded into the digest so a future change cannot alias. */
const KEY_ENCODING_VERSION = "crystal-key-v1";

/**
 * Length-prefixed field append. `<byteLength>:<bytes>` makes the concatenation
 * injective, so no combination of field contents can impersonate another.
 */
function field(parts: string[], value: string): void {
  parts.push(`${Buffer.byteLength(value, "utf8")}:${value}`);
}

/**
 * Total order over covered ranges: session, then start seq, then start byte.
 *
 * Ordering by SOURCE START (not by insertion, not by digest) is what makes the
 * key independent of how the planner happened to enumerate its spans. `sessionId`
 * leads because seq numbers are only comparable within a session.
 */
export function compareSpans(a: DagSpan, b: DagSpan): number {
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  if (a.startSeq !== b.startSeq) return a.startSeq < b.startSeq ? -1 : 1;
  if (a.startByte !== b.startByte) return a.startByte - b.startByte;
  if (a.endSeq !== b.endSeq) return a.endSeq < b.endSeq ? -1 : 1;
  return a.endByte - b.endByte;
}

/** Sort covered ranges into canonical order (never mutates the input array). */
export function sortSpans(spans: readonly DagSpan[]): readonly DagSpan[] {
  return [...spans].sort(compareSpans);
}

/** A range is malformed if either bound runs backwards or a byte bound is negative. */
function isMalformed(s: DagSpan): boolean {
  return (
    s.endSeq < s.startSeq ||
    s.startByte < 0 ||
    s.endByte < s.startByte ||
    !Number.isSafeInteger(s.startByte) ||
    !Number.isSafeInteger(s.endByte)
  );
}

/**
 * Byte-range overlap between two spans of the SAME session. Byte bounds are
 * half-open (`[startByte, endByte)`), so touching ranges (`a.end === b.start`)
 * are adjacent, not overlapping, and are legal.
 */
function overlaps(a: DagSpan, b: DagSpan): boolean {
  return a.sessionId === b.sessionId && a.startByte < b.endByte && b.startByte < a.endByte;
}

/**
 * Validate covered ranges: non-empty, bounded, well-formed, and disjoint within
 * each session. Returns deduplicated codes in a deterministic order.
 */
export function validateRanges(spans: readonly DagSpan[]): readonly CrystalFailureCode[] {
  const codes = new Set<CrystalFailureCode>();
  if (spans.length === 0) codes.add("CRY_RANGE_EMPTY");
  if (spans.length > CRYSTAL_LIMIT_RANGES) codes.add("CRY_KEY_LIMIT");

  let totalBytes = 0;
  for (const s of spans) {
    if (isMalformed(s)) codes.add("CRY_RANGE_INVALID");
    else totalBytes += s.endByte - s.startByte;
  }
  if (totalBytes > CRYSTAL_LIMIT_BYTES) codes.add("CRY_KEY_LIMIT");

  // Sorted order makes overlap a neighbour check within each session run.
  const sorted = sortSpans(spans);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev !== undefined && cur !== undefined && overlaps(prev, cur)) {
      codes.add("CRY_RANGE_OVERLAP");
      break;
    }
  }

  const order: CrystalFailureCode[] = [
    "CRY_RANGE_EMPTY",
    "CRY_RANGE_INVALID",
    "CRY_RANGE_OVERLAP",
    "CRY_KEY_LIMIT",
  ];
  return order.filter((c) => codes.has(c));
}

/**
 * The covered-bytes digest: SHA-256 over the SORTED ranges' identities and their
 * pinned span digests, `sha256:` prefixed (matching the `DagSpan.digest`
 * convention the ranges themselves carry).
 *
 * The span digests are what make this sensitive to a single covered BYTE: the
 * ranges alone would be identical if a byte inside an unchanged range mutated,
 * but the span's pinned digest would not be (CRY-COVERED-002).
 */
export function computeCoveredDigest(spans: readonly DagSpan[]): string {
  const h = createHash("sha256");
  for (const s of sortSpans(spans)) {
    const parts: string[] = [];
    field(parts, s.sessionId);
    field(parts, s.startSeq.toString());
    field(parts, s.endSeq.toString());
    field(parts, String(s.startByte));
    field(parts, String(s.endByte));
    field(parts, s.digest);
    h.update(parts.join(""), "utf8");
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * Canonical key bytes. Field order is fixed and every field is length-prefixed;
 * the ranges are emitted in canonical sort order with an explicit count so a
 * key with N ranges can never encode the same bytes as one with M.
 */
export function encodeCrystalKeyBytes(key: CrystalKeyV1): string {
  const parts: string[] = [];
  field(parts, KEY_ENCODING_VERSION);
  field(parts, key.profileId);
  field(parts, key.profileVersion);
  field(parts, key.requestDigest);
  field(parts, key.rendererVersion);
  field(parts, key.dependencyHighWater.toString());
  field(parts, key.coveredDigest);
  const sorted = sortSpans(key.sourceRanges);
  field(parts, String(sorted.length));
  for (const s of sorted) {
    field(parts, s.sessionId);
    field(parts, s.startSeq.toString());
    field(parts, s.endSeq.toString());
    field(parts, String(s.startByte));
    field(parts, String(s.endByte));
    field(parts, s.digest);
  }
  return parts.join("");
}

/**
 * Build the canonical key digest for a crystal identity.
 *
 * The returned `key` carries the ranges in canonical sorted order and the
 * RE-DERIVED `coveredDigest`, so a caller that supplied a stale or wrong covered
 * digest cannot mint a key that disagrees with its own ranges. The digest itself
 * is bare lowercase hex (it addresses an identity, not source bytes).
 */
export function encodeCrystalKey(key: CrystalKeyV1): CrystalKeyResult {
  const codes = validateRanges(key.sourceRanges);
  if (codes.length > 0) return { ok: false, codes };

  const normalized: CrystalKeyV1 = {
    ...key,
    sourceRanges: sortSpans(key.sourceRanges),
    coveredDigest: computeCoveredDigest(key.sourceRanges),
  };
  const keyDigest = createHash("sha256")
    .update(encodeCrystalKeyBytes(normalized), "utf8")
    .digest("hex");
  return { ok: true, keyDigest, key: normalized };
}

/**
 * Whether two identities are the same crystal. Used by invalidation fixtures to
 * state the sprint invariant directly: the key changes IFF an identity field
 * changes — an unrelated frontier append is not an identity field, so it cannot
 * appear here at all.
 */
export function sameCrystalKey(a: CrystalKeyV1, b: CrystalKeyV1): boolean {
  const ea = encodeCrystalKey(a);
  const eb = encodeCrystalKey(b);
  return ea.ok && eb.ok && ea.keyDigest === eb.keyDigest;
}
