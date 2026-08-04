/**
 * vector-cortex/shards/semantic.ts — semantic tier partition (VC4A, mode A/B).
 *
 * Partitions a session's canonical EventV2 stream into `SemanticShardV1`
 * chunks, cutting ONLY at complete record boundaries. Every shard's `range`
 * names the exact inclusive seq span and the half-open source byte window it
 * covers in canonical stream order; a shard NEVER splits a record (or a tool
 * call/result pair). Semantic shards carry DERIVED aggregate content (a
 * deterministic digest + token estimate + byte/event counts) and never
 * reproduce exact text — exact bytes are the exact tier's job.
 *
 * The partition is deterministic and size-bounded: it walks the sorted events,
 * accrues each record's bytes, and closes a shard the moment adding the next
 * complete record would exceed `targetSize`. A single record that is already
 * over the budget gets its own shard (a shard is always at least one complete
 * record, so over-budget records are never split).
 *
 * Triad: A = this semantic tier plus exact shards; B = the same range shape
 * derived from extractive heads with the semantic encoder disabled (the caller
 * may substitute the derived payload, since the range+digest contract is
 * identical); C = exact anchors/current transcript only (no semantic shards at
 * all, handled by the exact tier alone).
 *
 * Pure/deterministic: hashes + array walking only, no storage, no console, no
 * network (PREVENT-PI-004 / PREVENT-011).
 */
import { createHash } from "node:crypto";
import type { EventV2 } from "../ledger/types.js";
import type { SemanticPartitionInput, SemanticPartitionResult, SemanticShardV1 } from "./types.js";

/** A full-stream byte offset map: cumulative end offset per ascending seq. */
export interface ByteOffsets {
  /** For an EventV2 at `seq`, its half-open [byteStart, byteEnd) in stream order. */
  readonly of: (seq: bigint) => { byteStart: number; byteEnd: number } | undefined;
  /** Total canonical stream length (sum of every record's bytes). */
  readonly total: number;
}

/**
 * Compute the canonical per-record byte offsets for a session's sorted events.
 * Events are sorted by seq (ascending) defensively; the byte stream is the
 * concatenation of each event's `originalBytes` in that order. A shared pure
 * helper so semantic + exact tiers agree on source ranges (the two partitioning
 * algorithms remain otherwise independent). Returns `undefined`-guarding lookup
 * plus the total length; empty input yields an empty map with total 0.
 */
export function cumulativeOffsets(events: readonly EventV2[]): ByteOffsets {
  const map = new Map<string, { byteStart: number; byteEnd: number }>();
  let off = 0;
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  for (const e of sorted) {
    const len = e.originalBytes.length;
    map.set(e.seq.toString(), { byteStart: off, byteEnd: off + len });
    off += len;
  }
  return {
    of: (seq: bigint) => map.get(seq.toString()),
    total: off,
  };
}

/** Approximate token count for a valid UTF-8 text (whitespace-separated runs). */
function approxTokens(text: string): number {
  if (text.length === 0) return 0;
  const runs = text.match(/\S+/g);
  return runs ? runs.length : 0;
}

/** Deterministic SHARD digest over a semantic shard's derived payload. */
function sealedSemanticDigest(
  sessionId: string,
  events: readonly EventV2[],
  range: { byteStart: number; byteEnd: number; seqStart: bigint; seqEnd: bigint },
  tokenEstimate: number,
): string {
  const h = createHash("sha256");
  h.update(`semantic-shard-v1|${sessionId}|`);
  h.update(`${range.seqStart.toString()}|${range.seqEnd.toString()}|`);
  h.update(`${range.byteStart}|${range.byteEnd}|`);
  h.update(`${tokenEstimate}|`);
  // One `~`-joined run of the covered records' authoritative byte digests in
  // seq order, so the shard digest depends on exactly which records it covers.
  for (const e of [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
    h.update(`${e.seq.toString()}:${e.bytesDigest}~`);
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * Partition the semantic tier (task 2). Returns `ok:true` with a list of
 * `SemanticShardV1` whose (sorted) ranges are contiguous, non-overlapping and
 * jointly cover every event exactly once. Failures are defensive: a non-positive
 * or non-finite `targetSize` rejects with `SHD_INVALID_TARGET_SIZE`; mixed-session
 * events reject with `SHD_CROSS_SESSION`.
 */
export function partitionSemantic(input: SemanticPartitionInput): SemanticPartitionResult {
  const { sessionId, events, targetSize } = input;
  if (!Number.isFinite(targetSize) || targetSize <= 0) {
    return { ok: false, code: "SHD_INVALID_TARGET_SIZE" };
  }
  if (events.some((e) => e.sessionId !== sessionId)) {
    return { ok: false, code: "SHD_CROSS_SESSION" };
  }
  const offsets = cumulativeOffsets(events);
  const sorted = [...events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  if (sorted.length === 0) return { ok: true, shards: [] };

  const shards: SemanticShardV1[] = [];
  let batch: EventV2[] = [];
  let batchBytes = 0;
  let batchTokens = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const first = batch[0];
    const last = batch[batch.length - 1];
    const start = offsets.of(first.seq);
    const end = offsets.of(last.seq);
    const byteStart = start ? start.byteStart : 0;
    const byteEnd = end ? end.byteEnd : byteStart;
    const tokenEstimate = batchTokens;
    shards.push({
      schema: "semantic-shard-v1",
      sessionId,
      range: {
        sessionId,
        seqStart: first.seq,
        seqEnd: last.seq,
        byteStart,
        byteEnd,
      },
      kind: "semantic",
      digest: sealedSemanticDigest(sessionId, batch, { seqStart: first.seq, seqEnd: last.seq, byteStart, byteEnd }, tokenEstimate),
      byteCount: batchBytes,
      eventCount: batch.length,
      tokenEstimate,
    });
    batch = [];
    batchBytes = 0;
    batchTokens = 0;
  };

  for (const e of sorted) {
    const len = e.originalBytes.length;
    const tokens = e.utf8.valid ? approxTokens(e.utf8.text) : Math.ceil(len / 4);
    // A batch that already has a complete record and would exceed the budget
    // (and the next record itself fits, or it doesn't) closes at a boundary.
    if (batch.length > 0 && batchBytes + len > targetSize) flush();
    batch.push(e);
    batchBytes += len;
    batchTokens += tokens;
  }
  flush();

  return { ok: true, shards };
}
