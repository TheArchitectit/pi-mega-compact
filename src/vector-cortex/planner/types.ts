/**
 * vector-cortex/planner/types.ts — `PlanV1` + the budget admission contract
 * (VC5A, task 1).
 *
 * VC5A EXCLUSIVELY OWNS FRAMING + BUDGET ADMISSION (CONTRACTS §plan and
 * closure). VC4C hands over `ClosureResult.mandatoryTokenEstimate`, a
 * CONTENT-ONLY count with no prompt framing, no role tags and no separators, and
 * VC4C never truncates a mandatory node nor reasons about a budget. This module
 * adds the framing cost on top of that content estimate and decides admission:
 *
 *   framed(node)   = tokenEstimate + framingPerNode
 *   mandatoryCost  = mandatoryTokenEstimate + framingPerNode * |mandatory|
 *                    + framingOverhead
 *
 * If `mandatoryCost > tokenBudget` the planner returns
 * `MANDATORY_CLOSURE_OVER_BUDGET` and the adapter demotes to C. Crucially it
 * does so WITHOUT DROPPING EVIDENCE: the mandatory set is returned intact on the
 * failure so the caller can report exactly what did not fit (the sprint bar:
 * "over-budget mandatory closure never drops evidence and always demotes").
 *
 * The framing constants are CONFIGURABLE, never invented magic numbers: a caller
 * supplies the profile it is actually rendering with, and the defaults below are
 * documented as a conservative baseline rather than a measured provider fact.
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * The prompt framing cost model. These are the ONLY places framing enters the
 * budget, keeping the VC4C content-only estimate cleanly separable.
 *
 * `perNode` is the per-node envelope (role tag + separator) a renderer adds
 * around one node's content. `overhead` is the whole-prompt fixed cost (system
 * preamble scaffolding, closing delimiters) charged once.
 *
 * Both DEFAULT to a conservative baseline and are overridable per call, so a
 * provider profile with a measured framing cost (VC5B) supplies its own numbers
 * rather than inheriting a guess.
 */
export interface FramingProfile {
  /** Tokens added around each selected node (role tag + separator). */
  readonly perNode: number;
  /** Fixed whole-prompt framing tokens charged once. */
  readonly overhead: number;
}

/**
 * Conservative default framing baseline. Documented as a BASELINE, not a
 * measured provider constant: a real provider profile (VC5B) overrides it. Kept
 * small and explicit so a default-driven plan is never silently over-optimistic.
 */
export const DEFAULT_FRAMING: FramingProfile = { perNode: 4, overhead: 8 };

/**
 * One candidate offered to the 0/1 portfolio. `mandatory` candidates are the
 * closed set from VC4C and are admitted before any optional selection; optional
 * candidates compete for the REMAINING budget.
 *
 * `sourceSeq` is the source ordering fact used as the FIRST tie-break after
 * utility-per-token, so two equally efficient candidates resolve by source
 * position (earlier wins) and then by ID bytes — a total, deterministic order.
 */
export interface PlanCandidate {
  readonly nodeId: string;
  /** CONTENT-ONLY token estimate (framing is added by the planner). */
  readonly tokenEstimate: number;
  /** Selection value; higher is better. Ratio is `utility / framedTokens`. */
  readonly utility: number;
  /** Source sequence position, the first tie-break after the ratio. */
  readonly sourceSeq: bigint;
  /** True when the candidate is part of the mandatory closure. */
  readonly mandatory: boolean;
}

/** Why a candidate was left out of the plan (recorded, never silent). */
export interface PlanOmission {
  readonly nodeId: string;
  readonly reason: "over-budget" | "incompatible" | "zero-utility";
}

