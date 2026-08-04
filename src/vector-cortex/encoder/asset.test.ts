/** VC2A asset verification tests (task 2) — ENC-ASSET-001 / ENC-DIGEST-002 /
 *  ENC-PLATFORM-003 + constraint matrix + unreadable/truncated injection. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENC_FAIL,
  ENCODER_BATCH,
  ENCODER_MAX_TOKENS,
  ENCODER_OPSET,
  type ModelManifestV1,
} from "./types.js";
import { verifyEncoderAsset, readEncoderManifest, detectPlatform } from "./asset.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The live platform, or linux-x64 in an unrecognized-host test env. The temp
 *  asset manifests derive their declared platform from here so they always match
 *  the runtime host — otherwise verification spuriously demotes to
 *  PLATFORM_UNSUPPORTED on non-linux-x64 machines (cross-platform Q02). */
const HOST_PLATFORM = detectPlatform() ?? "linux-x64";

/** Walk up from the test location to the repo root (assets/ + conformance/). */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    try {
      if (readFileSync(join(dir, "package.json"), "utf8").includes('"name"')) return dir;
    } catch {
      /* keep walking (dist/src/... has no package.json) */
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("repo root not found");
}
const REPO = repoRoot(HERE);
const COMMITTED_ASSET = join(REPO, "assets", "vector-cortex", "encoder-v1");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build a temp asset dir containing onnx + tokenizer + manifest. */
function buildAssetDir(input: {
  onnxBytes?: Buffer;
  tokBytes?: Buffer;
  manifest?: ModelManifestV1;
}): { dir: string; manifest: ModelManifestV1 } {
  const dir = join(tmpdir(), `vc2a-asset-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const onnx = input.onnxBytes ?? Buffer.from("00000000-pretend-onnx-opset17", "binary");
  const tok = input.tokBytes ?? Buffer.from('{"vocab":[]}', "utf8");
  writeFileSync(join(dir, "model.onnx"), onnx);
  writeFileSync(join(dir, "tokenizer.json"), tok);
  const manifest: ModelManifestV1 =
    input.manifest ??
    {
      schema: "model-manifest-v1",
      modelVersion: "test-v1",
      opset: ENCODER_OPSET,
      batch: ENCODER_BATCH,
      maxTokens: ENCODER_MAX_TOKENS,
      platform: HOST_PLATFORM,
      hiddenWidth: 384,
      semanticWidth: 384,
      heads: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 },
      onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
      tokenizer: { path: "tokenizer.json", sha256: sha256(tok), bytes: tok.length },
      totalBytes: onnx.length + tok.length,
      trainingManifestDigest: "0".repeat(64),
    };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { dir, manifest };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("VC2A asset verification (ENC-ASSET-001)", () => {
  test("opset17 manifest + matching digests load successfully (mode A eligible)", () => {
    const { dir } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, readEncoderManifest(dir));
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.ok(res.embeddedBytes > 0, "embedded bytes measured");
        assert.equal(res.onnxDigest.length, 64);
        assert.equal(res.tokenizerDigest.length, 64);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("the committed encoder-v1 bundle verifies against its own manifest", () => {
    const manifest = readEncoderManifest(COMMITTED_ASSET);
    assert.ok(manifest, "committed manifest readable");
    const host = detectPlatform();
    const res = verifyEncoderAsset(COMMITTED_ASSET, manifest);
    // The committed placeholder bundle is digest-pinned to linux-x64 (the dev /
    // CI host). It verifies as mode A on that matching platform and correctly
    // demotes PLATFORM_UNSUPPORTED on any other supported platform — a valid,
    // digest-verified outcome either way (cross-platform Q02). The test must
    // not spuriously fail the suite on non-linux-x64 hosts.
    if (host === manifest.platform) {
      assert.equal(res.ok, true, "bundle verifies on its matching platform");
    } else {
      assert.equal(res.ok, false, "bundle demotes off-platform (not falsely verified)");
      if (!res.ok) assert.equal(res.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
    }
  });

  test("one-byte model mutation demotes BEFORE load (ENC_DIGEST_MISMATCH / ENC-DIGEST-002)", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const orig = readFileSync(join(dir, "model.onnx"));
      const mutated = Buffer.concat([
        orig.subarray(0, orig.length - 1),
        Buffer.from([orig[orig.length - 1]! ^ 0x01]),
      ]);
      writeFileSync(join(dir, "model.onnx"), mutated);
      const res = verifyEncoderAsset(dir, manifest);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH);
    } finally {
      cleanup(dir);
    }
  });

  test("one-byte tokenizer mutation demotes (ENC_DIGEST_MISMATCH)", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const orig = readFileSync(join(dir, "tokenizer.json"));
      const mutated = Buffer.concat([
        orig.subarray(0, orig.length - 1),
        Buffer.from([orig[orig.length - 1]! ^ 0x01]),
      ]);
      writeFileSync(join(dir, "tokenizer.json"), mutated);
      const res = verifyEncoderAsset(dir, manifest);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.DIGEST_MISMATCH);
    } finally {
      cleanup(dir);
    }
  });

  test("truncated/unreadable ONNX during digest read demotes ENC_ASSET_UNREADABLE", () => {
    const dir = join(tmpdir(), `vc2a-unreadable-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      // Write only the tokenizer; the manifest's onnx path does not exist.
      writeFileSync(join(dir, "tokenizer.json"), '{"vocab":[]}');
      const m = readEncoderManifest(COMMITTED_ASSET);
      assert.ok(m, "committed manifest readable");
      const res = verifyEncoderAsset(dir, m);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.ASSET_UNREADABLE);
    } finally {
      cleanup(dir);
    }
  });

  test("unsupported platform selects B (ENC_PLATFORM_UNSUPPORTED / ENC-PLATFORM-003)", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, manifest, null);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
    } finally {
      cleanup(dir);
    }
  });

  test("manifest platform that disagrees with the host demotes ENC_PLATFORM_UNSUPPORTED", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      // Bundles declare a platform; a cross-shipped one (manifest darwin-arm64
      // on a linux-x64 host) must NOT load as qualified mode A.
      const res = verifyEncoderAsset(dir, { ...manifest, platform: "darwin-arm64" as const }, "linux-x64");
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.PLATFORM_UNSUPPORTED);
      // Matching platform still verifies.
      const ok = verifyEncoderAsset(dir, { ...manifest, platform: "linux-x64" as const }, "linux-x64");
      assert.equal(ok.ok, true);
    } finally {
      cleanup(dir);
    }
  });

  test("traversal / non-basename asset paths are rejected (ENC_MANIFEST_INVALID)", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      for (const badPath of ["../../../../etc/passwd", "subdir/model.onnx", "..", "./model.onnx"]) {
        const badOnnx = {
          ...manifest,
          onnx: { ...manifest.onnx, path: badPath },
        };
        const res = verifyEncoderAsset(dir, badOnnx, "linux-x64");
        assert.equal(res.ok, false, `onnx path ${badPath} rejected`);
        if (!res.ok) assert.equal(res.code, ENC_FAIL.MANIFEST_INVALID);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("opset != 17 demotes ENC_OPSET_INVALID", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, { ...manifest, opset: 16 });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.OPSET_INVALID);
    } finally {
      cleanup(dir);
    }
  });

  test("batch != 1 demotes ENC_BATCH_INVALID", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, { ...manifest, batch: 2 });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.BATCH_INVALID);
    } finally {
      cleanup(dir);
    }
  });

  test("maxTokens > 512 demotes ENC_TOKENS_EXCEEDED", () => {
    const { dir, manifest } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, { ...manifest, maxTokens: 513 });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.TOKENS_EXCEEDED);
    } finally {
      cleanup(dir);
    }
  });

  test("invalid / missing manifest demotes ENC_MANIFEST_INVALID", () => {
    const { dir } = buildAssetDir({});
    try {
      const res = verifyEncoderAsset(dir, null);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, ENC_FAIL.MANIFEST_INVALID);
      const res2 = verifyEncoderAsset(dir, { schema: "nope" });
      assert.equal(res2.ok, false);
      if (!res2.ok) assert.equal(res2.code, ENC_FAIL.MANIFEST_INVALID);
    } finally {
      cleanup(dir);
    }
  });
});
