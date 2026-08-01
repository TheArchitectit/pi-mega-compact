/**
 * recallMetrics.ts — S45 CRAG quality metrics for recall evaluation.
 *
 * Four metrics evaluate the quality of a set of recall hits:
 *   - relevance:     average cosine similarity (SearchHit.score) across hits
 *   - coverage:      fraction of query sub-terms found in at least one hit summary
 *   - diversity:     average pairwise cosine distance among top-K embeddings (MMR-style)
 *   - specificity:   inverse document-frequency proxy via average chunk length
 *
 * Pi-agnostic: no pi runtime types, no network calls (PREVENT-PI-004).
 * All config is passed explicitly; defaults are documented but NOT hardcoded
 * inside the metric functions (the four constants from S45A.5 are also received
 * via config, not baked in).
 *
 * Best-effort: all functions handle degenerate inputs (empty hits, missing
 * embeddings, zero query terms) and return sensible defaults instead of NaN.
 */

import type { SearchHit } from "./vectorStore.js";
import { cosineSimilarity } from "./embedder.js";
import { STOP_WORDS } from "./config/stopwords.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface RecallQualityWeights {
  relevance: number;
  coverage: number;
  diversity: number;
  specificity: number;
}

export interface RecallQualityBreakdown {
  relevance: number;
  coverage: number;
  diversity: number;
  specificity: number;
}

export interface RecallQualityResult {
  /** Whether the overall quality passes the configured thresholds. */
  pass: boolean;
  /** Weighted composite score in [0, 1]. */
  score: number;
  /** Per-metric breakdown. */
  breakdown: RecallQualityBreakdown;
  /** Human-readable recommendation string, or null when everything passes. */
  recommendation: string | null;
  /** True when default (uncalibrated) weights/thresholds are in use. */
  uncalibrated: boolean;
  /** The weights used for this evaluation. */
  weights: RecallQualityWeights;
}

export interface RecallQualityConfig {
  /** Minimum diversity to pass. Default 0.3. Labeled uncalibrated. */
  minDiversity: number;
  /** Minimum coverage to pass. Default 0.4. Labeled uncalibrated. */
  minCoverage: number;
  /** Minimum average relevance to pass. Default 0.5. Labeled uncalibrated. */
  minRelevance: number;
  /** Minimum overall composite score to pass. Default 0.4. Labeled uncalibrated. */
  minOverallScore: number;
  /** Weight vector for the composite score. Defaults sum to 1.0. Labeled uncalibrated. */
  weights: RecallQualityWeights;
  /** Token-estimate divisor for specificity. Default 300. Labeled uncalibrated. */
  specificityDivisor: number;
  /**
   * Below specificityOptimalMin/2 the chunk is too short → specificity = 0.
   * Default 100. Labeled uncalibrated.
   */
  specificityOptimalMin: number;
  /**
   * Diminishing returns above this value; linear ramp-down to 0 by 2x this value.
   * Default 500. Labeled uncalibrated.
   */
  specificityOptimalMax: number;
  /**
   * Fraction of checkpoints a term may appear in before it is considered "common"
   * for the broaden-query strategy. Default 0.5. Labeled uncalibrated.
   */
  idfBroadenRatio: number;
  /** Set of stopwords for tokenization. Defaults to English STOP_WORDS. */
  stopwords: ReadonlySet<string>;
  /** When true, weights/thresholds are calibrated (not defaults). Default false. */
  calibrated: boolean;
}

/** Default config — all values marked "uncalibrated" unless CRAG_CALIBRATED=true. */
export const DEFAULT_RECALL_QUALITY_CONFIG: RecallQualityConfig = {
  minDiversity: 0.3,
  minCoverage: 0.4,
  minRelevance: 0.5,
  minOverallScore: 0.4,
  weights: { relevance: 0.35, coverage: 0.25, diversity: 0.25, specificity: 0.15 },
  specificityDivisor: 300,
  specificityOptimalMin: 100,
  specificityOptimalMax: 500,
  idfBroadenRatio: 0.5,
  stopwords: STOP_WORDS,
  calibrated: false,
};

// ---------------------------------------------------------------------------
// Metric helpers (exported individually for unit testing)
// ---------------------------------------------------------------------------

/**
 * S45A.2: Relevance — average of SearchHit.score across all hits.
 * Scores are already cosine similarities in [0, 1].
 * Empty hits → 0.
 */
