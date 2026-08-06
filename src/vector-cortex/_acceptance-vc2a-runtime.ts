/** VC2A runtime invariant + injection + triad + budget acceptance suites.
 *  Extracted from vc2a-acceptance.test.ts (soft-limit compliance). Context injected. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModelManifestV1 } from "./encoder/types.js";

/** Context from the aggregator — only domain-specific helpers, not node:test/assert. */
export interface Vc2aRuntimeCtx {
  ENC_FAIL: typeof import("./encoder/types.js").ENC_FAIL;
  ENCODER_RSS_BUDGET_BYTES: number;
  ENCODER_LATENCY_P95_MS: number;
  tmpAsset: (prefix: string) => string;
  baseManifest: (over?: Partial<ModelManifestV1>) => ModelManifestV1;
  buildDir: (scenario: string) => Built;
  rmBuilt: (b: Built) => void;
  sha256: (bytes: Uint8Array) => string;
  percentile: (sorted: number[], p: number) => number;
  createEncoderRuntime: typeof import("./encoder/runtime.js").createEncoderRuntime;
  verifyEncoderAsset: typeof import("./encoder/asset.js").verifyEncoderAsset;
  readEncoderManifest: typeof import("./encoder/asset.js").readEncoderManifest;
}

/* Structural stand-in for the aggregator's local `Built` (dir + scenario). */
interface Built {
  dir: string;
  scenario: string;
}

