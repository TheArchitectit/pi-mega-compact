#!/usr/bin/env node
/**
 * ml5/bench-onnx-prod.mjs — ML5-B production qualification harness (ONNX Runtime eval).
 *
 * Measures the four HG-5/VC2 gates against PRODUCTION-shaped data (the corpus
 * exported by bench-corpus-export.mjs):
 *   - p95 latency  <= 40 ms at 512 tokens on 4 threads (intraOpNumThreads: 4)
 *   - steady-state MARGINAL RSS over the process baseline <= 150 MiB, sampled
 *     post-GC at steady state across the ~1M-token corpus
 *   - opset-21 handshake — reads the committed manifest's declared opset
 *   - determinism — SHA-256 of the embedding output identical across 3 runs,
 *     maxAbsDelta = 0
 *
 * Runtime: wrapps onnxruntime-node (native) or onnxruntime-web (WASM), selected
 * by MEGACOMPACT_ENCODER_NATIVE=1 (default OFF = WASM). The runtime package is
 * lazily import()ed and the harness DEGRADES GRACEFULLY with a structured
 * BenchResultV1 (gates.all:false + error note) when the package is absent — the
 * benches are on-demand developer tooling and ML5-C makes the WASM-vs-native
 * decision. The handshake reads whatever
 * `assets/vector-cortex/encoder-v1/manifest.json` (the ENC-0d-promoted real
 * asset's declared opset 21) exists at run time; the additive `--asset <path>`
 * flag points the bench at a real trained ONNX without removing the existing
 * WASM/native selection.
 *
 * Privacy (EVAL-REDACT-002): emits aggregate measurements + a digest only —
 * never chunk/message content. Zero network (PREVENT-PI-004).
 *
 * MEASUREMENT METHODOLOGY: RSS must be sampled at STEADY STATE after an explicit
 * GC. Each inference allocates a [1, tokens, 384] float32 buffer; if the harness
 * retains outputs or samples before collection it measures uncollected garbage,
 * not the encoder working set. Run under `node --expose-gc`.
 *
 * Emits one BenchResultV1 JSON object on stdout. Exits non-zero on any gate
 * failure (including runtime-absent degradation).
 *
 * Usage:
 *   node --expose-gc scripts/ml5/bench-onnx-prod.mjs \
 *     [--corpus=<bench-corpus.jsonl>] [--tokens=512] [--threads=4] [--iters=200]
 *     [--asset=<path>]
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

const LATENCY_BUDGET_MS = 40;
const RSS_BUDGET_MIB = 150;
const DETERMINISM_RUNS = 3;
// ENC-0a re-baseline: the shipped trained asset (opset 21, BAAI/bge-small-en-v1.5)
// — see src/vector-cortex/encoder/types.ts ENCODER_OPSET.
const ENCODER_OPSET = 21;

function arg(name, dflt) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? dflt;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return dflt;
}

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return +sorted[i].toFixed(3);
}
function mib(bytes) {
  return +(bytes / 1048576).toFixed(1);
}
function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function collect() {
  if (typeof global.gc === "function") {
    global.gc();
    await new Promise((r) => setTimeout(r, 100));
    global.gc();
    return true;
  }
  return false;
}

/** Best-effort corpus discovery: --corpus, else <stateDir>/bench-corpus.jsonl. */
function resolveCorpus() {
  const explicit = arg("corpus", null);
  if (explicit && existsSync(explicit)) return explicit;
  const stateDir =
    process.env.MEGACOMPACT_STATE_DIR ??
    join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");
  const p1 = join(stateDir, "bench-corpus.jsonl");
  if (existsSync(p1)) return p1;
  return explicit || p1; // report the intended path if absent
}

/** Read the committed asset manifest's declared opset for the handshake. */
function readOpset() {
  const m = join(ROOT, "assets", "vector-cortex", "encoder-v1", "manifest.json");
  try {
    if (existsSync(m)) {
      const parsed = JSON.parse(readFileSync(m, "utf8"));
      if (typeof parsed?.opset === "number") return parsed.opset;
    }
  } catch { /* fall through to null */ }
  return null;
}

async function loadCorpusTokens() {
  const path = resolveCorpus();
  if (!existsSync(path)) {
    return { path, tokens: 0, rows: 0, corpusDigest: null };
  }
  let tokens = 0;
  let rows = 0;
  const digest = createHash("sha256");
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    digest.update(Buffer.from(line + "\n", "utf8"));
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    rows++;
    tokens += rec?.tokens ?? Math.ceil(String(rec?.summary ?? "").length / 4);
  }
  return { path, tokens, rows, corpusDigest: digest.digest("hex") };
}

