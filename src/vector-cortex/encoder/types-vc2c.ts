/**
 * vector-cortex/encoder/types-vc2c.ts — VC2C qualification + calibration
 * contracts (QualifiedEncoderV1 / CalibrationV1 / EVALUATION_THRESHOLDS).
 *
 * Extracted from types.ts (delegate-shell split) when types.ts crossed the
 * 300-line soft limit. types.ts re-exports everything here; consumers import
 * from types.ts unchanged.
 *
 * Pi-agnostic and dependency-free (PREVENT-PI-004). No `any` (PREVENT-011).
 */

import type { EncoderHeadName } from "./types.js";

/**
 * Held-out metrics recorded as qualification evidence for a candidate asset
 * (EVALUATION.md §metrics). Semantic metrics are Spearman rho + recall@10;
 * dependency directed precision/recall; contradiction precision/recall/ECE;
 * cache precision/recall; payload-routing macro-F1 + exact/anchor recall;
 * reconstruction is the binary causality/exact/closure/task-success set. The
 * qualification decision (task 3 `select.ts`) consumes ONLY the per-head rows
 * this record carries; the true EVALUATION thresholds are the normative
 * constants in MODEL_ASSET (mirrored in `EVALUATION_THRESHOLDS` below).
 */
export interface EncoderHeldOutMetrics {
  /** Semantic: Spearman rho (>= .75) and recall@10 (>= .90). */
  readonly semantic: { readonly spearman: number; readonly recallAt10: number };
  /** Dependency: directed precision (>= .97) and recall (>= .95). */
  readonly dependency: { readonly precision: number; readonly recall: number };
  /** Contradiction: precision (>= .98), recall (>= .90), ECE (<= .05). */
  readonly contradiction: { readonly precision: number; readonly recall: number; readonly ece: number };
  /** Cache: precision (>= .999, zero false-stable) and recall (>= .90). */
  readonly cacheStability: { readonly precision: number; readonly recall: number };
  /** Payload routing: macro-F1 (>= .97) and exact/anchor recall (1.0). */
  readonly payloadRouting: { readonly macroF1: number; readonly exactAnchorRecall: number };
  /** Reconstruction: binary gates — zero causal/tool/anchor/exact violations. */
  readonly reconstruction: {
    readonly votesOk: boolean;
    readonly dependencyClosureRecall: number;
    readonly taskSuccessNonInferior: boolean;
  };
}

/** Normative per-head + asset qualification thresholds (MODEL_ASSET §qualification
 *  + EVALUATION.md §metrics). These are the constants `select.ts` evaluates the
 *  candidate's held-out metrics against (task 3 atomic check). */
export const EVALUATION_THRESHOLDS = {
  semantic: { spearman: 0.75, recallAt10: 0.9 },
  dependency: { precision: 0.97, recall: 0.95 },
  contradiction: { precision: 0.98, recall: 0.9, ece: 0.05 },
  cacheStability: { precision: 0.999, recall: 0.9 },
  payloadRouting: { macroF1: 0.97, exactAnchorRecall: 1.0 },
  reconstruction: { dependencyClosureRecall: 1.0 },
  asset: { maxTokens: 512, maxLatencyP95Ms: 40, maxRssDeltaMib: 150 },
} as const;

/**
 * CalibrationV1 — fitted temperature/isotonic calibration, frozen on the
 * CALIBRATION split only (VC2C task 2). Held-out test labels NEVER enter the
 * fit inputs (calibration-fit prohibition). The split digest proves the exact
 * calibration assignment (grouped by repository+session); the frozen temp/threshold
 * values are what `select.ts` stamps into a `QualifiedEncoderV1`.
 */
export interface CalibrationV1 {
  readonly schema: "calibration-v1";
  readonly headOrder: readonly EncoderHeadName[];
  /** SHA-256 of the calibration split assignment (grouped repository+session). */
  readonly calibrationSplitDigest: string;
  /** Fitted on the calibration split only; held-out labels excluded from fit. */
  readonly fittedOnCalibrationOnly: true;
  /** Frozen per-head temperature (isotonic calibration reference points). */
  readonly temperatures: Readonly<Record<EncoderHeadName, number>>;
  /** Frozen per-head decision thresholds for the qualified decision. */
  readonly thresholds: Readonly<Record<EncoderHeadName, number>>;
  /** Seed of the deterministic calibration fit. */
  readonly seed: number;
}

/**
 * QualifiedEncoderV1 — the VC2C-owned eligibility record (mode A). Produced by
 * `select.ts` ONLY when EVERY MODEL_ASSET + per-head EVALUATION threshold
 * passes (atomic — one failed field demotes all of A). Pins the asset digest,
 * the calibration digest, the held-out metrics that justified eligibility, and
 * the calibration reference, so VC3A receives a fully self-describing candidate.
 */
export interface QualifiedEncoderV1 {
  readonly schema: "qualified-encoder-v1";
  readonly modelVersion: string;
  readonly mode: "A";
  /** SHA-256 of the asset manifest bytes (ModelManifestV1) that qualified.
   *  Identical semantics to the dashboard health card's `encoderAssetDigest`
   *  (both hash the committed manifest.json ModelManifestV1 bytes), so
   *  downstream consumers (VC3A) pin the same digest across the seam. */
  readonly assetDigest: string;
  /** SHA-256 of the calibration split assignment (grouped repository+session)
   *  that the CalibrationV1 was fitted on — the calibration's core identity. */
  readonly calibrationDigest: string;
  /** SHA-256 of the qualified asset's verified ONNX bytes (digest-pinned). */
  readonly onnxDigest: string;
  /** Held-out metrics recorded as the eligibility evidence. */
  readonly heldOut: EncoderHeldOutMetrics;
  /** Calibration reference this qualification is grounded in. */
  readonly calibration: CalibrationV1;
}

/** VC2C-specific qualification failure codes (returned, never thrown). */
export const ENC_QUALIFICATION_FAIL = {
  /** The qualification manifest hash does not match the calibration that was fit
   *  (corrupt qualification manifest after calibration before selection). */
  DIGEST_MISMATCH: "ENC_QUALIFICATION_DIGEST_MISMATCH",
  /** One or more per-head EVALUATION thresholds failed (demotes all of A). */
  THRESHOLD_FAILED: "ENC_QUALIFICATION_THRESHOLD_FAILED",
  /** An asset-field qualification check (asset/latency/RSS) failed. */
  ASSET_FAILED: "ENC_QUALIFICATION_ASSET_FAILED",
  /** Calibration was attempted using held-out labels (fit prohibition). */
  HELD_OUT_IN_FIT: "ENC_QUALIFICATION_HELD_OUT_IN_FIT",
} as const;

/** The 4 registered VC2C conformance IDs (task 1: "register ENC-017..020"). */
export const ENC2C_IDS: readonly string[] = [
  "ENC-017",
  "ENC-018",
  "ENC-019",
  "ENC-020",
];
