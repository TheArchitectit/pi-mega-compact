/** VC2B acceptance aggregator — ENC-009..016 + named fixtures against the REAL
 *  heads/trigram/lexical producers (no mocks). Sprint: multi-head encoder.
 *
 *  Scopes: VectorSetV1/HeadCalibrationDraft registration + registration order
 *  (before training/export logic), every conformance row resolved through the
 *  real producers, the shape/norm invariant (all norms 0 or within 1e-6 of 1,
 *  repeat drift <= 1e-6), loss/seed constants, unique failure injection (delete
 *  the learned asset after A selection but before inference -> the router
 *  catches the REAL load() failure and selects independently initialized B,
 *  emitting vector_cortex_encoder_fallback_selected from the production seam),
 *  forced triad A/B/C through the encode-or-fallback router, flag-OFF parity,
 *  and the VC2B emit seam (both named events).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENC2B_IDS,
  ENC_FAIL,
  ENCODER_HEAD_DIM_ORDER,
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_LOSS_WEIGHTS,
  ENCODER_HEAD_LOSS_SUM,
  ENCODER_HEAD_ORDER,
  ENCODER_MAX_TOKENS,
  ENCODER_SEED,
  type EncoderHeadName,
} from "./encoder/types.js";
import { encodeVectorSet, projectHead, l2Norm } from "./encoder/heads.js";
import { embedTrigram512, ENCODER_TRIGRAM_WIDTH, selectTrigramBFallback } from "./encoder/trigram.js";
import { embedLexical, ENCODER_LEXICAL_WIDTH } from "./encoder/lexical.js";
import { encodeOrFallback } from "./encoder/router.js";
import { createEncoderRuntime } from "./encoder/runtime.js";
import { detectPlatform } from "./encoder/asset.js";
import { createEncoderHeadsReporter } from "./encoder/emit-vc2b.js";
import { canonicalManifestsConverge } from "./conformance/manifest.js";
import { VC2B_ENABLED } from "../config/vector-cortex.js";

// Q03 (flag-off parity): do NOT pin the flags ON at module scope. The mandated
// flag-off gate (`MEGACOMPACT_VC2B=0 node --test ...`) must genuinely exercise
// the flag-independent producer paths (shape/norm/dims/trigram/lexical) under
// the external OFF env, so that run is NOT behaviorally identical to the
// default-ON run. The ON-dependent scenarios (router A/B/C handoff, emission
// assertions) self-pin the flags ON via `withFlagsOn` and are therefore valid
// under EITHER external env, while the dedicated flag suite manages its own env.
function withFlagsOn(fn: () => void): void {
  const keys = ["MEGACOMPACT_VC2B", "MEGACOMPACT_VC2A"] as const;
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    process.env[k] = "1";
  }
  try {
    fn();
  } finally {
    for (const k of keys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The temp asset's declared platform follows the LIVE detector so a staged,
 *  verifying asset directory never spuriously demotes to PLATFORM_UNSUPPORTED
 *  on a non-linux-x64 host (mirrors runtime.test.ts). */
const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

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
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestDef {
  owner: string;
  domain: string;
  fixtures: { id: string; path: string; algorithm: string }[];
}
interface EFixture {
  id: string;
  kind: string;
  producer: string;
  input: { scenario: string; head?: string };
  expected: {
    ok: boolean;
    code?: string;
    mode?: string;
    head?: string;
    dim?: number;
    width?: number;
    heads?: number;
    dims?: number[];
    zero?: boolean;
  };
  assertion: string;
}
function readManifest(): ManifestDef {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as ManifestDef;
}
function fixture(id: string): EFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as EFixture;
}

const ENC2B_NAMED = ["ENC-HEAD-001", "ENC-ZERO-002", "ENC-FALLBACK-003"];
const VC2B_IDS = [...ENC2B_IDS, ...ENC2B_NAMED];
const ORDERED_DIMS = [384, 128, 128, 64, 32];

const SET_TOKENS = [1, 2, 3, 4, 5];
const EMPTY_TOKENS: number[] = [];

/** Stage a directory that the VC2A runtime VERIFIES into mode A: a committed
 *  manifest (live platform, opset 17, batch 1, `maxTokens` defaulting to the
 *  global 512, overridable to exercise the per-manifest token-capacity path)
 *  plus model.onnx and tokenizer.json hashed into the manifest. Returns the dir
 *  path (caller owns cleanup). */
