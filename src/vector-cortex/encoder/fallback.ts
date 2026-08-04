/**
 * vector-cortex/encoder/fallback.ts — VC2C qualification fallback selection.
 *
 * After a qualification demotion (qualify/select fails to produce mode A), this
 * seam selects the mode-B/C fallback and routes the encode request to the
 * independently initialized VC2B producers (trigram B / lexical C). It is the
 * breaker-recovery handoff for the encoder triad:
 *
 *   A = fully qualified learned asset (QualifiedEncoderV1).
 *   B = asset-free trigram, forced by ANY one failed qualification threshold
 *       (or a qualification-manifest digest mismatch).
 *   C = token/phrase lexical, forced when A is absent AND B itself errors
 *       (injected B error), or when the caller forces C.
 *
 * Breaker recovery follows TRIAD_RESILIENCE: a demotion may probe/promote, never
 * directly re-qualify A; the fallback only ever SELECTS B or C locally, never a
 * remote fetch (PREVENT-PI-004). C states its loss of old semantic context.
 *
 * Pi-agnostic, zero network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { createEncoderHeadsReporter, type EncoderHeadsReporter } from "./emit-vc2b.js";
import { embedTrigram512, selectTrigramBFallback, ENCODER_TRIGRAM_WIDTH } from "./trigram.js";
import { embedLexical, selectLexicalC, ENCODER_LEXICAL_WIDTH, ENCODER_LEXICAL_LIMITATION } from "./lexical.js";

export type QualificationFallbackVerdict =
  | {
      readonly ok: true;
      readonly mode: "B";
      readonly vector: Float32Array;
      readonly width: number;
      /** The qualification failure code that forced B (never null on this path). */
      readonly code: string;
      readonly limitation: null;
    }
  | {
      readonly ok: true;
      readonly mode: "C";
      readonly vector: Float32Array;
      readonly width: number;
      /** The qualification or B failure code that forced C. */
      readonly code: string;
      readonly limitation: string;
    };

export interface FallbackSelectionOptions {
  readonly reporter?: EncoderHeadsReporter;
  /** Simulates a B initializer failure (forces C despite B being available). */
  readonly injectBError?: boolean;
  /** Force lexical C directly (skips the B attempt). */
  readonly forceC?: boolean;
}

/** Deterministic text derived from an int token sequence (mirrors router.ts). */
function textFromTokens(tokens: readonly number[]): string {
  return tokens.join("-");
}

/**
 * Select the B/C fallback for a failed qualification and produce the encode
 * vector. When `injectBError` or `forceC` is set, selection lands on lexical C
 * (absent A + injected B error -> C); otherwise a qualification THRESHOLD or
 * DIGEST mismatch selects trigram B. Never returns without an explicit verdict.
 */
export function selectQualificationFallback(
  qualificationCode: string,
  tokens: readonly number[],
  options: FallbackSelectionOptions = {},
): QualificationFallbackVerdict {
  const reporter = options.reporter ?? createEncoderHeadsReporter();
  const tokensText = textFromTokens(tokens);

  // A absent + injected/forced B error -> C (lexical) with the documented
  // semantic-context limitation.
  if (options.forceC || options.injectBError) {
    selectLexicalC({ reporter });
    const vector = embedLexical(tokensText);
    return {
      ok: true,
      mode: "C",
      vector,
      width: ENCODER_LEXICAL_WIDTH,
      code: options.injectBError ? "ENC_B_INJECTED_ERROR" : qualificationCode,
      limitation: ENCODER_LEXICAL_LIMITATION,
    };
  }

  // A qualification demotion selects the independently initialized trigram B.
  selectTrigramBFallback({ reporter });
  const vector = embedTrigram512(tokensText);
  return {
    ok: true,
    mode: "B",
    vector,
    width: ENCODER_TRIGRAM_WIDTH,
    code: qualificationCode,
    limitation: null,
  };
}
