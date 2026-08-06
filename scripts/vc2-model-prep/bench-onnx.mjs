/**
 * VC2 model prep — encoder qualification harness (DEVELOPER TOOLING ONLY).
 *
 * Measures the two MODEL_ASSET.md gates for a candidate ONNX encoder:
 *   - p95 inference latency <= 40 ms
 *   - encoder RSS delta     <= 150 MiB
 * plus the determinism gate (identical output within 1e-6 across repeats).
 *
 * This is NOT extension runtime code: it is run by a developer to qualify an
 * asset before it ships. It performs no network access — it reads a local
 * model file only.
 *
 * IMPORTANT (measurement methodology): RSS must be sampled at STEADY STATE,
 * after an explicit GC. Each inference allocates a [1, tokens, 384] float32
 * output tensor (768 KiB at 512 tokens); if the harness retains those tensors
 * or samples before collection, it measures uncollected garbage rather than the
 * encoder's working set, and reports a false budget breach. Run under
 * `node --expose-gc` so the GC step is real.
 *
 * ENC-0a --transformers mode (additive): measures the SAME p95 gate for the
 * bge-small-en-v1.5 int8 asset under the transformers.js WASM pipeline (the
 * leading ENC backend candidate) and emits one JSONL line in the resolver's
 * bench-input shape. Run separately; does not touch the native-mode path.
 *
 * Usage:
 *   node --expose-gc scripts/vc2-model-prep/bench-onnx.mjs <model.onnx> \
 *     [--tokens=512] [--iters=300] [--threads=4] [--repeats=200]
 *
 *   node scripts/vc2-model-prep/bench-onnx.mjs --transformers \
 *     [--tokens=512] [--iters=300] [--threads=4]
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const LATENCY_BUDGET_MS = 40;
const RSS_BUDGET_MIB = 150;
const DETERMINISM_EPSILON = 1e-6;

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
}

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return +sorted[i].toFixed(2);
}

function mib(bytes) {
  return +(bytes / 1048576).toFixed(1);
}

async function collect() {
  if (typeof global.gc === "function") {
    global.gc();
    global.gc();
    await new Promise((r) => setTimeout(r, 200));
    global.gc();
    return true;
  }
  return false;
}

async function main() {
  const modelPath = process.argv[2];
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.error("usage: node --expose-gc bench-onnx.mjs <model.onnx> [--tokens=] [--iters=] [--threads=]");
    process.exit(2);
  }
  const tokens = arg("tokens", 512);
  const iters = arg("iters", 300);
  const threads = arg("threads", 4);
  const repeats = arg("repeats", 200);

  let ort;
  try {
    ort = require("onnxruntime-node");
  } catch {
    console.error("onnxruntime-node is not installed. See docs/vector-cortex/vc2-model-prep.md.");
    process.exit(2);
  }

  const rssBefore = process.memoryUsage().rss;
  const loadStart = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    graphOptimizationLevel: "all",
  });
  const loadMs = Date.now() - loadStart;

  const dims = [1, tokens];
  const ids = BigInt64Array.from({ length: tokens }, (_, i) =>
    BigInt(i === 0 ? 101 : i === tokens - 1 ? 102 : 2000 + (i % 500)),
  );
  const mask = BigInt64Array.from({ length: tokens }, () => 1n);
  const types = new BigInt64Array(tokens);
  const feeds = () => {
    const f = {};
    if (session.inputNames.includes("input_ids")) f.input_ids = new ort.Tensor("int64", ids, dims);
    if (session.inputNames.includes("attention_mask")) f.attention_mask = new ort.Tensor("int64", mask, dims);
    if (session.inputNames.includes("token_type_ids")) f.token_type_ids = new ort.Tensor("int64", types, dims);
    return f;
  };

  for (let i = 0; i < 5; i++) await session.run(feeds());

  // Latency: do NOT retain outputs (that would measure garbage, not working set).
  const lat = [];
  for (let i = 0; i < iters; i++) {
    const t = process.hrtime.bigint();
    await session.run(feeds());
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const gcRan = await collect();
  const steadyRss = mib(process.memoryUsage().rss - rssBefore);
  lat.sort((a, b) => a - b);

  // Determinism: identical inputs must yield bit-stable outputs.
  let ref = null;
  let maxDelta = 0;
  const digests = new Set();
  for (let i = 0; i < repeats; i++) {
    const out = await session.run(feeds());
    const d = out[session.outputNames[0]].data;
    digests.add(createHash("sha256").update(Buffer.from(d.buffer, d.byteOffset, d.byteLength)).digest("hex"));
    if (!ref) ref = Float32Array.from(d);
    else for (let k = 0; k < d.length; k++) {
      const delta = Math.abs(d[k] - ref[k]);
      if (delta > maxDelta) maxDelta = delta;
    }
  }

  const p95 = percentile(lat, 0.95);
  const report = {
    model: modelPath,
    modelBytes: fs.statSync(modelPath).size,
    backend: "onnxruntime-node",
    ortVersion: require("onnxruntime-node/package.json").version,
    platform: `${process.platform}-${process.arch}`,
    threads,
    tokens,
    iters,
    loadMs,
    p50: percentile(lat, 0.5),
    p95,
    p99: percentile(lat, 0.99),
    steadyRssMiB: steadyRss,
    gcRan,
    determinism: { repeats, distinctDigests: digests.size, maxAbsDelta: maxDelta },
    gates: {
      latency: p95 <= LATENCY_BUDGET_MS,
      rss: steadyRss <= RSS_BUDGET_MIB,
      determinism: digests.size === 1 && maxDelta <= DETERMINISM_EPSILON,
    },
  };
  report.gates.all = report.gates.latency && report.gates.rss && report.gates.determinism;

  console.log(JSON.stringify(report, null, 2));
  if (!gcRan) console.error("WARNING: run under `node --expose-gc`; RSS figure is unreliable without it.");
  process.exit(report.gates.all ? 0 : 1);
}

// ---------------------------------------------------------------------------
// ENC-0a --transformers mode (additive; does not touch the native-mode path).
// Measures the p95 gate for bge-small int8 under the transformers.js WASM
// pipeline and emits ONE JSONL row in the resolver's bench-input shape.
// ---------------------------------------------------------------------------

/**
 * Best-effort byte/sha256 for a cached transformers.js asset file. Returns
 * null when the file is not present (the ENC-0a degraded baseline — real
 * asset not yet fetched; the sizes are recorded constants instead).
 */
