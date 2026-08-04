/**
 * vector-cortex/cortex/types.ts — capability-gated cortex store contract (VC3A).
 *
 * Owns `CortexReader` / `CortexWriter` / `CortexAdmin` and `CortexRecordV1`
 * (the immutable derived record). Consumes only reviewer-accepted predecessor
 * contracts and [common contracts](../../CONTRACTS.md §Store and migration
 * contracts), which are NORMATIVE here: the derived frontier cannot exceed the
 * contiguous durable authority high-water and cannot advance during
 * authority/spool outage.
 *
 * A CortexRecordV1 is a DERIVED record keyed by
 * `(sourceHighWater, algorithmVersion, id)`. The same `id` at a different
 * `algorithmVersion` (or a different `sourceHighWater`) is a DISTINCT record —
 * never collapsed (CTX-KEY-002). Records are immutable: re-appending an exact
 * `(sourceHighWater, algorithmVersion, id)` with the SAME `payloadDigest` is an
 * idempotent acknowledge; the same key with a DIFFERENT digest is a conflict.
 *
 * Capability gating mirrors the host `asReader/asWriter/asAdmin` pattern and the
 * VC1B ledger: the writer exposes append only, the reader exposes query only,
 * and the admin alone can rebuild / switch generations. No callbacks or event
 * emitters flow from the store; writes are non-fatal (failures log and never
 * break the agent loop).
 *
 * Pure type/schema definitions + small pure predicates. No storage, no console,
 * no network, no side effects (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * A derived cortex record — byte authority is `payloadBytes`; `payloadDigest` is
 * the authoritative `sha256:<hex>` over those bytes. `sourceHighWater` is the
 * durable authority high-water the record was derived AT (the derived frontier
 * cannot exceed it); `algorithmVersion` is the producing algorithm revision.
 */
export interface CortexRecordV1 {
  readonly schema: "cortex-record-v1";
  /** Durable contiguous authority high-water this record derives from. */
  readonly sourceHighWater: bigint;
  /** Producing algorithm revision (records at distinct versions stay distinct). */
  readonly algorithmVersion: number;
  /** Stable record identity within the derived store. */
  readonly id: string;
  /** Record kind (semantic / dependency / contradiction / synthetic...). */
  readonly kind: string;
  /** Authoritative `sha256:<hex>` of `payloadBytes` (immutability anchor). */
  readonly payloadDigest: string;
  /** Immutable derived payload bytes (byte authority for the record). */
  readonly payloadBytes: Uint8Array;
}

/**
 * A derived GENEration — a named, digest-pinned front over the sorted accepted
 * records. `rootDigest` is ONE deterministic digest over the canonical sorted
 * key list (order-independent, CTX-REBUILD-003); `sourceHighWater` is the derived
 * frontier (max sourceHighWater across its records).
 */
export interface CortexGenerationV1 {
  readonly schema: "cortex-generation-v1";
  readonly id: string;
  readonly sourceHighWater: bigint;
  readonly recordCount: number;
  readonly rootDigest: string;
  /** Monotonic rebuild ordinal (never regresses for an accepted generation). */
  readonly ordinal: bigint;
}

/** Failure codes the writer surfaces on a rejected / failed append. */
export type CortexAppendCode =
  /** Storage failure (e.g. SQLITE_FULL). Non-fatal; host continues in mode C. */
  | "CTX_APPEND_FAILED"
  /** Same (sourceHighWater, algorithmVersion, id) but a different payloadDigest. */
  | "CTX_KEY_CONFLICT";

/** Result of a single append attempt. */
export type CortexAppendResult =
  | { ok: true; record: CortexRecordV1 }
  | { ok: false; code: CortexAppendCode; rejected: CortexRecordV1 };

/** Failure codes the admin surfaces on a rejected rebuild. */
export type CortexRebuildCode =
  /** A record's payloadDigest does not match its payloadBytes (authority corrupt). */
  | "CTX_PAYLOAD_DIGEST_MISMATCH"
  /** A record exceeds the caller's declared generation source high-water. */
  | "CTX_HIGH_WATER_EXCEEDED";

