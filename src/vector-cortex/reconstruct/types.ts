/**
 * vector-cortex/reconstruct/types.ts — conservative closure + reconstruction
 * fidelity contract (VC4C).
 *
 * Owns `ClosureResult` / `ReconstructionV1` — the contract of the sprint failure
 * triad:
 *
 *   A = closed semantic + exact/residual reconstruction (the normal path);
 *   B = greedy EXACT-only closure, forced when semantic validation fails;
 *   C = legacy prompt, forced by an unresolved contradiction (states its loss of
 *       old semantic context — TRIAD_RESILIENCE: C is continuity, NOT semantic
 *       completeness).
 *
 * Closure is MANDATORY before VC5 (CONTRACTS §plan and closure): recursively add
 * every `depends`/tool-pair predecessor until a fixed point; for contradictions
 * keep the LATER exact source resolution unless an explicit resolution event
 * names the loser; ties keep both and reject live use
 * (`CLO_CONTRADICTION_UNRESOLVED`). The anchor floor is preserved, and the closed
 * mandatory node set is returned with its deterministic token estimate.
 *
 * OWNERSHIP BOUNDARY (CONTRACTS §plan and closure): `mandatoryTokenEstimate`
 * counts CONTENT ONLY — no prompt framing, no role tags, no separators, no
 * budget admission. VC5A exclusively owns framing/budget: it adds framing cost
 * to this estimate and returns `MANDATORY_CLOSURE_OVER_BUDGET` if the mandatory
 * cost exceeds its `tokenBudget`. VC4C therefore NEVER truncates a mandatory
 * node and never reasons about a budget.
 *
 * Consumes only reviewer-accepted predecessor contracts (VC1A `EventV2` byte
 * authority, VC4A `ShardRange`/`ExactShardV1`, VC4B `ParityShardV1` residual
 * decode) and the common contracts. Pure types + registered conformance IDs: no
 * storage, no console, no network (PREVENT-PI-004 / PREVENT-011).
 */

import type { ShardRange } from "../shards/types.js";

/**
 * The kind of a closure graph node, mirroring `DagNode.kind`
 * (CONTRACTS §PromptDagV1). `exact` nodes carry authoritative source bytes;
 * `semantic` nodes are derived and never claim to recover exact text;
 * `synthetic` nodes have no source span and order after their prerequisites.
 */
export type ClosureNodeKind = "event" | "exact" | "semantic" | "synthetic";

/**
 * One node in the closure graph. `span` is the half-open source byte range this
 * node occupies (absent for `synthetic` nodes, which have no source position).
 * `anchor` marks a node inside the preserved anchor floor — closure preserves it
 * and the validator rejects a reconstruction that drops it (PREVENT-PI-001's
 * anchor-floor discipline, restated for the closed prompt).
 *
 * `resolvedAtMs` is the source resolution TIME used only for contradiction
 * ordering: the LATER exact resolution wins. It is a source fact (the event's
 * `occurredAtMs`), never a wall clock read at closure time — closure is pure and
 * deterministic (TRIAD_RESILIENCE: wall time for records, never for eligibility).
 */
export interface ClosureNode {
  readonly id: string;
  readonly kind: ClosureNodeKind;
  /** Source span; absent only for `synthetic` nodes. */
  readonly span?: ShardRange;
  /** True when the node belongs to the preserved anchor floor. */
  readonly anchor?: boolean;
  /**
   * Source resolution time for contradiction ordering (from the source event,
   * never `Date.now()`). Two contradicting nodes with EQUAL or ABSENT
   * resolutions are an unresolved tie.
   */
  readonly resolvedAtMs?: bigint;
  /**
   * Deterministic CONTENT token estimate for this node (no framing). Summed into
   * `ClosureResult.mandatoryTokenEstimate` and handed unchanged to VC5A.
   */
  readonly tokenEstimate: number;
}

/**
 * One directed closure edge. Edges point prerequisite/earlier **from →
 * dependent/later to** (CONTRACTS §PromptDagV1).
 *
 *   - `depends`   — `to` requires `from`; closure pulls `from` in transitively;
 *   - `tool-pair` — a tool call/result pair that must be selected WHOLE (never
 *                   split at a compaction boundary — PREVENT-PI-002);
 *   - `contradicts` — mutually exclusive claims; the later exact resolution wins.
 */
export type ClosureEdgeKind = "depends" | "tool-pair" | "contradicts";

/** A directed closure edge (`from` is the prerequisite/earlier endpoint). */
export interface ClosureEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: ClosureEdgeKind;
}

