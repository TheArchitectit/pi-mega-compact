/**
 * dashboard-server/setup-cortex-actions-vc2.ts — VC2 model-prep action driver
 * (fetch-model + bench), ported in-process.
 *
 * Sibling of setup-cortex-actions.ts (the vc9b actor surface). Implements the
 * mechanics behind the VC9B `fetch-model` and `bench` actions, replacing the
 * previous spawn-of-scripts approach: the npm package's `files` allowlist does
 * NOT include scripts/, so scripts/vc2-model-prep/* is absent on installed
 * devices and the spawn path 500s with "not found in this checkout".
 *
 * fetch-model: downloads the candidate encoder (model.onnx + tokenizer.json)
 * from HuggingFace via node:https and verifies sha256 against pinned digests.
 * PREVENT-PI-004 opt-in: user-triggered, confirm-gated download of ML model
 * assets from HuggingFace (same exemption class as install-native-ort).
 *
 * bench: loads onnxruntime-node via createRequire, runs warm-up + timed
 * inference iterations, computes p50/p95/p99 latency, samples RSS, and runs a
 * determinism check (identical outputs within 1e-6 across repeats).
 *
 * Never throws: every failure is returned as { ok: false, ... } with a log.
 * Guardrails: PREVENT-011 (no `any`); PREVENT-PI-004 (guardrails-allow below).
 */

// guardrails-allow PREVENT-PI-004: opt-in, confirm-gated download of ML model
// assets from HuggingFace (user-triggered from dashboard)
import { get as httpsGet } from "node:https";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SetupCortexActionKind,
  SetupCortexActionResult,
} from "./api-contracts/setup-cortex.js";
import { writeLogName, writeLog } from "./setup-cortex-actions.js";

// ─── fetch-model constants ─────────────────────────────────────────────────

const HF_BASE =
  // guardrails-allow PREVENT-PI-004: opt-in, confirm-gated download of ML model
  // assets from HuggingFace (user-triggered from dashboard)
  "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main";
const MODEL_URL = `${HF_BASE}/onnx/model_qint8_avx512_vnni.onnx`;
const TOKENIZER_URL = `${HF_BASE}/tokenizer.json`;
const MODEL_SHA256 =
  "4278337fd0ff3c68bfb6291042cad8ab363e1d9fbc43dcb499fe91c871902474";
const TOKENIZER_SHA256 =
  "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037";

// ─── bench constants ───────────────────────────────────────────────────────

const LATENCY_BUDGET_MS = 40;
const RSS_BUDGET_MIB = 150;
const DETERMINISM_EPSILON = 1e-6;
const BENCH_TOKENS = 512;
const BENCH_ITERS = 300;
const BENCH_THREADS = 4;
const BENCH_REPEATS = 200;

// ─── shared helpers ────────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function mib(bytes: number): number {
  return +(bytes / 1048576).toFixed(1);
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return +sorted[i].toFixed(2);
}

// ─── fetch helpers ─────────────────────────────────────────────────────────

