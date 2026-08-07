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
  // Floor of 1: even with preserveRecentMin=0 at full pressure, never compact
  // ALL messages — the boundary guard (computeDropRange) needs ≥1 to anchor on.
  return Math.max(1, preserveRecentMin, Math.min(preserveRecent, v));
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

// ---------------------------------------------------------------------------
// S57 RAG Suite feature flags — all default ON with graceful fallback; opt OUT
// via MEGACOMPACT_<NAME>_DISABLED=true. Every feature degrades to existing
// behavior on error (non-fatal, best-effort).
// ---------------------------------------------------------------------------

function ragFlag(name: string): boolean {
  const v = process.env[name];
  if (v === undefined) return false;
  return v === "true" || v === "1";
}

function ragEnabled(name: string): boolean {
  return !ragFlag(name + "_DISABLED");
}

/** B1: Query reformulation (keyword expansion via embedding neighbors). */
export const RAG_QUERY_REFORMULATION = (): boolean =>
  ragEnabled("MEGACOMPACT_QUERY_REFORMULATION");

/** B2: Tiered recall router (L0 cache → L1 FTS5 → L2 HNSW). */
export const RAG_TIERED_ROUTER = (): boolean =>
  ragEnabled("MEGACOMPACT_TIERED_ROUTER");

/** B3: Recall quality metrics (precision/recall scoring + logging). */
export const RAG_RECALL_METRICS = (): boolean =>
  ragEnabled("MEGACOMPACT_RECALL_METRICS");

/** B4: Memory graph traversal (dashboard-oriented). */
export const RAG_MEMORY_GRAPH = (): boolean =>
  ragEnabled("MEGACOMPACT_MEMORY_GRAPH");

/** B5: HyDE — generate a hypothetical answer doc via LLM. Auto-ON when an
 * HttpEmbedder is active (the LLM is configured for indexing); opt OUT with
 * MEGACOMPACT_HYDE_DISABLED=true. TrigramEmbedder path is unaffected. */
export const RAG_HYDE_ENABLED = (): boolean =>
  ragEnabled("MEGACOMPACT_HYDE");

/** Spec 1: vbrainstorm visual design migration for the dashboard. */
export const NEW_UI = (): boolean => ragEnabled("MEGACOMPACT_NEW_UI");

// ---------------------------------------------------------------------------
// Vector-cortex flags + breaker constants (VC0A+). Positive sprint flags,
// default ON, `=0`/`_DISABLED` off. Re-exported from src/config/vector-cortex.ts
// so root consumers share one source of truth.
// ---------------------------------------------------------------------------

export {
  VC0A_ENABLED,
  VC0B_ENABLED,
  VC1A_ENABLED,
  VC0C_ENABLED,
  VC1B_ENABLED,
  VC1C_ENABLED,
  VC2A_ENABLED,
  VC2B_ENABLED,
  VC2C_ENABLED,
  VC3A_ENABLED,
  VC3B_ENABLED,
  VC3C_ENABLED,
  VC4A_ENABLED,
  VC4B_ENABLED,
  VC4C_ENABLED,
  VC5A_ENABLED,
  VC5B_ENABLED,
  VC5C_ENABLED,
  VC6A_ENABLED,
  VC6B_ENABLED,
  VC6C_ENABLED,
  VC7A_ENABLED,
  VC7B_ENABLED,
  VC7C_ENABLED,
  VC8A_ENABLED,
  VC8B_ENABLED,
  VC8C_ENABLED,
  VC9A_ENABLED,
  VC9B_ENABLED,
  VC9C_ENABLED,
  VC9D_ENABLED,
  PCC_ENABLED,
  ML5A_ENABLED,
  ML5B_ENABLED,
  ML5C_ENABLED,
  ML5D_ENABLED,
  ML5E_ENABLED,
  DEDUP_ATTR_ENABLED,
  ENC_0A_ENABLED,
  ENC_0B_ENABLED,
  ENC_0C_ENABLED,
  ENC_0D_ENABLED,
  ENC_0E_ENABLED,
  ENC_0F_ENABLED,
  ENC_0G_ENABLED,
  ENC_1A_ENABLED,
  ENC_1B_ENABLED,
  ENC_2BUDGET_ENABLED,
  ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV,
  ENC_2BUDGET_MAX_MIB,
  ENC_2BUDGET_DEFAULT_MIB,
  COSINE_FP_BENCH_ENABLED,
  COSINE_FP_REAL_ENABLED,
  REPO_CORPUS_ENABLED,
  BREAKER_WINDOW_MS,
  BREAKER_MIN_ATTEMPTS,
  BREAKER_PERF_FAILURES,
  BREAKER_PERF_FAILURE_RATE,
  BREAKER_CORRECTNESS_FAILURES,
  BREAKER_COOLDOWN_MS,
  BREAKER_PROBE_COUNT,
  BREAKER_RETRY_BASE_MS,
  BREAKER_RETRY_CAP_MS,
  BREAKER_RETRY_JITTER,
  BREAKER_HYSTERESIS_FAILURE_RATE,
  BREAKER_HYSTERESIS_BUDGET_P95_MS,
  BREAKER_MIN_HEALTHY_RESIDENCE_MS,
} from "./config/vector-cortex.js";
