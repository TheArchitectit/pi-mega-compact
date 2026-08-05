/**
 * vector-cortex/cache/compiler.ts — VC7B provider-safe crystal boundary compiler.
 *
 * A provider caches a PREFIX of the request. So where you cut the prompt into
 * cacheable segments determines whether anything is reusable at all: cut too
 * finely and every segment falls under the provider's `minPrefix` and nothing is
 * cacheable; cut in the wrong place and a segment that changes every turn sits
 * in front of one that never changes, invalidating everything behind it. This
 * file turns validated source ranges plus a profile's limits into boundaries
 * that the provider can actually cache.
 *
 * THE ONE INVARIANT THAT OUTRANKS EVERYTHING: THE COMPILER NEVER CHANGES
 * REQUEST IDENTITY. It selects where boundaries FALL; it never reorders, never
 * merges across a session, never drops a range, never rewrites bytes. The
 * concatenation of the compiled boundaries covers exactly the same ranges, in
 * exactly the same canonical order, as the input — so the VC5B canonical request
 * digest and the VC7A crystal key are byte-identical before and after
 * compilation. `boundariesPreserveIdentity()` states this as an executable
 * check, and the acceptance suite runs it on every compiled row. If compilation
 * could alter identity it would be a cache-poisoning engine rather than an
 * optimizer: two different conversations could compile to one cache key.
 *
 * WHY MERGE FORWARD, AND ONLY WITHIN A SESSION. Ranges below `minPrefix` are not
 * independently cacheable, so the compiler merges each undersized range into the
 * one that FOLLOWS it in canonical order — forward, so the merged segment keeps
 * the earlier range's start and the prefix relationship is preserved. Merging is
 * confined to a single session because ranges from different sessions cover
 * disjoint byte streams; a cross-session segment would claim a contiguity that
 * does not exist. A trailing undersized run with nothing to merge into is
 * emitted as its own boundary marked `cacheable: false` — reported honestly as
 * uncacheable rather than padded, dropped, or silently attached backwards.
 *
 * BOUNDED. `maxSegments` caps the output so a caller-shaped range list cannot be
 * turned into an unbounded segmentation (`COMP_SEGMENT_LIMIT`).
 *
 * PURE. No clock, no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011). Runs identically with `MEGACOMPACT_VC7B` on or off — the flag
 * gates only the reporter/dashboard seam in `./economics-emit.ts`.
 */

import { createHash } from "node:crypto";

import { compareSpans, sortSpans, validateRanges } from "./crystal.js";
import type { CrystalKeyV1, DagSpan } from "./types.js";

/**
 * One compiled, provider-safe cache boundary: a contiguous run of covered ranges
 * within a SINGLE session that the provider may treat as one cacheable segment.
 */
export interface CrystalBoundaryV1 {
  readonly schema: "crystal-boundary-v1";
  /** The session these ranges belong to (a boundary never spans sessions). */
  readonly sessionId: string;
  /** The covered ranges in this segment, in canonical order. */
  readonly ranges: readonly DagSpan[];
  /** Total covered bytes in the segment. */
  readonly byteCount: number;
  /** Approximate token count used against `minPrefix` (see `tokensForBytes`). */
  readonly tokenCount: number;
  /**
   * Whether the provider can actually cache this segment: it meets `minPrefix`.
   * A `false` segment is still emitted and still rendered — it is simply priced
   * as uncached rather than pretended to be a hit.
   */
  readonly cacheable: boolean;
  /** `sha256:` digest over the segment's ranges — a segment-level content pin. */
  readonly digest: string;
}

/** Profile-derived limits the compiler must respect. */
export interface CompilerLimits {
  /** Minimum cacheable prefix in tokens (`ProviderEconomicsV1.minPrefix`). */
  readonly minPrefix: number;
  /** Maximum number of compiled segments. Bounds the output. */
  readonly maxSegments: number;
  /** Bytes per token used for the token estimate. Must be >= 1. */
  readonly bytesPerToken: number;
}

