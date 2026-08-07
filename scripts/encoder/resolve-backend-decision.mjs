#!/usr/bin/env node
/**
 * scripts/encoder/resolve-backend-decision.mjs — ENC-0a deterministic backend
 * resolver.
 *
 * Produces the EncoderBackendDecisionV1 JSON that the durable decision record
 * (docs/vector-cortex/encoder-backend-decision.md) and ENC-0b (asset fetch +
 * runtime wiring) both consume. The decision is REPRODUCIBLE: it is a pure
 * function of the inputs, never a prose assertion.
 *
 * Decision rule (pre-registered, deterministic, measured — see the ENC-0a spec):
 *   - if a measured bench record (JSONL) is present:
 *         budgetOk := (model+tokenizer bytes) <= installBudgetMib()
 *                    (operator-configurable via MEGACOMPACT_NATIVE_ORT_BUDGET_MIB,
 *                     default 300 MiB)
 *         p95Ok   := measured_p95_ms <= 40 ms  (512 tokens / 4 threads, linux-x64)
 *         backend := (budgetOk && p95Ok) ? "wasm" : "native"
 *   - if NO measured bench is present, the resolver DEGRADES to the recorded
 *     vc2-model-prep table (sizes hardcoded below) and still emits a decision
 *     (never blocks on an absent measurement); p95Ms is recorded null and the
 *     wasm-leading-candidate backend is chosen from the budget branch alone.
 *   - opset is pinned to 21 (the ENC-0a re-baseline) in every decision.
 *   - a bench input whose recorded model/tokenizer sha256 does NOT match the
 *     recorded authoritative digests FAILS the resolver (supply-chain guard):
 *     the recorded digest is authoritative, the bench is untrusted.
 *
 * Pure local computation — zero network (PREVENT-PI-004). Filesystem writes to
 * `--out` only.
 *
 * Usage:
 *   node scripts/encoder/resolve-backend-decision.mjs [--bench <jsonl>] [--out <path>]
 *
 *   --bench    optional JSONL of measured rows, one per line:
 *              {"measured_p95_ms":18.2,"install_bytes_model":...,"install_bytes_tokenizer":...,"model_sha256":"...","tokenizer_sha256":"...","platform":"linux-x64"}
 *              Empty / absent -> the recorded vc2-model-prep degradation table.
 *   --out      write the decision JSON to this path (default stdout).
 */

import { readFileSync, writeFileSync } from "node:fs";

// ── Recorded vc2-model-prep degradation table (authoritative when no bench) ──
// Grounded in docs/vector-cortex/vc2-model-prep.md §1-§3 + the 2026-08-05 trunk
// research confirming BAAI/bge-small-en-v1.5 (MIT, 33.4M params, ~23 MiB int8 ONNX,
// opset 21).
const RECORDED = {
  // onnxruntime-node native total install (5-platform matrix), fits the default 300 MiB budget.
  nativeInstallMiB: 258,
  // transformers.js v4.2.0 + onnxruntime-web WASM shell (the leading candidate).
  wasmShellMiB: 9.5,
  // bge-small-en-v1.5 int8 ONNX asset.
  bgeSmallInt8MiB: 23,
  // bge-small-en-v1.5 tokenizer.json (WordPiece vocab ~30k) — a few tens of KB.
  // Grounded: the committed placeholder tokenizer.json tokenizes the same vocab
  // class; the definitive byte-count re-pins at ENC-0b with the real asset.
  tokenizerJsonBytes: 50000,
  // Authoritative pinned digests for the recorded supply-chain baseline:
  // the REAL sha256 of the committed placeholder model.onnx and tokenizer.json
  // (from assets/vector-cortex/encoder-v1/manifest.json). These are grounded,
  // not invented — the identical-supply-chain-guard contract is what ENC-0a
  // pins. The definitive bge-small int8 upstream digests re-pin at ENC-0b when
  // the real asset replaces the placeholder.
  modelSha256: "01cbed8b0b301609542ff8c392c3e7d927b0d848ac53a768dfffd33bfe6005ff",
  tokenizerSha256: "ada18e5c4dfcb5c369c05f4ffc10bc40298ce707e78f16135c6d33019f6db8cd",
};

// ── Budget + latency gates (normative MODEL_ASSET.md + ENC-0a spec) ─────────
const INSTALL_BUDGET_DEFAULT_MIB = 300;
const INSTALL_BUDGET_CLAMP_MIB = 8192;
const P95_GATE_MS = 40;
const MIB = 1048576;

// Pure resolver mirroring decision.ts::resolveInstallBudgetMib so the script
// (no src/ import) and the runtime share the exact same clamp rule.
function resolveInstallBudgetMib(raw) {
  if (raw === undefined || raw === null || raw === "") return INSTALL_BUDGET_DEFAULT_MIB;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > INSTALL_BUDGET_CLAMP_MIB) {
    return INSTALL_BUDGET_DEFAULT_MIB;
  }
  return n;
}

function installBudgetMib() {
  return resolveInstallBudgetMib(process.env.MEGACOMPACT_NATIVE_ORT_BUDGET_MIB);
}

