/**
 * vector-cortex/encoder/native-qualify-retest.ts — ENC-2b native onnxruntime
 * qualification retest (reader-only probe).
 *
 * When an operator installs onnxruntime-node via the ENC-2a guide, the encoder
 * read path does not automatically re-evaluate the qualification verdict — the
 * encoder still reports encoderBackend "wasm" until a retest runs. This module
 * is that retest: a pure, bounded, reader-only probe that
 *
 *   (a) resolves the installed binding `<native-ort>/node_modules/onnxruntime-node/`;
 *   (b) reads its `package.json` version;
 *   (c) dynamic-imports the binding;
 *   (d) finds a LOCAL onnx model to probe against (under `~/.pi/mega-compact/`);
 *   (e) runs a bounded warmup (3 passes) + 10 timed inference passes on a fixed
 *       512-token synthetic input (the bench-onnx.mjs harness shape, in-process);
 *   (f) measures p95 (sorted index) and RSS (`process.memoryUsage().rss`);
 *   (g) computes a fresh qualification verdict against the ENC-0f p95 budget
 *       (`ENCODER_LATENCY_P95_MS`) and the operator install-budget
 *       (`installBudgetMib()` as the RSS ceiling — the ENC-2budget derivative).
 *
 * Results: `{platform, version, verdict: "qualified"|"degraded"|"failed",
 * p95Ms, rssMiB, testedAt}` or `null` when no binding is installed. It NEVER
 * throws into the route layer: every binding-load/session/model failure is
 * caught and reported as a `failed` verdict with the error message surfaced in
 * the engine, never raised. NO network (PREVENT-PI-004 — the binding + model
 * are on disk from the operator's ENC-2a install), NO training (HG-1 unchanged).
 *
 * Pi-agnostic, dependency-free. No `any` (PREVENT-011).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ENCODER_LATENCY_P95_MS, ENCODER_MAX_TOKENS } from "./types.js";
import { installBudgetMib } from "./decision.js";
import { detectPlatform } from "./asset.js";
import { NATIVE_ORT_PACKAGE, type EncoderPlatform } from "./native-install-artifacts.js";

/** Candidate ONNX runtime native-ort prefixes. The ENC-2a guide installs to
 *  the global `~/.pi/mega-compact/native-ort/`; `stateDir` (per-repo) is a
 *  secondary probe root so the retest resolves either install location. */
function nativeOrtRootCandidates(stateDir: string): string[] {
  return [
    join(process.env.HOME ?? "", ".pi", "mega-compact", "native-ort"),
    join(stateDir, "native-ort"),
  ];
}

/** A single bounded inference pass on the fixed 512-token synthetic input;
 *  returns latency ms, or null when the session cannot run (caller reports
 *  failed). The input mirrors bench-onnx.mjs: batch 1, 512 int64 ids. */
async function timedPass(
  ort: unknown,
  session: unknown,
  ids: BigInt64Array,
  mask: BigInt64Array,
  types: BigInt64Array,
): Promise<number | null> {
  try {
    const dims = [1, ENCODER_MAX_TOKENS];
    const o = ort as {
      Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
    };
    const s = session as {
      inputNames: readonly string[];
      run: (feeds: Record<string, unknown>) => Promise<unknown>;
    };
    const feeds: Record<string, unknown> = {};
    if (s.inputNames.includes("input_ids")) {
      feeds.input_ids = new o.Tensor("int64", ids, dims);
    }
    if (s.inputNames.includes("attention_mask")) {
      feeds.attention_mask = new o.Tensor("int64", mask, dims);
    }
    if (s.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new o.Tensor("int64", types, dims);
    }
    const t = process.hrtime.bigint();
    await s.run(feeds);
    return Number(process.hrtime.bigint() - t) / 1e6;
  } catch {
    return null;
  }
}

/** The retest verdict covering the ENC-0f p95 budget + the RSS ceiling. */
export type RetestVerdict = "qualified" | "degraded" | "failed";

/** The ENC-2b retest result surfaced on the GET read path + retest card. */
export interface RetestResult {
  readonly platform: string;
  readonly version: string;
  readonly verdict: RetestVerdict;
  readonly p95Ms: number;
  readonly rssMiB: number;
  readonly testedAt: string;
}

/** Resolve the first existing installed-binding package root, or the first
 *  candidate's path (for a missing-binding probe) when none exists. */
function bindingRootDir(stateDir: string): string {
  for (const root of nativeOrtRootCandidates(stateDir)) {
    const pkg = join(root, "node_modules", NATIVE_ORT_PACKAGE);
    if (existsSync(pkg)) return pkg;
  }
  return join(nativeOrtRootCandidates(stateDir)[0], "node_modules", NATIVE_ORT_PACKAGE);
}