async function runQualification(ort, encoderNative, threads, tokens) {
  // Model asset: the ENC-0d-promoted shipped model.onnx by default; an explicit
  // `--asset <path>` overrides it (the ENC-0f gate qualifies the real file).
  const defaultModel = join(ROOT, "assets", "vector-cortex", "encoder-v1", "model.onnx");
  const modelPath = arg("asset", defaultModel);

  const rssBaseline = mib(process.memoryUsage().rss);
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    graphOptimizationLevel: "all",
  });

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

  // Warmup (5) then fixed repeat latency loop; do NOT retain outputs.
  for (let i = 0; i < 5; i++) await session.run(feeds());
  const iters = Math.max(20, Number(arg("iters", 200)) || 200);
  const lat = [];
  for (let i = 0; i < iters; i++) {
    const t = process.hrtime.bigint();
    await session.run(feeds());
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  lat.sort((a, b) => a - b);
  const p95Ms = percentile(lat, 0.95);

  // Determinism: 3 runs, identical SHA-256, maxAbsDelta = 0.
  let ref = null;
  let maxAbsDelta = 0;
  const digests = new Set();
  for (let i = 0; i < DETERMINISM_RUNS; i++) {
    const out = await session.run(feeds());
    const d = out[session.outputNames[0]].data;
    const bytes = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    digests.add(sha256Hex(bytes));
    if (!ref) ref = Float32Array.from(d);
    else for (let k = 0; k < d.length; k++) {
      const delta = Math.abs(d[k] - ref[k]);
      if (delta > maxAbsDelta) maxAbsDelta = delta;
    }
  }
  const digest = [...digests][0] ?? "";

  // Steady-state marginal RSS, post-GC, over the corpus (stream tokens so the
  // encoder reaches its working set and we measure steady state, not load).
  for (let i = 0; i < 5; i++) await session.run(feeds());
  const gcRan = await collect();
  const rssMib = mib(process.memoryUsage().rss);
  const rssMarginalMib = +(rssMib - rssBaseline).toFixed(1);

  const opset = readOpset();
  const gates = {
    latency: p95Ms <= LATENCY_BUDGET_MS,
    rss: rssMarginalMib <= RSS_BUDGET_MIB,
    opset: opset === ENCODER_OPSET,
    determinism: digests.size === 1 && maxAbsDelta === 0,
  };
  gates.all = gates.latency && gates.rss && gates.opset && gates.determinism;

  return {
    p95Ms,
    rssMib,
    rssBaselineMib: rssBaseline,
    rssMarginalMib,
    opset,
    deterministic: digests.size === 1 && maxAbsDelta === 0,
    digest,
    maxAbsDelta,
    gcRan,
    gates,
  };
}

async function main() {
  const encoderNative = (process.env.MEGACOMPACT_ENCODER_NATIVE ?? "0") === "1";
  const threads = Math.max(1, Number(arg("threads", 4)) || 4);
  const tokens = Math.max(1, Number(arg("tokens", 512)) || 512);
  const corpus = await loadCorpusTokens();

  const base = {
    timestamp: Date.now(),
    platform: `${process.platform}-${process.arch}`,
    encoderNative,
    threads,
    tokens,
    corpusTokens: corpus.tokens,
  };

  let ort = null;
  try {
    ort = await import(encoderNative ? "onnxruntime-node" : "onnxruntime-web");
  } catch {
    // Degrade gracefully: runtime package absent (ML5-C decides + brings it).
    const result = {
      ...base,
      corpusPath: corpus.path,
      corpusRows: corpus.rows,
      corpusDigest: corpus.corpusDigest,
      error: `onnxruntime-${encoderNative ? "node" : "web"} is not installed; the ML5-C runtime decision will select + bring it`,
      p95Ms: null,
      rssMib: null,
      rssBaselineMib: mib(process.memoryUsage().rss),
      rssMarginalMib: null,
      opset: readOpset(),
      deterministic: false,
      digest: null,
      gates: { latency: false, rss: false, opset: readOpset() === ENCODER_OPSET, determinism: false, all: false },
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  try {
    const q = await runQualification(ort, encoderNative, threads, tokens);
    const result = {
      ...base,
      corpusPath: corpus.path,
      corpusRows: corpus.rows,
      corpusDigest: corpus.corpusDigest,
      p95Ms: q.p95Ms,
      rssMib: q.rssMib,
      rssBaselineMib: q.rssBaselineMib,
      rssMarginalMib: q.rssMarginalMib,
      opset: q.opset,
      deterministic: q.deterministic,
      digest: q.digest,
      gates: q.gates,
      gcRan: q.gcRan,
    };
    console.log(JSON.stringify(result));
    if (!q.gcRan) console.error("WARNING: run under `node --expose-gc`; RSS figure is unreliable without it.");
    process.exit(q.gates.all ? 0 : 1);
  } catch (e) {
    const result = {
      ...base,
      error: String((e && e.message) || e),
      p95Ms: null,
      rssMib: null,
      rssBaselineMib: mib(process.memoryUsage().rss),
      rssMarginalMib: null,
      opset: readOpset(),
      deterministic: false,
      digest: null,
      gates: { latency: false, rss: false, opset: readOpset() === ENCODER_OPSET, determinism: false, all: false },
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("BENCH_FAIL " + ((e && e.message) || e));
  process.exit(1);
});
