/**
 * vector-cortex/encoder/bench-export.ts — ML5-B bench result contract.
 *
 * BenchResultV1 is the typed surface `bench.ts` parses from the qualification
 * harness (`scripts/ml5/bench-onnx-prod.mjs`) and the dashboard / evidence
 * tooling consume. It carries AGGREGATE measurements + a digest only — never
 * chunk/message content (EVAL-REDACT-002).
 *
 * Contract-first (ENGINEERING_PRACTICES §3): this types file is the reviewed
 * gate; implementations import from it. Pi-agnostic, dependency-free
 * (PREVENT-PI-004 / PREVENT-011).
 */

/** The four ML5-B bench gates, each independently measured. */
export interface BenchGatesV1 {
  /** p95 latency at 512 tokens on `threads` threads <= 40 ms. */
  readonly latency: boolean;
  /** steady-state marginal RSS over the process baseline <= 150 MiB. */
  readonly rss: boolean;
  /** the loaded model's declared opset_import equals ENCODER_OPSET (21, ENC-0a re-baseline). */
  readonly opset: boolean;
  /** SHA-256 of the embedding output identical across 3 runs (maxAbsDelta=0). */
  readonly determinism: boolean;
  /** conjunctive: every gate passed. */
  readonly all: boolean;
}

/**
 * BenchResultV1 — one qualification run of the ONNX encoder bench.
 *
 * Shape is fixed by the ML5-B spec (task 4). `p95Ms`/`rssMib`/`rssMarginalMib`/
 * `digest` are null when the runtime package is absent (degraded run) or a
 * gate could not be measured; `gates.all` is false in that case and `error`
 * (optional) records the honest degradation reason.
 */
export interface BenchResultV1 {
  readonly timestamp: number;
  /** `${process.platform}-${process.arch}` (e.g. linux-x64, darwin-arm64). */
  readonly platform: string;
  /** true = onnxruntime-node (native); false = onnxruntime-web (WASM). */
  readonly encoderNative: boolean;
  /** intraOpNumThreads used for the latency gate (normative 4). */
  readonly threads: number;
  /** token count per inference (normative 512). */
  readonly tokens: number;
  /** total tokens in the corpus the bench streamed over. */
  readonly corpusTokens: number;
  /** p95 latency in ms (null on degraded/absent runtime). */
  readonly p95Ms: number | null;
  /** steady-state RSS (MiB) over the process baseline, post-GC. */
  readonly rssMib: number | null;
  /** RSS (MiB) sampled at process start before loading the encoder. */
  readonly rssBaselineMib: number | null;
  /** rssMib - rssBaselineMib: the encoder's marginal footprint. */
  readonly rssMarginalMib: number | null;
  /** declared opset_import (21, ENC-0a re-baseline); null when no asset manifest is readable. */
  readonly opset: number | null;
  /** true when the output SHA-256 is identical across 3 runs. */
  readonly deterministic: boolean;
  /** SHA-256 of the embedding output buffer (null on degraded/absent). */
  readonly digest: string | null;
  readonly gates: BenchGatesV1;
  /** Optional: honest degradation / failure reason (no runtime package, etc.). */
  readonly error?: string;
}
