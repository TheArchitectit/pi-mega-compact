/**
 * vector-cortex/heal/restore-types.ts — VC6B exact source restoration contract.
 *
 * VC6A optimized WHICH EDGES the closure plan walks. VC6B answers the next
 * question: when the plan needs a node whose bytes are no longer in the live
 * window, WHERE do those bytes come from? The answer is deliberately narrow —
 * an EXACT source, or nothing.
 *
 * THE CARDINAL RULE. Restored bytes are ONLY ever read from an exact source:
 *   1. an `ExactShardV1` whose range and digest both match the request, or
 *   2. a scan of the `EventV2` occurrence ledger over the requested seq range.
 * Bytes are NEVER inferred from an embedding, a semantic shard, a RAPTOR
 * summary, or any other derived/lossy representation. A semantic tier can tell
 * you what a span was ABOUT; it cannot tell you what the span WAS. Attempting to
 * "restore" from a derived source would silently fabricate transcript history,
 * so VC6B has no code path that can do it: `RestoreReader` exposes exactly the
 * two exact sources and nothing else.
 *
 * THE VERIFICATION RULE. Every restored span must hash to the SHA-256 digest the
 * REQUEST pinned, checked immediately before insertion. A source that matches by
 * range but not by hash is rejected (`HEAL_RESTORE_DIGEST_MISMATCH`) — never
 * "close enough". This is what makes a swapped shard file, a truncated read, or a
 * corrupted ledger record fail loudly instead of poisoning the reconstruction.
 *
 * DIGEST PINNING (three fields exist; do not confuse them).
 *   - `ReconstructionSpan.digest` and `ExactShardV1.digest` are SHA-256 in
 *     LOWERCASE HEX with NO prefix.
 *   - `EventV2.bytesDigest` is `sha256:<hex>`, WITH the prefix.
 * `RestoreSpanRequest.digest` works at SPAN level and uses the FORMER: bare
 * lowercase hex, matching `ExactShardV1.digest` / `ReconstructionSpan.digest`.
 * The prefixed `EventV2.bytesDigest` is used ONLY for per-event verification
 * inside the ledger-scan path and is never the request-level digest. Mixing the
 * two would make every ledger restoration fail (or, worse, make a prefix-stripped
 * comparison accidentally succeed against the wrong granularity).
 *
 * BOUNDS. A restore request is attacker-shaped input: it names spans and byte
 * ranges. `RESTORE_LIMIT_SPANS` / `RESTORE_LIMIT_BYTES` bound it BEFORE any
 * reader is consulted, so an oversized request cannot be used to make the
 * restorer walk the whole ledger (HEAL-LIMIT-002).
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import type { ExactShardV1, ShardRange } from "../shards/types.js";
import type { EventV2 } from "../ledger/types.js";

/**
 * One requested span: the node it restores, the byte/seq window that IDENTIFIES
 * it, and the digest that AUTHENTICATES it.
 *
 * `range` is identity — it says which slice of the canonical stream to look for.
 * `digest` is authentication — it says which bytes are acceptable. Both are
 * required: identity alone would accept a shard file that was swapped in place,
 * and a digest alone would require scanning every source.
 */
export interface RestoreSpanRequest {
  /** The closure node these bytes belong to (echoed back in the result). */
  readonly nodeId: string;
  /** The span's identity: session + inclusive seq bounds + half-open bytes. */
  readonly range: ShardRange;
  /**
   * SHA-256 of the span's original bytes, LOWERCASE HEX, NO `sha256:` prefix
   * (matches `ExactShardV1.digest` / `ReconstructionSpan.digest`).
   */
  readonly digest: string;
}

/** A batch of span restorations for one session. */
export interface RestoreRequestV1 {
  readonly schema: "restore-request-v1";
  readonly sessionId: string;
  /** Requested spans, restored in this order (the result preserves it). */
  readonly spans: readonly RestoreSpanRequest[];
}

/**
 * One successfully restored span. `source` records WHICH exact tier answered so
 * the triad mode can be derived and so an operator can see whether the shard
 * index is doing its job or every read is falling through to a ledger scan.
 */
