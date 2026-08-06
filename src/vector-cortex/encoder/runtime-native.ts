/**
 * vector-cortex/encoder/runtime-native.ts — ML5-C native backend (Option N).
 *
 * Loads an `InferenceSession` from the `onnxruntime-node` native binding for
 * the committed encoder-v1 ONNX asset. This is the CHOSEN selection when
 * `MEGACOMPACT_ENCODER_NATIVE=1` (the native opt-in marker) is set AND the
 * package is present — it uses the platform-specific prebuilt binary (no
 * postinstall compilation needed; per vc2-model-prep §1 the allowScripts
 * removal is safe because only CUDA/TensorRT downloads use it, and pi blocks
 * all scripts anyway).
 *
 * The package is NOT declared in package.json dependencies — it is a lazily-
 * resolved peer that the runtime loads ONLY when the native opt-in is set AND
 * selected. Loading uses dynamic `import()` so the module graph compiles
 * cleanly on hosts without the package (absent installs return null, never
 * throw), so the ML5-C dispatch demotes to mode B trigram rather than
 * breaking.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 — the native binary + model are
 * committed local files). No `any` (PREVENT-011).
 */

import {
  ENCODER_OPSET,
  ENCODER_SEMANTIC_WIDTH,
  ENCODER_MAX_TOKENS,
} from "./types.js";

/** The shape of the optionalImport result when onnxruntime-node is present.
 *  Shadow-types instead of `import("onnxruntime-node")` so the module graph
 *  builds without the package being declared in package.json (ML5-B precedent). */
export interface OrtNativeModule {
  InferenceSession: {
    create(
      path: string,
      opts: { executionProviders: string[]; intraOpNumThreads: number },
    ): Promise<{
      run(
        feeds: Record<string, Float32Array>,
        outputNames: string[],
      ): Promise<Record<string, { data: Float32Array }>>;
    }>;
  };
}

/** The backend's inference session — a thin wrapper over the real native session. */
export interface NativeSession {
  /** The declared ONNX opset in the loaded manifest (normative 21). */
  readonly opset: number;
  /** The semantic embedding width (normative 384). */
  readonly semanticWidth: number;
  /** The per-asset token capacity cap (normative <= 512). */
  readonly maxTokens: number;
  /** Run one inference over already shape-checked input tokens. */
  infer(inputIds: Float32Array): Promise<Float32Array>;
}

/** True when `MEGACOMPACT_ENCODER_NATIVE=1` (the native opt-in operator flag). */
export function nativeOptIn(): boolean {
  return process.env.MEGACOMPACT_ENCODER_NATIVE === "1";
}

/** True if `onnxruntime-node` resolves on this host (loading is best-effort).
 *  Absent installs return null (never throw) so the ML5-C dispatch can demote
 *  to mode B trigram cleanly. */
async function loadOrtNative(): Promise<OrtNativeModule | null> {
  try {
    // @ts-expect-error — optional peer; the shadow type above covers the surface
    const mod = (await import("onnxruntime-node")) as OrtNativeModule;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Create a native-backed `NativeSession` over the committed ONNX asset, gated
 * first on `nativeOptIn()`. Returns null (never throws) on any failure
 * (opt-in off, absent package, unreadable asset, bad session creation) so the
 * caller demotes to mode B trigram.
 */
export async function createNativeSession(
  modelPath: string,
  options: { threads?: number; maxTokens?: number } = {},
): Promise<NativeSession | null> {
  if (!nativeOptIn()) return null;

  const ort = await loadOrtNative();
  if (!ort || !ort.InferenceSession?.create) return null;

  const threads = options.threads ?? 4;
  const maxTokens = options.maxTokens ?? ENCODER_MAX_TOKENS;

  try {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
    });

    return {
      opset: ENCODER_OPSET,
      semanticWidth: ENCODER_SEMANTIC_WIDTH,
      maxTokens,
      async infer(inputIds: Float32Array): Promise<Float32Array> {
        const feeds = { input_ids: inputIds };
        const results = await session.run(feeds, ["embedding"]);
        const out = results["embedding"];
        if (!out || !(out.data instanceof Float32Array)) {
          return new Float32Array(ENCODER_SEMANTIC_WIDTH);
        }
        return out.data;
      },
    };
  } catch {
    return null;
  }
}
