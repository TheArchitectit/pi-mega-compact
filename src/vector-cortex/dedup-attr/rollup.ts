/**
 * vector-cortex/dedup-attr/rollup.ts — DEDUP-ATTR pure tier-attribution rollup.
 *
 * Pure function: reads an array of parsed dedup-audit events, buckets them by
 * tier over a query window, and returns the per-tier catch shares. No I/O, no
 * clock — the route passes `now: Date` (new Date()) at request time, so this
 * module is deterministically reproducible and trivially testable (DEDUP-ATTR-004).
 *
 * Missing `similarity` is fine here: L0/L1 are hash/verify tiers and emit no
 * score, and the rollup never consults it. Malformed lines (non-object, wrong
 * type) are skipped silently — the route's events.log reader already guards its
 * JSON.parse (PREVENT-001), and this layer defends against a hostile/mixed
 * `dedup_audit` array as well.
 *
 * The returned shape is structurally identical to the authoritative contract in
 * `extensions/dashboard-server/api-contracts/dedup-attribution.ts` (the existing
 * src-mirrors-dashboard-contract pattern); src/ stays pi-agnostic and never
 * imports dashboard types. Status here is computed from the pure signal the
 * rollup owns (a non-empty window) — the route additionally derives the sent
 * `status` via `deriveVcStatus` from the shared vc-status module.
 *
 * Guardrails: PREVENT-PI-004 (zero I/O/network), PREVENT-011 (no `any`).
 */

import type { DedupAuditEvent } from "../../vectorStore/dedup-audit.js";

/** Per-tier dedup/passed counts (same shape as the api-contract DedupTierCounts). */
export interface DedupTierRollupCounts {
  /** Decisions this tier collapsed onto a matched checkpoint. */
  readonly deduped: number;
  /** Decisions this tier scored a candidate but did not collapse. */
  readonly passed: number;
}

/** The status the rollup can produce from its pure signal. */
export type RollupStatus = "live" | "awaiting_data";

/** Purely-computed tier attribution for one window (mirrors DedupTierRollupV1). */
export interface DedupTierRollup {
  readonly schema: "dedup-tier-rollup-v1";
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totalDecisions: number;
  readonly byTier: {
    readonly l0: DedupTierRollupCounts;
    readonly l1: DedupTierRollupCounts;
    readonly l2: DedupTierRollupCounts;
    readonly new: number;
  };
  readonly l0Share: number;
  readonly l1Share: number;
  readonly l2Share: number;
  readonly status: RollupStatus;
}

interface Accumulator {
  l0: { deduped: number; passed: number };
  l1: { deduped: number; passed: number };
  l2: { deduped: number; passed: number };
  storedNew: number;
}

/**
 * Roll up dedup-audit events over [now - windowMs, now] into per-tier shares.
 *
 * Only events whose ISO-8601 `ts` falls inside the window are counted; events of
 * any other `type` (or a missing/unparseable `ts`) are skipped silently. Shares
 * are fractions of the window's total decisions, each in [0, 1]; an empty window
 * yields all-zero shares with `status:"awaiting_data"` — never a fabricated
 * zero-share table presented as real.
 */
export function computeDedupTierRollup(
  events: readonly DedupAuditEvent[],
  windowMs: number,
  now: Date,
): DedupTierRollup {
  const winMs = windowMs > 0 ? windowMs : 24 * 60 * 60 * 1000;
  const windowStart = now.getTime() - winMs;
  const windowEnd = now.getTime();

  const acc: Accumulator = {
    l0: { deduped: 0, passed: 0 },
    l1: { deduped: 0, passed: 0 },
    l2: { deduped: 0, passed: 0 },
    storedNew: 0,
  };
  let total = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type !== "dedup_audit") continue;
    const ts = Date.parse(ev.ts);
    if (Number.isNaN(ts) || ts < windowStart || ts > windowEnd) continue;
    total += 1;
    switch (ev.tier) {
      case "L0":
        if (ev.status === "deduped") acc.l0.deduped += 1;
        else if (ev.status === "passed") acc.l0.passed += 1;
        break;
      case "L1":
        if (ev.status === "deduped") acc.l1.deduped += 1;
        else if (ev.status === "passed") acc.l1.passed += 1;
        break;
      case "L2":
        if (ev.status === "deduped") acc.l2.deduped += 1;
        else if (ev.status === "passed") acc.l2.passed += 1;
        break;
      case "new":
        acc.storedNew += 1;
        break;
      default:
        break;
    }
  }

  const byTier = {
    l0: { deduped: acc.l0.deduped, passed: acc.l0.passed },
    l1: { deduped: acc.l1.deduped, passed: acc.l1.passed },
    l2: { deduped: acc.l2.deduped, passed: acc.l2.passed },
    new: acc.storedNew,
  };

  const shareOf = (n: number): number => (total > 0 ? n / total : 0);

  return {
    schema: "dedup-tier-rollup-v1",
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: now.toISOString(),
    totalDecisions: total,
    byTier,
    l0Share: shareOf(acc.l0.deduped + acc.l0.passed),
    l1Share: shareOf(acc.l1.deduped + acc.l1.passed),
    l2Share: shareOf(acc.l2.deduped + acc.l2.passed),
    status: total > 0 ? "live" : "awaiting_data",
  };
}