export interface RestoreSpanResult {
  readonly nodeId: string;
  /** Which exact source produced the bytes (never a derived/semantic tier). */
  readonly source: "exact-shard" | "ledger-scan";
  /** The EXACT original bytes, verbatim — invalid UTF-8 included, unnormalized. */
  readonly bytes: Uint8Array;
  /** The verified SHA-256 (bare lowercase hex) — equals the request's digest. */
  readonly digest: string;
}

/**
 * The restoration outcome for one request.
 *
 * `mode` mirrors TRIAD_RESILIENCE:
 *   A — every span came from an indexed exact shard (the fast, normal path);
 *   B — every span was restored, but at least one required a ledger range scan
 *       (an INDEPENDENT code path: no shard index involved, bytes rebuilt by
 *       concatenating verified occurrence records);
 *   C — at least one span could not be restored from ANY exact source. Mode C
 *       OMITS the span and DISCLOSES the loss (`semanticLossStated`) rather than
 *       substituting derived text.
 */
export interface RestoreResultV1 {
  readonly schema: "restore-result-v1";
  readonly sessionId: string;
  readonly mode: "A" | "B" | "C";
  /** Restored spans in request order (only digest-verified spans appear here). */
  readonly restored: readonly RestoreSpanResult[];
  /** Node ids that could not be restored (identity only — never bytes). */
  readonly missing: readonly string[];
  /** Set in mode C: the caller MUST be told the old context is gone. */
  readonly semanticLossStated: boolean;
  /** Deduplicated failure codes in deterministic order. */
  readonly codes: readonly RestoreFailureCode[];
}

/** VC6B failure codes (registered HEAL codes). */
export type RestoreFailureCode =
  /** The request exceeds the span-count or aggregate-byte bound. */
  | "HEAL_RESTORE_LIMIT"
  /** A source's bytes do not hash to the pinned digest — nothing is inserted. */
  | "HEAL_RESTORE_DIGEST_MISMATCH"
  /** Neither an exact shard nor the ledger covers the requested span. */
  | "HEAL_RESTORE_SOURCE_MISSING"
  /** A restored span does not correspond to a requested span/digest. */
  | "HEAL_RESTORE_RANGE_MISMATCH";

/**
 * Post-restoration verdict. `verifyRestored` re-derives every digest from the
 * bytes actually carried in the result, so a result object that was mutated
 * after `restoreSources` returned still fails before insertion.
 */
export type RestoreVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly codes: readonly RestoreFailureCode[] };

/**
 * The ONLY sources a restoration may read. Deliberately exhaustive: there is no
 * embedding, semantic shard, or summary field here, so "restore from a derived
 * source" is not merely forbidden by policy — it is unrepresentable.
 */
export interface RestoreReader {
  /** Indexed exact shards (mode A). */
  readonly exactShards: readonly ExactShardV1[];
  /** Raw occurrence records for the ledger range scan (mode B). */
  readonly ledgerEvents: readonly EventV2[];
}

/**
 * Maximum spans in one request. A request naming more spans than this is
 * rejected outright — the bound exists so a single call cannot be turned into an
 * unbounded traversal of the ledger.
 */
export const RESTORE_LIMIT_SPANS = 64;

/**
 * Maximum aggregate requested bytes (4 MiB), summed from the REQUEST's ranges
 * (`byteEnd - byteStart`) so the bound is enforceable without reading anything.
 */
export const RESTORE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Registered VC6B conformance ID range (HEAL-016..030), continuing VC6A's
 * HEAL-001..015. The acceptance test reads these rows from the v2 manifest and
 * asserts each returns its manifest `ok`/`code`.
 */
export const RESTORE_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `HEAL-${String(i + 16).padStart(3, "0")}`,
);

/** Named VC6B conformance assertions (the sprint's headline rows). */
export const RESTORE_NAMED_IDS = [
  "HEAL-SPAN-001",
  "HEAL-LIMIT-002",
  "HEAL-DIGEST-003",
] as const;

/** The two structured events the VC6B reporter emits. */
export type RestoreEventName =
  | "vector_cortex_source_restored"
  | "vector_cortex_restore_digest_rejected";

export type { EventV2, ExactShardV1, ShardRange };
