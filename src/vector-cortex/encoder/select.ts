/**
 * vector-cortex/encoder/select.ts — VC2C atomic qualification selection (task 3).
 *
 * Selects mode A (a `QualifiedEncoderV1`) ONLY when EVERY MODEL_ASSET
 * constraint AND every per-head EVALUATION threshold passes — the eligibility
 * check is ATOMIC: any single failed field demotes the ENTIRE candidate to
 * mode B/C (never a partial A). The failed field is reported so the caller/UI
 * can inspect which threshold tripped.
 *
 *   - asset fields (MODEL_ASSET §qualification): maxTokens <= 512, p95 latency
 *     <= 40 ms, encoder RSS delta <= 150 MiB.
 *   - per-head EVALUATION thresholds (EVALUATION.md §metrics):
 *       semantic      spearman >= .75, recall@10 >= .90
 *       dependency    precision >= .97, recall >= .95
 *       contradiction precision >= .98, recall >= .90, ECE <= .05
 *       cacheStability precision >= .999, recall >= .90
 *       payloadRouting macro-F1 >= .97, exact/anchor recall = 1.0
 *   - reconstruction: zero causal/tool/anchor/exact violations, dependency
 *     closure recall = 1.0, task-success non-inferior to C.
 *
 * Unique failure injection: when a candidate supplies an expected
 * `qualificationManifestDigest` (the digest of the qualification manifest
 * sealed at calibration time) and the presented calibration digest differs,
 * selection returns ENC_QUALIFICATION_DIGEST_MISMATCH and demotes A — the
 * "corrupt qualification manifest after calibration but before selection" case.
 *
 * Emits `vector_cortex_encoder_qualification_passed` on success and
 * `vector_cortex_encoder_qualification_demoted` on any demotion, via the
 * flag-gated VC2C reporter. Pi-agnostic, zero network (PREVENT-PI-004), no
 * `any` (PREVENT-011).
 */

import { createHash } from "node:crypto";
import {
  ENC_QUALIFICATION_FAIL,
  EVALUATION_THRESHOLDS,
  type CalibrationV1,
  type EncoderHeldOutMetrics,
  type EncoderHeadName,
  type QualifiedEncoderV1,
} from "./types.js";
import {
  createEncoderQualificationReporter,
  type EncoderQualificationReporter,
} from "./emit-vc2c.js";

/** The MODEL_ASSET asset constraints a candidate must satisfy (subset that
 *  select.ts evaluates; the rest — supported matrix, opset, batch, digest — are
 *  enforced by the VC2A asset verification seam before a candidate exists). */
export interface CandidateAssetFacts {
  /** Declared/verified per-manifest token capacity (<= 512). */
  readonly maxTokens: number;
  /** Measured p95 inference latency (ms, <= 40). */
  readonly latencyP95Ms: number;
  /** Measured encoder RSS delta (MiB, <= 150). */
  readonly rssDeltaMib: number;
}

/** Inputs to the atomic eligibility check. */
export interface QualificationCandidate {
  readonly modelVersion: string;
  readonly asset: CandidateAssetFacts;
  /** The verified ONNX digest of the candidate asset. */
  readonly onnxDigest: string;
  /** Calibration digest the asset is qualified against (from `CalibrationV1`). */
  readonly calibration: CalibrationV1;
  /** Held-out metrics as evidence (EVALUATION.md). */
  readonly heldOut: EncoderHeldOutMetrics;
  /**
   * The qualification manifest digest sealed at calibration time. When supplied,
   * it must equal SHA-256 over the calibration manifest bytes; a mismatch is the
   * corrupt-qualification-manifest injection (ENC_QUALIFICATION_DIGEST_MISMATCH).
   */
  readonly expectedQualificationManifestDigest?: string;
}

export type QualificationVerdict =
  | { ok: true; mode: "A"; qualified: QualifiedEncoderV1; code: null }
  | { ok: false; mode: "B" | "C"; code: string; failedField: string | null };

/** Canonical digest over a CalibrationV1's stable identity (split digest, heads,
 *  temps, thresholds, seed) — the "qualification manifest digest". */
