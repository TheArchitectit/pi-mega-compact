/** VC2B acceptance — multi-head invariant + independence + forced triad through
 *  the REAL encode-or-fallback router (no mocks, including unique failure
 *  injection where the learned asset is deleted after A selection but before
 *  inference). Extracted from vc2b-acceptance.test.ts so the aggregator stays
 *  under the soft line limit. Shared context (withFlagsOn, stageVerifyingAssetDir,
 *  token/order constants) is injected by the aggregator to avoid a circular import.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { ENC_FAIL, ENCODER_HEAD_DIMS } from "./encoder/types.js";
import { encodeVectorSet, l2Norm } from "./encoder/heads.js";
import { ENCODER_TRIGRAM_WIDTH } from "./encoder/trigram.js";
import { embedLexical, ENCODER_LEXICAL_WIDTH } from "./encoder/lexical.js";
import { encodeOrFallback } from "./encoder/router.js";
import { createEncoderRuntime } from "./encoder/runtime.js";
import { createEncoderHeadsReporter } from "./encoder/emit-vc2b.js";

export interface HeadsCtx {
  withFlagsOn: (fn: () => void) => void;
  stageVerifyingAssetDir: (maxTokens?: number) => string;
  SET_TOKENS: number[];
  EMPTY_TOKENS: number[];
  ORDERED_DIMS: number[];
}

export function registerHeads(ctx: HeadsCtx): void {
  const { withFlagsOn, stageVerifyingAssetDir, SET_TOKENS, EMPTY_TOKENS, ORDERED_DIMS } = ctx;

  // Suite 4 — invariant + unique failure injection + forced triad
  describe("multi-head invariant + independence + triad", () => {
    test("invariant: every emitted norm is 0 or within 1e-6 of 1", () => {
      for (const tokens of [SET_TOKENS, EMPTY_TOKENS, [7], Array.from({ length: 300 }, (_, i) => i)]) {
        const set = encodeVectorSet(tokens);
        for (const hv of set.heads) {
          const n = l2Norm(hv.values);
          assert.equal(n === 0 || Math.abs(n - 1) <= 1e-6, true, `${hv.head} norm ${n}`);
        }
      }
    });

    test("repeat drift <= 1e-6 across repeated seeded exports (all five heads)", () => {
      for (let rep = 0; rep < 3; rep++) {
        const a = encodeVectorSet(SET_TOKENS);
        const b = encodeVectorSet(SET_TOKENS);
        for (let i = 0; i < a.heads.length; i++) {
          for (let j = 0; j < a.heads[i]!.values.length; j++) {
            assert.equal(Math.abs(a.heads[i]!.values[j]! - b.heads[i]!.values[j]!) <= 1e-6, true);
          }
        }
      }
    });

    test("unique failure injection: delete model after A selection but before inference; router catches the real load() failure and selects independently initialized B", () => {
      // This scenario is ON-dependent: it asserts a fallback emission, which is
      // VC2B-flag-gated, and drives the VC2A runtime into an A load — so it self-pins
      // both flags ON and is thus valid under either the default-ON run or the
      // MEGACOMPACT_VC2B=0 parity run.
      withFlagsOn(() => {
        // Stage a learned asset the VC2A runtime would VERIFY into mode A, then
        // REMOVE model.onnx before encoding. The router's load() returns the real
        // ENC_ASSET_UNREADABLE failure code and must hand off to the independently
        // initialized asset-free trigram B — emitting vector_cortex_encoder_fallback_selected
        // from the production seam (S2: a true end-to-end router test, not a
        // simulated direct call to selectTrigramBFallback).
        const dir = stageVerifyingAssetDir();
        const emitted: string[] = [];
        const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
        try {
          // A is selectable at this point (a staging runtime verifies it).
          const probe = createEncoderRuntime();
          assert.equal(probe.load(dir).ok, true, "staged asset verifies into A");
          // "After A selection but before inference": the on-disk model is gone.
          rmSync(join(dir, "model.onnx"), { force: true });
          const verdict = encodeOrFallback({ tokens: SET_TOKENS }, dir, { reporter });
          assert.equal(verdict.ok, true);
          assert.equal(verdict.mode, "B", "router handoff selects independently initialized B");
          assert.equal(verdict.width, 512);
          if (verdict.ok) {
            assert.equal(verdict.vector.length, 512);
            assert.equal(verdict.code, ENC_FAIL.ASSET_UNREADABLE, "load() reported the real failure code");
          }
          assert.ok(
            emitted.includes("vector_cortex_encoder_fallback_selected"),
            "fallback-selected fired from the real router seam: " + emitted.join(","),
          );
          // Distinct vectors for distinct inputs — the fallback is not a constant.
          const again = encodeOrFallback({ tokens: [9, 8, 7, 6] }, dir, { reporter });
          assert.equal(again.ok, true);
          if (verdict.ok && again.ok && verdict.mode === "B" && again.mode === "B") {
            let diff = 0;
            for (let i = 0; i < verdict.vector.length; i++) diff += Math.abs(verdict.vector[i]! - again.vector[i]!);
            assert.ok(diff > 1e-3, "independent trigram B is input-sensitive");
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    test("forced triad A / B / C through the encode-or-fallback router", () => {
      // ON-dependent: asserts heads_emitted / fallback_selected emissions, so it
      // self-pins both flags ON (valid under either the default-ON run or the
      // MEGACOMPACT_VC2B=0 parity run).
      withFlagsOn(() => {
        // A = learned projections: a verifying asset dir routes to a VectorSetV1 with
        // the five heads in ordered dims (emitting heads_emitted).
        const dirA = stageVerifyingAssetDir();
        const emittedA: string[] = [];
        try {
          const reporterA = createEncoderHeadsReporter((e) => emittedA.push(e));
          const a = encodeOrFallback({ tokens: SET_TOKENS }, dirA, { reporter: reporterA });
          assert.equal(a.ok, true);
          assert.equal(a.mode, "A");
          if (a.ok) {
            assert.equal(a.vectorSet.heads.length, 5);
            assert.deepEqual(a.vectorSet.heads.map((h) => h.dim), ORDERED_DIMS);
          }
          assert.ok(emittedA.includes("vector_cortex_encoder_heads_emitted"));
        } finally {
          rmSync(dirA, { recursive: true, force: true });
        }
        // B = 512d trigram selected when the learned asset directory is REMOVED: the
        // router's load() fails (no manual fetch) and hands off to B. Remove a staged
        // asset dir so the directory is genuinely absent, proving B needs no asset.
        const dirB = stageVerifyingAssetDir();
        rmSync(dirB, { recursive: true, force: true }); // asset directory REMOVED
        const emittedB: string[] = [];
        const reporterB = createEncoderHeadsReporter((e) => emittedB.push(e));
        const b = encodeOrFallback({ tokens: SET_TOKENS }, dirB, { reporter: reporterB });
        assert.equal(b.ok, true);
        assert.equal(b.mode, "B", "B works without an asset dir");
        assert.equal(b.width, 512);
        if (b.ok) {
          assert.equal(b.vector.length, 512);
          assert.equal(b.limitation, null);
        }
        assert.ok(emittedB.includes("vector_cortex_encoder_fallback_selected"), "B selection emits fallback-selected");
        // C = token/phrase lexical forced when both A and B runtimes are disabled.
        const emittedC: string[] = [];
        const reporterC = createEncoderHeadsReporter((e) => emittedC.push(e));
        const c = encodeOrFallback({ tokens: SET_TOKENS }, dirB, { reporter: reporterC, forceFallback: "C" });
        assert.equal(c.ok, true);
        assert.equal(c.mode, "C");
        assert.equal(c.width, ENCODER_LEXICAL_WIDTH);
        if (c.ok && c.mode === "C") {
          assert.equal(c.vector.length, ENCODER_LEXICAL_WIDTH);
          assert.ok((c.limitation ?? "").length > 0, "C reports its semantic-context limitation");
          // Q04: a FORCED C is an intentional selection, not a demotion or rollback,
          // so it must NOT be stamped with ENC_FAIL.ROLLBACK.
          assert.equal(c.code, null, "forced C is not a rollback/demotion (code = null)");
        }
        assert.ok(emittedC.includes("vector_cortex_encoder_fallback_selected"), "C selection emits fallback-selected");
        // Widths are disjoint across the triad (no shared feature space).
        const aWidths = Object.values(ENCODER_HEAD_DIMS);
        for (const w of [...aWidths, ENCODER_LEXICAL_WIDTH]) assert.notEqual(w, ENCODER_TRIGRAM_WIDTH);
      });
    });

    test("forced fallback (B/C) wins over the empty-input degenerate case (Q02)", () => {
      // Q02: a caller that explicitly forces a fallback mode must get that mode
      // even for EMPTY input — empty tokens must NOT silently short-circuit to B.
      // Asserts fallback_selected emissions → ON-dependent, so it self-pins via
      // withFlagsOn (valid under either external env, same as the forced-triad test).
      withFlagsOn(() => {
        const emittedC: string[] = [];
        const reporterC = createEncoderHeadsReporter((e) => emittedC.push(e));
        const c = encodeOrFallback({ tokens: EMPTY_TOKENS }, "", { reporter: reporterC, forceFallback: "C" });
        assert.equal(c.ok, true);
        assert.equal(c.mode, "C", "forced C must win over empty-input B selection");
        if (c.ok && c.mode === "C") {
          assert.equal(c.vector.length, ENCODER_LEXICAL_WIDTH);
          assert.equal(c.code, null, "forced C carries no rollback/demotion code (Q04)");
        }
        assert.ok(emittedC.includes("vector_cortex_encoder_fallback_selected"));
        // Forced B on empty input also stays B (force mode is honored, no failure
        // code — a forced mode is not a rollback/demotion, so code is null).
        const emittedB: string[] = [];
        const reporterB = createEncoderHeadsReporter((e) => emittedB.push(e));
        const b = encodeOrFallback({ tokens: EMPTY_TOKENS }, "", { reporter: reporterB, forceFallback: "B" });
        assert.equal(b.ok, true);
        assert.equal(b.mode, "B");
        if (b.ok && b.mode === "B") {
          assert.equal(b.vector.length, ENCODER_TRIGRAM_WIDTH);
          assert.equal(b.code, null, "forced B carries no rollback/demotion code (Q04)");
        }
      });
    });

    test("A/B/C use disjoint widths and independent algorithms", () => {
      // A head widths are 384/128/128/64/32; B is 512; C is 256 — no shared space.
      const aWidths = Object.values(ENCODER_HEAD_DIMS);
      const bWidth = ENCODER_TRIGRAM_WIDTH;
      const cWidth = ENCODER_LEXICAL_WIDTH;
      for (const w of [...aWidths, cWidth]) assert.notEqual(w, bWidth);
      // B works with the asset absent; C works with both vector runtimes disabled
      // (C does not depend on B or A — it embeds tokens directly).
      const cTokens = embedLexical("independently computed lexical with vector runtimes disabled");
      assert.equal(cTokens.length, ENCODER_LEXICAL_WIDTH);
    });

    test("router seam enforces the verified per-manifest token capacity: over-cap input routes to B with ENC_SHAPE_INVALID, never an over-cap A VectorSet", () => {
      // Q01: the router's mode-A path must enforce the VC2A contract
      // "only batch1/<=maxTokens verified assets reach inference" at its own seam.
      // A verified asset declaring maxTokens=64 with an input of 100 tokens must
      // NOT produce an ok:true mode-A VectorSetV1 whose inputTokens breach the
      // model's declared capacity — instead the router rejects it and falls back
      // to the asset-free trigram B, reporting the real shape failure code.
      withFlagsOn(() => {
        const dir = stageVerifyingAssetDir(64); // verified low-cap manifest
        try {
          const over = encodeOrFallback({ tokens: Array.from({ length: 100 }, (_, i) => i) }, dir);
          assert.equal(over.ok, true, "over-cap input still yields a usable (fallback) verdict");
          assert.equal(over.mode, "B", "over-cap input must route to the B fallback, not an A VectorSet");
          if (over.ok) {
            assert.equal(over.code, ENC_FAIL.SHAPE_INVALID, "reported the real shape failure code");
            assert.equal(over.vector.length, ENCODER_TRIGRAM_WIDTH);
          }
          // A within-cap input against the SAME verified manifest still reaches a
          // qualified mode-A VectorSet — the capacity rejection is input-scoped,
          // not a blanket demotion of the verified asset.
          const within = encodeOrFallback({ tokens: SET_TOKENS }, dir);
          assert.equal(within.ok, true);
          assert.equal(within.mode, "A", "within-cap input still reaches mode A");
          if (within.ok) assert.equal(within.vectorSet.heads.length, 5);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
}