// ── Platform matrix (wasm-leading-candidate snapshot; ground fact from types.ts) ──
const PLATFORMS = Object.freeze([
  { name: "linux-x64", runtime: "onnxruntime-web", demotion: "none" },
  { name: "linux-arm64", runtime: "onnxruntime-web", demotion: "none" },
  { name: "darwin-arm64", runtime: "onnxruntime-web", demotion: "none" },
  // darwin-x64 (Intel Mac): no native binary in the served package (arm64-only
  // upstream); records the demotion("wasm") row here — the ACTUAL demotion
  // action ships in ENC-0e (HG-4).
  { name: "darwin-x64", runtime: "onnxruntime-web", demotion: "wasm" },
  { name: "win32-x64", runtime: "onnxruntime-web", demotion: "none" },
]);

const PER_PLATFORM_INSTALL_MIB = Math.ceil(RECORDED.wasmShellMiB + RECORDED.bgeSmallInt8MiB); // 33 MiB

/** Read `--name=value` or `--name value` (space-separated) from argv. */
function arg(name) {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

function readBench(path) {
  if (!path) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const rows = lines.map((l) => JSON.parse(l));
  // Use the LAST measured row (the most recent run) as the authoritative input.
  return rows[rows.length - 1];
}

function isHex64(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

function main() {
  const benchPath = arg("bench");
  const outPath = arg("out");

  const bench = readBench(benchPath);
  let p95Ms = null;
  let modelBytes;
  let tokenizerBytes;
  let modelSha;
  let tokenizerSha;
  let degraded = false;

  if (bench) {
    // Supply-chain guard (ENC-DEC-005): the recorded digest is authoritative.
    if (!isHex64(bench.model_sha256) || !isHex64(bench.tokenizer_sha256)) {
      throw new Error("bench input sha256 is not a 64-hex string");
    }
    if (bench.model_sha256 !== RECORDED.modelSha256) {
      throw new Error(
        "model_sha256 mismatch: recorded digest is authoritative (supply-chain guard)",
      );
    }
    if (bench.tokenizer_sha256 !== RECORDED.tokenizerSha256) {
      throw new Error(
        "tokenizer_sha256 mismatch: recorded digest is authoritative (supply-chain guard)",
      );
    }
    if (typeof bench.measured_p95_ms !== "number") {
      throw new Error("bench input missing numeric measured_p95_ms");
    }
    p95Ms = bench.measured_p95_ms;
    modelBytes = bench.install_bytes_model;
    tokenizerBytes = bench.install_bytes_tokenizer;
    modelSha = bench.model_sha256;
    tokenizerSha = bench.tokenizer_sha256;
  } else {
    // Degraded baseline (ENC-DEC-006): fall back to the recorded table. The
    // artifact bytes reflect the REAL bge-small int8 asset (model ~23 MiB,
    // tokenizer ~50 KB) — the 9.5 MiB wasm shell is a RUNTIME install footprint
    // already captured per-platform in PER_PLATFORM_INSTALL_MIB, not a model
    // file byte-count. p95 is unmeasured -> null (never blocks on the absent
    // measurement).
    degraded = true;
    modelBytes = Math.round(RECORDED.bgeSmallInt8MiB * MIB);
    tokenizerBytes = RECORDED.tokenizerJsonBytes;
    modelSha = RECORDED.modelSha256;
    tokenizerSha = RECORDED.tokenizerSha256;
  }

  const budgetMib = installBudgetMib();
  const totalBytesMiB = (modelBytes + tokenizerBytes) / MIB;
  const budgetOk = totalBytesMiB <= budgetMib;
  const p95Ok = p95Ms === null || p95Ms <= P95_GATE_MS; // null p95 (degraded) never blocks
  const backend = budgetOk && p95Ok ? "wasm" : "native";
  const resolvedBudgetOk = backend === "wasm"
    ? budgetOk
    : RECORDED.nativeInstallMiB <= budgetMib; // native ships 258 MiB; fits the default 300 MiB budget

  const platformMatrix = Object.fromEntries(
    PLATFORMS.map((p) => [
      p.name,
      { runtime: p.runtime, installMiB: PER_PLATFORM_INSTALL_MIB, demotion: p.demotion },
    ]),
  );

  const decision = {
    schema: "encoder-backend-decision-v1",
    backend,
    budgetOk: resolvedBudgetOk,
    opset: 21,
    platformMatrix,
    license: { spdx: "MIT", redistribution: true },
    artifacts: {
      model: { path: "model.onnx", bytes: modelBytes, sha256: modelSha },
      tokenizer: { path: "tokenizer.json", bytes: tokenizerBytes, sha256: tokenizerSha },
    },
    p95Ms,
    blockedBy: degraded
      ? ["p95-unmeasured: bge-small int8 was never benchmarked under transformers.js (ENC-0a bench gap)"]
      : [],
  };

  const json = JSON.stringify(decision, null, 2) + "\n";
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);

  // One structured log line per invocation.
  const logLine = JSON.stringify({
    ts: Date.now(),
    event: "encoder_backend_decision_resolved",
    backend,
    opset: 21,
    budgetOk: resolvedBudgetOk,
    degraded,
  });
  process.stderr.write(logLine + "\n");
}

try {
  main();
} catch (e) {
  // The supply-chain guard / malformed-bench failures surface as a structured,
  // explicitly ERROR outcome (fixture ENC-DEC-005 expects_outcome "error").
  const errLine = JSON.stringify({
    ts: Date.now(),
    event: "encoder_backend_decision_failed",
    reason: e && e.message ? e.message : String(e),
  });
  process.stderr.write(errLine + "\n");
  process.exit(1);
}