/** Planner failure codes (registered PLN codes). */
export type PlanFailureCode =
  /**
   * The mandatory closure alone (with framing) exceeds `tokenBudget`. Evidence
   * is NOT dropped — the mandatory set is returned intact and the adapter
   * demotes to C.
   */
  | "MANDATORY_CLOSURE_OVER_BUDGET"
  /** A candidate names a node absent from the DAG. */
  | "PLN_UNKNOWN_NODE"
  /** Two selected nodes declare mutual incompatibility. */
  | "PLN_INCOMPATIBLE_SELECTION"
  /** The DAG digest recorded in the plan no longer matches the DAG. */
  | "PLN_MANIFEST_DIGEST_MISMATCH"
  /** The budget itself is invalid (negative or non-finite). */
  | "PLN_INVALID_BUDGET";

/**
 * The accepted plan (CONTRACTS §plan and closure). `selectedNodeIds` is sorted
 * for a stable manifest; `tokenTotal` is the FRAMED total and is guaranteed
 * `<= tokenBudget` for every accepted plan.
 */
export interface PlanV1 {
  readonly schema: "plan-v1";
  /** Digest of the DAG this plan was selected over (binds plan to structure). */
  readonly dagDigest: string;
  /** The selected node IDs, sorted by ID bytes. */
  readonly selectedNodeIds: readonly string[];
  /** The budget this plan was admitted against. */
  readonly tokenBudget: number;
  /** Framed token total of the selection; always `<= tokenBudget`. */
  readonly tokenTotal: number;
  /** Summed utility of the selection. */
  readonly utilityTotal: number;
  /** The durable authority high-water the plan's evidence depends on. */
  readonly dependencyHighWater: bigint;
  /** Candidates deliberately left out, with the reason. */
  readonly omissions: readonly PlanOmission[];
}

/**
 * The planner verdict. On failure the mandatory set is preserved so an
 * over-budget closure can be reported WITHOUT dropping evidence.
 */
export type PlanResult =
  | { readonly ok: true; readonly plan: PlanV1 }
  | {
      readonly ok: false;
      readonly code: PlanFailureCode;
      /** The intact mandatory node IDs (never dropped on failure). */
      readonly mandatory: readonly string[];
      /** The framed cost of the mandatory set that could not be admitted. */
      readonly mandatoryCost: number;
      /** The budget the mandatory cost was measured against. */
      readonly tokenBudget: number;
    };

/**
 * The triad mode VC5A selects (TRIAD_RESILIENCE). A/B/C are INDEPENDENT
 * algorithms:
 *
 *   A = the 0/1 portfolio optimizer (ratio-ordered admission);
 *   B = a stable greedy closed planner, forced by an A exception — it shares no
 *       ratio ordering with A and admits strictly in source order;
 *   C = the predecessor prompt, forced by mandatory overflow; it states its loss
 *       of old semantic context (continuity, NOT completeness).
 */
export type PlanMode = "A" | "B" | "C";

/** The two structured events the VC5A reporter emits. */
export type PlanEventName =
  | "vector_cortex_plan_selected"
  | "vector_cortex_plan_mandatory_overflow";

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type PlanEmitter = (
  event: PlanEventName,
  fields: Record<string, unknown>,
) => void;

/** Typed, best-effort reporter bound to the two plan event names. */
export interface PlanReporter {
  readonly planSelected: (fields: Record<string, unknown>) => void;
  readonly planMandatoryOverflow: (fields: Record<string, unknown>) => void;
}

/**
 * Aggregate-only plan metrics for the dashboard (counts/tokens only, never
 * prompt text or node payloads).
 */
export interface PlanMetricsV1 {
  readonly plansSelected: number;
  readonly mandatoryOverflows: number;
  readonly nodesSelected: number;
  readonly tokenTotal: number;
}

/**
 * Registered PLN conformance ID range (PLN-001..020). The acceptance aggregator
 * reads these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`.
 */
export const PLN_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_v, i) => `PLN-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC5A planner conformance assertions (the sprint's headline rows). */
export const PLAN_NAMED_IDS = ["PLN-MANDATORY-002", "PLN-TIE-003"] as const;