/** Download a URL to a Buffer via node:https (follows one redirect). */
function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // guardrails-allow PREVENT-PI-004: opt-in, confirm-gated download of ML
    // model assets from HuggingFace (user-triggered from dashboard)
    httpsGet(url, (res) => {
      if (
        res.statusCode !== undefined &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        // Follow a single redirect (HuggingFace CDN redirects).
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Fetch one asset: download, verify sha256, write to disk. */
async function fetchAsset(
  url: string,
  outPath: string,
  wantSha: string,
  logLines: string[],
): Promise<boolean> {
  const label = outPath.split("/").pop() ?? outPath;
  logLines.push(`fetching ${label}`);
  let buf: Buffer;
  try {
    buf = await download(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLines.push(`FAIL download ${label}: ${msg}`);
    return false;
  }
  const got = sha256Hex(buf);
  if (got !== wantSha) {
    logLines.push(`DIGEST MISMATCH for ${label}`);
    logLines.push(`  expected: ${wantSha}`);
    logLines.push(`  actual:   ${got}`);
    return false;
  }
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  writeFileSync(outPath, buf);
  logLines.push(`  ok  sha256=${got}  bytes=${buf.length}`);
  return true;
}

// ─── fetch-model implementation ────────────────────────────────────────────

async function runFetchModel(
  stateDir: string,
): Promise<SetupCortexActionResult> {
  const action: SetupCortexActionKind = "fetch-model";
  const { name, logPath } = writeLogName(action, stateDir);
  const outdir = join(stateDir, "vc2-model-prep");
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem write (loopback)
  mkdirSync(outdir, { recursive: true });

  const logLines: string[] = [];
  let ok = true;

  // Model
  const modelPath = join(outdir, "model.onnx");
  if (!(await fetchAsset(MODEL_URL, modelPath, MODEL_SHA256, logLines))) {
    ok = false;
    // Clean up partial download
    // guardrails-allow PREVENT-PI-004: removing file we just wrote (local FS)
    rmSync(modelPath, { force: true });
  }

  // Tokenizer
  const tokPath = join(outdir, "tokenizer.json");
  if (!(await fetchAsset(TOKENIZER_URL, tokPath, TOKENIZER_SHA256, logLines))) {
    ok = false;
    // guardrails-allow PREVENT-PI-004: removing file we just wrote (local FS)
    rmSync(tokPath, { force: true });
  }

  logLines.push("");
  logLines.push(`Staged in ${outdir}.`);
  logLines.push(
    "NOTE: this export is opset 14, NOT the opset 17 required by MODEL_ASSET.md.",
  );
  logLines.push(
    "See docs/vector-cortex/vc2-model-prep.md (Opset gap) before committing.",
  );

  writeLog(logPath, logLines.join("\n") + "\n");
  return {
    action,
    ok,
    exitCode: ok ? 0 : 1,
    logPath,
    logName: name,
    spawned: false,
  };
}

// ─── bench implementation ──────────────────────────────────────────────────

/** Locate model.onnx: stateDir first, then walk up from module for dev. */
function findModelPath(stateDir: string): string | null {
  // Check stateDir first (installed-device path).
  const fromState = join(stateDir, "vc2-model-prep", "model.onnx");
  // guardrails-allow PREVENT-PI-004: local state-dir filesystem read (loopback)
  if (existsSync(fromState)) return fromState;

  // Walk up from module for repo-checkout dev mode.
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("scripts", "vc2-model-prep", "model.onnx");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    // guardrails-allow PREVENT-PI-004: local repo filesystem read (loopback)
    if (existsSync(candidate)) return candidate;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** Run the ONNX bench: latency + RSS + determinism gates. */
async function runBench(
  stateDir: string,
): Promise<SetupCortexActionResult> {
  const action: SetupCortexActionKind = "bench";
  const { name, logPath } = writeLogName(action, stateDir);
  const logLines: string[] = [];

  const modelPath = findModelPath(stateDir);
  if (modelPath === null) {
    logLines.push("bench: model.onnx not found (run fetch-model first)");
    writeLog(logPath, logLines.join("\n") + "\n");
    return { action, ok: false, exitCode: 2, logPath, logName: name, spawned: false };
  }

  // Load onnxruntime-node via createRequire — the binding may be at the
  // ENC-2a native-ort root or in the package's node_modules.
  let ort;
  try {
    const req = createRequire(import.meta.url);
    ort = req("onnxruntime-node");
  } catch {
    logLines.push(
      "onnxruntime-node is not installed. See docs/vector-cortex/vc2-model-prep.md.",
    );
    writeLog(logPath, logLines.join("\n") + "\n");
    return { action, ok: false, exitCode: 2, logPath, logName: name, spawned: false };
  }

  const tokens = BENCH_TOKENS;
  const iters = BENCH_ITERS;
  const threads = BENCH_THREADS;
  const repeats = BENCH_REPEATS;

  const rssBefore = process.memoryUsage().rss;
  const loadStart = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    graphOptimizationLevel: "all",
  });
  const loadMs = Date.now() - loadStart;

  const dims = [1, tokens];
  const ids = BigInt64Array.from({ length: tokens }, (_: unknown, i: number) =>
    BigInt(i === 0 ? 101 : i === tokens - 1 ? 102 : 2000 + (i % 500)),
  );
  const mask = BigInt64Array.from({ length: tokens }, () => 1n);
  const types = new BigInt64Array(tokens);

  interface Feeds { [key: string]: unknown }
  const feeds = (): Feeds => {
    const f: Feeds = {};
    if (session.inputNames.includes("input_ids"))
      f.input_ids = new ort.Tensor("int64", ids, dims);
    if (session.inputNames.includes("attention_mask"))
      f.attention_mask = new ort.Tensor("int64", mask, dims);
    if (session.inputNames.includes("token_type_ids"))
      f.token_type_ids = new ort.Tensor("int64", types, dims);
    return f;
  };

  // Warm-up
  for (let i = 0; i < 5; i++) await session.run(feeds());

  // Latency measurement — do NOT retain outputs (measures working set, not GC).
  const lat: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = process.hrtime.bigint();
    await session.run(feeds());
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  // GC + steady-state RSS
  let gcRan = false;
  if (typeof global.gc === "function") {
    global.gc();
    global.gc();
    await new Promise((r) => setTimeout(r, 200));
    global.gc();
    gcRan = true;
  } else {
    logLines.push(
      "WARNING: global.gc not available (run under node --expose-gc);" +
        " RSS figure is unreliable without it.",
    );
  }
  const steadyRss = mib(process.memoryUsage().rss - rssBefore);
  lat.sort((a, b) => a - b);

  // Determinism: identical inputs must yield bit-stable outputs.
  let ref: Float32Array | null = null;
  let maxDelta = 0;
  const digests = new Set<string>();
  for (let i = 0; i < repeats; i++) {
    const out = (await session.run(feeds())) as Record<string, { data: Float32Array }>;
    const d = out[session.outputNames[0]].data;
    digests.add(
      createHash("sha256")
        .update(Buffer.from(d.buffer, d.byteOffset, d.byteLength))
        .digest("hex"),
    );
    if (!ref) ref = Float32Array.from(d);
    else
      for (let k = 0; k < d.length; k++) {
        const delta = Math.abs(d[k] - ref[k]);
        if (delta > maxDelta) maxDelta = delta;
      }
  }

  const p95 = percentile(lat, 0.95);
  const report = {
    model: modelPath,
    // guardrails-allow PREVENT-PI-004: local file stat (loopback)
    modelBytes: statSync(modelPath).size,
    backend: "onnxruntime-node",
    ortVersion: (() => {
      try {
        return createRequire(import.meta.url)("onnxruntime-node/package.json").version as string;
      } catch {
        return "unknown";
      }
    })(),
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
    determinism: {
      repeats,
      distinctDigests: digests.size,
      maxAbsDelta: maxDelta,
    },
    gates: {
      latency: p95 <= LATENCY_BUDGET_MS,
      rss: steadyRss <= RSS_BUDGET_MIB,
      determinism: digests.size === 1 && maxDelta <= DETERMINISM_EPSILON,
    },
  };
  const allPass =
    report.gates.latency && report.gates.rss && report.gates.determinism;

  logLines.push(JSON.stringify({ ...report, gates: { ...report.gates, all: allPass } }, null, 2));
  writeLog(logPath, logLines.join("\n") + "\n");
  return {
    action,
    ok: allPass,
    exitCode: allPass ? 0 : 1,
    logPath,
    logName: name,
    spawned: false,
  };
}

// ─── public entry point ────────────────────────────────────────────────────

/**
 * Run one VC2 model-prep action (fetch-model or bench) in-process.
 * Never throws — every failure surfaces as { ok: false, ... } with a log.
 */
export async function runVc2Action(
  action: Extract<SetupCortexActionKind, "fetch-model" | "bench">,
  stateDir: string,
): Promise<SetupCortexActionResult> {
  try {
    if (action === "fetch-model") return await runFetchModel(stateDir);
    return await runBench(stateDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { name, logPath } = writeLogName(action, stateDir);
    writeLog(logPath, `${action} failed: ${msg}\n`);
    return { action, ok: false, exitCode: 1, logPath, logName: name, spawned: false };
  }
}
