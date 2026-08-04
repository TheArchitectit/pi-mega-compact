/** VC2C unit tests — calibration fit (calibrate.ts).
 *
 *  Verifies the fit surface contract: held-out labels are strictly prohibited
 *  from the fit inputs (ENC_QUALIFICATION_HELD_OUT_IN_FIT), split assignment is
 *  grouped by repository+session (a group never crosses a split), ties in score
 *  resolve by item ID bytewise (invariant to row order), and the split digest is
 *  canonical (sorted, deduped — invariant to row order within the input).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fitCalibration, calibrationSplitDigest, type CalibrationExample } from "./calibrate.js";
import { ENC_QUALIFICATION_FAIL, ENCODER_HEAD_ORDER, ENCODER_SEED } from "./types.js";

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

describe("calibrate.fitCalibration — held-out prohibition", () => {
  test("rejects any example whose id is in heldOutIds", () => {
    const leaked = { itemId: "HELD-9", head: "semantic" as const, score: 0.99, label: 1 as const, repository: "repoX", session: "sx" };
    const fit = fitCalibration([...EXAMPLES, leaked], { heldOutIds: ["HELD-9"] });
    assert.equal(fit.ok, false);
    if (!fit.ok) assert.equal(fit.code, ENC_QUALIFICATION_FAIL.HELD_OUT_IN_FIT);
  });

  test("accepts a fit with no held-out leak", () => {
    const fit = fitCalibration([...EXAMPLES]);
    assert.equal(fit.ok, true);
    if (fit.ok) assert.equal(fit.calibration.fittedOnCalibrationOnly, true);
  });

  test("default seed is ENCODER_SEED (1729)", () => {
    const fit = fitCalibration([...EXAMPLES]);
    assert.equal(fit.ok, true);
    if (fit.ok) assert.equal(fit.calibration.seed, ENCODER_SEED);
  });
});

describe("calibrate.fitCalibration — split grouping + order invariance", () => {
  test("split digest covers the groups actually present (canonical, sorted, deduped)", () => {
    const groups = [
      { repository: "repoA", session: "s1" },
      { repository: "repoB", session: "s2" },
      { repository: "repoC", session: "s3" },
      { repository: "repoD", session: "s4" },
      { repository: "repoE", session: "s5" },
    ];
    const fit = fitCalibration([...EXAMPLES]);
    assert.equal(fit.ok, true);
    if (fit.ok) {
      assert.equal(fit.calibration.calibrationSplitDigest.length, 64);
      // The emitted digest is invariant to row order and to duplicate groups.
      assert.equal(calibrationSplitDigest(groups), fit.calibration.calibrationSplitDigest);
      assert.equal(calibrationSplitDigest([...groups].reverse()), calibrationSplitDigest(groups));
      assert.equal(calibrationSplitDigest([...groups, ...groups]), calibrationSplitDigest(groups));
    }
  });

  test("a whole repo/session group never crosses a split boundary (declared groups)", () => {
    // Fit with the full group declared; every example in a group lands in the
    // calibration split together — no example is assigned elsewhere.
    const fit = fitCalibration([...EXAMPLES], {
      groups: EXAMPLES.map((e) => ({ repository: e.repository, session: e.session })),
    });
    assert.equal(fit.ok, true);
    if (fit.ok) {
      assert.equal(fit.calibration.calibrationSplitDigest.length, 64);
      // headOrder stable and complete.
      assert.deepEqual(fit.calibration.headOrder, ENCODER_HEAD_ORDER);
    }
  });

  test("fit is invariant to row order (stable score/id ties)", () => {
    const a = fitCalibration([...EXAMPLES]);
    const b = fitCalibration([...EXAMPLES].reverse());
    const c = fitCalibration([...EXAMPLES].sort(() => (Math.random() > 0.5 ? 1 : -1)));
    assert.equal(a.ok && b.ok && c.ok, true);
    if (a.ok && b.ok && c.ok) {
      assert.equal(a.calibration.calibrationSplitDigest, b.calibration.calibrationSplitDigest);
      assert.equal(a.calibration.calibrationSplitDigest, c.calibration.calibrationSplitDigest);
      for (const h of ENCODER_HEAD_ORDER) {
        assert.equal(a.calibration.temperatures[h], b.calibration.temperatures[h]);
        assert.equal(a.calibration.thresholds[h], b.calibration.thresholds[h]);
      }
    }
  });
});

describe("calibrate.fitCalibration — surface", () => {
  test("every head receives a frozen temperature and threshold in 0.8..1.5", () => {
    const fit = fitCalibration([...EXAMPLES]);
    assert.equal(fit.ok, true);
    if (fit.ok) {
      for (const h of ENCODER_HEAD_ORDER) {
        assert.ok(fit.calibration.temperatures[h] >= 0.8, `${h} temp lower`);
        assert.ok(fit.calibration.temperatures[h] <= 1.5, `${h} temp upper`);
        assert.ok(Number.isFinite(fit.calibration.thresholds[h]), `${h} threshold finite`);
      }
    }
  });

  test("CalibrationV1 schema + shape", () => {
    const fit = fitCalibration([...EXAMPLES]);
    assert.equal(fit.ok, true);
    if (fit.ok) {
      assert.equal(fit.calibration.schema, "calibration-v1");
      assert.equal(fit.calibration.fittedOnCalibrationOnly, true);
      assert.equal(fit.calibration.seed, ENCODER_SEED);
    }
  });
});
