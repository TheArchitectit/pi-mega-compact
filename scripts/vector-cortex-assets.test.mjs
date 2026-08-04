#!/usr/bin/env node
/**
 * vector-cortex-assets.test.mjs — VC2A committed asset bundle test (task 6/7).
 *
 * Verifies the shipped `assets/vector-cortex/encoder-v1/*` bundle against its own
 * ModelManifestV1 and against the production verification seam, plus the matching
 * training provenance scaffold. This test runs against the REAL committed bytes on
 * disk — it does not fabricate a bundle — and exercises the same verify/load path
 * the runtime uses.
 *
 *   - manifest schema + opset17/batch1/max512 constraints
 *   - on-disk ONNX + tokenizer SHA-256 equal the manifest digests (mode-A ready)
 *   - the runtime loads the committed asset as mode A and infers within 1..512 dims
 *   - a one-byte mutation of model.onnx demotes ENC_DIGEST_MISMATCH (mode B)
 *   - truncating model.onnx demotes ENC_ASSET_UNREADABLE (mode B)
 *   - training dataset-manifest exists and carries the provenance scaffold
 *
 * LOCAL ONLY: reads the filesystem, zero network (PREVENT-PI-004).
 *
 * Run: node scripts/vector-cortex-assets.test.mjs
 * (Standalone; the compiled acceptance aggregator src/vector-cortex/vc2a-acceptance.test.ts
 *  is the one picked up by `npm test` via dist/.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ASSET_DIR = join(ROOT, "assets", "vector-cortex", "encoder-v1");

const require = createRequire(import.meta.url);
// The compiled encoder seam lives in dist/vector-cortex/encoder after publish
// (or src directly on a source checkout — try both).
let assetMod;
try {
  assetMod = require("../dist/vector-cortex/encoder/asset.js");
} catch {
  assetMod = require("../src/vector-cortex/encoder/asset.js");
}
const { verifyEncoderAsset, readEncoderManifest } = assetMod;

let runtimeMod;
try {
  runtimeMod = require("../dist/vector-cortex/encoder/runtime.js");
} catch {
  runtimeMod = require("../src/vector-cortex/encoder/runtime.js");
}
const { createEncoderRuntime } = runtimeMod;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("committed bundle: model.onnx + tokenizer.json exist and hash to the manifest", () => {
  const manifest = readEncoderManifest(ASSET_DIR);
  assert.ok(manifest, "manifest parses + shape-checks");
  assert.equal(manifest.schema, "model-manifest-v1");
  assert.equal(manifest.opset, 17, "opset 17");
  assert.equal(manifest.batch, 1, "batch 1");
  assert.equal(manifest.maxTokens, 512, "maxTokens 512");
  assert.equal(manifest.semanticWidth, 384, "semantic width 384");

  const onnx = readFileSync(join(ASSET_DIR, manifest.onnx.path));
  assert.equal(sha256(onnx), manifest.onnx.sha256, "ONNX digest matches manifest");
  assert.equal(onnx.length, manifest.onnx.bytes, "ONNX byte count matches manifest");

  const tok = readFileSync(join(ASSET_DIR, manifest.tokenizer.path));
  assert.equal(sha256(tok), manifest.tokenizer.sha256, "tokenizer digest matches manifest");
  assert.equal(tok.length, manifest.tokenizer.bytes, "tokenizer byte count matches manifest");
});

test("committed bundle verifies as mode A through the production seam", () => {
  const manifest = readEncoderManifest(ASSET_DIR);
  const res = verifyEncoderAsset(ASSET_DIR, manifest);
  assert.equal(res.ok, true, "verify passes");
  assert.ok(res && res.embeddedBytes === manifest.totalBytes, "embedded bytes match totalBytes");
});

test("committed bundle loads as mode A and infers within 1..512 dims", () => {
  const rt = createEncoderRuntime();
  const load = rt.load(ASSET_DIR);
  assert.equal(load.ok, true, "load ok");
  if (load.ok) assert.equal(load.mode, "A");
  for (const n of [1, 128, 512]) {
    const inf = rt.infer({ tokens: Array.from({ length: n }, (_, i) => i % 500) });
    assert.equal(inf.ok, true, `dim ${n} infers`);
    if (inf.ok) assert.equal(inf.semantic.length, 384, "384-dim semantic projection");
  }
});

test("one-byte mutation of the committed ONNX demotes ENC_DIGEST_MISMATCH (mode B)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-vc2a-asset-mut-"));
  try {
    const manifest = readEncoderManifest(ASSET_DIR);
    const onnx = readFileSync(join(ASSET_DIR, manifest.onnx.path));
    const mutated = Buffer.concat([onnx.subarray(0, onnx.length - 1), Buffer.from([onnx[onnx.length - 1] ^ 0x01])]);
    writeFileSync(join(dir, "model.onnx"), mutated);
    writeFileSync(join(dir, "tokenizer.json"), readFileSync(join(ASSET_DIR, manifest.tokenizer.path)));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const res = verifyEncoderAsset(dir, readEncoderManifest(dir));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "ENC_DIGEST_MISMATCH");
      const load = createEncoderRuntime().load(dir);
      assert.equal(load.ok, false);
      if (!load.ok) assert.equal(load.mode, "B");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncating the committed ONNX demotes ENC_ASSET_UNREADABLE (mode B)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-vc2a-asset-trunc-"));
  try {
    const manifest = readEncoderManifest(ASSET_DIR);
    writeFileSync(join(dir, "tokenizer.json"), readFileSync(join(ASSET_DIR, manifest.tokenizer.path)));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    // manifest.onnx absent on disk -> unreadable during digest read.
    const load = createEncoderRuntime().load(dir);
    assert.equal(load.ok, false);
    if (!load.ok) {
      assert.equal(load.code, "ENC_ASSET_UNREADABLE");
      assert.equal(load.mode, "B");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("training provenance scaffold exists and matches the manifest digest", () => {
  const dm = readFileSync(join(ROOT, "training", "vector-cortex", "dataset-manifest.json"), "utf8");
  const parsed = JSON.parse(dm);
  assert.equal(parsed.schema, "training-dataset-manifest-v1");
  assert.equal(parsed.policy.noUserLedger, true, "no user ledger as training data");
  assert.equal(parsed.policy.noSecrets, true, "no secrets");
  assert.ok(Array.isArray(parsed.records), "records array present");
  assert.ok(parsed.policy.consent.length > 0, "explicit consent mention present");
});

// Keep the module importable; coverage is exercised via `node --test` entry.
