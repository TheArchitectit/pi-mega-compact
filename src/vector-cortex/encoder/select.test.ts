/** VC2C unit tests — atomic qualification selection (select.ts).
 *
 *  Verifies the atomic eligibility check: EVERY MODEL_ASSET + per-head
 *  EVALUATION threshold must pass for mode A; a single failed field demotes the
 *  ENTIRE candidate (no partial A) with the demotion code + failed field. Also
 *  covers the unique corrupt-qualification-manifest injection
 *  (ENC_QUALIFICATION_DIGEST_MISMATCH -> choose B) and the stable qualified
 *  record surface (QualifiedEncoderV1).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectQualifiedEncoder, qualificationManifestDigest, type QualificationCandidate } from "./select.js";
import { fitCalibration, type CalibrationExample } from "./calibrate.js";
import { ENC_QUALIFICATION_FAIL, type CalibrationV1, type EncoderHeldOutMetrics } from "./types.js";

/** Locate the repo root (the directory holding `conformance/vector-cortex`). */
const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
/** SHA-256 of the REAL committed ModelManifestV1 — what assetDigest must pin. */
function realManifestDigest(): string {
  // guardrails-allow PREVENT-PI-004: local committed asset filesystem read (loopback)
  return createHash("sha256")
    .update(readFileSync(join(REPO_ROOT, "assets", "vector-cortex", "encoder-v1", "manifest.json")))
    .digest("hex");
}

const EXAMPLES: readonly CalibrationExample[] = [
  { itemId: "a1", head: "semantic", score: 0.2, label: 0, repository: "repoA", session: "s1" },
  { itemId: "a2", head: "semantic", score: 0.9, label: 1, repository: "repoA", session: "s1" },
  { itemId: "b1", head: "dependency", score: 0.1, label: 0, repository: "repoB", session: "s2" },
  { itemId: "b2", head: "dependency", score: 0.8, label: 1, repository: "repoB", session: "s2" },
  { itemId: "c1", head: "contradiction", score: 0.3, label: 0, repository: "repoC", session: "s3" },
  { itemId: "c2", head: "contradiction", score: 0.85, label: 1, repository: "repoC", session: "s3" },
  { itemId: "d1", head: "cacheStability", score: 0.15, label: 0, repository: "repoD", session: "s4" },
  { itemId: "d2", head: "cacheStability", score: 0.95, label: 1, repository: "repoD", session: "s4" },
  { itemId: "e1", head: "payloadRouting", score: 0.4, label: 0, repository: "repoE", session: "s5" },
  { itemId: "e2", head: "payloadRouting", score: 0.7, label: 1, repository: "repoE", session: "s5" },
];

function cal(): CalibrationV1 {
  const fit = fitCalibration([...EXAMPLES]);
  if (!fit.ok) throw new Error("fit failed");
  return fit.calibration;
}

function full(): EncoderHeldOutMetrics {
  return {
    semantic: { spearman: 0.8, recallAt10: 0.95 },
    dependency: { precision: 0.98, recall: 0.96 },
    contradiction: { precision: 0.99, recall: 0.95, ece: 0.03 },
    cacheStability: { precision: 1.0, recall: 0.95 },
    payloadRouting: { macroF1: 0.98, exactAnchorRecall: 1.0 },
    reconstruction: { votesOk: true, dependencyClosureRecall: 1.0, taskSuccessNonInferior: true },
  };
}

function candidate(over?: Partial<QualificationCandidate>): QualificationCandidate {
  return {
    modelVersion: "vc2c-test",
    asset: { maxTokens: 512, latencyP95Ms: 20, rssDeltaMib: 40 },
    onnxDigest: "a".repeat(64),
    // Real ModelManifestV1 asset-manifest digest (SHA-256 of the committed
    // manifest.json bytes) — distinct from onnxDigest and calibration split
    // digest; asserted equal to what the qualified record pins (Q01).
    assetManifestDigest: realManifestDigest(),
    calibration: cal(),
    heldOut: full(),
    ...over,
  };
}

/** Immutable variant builders for a single weakened head (fields are readonly). */
function dep(pr: number): EncoderHeldOutMetrics {
  return { ...full(), dependency: { precision: pr, recall: 0.96 } };
}
function semantic(spearman: number): EncoderHeldOutMetrics {
  return { ...full(), semantic: { spearman, recallAt10: 0.95 } };
}
function contradiction(ece: number): EncoderHeldOutMetrics {
  return { ...full(), contradiction: { precision: 0.99, recall: 0.95, ece } };
}
function cache(precision: number): EncoderHeldOutMetrics {
  return { ...full(), cacheStability: { precision, recall: 0.95 } };
}
function prRouting(exactAnchorRecall: number): EncoderHeldOutMetrics {
  return { ...full(), payloadRouting: { macroF1: 0.98, exactAnchorRecall } };
}
function noVotes(): EncoderHeldOutMetrics {
  const m = full();
  return { ...m, reconstruction: { ...m.reconstruction, votesOk: false } };
}