/**
 * An explicit resolution event that names the LOSER of a contradiction
 * (CONTRACTS §plan and closure: "keep the later exact source unless an explicit
 * resolution event names the loser"). An explicit resolution therefore
 * OVERRIDES the later-wins time rule and breaks what would otherwise be a tie.
 */
export interface ContradictionResolution {
  /** The node id explicitly superseded (dropped from the closure). */
  readonly loserId: string;
  /** The node id that survives. */
  readonly winnerId: string;
}

/** The closure graph handed to `closeSelection`. */
export interface ClosureGraph {
  readonly sessionId: string;
  readonly nodes: readonly ClosureNode[];
  readonly edges: readonly ClosureEdge[];
  /** Explicit resolutions naming contradiction losers (may be empty). */
  readonly resolutions?: readonly ContradictionResolution[];
}

/**
 * A single recorded closure step — the PROOF that the fixed point was reached by
 * a defensible derivation rather than asserted. Each step names the node added
 * and the edge/rule that forced it.
 */
export interface ClosureProofStep {
  /** The node id added by this step. */
  readonly added: string;
  /** The already-selected node that required it (absent for a seed). */
  readonly requiredBy?: string;
  /** Why it was added. */
  readonly rule: "seed" | "depends" | "tool-pair" | "anchor-floor";
}

/** Closure failure codes (registered CLO codes). */
export type ClosureFailureCode =
  /** A contradiction whose resolutions are equal/unordered — reject live use. */
  | "CLO_CONTRADICTION_UNRESOLVED"
  /** An edge names a node id that is not in the graph. */
  | "CLO_MISSING_NODE"
  /** A seed id is not in the graph. */
  | "CLO_UNKNOWN_SEED";

/**
 * The closed mandatory node set (CONTRACTS §plan and closure). `ok:false` means
 * the closure is NOT live-usable and the adapter demotes (C on an unresolved
 * contradiction).
 *
 * `selected` is the fixed point: every seed plus every transitively required
 * dependency and whole tool pair, sorted deterministically by node id so the
 * result is stable across input permutations. `mandatoryTokenEstimate` is the
 * CONTENT-ONLY sum handed UNCHANGED to VC5A (which adds framing and owns budget
 * admission — VC4C never truncates a mandatory node).
 */
export interface ClosureResult {
  readonly ok: boolean;
  /** The closed selection (sorted by node id). */
  readonly selected: readonly string[];
  /** Dependencies/tool-pair members pulled in beyond the seeds (sorted). */
  readonly addedDependencies: readonly string[];
  /** Contradiction losers removed by the later-exact / explicit rule (sorted). */
  readonly removedContradictions: readonly string[];
  /** Contradictions that could not be resolved (sorted) — reject live use. */
  readonly unresolved: readonly string[];
  /** Ordered derivation proof of the fixed point. */
  readonly proof: readonly ClosureProofStep[];
  /** Failure codes; empty when `ok`. */
  readonly failures: readonly ClosureFailureCode[];
  /**
   * Deterministic CONTENT-ONLY token estimate of the closed mandatory set.
   * Contains NO prompt framing (VC5A adds that and owns budget admission).
   */
  readonly mandatoryTokenEstimate: number;
}

/**
 * One assembled span of the reconstruction. `bytes` are the authoritative source
 * bytes for `range` — either verbatim exact-shard bytes (`source:"exact"`), a
 * byte-exact residual decode (`source:"residual"`), or a derived semantic
 * rendering that NEVER claims to be the exact text (`source:"semantic"`).
 * `protectedSpan` marks a span the validator requires to be present and exact.
 */
export interface ReconstructionSpan {
  readonly nodeId: string;
  readonly range: ShardRange;
  readonly source: "exact" | "residual" | "semantic";
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex (no `sha256:` prefix). */
  readonly digest: string;
  /** True when this span must survive verbatim (tool pair / anchor / invalid UTF-8). */
  readonly protectedSpan: boolean;
}

/**
 * The assembled reconstruction (VC4C's outbound contract to VC5A). Spans are
 * ordered SOLELY by source range (`byteStart`, then `seqStart`, then node id for
 * a total order) — never by selection order, map iteration, or scoring, so the
 * assembly is deterministic and replayable. `digest` is one SHA-256 over the
 * ordered span digests plus their ranges.
 */
export interface ReconstructionV1 {
  readonly schema: "reconstruction-v1";
  readonly sessionId: string;
  /** Spans in source order (the concatenation order). */
  readonly spans: readonly ReconstructionSpan[];
  /** Deterministic digest over the ordered spans. */
  readonly digest: string;
  /** Total assembled byte count. */
  readonly byteTotal: number;
  /**
   * CONTENT-ONLY mandatory token estimate, carried UNCHANGED from the closure so
   * VC5A receives exactly the number VC4C computed (no framing, no budget).
   */
  readonly mandatoryTokenEstimate: number;
}

