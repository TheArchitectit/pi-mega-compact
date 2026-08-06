/** VC2A EncoderRuntime emit/flag tests — extracted from runtime.test.ts
 *  (delegate-shell split, soft-limit compliance). Reporter seam, NOOP reporter,
 *  and flag-off structural no-op guarantees. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENCODER_MAX_TOKENS, ENCODER_OPSET } from "./types.js";
import { createEncoderRuntime } from "./runtime.js";
import { detectPlatform } from "./asset.js";
import { createEncoderReporter, NOOP_ENCODER_REPORTER } from "./emit.js";

process.env.MEGACOMPACT_VC2A = "1";

const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

function tempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
}

function makeAssetDir(): string {
  const dir = tempDir("vc2a-emit");
  mkdirSync(dir, { recursive: true });
  const onnx = Buffer.from("00000000-pretend-onnx-opset21", "binary");
  const tok = Buffer.from('{"vocab":[]}', "utf8");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  const manifest = {
    schema: "model-manifest-v1",
    modelVersion: "rt-test",
    opset: ENCODER_OPSET,
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

describe("VC2A EncoderRuntime emit seam", () => {
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
    const rt = createEncoderRuntime({ reporter: noop });
    const dir = makeAssetDir();
    try {
      rt.load(dir);
    } finally {
      cleanup(dir);
    }
    assert.deepEqual(emitted, []);
  });
});