export function registerVc2aRuntime(ctx: Vc2aRuntimeCtx): void {
  const {
    ENC_FAIL,
    ENCODER_RSS_BUDGET_BYTES,
    ENCODER_LATENCY_P95_MS,
    tmpAsset,
    baseManifest,
    buildDir,
    rmBuilt,
    sha256,
    percentile,
    createEncoderRuntime,
    verifyEncoderAsset,
    readEncoderManifest,
  } = ctx;

  // -------------------------------------------------------------------------
  // Invariant + unique failure injection + forced triad
  // -------------------------------------------------------------------------
  describe("encoder runtime invariant + injection + triad", () => {
    test("invariant: only batch1/max512 verified assets reach inference", () => {
      const built = buildDir("valid");
      try {
        const rt = createEncoderRuntime();
        const load = rt.load(built.dir);
        assert.equal(load.ok, true);
        if (load.ok) assert.equal(load.mode, "A");
        // dims 1..512 infer; 0 and 513+ are shape-rejected.
        for (const n of [1, 64, 512]) {
          const inf = rt.infer({ tokens: Array.from({ length: n }, (_, i) => i % 500) });
          assert.equal(inf.ok, true, `dim ${n} infers`);
        }
        for (const n of [0, 513, 1000]) {
          const inf = rt.infer({ tokens: Array.from({ length: n }) });
          assert.equal(inf.ok, false, `dim ${n} shape-rejected`);
          if (!inf.ok) assert.equal(inf.code, ENC_FAIL.SHAPE_INVALID);
        }
        // A batch>1 manifest never reaches inference: verification demotes to B.
        const bad = buildDir("batch-2");
        try {
          const checker = createEncoderRuntime();
          const check = checker.load(bad.dir);
          assert.equal(check.ok, false);
          if (!check.ok) assert.equal(check.code, ENC_FAIL.BATCH_INVALID);
        } finally {
          rmBuilt(bad);
        }
      } finally {
        rmBuilt(built);
      }
    });
    test("1..513 maxTokens manifests: 1..512 verify+infer, 513 demotes TOKENS_EXCEEDED", () => {
      for (const maxTok of [1, 64, 512]) {
        const dir = tmpAsset("vc2a-dim");
        mkdirSync(dir, { recursive: true });
        const onnx = Buffer.from(`dim-${maxTok}`, "binary");
        const tok = Buffer.from('{"vocab":[]}', "utf8");
        writeFileSync(join(dir, "model.onnx"), onnx);
        writeFileSync(join(dir, "tokenizer.json"), tok);
        const m = baseManifest({
          maxTokens: maxTok,
          onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
          tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
        });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
        assert.equal(verifyEncoderAsset(dir, readEncoderManifest(dir)).ok, true, `maxTokens ${maxTok} verifies`);
        const rt = createEncoderRuntime();
        assert.equal(rt.load(dir).ok, true, `maxTokens ${maxTok} loads`);
        const inf = rt.infer({ tokens: Array.from({ length: maxTok }) });
        assert.equal(inf.ok, true, `cap ${maxTok} infers`);
        rmSync(dir, { recursive: true, force: true });
      }
      // 513 demotes.
      const dir513 = tmpAsset("vc2a-dim-513");
      mkdirSync(dir513, { recursive: true });
      const onnx513 = Buffer.from("dim-513", "binary");
      const tok513 = Buffer.from('{"vocab":[]}', "utf8");
      writeFileSync(join(dir513, "model.onnx"), onnx513);
      writeFileSync(join(dir513, "tokenizer.json"), tok513);
      const m513 = baseManifest({
        maxTokens: 513,
        onnx: { path: "model.onnx", sha256: sha256(onnx513), bytes: onnx513.length },
        tokenizer: { path: "tokenizer.json", sha256: sha256(tok513), bytes: tok513.length },
      });
      writeFileSync(join(dir513, "manifest.json"), JSON.stringify(m513));
      const res = verifyEncoderAsset(dir513, readEncoderManifest(dir513));
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.TOKENS_EXCEEDED);
      rmSync(dir513, { recursive: true, force: true });
    });
    test("truncated ONNX during digest read demotes ENC_ASSET_UNREADABLE", () => {
      // LIVE-platform manifest with absent model.onnx -> unreadable -> ASSET_UNREADABLE.
      const built = buildDir("missing-onnx");
      try {
        const load = createEncoderRuntime().load(built.dir);
        assert.equal(load.ok, false);
        if (!load.ok) {
          assert.equal(load.code, ENC_FAIL.ASSET_UNREADABLE);
          assert.equal(load.mode, "B");
        }
      } finally {
        rmBuilt(built);
      }
    });
    test("allocator failure after verification demotes ENC_ASSET_UNREADABLE", () => {
      const built = buildDir("valid");
      try {
        const load = createEncoderRuntime({ host: { allocatorFails: () => true } }).load(built.dir);
        assert.equal(load.ok, false);
        if (!load.ok) assert.equal(load.code, ENC_FAIL.ASSET_UNREADABLE);
      } finally {
        rmBuilt(built);
      }
    });
    test("forced triad A / B / C", () => {
      const dirA = buildDir("valid");
      try {
        assert.equal(createEncoderRuntime().load(dirA.dir).ok, true);
      } finally {
        rmBuilt(dirA);
      }
      // B: missing asset => asset-free trigram.
      const dirB = buildDir("missing-onnx");
      try {
        const load = createEncoderRuntime().load(dirB.dir);
        assert.equal(load.ok, false);
        if (!load.ok) assert.equal(load.mode, "B");
      } finally {
        rmBuilt(dirB);
      }
      // C: lexical forced by mode C (rollback path).
      const dirC = tmpAsset("vc2a-C");
      mkdirSync(dirC, { recursive: true });
      try {
        const load = createEncoderRuntime({ forcedMode: "C" }).load(dirC);
        assert.equal(load.ok, false);
        if (!load.ok) assert.equal(load.mode, "C");
      } finally {
        rmSync(dirC, { recursive: true, force: true });
      }
    });
    test("acceptance budgets: infer p95 <=40ms and encoder marginal footprint <=150MiB", () => {
      // Q02: rssBytes = encoder MARGINAL footprint, never whole-process RSS.
      // p95 via linear interpolation — not max sample.
      const built = buildDir("valid");
      try {
        const rt = createEncoderRuntime();
        assert.equal(rt.load(built.dir).ok, true);
        const latencies: number[] = [];
        for (let i = 0; i < 200; i++) {
          const inf = rt.infer({ tokens: Array.from({ length: 128 }, (_, k) => k) });
          assert.equal(inf.ok, true);
          if (inf.ok) {
            latencies.push(inf.latencyMs);
            assert.ok(inf.rssBytes <= ENCODER_RSS_BUDGET_BYTES, "encoder marginal footprint <=150MiB");
          }
        }
        const p95 = percentile(latencies, 0.95);
        assert.ok(p95 <= ENCODER_LATENCY_P95_MS, `p95 ${p95} <= 40ms`);
      } finally {
        rmBuilt(built);
      }
    });
    test("Q01: a long-lived runtime cannot drift over the 150MiB marginal budget", () => {
      // selfAllocated models a REUSABLE projection buffer — must not accumulate.
      // 100k inferences prove no irreversible budget demotion.
      const built = buildDir("valid");
      try {
        const rt = createEncoderRuntime();
        assert.equal(rt.load(built.dir).ok, true);
        let firstRss = 0;
        for (let i = 0; i < 100_000; i++) {
          const inf = rt.infer({ tokens: Array.from({ length: 4 }, () => i % 500) });
          assert.equal(inf.ok, true, `infer #${i} still ok`);
          if (inf.ok) {
            if (i === 0) firstRss = inf.rssBytes;
            assert.equal(inf.rssBytes, firstRss, `marginal footprint flat at infer #${i}`);
            assert.ok(inf.rssBytes <= ENCODER_RSS_BUDGET_BYTES, `still within budget at infer #${i}`);
          }
        }
        assert.equal(rt.mode, "A", "mode A survives 100k inferences (no irreversible budget demotion)");
      } finally {
        rmBuilt(built);
      }
    });

    test("Q03: per-manifest maxTokens is enforced at inference (over-cap rejected)", () => {
      // maxTokens=64 manifest: 65..512 tokens must be SHAPE_INVALID.
      const dir = tmpAsset("vc2a-q03");
      mkdirSync(dir, { recursive: true });
      const onnx = Buffer.from("q03-lowcap", "binary");
      const tok = Buffer.from('{"vocab":[]}', "utf8");
      writeFileSync(join(dir, "model.onnx"), onnx);
      writeFileSync(join(dir, "tokenizer.json"), tok);
      const m = baseManifest({
        maxTokens: 64,
        onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
        tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
      });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
      try {
        const rt = createEncoderRuntime();
        assert.equal(rt.load(dir).ok, true, "maxTokens=64 manifest loads (mode A)");
        assert.equal(rt.infer({ tokens: Array.from({ length: 64 }, (_, k) => k) }).ok, true, "cap 64 infers");
        for (const over of [65, 128, 512]) {
          const inf = rt.infer({ tokens: Array.from({ length: over }) });
          assert.equal(inf.ok, false, `${over} tokens rejected against a 64-cap manifest`);
          if (!inf.ok) assert.equal(inf.code, ENC_FAIL.SHAPE_INVALID);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("Q04: MEGACOMPACT_VC2A=0 makes the default factory select mode C (rollback)", () => {
      // Flag OFF => default factory is fixed at mode C (byte-identical predecessor).
      const saved = process.env.MEGACOMPACT_VC2A;
      process.env.MEGACOMPACT_VC2A = "0";
      try {
        // An explicitly forced "C" also reports ROLLBACK (existing contract).
        const forced = createEncoderRuntime({ forcedMode: "C" });
        // The default factory under flag-off must match that exactly.
        const byFlag = createEncoderRuntime();
        for (const rt of [forced, byFlag]) {
          assert.equal(rt.mode, "C", "flag-off / forced runtime starts in mode C");
          const built = buildDir("valid");
          try {
            const load = rt.load(built.dir);
            assert.equal(load.ok, false);
            if (!load.ok) {
              assert.equal(load.mode, "C", "flag-off default factory reports mode C");
              assert.equal(load.code, ENC_FAIL.ROLLBACK, "ROLLBACK, not MANIFEST_INVALID");
            }
          } finally {
            rmBuilt(built);
          }
          const inf = rt.infer({ tokens: [1, 2, 3] });
          assert.equal(inf.ok, false, "no learned infer on the flag-off path");
        }
      } finally {
        if (saved === undefined) delete process.env.MEGACOMPACT_VC2A;
        else process.env.MEGACOMPACT_VC2A = saved;
      }
      // Restore the module-scope pin (flag ON) for subsequent scenarios.
      process.env.MEGACOMPACT_VC2A = "1";
    });

    test("all digest corruptions demote before load", () => {
      for (const which of ["onnx", "tokenizer", "both"] as const) {
        const dir = tmpAsset("vc2a-corr");
        mkdirSync(dir, { recursive: true });
        const onnx = Buffer.from("corrupt-me-onnx", "binary");
        const tok = Buffer.from('{"vocab":[]}', "utf8");
        writeFileSync(join(dir, "model.onnx"), onnx);
        writeFileSync(join(dir, "tokenizer.json"), tok);
        const m = baseManifest({
          onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
          tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
        });
        if (which === "onnx" || which === "both") writeFileSync(join(dir, "model.onnx"), Buffer.concat([onnx, Buffer.from("X")]));
        if (which === "tokenizer" || which === "both") writeFileSync(join(dir, "tokenizer.json"), Buffer.concat([tok, Buffer.from("X")]));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
        const res = verifyEncoderAsset(dir, readEncoderManifest(dir));
        assert.equal(res.ok, false, `corrupt ${which} demotes`);
        if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH, `corrupt ${which} code`);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
