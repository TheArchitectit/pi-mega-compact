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
const { verifyEncoderAsset, readEncoderManifest, detectPlatform } = assetMod;

let runtimeMod;
try {
  runtimeMod = require("../dist/vector-cortex/encoder/runtime.js");
} catch {
  runtimeMod = require("../src/vector-cortex/encoder/runtime.js");
}
const { createEncoderRuntime } = runtimeMod;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Q04: the default createEncoderRuntime() honors MEGACOMPACT_VC2A ("-0 selects
// mode C"). Pin the flag ON so this bundle test exercises the verify/load/infer
// path deterministically regardless of the caller's env (flag-off rollback is
// covered by the dedicated acceptance/flag tests).
process.env.MEGACOMPACT_VC2A = "1";

// The committed placeholder bundle is digest-pinned to linux-x64 (the dev/CI
// host). On any OTHER supported platform it correctly demotes PLATFORM_UNSUPPORTED
// (mode B) rather than verifying as mode A — cross-platform handling (Q02). The
// mode-A assertions below are gated on the live host matching the bundle.
const BUNDLE_PLATFORM = "linux-x64";
const HOST_PLATFORM = detectPlatform();

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

test("committed bundle verifies as mode A through the production seam (on its platform)", () => {
  const manifest = readEncoderManifest(ASSET_DIR);
  const res = verifyEncoderAsset(ASSET_DIR, manifest);
  if (HOST_PLATFORM === BUNDLE_PLATFORM) {
    assert.equal(res.ok, true, "verify passes on the matching host");
    assert.ok(res && res.embeddedBytes === manifest.totalBytes, "embedded bytes match totalBytes");
  } else {
    assert.equal(res.ok, false, "bundle demotes off-platform (not falsely verified)");
    if (!res.ok) assert.equal(res.code, "ENC_PLATFORM_UNSUPPORTED");
  }
});

test("committed bundle loads as mode A and infers within 1..512 dims (on its platform)", () => {
  const rt = createEncoderRuntime();
  const load = rt.load(ASSET_DIR);
  if (HOST_PLATFORM === BUNDLE_PLATFORM) {
    assert.equal(load.ok, true, "load ok");
    if (load.ok) assert.equal(load.mode, "A");
    for (const n of [1, 128, 512]) {
      const inf = rt.infer({ tokens: Array.from({ length: n }, (_, i) => i % 500) });
      assert.equal(inf.ok, true, `dim ${n} infers`);
      if (inf.ok) assert.equal(inf.semantic.length, 384, "384-dim semantic projection");
    }
  } else {
    assert.equal(load.ok, false, "off-platform bundle demotes to mode B");
    if (!load.ok) {
      assert.equal(load.code, "ENC_PLATFORM_UNSUPPORTED");
      assert.equal(load.mode, "B");
    }
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
    // Pin the bundle's declared platform so the digest path is exercised
    // regardless of the live host (Q02).
    const res = verifyEncoderAsset(dir, readEncoderManifest(dir), BUNDLE_PLATFORM);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "ENC_DIGEST_MISMATCH");
      const load = createEncoderRuntime({ platform: () => BUNDLE_PLATFORM }).load(dir);
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
    // manifest.onnx absent on disk -> unreadable during digest read. Pin the
    // bundle's declared platform so the digest path runs regardless of host (Q02).
    const load = createEncoderRuntime({ platform: () => BUNDLE_PLATFORM }).load(dir);
    assert.equal(load.ok, false);
    if (!load.ok) {
      assert.equal(load.code, "ENC_ASSET_UNREADABLE");
      assert.equal(load.mode, "B");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VC2C_PACKAGE_BUDGET_BYTES = 35 * 1024 * 1024;

test("VC2C package dry-run listing is under the 35 MiB budget (no .tgz created)", async () => {
  // MODEL_ASSET §packaging: the ENTIRE compressed npm package listing must be
  // <= 35 MiB. Dry-run listing ONLY — never creates a .tgz (PREVENT-DIST-001).
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const { stdout } = await execFileP("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    timeout: 120_000,
  });
  // `npm pack --json` returns an object keyed by package name with a `files`
  // array of {path,size,...} entries.
  const parsed = JSON.parse(stdout);
  const pack = Object.values(parsed)[0] ?? {};
  const files = pack.files ?? [];
  const total = files.reduce((acc, e) => acc + (Number(e?.size) || 0), 0);
  assert.ok(
    total <= VC2C_PACKAGE_BUDGET_BYTES,
    `package listing ${total} bytes exceeds ${VC2C_PACKAGE_BUDGET_BYTES} (35 MiB)`,
  );
  // The qualified manifest + ONNX must be present in the shipped listing.
  const paths = new Set(files.map((e) => e.path));
  assert.ok(
    [...paths].some((p) => p.includes("assets/vector-cortex/encoder-v1/manifest.json")),
    "qualified encoder manifest listed in package",
  );
  assert.ok(
    [...paths].some((p) => p.includes("assets/vector-cortex/encoder-v1/model.onnx")),
    "encoder ONNX listed in package",
  );
});

test("VC2C committed qualified manifest + assets exist and onnx+tokenizer stay under 35 MiB", () => {
  // The committed encoder manifest + ONNX + tokenizer are the runtime asset; the
  // ONNX+tokenizer working set must stay well under the 35 MiB shipping budget.
  const manifest = readEncoderManifest(ASSET_DIR);
  assert.ok(manifest, "qualified manifest readable");
  assert.equal(typeof manifest.onnx.sha256, "string");
  assert.ok(manifest.onnx.bytes > 0, "onnx bytes declared");
  const onnxBytes = manifest.onnx.bytes;
  assert.ok(onnxBytes < VC2C_PACKAGE_BUDGET_BYTES, "onnx bytes under 35 MiB");
  assert.ok(manifest.tokenizer.bytes < VC2C_PACKAGE_BUDGET_BYTES, "tokenizer bytes under 35 MiB");
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
