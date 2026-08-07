#!/usr/bin/env node
/**
 * verify-staged-asset.mjs — assert the staged encoder-v1 asset is REAL (not placeholder).
 *
 * Reads assets/vector-cortex/encoder-v1/manifest.json and model-card.json.
 * Asserts:
 *   - modelVersion === "encoder-v1" (not "-placeholder")
 *   - onnx.sha256 matches the real pinned digest
 *   - tokenizer.sha256 matches the real pinned digest
 *   - opset === 21
 *   - model-card.json exists and has schema "model-card-v1"
 *
 * Zero network (PREVENT-PI-004). Pure local file reads + JSON parse.
 * Exit 1 on any failure.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(scriptDir, "..", "..", "assets", "vector-cortex", "encoder-v1");

const REAL_MODEL_SHA = "913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2";
const REAL_TOKENIZER_SHA = "ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9";

let failures = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures++;
}

try {
  const manifestPath = join(ASSET_DIR, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.modelVersion !== "encoder-v1") {
    fail(`modelVersion is "${manifest.modelVersion}" (expected "encoder-v1", not "-placeholder")`);
  }

  if (manifest.onnx?.sha256 !== REAL_MODEL_SHA) {
    fail(`onnx.sha256 is "${manifest.onnx?.sha256}" (expected ${REAL_MODEL_SHA})`);
  }

  if (manifest.tokenizer?.sha256 !== REAL_TOKENIZER_SHA) {
    fail(`tokenizer.sha256 is "${manifest.tokenizer?.sha256}" (expected ${REAL_TOKENIZER_SHA})`);
  }

  if (manifest.opset !== 21) {
    fail(`opset is ${manifest.opset} (expected 21)`);
  }
} catch (err) {
  fail(`cannot read manifest.json: ${err.message}`);
}

try {
  const cardPath = join(ASSET_DIR, "model-card.json");
  const card = JSON.parse(readFileSync(cardPath, "utf8"));

  if (card.schema !== "model-card-v1") {
    fail(`model-card schema is "${card.schema}" (expected "model-card-v1")`);
  }
} catch (err) {
  fail(`cannot read model-card.json: ${err.message}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log("PASS: staged encoder-v1 asset verified (real digests, opset 21, model-card-v1).");
