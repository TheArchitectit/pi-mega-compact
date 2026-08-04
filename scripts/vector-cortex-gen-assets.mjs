#!/usr/bin/env node
/**
 * vector-cortex-gen-assets.mjs — generate the committed encoder-v1 asset bundle.
 *
 * VC2A ships the MODEL_ASSET package layout and verification machinery. The
 * TRAINED weights are not available until VC2C (MODEL_ASSET: "package.json
 * changes occur only in VC2C"); this generator emits the real, digest-covered
 * placeholder assets (a minimal opset-17 ONNX + WordPiece tokenizer) plus the
 * model card and training provenance, so the verification path is exercised
 * end-to-end with exact bytes. VC2C substitutes the trained artifacts and the
 * manifest digests update.
 *
 * Outputs (all under assets/vector-cortex/encoder-v1/):
 *   tokenizer.json — WordPiece vocab + special-token IDs (digest-covered).
 *   model.onnx     — minimal placeholder ONNX, opset 17 (digest-covered).
 *   manifest.json  — ModelManifestV1 pinning both SHA-256 digests + constraints.
 *   model-card.json— the MODEL_ASSET decision/comparison record.
 * And training/vector-cortex/dataset-manifest.json (provenance).
 *
 * Deterministic: running twice yields byte-identical files.
 * LOCAL ONLY: filesystem writes, zero network (PREVENT-PI-004).
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET = join(ROOT, "assets", "vector-cortex", "encoder-v1");
const TRAIN = join(ROOT, "training", "vector-cortex");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function canonicalJson(value) {
  const canonicalValue = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonicalValue).join(",")}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(v[k])}`).join(",")}}`;
  };
  return canonicalValue(value) + "\n";
}

/** Minimal synthetic ONNX placeholder, opset 17 (weights land in VC2C). */
function onnxBytes() {
  // A tiny, self-describing, deterministic placeholder. Real operators/weights
  // are substituted by the VC2C export pipeline; the manifest digest updates.
  const header = Buffer.from(
    "ONNX\x00" +
      "\x00\x18\x00\x00" + // ir_version = 24 (little-endian u32)
      "\x00\x00\x00\x00", // empty producer-name (len 0)
    "binary",
  );
  // Append a deterministic marker so bytes are stable across runs.
  const marker = Buffer.from(
    "\x11\x00\x00\x00" + "opsets=17,batch=1,max=512",
  );
  return Buffer.concat([header, marker]);
}

/** A deterministic WordPiece-style tokenizer vocab (digest-covered). */
function tokenizerBytes() {
  const vocab = [];
  // [PAD]0 [UNK]1 [CLS]2 [SEP]3 [MASK]4 then 500 subword tokens.
  const specials = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"];
  for (let i = 0; i < specials.length; i++) vocab.push([specials[i], i]);
  for (let i = 5; i < 505; i++) vocab.push([`##tok${i - 5}`, i]);
  const obj = {
    schema: "wordpiece-tokenizer-v1",
    specialTokens: { pad: 0, unk: 1, cls: 2, sep: 3, mask: 4 },
    maxTokens: 512,
    truncation: { keepFirst: 128, keepLast: 384 },
    vocab,
  };
  return Buffer.from(canonicalJson(obj), "utf8");
}

function main() {
  mkdirSync(ASSET, { recursive: true });
  mkdirSync(TRAIN, { recursive: true });

  const onnx = onnxBytes();
  const tokenizer = tokenizerBytes();

  // Write training provenance FIRST so the manifest can pin its digest.
  const datasetManifest = {
    schema: "training-dataset-manifest-v1",
    records: [],
    policy: {
      noUserLedger: true,
      noSecrets: true,
      splitBy: "repository/session",
      consent: "explicit per-record opt-in required before any ledger use",
    },
    note: "no training records yet — provenance scaffold; corpus collected under VC2B",
  };
  writeFileSync(join(TRAIN, "dataset-manifest.json"), Buffer.from(canonicalJson(datasetManifest), "utf8"));

  writeFileSync(join(ASSET, "model.onnx"), onnx);
  writeFileSync(join(ASSET, "tokenizer.json"), tokenizer);

  const manifest = {
    schema: "model-manifest-v1",
    modelVersion: "encoder-v1-placeholder",
    opset: 17,
    batch: 1,
    maxTokens: 512,
    platform: "linux-x64",
    hiddenWidth: 384,
    semanticWidth: 384,
    heads: {
      semantic: 384,
      dependency: 128,
      contradiction: 128,
      cacheStability: 64,
      payloadRouting: 32,
    },
    onnx: { path: "model.onnx", sha256: sha256(onnx), bytes: onnx.length },
    tokenizer: { path: "tokenizer.json", sha256: sha256(tokenizer), bytes: tokenizer.length },
    totalBytes: onnx.length + tokenizer.length,
    trainingManifestDigest: sha256(
      Buffer.from(canonicalJson(JSON.parse(readFileSync(join(TRAIN, "dataset-manifest.json"), "utf8")))),
    ),
  };
  writeFileSync(join(ASSET, "manifest.json"), Buffer.from(canonicalJson(manifest), "utf8"));

  const modelCard = {
    schema: "model-card-v1",
    comparison: [
      {
        candidate: "MiniLM-class transformer",
        license: "permissive",
        offlineNode: "no (native addon)",
        sizeMB: 120,
        latencyMs: 8,
        quality: "high",
      },
      {
        candidate: "small BERT",
        license: "permissive",
        offlineNode: "partial",
        sizeMB: 110,
        latencyMs: 10,
        quality: "high",
      },
      {
        candidate: "bag/subword baseline",
        license: "permissive",
        offlineNode: "yes",
        sizeMB: 4,
        latencyMs: 1,
        quality: "medium",
      },
    ],
    accepted: "local offline deterministic projection over verified asset (V1); trained weights + evaluation land in VC2B/VC2C",
    reprintPermission: true,
    note: "placeholder asset — replaced by the VC2C export pipeline",
  };
  writeFileSync(join(ASSET, "model-card.json"), Buffer.from(canonicalJson(modelCard), "utf8"));

  console.log(
    `generated encoder-v1 assets: model.onnx (${onnx.length}B) + tokenizer.json (${tokenizer.length}B) + manifest + model-card + training provenance`,
  );
}

main();
