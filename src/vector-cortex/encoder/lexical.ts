/**
 * vector-cortex/encoder/lexical.ts — VC2B mode C: token/phrase lexical encoder.
 *
 * Lexical C is a token/phrase lexical feature generator used when both mode A
 * (learned asset) and mode B (trigram) are unavailable or fail. It is continuity,
 * NOT semantic completeness: C operates on exact current tokens/phrases only and
 * MUST state that it has lost old semantic context (task 4 + TRIAD_RESILIENCE.
 * "C is continuity, not semantic completeness: it may omit old context and must
 * report that limitation").
 *
 * C never imports the learned asset or learned calibration (task 4): it is a
 * pure token/phrase lexical projection (token counts + phrase hashes) computed
 * from the exact input. It is independently implemented from B (which hashes
 * byte-level trigrams) — C works at the token/phrase level, B at the byte-ngram
 * level, so the two share no algorithm.
 *
 * Authority outage freezes derived high-water: C never advances any derived
 * frontier; it is purely a local reconstruction from the exact present tokens.
 *
 * Pi-agnostic, zero network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { createHash } from "node:crypto";
import { l2Normalize } from "./heads.js";
import {
  createEncoderHeadsReporter,
  type EncoderHeadsReporter,
} from "./emit-vc2b.js";

/** Fixed output width of lexical C. */
export const ENCODER_LEXICAL_WIDTH = 256;

/** The documented limitation lexical C reports (continuity, not semantics). */
export const ENCODER_LEXICAL_LIMITATION =
  "lexical C: token/phrase-level continuity only; old semantic context is omitted";

export function tokenizeLexical(text: string): string[] {
  // Split into lowercase token/phrase units on non-alphanumeric boundaries.
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
}

/**
 * Normalize a single token/phrase unit the same way `tokenizeLexical` does for
 * the string form: lowercase and strip leading/trailing non-alphanumeric runs.
 * Applied to array-form tokens so both accepted input forms of `embedLexical`
 * hash identical conceptual content to identical buckets, regardless of how the
 * caller chose to pass it (code-review Q03).
 */
function normalizeToken(tok: string): string {
  return tok.toLowerCase().split(/[^a-z0-9_]+/).join("");
}

/**
 * Resolve either accepted input form to a normalized token sequence: the string
 * form routes through `tokenizeLexical` (split on non-alphanumeric boundaries,
 * fragmented tokens discarded); the array form applies the same per-token
 * lowercase/strip normalization and drops tokens that normalize to empty. Both
 * paths therefore agree on hash buckets for the same conceptual content.
 */
function resolveTokens(tokensOrText: readonly string[] | string): string[] {
  if (typeof tokensOrText === "string") return tokenizeLexical(tokensOrText);
  const out: string[] = [];
  for (const raw of tokensOrText) {
    const norm = normalizeToken(raw);
    if (norm.length > 0) out.push(norm);
  }
  return out;
}

/**
 * Encode a token/phrase sequence into a 256-dim L2-normalized lexical vector
 * (all-zero on empty input). Features: exact token count + token id-hash sums +
 * phrase-adjacency hashes. Deterministic (repeat drift == 0). Pure local compute.
 */
export function embedLexical(tokensOrText: readonly string[] | string): Float32Array {
  const width = ENCODER_LEXICAL_WIDTH;
  const out = new Float32Array(width);
  const tokens = resolveTokens(tokensOrText);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const h = createHash("sha256").update(`t:${tok}`).digest();
    const bucket = h.readUInt32BE(0) % width;
    const weight = (h.readUInt32BE(4) / 4294967295) * 2 - 1;
    out[bucket] += weight;
    // Phrase adjacency: bigram hash blended in so semantic-free ordering matters.
    if (i > 0) {
      const pair = createHash("sha256").update(`p:${tokens[i - 1]}:${tok}`).digest();
      const pb = pair.readUInt32BE(0) % width;
      const pw = (pair.readUInt32BE(4) / 4294967295) * 2 - 1;
      out[pb] += pw;
    }
  }
  return l2Normalize(out);
}

/** The documented limitation string, surfaced when lexical C is selected. */
export function selectLexicalC(
  options: { readonly reporter?: EncoderHeadsReporter } = {},
): {
  ok: true;
  mode: "C";
  dim: number;
  width: number;
  limitation: string;
} {
  const reporter = options.reporter ?? createEncoderHeadsReporter();
  const selection = {
    ok: true as const,
    mode: "C" as const,
    dim: ENCODER_LEXICAL_WIDTH,
    width: ENCODER_LEXICAL_WIDTH,
    limitation: ENCODER_LEXICAL_LIMITATION,
  };
  reporter.fallbackSelected({
    mode: selection.mode,
    dim: selection.dim,
    width: selection.width,
    limitation: selection.limitation,
  });
  return selection;
}

export { l2Normalize };