export function qualificationManifestDigest(calibration: CalibrationV1): string {
  const payload = JSON.stringify({
    headOrder: [...calibration.headOrder].sort(),
    splitDigest: calibration.calibrationSplitDigest,
    temps: calibration.temperatures,
    thresholds: calibration.thresholds,
    seed: calibration.seed,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** True when one per-head metric row clears its normative EVALUATION threshold. */
function headPasses(head: EncoderHeadName, m: EncoderHeldOutMetrics): boolean {
  switch (head) {
    case "semantic":
      return m.semantic.spearman >= EVALUATION_THRESHOLDS.semantic.spearman &&
        m.semantic.recallAt10 >= EVALUATION_THRESHOLDS.semantic.recallAt10;
    case "dependency":
      return m.dependency.precision >= EVALUATION_THRESHOLDS.dependency.precision &&
        m.dependency.recall >= EVALUATION_THRESHOLDS.dependency.recall;
    case "contradiction":
      return m.contradiction.precision >= EVALUATION_THRESHOLDS.contradiction.precision &&
        m.contradiction.recall >= EVALUATION_THRESHOLDS.contradiction.recall &&
        m.contradiction.ece <= EVALUATION_THRESHOLDS.contradiction.ece;
    case "cacheStability":
      return m.cacheStability.precision >= EVALUATION_THRESHOLDS.cacheStability.precision &&
        m.cacheStability.recall >= EVALUATION_THRESHOLDS.cacheStability.recall;
    case "payloadRouting":
      return m.payloadRouting.macroF1 >= EVALUATION_THRESHOLDS.payloadRouting.macroF1 &&
        m.payloadRouting.exactAnchorRecall >= EVALUATION_THRESHOLDS.payloadRouting.exactAnchorRecall;
  }
}

function reconstructionPasses(m: EncoderHeldOutMetrics): boolean {
  return (
    m.reconstruction.votesOk &&
    m.reconstruction.dependencyClosureRecall >= EVALUATION_THRESHOLDS.reconstruction.dependencyClosureRecall &&
    m.reconstruction.taskSuccessNonInferior
  );
}

function assetPasses(a: CandidateAssetFacts, failed: string[]): boolean {
  let ok = true;
  if (a.maxTokens > EVALUATION_THRESHOLDS.asset.maxTokens) { failed.push("asset.maxTokens"); ok = false; }
  if (a.latencyP95Ms > EVALUATION_THRESHOLDS.asset.maxLatencyP95Ms) { failed.push("asset.latencyP95Ms"); ok = false; }
  if (a.rssDeltaMib > EVALUATION_THRESHOLDS.asset.maxRssDeltaMib) { failed.push("asset.rssDeltaMib"); ok = false; }
  return ok;
}

/**
 * Atomic eligibility check across every MODEL_ASSET + per-head EVALUATION
 * threshold (task 3). Any single failed field demotes ALL of A (returns
 * `ok:false`); there is no partial qualification. On success returns a
 * `QualifiedEncoderV1` pinning asset/calibration digests + held-out evidence.
 */
export function selectQualifiedEncoder(
  candidate: QualificationCandidate,
  options: { reporter?: EncoderQualificationReporter } = {},
): QualificationVerdict {
  const reporter = options.reporter ?? createEncoderQualificationReporter();

  // Unique failure injection: corrupt qualification manifest between calibration
  // and selection. The sealed manifest digest must match the presented
  // calibration's digest; a mismatch demotes A to B/C with the dedicated code.
  if (candidate.expectedQualificationManifestDigest !== undefined) {
    const presented = qualificationManifestDigest(candidate.calibration);
    if (presented !== candidate.expectedQualificationManifestDigest) {
      reporter.qualificationDemoted({
        reason: ENC_QUALIFICATION_FAIL.DIGEST_MISMATCH,
        modelVersion: candidate.modelVersion,
        mode: "B",
      });
      return {
        ok: false,
        mode: "B",
        code: ENC_QUALIFICATION_FAIL.DIGEST_MISMATCH,
        failedField: "qualificationManifestDigest",
      };
    }
  }

  // Atomic: collect EVERY failed field across asset + all heads + reconstruction.
  const failed: string[] = [];
  assetPasses(candidate.asset, failed);
  const heads: EncoderHeadName[] = ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"];
  for (const h of heads) {
    if (!headPasses(h, candidate.heldOut)) failed.push(`head.${h}`);
  }
  if (!reconstructionPasses(candidate.heldOut)) failed.push("reconstruction");

  if (failed.length > 0) {
    // Any failed field demotes all of A — no partial A.
    reporter.qualificationDemoted({
      reason: ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED,
      failed: failed.join("/"),
      modelVersion: candidate.modelVersion,
      mode: "B",
    });
    return {
      ok: false,
      mode: "B",
      code: ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED,
      failedField: failed[0] ?? null,
    };
  }

  const qualified: QualifiedEncoderV1 = {
    schema: "qualified-encoder-v1",
    modelVersion: candidate.modelVersion,
    mode: "A",
    assetDigest: qualificationManifestDigest(candidate.calibration),
    calibrationDigest: candidate.calibration.calibrationSplitDigest,
    onnxDigest: candidate.onnxDigest,
    heldOut: candidate.heldOut,
    calibration: candidate.calibration,
  };
  reporter.qualificationPassed({
    modelVersion: candidate.modelVersion,
    mode: "A",
    assetDigest: qualified.assetDigest.slice(0, 12),
    calibrationDigest: qualified.calibrationDigest.slice(0, 12),
  });
  return { ok: true, mode: "A", qualified, code: null };
}
