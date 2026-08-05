/**
 * vector-cortex/heal/repair-types.ts — VC6C self-healing derived controller.
 *
 * VC6B answered "when a node's bytes are gone, WHERE do they come from?". VC6C
 * answers the question one level up: when a DERIVED subsystem (topology, shards,
 * closure) has fallen BEHIND the durable authority, how do we notice, and how do
 * we catch it up without ever risking the authority itself?
 *
 * THE AUTHORITY IS READ-ONLY, ALWAYS. The controller compares each derived
 * source's high-water to the durable authority high-water and plans work. It has
 * no write path to the authority — not a guarded one, not an admin one. Derived
 * state is disposable and can always be rebuilt from the byte ledger; the
 * authority is not, so the repair path is deliberately one-directional. This is
 * why `RepairState` carries `authorityHighWater` as a plain readonly field and
 * why no function in `controller.ts` returns anything that could be applied to it.
 *
 * NEVER READ PAST THE AUTHORITY (TRIAD_RESILIENCE §frontier). A derived builder
 * may not read beyond the durable CONTIGUOUS authority high-water. During an
 * authority outage that high-water FREEZES even though the spool keeps accepting
 * frames — so a derived subsystem that is "behind" a frozen frontier is CORRECT,
 * not broken, and planning a rebuild against the spool tail would materialize
 * frames that are not yet durable. `detectGaps` therefore treats
 * `authorityFrozen` as a hard stop (`HEAL_REPAIR_AUTHORITY_FROZEN`) rather than
 * as a large gap to chase. After the drain, catch-up resumes from the OLD
 * high-water; it never jumps to the tail.
 *
 * REBUILD IS COPY-THEN-SWITCH, NEVER IN-PLACE. `rebuild.ts` materializes a NEW
 * generation, verifies its root digest, and only then flips the pointer. A failed
 * verification keeps the old pointer and DELETES NO EVIDENCE: the corrupt
 * generation stays on disk to be inspected. An in-place repair would, by
 * construction, destroy the only copy of the thing that was about to be proven
 * wrong.
 *
 * RATE LIMIT + BACKOFF ARE THE BLAST RADIUS. A subsystem that fails to rebuild
 * will fail again, usually instantly, so an unbounded retry loop turns one broken
 * shard into a CPU-saturating rebuild storm. One rebuild per subsystem per 5
 * minutes bounds the steady state, and the deterministic exponential backoff
 * (30s * 2^attempt, capped at 15 min, ±10% jitter derived from the SUBSYSTEM
 * DIGEST rather than `Math.random`) bounds the failure state while keeping the
 * schedule reproducible in a fixture.
 *
 * Pure types + registered conformance IDs: no storage, no console, no clock, no
 * network (PREVENT-PI-004 / PREVENT-011).
 */

import type { ShardRange } from "../shards/types.js";
import type { EventV2 } from "../ledger/types.js";

/** The triad mode, mirroring TRIAD_RESILIENCE (A targeted / B full / C disable). */
export type Mode = "A" | "B" | "C";

/**
 * A derived subsystem name (e.g. "topology", "shards", "closure").
 *
 * Deliberately a plain string rather than a closed union: the set of derived
 * subsystems grows every sprint, and a union here would force an unrelated
 * contract edit (and a conformance-corpus regeneration) every time a new derived
 * tier is added. The subsystem name is also the jitter seed, so it must be stable.
 */
export type RepairSubsystem = string;

/**
 * A planned rebuild for ONE subsystem.
 *
 * `range` is the gap to rebuild — derived high-water (exclusive) to authority
 * high-water (inclusive) — so a plan is self-describing: an operator can read the
 * exact seq window that will be materialized. `generation` is the NEW generation
 * the rebuild will write into (never the live one). `backoffMs` is the delay
 * BEFORE the plan may execute, and `scheduledAt` is the monotonic timestamp it
 * becomes eligible.
 */
export interface RepairPlanV1 {
  readonly schema: "repair-plan-v1";
  readonly subsystem: RepairSubsystem;
  /** The seq/byte window to rebuild (derived high-water .. authority high-water). */
  readonly range: ShardRange;
  /** The NEW generation number the rebuild materializes into. */
  readonly generation: number;
  /** Deterministic delay before this plan is eligible to run. */
  readonly backoffMs: number;
  /** Monotonic ms at which the plan becomes eligible (`now + backoffMs`). */
  readonly scheduledAt: bigint;
}

/**
 * A repair lifecycle record. Emitted as a structured event AND retained for the
 * dashboard's repair state, so it carries identity and counters only — never a
 * rebuilt byte, never a node id, never transcript text (SECURITY_PRIVACY).
 */
export interface RepairEventV1 {
  readonly schema: "repair-event-v1";
  readonly subsystem: RepairSubsystem;
  /**
   * `planned`          — a gap was detected and a rebuild scheduled.
   * `pointer-switched` — a verified generation became live (the ONLY success).
   * `backoff`          — a rebuild was suppressed (rate limit) or failed and is
   *                      now waiting out its exponential delay.
   */
  readonly kind: "planned" | "pointer-switched" | "backoff";
  readonly generation: number;
  /** Monotonic ms of the transition. */
  readonly ts: bigint;
}