/** Read the installed binding version from its package.json; null when absent. */
function readInstalledVersion(pkgJsonPath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as unknown;
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { version?: unknown }).version === "string"
    ) {
      return (raw as { version: string }).version;
    }
    return null;
  } catch {
    return null;
  }
}

/** Locate a LOCAL onnx model to probe against, under the native-ort roots.
 *  Null when none exists (the retest cannot qualify without a probe target). */
function findLocalModel(stateDir: string): string | null {
  const candidates = [
    join(nativeOrtRootCandidates(stateDir)[0], "model.onnx"),
    join(stateDir, "model.onnx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** p95 of sorted latencies (sorted-index percentile, bench-onnx idiom). */
function p95Of(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return +sorted[idx].toFixed(2);
}

/**
 * Run the native onnxruntime qualification retest. Returns `RetestResult` on a
 * completed (pass/fail/degrade) probe, or `null` when no binding is installed.
 * Never throws: binding-load / session / model failures produce a `failed`
 * verdict with the message on the result, and the `testedAt`/RSS are filled.
 */
export async function runNativeRetest(stateDir: string): Promise<RetestResult | null> {
  const rootDir = bindingRootDir(stateDir);
  const pkgJsonPath = join(rootDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  const version = readInstalledVersion(pkgJsonPath);
  const platform: EncoderPlatform | null = detectPlatform();
  const platformStr = platform ?? `${process.platform}-${process.arch}`;
  const testedAt = new Date().toISOString();
  const rssMiB = +((process.memoryUsage().rss / 1048576).toFixed(1));

  // Binding present but version unreadable — report failed (never throw).
  if (version === null) {
    return {
      platform: platformStr,
      version: "unknown",
      verdict: "failed",
      p95Ms: 0,
      rssMiB,
      testedAt,
    };
  }

  // Load the LOCAL binding via dynamic import. Load failure -> failed verdict.
  let ort: unknown;
  try {
    ort = await import(join(rootDir, "lib", "index.js"));
  } catch {
    try {
      ort = await import(join(rootDir, "dist", "ort.node.mjs"));
    } catch {
      return {
        platform: platformStr,
        version,
        verdict: "failed",
        p95Ms: 0,
        rssMiB,
        testedAt,
      };
    }
  }

  // Find a local probe model; without one the binding cannot be qualified.
  const modelPath = findLocalModel(stateDir);
  if (modelPath === null) {
    return {
      platform: platformStr,
      version,
      verdict: "failed",
      p95Ms: 0,
      rssMiB,
      testedAt,
    };
  }

  // Create the session (bounded); failure -> failed.
  try {
    const factory = ort as {
      InferenceSession: {
        create: (
          path: string,
          opts: { executionProviders: string[]; intraOpNumThreads: number; graphOptimizationLevel: string },
        ) => Promise<unknown>;
      };
    };
    const session = await factory.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: 4,
      graphOptimizationLevel: "all",
    });
    const n = ENCODER_MAX_TOKENS;
    const ids = BigInt64Array.from({ length: n }, (_, i) =>
      BigInt(i === 0 ? 101 : i === n - 1 ? 102 : 2000 + (i % 500)),
    );
    const mask = BigInt64Array.from({ length: n }, () => 1n);
    const types = new BigInt64Array(n);

    // Bounded warmup (3 passes) + 10 timed passes.
    for (let i = 0; i < 3; i++) await timedPass(ort, session, ids, mask, types);
    const lat: number[] = [];
    for (let i = 0; i < 10; i++) {
      const ms = await timedPass(ort, session, ids, mask, types);
      if (ms === null) break;
      lat.push(ms);
    }
    if (lat.length === 0) {
      return {
        platform: platformStr,
        version,
        verdict: "failed",
        p95Ms: 0,
        rssMiB,
        testedAt,
      };
    }
    lat.sort((a, b) => a - b);
    const p95Ms = p95Of(lat);
    const rssBudgetMib = installBudgetMib();
    const verdict: RetestVerdict =
      p95Ms <= ENCODER_LATENCY_P95_MS && rssMiB <= rssBudgetMib
        ? "qualified"
        : "degraded";
    return { platform: platformStr, version, verdict, p95Ms, rssMiB, testedAt };
  } catch {
    return {
      platform: platformStr,
      version,
      verdict: "failed",
      p95Ms: 0,
      rssMiB,
      testedAt,
    };
  }
}