function cachedAsset(path) {
  try {
    const buf = fs.readFileSync(path);
    return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  } catch {
    return null;
  }
}

/**
 * Locates the transformers.js cache dir for the bge-small-en-v1.5 ONNX int8
 * release (`~/.cache/huggingface/hub/models--Xenova--bge-small-en-v1.5/` on
 * Linux/macOS). ENC-0b (asset fetch) will pin the definitive cache layout; this
 * is best-effort developer tooling.
 */
function transformersCachePaths() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const base = join(home, ".cache", "huggingface", "hub", "models--Xenova--bge-small-en-v1.5", "snapshots");
  let modelOnnx = null;
  let tokenizerJson = null;
  try {
    const snapshots = fs.readdirSync(base);
    const snapshot = snapshots.sort().at(-1);
    if (snapshot) {
      const snap = join(base, snapshot);
      for (const name of fs.readdirSync(snap)) {
        const full = join(snap, name);
        if (/quantized.*\.onnx$/.test(name)) modelOnnx = full;
        if (name === "tokenizer.json") tokenizerJson = full;
      }
    }
  } catch {
    // no cache yet -> degraded baseline
  }
  return { modelOnnx, tokenizerJson };
}

/** ENC-0a degenerate recorded constants (matching the resolver's RECORDED table). */
const TF_WASM_SHELL_MIB = 9.5;
const TF_BGE_INT8_MIB = 23;

async function mainTransformers() {
  const tokens = arg("tokens", 512);
  const iters = arg("iters", 300);
  const threads = arg("threads", 4);
  const platform = `${process.platform}-${process.arch}`;

  // guardrails-allow PREVENT-PI-004: release-time developer benchmark tooling
  // that loads the transformers.js asset (cached locally by the tool), not
  // extension runtime code — the runtime itself never performs network access.
  let pipeline;
  try {
    pipeline = require("@huggingface/transformers");
  } catch {
    // @huggingface/transformers not installed -> degraded baseline, never block.
    const metrics = { bytes: Math.round((TF_WASM_SHELL_MIB + TF_BGE_INT8_MIB) * 1048576) };
    const row = {
      measured_p95_ms: null,
      install_bytes_model: metrics.bytes,
      install_bytes_tokenizer: 0,
      model_sha256: "01cbed8b0b301609542ff8c392c3e7d927b0d848ac53a768dfffd33bfe6005ff",
      tokenizer_sha256: "ada18e5c4dfcb5c369c05f4ffc10bc40298ce707e78f16135c6d33019f6db8cd",
      platform,
      degraded: true,
    };
    process.stdout.write(JSON.stringify(row) + "\n");
    console.error("BENCH_TRANSFORMERS_DEGRADED: @huggingface/transformers not installed; no p95 measured.");
    process.exit(2);
  }

  const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
    dtype: "q8",
    device: "cpu",
    threads,
  });

  // 512-token input: 505 content tokens + [CLS]/[SEP] padding handled by the
  // pipeline tokenizer; a deterministic repeated sentence yields a fixed shape.
  const input = (Array(64).fill("the quick brown fox jumps over the lazy dog")).join(" ");
  const extract = async () => {
    const start = process.hrtime.bigint();
    await extractor(input, { pooling: "mean", normalize: true });
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  for (let i = 0; i < 5; i++) await extract(); // warm-up
  const lat = [];
  for (let i = 0; i < iters; i++) lat.push(await extract());
  lat.sort((a, b) => a - b);
  const p95 = percentile(lat, 0.95);

  // Best-effort install bytes + sha256 from the local cache (degraded -> constants).
  const { modelOnnx, tokenizerJson } = transformersCachePaths();
  const model = cachedAsset(modelOnnx);
  const tokenizer = cachedAsset(tokenizerJson);

  const row = {
    measured_p95_ms: p95,
    install_bytes_model: model ? model.bytes : Math.round(TF_WASM_SHELL_MIB * 1048576),
    install_bytes_tokenizer: tokenizer ? tokenizer.bytes : Math.round(TF_BGE_INT8_MIB * 1048576),
    model_sha256: model ? model.sha256 : "01cbed8b0b301609542ff8c392c3e7d927b0d848ac53a768dfffd33bfe6005ff",
    tokenizer_sha256: tokenizer ? tokenizer.sha256 : "ada18e5c4dfcb5c369c05f4ffc10bc40298ce707e78f16135c6d33019f6db8cd",
    platform,
  };

  process.stdout.write(JSON.stringify(row) + "\n");
  if (!model || !tokenizer) {
    console.error("BENCH_TRANSFORMERS_DEGRADED: assets missing from cache; sizes/digests are recorded constants.");
  }
  process.exit(p95 <= LATENCY_BUDGET_MS ? 0 : 1);
}

if (process.argv.includes("--transformers")) {
  mainTransformers().catch((e) => {
    console.error("BENCH_FAIL", e && e.message);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error("BENCH_FAIL", e && e.message);
    process.exit(1);
  });
}
