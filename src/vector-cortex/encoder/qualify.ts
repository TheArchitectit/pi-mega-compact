/**
 * vector-cortex/encoder/qualify.ts — ENC-0f pure qualification function.
 *
 * Constructs a {@link QualificationV1} record from a {@link BenchResultV1} by
 * asserting four independent gates (latency, marginal-RSS, determinism, opset)
 * plus the bench's own conjunctive `gates.all`. A gated-off bench can NEVER be
 * swept into mode A by a sub-threshold p95 alone — `bench_gates_not_green`
 * forces `"failed"` regardless of the sub-threshold values.
 *
 * Pure (TRIAD_RESILIENCE §pure): no `any` (PREVENT-011), no casts, no clock, no
 * storage, no network (PREVENT-PI-004). Thresholds are sourced from
 * {@link ENCODER_LATENCY_P95_MS} / {@link ENCODER_RSS_BUDGET_BYTES} /
 * {@link ENCODER_OPSET} — never magic numbers.
 */

import type { BenchResultV1 } from "./bench-export.js";
import {
  ENCODER_LATENCY_P95_MS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_OPSET,
} from "./types.js";

/** The qualification verdict for a real trained encoder asset. */
export interface QualificationV1 {
  readonly schema: "qualification-v1";
  readonly verdict: "qualified" | "failed";
  readonly reasons: string[];
  readonly platform: string;
  readonly p95Ms: number;
  readonly rssMib: number;
  readonly opset: number;
  /** SHA-256 hex of the bench run's embedding output (never payload content). */
  readonly digest: string;
}

/**
 * Qualify a bench result against the four independent gates + the bench's own
 * conjunctive gate. Returns a QualificationV1 with `verdict:"qualified"` only
 * when ALL gates pass and `bench.gates.all` is true.
 */
export function qualifyEncodedAsset(
  bench: BenchResultV1,
  platform: string,
): QualificationV1 {
  const reasons: string[] = [];

  if (bench.p95Ms !== null && bench.p95Ms > ENCODER_LATENCY_P95_MS) {
    reasons.push("latency");
  }

  if (
    bench.rssMarginalMib !== null &&
    bench.rssMarginalMib * 1024 * 1024 > ENCODER_RSS_BUDGET_BYTES
  ) {
    reasons.push("rss");
  }

  if (!bench.deterministic) {
    reasons.push("determinism");
  }

  if (bench.opset !== null && bench.opset !== ENCODER_OPSET) {
    reasons.push("opset");
  }

  if (!bench.gates.all && !reasons.includes("bench_gates_not_green")) {
    reasons.push("bench_gates_not_green");
  }

  const verdict: "qualified" | "failed" =
    reasons.length === 0 && bench.gates.all ? "qualified" : "failed";

  return {
    schema: "qualification-v1",
    verdict,
    reasons,
    platform,
    p95Ms: bench.p95Ms ?? 0,
    rssMib: bench.rssMarginalMib ?? 0,
    opset: bench.opset ?? 0,
    digest: bench.digest ?? "",
  };
}
