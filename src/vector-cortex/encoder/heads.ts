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

import { readFileSync } from "node:fs";
import { ML5A_ENABLED } from "../../config/vector-cortex.js";
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

// ---------------------------------------------------------------------------
// ML5-A real trained-head loading. Produces the projection matrices that the
// deterministic placeholder `projectHead` approximates: row-major
// `weights[h]` of length `headDim * trunkDim`, applied `W[i*t+j]*trunk[j]`,
// L2-normalized. Loaded from the `trained-heads-v1` JSON that
// `training/vector-cortex/train.py` emits, under the MEGACOMPACT_ML5_A gate.
// Non-fatal: any violation (flag off, absent, malformed, wrong seed, wrong
// shape) yields null, never a throw (all loaders return null on violation).
// ---------------------------------------------------------------------------

/** The real loadable form of the trained five-head projection table. */
export interface HeadProjectionTable {
  readonly schema: "trained-heads-v1";
  readonly seed: number;
  /** Input/trunk embedding dimension every head projects from (uniform 384). */
  readonly trunkDim: number;
  /** Per-head OUTPUT dimension (semantic 384 / ... / payloadRouting 32). */
  readonly dims: Readonly<Record<EncoderHeadName, number>>;
  /** Row-major `[headDim * trunkDim]` projection matrix per head. */
  readonly weights: Readonly<Record<EncoderHeadName, Float32Array>>;
  readonly temperatures: Readonly<Record<EncoderHeadName, number>>;
}

/** True when every head's output dim + weight length matches the contract. */
export function headsShapeValid(t: HeadProjectionTable): boolean {
  return ENCODER_HEAD_ORDER.every(
    (h) => t.dims[h] === ENCODER_HEAD_DIMS[h] && t.weights[h].length === ENCODER_HEAD_DIMS[h] * t.trunkDim,
  );
}

/**
 * Load a `trained-heads-v1` artifact into a `HeadProjectionTable`. Gated on
 * MEGACOMPACT_ML5_A: flag-off, absent file, malformed JSON, wrong schema,
 * wrong seed, or a shape mismatch each return null (non-fatal). Deterministic
 * and local (PREVENT-PI-004).
 */
export function loadHeadProjections(path: string): HeadProjectionTable | null {
  if (!ML5A_ENABLED()) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = parsed as Record<string, unknown> | null;
  if (!r || r["schema"] !== "trained-heads-v1") return null;
  if (r["seed"] !== ENCODER_SEED) return null;
  const dims = r["dims"] as Record<string, unknown> | undefined;
  const heads = r["heads"] as Record<string, unknown> | undefined;
  if (!dims || !heads) return null;
  const trunkDim = Number(r["trunkDim"] ?? 0);
  if (!Number.isFinite(trunkDim) || trunkDim <= 0) return null;
  const weights: Record<string, Float32Array> = {};
  const temperatures: Record<string, number> = {};
  for (const h of ENCODER_HEAD_ORDER) {
    const hd = heads[h] as Record<string, unknown> | undefined;
    if (!hd || typeof hd !== "object") return null;
    const w = hd["weights"];
    if (!Array.isArray(w)) return null;
    weights[h] = Float32Array.from(w as number[]);
    if (Number(hd["dim"] ?? 0) !== ENCODER_HEAD_DIMS[h]) return null;
    temperatures[h] = Number(hd["temperature"] ?? 1);
    if (!Number.isFinite(dims[h])) return null;
  }
  const table: HeadProjectionTable = {
    schema: "trained-heads-v1",
    seed: Number(r["seed"]),
    trunkDim,
    dims: { semantic: 384, dependency: 128, contradiction: 128, cacheStability: 64, payloadRouting: 32 } as unknown as Record<EncoderHeadName, number>,
    weights: weights as unknown as Record<EncoderHeadName, Float32Array>,
    temperatures: temperatures as unknown as Record<EncoderHeadName, number>,
  };
  if (!headsShapeValid(table)) return null;
  return table;
}

/**
 * Project a trunk embedding through a trained head's real weights, applying the
 * row-major matrix then L2-normalizing (all-zero on zero norm). Returns a
 * `HeadVector` of the head's normative dimension.
 */
export function projectHeadFromTrunk(
  head: EncoderHeadName,
  trunk: Float32Array,
  table: HeadProjectionTable,
): HeadVector {
  const dim = ENCODER_HEAD_DIMS[head];
  const W = table.weights[head];
  const t = table.trunkDim;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    let acc = 0;
    for (let j = 0; j < t; j++) acc += W[i * t + j]! * (trunk[j] ?? 0);
    out[i] = acc;
  }
  return { head, dim, values: l2Normalize(out) };
}

export { ENCODER_HEAD_ORDER, ENCODER_HEAD_DIMS, ENCODER_HEAD_LOSS_SUM, ENCODER_SEED, NOOP_VC2B_REPORTER };

// ENC-0c five-head candidate seam (delegate-shell): the load/validate impl
// lives in heads-candidate.ts; these re-exports keep the public import path
// stable at heads.ts without growing this survivor file over the soft limit.
export {
  HEAD_CANDIDATE_SCHEMA,
  HEAD_CANDIDATE_FAIL,
  loadHeadCandidate,
  validateHeadCandidate,
  type HeadCandidate,
  type HeadCandidateManifest,
  type HeadCandidateHeadDigest,
  type HeadCandidateValidation,
} from "./heads-candidate.js";