export function computeRelevance(hits: SearchHit[]): number {
  if (hits.length === 0) return 0;
  let sum = 0;
  for (const h of hits) sum += h.score;
  return sum / hits.length;
}

/**
 * S45A.3: Coverage — fraction of query subterms present in at least one
 * hit's `checkpoint.summary`. Tokenization removes stopwords and short terms.
 * Zero query terms after filtering → coverage = 1.0 (trivially satisfied).
 */
export function computeCoverage(
  query: string,
  hits: SearchHit[],
  stopwords: ReadonlySet<string> = STOP_WORDS,
): number {
  const queryTerms = tokenizeTerms(query, stopwords);
  if (queryTerms.length === 0) return 1.0;
  if (hits.length === 0) return 0;

  let foundCount = 0;
  for (const qt of queryTerms) {
    const found = hits.some((h) => {
      const summary = h.checkpoint.summary ?? "";
      return summary.toLowerCase().includes(qt);
    });
    if (found) foundCount++;
  }
  return foundCount / queryTerms.length;
}

/**
 * S45A.4: Diversity — average pairwise cosine distance (1 - similarity)
 * among hit embeddings. Filtered to hits with non-empty embedding arrays.
 *
 * Edge cases:
 *   - < 2 valid hits → 1.0 (nothing to compare)
 *   - empty-embedding checkpoints are skipped (no NaN path)
 */
export function computeDiversity(hits: SearchHit[]): number {
  const valid = hits.filter(
    (h) => Array.isArray(h.checkpoint.embedding) && h.checkpoint.embedding.length > 0,
  );
  if (valid.length < 2) return 1.0;

  let totalDist = 0;
  let pairCount = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const sim = cosineSimilarity(valid[i].checkpoint.embedding, valid[j].checkpoint.embedding);
      // cosineSimilarity returns 0 for empty vectors, but we've filtered those out.
      // NaN/Infinity could theoretically arise from degenerate floats; guard defensively.
      const dist = Number.isFinite(sim) ? 1 - sim : 1.0;
      totalDist += dist;
      pairCount++;
    }
  }
  return pairCount > 0 ? totalDist / pairCount : 1.0;
}

/**
 * S45A.5: Specificity — average chunk length (tokenEstimate) as a proxy
 * for information density.
 *
 * Formula (all constants from config, NOT hardcoded):
 *   avg = mean(tokenEstimate across hits; hits missing tokenEstimate → 0)
 *   If avg < optimalMin / 2 → 0 (too short to be specific)
 *   base = avg / divisor
 *   If avg > optimalMax:
 *     ramp = 1 - (avg - optimalMax) / optimalMax  // linear to 0 at 2*optimalMax
 *     capped = max(0, ramp)
 *     specificity = min(base, capped)
 *   else:
 *     specificity = min(base, 1)
 *
 * Edge cases: empty hits → 1.0 (nothing to penalize).
 */
export function computeSpecificity(
  hits: SearchHit[],
  config: Pick<RecallQualityConfig, "specificityDivisor" | "specificityOptimalMin" | "specificityOptimalMax">,
): number {
  if (hits.length === 0) return 1.0;

  const { specificityDivisor: divisor, specificityOptimalMin: optMin, specificityOptimalMax: optMax } = config;

  let sum = 0;
  for (const h of hits) {
    sum += h.checkpoint.tokenEstimate ?? 0;
  }
  const avg = sum / hits.length;

  // Below optMin/2 → too short to be specific
  if (avg < optMin / 2) return 0;

  const base = divisor > 0 ? avg / divisor : 0;
  const clamped = base > 1 ? 1 : base;

  if (avg > optMax) {
    // Linear ramp-down from optMax to 0 at 2*optMax
    const ramp = optMax > 0 ? 1 - (avg - optMax) / optMax : 0;
    const capped = ramp > 0 ? ramp : 0;
    return clamped < capped ? clamped : capped;
  }
  return clamped;
}

// ---------------------------------------------------------------------------
// Composite evaluation
// ---------------------------------------------------------------------------

/**
 * Normalize a four-weight vector so its components sum to 1.0.
 * If all weights are 0, return equal weights (0.25 each).
 * Used defensively since users may set non-sum-1 weights via env.
 */
