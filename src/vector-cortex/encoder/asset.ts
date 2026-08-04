/**
 * vector-cortex/encoder/asset.ts — VC2A asset verification (task 2).
 *
 * Verifies a ModelManifestV1 before any allocation: SHA-256 the ONNX and
 * tokenizer against the manifest digests, require opset 17, batch exactly 1 and
 * maximum 512 tokens, and confirm the current platform is in the supported
 * matrix. On ANY of these the caller demotes to mode B (asset-free trigram) —
 * never a remote fetch (PREVENT-PI-004). A truncated/unreadable asset during
 * the digest read demotes with ENC_ASSET_UNREADABLE.
 *
 * Pi-agnostic. Filesystem reads only, zero network (PREVENT-PI-004).
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ENC_FAIL,
  ENCODER_BATCH,
  ENCODER_MAX_TOKENS,
  ENCODER_OPSET,
  ENCODER_SUPPORTED_PLATFORMS,
  type EncoderPlatform,
  type ModelManifestV1,
} from "./types.js";

export type AssetVerifyResult =
  | { ok: true; embeddedBytes: number; onnxDigest: string; tokenizerDigest: string }
  | { ok: false; code: string };

/** True when `p` is a single basename: non-empty, no path separators, no "..",
 *  no leading dot-segment traversal. Keeps manifest-controlled asset paths
 *  confined to the asset directory (no path-traversal via join()). */
function isBasename(p: string): boolean {
  if (!p || p.length === 0 || p.includes("/") || p.includes("\\")) return false;
  if (p === "." || p === "..") return false;
  return true;
}

/** Digest the on-disk bytes of one asset file; "" on unreadable (truncated). */
function digestFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    // Truncated / unreadable during the digest read -> ENC_ASSET_UNREADABLE.
    return null;
  }
}

/**
 * Detect the current platform (MODEL_ASSET supported matrix). Unrecognized
 * hosts return null so verification demotes to mode B (unsupported platform).
 */
export function detectPlatform(host = process.platform, arch = process.arch): EncoderPlatform | null {
  if (!host || !arch) return null;
  // Normalize "win32"/"win32"/"linux"/"darwin" + "x64"/"arm64".
  const plat = host === "win32" ? "win32" : host === "darwin" ? "darwin" : host === "linux" ? "linux" : "";
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "";
  if (!plat || !a) return null;
  const candidate = `${plat}-${a}` as EncoderPlatform;
  return (ENCODER_SUPPORTED_PLATFORMS as readonly string[]).includes(candidate)
    ? candidate
    : null;
}

function isManifest(m: unknown): m is ModelManifestV1 {
  const o = m as ModelManifestV1;
  return (
    !!o &&
    typeof o === "object" &&
    o.schema === "model-manifest-v1" &&
    typeof o.opset === "number" &&
    typeof o.batch === "number" &&
    typeof o.maxTokens === "number" &&
    typeof o.platform === "string" &&
    !!o.onnx &&
    !!o.tokenizer &&
    typeof o.onnx.path === "string" &&
    typeof o.onnx.sha256 === "string" &&
    typeof o.tokenizer.path === "string" &&
    typeof o.tokenizer.sha256 === "string"
  );
}

/**
 * Verify the asset manifest + digest + constraints BEFORE allocation.
 *
 *   - manifest parse/shape failure      -> ENC_MANIFEST_INVALID -> mode B
 *   - unsupported platform              -> ENC_PLATFORM_UNSUPPORTED -> mode B
 *   - opset != 17                       -> ENC_OPSET_INVALID -> mode B
 *   - batch != 1                        -> ENC_BATCH_INVALID -> mode B
 *   - maxTokens > 512                   -> ENC_TOKENS_EXCEEDED -> mode B
 *   - on-disk digest != manifest digest -> ENC_DIGEST_MISMATCH (one-byte mutation)
 *   - unreadable/truncated file         -> ENC_ASSET_UNREADABLE
 *
 * Returns ok only when EVERY constraint passes and both files hash to the
 * declared digests (the "only batch1/max512 verified assets reach inference"
 * invariant).
 */
export function verifyEncoderAsset(
  assetDir: string,
  manifest: unknown,
  platform: EncoderPlatform | null = detectPlatform(),
): AssetVerifyResult {
  if (typeof manifest !== "object" || manifest === null || !isManifest(manifest)) {
    return { ok: false, code: ENC_FAIL.MANIFEST_INVALID };
  }
  if (!platform) return { ok: false, code: ENC_FAIL.PLATFORM_UNSUPPORTED };
  // The manifest's declared platform must match the runtime host (per-platform
  // asset pinning): a bundle cross-shipped to the wrong arch is not qualified.
  if (manifest.platform !== platform) return { ok: false, code: ENC_FAIL.PLATFORM_UNSUPPORTED };
  if (manifest.opset !== ENCODER_OPSET) return { ok: false, code: ENC_FAIL.OPSET_INVALID };
  if (manifest.batch !== ENCODER_BATCH) return { ok: false, code: ENC_FAIL.BATCH_INVALID };
  if (manifest.maxTokens > ENCODER_MAX_TOKENS) return { ok: false, code: ENC_FAIL.TOKENS_EXCEEDED };

  // Constrain asset paths to basenames (no separators / no '..') so a forged
  // manifest cannot read digests from arbitrary paths off the asset dir.
  if (!isBasename(manifest.onnx.path) || !isBasename(manifest.tokenizer.path)) {
    return { ok: false, code: ENC_FAIL.MANIFEST_INVALID };
  }

  const onnxPath = join(assetDir, manifest.onnx.path);
  const onnxDigest = digestFile(onnxPath);
  if (onnxDigest === null) return { ok: false, code: ENC_FAIL.ASSET_UNREADABLE };
  if (onnxDigest !== manifest.onnx.sha256) return { ok: false, code: ENC_FAIL.DIGEST_MISMATCH };

  const tokPath = join(assetDir, manifest.tokenizer.path);
  const tokDigest = digestFile(tokPath);
  if (tokDigest === null) return { ok: false, code: ENC_FAIL.ASSET_UNREADABLE };
  if (tokDigest !== manifest.tokenizer.sha256) return { ok: false, code: ENC_FAIL.DIGEST_MISMATCH };

  let embeddedBytes = 0;
  try {
    embeddedBytes = statSync(onnxPath).size + statSync(tokPath).size;
  } catch {
    return { ok: false, code: ENC_FAIL.ASSET_UNREADABLE };
  }
  return { ok: true, embeddedBytes, onnxDigest, tokenizerDigest: tokDigest };
}

/**
 * Read + shape-check a committed ModelManifestV1 from an asset directory.
 * Returns the parsed manifest or null when the file is absent/malformed.
 */
export function readEncoderManifest(assetDir: string): ModelManifestV1 | null {
  try {
    const raw = JSON.parse(readFileSync(join(assetDir, "manifest.json"), "utf8")) as unknown;
    return isManifest(raw) ? raw : null;
  } catch {
    return null;
  }
}