describe("select.selectQualifiedEncoder — atomic eligibility (A)", () => {
  test("a fully satisfactory candidate qualifies as mode A", () => {
    const v = selectQualifiedEncoder(candidate());
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.mode, "A");
      assert.equal(v.code, null);
      assert.equal(v.qualified.schema, "qualified-encoder-v1");
      assert.equal(v.qualified.mode, "A");
      assert.equal(v.qualified.onnxDigest, "a".repeat(64));
      // assetDigest pins the REAL committed ModelManifestV1 asset-manifest
      // digest (SHA-256 of manifest.json bytes) — verified against the true
      // committed bytes, not a sentinel, and distinct from the calibration split
      // digest recorded as calibrationDigest (Q01).
      assert.equal(v.qualified.assetDigest, realManifestDigest());
      assert.notEqual(v.qualified.assetDigest, v.qualified.calibrationDigest);
      assert.equal(v.qualified.calibrationDigest, v.qualified.calibration.calibrationSplitDigest);
    }
  });

  test("every MODEL_ASSET asset field is enforced (atomic)", () => {
    const tokens = selectQualifiedEncoder(candidate({ asset: { maxTokens: 600, latencyP95Ms: 20, rssDeltaMib: 40 } }));
    assert.equal(tokens.ok, false);
    if (!tokens.ok) {
      assert.equal(tokens.code, ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED);
      assert.equal(tokens.failedField, "asset.maxTokens");
    }

    const latency = selectQualifiedEncoder(candidate({ asset: { maxTokens: 512, latencyP95Ms: 200, rssDeltaMib: 40 } }));
    assert.equal(latency.ok, false);
    if (!latency.ok) assert.equal(latency.failedField, "asset.latencyP95Ms");

    const rss = selectQualifiedEncoder(candidate({ asset: { maxTokens: 512, latencyP95Ms: 20, rssDeltaMib: 900 } }));
    assert.equal(rss.ok, false);
    if (!rss.ok) assert.equal(rss.failedField, "asset.rssDeltaMib");
  });
});

describe("select.selectQualifiedEncoder — per-head thresholds", () => {
  test("one failed causal head (dependency) demotes the ENTIRE A to B (atomic)", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: dep(0.9) }));
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.code, ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED);
      assert.equal(v.mode, "B");
      assert.equal(v.failedField, "head.dependency");
    }
  });

  test("a semantic failure demotes A", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: semantic(0.5) }));
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.failedField, "head.semantic");
  });

  test("a contradiction ECE failure demotes A", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: contradiction(0.2) }));
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.failedField, "head.contradiction");
  });

  test("a cache precision failure (below .999) demotes A", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: cache(0.95) }));
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.failedField, "head.cacheStability");
  });

  test("a reconstruction violation demotes A", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: noVotes() }));
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.failedField, "reconstruction");
  });

  test("a payloadRouting exact/anchor recall failure (zero-tolerance) demotes A", () => {
    const v = selectQualifiedEncoder(candidate({ heldOut: prRouting(0.9) }));
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.code, ENC_QUALIFICATION_FAIL.THRESHOLD_FAILED);
      assert.equal(v.mode, "B");
      assert.equal(v.failedField, "head.payloadRouting");
    }
  });
});

describe("select.qualificationManifestDigest + corrupt injection", () => {
  test("digest is deterministic and stable", () => {
    const c = cal();
    assert.equal(qualificationManifestDigest(c), qualificationManifestDigest(c));
    assert.equal(qualificationManifestDigest(c).length, 64);
  });

  test("a corrupt qualification manifest after calibration demotes A to B (DIGEST_MISMATCH)", () => {
    const c = cal();
    const sealed = qualificationManifestDigest(c);
    const corrupt: CalibrationV1 = { ...c, seed: c.seed + 1 };
    const v = selectQualifiedEncoder(
      candidate({ calibration: corrupt, expectedQualificationManifestDigest: sealed }),
    );
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.code, ENC_QUALIFICATION_FAIL.DIGEST_MISMATCH);
      assert.equal(v.mode, "B", "digest mismatch chooses B");
      assert.equal(v.failedField, "qualificationManifestDigest");
    }
  });

  test("a matching qualification manifest digest does not demote", () => {
    const v = selectQualifiedEncoder(
      candidate({ expectedQualificationManifestDigest: qualificationManifestDigest(cal()) }),
    );
    assert.equal(v.ok, true);
  });
});
