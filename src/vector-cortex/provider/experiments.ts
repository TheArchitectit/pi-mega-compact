/**
 * vector-cortex/provider/experiments.ts — VC7B session-level cache experiments.
 *
 * To claim a cache strategy CAUSED a saving you need a randomized comparison,
 * not a before/after. This file assigns each session to an experiment arm and
 * guarantees the two properties that make the resulting telemetry admissible as
 * causal evidence.
 *
 * 1. STABLE, JOURNAL-FREE ASSIGNMENT. The arm is a pure function of
 *    `sha256(experimentId, sessionId)` — NOT a random draw recorded in a
 *    journal. So the assignment survives anything: process restart, a lost or
 *    corrupted journal, a different host, a replay months later. This is the
 *    sprint's unique failure-injection case (lose the journal after the first
 *    event, restart, and the same arm must come back), and a hash-derived arm
 *    passes it by construction rather than by careful recovery code. A journal
 *    can still be kept as an audit trail, but nothing DEPENDS on it.
 *
 *    The corollary matters just as much: every event in one session shares one
 *    arm (CACHE-RANDOM-003). If a session could drift between arms mid-flight,
 *    its rows would appear in both arms of the comparison and the contrast would
 *    be measuring nothing.
 *
 * 2. RANDOMIZED ⇒ CAUSAL; EVERYTHING ELSE ⇒ ESTIMATE. Hashing a session id is
 *    randomization only when the id itself is unpredictable and every session is
 *    eligible. A FORCED arm (operator override), a SHADOW arm (computed but not
 *    served), and a non-randomized rollout are all labeled `estimate` and are
 *    excluded from causal intervals by `isCausallyAdmissible`. Shadow numbers are
 *    genuinely useful — they are just not evidence of an effect.
 *
 * WHY 10_000 BUCKETS. Bucket granularity bounds how finely traffic can be split;
 * 10k gives 0.01% resolution, matching VC5C's rollout bucketing so the two
 * subsystems partition traffic on the same scale rather than on quietly
 * different ones.
 *
 * PURE. No clock, no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011). `assignedAt` is an INJECTED timestamp, never `Date.now()` read
 * here, so assignment is fully reproducible in tests and replays. Runs
 * identically with `MEGACOMPACT_VC7B` on or off.
 */

import { createHash } from "node:crypto";

/**
 * Experiment arms.
 *
 *   A — control: the predecessor path, no VC7B crystal compiler.
 *   B — treatment: provider-safe compiled crystal boundaries.
 *   C — holdout: cache bypassed entirely, the uncached baseline that prices what
 *       the cache is being compared AGAINST.
 */
export type ExperimentArm = "A" | "B" | "C";

/** The registered arms, in canonical bucket order. */
export const EXPERIMENT_ARMS: readonly ExperimentArm[] = ["A", "B", "C"] as const;

/** Bucket space: 10k buckets = 0.01% resolution (matches VC5C rollout). */
export const EXPERIMENT_BUCKETS = 10_000;

/**
 * How a session came to be in its arm. Only `randomized` is causal evidence.
 *
 *   `randomized` — derived from the stable hash over every eligible session.
 *   `forced`     — an operator/test override; self-selected, never causal.
 *   `shadow`     — computed for comparison but not served; never causal.
 */
export type AssignmentSource = "randomized" | "forced" | "shadow";

/** A session's experiment assignment (VC7B contract type). */
export interface CacheExperimentV1 {
  readonly schema: "cache-experiment-v1";
  /** Names the experiment; folded into the hash so arms differ per experiment. */
  readonly experimentId: string;
  /** The session this assignment belongs to. */
  readonly sessionId: string;
  /** The assigned arm. */
  readonly arm: ExperimentArm;
  /** The session's stable bucket in `[0, EXPERIMENT_BUCKETS)`. */
  readonly bucket: number;
  /** How the arm was chosen — gates causal admissibility. */
  readonly source: AssignmentSource;
  /** INJECTED assignment timestamp (epoch ms). Never read from a clock here. */
  readonly assignedAt: number;
}

/** VC7B experiment failure codes. */
export type ExperimentFailureCode =
  /** A blank experiment id or session id — an unnamed experiment is unanalyzable. */
  | "EXP_ID_INVALID"
  /** An arm split that does not sum to the full bucket space. */
  | "EXP_SPLIT_INVALID"
  /** A forced arm that is not one of the registered arms. */
  | "EXP_ARM_UNKNOWN";

/** The verdict of an assignment. */
export type ExperimentResult =
  | { readonly ok: true; readonly assignment: CacheExperimentV1 }
  | { readonly ok: false; readonly codes: readonly ExperimentFailureCode[] };

/**
 * Traffic split across arms, in buckets. Must sum to exactly
 * `EXPERIMENT_BUCKETS`: a split that sums to less would leave sessions
 * unassigned, and one that sums to more would make the last arm unreachable —
 * both silently bias the comparison, so both are rejected.
 */
export interface ExperimentSplit {
  readonly A: number;
  readonly B: number;
  readonly C: number;
}

