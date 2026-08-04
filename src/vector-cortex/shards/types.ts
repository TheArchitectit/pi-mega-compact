/**
 * vector-cortex/shards/types.ts — dual-tier shard contract (VC4A).
 *
 * Owns `SemanticShardV1` / `ExactShardV1` / `ShardManifestV1` — the shared
 * partition contract of the sprint failure triad:
 *
 *   A = semantic + exact shards (normal path);
 *   B = extractive + exact shards with the semantic encoder disabled;
 *   C = exact anchors/current transcript only.
 *
 * A session's canonical byte stream is partitioned ONLY at complete EventV2
 * record boundaries (VC1A byte authority — an EventV2's `originalBytes` + its
 * SHA-256 `bytesDigest` are authoritative, invalid UTF-8 is never normalized).
 * A `ShardRange` names a contiguous run of complete records by inclusive
 * seq `[seqStart..seqEnd]` and by the half-open source byte range
 * `[byteStart, byteEnd)` they occupy in canonical stream order (record `seq`
 * carries every byte from `offset(seq)` to `offset(seq)+len(seq)`).
 *
 * Semantic shards carry derived aggregate vectors/token estimates and NEVER
 * reproduce exact text (the RESIDUAL_CODEC / exact-payload shards own exact
 * bytes). Exact shards carry the EXACT original bytes, unchanged, for the
 * protected spans: every tool call/result pair, every anchor, and every invalid
 * UTF-8 event (SHD-UTF8-002 — invalid bytes are exact-only and never
 * normalized/re-encoded). A tool call/result pair that straddles a target-size
 * boundary stays in ONE exact shard (SHD-PAIR-001).
 *
 * Consumes only reviewer-accepted predecessor contracts (VC1A EventV2) and the
 * [common contracts](../../../../docs/vector-cortex/CONTRACTS.md). Pure
 * types/schema + small predicates: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011). The acceptance contract and the conformance
 * IDs (SHD-001..020 + named SHD-PAIR-001 / SHD-UTF8-002 / SHD-RANGE-003) live
 * here.
 */

import type { EventV2 } from "../ledger/types.js";

/**
 * A contiguous covered byte+seq window over ONE session's canonical EventV2
 * stream. `seqStart`/`seqEnd` are inclusive record sequence bounds; `byteStart`/
 * `byteEnd` are half-open byte offsets in canonical stream order. Every recorded
 * boundary is a COMPLETE EventV2 record boundary — a shard never splits a record
 * or a tool call/result pair.
 */
export interface ShardRange {
  readonly sessionId: string;
  readonly seqStart: bigint;
  readonly seqEnd: bigint;
  readonly byteStart: number;
  readonly byteEnd: number;
}

/** What an exact shard protects (why its bytes must survive verbatim). */
export type ExactShardCase =
  | "tool-pair"
  | "anchor"
  | "invalid-utf8"
  | "anchor+invalid";

/**
 * A semantic shard — a deterministic partition of complete, valid EventV2
 * records into sub-target-size chunks. It carries DERIVED aggregate content
 * (head vectors + token estimate + a deterministic content digest) and
 * explicitly not the raw record bytes; exact restoration of those bytes is the
 * exact tier's job (RESIDUAL_CODEC / exact payload shards).
 */
export interface SemanticShardV1 {
  readonly schema: "semantic-shard-v1";
  readonly sessionId: string;
  /** Source metadata: which complete records and byte span this shard covers. */
  readonly range: ShardRange;
  readonly kind: "semantic";
  /** Deterministic SHA-256 over the shard's derived payload bytes. */
  readonly digest: string;
  /** Sum of the covered records' original byte lengths. */
  readonly byteCount: number;
  /** Number of complete events covered. */
  readonly eventCount: number;
  /** Deterministic token estimate for the covered text (aggregate). */
  readonly tokenEstimate: number;
}

/**
 * An exact shard — the ORIGINAL bytes of a protected span, preserved verbatim
 * including invalid UTF-8 (never normalized/re-encoded). `originalBytes` is the
 * concatenation, in seq order, of every covered record's `originalBytes`; the
 * byte range equals that concatenation exactly. `case` records why the span is
 * protected. No semantic loss is ever claimed for exact bytes.
 */
export interface ExactShardV1 {
  readonly schema: "exact-shard-v1";
  readonly sessionId: string;
  readonly range: ShardRange;
  readonly kind: "exact";
  /** Exact original bytes, unchanged (authoritative). */
  readonly originalBytes: Uint8Array;
  /** SHA-256 of `originalBytes`. */
  readonly digest: string;
  readonly byteCount: number;
  readonly case: ExactShardCase;
}

