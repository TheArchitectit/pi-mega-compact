/**
 * vector-cortex/encoder/heads.ts — VC2B multi-head encoder (tasks 1–2).
 *
 * Produces a `VectorSetV1`: five independent L2-normalized projection heads in
 * STABLE order — semantic 384, dependency 128, contradiction 128, cacheStability
 * 64, payloadRouting 32 (MODEL_ASSET §decision record). Each head L2-normalizes
 * its raw projection; a zero-norm projection maps to an all-zero vector (task 2).
 *
 * The raw per-head projection is a deterministic seeded compression of the input
 * token sequence (seeded by `ENCODER_SEED` and the head's stable index), which
 * mirrors the VC2A `projectSemantic` placeholder pattern: the contract, shape
 * gating, normalization, zero-norm mapping, ordering and loss/seed constants are
 * all normative here; real trained weights are substituted in VC2C. This keeps
 * the mode-A multi-head path fully testable end-to-end today with zero network.
 *
 * The VC2B emit seam (task 5) is wired: producing a VectorSetV1 emits
 * `vector_cortex_encoder_heads_emitted`; selecting a mode B/C fallback emits
 * `vector_cortex_encoder_fallback_selected` — both gated on MEGACOMPACT_VC2B.
 *
 * Pi-agnostic, zero network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import {
  ENCODER_HEAD_DIMS,
  ENCODER_HEAD_ORDER,
  ENCODER_HEAD_LOSS_WEIGHTS,
  ENCODER_HEAD_LOSS_SUM,
  ENCODER_SEED,
  type EncoderHeadName,
  type HeadVector,
  type VectorSetV1,
} from "./types.js";
import {
  createEncoderHeadsReporter,
  NOOP_VC2B_REPORTER,
  type EncoderHeadsReporter,
} from "./emit-vc2b.js";

/** The stable head index of a head name (its position in ENCODER_HEAD_ORDER). */
const HEAD_INDEX: Readonly<Record<EncoderHeadName, number>> = {
  semantic: 0,
  dependency: 1,
  contradiction: 2,
  cacheStability: 3,
  payloadRouting: 4,
};

/** Deterministic 32-bit LCG step (matches runtime.ts projectSemantic). */
function nextState(state: number): number {
  return (state * 1664525 + 1013904223) >>> 0;
}

export interface HeadProjectionOptions {
  readonly seed?: number;
  readonly reporter?: EncoderHeadsReporter;
}

/**
 * L2-normalize a float vector in place semantics (returns a new Float32Array).
 * A zero-norm (or empty) input maps to an all-zero vector of the same length
 * (task 2: "mapping zero norm to an all-zero vector"). All finite.
 */
export function l2Normalize(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!(norm > 0)) return out; // zero norm -> all-zero
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / norm;
  return out;
}

/** L2 norm of a Float32Array (0 for empty/all-zero). */
export function l2Norm(values: Float32Array): number {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

/** A deterministic per-head projection over the token sequence, pre-normalization. */
function projectRaw(head: EncoderHeadName, tokens: readonly number[], seed: number): Float32Array {
  const dim = ENCODER_HEAD_DIMS[head];
  const out = new Float32Array(dim);
  // An EMPTY token sequence has no signal: the raw projection is the zero vector,
  // so after L2 normalization it maps to the all-zero vector (task 2: "mapping
  // zero norm to an all-zero vector"; ENC-ZERO-002). This keeps empty input
  // finite and zero-norm instead of seeding spurious unit-norm noise.
  if (tokens.length === 0) return out;
  // Mix the stable head index + ENCODER_SEED + seed into a per-head state so
  // each head is a distinct independent projection (failure-triad independence).
  let state = (((ENCODER_SEED ^ HEAD_INDEX[head]) >>> 0) ^ (seed >>> 0)) ^ 0x9e3779b9;
  for (const t of tokens) state = nextState(state ^ ((t >>> 0) * 2654435761));
  for (let i = 0; i < dim; i++) {
    state = nextState(state ^ seed);
    out[i] = (state / 4294967296) * 2 - 1;
  }
  return out;
}

/**
 * Compute one head's L2-normalized vector (all-zero on zero norm) for a token
 * sequence. Deterministic for a given seed (repeat drift == 0).
 */
export function projectHead(
  head: EncoderHeadName,
  tokens: readonly number[],
  seed: number = ENCODER_SEED,
): HeadVector {
  const raw = projectRaw(head, tokens, seed);
  return { head, dim: ENCODER_HEAD_DIMS[head], values: l2Normalize(raw) };
}

/**
 * Encode a token sequence into a `VectorSetV1`: the five heads in stable order,
 * each L2-normalized (all-zero on zero norm). Emits `heads_emitted` via the
 * reporter (non-fatal, flag-gated). Deterministic for a given seed.
 */
export function encodeVectorSet(
  tokens: readonly number[],
  options: HeadProjectionOptions = {},
): VectorSetV1 {
  const seed = options.seed ?? ENCODER_SEED;
  const reporter = options.reporter ?? createEncoderHeadsReporter();
  const heads: HeadVector[] = ENCODER_HEAD_ORDER.map((h) => projectHead(h, tokens, seed));
  reporter.headsEmitted({
    heads: heads.length,
    dims: heads.map((h) => h.dim).join("/"),
    normalized: true,
    tokens: tokens.length,
  });
  return { schema: "vector-set-v1", inputTokens: [...tokens], heads, normalized: true };
}

/**
 * The per-head loss weights (must sum to ENCODER_HEAD_LOSS_SUM exactly).
 * Exposed for training/tests to assert the normative .35/.20/.20/.15/.10 split.
 */
export function headLossWeights(): Readonly<Record<EncoderHeadName, number>> {
  return { ...ENCODER_HEAD_LOSS_WEIGHTS };
}

export { ENCODER_HEAD_ORDER, ENCODER_HEAD_DIMS, ENCODER_HEAD_LOSS_SUM, ENCODER_SEED, NOOP_VC2B_REPORTER };