/** Even three-way split (the default): 3334 / 3333 / 3333 = 10000. */
export const EVEN_SPLIT: ExperimentSplit = { A: 3334, B: 3333, C: 3333 };

/**
 * Length-prefixed field framing, identical in spirit to the crystal key encoder:
 * `<byteLength>:<value>` makes the concatenation injective, so experiment
 * `"a"` + session `"b:c"` cannot collide with experiment `"a:b"` + session `"c"`.
 * Without it, two different (experiment, session) pairs could share a bucket and
 * a session could appear to switch arms when an experiment is renamed.
 */
function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * The stable bucket for a session: the low 32 bits of
 * `sha256(experimentId, sessionId)`, modulo the bucket space.
 *
 * Deterministic and storage-free — this is what makes a lost assignment journal
 * a non-event. Reading 4 bytes (rather than the whole digest) keeps the value in
 * exact integer range; SHA-256's avalanche means any 32 bits are equidistributed.
 */
export function experimentBucket(experimentId: string, sessionId: string): number {
  const h = createHash("sha256")
    .update(field(experimentId) + field(sessionId), "utf8")
    .digest();
  return h.readUInt32BE(0) % EXPERIMENT_BUCKETS;
}

/** Validate that a split covers the bucket space exactly once. */
export function validateSplit(split: ExperimentSplit): boolean {
  for (const n of [split.A, split.B, split.C]) {
    if (!Number.isSafeInteger(n) || n < 0) return false;
  }
  return split.A + split.B + split.C === EXPERIMENT_BUCKETS;
}

/**
 * Map a bucket to an arm under a split. Arms occupy contiguous bucket ranges in
 * the fixed order A, B, C, so the mapping is stable: widening arm C's share can
 * never reshuffle a session already sitting in arm A.
 */
export function armForBucket(bucket: number, split: ExperimentSplit): ExperimentArm {
  if (bucket < split.A) return "A";
  if (bucket < split.A + split.B) return "B";
  return "C";
}

/**
 * Assign a session to an experiment arm.
 *
 * The default path is `randomized`: bucket = stable hash, arm = bucket's range.
 * Passing `forced` overrides the arm and downgrades the source (and therefore
 * causal admissibility) — the bucket is still computed and reported so the
 * override remains auditable against what the session WOULD have got.
 *
 * `assignedAt` is injected by the caller. Assignment is a pure function of its
 * arguments, so the same session always yields the same arm no matter when, or
 * how many times, it is asked.
 */
export function assignExperiment(input: {
  readonly experimentId: string;
  readonly sessionId: string;
  readonly assignedAt: number;
  readonly split?: ExperimentSplit;
  readonly forced?: ExperimentArm;
  readonly shadow?: boolean;
}): ExperimentResult {
  const codes: ExperimentFailureCode[] = [];
  if (input.experimentId.trim() === "" || input.sessionId.trim() === "") {
    codes.push("EXP_ID_INVALID");
  }
  const split = input.split ?? EVEN_SPLIT;
  if (!validateSplit(split)) codes.push("EXP_SPLIT_INVALID");
  if (input.forced !== undefined && !EXPERIMENT_ARMS.includes(input.forced)) {
    codes.push("EXP_ARM_UNKNOWN");
  }
  if (codes.length > 0) return { ok: false, codes };

  const bucket = experimentBucket(input.experimentId, input.sessionId);
  const natural = armForBucket(bucket, split);
  const arm = input.forced ?? natural;
  // Precedence: a forced arm is self-selected, so it is never causal even when
  // it happens to agree with the natural arm. Shadow is likewise non-causal.
  const source: AssignmentSource =
    input.forced !== undefined ? "forced" : input.shadow === true ? "shadow" : "randomized";

  return {
    ok: true,
    assignment: {
      schema: "cache-experiment-v1",
      experimentId: input.experimentId,
      sessionId: input.sessionId,
      arm,
      bucket,
      source,
      assignedAt: input.assignedAt,
    },
  };
}

/**
 * Whether an assignment's telemetry may enter a causal interval.
 *
 * ONLY `randomized`. This single predicate is what keeps forced and shadow rows
 * out of the causal aggregate; every consumer computing an interval must filter
 * through it rather than re-deriving the rule.
 */
export function isCausallyAdmissible(a: CacheExperimentV1): boolean {
  return a.source === "randomized";
}

/**
 * Keep only causally admissible assignments. The complement is not discarded by
 * the caller — it is reported as `estimate` — but it never reaches an interval.
 */
export function causalOnly(
  assignments: readonly CacheExperimentV1[],
): readonly CacheExperimentV1[] {
  return assignments.filter(isCausallyAdmissible);
}

/**
 * Whether every assignment for one session agrees on the arm (CACHE-RANDOM-003).
 * A session that appears in two arms would contaminate both sides of the
 * comparison, so this is asserted directly rather than assumed.
 */
export function sessionArmsConsistent(
  assignments: readonly CacheExperimentV1[],
): boolean {
  const bySession = new Map<string, ExperimentArm>();
  for (const a of assignments) {
    const seen = bySession.get(a.sessionId);
    if (seen !== undefined && seen !== a.arm) return false;
    bySession.set(a.sessionId, a.arm);
  }
  return true;
}