/**
 * The assembled shard manifest. `changes` mirror the sprint failure triad:
 *   A / B — semantic + exact tiers both present (B may derive the semantic tier
 *           from extractive heads when the semantic encoder is disabled);
 *   C     — exact anchors/current transcript ONLY (zero semantic shards).
 * `generationDigest` is ONE deterministic SHA-256 over the canonical
 * serialization of every shard's range + kind + digest. `protectedSpans`
 * enumerate every span that must exist as exact bytes; the validator requires
 * the exact shards to cover them exactly once (no gap, no overlap).
 */
export interface ShardManifestV1 {
  readonly schema: "shard-manifest-v1";
  readonly sessionId: string;
  /** Contiguous durable authority high-water the manifest is built AT. */
  readonly sourceHighWater: bigint;
  readonly semantic: readonly SemanticShardV1[];
  readonly exact: readonly ExactShardV1[];
  /** Deterministic manifest digest (order-independent over the shard set). */
  readonly generationDigest: string;
  /** The protected spans that must be exactly covered (tools/anchors/invalid). */
  readonly protectedSpans: readonly ShardRange[];
  /** Sum of every semantic + exact shard's covered bytes. */
  readonly byteTotal: number;
  /** Total number of shards (semantic + exact). */
  readonly shardCount: number;
}

/** Input to a semantic partition: the sorted events + a target max byte size. */
export interface SemanticPartitionInput {
  readonly sessionId: string;
  /** Complete EventV2 records in ascending seq order (source of truth). */
  readonly events: readonly EventV2[];
  /** Per-shard byte budget; a single over-budget record gets its own shard. */
  readonly targetSize: number;
}

/** Result of partitioning the semantic tier (A/B). */
export type SemanticPartitionResult =
  | { ok: true; shards: readonly SemanticShardV1[] }
  | { ok: false; code: string };

/** One protected input span to carve into exact shards. */
export interface ProtectedSpan {
  /** The events to preserve verbatim, in ascending seq order. */
  readonly events: readonly EventV2[];
  /** Why this span is protected (used for the exact shard `case`). */
  readonly case: ExactShardCase;
}

/**
 * Input to an exact partition. `events` is the FULL canonical session stream
 * (used to derive the true stream byte offsets); `protectedSpans` are the atomic
 * groups to preserve verbatim (a tool call+result pair is ONE span so it can
 * never be split across exact shards — SHD-PAIR-001); `targetSize` is the
 * per-shard byte budget (a single over-budget pair still occupies one shard).
 */
export interface ExactPartitionInput {
  readonly sessionId: string;
  readonly events: readonly EventV2[];
  readonly protectedSpans: readonly ProtectedSpan[];
  readonly targetSize: number;
}

/** Result of partitioning the exact tier. */
export type ExactPartitionResult =
  | { ok: true; shards: readonly ExactShardV1[] }
  | { ok: false; code: string };

/** Manifest validation failure codes. */
export type ShardManifestFailureCode = "SHD_RANGE_OVERLAP" | "SHD_PROTECTED_GAP";

/** Validation of a manifest vs the pairwise-disjoint + protected-span rules. */
export type ShardManifestValidation =
  | { ok: true }
  | { ok: false; code: ShardManifestFailureCode };

/** The two structured events the VC4A reporter emits. */
export type ShardEventName =
  | "vector_cortex_shard_manifest_built"
  | "vector_cortex_protected_span_rejected";

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type ShardEmitter = (event: ShardEventName, fields: Record<string, unknown>) => void;

/** Typed, best-effort reporter bound to the two shard event names. */
export interface ShardReporter {
  readonly manifestBuilt: (fields: Record<string, unknown>) => void;
  readonly protectedSpanRejected: (fields: Record<string, unknown>) => void;
}

/**
 * Registered SHD conformance ID range (SHD-001..020). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`. The named assertions (SHD-PAIR-001 / SHD-UTF8-002 /
 * SHD-RANGE-003) live in the acceptance test.
 */
export const SHD_IDS = [
  "SHD-001", "SHD-002", "SHD-003", "SHD-004", "SHD-005",
  "SHD-006", "SHD-007", "SHD-008", "SHD-009", "SHD-010",
  "SHD-011", "SHD-012", "SHD-013", "SHD-014", "SHD-015",
  "SHD-016", "SHD-017", "SHD-018", "SHD-019", "SHD-020",
] as const;

/** Named SHD conformance assertions. */
export const SHD_NAMED_IDS = [
  "SHD-PAIR-001",
  "SHD-UTF8-002",
  "SHD-RANGE-003",
] as const;

export type { EventV2 };
