/**
 * vector-cortex/encoder/onnx.ts — ENC-0b real ONNX InferenceSession builder.
 *
 * Creates a WASM-backed ONNX InferenceSession over the committed encoder-v1
 * asset (bge-small-en-v1.5, opset 21, 384-dim sentence_embedding). Dynamically
 * imports onnxruntime-web/wasm (the CPU-only variant) so the module graph
 * compiles on hosts without the package. All failures return typed result
 * codes — this function NEVER throws (PREVENT-011: no `any`).
 *
 * Lifecycle:
 *   1. Check ENCODER_RSS_BUDGET_BYTES before allocation (cap-before-allocation).
 *   2. Assert manifest.opset === ENCODER_OPSET (21).
 *   3. Dynamically import("onnxruntime-web/wasm").
 *   4. Create InferenceSession with wasm EP, 4 threads.
 *   5. Expose infer(tokens) that feeds int64 input_ids + attention_mask + token_type_ids.
 *   6. Return sentence_embedding, L2-normalized to unit norm.
 *
 * Pi-agnostic (PREVENT-PI-004: local file only, zero network).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  ENCODER_OPSET,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_SEMANTIC_WIDTH,
  type ModelManifestV1,
} from "./types.js";
import type { EncoderReporter } from "./emit.js";

/** ENC-0b failure codes (new ENC_FAIL namespace entries declared here). */
export const ENC_ONNX_FAIL = {
  OPSET_MISMATCH: "ENC_ONNX_OPSET_MISMATCH",
  RSS_BREACH: "ENC_ONNX_RSS_BREACH",
  MODULE_ABSENT: "ENC_ONNX_MODULE_ABSENT",
  SESSION_ERROR: "ENC_ONNX_SESSION_ERROR",
  MODEL_ABSENT: "ENC_ONNX_MODEL_ABSENT",
} as const;

/** Typed failure code union. */
export type OnnxFailCode = (typeof ENC_ONNX_FAIL)[keyof typeof ENC_ONNX_FAIL];

/** Result of building an ONNX session — never throws. */
export type OnnxSessionResult =
  | { ok: true; session: OnnxInferenceSession }
  | { ok: false; code: OnnxFailCode };

/** The runnable ONNX inference surface (thin wrapper over the real session). */
export interface OnnxInferenceSession {
  readonly opset: number;
  readonly semanticWidth: number;
  /** Run inference over token IDs, returning L2-normalized sentence_embedding. */
  infer(tokens: readonly number[]): Promise<Float32Array>;
  /** Release the underlying session resources. */
  release(): Promise<void>;
}

/** Shadow type for onnxruntime-web/wasm InferenceSession (avoids hard dep). */
interface OrtSession {
  run(
    feeds: Record<string, { data: BigInt64Array | Float32Array; dims: readonly number[]; type: string }>,
    fetches: readonly string[],
  ): Promise<Record<string, { data: Float32Array | BigInt64Array; dims: readonly number[] }>>;
  release(): Promise<void>;
}
interface OrtWasmModule {
  InferenceSession: {
    create(
      path: string,
      opts: { executionProviders: readonly string[]; intraOpNumThreads: number },
    ): Promise<OrtSession>;
  };
}

/** Resolve the onnxruntime-web package root from import.meta.url. */
function resolveOrtWasmPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up to find node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm
    let dir = here;
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm");
      if (existsSync(candidate)) return candidate;
      const next = dirname(dir);
      if (next === dir) break;
      dir = next;
    }
    return null;
  } catch {
    return null;
  }
}

/** L2-normalize a Float32Array in-place; returns the same array. */
function l2Normalize(arr: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]! * arr[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 1e-12) {
    for (let i = 0; i < arr.length; i++) arr[i] = arr[i]! / norm;
  }
  return arr;
}

/**
 * Build a real ONNX InferenceSession over the committed encoder-v1 asset.
 * Returns a typed result — NEVER throws. On any failure the caller demotes
 * to mode B trigram with the returned code.
 *
 * @param assetDir  Path to the directory containing model.onnx + manifest.
 * @param manifest  The verified ModelManifestV1 from the asset.
 * @param reporter  Encoder reporter for the onnx_loaded event (optional).
 * @param allocatedBytes  Externally committed bytes (for RSS budget check).
 */
export async function buildOnnxSession(
  assetDir: string,
  manifest: ModelManifestV1,
  reporter?: EncoderReporter,
  allocatedBytes: number = 0,
): Promise<OnnxSessionResult> {
  // Q01: cap-before-allocation.
  if (allocatedBytes > ENCODER_RSS_BUDGET_BYTES) {
    return { ok: false, code: ENC_ONNX_FAIL.RSS_BREACH };
  }

  // Opset assertion.
  if (manifest.opset !== ENCODER_OPSET) {
    return { ok: false, code: ENC_ONNX_FAIL.OPSET_MISMATCH };
  }

  const modelPath = join(assetDir, manifest.onnx.path);
  if (!existsSync(modelPath)) {
    return { ok: false, code: ENC_ONNX_FAIL.MODEL_ABSENT };
  }

  // Dynamically import onnxruntime-web/wasm (never a hard dependency).
  let ort: OrtWasmModule;
  try {
    ort = (await import("onnxruntime-web/wasm")) as OrtWasmModule;
    if (!ort?.InferenceSession?.create) {
      return { ok: false, code: ENC_ONNX_FAIL.MODULE_ABSENT };
    }
  } catch {
    return { ok: false, code: ENC_ONNX_FAIL.MODULE_ABSENT };
  }

  // Resolve WASM binary path for the threading backend.
  const wasmPath = resolveOrtWasmPath();

  let rawSession: OrtSession;
  try {
    const opts: { executionProviders: readonly string[]; intraOpNumThreads: number; wasmPaths?: string } = {
      executionProviders: ["wasm"],
      intraOpNumThreads: 4,
    };
    if (wasmPath) opts.wasmPaths = wasmPath;
    rawSession = await ort.InferenceSession.create(modelPath, opts);
  } catch {
    return { ok: false, code: ENC_ONNX_FAIL.SESSION_ERROR };
  }

  reporter?.onnxSessionLoaded({
    opset: manifest.opset,
    semanticWidth: ENCODER_SEMANTIC_WIDTH,
    threads: 4,
  });

  const session: OnnxInferenceSession = {
    opset: manifest.opset,
    semanticWidth: ENCODER_SEMANTIC_WIDTH,
    async infer(tokens: readonly number[]): Promise<Float32Array> {
      const n = tokens.length;
      const inputIds = new BigInt64Array(n);
      const attentionMask = new BigInt64Array(n);
      const tokenTypeIds = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        inputIds[i] = BigInt(tokens[i]!);
        attentionMask[i] = 1n;
        tokenTypeIds[i] = 0n;
      }
      const feeds = {
        input_ids: { data: inputIds, dims: [1, n], type: "int64" },
        attention_mask: { data: attentionMask, dims: [1, n], type: "int64" },
        token_type_ids: { data: tokenTypeIds, dims: [1, n], type: "int64" },
      };
      const results = await rawSession.run(feeds, ["sentence_embedding"]);
      const out = results["sentence_embedding"];
      if (!out || !(out.data instanceof Float32Array)) {
        return new Float32Array(ENCODER_SEMANTIC_WIDTH);
      }
      return l2Normalize(out.data);
    },
    release: () => rawSession.release(),
  };

  return { ok: true, session };
}
