/**
 * vector-cortex/encoder/bench.ts — ML5-B bench runner (consumer-facing shell).
 *
 * Calls `scripts/ml5/bench-onnx-prod.mjs` via child_process, parses the
 * BenchResultV1 it emits, and writes the four `vector_cortex_encoder_bench_*`
 * events to the monitoring events.log (the dashboard / ML5-D surface consume
 * them later). This is NOT a runtime path — it is developer/evidence tooling.
 *
 * Events written (all best-effort / non-fatal):
 *   - vector_cortex_encoder_bench_p95_ms
 *   - vector_cortex_encoder_bench_rss_mib
 *   - vector_cortex_encoder_bench_opset_ok
 *   - vector_cortex_encoder_bench_deterministic
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 — the child bench is pure local
 * computation). No `any` (PREVENT-011).
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../../store.js";
import { defaultEventsPath, logBenchEvent } from "../../monitoring.js";
import type { BenchResultV1 } from "./bench-export.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const BENCH_SCRIPT = join(REPO_ROOT, "scripts", "ml5", "bench-onnx-prod.mjs");

/** Default events.log beside the state dir (mirrors defaultEventsPath). */
function benchEventsPath(stateDir: string): string {
  return defaultEventsPath(stateDir);
}

/**
 * Run the ONNX bench once and record its four events. Returns the parsed
 * BenchResultV1. On any failure (script missing, non-zero exit, unparsable
 * output) it returns a degraded result with gates.all:false — never throws, so
 * the caller's agent loop is never broken (non-fatal store/write contract).
 */
export function runBench(stateDir: string = getStateDir()): BenchResultV1 {
  const noop = (error: string): BenchResultV1 => ({
    timestamp: Date.now(),
    platform: `${process.platform}-${process.arch}`,
    encoderNative: false,
    threads: 4,
    tokens: 512,
    corpusTokens: 0,
    p95Ms: null,
    rssMib: null,
    rssBaselineMib: null,
    rssMarginalMib: null,
    opset: null,
    deterministic: false,
    digest: null,
    gates: { latency: false, rss: false, opset: false, determinism: false, all: false },
    error,
  });

  const fallback = (error: string): BenchResultV1 => {
    const r = noop(error);
    emitEvents(stateDir, r);
    return r;
  };

  try {
    const res = spawnSync(process.execPath, ["--expose-gc", BENCH_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 600_000,
    });
    const stdout = (res.stdout ?? "").trim();
    if (res.status === null) {
      return fallback("bench timed out or failed to spawn");
    }
    const parsed: unknown = JSON.parse(stdout || "");
    if (!isBenchResultV1(parsed)) {
      return fallback("bench output was not a BenchResultV1");
    }
    emitEvents(stateDir, parsed);
    return parsed;
  } catch (e) {
    return fallback(`bench failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

function isBenchResultV1(v: unknown): v is BenchResultV1 {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.timestamp === "number" &&
    typeof o.platform === "string" &&
    typeof o.encoderNative === "boolean" &&
    typeof o.threads === "number" &&
    typeof o.tokens === "number" &&
    typeof o.corpusTokens === "number" &&
    typeof o.gates === "object" && o.gates !== null &&
    typeof (o.gates as Record<string, unknown>).all === "boolean"
  );
}

function emitEvents(stateDir: string, r: BenchResultV1): void {
  const path = benchEventsPath(stateDir);
  const run = { platform: r.platform, encoderNative: r.encoderNative, threads: r.threads, tokens: r.tokens, digest: r.digest, corpusTokens: r.corpusTokens };
  logBenchEvent(path, "vector_cortex_encoder_bench_p95_ms", { ...run, p95Ms: r.p95Ms, pass: r.gates.latency });
  logBenchEvent(path, "vector_cortex_encoder_bench_rss_mib", { ...run, rssMib: r.rssMib, rssBaselineMib: r.rssBaselineMib, rssMarginalMib: r.rssMarginalMib, pass: r.gates.rss });
  logBenchEvent(path, "vector_cortex_encoder_bench_opset_ok", { ...run, opset: r.opset, pass: r.gates.opset });
  logBenchEvent(path, "vector_cortex_encoder_bench_deterministic", { ...run, deterministic: r.deterministic, pass: r.gates.determinism });
}
