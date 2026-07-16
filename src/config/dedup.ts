/**
 * config/dedup.ts — SINGLE SOURCE OF TRUTH for dedup tier flags + thresholds
 * (Sprint 14, Phase 7).
 *
 * Every tier flag and threshold that was previously an inline default in
 * vectorStore.ts / the RAPTOR modules is defined HERE and only here (QA #8: no
 * duplicated threshold across modules). Values are read from MEGACOMPACT_* env
 * at load, with the file defaults below as the fallback (which reproduce the
 * Sprint 13 behavior — all tiers active, nothing MARK_ONLY).
 *
 * MARK_ONLY semantics (QA ops): a tier in MARK_ONLY still RUNS and RECORDS its
 * decision (so we keep the data + can replay), but does NOT collapse/dedup — a
 * safe partial-rollout / auto-degrade state.
 *
 * PREVENT-PI-004: pure config, no network. Booleans/numbers only.
 */

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface DedupConfigShape {
  // Tier enable flags.
  L0_ENABLED: boolean;
  L1_ENABLED: boolean;
  L2_ENABLED: boolean;
  RAPTOR_ENABLED: boolean;
  // MARK_ONLY per tier: run + record, never collapse.
  MARK_ONLY_L0: boolean;
  MARK_ONLY_L1: boolean;
  MARK_ONLY_L2: boolean;
  // Embedder selection.
  MINILM_EMBEDDER: boolean;
  // Thresholds.
  L2_COSINE: number; // semantic dedup firing point
  L1_JACCARD: number; // MinHash/LSH near-dup verification
  DEDUP_SIM: number; // legacy content-similarity fallback
  MMR_LAMBDA: number; // retrieval diversity
  SEMDEDUP_COSINE: number; // offline SemDeDup pair threshold
  CONSOLIDATE_COSINE: number; // memory consolidation merge threshold (Sprint 21)
  // Caps / budgets.
  SIMILARITY_BUDGET_MS: number;
  L1_VERIFY_BUDGET_MS: number;
  L1_CANDIDATE_CAP: number;
  RAPTOR_BUDGET_MS: number;
  RAPTOR_CLUSTERS_PER_LEVEL: number;
  RAPTOR_CONSISTENCY: number;
  // Monitoring / alerting.
  FP_RATE_L0: number; // FP alert threshold for exact tier
  FP_RATE_L1L2: number; // FP alert threshold for fuzzy tiers
  ALERT_WINDOW_MS: number;
  P95_BUDGET_MS: number; // canary p95 budget per tier
}

/** Read the current dedup config from env (file defaults reproduce Sprint 13). */
export function loadDedupConfig(): DedupConfigShape {
  return {
    L0_ENABLED: envBool("MEGACOMPACT_L0_ENABLED", true),
    L1_ENABLED: envBool("MEGACOMPACT_L1_ENABLED", true),
    L2_ENABLED: envBool("MEGACOMPACT_L2_ENABLED", true),
    // Fix D: RAPTOR promoted to live recall. Default ON; canary.ts sequences it
    // last (L0→L1→L2→RAPTOR) and auto-disables on p95 breach, so promotion is
    // safe. `RAPTOR_SHADOW_MODE=false` still gates serving during transition.
    RAPTOR_ENABLED: envBool("MEGACOMPACT_RAPTOR_ENABLED", true),
    MARK_ONLY_L0: envBool("MEGACOMPACT_MARK_ONLY_L0", false),
    MARK_ONLY_L1: envBool("MEGACOMPACT_MARK_ONLY_L1", false),
    MARK_ONLY_L2: envBool("MEGACOMPACT_MARK_ONLY_L2", false),
    MINILM_EMBEDDER: envBool("MEGACOMPACT_MINILM", false),
    L2_COSINE: envNum("MEGACOMPACT_L2_THRESHOLD", 0.85),
    L1_JACCARD: envNum("MEGACOMPACT_L1_JACCARD", 0.8),
    DEDUP_SIM: envNum("MEGACOMPACT_DEDUP_SIM", 0.9),
    MMR_LAMBDA: envNum("MEGACOMPACT_MMR_LAMBDA", 0.5),
    SEMDEDUP_COSINE: envNum("MEGACOMPACT_SEMDEDUP_COSINE", 0.95),
    CONSOLIDATE_COSINE: envNum("MEGACOMPACT_CONSOLIDATE_COSINE", 0.7),
    SIMILARITY_BUDGET_MS: envNum("MEGACOMPACT_SIMILARITY_BUDGET_MS", 50),
    L1_VERIFY_BUDGET_MS: envNum("MEGACOMPACT_L1_VERIFY_BUDGET_MS", 20),
    L1_CANDIDATE_CAP: envNum("MEGACOMPACT_L1_CANDIDATE_CAP", 100),
    RAPTOR_BUDGET_MS: envNum("MEGACOMPACT_RAPTOR_BUDGET_MS", 5000),
    RAPTOR_CLUSTERS_PER_LEVEL: envNum("MEGACOMPACT_RAPTOR_CLUSTERS", 5),
    RAPTOR_CONSISTENCY: envNum("MEGACOMPACT_RAPTOR_CONSISTENCY", 0.6),
    FP_RATE_L0: envNum("MEGACOMPACT_FP_RATE_L0", 0.01),
    FP_RATE_L1L2: envNum("MEGACOMPACT_FP_RATE_L1L2", 0.05),
    ALERT_WINDOW_MS: envNum("MEGACOMPACT_ALERT_WINDOW_MS", 600_000),
    P95_BUDGET_MS: envNum("MEGACOMPACT_P95_BUDGET_MS", 100),
  };
}

/**
 * The default config snapshot (read once at import). Callers that need to honor
 * runtime env changes (tests) should call loadDedupConfig() directly; the live
 * add()/search() path reads this snapshot but accepts an override for testing.
 */
export const DedupConfig: DedupConfigShape = loadDedupConfig();

/** Tier identifiers used in monitoring + alerting. */
export type DedupTier = "L0" | "L1" | "L2" | "RAPTOR";

/** Is a given tier enabled (and not merely MARK_ONLY)? */
export function tierEnabled(cfg: DedupConfigShape, tier: DedupTier): boolean {
  switch (tier) {
    case "L0": return cfg.L0_ENABLED;
    case "L1": return cfg.L1_ENABLED;
    case "L2": return cfg.L2_ENABLED;
    case "RAPTOR": return cfg.RAPTOR_ENABLED;
  }
}

/** Is a given tier in MARK_ONLY (record, don't collapse)? */
export function tierMarkOnly(cfg: DedupConfigShape, tier: DedupTier): boolean {
  switch (tier) {
    case "L0": return cfg.MARK_ONLY_L0;
    case "L1": return cfg.MARK_ONLY_L1;
    case "L2": return cfg.MARK_ONLY_L2;
    case "RAPTOR": return false; // RAPTOR has its own shadow mode
  }
}
