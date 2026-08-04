/**
 * vector-cortex/shards/manifest.ts — shard manifest assembly + validation (VC4A).
 *
 * Owns `assembleShardManifest` (the deterministic build) and
 * `validateShardManifest` (task 4). The builder takes the already-partitioned
 * semantic + exact tiers plus the protected spans and emits a `ShardManifestV1`
 * whose ranges are disjoint and sorted by `(seqStart, byteStart)`. The validator
 * enforces the two structural rules the sprint acceptance pins:
 *
 *   - SHD_RANGE_OVERLAP — any two manifest shard ranges (semantic or exact)
 *     overlap in the session byte stream;
 *   - SHD_PROTECTED_GAP  — the exact shards do not cover every protected byte
 *     exactly once (a protected span is unterminated by an exact shard, or an
 *     exact shard covers a byte no protected span claims).
 *
 * Emits `vector_cortex_shard_manifest_built` on a successful assembly and
 * `vector_cortex_protected_span_rejected` when validation fails, via the same
 * flag-gated reporter pattern VC3A/VC3B/VC3C use (`MEGACOMPACT_VC4A=0` emits
 * nothing — byte-identical predecessor).
 *
 * Pure/deterministic: hashes + range math only, no storage, no console, no
 * network (PREVENT-PI-004 / PREVENT-011).
 */
import { createHash } from "node:crypto";
import { VC4A_ENABLED } from "../../config/vector-cortex.js";
import type {
  ExactShardV1,
  SemanticShardV1,
  ShardEmitter,
  ShardManifestFailureCode,
  ShardManifestV1,
  ShardManifestValidation,
  ShardRange,
  ShardReporter,
} from "./types.js";

/** A bare byte interval (used for the range math below). */
interface Interval {
  readonly start: number;
  readonly end: number;
}

/** A manifest shard's range, normalized for sorting / digest purposes. */
function rangeKey(r: ShardRange): string {
  return `${r.seqStart.toString()},${r.byteStart}`;
}

/**
 * Merge byte intervals into disjoint, sorted intervals (half-open). Overlapping
 * AND touching intervals merge into one — this produces the "union" used for
 * coverage math, never used to hide an overlap (overlap is checked separately in
 * `hasOverlap` before any merging).
 */
function mergeIntervals(ranges: readonly ShardRange[]): Interval[] {
  const sorted = [...ranges]
    .map((r) => ({ start: r.byteStart, end: r.byteEnd }))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && iv.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, iv.end) };
      continue;
    }
    out.push(iv);
  }
  return out;
}

/** Difference: the bytes of `base` intervals NOT covered by `cover` intervals. */
function subtractCover(base: Interval[], cover: Interval[]): Interval[] {
  const ordered = cover
    .slice()
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const gaps: Interval[] = [];
  for (const iv of base) {
    let cursor = iv.start;
    for (const c of ordered) {
      if (c.end <= cursor) continue;
      if (c.start > cursor) {
        gaps.push({ start: cursor, end: Math.min(c.start, iv.end) });
        if (c.start >= iv.end) break;
      }
      cursor = Math.max(cursor, c.end);
      if (cursor >= iv.end) break;
    }
    if (cursor < iv.end) gaps.push({ start: cursor, end: iv.end });
  }
  return gaps;
}

/** True when any two ranges overlap (share at least one byte). */
function hasOverlap(ranges: readonly ShardRange[]): boolean {
  const sorted = [...ranges].sort((a, b) => (a.byteStart !== b.byteStart ? a.byteStart - b.byteStart : a.byteEnd - b.byteEnd));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.byteStart < prev.byteEnd) return true;
  }
  return false;
}

/**
 * Validate a manifest (task 4). Disjointness is a PER-TIER property: semantic
 * shard ranges must be pairwise disjoint among themselves, and exact shard
 * ranges pairwise disjoint among themselves (else `SHD_RANGE_OVERLAP`). The two
 * tiers are NOT disjoint from each other — exact shards are a verbatim SUBSET of
 * the semantic stream's bytes (a protected tool-pair's bytes are part of the
 * semantic content), so a semantic range and an exact range overlapping is
 * expected and correct. The cross-tier property is complete protected-span
 * coverage: the exact shards must tile every protected span byte exactly once,
 * no gap and no extra coverage (else `SHD_PROTECTED_GAP`). A manifest missing
 * protected spans is malformed (`SHD_PROTECTED_GAP`). `generationDigest` is NOT
 * verified here (it is a deterministic projection; the caller verifies it
 * against the rebuilt digest).
 */
export function validateShardManifest(manifest: ShardManifestV1): ShardManifestValidation {
  // Disjointness is enforced within each tier separately. An exact shard sitting
  // inside a semantic shard is legitimate (exact ⊂ semantic).
  if (hasOverlap(manifest.semantic.map((s) => s.range))) {
    return { ok: false, code: "SHD_RANGE_OVERLAP" };
  }
  if (hasOverlap(manifest.exact.map((s) => s.range))) {
    return { ok: false, code: "SHD_RANGE_OVERLAP" };
  }

  const protectedUnion = mergeIntervals(manifest.protectedSpans);
  const exactUnion = mergeIntervals(manifest.exact.map((s) => s.range));

  // Every protected byte must be covered by at least one exact shard (no gap),
  // and no exact byte may fall outside the protected union (no extra coverage).
  const gaps = subtractCover(protectedUnion, exactUnion);
  const extras = subtractCover(exactUnion, protectedUnion);
  if (gaps.length > 0 || extras.length > 0) {
    return { ok: false, code: "SHD_PROTECTED_GAP" };
  }
  return { ok: true };
}

