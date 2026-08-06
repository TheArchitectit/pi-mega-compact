/** VC2B acceptance — ENC-009..016 conformance rows + the ENC-HEAD-001 /
 *  ENC-ZERO-002 / ENC-FALLBACK-003 named assertions, resolved through the REAL
 *  heads/trigram producers (no mocks). Extracted from vc2b-acceptance.test.ts so
 *  the aggregator stays under the soft line limit. Context (fixture loader,
 *  shared token/order constants) is injected by the aggregator to avoid a
 *  circular import.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ENC2B_IDS,
  ENCODER_HEAD_DIMS,
  type EncoderHeadName,
} from "./encoder/types.js";
import { encodeVectorSet, projectHead, l2Norm } from "./encoder/heads.js";
import {
  embedTrigram512,
  ENCODER_TRIGRAM_WIDTH,
  selectTrigramBFallback,
} from "./encoder/trigram.js";
import type { EFixture } from "./vc2b-acceptance.test.js";

export interface ConformanceCtx {
  fixture: (id: string) => EFixture;
  SET_TOKENS: number[];
  EMPTY_TOKENS: number[];
  ORDERED_DIMS: number[];
}

export function registerConformanceRows(ctx: ConformanceCtx): void {
  const { fixture, SET_TOKENS, EMPTY_TOKENS, ORDERED_DIMS } = ctx;

  // Suite 2 — ENC-009..016 conformance rows through the real producers
  describe("ENC-009..016 conformance rows", () => {
    test("ENC-009: full-set produces five heads with ordered dims", () => {
      const fx = fixture("ENC-009");
      assert.equal(fx.expected.ok, true);
      const set = encodeVectorSet(SET_TOKENS);
      assert.equal(set.heads.length, fx.expected.heads);
      assert.deepEqual(
        set.heads.map((h) => h.dim),
        fx.expected.dims,
        "ordered dims",
      );
    });

    for (const id of ENC2B_IDS.slice(1, 6)) {
      test(`${id}: ${fixture(id).input.head} head emits its declared dim`, () => {
        const fx = fixture(id);
        assert.equal(fx.expected.ok, true);
        const head = fx.input.head as EncoderHeadName;
        assert.ok(head);
        const hv = projectHead(head, SET_TOKENS);
        assert.equal(hv.dim, ENCODER_HEAD_DIMS[head]);
        assert.equal(hv.dim, fx.expected.dim, "declared dim");
        assert.equal(hv.values.length, hv.dim);
      });
    }

    test("ENC-015: zero-input produces finite all-zero vectors for every head", () => {
      const fx = fixture("ENC-015");
      assert.equal(fx.expected.ok, true);
      assert.equal(fx.expected.zero, true);
      const set = encodeVectorSet(EMPTY_TOKENS);
      assert.equal(set.heads.length, fx.expected.heads);
      for (const hv of set.heads) {
        for (const v of hv.values) assert.equal(Number.isFinite(v), true, "finite");
        assert.equal(hv.values.every((v) => v === 0), true, `head ${hv.head} all-zero`);
        assert.equal(l2Norm(hv.values), 0);
      }
    });

    test("ENC-016: asset-free trigram B emits 512 dims", () => {
      const fx = fixture("ENC-016");
      assert.equal(fx.expected.ok, true);
      assert.equal(fx.expected.mode, "B");
      assert.equal(fx.expected.width, 512);
      const v = embedTrigram512("the model is removed but trigram B still works");
      assert.equal(v.length, ENCODER_TRIGRAM_WIDTH);
      assert.equal(v.length, 512);
      const n = l2Norm(v);
      assert.equal(n === 0 || Math.abs(n - 1) <= 1e-6, true);
    });
  });

  // Suite 3 — named assertions
  describe("VC2B named assertions", () => {
    test("ENC-HEAD-001: all five output shapes match ordered dims", () => {
      const fx = fixture("ENC-HEAD-001");
      assert.equal(fx.expected.ok, true);
      const set = encodeVectorSet(SET_TOKENS);
      assert.deepEqual(
        set.heads.map((h) => h.dim),
        ORDERED_DIMS,
      );
    });
    test("ENC-ZERO-002: empty input produces finite zero vectors", () => {
      const fx = fixture("ENC-ZERO-002");
      assert.equal(fx.expected.ok, true);
      const set = encodeVectorSet(EMPTY_TOKENS);
      for (const hv of set.heads) {
        assert.equal(hv.values.every((v) => v === 0), true);
        assert.equal(hv.values.every((v) => Number.isFinite(v)), true);
      }
    });
    test("ENC-FALLBACK-003: removed model still yields 512d trigram B", () => {
      const fx = fixture("ENC-FALLBACK-003");
      assert.equal(fx.expected.ok, true);
      assert.equal(fx.expected.mode, "B");
      assert.equal(fx.expected.width, 512);
      // The learned asset is gone (asset dir absent); the asset-free trigram B
      // still produces a full 512-dim vector — no import of the learned asset.
      const v = embedTrigram512("no learned model present, trigram independent");
      assert.equal(v.length, 512);
      const sel = selectTrigramBFallback();
      assert.equal(sel.mode, "B");
      assert.equal(sel.dim, 512);
    });
  });
}