/** Conventional default limits (4 bytes/token is the usual English estimate). */
export const DEFAULT_COMPILER_LIMITS: CompilerLimits = {
  minPrefix: 1024,
  maxSegments: 64,
  bytesPerToken: 4,
};

/** VC7B compiler failure codes. */
export type CompilerFailureCode =
  /** The input ranges failed VC7A validation (empty/malformed/overlapping). */
  | "COMP_RANGE_INVALID"
  /** Compilation would exceed `maxSegments`. */
  | "COMP_SEGMENT_LIMIT"
  /** A limit is negative, fractional, or otherwise unusable. */
  | "COMP_LIMIT_INVALID"
  /** The compiled boundaries did not re-cover the input exactly (never expected). */
  | "COMP_IDENTITY_DRIFT";

/** The verdict of a compilation. */
export type CompileResult =
  | {
      readonly ok: true;
      readonly boundaries: readonly CrystalBoundaryV1[];
      /** Segments the provider can actually cache (`cacheable: true`). */
      readonly cacheableCount: number;
      /** Covered tokens sitting in cacheable segments. */
      readonly cacheableTokens: number;
    }
  | { readonly ok: false; readonly codes: readonly CompilerFailureCode[] };

/** Covered bytes of one range. */
function spanBytes(s: DagSpan): number {
  return s.endByte - s.startByte;
}

/**
 * Byte→token estimate. Deliberately a floor: under-estimating tokens can only
 * make the compiler MORE conservative about calling a segment cacheable, which
 * fails safe (a wrongly-cacheable segment would be priced as a hit it never got).
 */
export function tokensForBytes(bytes: number, bytesPerToken: number): number {
  return Math.floor(bytes / bytesPerToken);
}

/** `sha256:` digest over a segment's ranges — length-prefixed, so injective. */
function boundaryDigest(ranges: readonly DagSpan[]): string {
  const h = createHash("sha256");
  for (const s of ranges) {
    const parts = [
      s.sessionId,
      s.startSeq.toString(),
      s.endSeq.toString(),
      String(s.startByte),
      String(s.endByte),
      s.digest,
    ];
    for (const p of parts) h.update(`${Buffer.byteLength(p, "utf8")}:${p}`, "utf8");
  }
  return `sha256:${h.digest("hex")}`;
}

/** Build one boundary from a contiguous same-session run of ranges. */
function makeBoundary(
  ranges: readonly DagSpan[],
  limits: CompilerLimits,
): CrystalBoundaryV1 {
  const byteCount = ranges.reduce((n, s) => n + spanBytes(s), 0);
  const tokenCount = tokensForBytes(byteCount, limits.bytesPerToken);
  const first = ranges[0];
  return {
    schema: "crystal-boundary-v1",
    sessionId: first === undefined ? "" : first.sessionId,
    ranges,
    byteCount,
    tokenCount,
    cacheable: tokenCount >= limits.minPrefix,
    digest: boundaryDigest(ranges),
  };
}

function validLimits(l: CompilerLimits): boolean {
  return (
    Number.isSafeInteger(l.minPrefix) &&
    l.minPrefix >= 0 &&
    Number.isSafeInteger(l.maxSegments) &&
    l.maxSegments > 0 &&
    Number.isSafeInteger(l.bytesPerToken) &&
    l.bytesPerToken >= 1
  );
}

/**
 * Compile validated ranges into provider-safe cache boundaries.
 *
 * Ranges are first put in canonical order (the SAME `sortSpans` order the VC7A
 * key encoder uses — sharing the comparator is what keeps the two subsystems
 * from disagreeing about what "canonical" means). They are then grouped by
 * session, and within each session an undersized run is merged FORWARD until it
 * meets `minPrefix`.
 *
 * Identity is verified before returning: the flattened output must equal the
 * canonical input exactly. That check should never fire — it is a guard against
 * a future edit to the merge loop quietly reordering or dropping a range.
 */