export function normalizeWeights(w: RecallQualityWeights): RecallQualityWeights {
  const sum = w.relevance + w.coverage + w.diversity + w.specificity;
  if (sum === 0) return { relevance: 0.25, coverage: 0.25, diversity: 0.25, specificity: 0.25 };
  return {
    relevance: w.relevance / sum,
    coverage: w.coverage / sum,
    diversity: w.diversity / sum,
    specificity: w.specificity / sum,
  };
}

/**
 * S45A.6: Evaluate recall quality — compute all four metrics and return a
 * composite result with pass/fail + recommendation.
 */
export function evaluateRecall(
  query: string,
  hits: SearchHit[],
  config: RecallQualityConfig,
): RecallQualityResult {
  const weights = normalizeWeights(config.weights);
  const breakdown: RecallQualityBreakdown = {
    relevance: computeRelevance(hits),
    coverage: computeCoverage(query, hits, config.stopwords),
    diversity: computeDiversity(hits),
    specificity: computeSpecificity(hits, config),
  };

  const score =
    weights.relevance * breakdown.relevance +
    weights.coverage * breakdown.coverage +
    weights.diversity * breakdown.diversity +
    weights.specificity * breakdown.specificity;

  const pass =
    score >= config.minOverallScore &&
    breakdown.relevance >= config.minRelevance &&
    breakdown.coverage >= config.minCoverage &&
    breakdown.diversity >= config.minDiversity;

  const recommendation = buildRecommendation(breakdown, score, config);

  return {
    pass,
    score,
    breakdown,
    recommendation,
    uncalibrated: !config.calibrated,
    weights,
  };
}

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable recommendation based on which metric is lowest.
 * Uses env-overridable thresholds from config (not hardcoded).
 */
function buildRecommendation(
  breakdown: RecallQualityBreakdown,
  score: number,
  config: RecallQualityConfig,
): string | null {
  // Check each metric against its threshold (lowest first for specificity).
  const issues: string[] = [];

  if (breakdown.diversity < config.minDiversity) {
    issues.push("chunks are too similar — consider expanding K or using MMR");
  }
  if (breakdown.coverage < config.minCoverage) {
    issues.push("query terms not well covered — consider query expansion");
  }
  if (breakdown.relevance < config.minRelevance) {
    issues.push("chunks may be irrelevant — consider stricter threshold");
  }
  if (score < config.minOverallScore) {
    issues.push("quality is low — recommend re-retrieval with expanded query");
  }

  return issues.length > 0 ? issues.join("; ") : null;
}

// ---------------------------------------------------------------------------
// Unified entry point (pi-agnostic, matches task spec)
// ---------------------------------------------------------------------------

export interface RecallMetrics {
  /** Per-metric breakdown. */
  breakdown: RecallQualityBreakdown;
  /** Weighted composite score. */
  score: number;
  /** Whether quality passes all thresholds. */
  pass: boolean;
  /** Human-readable recommendation. */
  recommendation: string | null;
  /** Whether default config was used (uncalibrated). */
  uncalibrated: boolean;
}

/**
 * Compute recall quality metrics for a set of search hits.
 *
 * Pi-agnostic: takes query text and SearchHit results directly, no pi types.
 * The `config` parameter is optional — when omitted, DEFAULT_RECALL_QUALITY_CONFIG
 * is used (labelled uncalibrated).
 *
 * This is the primary export for external callers (e.g., recall.ts integration).
 */
export function computeRecallMetrics(
  query: string,
  results: SearchHit[],
  config?: Partial<RecallQualityConfig>,
): RecallMetrics {
  const effectiveConfig: RecallQualityConfig = {
    ...DEFAULT_RECALL_QUALITY_CONFIG,
    ...config,
    // Merge weights shallowly if both sides exist
    weights: {
      ...DEFAULT_RECALL_QUALITY_CONFIG.weights,
      ...(config?.weights ?? {}),
    },
  };

  const result = evaluateRecall(query, results, effectiveConfig);

  return {
    breakdown: result.breakdown,
    score: result.score,
    pass: result.pass,
    recommendation: result.recommendation,
    uncalibrated: result.uncalibrated,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize text into lowercased alphanumeric terms, filtering stop words
 * and terms shorter than 3 characters.
 */
function tokenizeTerms(text: string, stopwords: ReadonlySet<string>): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

/**
 * Estimate block tokens for a piece of text (rough approximation).
 * Used by the specificity metric fallback when tokenEstimate is missing.
 */
export function estimateBlockTokens(text: string): number {
  // ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}
