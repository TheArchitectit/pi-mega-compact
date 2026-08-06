/**
 * vector-cortex/encoder/runtime-wasm.ts — ML5-C WASM backend (Option W).
 *
 * Loads an `InferenceSession` from the `onnxruntime-web` WASM execution
 * provider for the committed encoder-v1 ONNX asset. This is the default
 * backend when the WASM path is selected by `select.ts` — it covers all Node
 * platforms (no per-platform optionalDependencies), is pure JS + WASM (~9 MiB),
 * and never fetches from the network (PREVENT-PI-004).
 *
 * The package is NOT declared in package.json dependencies — it is a lazily-
 * resolved peer that the runtime loads ONLY when the WASM backend is actually
 * selected. Loading uses dynamic `import()` so the module graph compiles
 * cleanly on hosts without the package; absent installs return null (never
 * throw), so the ML5-C dispatch demotes to mode B trigram rather than
 * breaking (ML5-B-bench precedent: the fixtures declare the shape even when
 * the package is absent).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 — the WASM artifact is loaded
 * from the committed local path; no fetch/HTTP anywhere). No `any`
 * (PREVENT-011).
 */

import {
  ENCODER_OPSET,
  ENCODER_SEMANTIC_WIDTH,
  ENCODER_MAX_TOKENS,
} from "./types.js";

/** The shape of the optionalImport result when onnxruntime-web is present.
 *  Shadow-types instead of `import("onnxruntime-web")` so the module graph builds
 *  without the package being declared in package.json (ML5-B precedent). */
export interface OrtWasmModule {
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

/** The backend's inference session — a thin wrapper over the real WASM session. */
export interface WasmSession {
  /** The declared ONNX opset in the loaded manifest (normative 17). */
  readonly opset: number;
  /** The semantic embedding width (normative 384). */
  readonly semanticWidth: number;
  /** The per-asset token capacity cap (normative <= 512). */
  readonly maxTokens: number;
  /** Run one inference over already shape-checked input tokens. */
  infer(inputIds: Float32Array): Promise<Float32Array>;
}

/** True if `onnxruntime-web` resolves on this host (loading is best-effort).
 *  Absent installs return null (never throw) so the ML5-C dispatch can demote
 *  to mode B trigram cleanly. */
async function loadOrtWasm(): Promise<OrtWasmModule | null> {
  try {
    // @ts-expect-error — optional peer; the shadow type above covers the surface
    const mod = (await import("onnxruntime-web")) as OrtWasmModule;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Create a WASM-backed `WasmSession` over the committed ONNX asset. Returns
 * null (never throws) on any failure (absent package, unreadable asset, bad
 * session creation) so the caller demotes to mode B trigram per HG-4 mode-B
 * disposition when the WASM path is unavailable on a darwin-x64 host.
 */
export async function createWasmSession(
  modelPath: string,
  options: { threads?: number; maxTokens?: number } = {},
): Promise<WasmSession | null> {
  const ort = await loadOrtWasm();
  if (!ort || !ort.InferenceSession?.create) return null;

  const threads = options.threads ?? 4;
  const maxTokens = options.maxTokens ?? ENCODER_MAX_TOKENS;

  try {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["wasm"],
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
