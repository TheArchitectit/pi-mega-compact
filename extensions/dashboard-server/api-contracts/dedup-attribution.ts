/**
 * api-contracts/dedup-attribution.ts — Dedup tier-attribution rollup types (DEDUP-ATTR).
 *
 * Types for GET /api/dedup-tier-attribution — the reader-only aggregate that
 * answers "L0/L1/L2/new percent of dedup decisions in window W". Inputs are the
 * produced `dedup_audit` events in the local events.log (shape DedupAuditEvent
 * in src/vectorStore/dedup-audit.ts). Outputs are counts + shares only — never
 * matched checkpoint paths/text, never raw user query (EVAL-REDACT-002).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

import type { VcStatus } from "../vc-status.js";

/** Per-tier dedup decision counts (L0/L1/L2 carry deduped + passed; `new` carries stored). */
export interface DedupTierCounts {
  /** Decisions this tier collapsed onto a matched checkpoint. */
  readonly deduped: number;
  /** Decisions this tier scored a candidate but did not collapse. */
  readonly passed: number;
}

/**
 * The rolled-up per-tier attribution for one query window.
 *
 * Shares are fractions of the window's total decisions (deduped + passed +
 * stored), each in [0, 1]. `updateHz` is present when a derived refresh cadence
 * is meaningful; the response is otherwise a point-in-time snapshot.
 */
export interface DedupTierRollupV1 {
  /** Discriminator so a future schema migration is explicit. */
  readonly schema: "dedup-tier-rollup-v1";
  /** ISO-8601 window start (inclusive), `now - windowMs`. */
  readonly windowStart: string;
  /** ISO-8601 window end (inclusive), `now`. */
  readonly windowEnd: string;
  /** Number of dedup decisions in the window (deduped + passed + stored). */
  readonly totalDecisions: number;
  /** Per-tier decision counts. */
  readonly byTier: {
    readonly l0: DedupTierCounts;
    readonly l1: DedupTierCounts;
    readonly l2: DedupTierCounts;
    /** Count of "new" decisions (nothing collapsed — a stored entry). */
    readonly new: number;
  };
  /** L0 share of the window's total decisions, in [0, 1]. */
  readonly l0Share: number;
  /** L1 share of the window's total decisions, in [0, 1]. */
  readonly l1Share: number;
  /** L2 share of the window's total decisions, in [0, 1]. */
  readonly l2Share: number;
  /** Optional derived refresh cadence (ms) when meaningful. */
  readonly updateHz?: number;
  /** Shared status derivation (deriveVcStatus). */
  readonly status: VcStatus;
}

/** Holds the per-tier deduped/passed accumulators + the stored count. */
export interface DedupTierAccumulator {
  l0: { deduped: number; passed: number };
  l1: { deduped: number; passed: number };
  l2: { deduped: number; passed: number };
  storedNew: number;
}

/** Response body for GET /api/dedup-tier-attribution. */
export type DedupTierAttributionResponse = DedupTierRollupV1;
