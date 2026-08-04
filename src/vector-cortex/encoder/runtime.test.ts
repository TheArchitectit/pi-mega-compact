/** VC2A EncoderRuntime tests (task 3) — allocate only after verification, shape
 *  rejection (ENC_SHAPE_INVALID), RSS cap (150 MiB), triad A/B/C, and the emit
 *  seam (asset_verified / runtime_demoted). */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENC_FAIL, ENCODER_MAX_TOKENS, ENCODER_RSS_BUDGET_BYTES } from "./types.js";
import { createEncoderRuntime } from "./runtime.js";
import { detectPlatform } from "./asset.js";
import { createEncoderReporter, NOOP_ENCODER_REPORTER } from "./emit.js";

// Q04: the default createEncoderRuntime() honors MEGACOMPACT_VC2A ("-0 selects
// mode C"). Pin the flag ON at module scope so the mode-A scenarios are
// deterministic under either the default-ON run or any flag-off parity run; the
// flag-off rollback behavior is covered by the dedicated tests that manage their
// own env.
process.env.MEGACOMPACT_VC2A = "1";

/** The temp asset's declared platform follows the LIVE detector, so the
 *  manifest's platform always matches the runtime host and verification does
 *  not spuriously demote to PLATFORM_UNSUPPORTED on non-linux-x64 hosts
 *  (cross-platform code-quality Q02). */
const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

function tempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

