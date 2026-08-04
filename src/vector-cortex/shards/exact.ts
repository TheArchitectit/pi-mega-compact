/**
 * vector-cortex/shards/exact.ts — exact tier partition (VC4A).
 *
 * Carves the session's PROTECTED spans — every tool call/result pair, every
 * anchor, every invalid UTF-8 event — into `ExactShardV1` payloads of the
 * ORIGINAL bytes, verbatim and never normalized (SHD-UTF8-002: invalid bytes
 * are exact-only and preserved unchanged — the codec's strict-fatal classifier
 * means an invalid event has no lossy text to re-encode; we copy `originalBytes`
 * directly). Each protected span is ATOMIC: a tool call/result pair is one
 * `ProtectedSpan`, so no exact shard EVER splits a pair, even when the pair
 * straddles the target-size boundary (SHD-PAIR-001).
 *
 * The partition walks the protected spans in canonical stream order (ascending
 * first-seq), accrues each span's bytes, and closes an exact shard the moment
 * adding the next atomic span would exceed `targetSize`. A single span over the
 * budget still occupies exactly one shard — the pair case never splits.
 *
 * Triad: A = used with the semantic tier; B = the same exact spans preserved
 * alongside extractive-derived semantic content; C = exact anchors/current
 * transcript ONLY (this partition alone, with zero semantic shards).
 *
 * Pure/deterministic: hashes + array walking only, no storage, no console, no
 * network (PREVENT-PI-004 / PREVENT-011).
 */
import { createHash } from "node:crypto";
import type { EventV2 } from "../ledger/types.js";
import { cumulativeOffsets } from "./semantic.js";
import type { ExactPartitionInput, ExactPartitionResult, ExactShardCase, ExactShardV1, ProtectedSpan } from "./types.js";

/** Deterministic exact-shard digest over the verbatim original bytes. */
function sealExactDigest(sessionId: string, bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(`exact-shard-v1|${sessionId}|`);
  h.update(bytes);
  return `sha256:${h.digest("hex")}`;
}

/** Combine per-span cases into one shard case (invalid dominates, then tool-pair). */
function combineCase(span: ProtectedSpan, acc: ExactShardCase): ExactShardCase {
  if (span.case === "invalid-utf8" || acc === "invalid-utf8") return "invalid-utf8";
  if (span.case === "tool-pair" || acc === "tool-pair") return "tool-pair";
  return "anchor";
}

/** Concatenate an ordered group of events' original bytes, verbatim. */
function concatBytes(events: readonly EventV2[]): Uint8Array {
  let len = 0;
  for (const e of events) len += e.originalBytes.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const e of events) {
    out.set(e.originalBytes, off);
    off += e.originalBytes.length;
  }
  return out;
}

/**
 * Partition the exact tier (task 3). Returns `ok:true` with a list of
 * `ExactShardV1` whose (sorted) ranges are contiguous, non-overlapping and
 * jointly cover every protected span exactly once, each preserving the original
 * bytes verbatim. Defensive failures mirror the semantic tier: a bad target size
 * rejects with `SHD_INVALID_TARGET_SIZE`; a protected span referencing an event
 * outside the session's stream, or a mixed-session span, rejects with
 * `SHD_CROSS_SESSION`.
 */
export function partitionExact(input: ExactPartitionInput): ExactPartitionResult {
  const { sessionId, events, protectedSpans, targetSize } = input;
  if (!Number.isFinite(targetSize) || targetSize <= 0) {
    return { ok: false, code: "SHD_INVALID_TARGET_SIZE" };
  }
  const stream = new Set(events.map((e) => e.seq.toString()));
  for (const span of protectedSpans) {
    if (span.events.some((e) => e.sessionId !== sessionId || !stream.has(e.seq.toString()))) {
      return { ok: false, code: "SHD_CROSS_SESSION" };
    }
  }
  const offsets = cumulativeOffsets(events);
  if (protectedSpans.length === 0) return { ok: true, shards: [] };

  // Process protected spans in canonical stream order (ascending first-seq;
  // equal first-seq preserves input order for determinism).
  const ordered = [...protectedSpans].sort((a, b) => {
    const as = a.events.length ? a.events[0].seq : 0n;
    const bs = b.events.length ? b.events[0].seq : 0n;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });

  const shards: ExactShardV1[] = [];
  let batch: ProtectedSpan[] = [];
  let batchBytes = 0;
  let batchCase: ExactShardCase = "anchor";

  const spanBytes = (s: ProtectedSpan): number =>
    s.events.reduce((n, e) => n + e.originalBytes.length, 0);

  const flush = (): void => {
    if (batch.length === 0) return;
    const first = batch[0];
    const last = batch[batch.length - 1];
    const firstEv = first.events[0];
    const lastEv = last.events[last.events.length - 1];
    const start = offsets.of(firstEv.seq);
    const end = offsets.of(lastEv.seq);
    const byteStart = start ? start.byteStart : 0;
    const byteEnd = end ? end.byteEnd : byteStart;
    const bytes = concatBytes(batch.flatMap((s) => s.events));
    shards.push({
      schema: "exact-shard-v1",
      sessionId,
      range: {
        sessionId,
        seqStart: firstEv.seq,
        seqEnd: lastEv.seq,
        byteStart,
        byteEnd,
      },
      kind: "exact",
      originalBytes: bytes,
      digest: sealExactDigest(sessionId, bytes),
      byteCount: batchBytes,
      case: batchCase,
    });
    batch = [];
    batchBytes = 0;
    batchCase = "anchor";
  };

  for (const span of ordered) {
    const sz = spanBytes(span);
    // Close at a complete-span boundary when adding this atomic span would
    // exceed the budget and we already hold at least one complete span.
    if (batch.length > 0 && batchBytes + sz > targetSize) flush();
    batch.push(span);
    batchBytes += sz;
    batchCase = combineCase(span, batchCase);
  }
  flush();

  return { ok: true, shards };
}
