/**
 * vector-cortex/encoder/calibrate.ts — VC2C calibration fit (task 2).
 *
 * Fits a `CalibrationV1` using ONLY the calibration split. Held-out
 * (test/eval) labels are STRICTLY PROHIBITED from the fit inputs: the fit
 * function rejects (ENC_QUALIFICATION_HELD_OUT_IN_FIT) any example whose
 * `itemId` appears in the caller's held-out set. Ties in example score are
 * broken deterministically by item ID (stable score/id ties), never by arrival
 * order, so the fit is invariant to row order.
 *
 * The calibration split assignment is grouped by repository+session
 * (EVALUATION.md §corpus): every label-bearing item carries a `repository` +
 * `session` group, and the split digest is the canonical SHA-256 over the
 * sorted group list. A single repo/session group NEVER crosses split boundaries
 * (the caller seeds a group wholly into the calibration split or not at all).
 *
 * The fit itself is a deterministic seeded per-head temperature + threshold
 * calibration over the calibration-only examples (real isotonic/Platt weights
 * land with trained weights; the contract, split isolation, held-out
 * prohibition, stable ties, and frozen-temperature/threshold surface are all
 * normative here). Pi-agnostic, zero network (PREVENT-PI-004), no `any`
 * (PREVENT-011).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ML5A_ENABLED } from "../../config/vector-cortex.js";
import {
  ENCODER_HEAD_ORDER,
  ENCODER_SEED,
  ENC_QUALIFICATION_FAIL,
  type CalibrationV1,
  type EncoderHeadName,
} from "./types.js";

/** A scored, label-bearing calibration item. `heldOutIds` forbid review labels. */
export interface CalibrationExample {
  readonly itemId: string;
  readonly head: EncoderHeadName;
  readonly score: number;
  /** Binary ground-truth label (0/1) against which the raw score is calibrated. */
  readonly label: 0 | 1;
  /** Repository group (EVALUATION.md §corpus) — the split unit. */
  readonly repository: string;
  /** Session group (within the repository). */
  readonly session: string;
}

export interface CalibrationFitOptions {
  /** Seed of the deterministic fit (defaults to ENCODER_SEED). */
  readonly seed?: number;
}

export type CalibrationFitResult =
  | { ok: true; calibration: CalibrationV1 }
  | { ok: false; code: string; reason: string };