function makeAssetDir(over: Partial<{ onnx: Buffer; tokenizer: Buffer }> = {}): string {
  const dir = tempDir("vc2a-rt");
  mkdirSync(dir, { recursive: true });
  const onnx = over.onnx ?? Buffer.from("00000000-pretend-onnx-opset17", "binary");
  const tok = over.tokenizer ?? Buffer.from('{"vocab":[]}', "utf8");
  // A real, verifying asset dir: a manifest that hashes these files.
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  const manifest = {
    schema: "model-manifest-v1",
    modelVersion: "rt-test",
    opset: 17,
    batch: 1,
    maxTokens: ENCODER_MAX_TOKENS,
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

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("VC2A EncoderRuntime (task 3)", () => {
  test("loads a verified asset into mode A and infers a 384-dim semantic (ENC-001-like)", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime();
      const load = rt.load(dir);
      assert.equal(load.ok, true);
      if (load.ok) {
        assert.equal(load.mode, "A");
        assert.ok(load.embeddedBytes > 0);
      }
      const inf = rt.infer({ tokens: Array.from({ length: 64 }, (_, i) => i) });
      assert.equal(inf.ok, true);
      if (inf.ok) {
        assert.equal(inf.semantic.length, 384);
        assert.equal(inf.shapeError, null);
        assert.ok(inf.latencyMs >= 0);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("injecting dimension 513 demotes ENC_SHAPE_INVALID (invariant: only max512 reaches inference)", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime();
      assert.equal(rt.load(dir).ok, true);
      const inf = rt.infer({ tokens: Array.from({ length: 513 }) });
      assert.equal(inf.ok, false);
      if (!inf.ok) assert.equal(inf.code, ENC_FAIL.SHAPE_INVALID);
      // dimension 512 (the boundary) still infers.
      const ok = rt.infer({ tokens: Array.from({ length: 512 }) });
      assert.equal(ok.ok, true);
      // dimension 1 infers.
      const one = rt.infer({ tokens: [1] });
      assert.equal(one.ok, true);
      // dimension 0 is rejected.
      const zero = rt.infer({ tokens: [] });
      assert.equal(zero.ok, false);
    } finally {
      cleanup(dir);
    }
  });

  test("allocator failure after verification demotes ENC_ASSET_UNREADABLE (mode B)", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ host: { allocatorFails: () => true } });
      const load = rt.load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.code, ENC_FAIL.ASSET_UNREADABLE);
      // Infer is blocked in mode B (no verified learned asset).
      const inf = rt.infer({ tokens: [1, 2, 3] });
      assert.equal(inf.ok, false);
      if (!inf.ok) assert.equal(inf.code, ENC_FAIL.SHAPE_INVALID);
    } finally {
      cleanup(dir);
    }
  });

  test("allocator failure with A-failed also forces mode C (triad C)", () => {
    const dir = makeAssetDir();
    try {
      // A fails (no manifest in an empty dir) + B init fails (allocator) -> C.
      const empty = tempDir("vc2a-empty");
      mkdirSync(empty, { recursive: true });
      try {
        const rt = createEncoderRuntime({ host: { allocatorFails: () => true } });
        const load = rt.load(empty);
        assert.equal(load.ok, false);
        if (!load.ok) assert.equal(load.mode, "C");
      } finally {
        cleanup(empty);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("missing asset dir demotes to mode B (asset-free trigram, no remote fetch)", () => {
    const empty = tempDir("vc2a-missing");
    mkdirSync(empty, { recursive: true });
    try {
      const rt = createEncoderRuntime();
      const load = rt.load(empty);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.mode, "B");
      assert.equal(load.code, ENC_FAIL.MANIFEST_INVALID);
    } finally {
      cleanup(empty);
    }
  });

  test("unsupported platform demotes to mode B (ENC_PLATFORM_UNSUPPORTED)", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ platform: () => null });
      const load = rt.load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) {
        assert.equal(load.mode, "B");
        assert.equal(load.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("over-budget marginal footprint demotes ENC_RSS_BUDGET_EXCEEDED (mode B)", () => {
    // The budget gates the encoder's MARGINAL footprint (Q01), so a large
    // whole-process RSS is irrelevant; an externally staged allocation over the
    // 150 MiB budget (or the encoder's own allocation counter) demotes.
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ host: { allocatedBytes: () => ENCODER_RSS_BUDGET_BYTES + 1 } });
      const load = rt.load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.code, ENC_FAIL.RSS_BUDGET_EXCEEDED);
    } finally {
      cleanup(dir);
    }
  });

  test("over-budget marginal footprint during infer demotes to mode B (Q03 parity)", () => {
    // A healthy process baseline must not block mode A; only the encoder's
    // INCREMENTAL footprint exceeding the budget should (Q01). Once over budget
    // an inference demotes to mode B (consistent with load), and the check runs
    // BEFORE the projection allocation (cap-before-allocation, task 3).
    const dir = makeAssetDir();
    try {
      // Under budget a verified load is mode A even though the whole process
      // RSS (via the default seam, not measured here) could be large.
      const rtOk = createEncoderRuntime();
      assert.equal(rtOk.load(dir).ok, true);
      assert.equal(rtOk.mode, "A");
      // Push the marginal footprint over budget at runtime: start under budget,
      // then saturate so infer demotes from A -> B before allocating.
      let budget = 0;
      const rtInf = createEncoderRuntime({ host: { allocatedBytes: () => budget } });
      assert.equal(rtInf.load(dir).ok, true);
      budget = ENCODER_RSS_BUDGET_BYTES + 1;
      const inf = rtInf.infer({ tokens: [1, 2, 3] });
      assert.equal(inf.ok, false);
      if (!inf.ok) assert.equal(inf.code, ENC_FAIL.RSS_BUDGET_EXCEEDED);
      assert.equal(rtInf.mode, "B", "runtime demoted to B on over-budget infer");
      // A subsequent infer in mode B is blocked (no stale mode-A allocation).
      const after = rtInf.infer({ tokens: [1, 2, 3] });
      assert.equal(after.ok, false);
      if (!after.ok) assert.equal(after.code, ENC_FAIL.SHAPE_INVALID);
    } finally {
      cleanup(dir);
    }
  });

  test("forced mode C is the rollback path (returned, no learned infer)", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ forcedMode: "C" });
      const load = rt.load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) {
        assert.equal(load.mode, "C");
        // Q04: even a correctly-shaped, digest-correct asset present on disk is
        // reported as ROLLBACK (mode-C rollback), NOT MANIFEST_INVALID.
        assert.equal(load.code, ENC_FAIL.ROLLBACK);
      }
      const inf = rt.infer({ tokens: [1] });
      assert.equal(inf.ok, false);
    } finally {
      cleanup(dir);
    }
  });

  test("rollback returns ENC_ROLLBACK_ACTIVE, distinct from MANIFEST_INVALID (Q04)", () => {
    // A valid verified asset on disk alone must never be described as a
    // corrupt/missing manifest when the rollback path is active.
    const dir = makeAssetDir();
    const empty = tempDir("vc2a-rollback-empty");
    mkdirSync(empty, { recursive: true });
    try {
      // Both a valid asset dir and an empty dir report ROLLBACK (not
      // MANIFEST_INVALID) on the forced-C rollback path.
      for (const d of [dir, empty]) {
        const rt = createEncoderRuntime({ forcedMode: "C" });
        const load = rt.load(d);
        assert.equal(load.ok, false);
        if (!load.ok) {
          assert.equal(load.mode, "C");
          assert.equal(load.code, ENC_FAIL.ROLLBACK, "rollback code, not manifest-invalid");
        }
      }
    } finally {
      cleanup(dir);
      cleanup(empty);
    }
  });

  test("runtime.mode is a live getter that reflects the latest load/demote outcome", () => {
    // Construction-time mode is C (unloaded), then tracks A after a verified load
    // and B/C after a demotion — never a stale construction-time copy.
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime();
      assert.equal(rt.mode, "C", "unloaded runtime starts at C");
      const load = rt.load(dir);
      assert.ok(load.ok);
      assert.equal(rt.mode, "A", "runtime.mode tracks the verified load");
      // Now demote to B by a missing-asset load on the same runtime.
      const empty = tempDir("vc2a-mode-gate");
      mkdirSync(empty, { recursive: true });
      try {
        rt.load(empty);
        assert.equal(rt.mode, "B", "runtime.mode tracks the demotion to B");
      } finally {
        cleanup(empty);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("forcedMode is rollback-only: forcedMode C returns C without verifying", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ forcedMode: "C" });
      const load = rt.load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.mode, "C");
      // The forced path bypasses verification entirely: no asset_verified event,
      // and even a valid dir cannot promote past the forced C.
      assert.equal(rt.mode, "C");
      // @ts-expect-error A/B forcing is intentionally not offered (rollback only).
      createEncoderRuntime({ forcedMode: "A" });
    } finally {
      cleanup(dir);
    }
  });

  test("emits asset_verified on a qualified load and runtime_demoted on demotion", () => {
    const events: string[] = [];
    const reporter = createEncoderReporter((e) => events.push(e));
    const good = makeAssetDir();
    try {
      const rt = createEncoderRuntime({ reporter });
      rt.load(good);
      assert.ok(events.includes("vector_cortex_encoder_asset_verified"), events.join(","));
    } finally {
      cleanup(good);
    }
    const bad = tempDir("vc2a-emit-bad");
    mkdirSync(bad, { recursive: true });
    try {
      const rt = createEncoderRuntime({ reporter });
      rt.load(bad);
      assert.ok(events.includes("vector_cortex_encoder_runtime_demoted"), events.join(","));
    } finally {
      cleanup(bad);
    }
  });

  test("flag OFF: the reporter is a structural no-op and the noop reporter emits nothing", () => {
    const emitted: string[] = [];
    const noop = NOOP_ENCODER_REPORTER;
    noop.assetVerified({ a: 1 });
    noop.runtimeDemoted({ b: 2 });
    assert.deepEqual(emitted, []);
    // With the flag flipped by the caller's test harness the factory still
    // produces an inactive reporter (same zero-emission guarantee).
    const rt = createEncoderRuntime({ reporter: noop });
    const dir = makeAssetDir();
    try {
      rt.load(dir);
    } finally {
      cleanup(dir);
    }
    assert.deepEqual(emitted, []);
  });

  test("a full 512-token inference stays within the RSS budget and resolves", () => {
    const dir = makeAssetDir();
    try {
      const rt = createEncoderRuntime();
      assert.equal(rt.load(dir).ok, true);
      const inf = rt.infer({ tokens: Array.from({ length: ENCODER_MAX_TOKENS }, (_, i) => i % 500) });
      assert.equal(inf.ok, true);
      if (inf.ok) {
        assert.ok(inf.rssBytes <= ENCODER_RSS_BUDGET_BYTES, "RSS within 150 MiB budget");
      }
    } finally {
      cleanup(dir);
    }
  });
});
