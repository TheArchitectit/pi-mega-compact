/**
 * vector-cortex/migrations/effective-cut-v2.ts — M3 copy/validate/switch
 * migration (VC0B).
 *
 * Freezes the v2 effective replay cut: `min(boundarySafeSeq, committedSeq,
 * capturedHighWater)` with pair retreat and anchor floor. The migration copies
 * the candidate into the staged slot, validates the STAGED pointer against the
 * minima and pair/anchor invariants (plus copy-match), and ONLY THEN atomically
 * switches the active pointer. The three phases are exposed separately so a
 * crash between validate and switch retains the OLD pointer and a restart
 * resumes idempotently (the unique failure-injection contract).
 *
 * This is an internal developer seam: no dashboard/API change is necessary. It
 * operates against the EXISTING host state via an injected M3Host interface —
 * the future v2 compat-journal is owned by VC1B and is not introduced here.
 */

import { computeEffectiveCutV2 } from "../replay/cut.js";
import type { ReplayToolPair, ReplayRetreatCode } from "../replay/types.js";

/** Migration failure codes (registered in M3-001..010 as conformance rows). */
export const M3_FAIL = {
  MISSING_HOST: "M3_HOST_MISSING",
  INVALID_MINIMA: "M3_MINIMA_VIOLATED",
  PAIR_SPLIT: "M3_PAIR_SPLIT",
  ANCHOR_CROSSED: "M3_ANCHOR_CROSSED",
  COPY_MISMATCH: "M3_COPY_MISMATCH",
} as const;
export type M3FailureCode = (typeof M3_FAIL)[keyof typeof M3_FAIL];

/** Live seq inputs that parameterize the effective cut. */
export interface M3CutInput {
  readonly requestedSeq: bigint;
  readonly boundarySafeSeq: bigint;
  readonly committedSeq: bigint;
  readonly capturedHighWater: bigint;
  readonly anchorFloor: bigint;
  readonly pairs: readonly ReplayToolPair[];
}

/**
 * Host state the migration reads/writes. copy/validate are read-only over host;
 * switch is the only mutating step (atomically activates the staged pointer).
 */
export interface M3Host {
  /** Actively used cut pointer (legacy prior). Never changes before switch. */
  readonly oldPointer: bigint | null;
  /** Persist the staged (new) cut pointer WITHOUT activating it. */
  writeStaged(pointer: bigint): void;
  /** The currently staged (new) pointer, persisted across restarts. */
  stagedPointer(): bigint | null;
  /** Contiguous durable authority high-water (min source). */
  committedSeq(): bigint;
  /** Atomic switch: activate the staged pointer and freeze the prior one. */
  switchPointer(pointer: bigint): void;
}

export interface M3ValidateResult {
  readonly ok: boolean;
  readonly codes: readonly M3FailureCode[];
  readonly retreats: readonly { code: ReplayRetreatCode; fromSeq: bigint; toSeq: bigint }[];
  readonly effectiveSeq: bigint;
}

/** Pure effective-cut computation (min-of-three + retreat + floor). */
export function m3Compute(input: M3CutInput): bigint {
  return computeEffectiveCutV2(input).cut.effectiveSeq;
}

/**
 * Phase 1 — copy: compute the candidate effective cut and stage it via the host
 * (without activating). Returns the staged seq.
 */
export function m3Copy(host: M3Host, input: M3CutInput): bigint {
  const effective = m3Compute(input);
  host.writeStaged(effective);
  return effective;
}

/**
 * Phase 2 — validate: the host's STAGED pointer must equal the freshly computed
 * effective cut (copy-match), respect the minima, not split a pair, and never
 * fall below the anchor floor. Failure codes:
 *   M3_HOST_MISSING     — no staged pointer at all
 *   M3_COPY_MISMATCH    — staged != freshly computed effective
 *   M3_MINIMA_VIOLATED  — effective exceeds a source minimum (or requested)
 *   M3_PAIR_SPLIT       — effective splits a tool call/result pair
 *   M3_ANCHOR_CROSSED   — effective is below the anchor floor
 */
export function m3Validate(host: M3Host, input: M3CutInput): M3ValidateResult {
  const codes: M3FailureCode[] = [];
  const { cut, retreats } = computeEffectiveCutV2(input);
  const expected = cut.effectiveSeq;

  const staged = host.stagedPointer();
  if (staged === null) {
    codes.push(M3_FAIL.MISSING_HOST);
  } else {
    if (staged !== expected) codes.push(M3_FAIL.COPY_MISMATCH);
    if (
      staged > input.boundarySafeSeq ||
      staged > host.committedSeq() ||
      staged > input.capturedHighWater ||
      staged > input.requestedSeq
    ) {
      codes.push(M3_FAIL.INVALID_MINIMA);
    }
    for (const p of input.pairs) {
      if (p.callSeq <= staged && staged < p.resultSeq) {
        codes.push(M3_FAIL.PAIR_SPLIT);
        break;
      }
    }
    if (staged < input.anchorFloor) codes.push(M3_FAIL.ANCHOR_CROSSED);
  }

  return {
    ok: codes.length === 0,
    codes,
    retreats,
    effectiveSeq: expected,
  };
}

/**
 * Phase 3 — switch: atomic activation of the staged pointer. Only call after
 * m3Validate reports ok; the host performs the durable pointer flip.
 */
export function m3Switch(host: M3Host, input: M3CutInput): bigint {
  const effective = m3Compute(input);
  host.switchPointer(effective);
  return effective;
}

/**
 * Run the full copy-validate-switch migration against a host. On validation
 * failure the switch is NOT performed and the host retains its previous pointer
 * (crash-safety / copy-validate-switch).
 */
export function migrateEffectiveCutV2(
  host: M3Host,
  input: M3CutInput,
): { ok: boolean; codes: readonly M3FailureCode[]; effectiveSeq: bigint } {
  m3Copy(host, input);
  const v = m3Validate(host, input);
  if (!v.ok) return { ok: false, codes: v.codes, effectiveSeq: v.effectiveSeq };
  m3Switch(host, input);
  return { ok: true, codes: [], effectiveSeq: v.effectiveSeq };
}