/**
 * Deterministic manifest digest over a shard set — order-independent because it
 * hashes the shards sorted by `(kind, seqStart, byteStart, digest)` (never input
 * order). One SHA-256 over the canonical parts; the caller compares it against
 * the stored `generationDigest`.
 */
export function shardManifestDigest(
  sessionId: string,
  sourceHighWater: bigint,
  semantic: readonly { range: ShardRange; digest: string }[],
  exact: readonly { range: ShardRange; digest: string }[],
): string {
  const rows: Array<[string, ShardRange, string]> = [
    ...semantic.map((s) => ["semantic", s.range, s.digest] as [string, ShardRange, string]),
    ...exact.map((s) => ["exact", s.range, s.digest] as [string, ShardRange, string]),
  ].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    const rk = rangeKey(a[1]);
    const rk2 = rangeKey(b[1]);
    return rk !== rk2 ? (rk < rk2 ? -1 : 1) : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
  });
  const h = createHash("sha256");
  h.update(`shard-manifest-v1|${sessionId}|${sourceHighWater.toString()}|`);
  for (const [kind, r, digest] of rows) {
    h.update(`${kind}|${r.seqStart.toString()}|${r.seqEnd.toString()}|${r.byteStart}|${r.byteEnd}|${digest}~`);
  }
  return `sha256:${h.digest("hex")}`;
}

/** Inputs to assemble a manifest. */
export interface AssembleManifestInput {
  readonly sessionId: string;
  readonly sourceHighWater: bigint;
  readonly semantic: readonly SemanticShardV1[];
  readonly exact: readonly ExactShardV1[];
  readonly protectedSpans: readonly ShardRange[];
}

/**
 * Assemble a `ShardManifestV1` from already-partitioned tiers (deterministic).
 * Shards are sorted by `(seqStart, byteStart)`; `generationDigest`, `byteTotal`
 * and `shardCount` are computed from the sorted set. The caller typically runs
 * this through `assembleAndValidate` so the structural rules are enforced too.
 */
export function buildShardManifest(input: AssembleManifestInput): ShardManifestV1 {
  const cmp = (a: SemanticShardV1 | ExactShardV1, b: SemanticShardV1 | ExactShardV1): number => {
    if (a.range.seqStart !== b.range.seqStart) {
      return a.range.seqStart < b.range.seqStart ? -1 : 1;
    }
    return a.range.byteStart !== b.range.byteStart
      ? a.range.byteStart < b.range.byteStart ? -1 : 1
      : 0;
  };
  const semantic = [...input.semantic].sort(cmp);
  const exact = [...input.exact].sort(cmp);
  const byteTotal =
    semantic.reduce((n, s) => n + s.byteCount, 0) +
    exact.reduce((n, s) => n + s.byteCount, 0);
  const generationDigest = shardManifestDigest(input.sessionId, input.sourceHighWater, semantic, exact);
  return {
    schema: "shard-manifest-v1",
    sessionId: input.sessionId,
    sourceHighWater: input.sourceHighWater,
    semantic,
    exact,
    protectedSpans: [...input.protectedSpans],
    byteTotal,
    shardCount: semantic.length + exact.length,
    generationDigest,
  };
}

/**
 * Assembly + validation seam (task 5). Builds the manifest, validates it, and
 * emits `vector_cortex_shard_manifest_built` on success or
 * `vector_cortex_protected_span_rejected` on failure (flag-gated). Non-fatal:
 * a validation failure returns `{ok:false, code}` and NEVER throws into the host.
 */
export function assembleAndValidate(
  input: AssembleManifestInput,
  emit?: ShardEmitter,
): { ok: true; manifest: ShardManifestV1 } | { ok: false; code: ShardManifestFailureCode } {
  const manifest = buildShardManifest(input);
  const validation = validateShardManifest(manifest);
  const reporter = createShardReporter(emit);
  if (!validation.ok) {
    reporter.protectedSpanRejected({
      sessionId: input.sessionId,
      code: validation.code,
    });
    return { ok: false, code: validation.code };
  }
  reporter.manifestBuilt({
    sessionId: input.sessionId,
    sourceHighWater: input.sourceHighWater.toString(),
    shardCount: manifest.shardCount,
    byteTotal: manifest.byteTotal,
    generationDigest: manifest.generationDigest,
  });
  return { ok: true, manifest };
}

/**
 * Whether each tier's ranges are internally sorted by (seqStart, byteStart).
 * The two tiers are NOT globally ordered against each other (exact shards are a
 * subset of the semantic stream, so an exact range always sits inside some
 * semantic range); the guarantee the builder provides is per-tier ordering.
 */
export function manifestSorted(m: ShardManifestV1): boolean {
  const key = (r: ShardRange): string => `${r.seqStart.toString()},${r.byteStart}`;
  const sorted = (rows: readonly { range: ShardRange }[]): boolean =>
    rows.every((r, i) => i === 0 || key(rows[i - 1]!.range) <= key(r.range));
  return sorted(m.semantic) && sorted(m.exact);
}

/** Build the flag-gated typed reporter (mirrors ledger/topology reporters). */
function createShardReporter(emit?: ShardEmitter): ShardReporter {
  const fire = (event: Parameters<ShardEmitter>[0], fields: Record<string, unknown>): void => {
    if (!VC4A_ENABLED()) return;
    if (!emit) return;
    try {
      emit(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };
  return {
    manifestBuilt(fields) {
      fire("vector_cortex_shard_manifest_built", fields);
    },
    protectedSpanRejected(fields) {
      fire("vector_cortex_protected_span_rejected", fields);
    },
  };
}

export { createShardReporter };