export function compileCrystalBoundaries(
  ranges: readonly DagSpan[],
  limits: CompilerLimits = DEFAULT_COMPILER_LIMITS,
): CompileResult {
  if (!validLimits(limits)) return { ok: false, codes: ["COMP_LIMIT_INVALID"] };

  // Reuse VC7A's validator verbatim: the compiler must never accept a range set
  // the crystal key would reject, or the two would disagree about what is legal.
  const rangeCodes = validateRanges(ranges);
  if (rangeCodes.length > 0) return { ok: false, codes: ["COMP_RANGE_INVALID"] };

  const sorted = sortSpans(ranges);
  const boundaries: CrystalBoundaryV1[] = [];

  let run: DagSpan[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      boundaries.push(makeBoundary(run, limits));
      run = [];
    }
  };

  for (const span of sorted) {
    const head = run[0];
    // A session change always closes the run: a boundary never spans sessions,
    // because two sessions' byte streams are not contiguous with each other.
    if (head !== undefined && head.sessionId !== span.sessionId) flushRun();
    run.push(span);
    const bytes = run.reduce((n, s) => n + spanBytes(s), 0);
    // Close as soon as the run is independently cacheable; anything smaller keeps
    // absorbing the next range (merge-forward).
    if (tokensForBytes(bytes, limits.bytesPerToken) >= limits.minPrefix) flushRun();
  }
  // A trailing undersized run has nothing left to merge into: emit it honestly
  // as a non-cacheable boundary rather than padding or dropping it.
  flushRun();

  if (boundaries.length > limits.maxSegments) {
    return { ok: false, codes: ["COMP_SEGMENT_LIMIT"] };
  }
  if (!boundariesPreserveIdentity(sorted, boundaries)) {
    return { ok: false, codes: ["COMP_IDENTITY_DRIFT"] };
  }

  let cacheableCount = 0;
  let cacheableTokens = 0;
  for (const b of boundaries) {
    if (b.cacheable) {
      cacheableCount += 1;
      cacheableTokens += b.tokenCount;
    }
  }
  return { ok: true, boundaries, cacheableCount, cacheableTokens };
}

/**
 * The executable form of the sprint's headline invariant: flattening the
 * compiled boundaries must reproduce the canonical input ranges EXACTLY — same
 * ranges, same order, same pinned digests.
 *
 * Comparison is field-by-field on identity (session, seq bounds, byte bounds,
 * digest), never by count or by digest alone: a compiler bug that swapped two
 * equal-length ranges would keep the count and the byte total identical while
 * changing what the request means.
 */
export function boundariesPreserveIdentity(
  input: readonly DagSpan[],
  boundaries: readonly CrystalBoundaryV1[],
): boolean {
  const flat: DagSpan[] = [];
  for (const b of boundaries) flat.push(...b.ranges);
  const canonical = sortSpans(input);
  if (flat.length !== canonical.length) return false;
  for (let i = 0; i < flat.length; i += 1) {
    const a = flat[i];
    const b = canonical[i];
    if (a === undefined || b === undefined) return false;
    if (compareSpans(a, b) !== 0) return false;
    // compareSpans intentionally ignores the pinned digest (it orders by source
    // position). Identity includes the covered bytes, so check it explicitly.
    if (a.digest !== b.digest) return false;
  }
  return true;
}

/**
 * Compile the ranges of an existing crystal key. Returns the boundaries plus the
 * UNCHANGED key: compilation is an optimization of how the render is segmented,
 * never a re-keying. Returning the same key object makes that explicit at the
 * call site — a caller cannot accidentally pick up a "compiled key" that differs.
 */
export function compileForKey(
  key: CrystalKeyV1,
  limits: CompilerLimits = DEFAULT_COMPILER_LIMITS,
): { readonly key: CrystalKeyV1; readonly compiled: CompileResult } {
  return { key, compiled: compileCrystalBoundaries(key.sourceRanges, limits) };
}