/** Reconstruction/validation failure codes (registered REC codes). */
export type ReconstructionFailureCode =
  /** A required source shard is missing AND its residual fallback failed. */
  | "REC_SOURCE_UNAVAILABLE"
  /** A protected anchor span is absent from the reconstruction. */
  | "REC_ANCHOR_MISSING"
  /** A tool call/result pair was split (PREVENT-PI-002). */
  | "REC_TOOL_PAIR_SPLIT"
  /** A span's bytes do not hash to its recorded digest. */
  | "REC_DIGEST_MISMATCH"
  /** The closure carried an unresolved contradiction — never goes live. */
  | "REC_CONTRADICTION_UNRESOLVED"
  /** Two assembled spans overlap in the source byte stream. */
  | "REC_SPAN_OVERLAP";

/**
 * Validation verdict. Reader-facing surface is SUMMARY + CODES ONLY — never span
 * bytes, never prompt text (SECURITY_PRIVACY: the exact ledger is not training
 * data and is never rendered through a diagnostic surface).
 */
export type ReconstructionValidation =
  | { readonly ok: true; readonly summary: ReconstructionSummary }
  | { readonly ok: false; readonly codes: readonly ReconstructionFailureCode[] };

/**
 * Aggregate-only reconstruction summary exposed to the dashboard. Counts, byte
 * totals and the digest identity — NEVER payload bytes or prompt text.
 */
export interface ReconstructionSummary {
  readonly sessionId: string;
  readonly spanCount: number;
  readonly protectedSpanCount: number;
  readonly byteTotal: number;
  readonly mandatoryTokenEstimate: number;
  readonly digest: string;
  /** Per-source span counts (exact / residual / semantic). */
  readonly bySource: {
    readonly exact: number;
    readonly residual: number;
    readonly semantic: number;
  };
}

/** The two structured events the VC4C reporter emits. */
export type ReconstructEventName =
  | "vector_cortex_reconstruction_validated"
  | "vector_cortex_closure_rejected";

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type ReconstructEmitter = (
  event: ReconstructEventName,
  fields: Record<string, unknown>,
) => void;

/** Typed, best-effort reporter bound to the two reconstruction event names. */
export interface ReconstructReporter {
  readonly reconstructionValidated: (fields: Record<string, unknown>) => void;
  readonly closureRejected: (fields: Record<string, unknown>) => void;
}

/**
 * Aggregate-only reconstruction metrics for the dashboard (counts/bytes only).
 */
export interface ReconstructMetricsV1 {
  readonly closureAttempts: number;
  readonly closureRejections: number;
  readonly validatedCount: number;
  readonly invalidatedCount: number;
  readonly spanTotal: number;
  readonly byteTotal: number;
}

/**
 * The triad mode VC4C selects (TRIAD_RESILIENCE). A/B/C use INDEPENDENT
 * algorithms: A closes over semantic+exact/residual; B is a greedy EXACT-only
 * closure that shares no semantic index with A; C abandons the closed prompt
 * entirely and returns the legacy transcript, stating its semantic loss.
 */
export type ReconstructMode = "A" | "B" | "C";

/**
 * The outcome of the triad selection: the mode taken, the validated
 * reconstruction (A/B) and the reason C was forced, if it was.
 */
export interface ReconstructTriadOutcome {
  readonly mode: ReconstructMode;
  readonly reconstruction: ReconstructionV1 | null;
  readonly codes: readonly ReconstructionFailureCode[];
  /**
   * Set only in mode C: the explicit statement that old semantic context is lost
   * (TRIAD_RESILIENCE — "C states its loss of old semantic context").
   */
  readonly semanticLossStated: boolean;
}

/**
 * Registered CLO conformance ID range (CLO-001..030). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`.
 */
export const CLO_IDS: readonly string[] = Array.from(
  { length: 30 },
  (_v, i) => `CLO-${String(i + 1).padStart(3, "0")}`,
);

/** Registered REC conformance ID range (REC-001..030). */
export const REC_IDS: readonly string[] = Array.from(
  { length: 30 },
  (_v, i) => `REC-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC4C conformance assertions (the sprint's headline rows). */
export const RECONSTRUCT_NAMED_IDS = [
  "CLO-TRANSITIVE-001",
  "CLO-CONTRA-002",
  "REC-ORDER-003",
] as const;

export type { ShardRange };