/** Canonical digests of a sorted stable representation (order-invariant). */
function digestStrings(values: readonly string[]): string {
  const sorted = [...values].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Compute the calibration split digest for a set of (repository, session) groups
 * present in the fit. The group list is canonicalized (sorted, deduped) so the
 * digest is invariant to row order within the input. A caller that seeds WHOLE
 * groups into the calibration split guarantees no group crosses a boundary.
 */
/**
 * Render one (repository, session) group as an injective canonical string.
 * Each field is length-prefixed (`<len>:<value>`), so two distinct pairs can
 * never collide to the same rendering — e.g. `{r:"a", s:"b::c"}` renders as
 * `1:a3:b::c` while `{r:"a::b", s:"c"}` renders as `4:a::b1:c`. A plain
 * `repository::session` join would conflate those when identifiers happen to
 * contain "::"; length-prefixing makes the split digest sound for arbitrary
 * repository/session identifiers.
 */
function renderGroup(g: { repository: string; session: string }): string {
  return `${g.repository.length}:${g.repository}${g.session.length}:${g.session}`;
}

export function calibrationSplitDigest(groups: readonly { repository: string; session: string }[]): string {
  const rendered = new Set<string>();
  for (const g of groups) rendered.add(renderGroup(g));
  return digestStrings([...rendered]);
}

/** A deterministic 32-bit LCG step (matches the heads/runtime projectors). */
function nextState(state: number): number {
  return (state * 1664525 + 1013904223) >>> 0;
}

/**
 * Deterministic per-head temperature in a stable, healthy range (e.g. 0.8..1.5).
 *
 * The caller-supplied `seed` is mixed into the LCG state through independent
 * steps so it ALWAYS affects the temperature — even when it equals ENCODER_SEED.
 * (A naive `ENCODER_SEED ^ head.length ^ seed` cancels the two seed terms when
 * `seed === ENCODER_SEED`, leaving a pure function of the head — the default
 * path would make the seed option inert. Here the seed seeds the PRNG first,
 * then the head name is folded in, so both vary the fit independently.) The fit
 * stays deterministic for a fixed (seed, head) across processes.
 */
function fitTemperature(head: EncoderHeadName, seed: number): number {
  let state = (seed >>> 0) ^ 0x9e3779b9;
  state = nextState(state);
  state = (state ^ (head.length >>> 0)) >>> 0;
  state = nextState(state);
  state = (state ^ 0x85ebca6b) >>> 0;
  state = nextState(state);
  const r = (state / 4294967296) % 1;
  return 0.8 + r * 0.7; // 0.8 .. 1.5
}

/**
 * Deterministic per-head decision threshold derived from the calibration
 * distribution. For a head with BOTH classes present the threshold is the
 * midpoint between the highest-scoring negative (label 0) and the lowest-scoring
 * positive (label 1) — a true between-class balance point that NEVER lands on a
 * negative example's own score (code-review Q03): a future inference at the
 * highest calibration negative is still classified negative, and one at the
 * lowest calibration positive is still classified positive. Degenerate heads with
 * a single class fall back conservatively (no positives -> just above the top
 * observed score; no negatives -> just below the lowest observed positive) and an
 * empty head defaults to 0.5. Scoring is order-invariant: ties in score resolve by
 * item ID bytewise (stable score/id ties), never by arrival order, so the fit is
 * invariant to row order. This frozen threshold is a normative placeholder (real
 * trained weights land later).
 */
function fitThreshold(
  head: EncoderHeadName,
  examples: readonly CalibrationExample[],
): number {
  const headEx = examples
    .filter((e) => e.head === head)
    .slice()
    .sort((a, b) => (a.score - b.score) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  if (headEx.length === 0) return 0.5;
  let highestNeg = -Infinity;
  let lowestPos = Infinity;
  for (const e of headEx) {
    if (e.label === 0) highestNeg = Math.max(highestNeg, e.score);
    else lowestPos = Math.min(lowestPos, e.score);
  }
  if (lowestPos === Infinity) {
    // Only negatives observed — no positive class to balance against. Set the
    // threshold just above the top observed score so no observed negative is
    // re-admitted (a genuine future positive must exceed all calibration negatives).
    return Math.max(0.5, highestNeg + 0.05);
  }
  if (highestNeg === -Infinity) {
    // Only positives observed — set the threshold just below the lowest observed
    // positive so every observed positive is admitted.
    return Math.max(0, lowestPos - 0.05);
  }
  // Both classes present: the midpoint strictly between the highest negative and
  // the lowest positive is the between-class balance point (Q03).
  return (highestNeg + lowestPos) / 2;
}

/**
 * Fit `CalibrationV1` over the calibration split only (task 2).
 *
 *   - rejects any item whose `itemId` is in `heldOutIds` (held-out labels are
 *     prohibited from fit inputs).
 *   - treats `groups` as the calibration split units; the emitted split digest
 *     covers only the groups ACTUALLY present in the fit examples (plus the
 *     declared `groups`, when supplied — see below).
 *   - stable score/id ties (never arrival order).
 *
 * Held-out labels are prohibited by construction: the caller passes the full set
 * of held-out item IDs, and the fit fails loudly if any calibration input is
 * actually a held-out item — the fit can never silently learn from review labels.
 */
export function fitCalibration(
  examples: readonly CalibrationExample[],
  options: CalibrationFitOptions & {
    /** Item IDs that belong to the held-out (test/eval) split. Any calibration
     *  input whose id appears here is a fit violation. */
    readonly heldOutIds?: readonly string[];
    /** Declared calibration groups (repository+session). When supplied, the split
     *  digest covers these; otherwise it covers the groups actually in `examples`.
     *  Whole groups never cross a split boundary when the caller seeds a group
     *  into exactly one split. */
    readonly groups?: readonly { repository: string; session: string }[];
  } = {},
): CalibrationFitResult {
  const seed = options.seed ?? ENCODER_SEED;
  const heldOut = new Set(options.heldOutIds ?? []);

  for (const e of examples) {
    if (heldOut.has(e.itemId)) {
      return {
        ok: false,
        code: ENC_QUALIFICATION_FAIL.HELD_OUT_IN_FIT,
        reason: `held-out item ${e.itemId} leaked into calibration fit`,
      };
    }
  }

  // Stable order by (score, itemId) — arrival order never affects the digest or
  // the fit; ties resolve by item ID bytewise (stable score/id ties).
  const stable = examples
    .slice()
    .sort((a, b) => (a.score - b.score) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const usedGroups = options.groups ?? stable.map((e) => ({ repository: e.repository, session: e.session }));
  const splitDigest = calibrationSplitDigest(usedGroups);
  const temperatures: Record<EncoderHeadName, number> = {} as Record<EncoderHeadName, number>;
  const thresholds: Record<EncoderHeadName, number> = {} as Record<EncoderHeadName, number>;
  for (const head of ENCODER_HEAD_ORDER) {
    temperatures[head] = fitTemperature(head, seed);
    thresholds[head] = fitThreshold(head, stable);
  }

  const calibration: CalibrationV1 = {
    schema: "calibration-v1",
    headOrder: [...ENCODER_HEAD_ORDER],
    calibrationSplitDigest: splitDigest,
    fittedOnCalibrationOnly: true,
    temperatures,
    thresholds,
    seed,
  };
  return { ok: true, calibration };
}

/**
 * Load a persisted `CalibrationV1` artifact (schema "calibration-v1") from disk.
 * ML5-A: gated on MEGACOMPACT_ML5_A; flag-off, absent file, malformed JSON,
 * wrong schema, non-canonical five-head order, or non-finite temp/threshold each
 * return null (non-fatal, never throws). Deterministic, local (PREVENT-PI-004).
 */
export function loadCalibrationV1(path: string): CalibrationV1 | null {
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
  if (!r || r["schema"] !== "calibration-v1") return null;
  const order = r["headOrder"];
  if (!Array.isArray(order)) return null;
  if (order.length !== ENCODER_HEAD_ORDER.length || !ENCODER_HEAD_ORDER.every((h, i) => order[i] === h)) {
    return null;
  }
  const temperatures = r["temperatures"] as Record<string, unknown> | undefined;
  const thresholds = r["thresholds"] as Record<string, unknown> | undefined;
  const splitDigest = r["calibrationSplitDigest"];
  if (!temperatures || !thresholds || typeof splitDigest !== "string" || splitDigest.length !== 64) return null;
  for (const h of ENCODER_HEAD_ORDER) {
    const t = Number(temperatures[h]);
    const th = Number(thresholds[h]);
    if (!Number.isFinite(t) || !Number.isFinite(th)) return null;
  }
  return {
    schema: "calibration-v1",
    headOrder: [...ENCODER_HEAD_ORDER],
    calibrationSplitDigest: splitDigest,
    fittedOnCalibrationOnly: true,
    temperatures: { ...(temperatures as Record<EncoderHeadName, number>) },
    thresholds: { ...(thresholds as Record<EncoderHeadName, number>) },
    seed: Number(r["seed"] ?? ENCODER_SEED),
  };
}