/**
 * Reader capability: query-only. The dashboard's reader-only GET
 * `GET /api/vector-cortex/topology` is built on exactly this surface and nothing
 * more — it can read the generation/topology summary and records but never
 * append, rebuild, or switch generations.
 */
export interface CortexReader {
  readonly kind: "CortexReader";
  /** Count of accepted derived records. */
  recordCount(): number;
  /** Accepted records in ascending `(sourceHighWater, algorithmVersion, id)`. */
  readRecords(): readonly CortexRecordV1[];
  /** The single record at a composite key, or undefined. */
  readRecord(sourceHighWater: bigint, algorithmVersion: number, id: string): CortexRecordV1 | undefined;
  /** The latest (active) generation, or undefined when none rebuilt yet. */
  latestGeneration(): CortexGenerationV1 | undefined;
  /** Reader-only topology summary (the dashboard GET payload). */
  topologySummary(): CortexTopologySummary;
}

/**
 * Writer capability: append-only. Can add immutable derived records — but cannot
 * query arbitrary history, rebuild, or touch generations. Enforces the composite
 * key immutability on every append.
 */
export interface CortexWriter {
  readonly kind: "CortexWriter";
  /** Append one derived record; idempotent ack on exact key+digest, conflict otherwise. */
  append(input: CortexAppendInput): CortexAppendResult;
}

/**
 * Admin capability: maintenance + generation control ONLY. The sole surface with
 * rebuild / switch-generations capability — never exposed to ingestion or the
 * dashboard reader.
 */
export interface CortexAdmin {
  readonly kind: "CortexAdmin";
  /**
   * Deterministically rebuild a generation from ALL accepted records: sorts keys,
   * verifies each payload digest, computes ONE root digest, writes + activates a
   * new generation. Idempotent with respect to unchanged accepted inputs.
   */
  rebuild(): { ok: true; generation: CortexGenerationV1 } | { ok: false; code: CortexRebuildCode };
  /** Switch the active generation pointer without deleting evidence. */
  switchGeneration(generationId: string): { ok: boolean; code?: string };
  /** List every generation id in ascending ordinal order (evidence retained). */
  listGenerations(): readonly CortexGenerationV1[];
}

/** Input shape of a single append (record fields minus the readonly full type). */
export interface CortexAppendInput {
  readonly sourceHighWater: bigint;
  readonly algorithmVersion: number;
  readonly id: string;
  readonly kind: string;
  readonly payloadDigest?: string;
  readonly payloadBytes: Uint8Array;
}

/**
 * Reader-only topology summary — the exact payload of the dashboard
 * `GET /api/vector-cortex/topology` reader-only GET. Aggregate only: root digest
 * prefix, record count, derived frontier. Never exposes writer/admin surfaces or
 * raw record payloads.
 */
export interface CortexTopologySummary {
  /** Whether the VC3A cortex-store flag is enabled. */
  readonly enabled: boolean;
  /** Active generation id, or null when no generation rebuilt yet. */
  readonly generationId: string | null;
  /** Active generation root digest (or null). */
  readonly rootDigest: string | null;
  /** Derived frontier (active generation sourceHighWater, or "0"). */
  readonly sourceHighWater: string;
  /** Accepted derived record count. */
  readonly recordCount: number;
  /** Monotonic rebuild ordinal (or null). */
  readonly ordinal: string | null;
}

/**
 * Registered CTX conformance ID range (CTX-001..010). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest bytes or
 * exactly its listed failure code. The three NAMED assertions
 * (CTX-CAP-001 / CTX-KEY-002 / CTX-REBUILD-003) live in the acceptance test.
 */
export const CTX_IDS = [
  "CTX-001",
  "CTX-002",
  "CTX-003",
  "CTX-004",
  "CTX-005",
  "CTX-006",
  "CTX-007",
  "CTX-008",
  "CTX-009",
  "CTX-010",
] as const;
