/**
 * vector-cortex/encoder/router.ts — VC2B encode-or-fallback router (S2).
 *
 * The single production seam that catches a real VC2A `load()` failure and
 * hands off to the independently initialized VC2B fallbacks:
 *
 *   - mode A: the learned multi-head projection — an EncoderRuntime that
 *     verifies+loads a local qualified ONNX (VC2A) plus `encodeVectorSet`
 *     producing VectorSetV1, emitting `vector_cortex_encoder_heads_emitted`;
 *   - when that `load()` fails for ANY reason (removed model ->
 *     ENC_ASSET_UNREADABLE, digest mismatch -> ENC_DIGEST_MISMATCH, missing
 *     manifest -> ENC_MANIFEST_INVALID, unsupported platform, RSS over budget,
 *     ...) the router catches the real failure and selects the independently
 *     initialized asset-free trigram B (`selectTrigramBFallback`) — or lexical C
 *     when the runtime reports B-unavailable / the caller forces mode C. The
 *     `vector_cortex_encoder_fallback_selected` event fires from the REAL
 *     producer seam, not test wiring (task 5 + code-review S1).
 *
 * Best-effort and non-fatal: every branch returns an explicit verdict and never
 * throws across the boundary into the agent loop. Flag-OFF parity: with
 * `MEGACOMPACT_VC2B=0` the VC2B reporter is a no-op (zero emissions), and the
 * mode-A path is governed by the VC2A runtime itself — the router only adds the
 * fallback handoff and changes no producer bytes.
 *
 * Pi-agnostic, zero network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { createEncoderRuntime } from "./runtime.js";
import { encodeVectorSet, type HeadProjectionOptions } from "./heads.js";
import { embedTrigram512, selectTrigramBFallback } from "./trigram.js";
import { embedLexical, selectLexicalC } from "./lexical.js";
import { createEncoderHeadsReporter, type EncoderHeadsReporter } from "./emit-vc2b.js";
import {
  ENC_FAIL,
  type EncoderInput,
  type EncoderLoadResult,
  type EncoderRuntime,
  type VectorSetV1,
} from "./types.js";

/** A resolved encode decision: a qualified mode-A VectorSet, an explicit B/C
 *  fallback vector, or a hard failure. */
export type RouterVerdict =
  | { readonly ok: true; readonly mode: "A"; readonly vectorSet: VectorSetV1; readonly code: null }
  | {
      readonly ok: true;
      readonly mode: "B" | "C";
      readonly vector: Float32Array;
      readonly width: number;
      /** Semantic-context limitation (mode C) or null (mode B). */
      readonly limitation: string | null;
      /** The VC2A failure code that triggered the fallback (e.g.
       *  ENC_ASSET_UNREADABLE), or null when the caller forced the mode. */
      readonly code: string | null;
    }
  | { readonly ok: false; readonly mode: "B" | "C"; readonly code: string };

export interface RouterOptions extends HeadProjectionOptions {
  /** The VC2A runtime (mode A path). Defaults to a freshly created runtime. */
  readonly runtime?: EncoderRuntime;
  /** Forced fallback: skips the A load and selects the named VC2B fallback
   *  (used to exercise C when A and B are both disabled). Optional. */
  readonly forceFallback?: "B" | "C";
}

/** Deterministic text derived from an int token sequence so the asset-free
 *  fallback producers operate on the same authority the learned path encoded. */
function textFromTokens(tokens: readonly number[]): string {
  return tokens.join("-");
}

/**
 * Try to produce an encoding for an input token sequence. Mode A: verify+load
 * the local learned asset via the EncoderRuntime; on a real `load()` failure
 * (removed model, digest mismatch, missing manifest, ...) the router catches it
 * and selects the independently initialized trigram B or lexical C, emitting
 * `vector_cortex_encoder_fallback_selected` (and `heads_emitted` when A wins).
 */
export function encodeOrFallback(
  input: EncoderInput,
  assetDir: string,
  options: RouterOptions = {},
): RouterVerdict {
  const reporter = options.reporter ?? createEncoderHeadsReporter();
  const tokens = Array.isArray(input?.tokens) ? input.tokens : [];
  const runtime = options.runtime ?? createEncoderRuntime();

  // Empty input yields the asset-free fallback (finite, deterministic).
  if (tokens.length === 0) {
    const sel = selectTrigramBFallback({ reporter });
    const vector = embedTrigram512("");
    return { ok: true, mode: "B", vector, width: sel.width, limitation: null, code: ENC_FAIL.SHAPE_INVALID };
  }

  // Mode A attempt — only when not explicitly forced to a fallback.
  if (options.forceFallback === undefined) {
    const loaded = runtime.load(assetDir);
    if (loaded.ok && loaded.mode === "A") {
      const vectorSet = encodeVectorSet(tokens, { reporter, seed: options.seed });
      return { ok: true, mode: "A", vectorSet, code: null };
    }
    return fallbackFromLoad(loaded, reporter, tokens);
  }

  // Forced fallback skips the A load entirely (rollback / triad drill path).
  const forced: EncoderLoadResult = { ok: false, mode: options.forceFallback, code: ENC_FAIL.ROLLBACK };
  return fallbackFromLoad(forced, reporter, tokens);
}

/** Catch a (real or forced) A load failure and select the B/C fallback that
 *  emits `vector_cortex_encoder_fallback_selected` from the production seam. */
function fallbackFromLoad(
  loaded: EncoderLoadResult,
  reporter: EncoderHeadsReporter,
  tokens: readonly number[],
): RouterVerdict {
  // The router hands off here only on a non-A/load failure; a qualified A is the
  // responsibility of encodeOrFallback. Narrow `loaded` to a failed load so the
  // `code` field is well-typed.
  if (loaded.ok === true) {
    return { ok: false, mode: "B", code: ENC_FAIL.SHAPE_INVALID };
  }
  if (loaded.mode === "C") {
    const sel = selectLexicalC({ reporter });
    const vector = embedLexical(textFromTokens(tokens));
    return { ok: true, mode: "C", vector, width: sel.width, limitation: sel.limitation, code: loaded.code };
  }
  const sel = selectTrigramBFallback({ reporter });
  const vector = embedTrigram512(textFromTokens(tokens));
  return { ok: true, mode: "B", vector, width: sel.width, limitation: null, code: loaded.code };
}

export { ENC_FAIL };
export type { EncoderRuntime };