/** VC6C failure codes (registered HEAL codes). */
export type RepairFailureCode =
  /**
   * The authority high-water is frozen (outage). Derived state is CORRECTLY
   * behind and must not chase the spool tail — planning is refused, not delayed.
   */
  | "HEAL_REPAIR_AUTHORITY_FROZEN"
  /** A rebuilt generation's root digest does not match — pointer NOT switched. */
  | "HEAL_REPAIR_DIGEST_MISMATCH"
  /** The rebuild itself could not produce a generation (mode C disable). */
  | "HEAL_REBUILD_FAILED"
  /** A second rebuild for this subsystem inside the 5-minute window. */
  | "HEAL_REPAIR_RATE_LIMITED";

/**
 * The controller's view of ONE derived subsystem.
 *
 * `authorityHighWater` is READ, never written (see the file header). `mode`
 * records which triad arm this subsystem is currently served by, so a subsystem
 * already in mode C (derived state disabled) is not repeatedly re-planned.
 */
export interface RepairState {
  readonly subsystem: RepairSubsystem;
  /** How far the derived source has been built (inclusive seq). */
  readonly derivedHighWater: bigint;
  /** Durable CONTIGUOUS authority high-water (inclusive seq). Read-only. */
  readonly authorityHighWater: bigint;
  /** Monotonic ms of the last rebuild, or null if never rebuilt. */
  readonly lastRebuildAt: bigint | null;
  /** The CURRENT live generation. A plan targets `generation + 1`. */
  readonly generation: number;
  /** Which triad arm currently serves this subsystem. */
  readonly mode: Mode;
  /**
   * Consecutive failed rebuild attempts, the exponent in `30s * 2^attempt`.
   * Reset to 0 on a successful pointer switch.
   */
  readonly failedAttempts?: number;
  /**
   * True while the durable authority frontier is frozen (outage). A frozen
   * authority makes a derived lag EXPECTED, so no plan may be produced.
   */
  readonly authorityFrozen?: boolean;
}

/** The gap-detection + planning surface. Pure: no clock of its own, no I/O. */
export interface RepairController {
  /** Plan a rebuild for every subsystem with a real, actionable gap. */
  readonly detectGaps: (
    states: readonly RepairState[],
    nowMs: bigint,
  ) => readonly RepairPlanV1[];
  /** Build a single plan for one subsystem's gap. */
  readonly planRebuild: (state: RepairState, nowMs: bigint) => RepairPlanV1;
}

/**
 * One rebuild per subsystem per 5 minutes. Bounds a rebuild storm: a subsystem
 * that fails will fail again immediately, and without this an unhealthy tier
 * would saturate the box re-materializing the same broken generation.
 */
export const REPAIR_RATE_LIMIT_MS = 5 * 60_000;

/**
 * Exponential backoff base/cap, matching the breaker's retry rule
 * (TRIAD_RESILIENCE): `30s * 2^attempt`, capped at 15 minutes.
 */
export const REPAIR_BACKOFF_BASE_MS = 30_000;
export const REPAIR_BACKOFF_CAP_MS = 15 * 60_000;

/**
 * ±10% deterministic jitter. Derived from the SUBSYSTEM DIGEST, not a PRNG, so
 * two subsystems desynchronize (no thundering herd) while any single subsystem's
 * schedule stays reproducible in a fixture.
 */
export const REPAIR_BACKOFF_JITTER = 0.1;

/**
 * Registered VC6C conformance ID range (HEAL-031..045), continuing VC6B's
 * HEAL-016..030. The acceptance test reads these rows from the v2 manifest and
 * asserts each returns its manifest `ok`/`code`.
 */
export const REPAIR_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `HEAL-${String(i + 31).padStart(3, "0")}`,
);

/** Named VC6C conformance assertions (the sprint's headline rows). */
export const REPAIR_NAMED_IDS = [
  "HEAL-GAP-001",
  "HEAL-RATE-002",
  "HEAL-SWITCH-003",
] as const;

/** The three structured events the VC6C reporter emits. */
export type RepairEventName =
  | "vector_cortex_repair_planned"
  | "vector_cortex_repair_pointer_switched"
  | "vector_cortex_repair_backoff";

/**
 * Reader-only dashboard aggregate. Counters and the runtime mode only — no
 * subsystem payload, no rebuilt bytes, no gap ranges, no high-water marks, no
 * root digests (SECURITY_PRIVACY).
 *
 * Field names mirror `VectorCortexRepairView` in
 * `extensions/dashboard-server/api-contracts/vector-cortex-heal.ts` EXACTLY.
 * The dashboard contract is the shipped shape; keeping a differently-named
 * mirror here would guarantee a silent drift the compiler could never catch,
 * since the route builds its body from the extensions-side type.
 */
export interface RepairView {
  readonly enabled: boolean;
  readonly mode: Mode;
  readonly repairAttempts: number;
  readonly repairsPlanned: number;
  readonly pointersSwitched: number;
  readonly backoffs: number;
  readonly lastBackoffMs: number | null;
  readonly lastFailure: RepairFailureCode | null;
}

export type { EventV2, ShardRange };
