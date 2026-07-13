/**
 * monitoring.ts — local dedup monitoring + alerting (Sprint 14, Phase 7).
 *
 * Per-decision structured events go to `events.log` (append-only JSON).
 * Aggregate metrics (hit rate, FP rate, per-tier p95 latency, storage) go to
 * `dashboard.json` — the SAME local-only file the /dashboard UI reads. There is
 * NO Prometheus port and NO network listener (PREVENT-PI-004). Alerting is local
 * only: an FP-rate breach flips the tier to MARK_ONLY and writes a warning.
 *
 * Best-effort: logging/metrics never throw into the add()/search() path.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR_DEFAULT } from "./config.js";
import type { DedupConfigShape } from "./config/dedup.js";
import type { DedupTier } from "./config/dedup.js";

export interface DedupDecisionEvent {
  ts: number;
  tier: DedupTier;
  result: "deduped" | "new" | "mark_only";
  reason?: string;
  latencyMs: number;
  /** True when this dedup was later found to be a false positive. */
  falsePositive?: boolean;
}

export interface DedupMetrics {
  /** Decisions per tier. */
  decisions: Record<string, number>;
  /** Deduped (collapsed) per tier. */
  deduped: Record<string, number>;
  /** Rolling FP count per tier (within the alert window). */
  falsePositives: Record<string, number>;
  /** Latency samples per tier (for p95). */
  latency: Record<string, number[]>;
  /** Total storage bytes (checkpoint blobs). */
  storageBytes: number;
}

const TIERS: DedupTier[] = ["L0", "L1", "L2", "RAPTOR"];

function emptyMetrics(): DedupMetrics {
  const dec: Record<string, number> = {};
  const dp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const lat: Record<string, number[]> = {};
  for (const t of TIERS) { dec[t] = 0; dp[t] = 0; fp[t] = 0; lat[t] = []; }
  return { decisions: dec, deduped: dp, falsePositives: fp, latency: lat, storageBytes: 0 };
}

/** Append a structured decision event to events.log (best-effort). */
export function logDecision(path: string, ev: DedupDecisionEvent): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(ev)}\n`);
  } catch {
    /* never break the extension on a log failure */
  }
}

/**
 * Load metrics from dashboard.json, or return a fresh empty snapshot.
 * Kept simple + synchronous (no network).
 */
export function loadMetrics(path: string): DedupMetrics {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DedupMetrics>;
      const base = emptyMetrics();
      return {
        decisions: { ...base.decisions, ...(parsed.decisions ?? {}) },
        deduped: { ...base.deduped, ...(parsed.deduped ?? {}) },
        falsePositives: { ...base.falsePositives, ...(parsed.falsePositives ?? {}) },
        latency: { ...base.latency, ...(parsed.latency ?? {}) },
        storageBytes: parsed.storageBytes ?? 0,
      };
    }
  } catch {
    /* corrupt metrics → fresh */
  }
  return emptyMetrics();
}

/** Persist metrics to dashboard.json (best-effort). */
export function saveMetrics(path: string, m: DedupMetrics): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(m));
  } catch {
    /* never break the extension */
  }
}

/** Compute the p95 latency (ms) for a tier from its samples. */
export function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/** FP rate for a tier over the current window (0..1). */
export function fpRate(m: DedupMetrics, tier: DedupTier): number {
  const decisions = m.decisions[tier] ?? 0;
  if (decisions === 0) return 0;
  return (m.falsePositives[tier] ?? 0) / decisions;
}

export interface AlertResult {
  /** Tiers newly flipped to MARK_ONLY by this alert pass. */
  breached: DedupTier[];
  /** Warning lines written to events.log. */
  warnings: string[];
}

/**
 * Evaluate FP-rate breaches against the config thresholds. A breached fuzzy tier
 * (L0 vs L1/L2 have different thresholds) is auto-downgraded to MARK_ONLY — the
 * local re-map of "alertmanager" (QA #18/#19): record but don't collapse, no
 * remote alert. Returns the tiers flipped so the caller can mutate its config.
 */
export function evaluateAlerts(
  m: DedupMetrics,
  cfg: DedupConfigShape,
): AlertResult {
  const breached: DedupTier[] = [];
  const warnings: string[] = [];
  for (const tier of TIERS) {
    const rate = fpRate(m, tier);
    const limit = tier === "L0" ? cfg.FP_RATE_L0 : cfg.FP_RATE_L1L2;
    if (rate > limit) {
      breached.push(tier);
      warnings.push(`DEDUP FP BREACH tier=${tier} rate=${rate.toFixed(4)} > ${limit}`);
    }
  }
  return { breached, warnings };
}

/**
 * Record one decision into the metrics snapshot (mutates `m` in place) and
 * returns the updated snapshot. Caps stored latency samples to keep memory
 * bounded (last 1000 per tier).
 */
export function recordDecision(
  m: DedupMetrics,
  tier: DedupTier,
  result: "deduped" | "new" | "mark_only",
  latencyMs: number,
  falsePositive = false,
): DedupMetrics {
  m.decisions[tier] = (m.decisions[tier] ?? 0) + 1;
  if (result === "deduped") m.deduped[tier] = (m.deduped[tier] ?? 0) + 1;
  if (falsePositive) m.falsePositives[tier] = (m.falsePositives[tier] ?? 0) + 1;
  const arr = m.latency[tier] ?? (m.latency[tier] = []);
  arr.push(latencyMs);
  if (arr.length > 1000) arr.shift();
  return m;
}

/** Default metrics path alongside the state dir. */
export function defaultMetricsPath(stateDir: string = STATE_DIR_DEFAULT): string {
  return join(stateDir, "dashboard.json");
}

/** Default events-log path alongside the state dir. */
export function defaultEventsPath(stateDir: string = STATE_DIR_DEFAULT): string {
  return join(stateDir, "events.log");
}
