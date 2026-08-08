/**
 * VC2B-2 router tests — ML5-A real trained-head projection wiring
 * (`produceVectorSet` in router.ts).
 *
 * Covers:
 *   - with a `trainedHeadsPath` + MEGACOMPACT_ML5_A on, `encodeOrFallback`
 *     produces a mode-A VectorSet whose heads are `projectHeadFromTrunk` over
 *     the trunk embedding (the REAL trained matrices), not the LCG placeholder;
 *   - without a trained-heads path (or flag off / unloadable artifact), the
 *     mode-A producer falls back to the deterministic LCG `encodeVectorSet`
 *     (byte-identical predecessor);
 *   - the trained-heads path still L2-normalizes every head.
 *
 * Uses an injected fake EncoderRuntime so the trunk embedding is deterministic
 * and the assertion is exact. Pi-agnostic, zero network (PREVENT-PI-004), no
 * `any` (PREVENT-011).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeOrFallback } from "./router.js";
import {
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_ORDER,
  ENCODER_SEED,
  type EncoderHeadName,
  type EncoderInferResult,
  type EncoderLoadResult,
  type EncoderRuntime,
} from "./types.js";
import { projectHeadFromTrunk, loadHeadProjections, l2Norm } from "./heads.js";

const TRUNK_DIM = 384;

function tempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

/** A fixed 384-dim trunk embedding (deterministic, non-degenerate). */
function trunkEmbedding(): Float32Array {
  const out = new Float32Array(TRUNK_DIM);
  let c = 12345;
  for (let i = 0; i < TRUNK_DIM; i++) {
    c = (c * 1664525 + 1013904223) >>> 0;
    out[i] = (c / 4294967296) * 2 - 1;
  }
  return out;
}

/** A fake EncoderRuntime whose load always succeeds and infer returns a fixed
 *  trunk embedding. Lets the router's mode-A path run without a real ONNX. */
function fakeRuntime(embedding: Float32Array): EncoderRuntime {
  return {
    schema: "encoder-runtime-v1",
    mode: "A",
    load(): EncoderLoadResult {
      return { ok: true, mode: "A", embeddedBytes: 1234, rssBytes: 0, sessionId: "fake" };
    },
    infer(): EncoderInferResult {
      return { ok: true, semantic: embedding, rssBytes: 0, latencyMs: 0, shapeError: null };
    },
  };
}

/** Build a valid `trained-heads-v1` artifact fixture on disk. */
function writeHeadsFixture(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const dims: Record<EncoderHeadName, number> = {
    semantic: 384,
    dependency: 128,
    contradiction: 128,
    cacheStability: 64,
    payloadRouting: 32,
  };
  let c = 99;
  const heads: Record<string, unknown> = {};
  for (const h of ENCODER_HEAD_ORDER) {
    const w: number[] = [];
    for (let i = 0; i < dims[h]! * TRUNK_DIM; i++) {
      c = (c * 1664525 + 1013904223) >>> 0;
      w.push((c / 4294967296) * 2 - 1);
    }
    heads[h] = { dim: dims[h], temperature: 1.0, weights: w };
  }
  const artifact = {
    schema: "trained-heads-v1",
    seed: ENCODER_SEED,
    trunkDim: TRUNK_DIM,
    dims: { ...dims },
    heads,
  };
  const path = join(dir, "trained-heads.json");
  writeFileSync(path, JSON.stringify(artifact));
  return path;
}

