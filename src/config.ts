/**
 * config.ts — shared default paths/constants for the mega-compact engine.
 *
 * Kept tiny and dependency-free so both the extension entry and unit tests can
 * import it without pulling in pi runtime types.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Default on-disk location for checkpoints + session state. */
export const STATE_DIR_DEFAULT = join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");

/** Pi custom message / entry type used as the dedup sentinel. */
export const MARKER_TYPE = "mega-compact-marker";

/**
 * Derive context-window pressure (0–1) from a usage percentage. Used to scale
 * compression strength + keepFrom depth (Fix E): low pct = room to spare,
 * high pct = near the limit. Deterministic; clamps to [0,1].
 */
export function pressureFromPct(pct: number | null | undefined): number {
  if (pct == null || Number.isNaN(pct)) return 0;
  return pct < 0 ? 0 : pct > 100 ? 1 : pct / 100;
}

/**
 * Map pressure → how many recent messages to preserve verbatim. Under low
 * pressure we keep `preserveRecent`; under high pressure we compact deeper,
 * down to `preserveRecentMin`. Never splits a tool pair / anchor floor — the
 * boundary guard (computeDropRange) enforces that downstream.
 */
export function preserveRecentForPressure(
  pressure: number,
  preserveRecent: number,
  preserveRecentMin: number,
): number {
  const p = pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
  const v = Math.round(preserveRecent - (preserveRecent - preserveRecentMin) * p);
  return Math.max(preserveRecentMin, Math.min(preserveRecent, v));
}

/**
 * Discrete pressure band derived from the live 0–1 pressure ratio. This is the
 * single signal every subsystem (tier label, trim depth, memory cadence)
 * branches on, so context rising actually *moves* the dashboard/menu instead of
 * sitting on a static env-resolved preset. (S24 — unified pressure signal.)
 *
 * Bands:
 *   low    < 0.50   plenty of headroom — minimal trimming, infrequent review
 *   medium 0.50–0.75
 *   high   0.75–0.90
 *   ultra  0.90–1.00
 *   mega   >= 1.00  at/over threshold — deepest trim, most aggressive review
 */
export type PressureBand = "low" | "medium" | "high" | "ultra" | "mega";

/** Clamp a pressure ratio into [0, 1]. */
function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * Pressure as a 0–1 ratio from live token usage relative to the compaction
 * threshold. Cheaper + more direct than deriving from a usage percentage when
 * we already have both numbers (the context handler does). Re-exports
 * `pressureFromPct` covers the percentage-only path. (S24.)
 */
export function pressureRatio(currentTokens: number, thresholdTokens: number): number {
  if (!Number.isFinite(currentTokens) || currentTokens <= 0) return 0;
  const t = Number.isFinite(thresholdTokens) && thresholdTokens > 0 ? thresholdTokens : 0;
  return clamp01(t > 0 ? currentTokens / t : 0);
}

/** Map a 0–1 pressure ratio to a discrete band. (S24.) */
export function pressureBand(pressure: number): PressureBand {
  const p = clamp01(pressure);
  if (p >= 1.0) return "mega";
  if (p >= 0.9) return "ultra";
  if (p >= 0.75) return "high";
  if (p >= 0.5) return "medium";
  return "low";
}

/**
 * Memory auto-review cadence (in turns) for a given pressure band. As pressure
 * climbs, the conversation is reviewed more often so durable memories keep pace
 * with the faster context churn. Returns a divisor used as
 * `turn % cadence === 0`. Always >= 1. (S24 — memory cadence tie-in.)
 */
export function memoryReviewCadence(band: PressureBand, baseInterval: number): number {
  const base = baseInterval >= 1 ? baseInterval : 1;
  switch (band) {
    case "mega": return Math.max(1, Math.round(base / 5));
    case "ultra": return Math.max(1, Math.round(base / 3));
    case "high": return Math.max(1, Math.round(base / 2));
    case "medium": return Math.max(1, Math.round((base * 2) / 3));
    case "low":
    default: return base;
  }
}