function stageVerifyingAssetDir(maxTokens: number = ENCODER_MAX_TOKENS): string {
  const dir = join(tmpdir(), `vc2b-asset-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const onnx = Buffer.from("staged-onnx-opset17", "binary");
  const tok = Buffer.from('{"vocab":[]}', "utf8");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  const manifest = {
    schema: "model-manifest-v1",
    modelVersion: "acceptance",
    opset: 17,
    batch: 1,
    maxTokens,
    platform: HOST_PLATFORM,
    hiddenWidth: 384,
    semanticWidth: 384,
    heads: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 },
    onnx: { path: "model.onnx", sha256: sha(onnx), bytes: onnx.length },
    tokenizer: { path: "tokenizer.json", sha256: sha(tok), bytes: tok.length },
    totalBytes: onnx.length + tok.length,
    trainingManifestDigest: "0".repeat(64),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

// ---------------------------------------------------------------------------
// Suite 1 — registration + canonical corpus (owner VC2B)
// ---------------------------------------------------------------------------
describe("VC2B conformance registration", () => {
  test("manifest registers every ENC-009..016 + named fixture, owner + domain list VC2B", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of VC2B_IDS) assert.ok(ids.has(id), `missing ${id}`);
    assert.ok(m.owner.includes("VC2B"), "owner lists VC2B");
    assert.ok(m.domain.includes("encoder-heads"), "domain lists encoder-heads");
    for (const id of VC2B_IDS) {
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "encoder-heads", `${id} algorithm`);
    }
  });
  test("the committed VC2B corpus is canonical (a single reproducible digest)", () => {
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus converges");
  });
  test("head order + dims are the normative 384/128/128/64/32 before training/export logic", () => {
    assert.deepEqual(
      ENCODER_HEAD_ORDER,
      ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"],
    );
    assert.deepEqual(ENCODER_HEAD_DIM_ORDER, ORDERED_DIMS);
    assert.deepEqual(
      [ENCODER_HEAD_DIMS.semantic, ENCODER_HEAD_DIMS.dependency, ENCODER_HEAD_DIMS.contradiction, ENCODER_HEAD_DIMS.cacheStability, ENCODER_HEAD_DIMS.payloadRouting],
      ORDERED_DIMS,
    );
  });
  test("losses are exactly .35/.20/.20/.15/.10 and sum to 1; seed is 1729", () => {
    const w = ENCODER_HEAD_LOSS_WEIGHTS;
    assert.equal(w.semantic, 0.35);
    assert.equal(w.dependency, 0.2);
    assert.equal(w.contradiction, 0.2);
    assert.equal(w.cacheStability, 0.15);
    assert.equal(w.payloadRouting, 0.1);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    assert.equal(Math.abs(total - ENCODER_HEAD_LOSS_SUM) < 1e-12, true);
    assert.equal(ENCODER_SEED, 1729);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — ENC-009..016 conformance rows through the real producers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Suite 3 — named assertions
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Suite 4 — invariant + unique failure injection + forced triad
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Suite 5 — flag-off parity + emit seam
// ---------------------------------------------------------------------------
describe("VC2B flag-off parity + emit", () => {
  test("flag OFF yields ZERO VC2B emissions (byte-identical predecessor)", () => {
    const emitted: string[] = [];
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "0";
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      reporter.headsEmitted({ heads: 5 });
      reporter.fallbackSelected({ mode: "B" });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.deepEqual(emitted, [], "flag OFF => no emissions");
  });

  test("flag ON: producing a VectorSet and selecting a fallback emit their named events", () => {
    const saved = process.env.MEGACOMPACT_VC2B;
    process.env.MEGACOMPACT_VC2B = "1";
    const emitted: string[] = [];
    try {
      const reporter = createEncoderHeadsReporter((e) => emitted.push(e));
      encodeVectorSet(SET_TOKENS, { reporter });
      reporter.fallbackSelected({ mode: "B", width: 512 });
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC2B;
      else process.env.MEGACOMPACT_VC2B = saved;
    }
    assert.ok(emitted.includes("vector_cortex_encoder_heads_emitted"));
    assert.ok(emitted.includes("vector_cortex_encoder_fallback_selected"));
  });

  test("VC2B flag is defined, default ON, and =0 disables", () => {
    const saved = process.env.MEGACOMPACT_VC2B;
    delete process.env.MEGACOMPACT_VC2B;
    try {
      assert.equal(VC2B_ENABLED(), true, "default ON");
    } finally {
      if (saved !== undefined) process.env.MEGACOMPACT_VC2B = saved;
    }
    process.env.MEGACOMPACT_VC2B = "0";
    assert.equal(VC2B_ENABLED(), false, "=0 disables");
    process.env.MEGACOMPACT_VC2B = "1";
    assert.equal(VC2B_ENABLED(), true, "pinned ON");
  });
});
