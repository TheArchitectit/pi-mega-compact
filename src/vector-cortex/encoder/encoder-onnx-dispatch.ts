/**
 * encoder-onnx-dispatch.ts — ENC-0b ONNX dispatch: session lifecycle glue.
 *
 * Extracted from runtime.ts so runtime.ts stays under the 300-line soft limit.
 * Encapsulates the ENC-0b real ONNX session build during load().
 *
 * IMPORTANT (interface constraint): EncoderRuntime.load() and infer() are
 * SYNCHRONOUS — the router (router.ts:121-132) and all acceptance tests call
 * them synchronously. ONNX session creation is ASYNC (WASM init). ENC-0b
 * therefore expose the ONNX session as a SEPARATE async verification: load()
 * fires-and-forgets the session build, verifySession() awaits it for tests,
 * and infer() continues serving the LCG placeholder until the router is wired
 * for async inference (ENC-0c scope). This preserves the sync contract while
 * proving the real ONNX pipeline work end-to-end.
 *
 * ENC-0b gate: when MEGACOMPACT_ENC_0B is OFF, none of this code runs —
 * the LCG stub serves mode A byte-identical to the predecessor.
 *
 * Pi-agnostic (PREVENT-PI-004 / PREVENT-011).
 */

import { ENC_0B_ENABLED } from "../../config/vector-cortex.js";
import { buildOnnxSession, type OnnxInferenceSession } from "./onnx.js";
import type { EncoderReporter } from "./emit.js";
import type { ModelManifestV1 } from "./types.js";

/** State held by the runtime for the ENC-0b ONNX dispatch. */
export interface OnnxDispatchState {
  /** The built ONNX session (null when not built, flag off, or build failed). */
  readonly session: OnnxInferenceSession | null;
  /** Resolved when the session build attempt settles (ok or fail). */
  readonly ready: Promise<void>;
}

/** No-op state when ENC-0b is off or session build not attempted. */
export const NO_ONNX: OnnxDispatchState = { session: null, ready: Promise.resolve() };

/**
 * Attempt a real ONNX session build during load(). Fire-and-forget: returns
 * immediately with a state whose `ready` Promise resolves once the async
 * build settles. On failure the state's `session` stays null.
 */
export function tryBuildOnnx(
  assetDir: string,
  manifest: ModelManifestV1,
  reporter: EncoderReporter,
  allocatedBytes: number,
): OnnxDispatchState {
  if (!ENC_0B_ENABLED()) return NO_ONNX;
  let session: OnnxInferenceSession | null = null;
  const ready = buildOnnxSession(assetDir, manifest, reporter, allocatedBytes)
    .then((result) => { if (result.ok) session = result.session; })
    .catch(() => {});
  // Return a state whose `session` getter reads the mutable binding after
  // ready resolves (the getter runs at test assertion time, not at load()).
  return { get session() { return session; }, ready };
}

/**
 * Await the ONNX session build and verify it with a real inference.
 * Returns the embedding on success, null on any failure.
 * Called by tests and the ENC-0b acceptance aggregator, not by production
 * infer().
 */
export async function verifyOnnxSession(
  state: OnnxDispatchState,
  tokens: readonly number[],
): Promise<Float32Array | null> {
  await state.ready;
  if (!state.session) return null;
  try {
    return await state.session.infer(tokens);
  } catch {
    return null;
  }
}
