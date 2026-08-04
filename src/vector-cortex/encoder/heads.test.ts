/**
 * VC2B heads unit tests (task 6). Covers ENC-HEAD-001 (five output shapes match
 * ordered dims), ENC-ZERO-002 (empty input -> finite zero vectors), the L2-norm
 * invariant (every norm is 0 or within 1e-6 of 1), repeat drift <= 1e-6, loss
 * weights, and the emit seam.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_DIM_ORDER,
  ENCODER_HEAD_LOSS_WEIGHTS,
  ENCODER_HEAD_LOSS_SUM,
  ENCODER_HEAD_ORDER,
  ENCODER_SEED,
} from "./types.js";
import {
  encodeVectorSet,
  projectHead,
  l2Normalize,
  l2Norm,
  headLossWeights,
} from "./heads.js";
import { createEncoderHeadsReporter, NOOP_VC2B_REPORTER } from "./emit-vc2b.js";

describe("VC2B head shapes", () => {
  test("ENC-HEAD-001: all five output shapes match ordered dims 384/128/128/64/32", () => {
    const set = encodeVectorSet([1, 2, 3, 4, 5]);
    assert.equal(set.schema, "vector-set-v1");
    assert.equal(set.heads.length, 5);
    assert.deepEqual(
      ENCODER_HEAD_ORDER,
      ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"],
    );
    assert.deepEqual(ENCODER_HEAD_DIM_ORDER, [384, 128, 128, 64, 32]);
    for (const hv of set.heads) {
      assert.equal(hv.dim, ENCODER_HEAD_DIMS[hv.head]);
      assert.equal(hv.values.length, hv.dim, `head ${hv.head} width`);
    }
    // Stable order: the i-th produced head is the i-th named head.
    set.heads.forEach((hv, i) => {
      assert.equal(hv.head, ENCODER_HEAD_ORDER[i], `head order at index ${i}`);
    });
  });

  test("each head's declared dim matches the normative map", () => {
    assert.equal(ENCODER_HEAD_DIMS.semantic, 384);
    assert.equal(ENCODER_HEAD_DIMS.dependency, 128);
    assert.equal(ENCODER_HEAD_DIMS.contradiction, 128);
    assert.equal(ENCODER_HEAD_DIMS.cacheStability, 64);
    assert.equal(ENCODER_HEAD_DIMS.payloadRouting, 32);
  });

  test("loss weights are exactly .35/.20/.20/.15/.10 and sum to 1", () => {
    const w = ENCODER_HEAD_LOSS_WEIGHTS;
    assert.equal(w.semantic, 0.35);
    assert.equal(w.dependency, 0.2);
    assert.equal(w.contradiction, 0.2);
    assert.equal(w.cacheStability, 0.15);
    assert.equal(w.payloadRouting, 0.1);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    assert.equal(Math.abs(total - ENCODER_HEAD_LOSS_SUM) < 1e-12, true);
    assert.equal(Math.abs(total - 1.0) < 1e-12, true);
    // headLossWeights() mirrors the constant table.
    assert.deepEqual(headLossWeights(), w);
  });

  test("seed constant is 1729", () => {
    assert.equal(ENCODER_SEED, 1729);
  });
});

describe("VC2B L2 normalization + repeat drift", () => {
  test("every produced vector has norm 0 or within 1e-6 of 1", () => {
    for (const tokens of [[1, 2, 3], [7], [], Array.from({ length: 128 }, (_, i) => i)]) {
      const set = encodeVectorSet(tokens);
      for (const hv of set.heads) {
        const n = l2Norm(hv.values);
        assert.equal(
          n === 0 || Math.abs(n - 1) <= 1e-6,
          true,
          `head ${hv.head} norm ${n} for ${tokens.length} tokens`,
        );
      }
    }
  });

  test("repeat drift <= 1e-6 across repeated seeded exports", () => {
    for (const tokens of [[1, 2, 3, 4], Array.from({ length: 64 }, (_, i) => i), []]) {
      const a = encodeVectorSet(tokens);
      const b = encodeVectorSet(tokens);
      for (let i = 0; i < a.heads.length; i++) {
        const va = a.heads[i]!.values;
        const vb = b.heads[i]!.values;
        assert.equal(va.length, vb.length);
        for (let j = 0; j < va.length; j++) {
          assert.equal(Math.abs(va[j]! - vb[j]!) <= 1e-6, true, `drift at head ${i} j ${j}`);
        }
      }
    }
  });

  test("l2Normalize maps a zero-norm input to an all-zero vector", () => {
    const zero = l2Normalize(new Float32Array(5));
    assert.equal(zero.length, 5);
    for (const v of zero) assert.equal(v, 0);
    assert.equal(l2Norm(zero), 0);
    // A non-trivial vector normalizes to unit norm.
    const raw = new Float32Array([3, 4, 0]);
    const normed = l2Normalize(raw);
    assert.equal(Math.abs(l2Norm(normed) - 1) <= 1e-6, true);
  });
});

describe("VC2B emit seam", () => {
  test("vector_cortex_encoder_heads_emitted fires on a VectorSetV1 production", () => {
    const emitted: string[] = [];
    const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
    encodeVectorSet([1, 2, 3], { reporter });
    assert.ok(emitted.includes("vector_cortex_encoder_heads_emitted"));
  });

  test("flag OFF yields zero emissions (byte-identical predecessor)", () => {
    const emitted: string[] = [];
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "0";
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      reporter.headsEmitted({});
      reporter.fallbackSelected({});
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.deepEqual(emitted, [], "flag OFF => no emissions");
    NOOP_VC2B_REPORTER.headsEmitted({});
    NOOP_VC2B_REPORTER.fallbackSelected({});
    assert.deepEqual(emitted, [], "noop reporter never emits");
  });

  test("flag ON: the reporter emits its named events", () => {
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "1";
    const emitted: string[] = [];
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      reporter.headsEmitted({ heads: 5 });
      reporter.fallbackSelected({ mode: "B" });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.ok(emitted.includes("vector_cortex_encoder_heads_emitted"));
    assert.ok(emitted.includes("vector_cortex_encoder_fallback_selected"));
  });

  test("projectHead returns the named head with the right dim and unit-or-zero norm", () => {
    const hv = projectHead("semantic", [1, 2, 3]);
    assert.equal(hv.head, "semantic");
    assert.equal(hv.dim, 384);
    assert.equal(hv.values.length, 384);
    const n = l2Norm(hv.values);
    assert.equal(n === 0 || Math.abs(n - 1) <= 1e-6, true);
  });
});