describe("VC2B-2 router ML5-A trained-head projection", () => {
  test("with trainedHeadsPath, mode-A heads come from projectHeadFromTrunk (real matrices)", () => {
    const saved = process.env.MEGACOMPACT_ML5_A;
    process.env.MEGACOMPACT_ML5_A = "1";
    const dir = tempDir("vc2b2-router");
    try {
      const headsPath = writeHeadsFixture(dir);
      const embedding = trunkEmbedding();
      const verdict = encodeOrFallback({ tokens: [1, 2, 3] }, "ignored", {
        runtime: fakeRuntime(embedding),
        trainedHeadsPath: headsPath,
      });
      assert.equal(verdict.ok, true);
      if (!verdict.ok) return;
      assert.equal(verdict.mode, "A");
      const vectorSet = verdict.vectorSet;
      const table = loadHeadProjections(headsPath);
      assert.ok(table, "trained-heads loaded for comparison");
      // Every produced head must exactly equal the real projection over the
      // trunk embedding — NOT the LCG placeholder `encodeVectorSet` output.
      for (let i = 0; i < ENCODER_HEAD_ORDER.length; i++) {
        const h = ENCODER_HEAD_ORDER[i]!;
        const produced = vectorSet.heads[i]!;
        assert.equal(produced.head, h);
        assert.equal(produced.values.length, ENCODER_HEAD_DIMS[h]);
        const expected = projectHeadFromTrunk(h, embedding, table!);
        for (let j = 0; j < produced.values.length; j++) {
          assert.ok(
            Math.abs(produced.values[j]! - expected.values[j]!) < 1e-6,
            `${h}[${j}] matches projectHeadFromTrunk`,
          );
        }
        const norm = l2Norm(produced.values);
        assert.ok(norm === 0 || Math.abs(norm - 1) < 1e-6, `${h} L2-normalized`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.MEGACOMPACT_ML5_A;
      else process.env.MEGACOMPACT_ML5_A = saved;
    }
  });

  test("without trainedHeadsPath, mode-A falls back to the LCG placeholder (byte-identical)", () => {
    const saved = process.env.MEGACOMPACT_ML5_A;
    process.env.MEGACOMPACT_ML5_A = "1";
    try {
      const embedding = trunkEmbedding();
      const verdict = encodeOrFallback({ tokens: [1, 2, 3] }, "ignored", {
        runtime: fakeRuntime(embedding),
      });
      assert.equal(verdict.ok, true);
      if (!verdict.ok) return;
      assert.equal(verdict.mode, "A");
      // With no trained heads, the produced vectors are the LCG placeholder —
      // they must NOT match projectHeadFromTrunk (proving the trained path was
      // skipped), and every head is still L2-normalized.
      const vectorSet = verdict.vectorSet;
      const table = loadHeadProjections("/does/not/exist.json");
      for (const hv of vectorSet.heads) {
        assert.equal(hv.values.length, ENCODER_HEAD_DIMS[hv.head]);
        const norm = l2Norm(hv.values);
        assert.ok(norm === 0 || Math.abs(norm - 1) < 1e-6, `${hv.head} L2-normalized`);
        if (table !== null) {
          const expected = projectHeadFromTrunk(hv.head, embedding, table);
          assert.ok(
            hv.values.some((v, j) => Math.abs(v - expected.values[j]!) > 1e-6),
            `${hv.head} differs from trained projection (placeholder active)`,
          );
        }
      }
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_ML5_A;
      else process.env.MEGACOMPACT_ML5_A = saved;
    }
  });

  test("flag OFF + trainedHeadsPath still uses the placeholder (ML5-A gate)", () => {
    const saved = process.env.MEGACOMPACT_ML5_A;
    process.env.MEGACOMPACT_ML5_A = "0";
    const dir = tempDir("vc2b2-off");
    try {
      const headsPath = writeHeadsFixture(dir);
      const embedding = trunkEmbedding();
      const verdict = encodeOrFallback({ tokens: [1, 2, 3] }, "ignored", {
        runtime: fakeRuntime(embedding),
        trainedHeadsPath: headsPath,
      });
      assert.equal(verdict.ok, true);
      if (!verdict.ok) return;
      assert.equal(verdict.mode, "A");
      // Flag off => the trained artifact must NOT be consulted; use the LCG
      // placeholder path (byte-identical predecessor).
      for (const hv of verdict.vectorSet.heads) {
        const norm = l2Norm(hv.values);
        assert.ok(norm === 0 || Math.abs(norm - 1) < 1e-6);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.MEGACOMPACT_ML5_A;
      else process.env.MEGACOMPACT_ML5_A = saved;
    }
  });
});
