/**
 * vector-cortex/heal/types.ts — VC6A closure-optimization contract.
 *
 * Owns `ClosureProofV2` and `RestoreHintV1`.
 *
 * VC4C already performs the MANDATORY conservative closure (CONTRACTS §plan and
 * closure): it recursively adds every `depends`/tool-pair predecessor to a fixed
 * point, resolves contradictions, and preserves the anchor floor. VC6A does NOT
 * re-close and does NOT change WHICH NODES ARE SELECTED — "VC6 only optimizes
 * restoration/self-healing". It optimizes the PROOF EDGES of that already-closed
 * graph by transitive reduction: an edge `a -> c` whose requirement is already
 * carried by a path `a -> b -> c` is redundant and can be dropped from the
 * traversal plan without changing the closed set.
 *
 * The optimization is therefore a claim, and a claim needs a receipt:
 * `ClosureProofV2` records EVERY considered edge — retained or removed — with
 * the reason. `proof.ts` replays those rows against the conservative VC4C oracle
 * and rejects the optimization if the selected set diverges
 * (`HEAL_PROOF_SET_MISMATCH`) or if a considered edge has no proof row
 * (`HEAL_PROOF_INCOMPLETE`).
 *
 * PROTECTED EDGES ARE NEVER REMOVED. A tool-pair edge (PREVENT-PI-002), an edge
 * touching an anchor node (PREVENT-PI-001's anchor floor), a
 * contradiction-resolution edge, and a SOLE dependency edge (the only edge that
 * pulls its prerequisite in) are all retained unconditionally, even when an
 * alternate path exists. Only a redundant `depends` edge may go.
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import type { ClosureEdge, ClosureEdgeKind } from "../reconstruct/types.js";

/**
 * Why an edge survived the reduction. Ordered from strongest guarantee to
 * weakest:
 *
 *   - `tool-pair`      — a tool call/result pair is atomic and never split
 *                        (PREVENT-PI-002), so its edge is structural, not
 *                        merely a traversal hint;
 *   - `anchor`         — an endpoint is in the preserved anchor floor
 *                        (PREVENT-PI-001), so the edge documents a floor
 *                        obligation and is never elided;
 *   - `contradiction`  — a `contradicts` edge participates in resolution; the
 *                        resolver reads it directly, so removing it would
 *                        change the resolved set, not just the traversal;
 *   - `sole-dependency`— the ONLY edge requiring this prerequisite; removing it
 *                        would drop the prerequisite from the closure;
 *   - `no-alternate-path` — a plain `depends` edge with no `a -> ... -> c`
 *                        detour, so it still carries its own requirement.
 */
export type RetainReason =
  | "tool-pair"
  | "anchor"
  | "contradiction"
  | "sole-dependency"
  | "no-alternate-path";

/**
 * Why an edge was removed. Exactly one reason exists today — a redundant
 * `depends` edge shadowed by a longer path — and it is spelled out rather than
 * implied so a proof row can never be "removed, reason unstated"
 * (HEAL-PROOF-003).
 */
export type RemoveReason = "transitively-implied";

/**
 * One proof row: an edge the optimizer CONSIDERED, and what it decided.
 *
 * Every considered edge produces exactly one row — including retained ones. A
 * proof that lists only removals cannot be replayed against the oracle, because
 * the verifier could not distinguish "retained deliberately" from "never
 * examined" (the `HEAL_PROOF_INCOMPLETE` injection).
 *
 * `via` names the intermediate vertex of the witnessing path `from -> via -> to`
 * for a removal. It is REQUIRED on a removal row (the witness IS the reason) and
 * absent on a retention row.
 */
export interface ClosureProofRow {
  readonly from: string;
  readonly to: string;
  readonly kind: ClosureEdgeKind;
  readonly decision: "retained" | "removed";
  /** The stated reason. A removal without a reason fails verification. */
  readonly reason: RetainReason | RemoveReason;
  /** Witness vertex of the implying path (removals only). */
  readonly via?: string;
}

/**
 * The optimization receipt (`ClosureProofV2`).
 *
 * `selected` is copied UNCHANGED from the conservative VC4C closure — the
 * optimizer never edits it, and the verifier re-derives it independently to
 * prove that. `retainedEdges`/`removedEdges` are the optimized traversal plan;
 * `rows` is the full considered-edge ledger, sorted deterministically.
 *
 * `conservativeTraversals` / `optimizedTraversals` are the edge-walk counts of
 * the conservative and reduced plans; the sprint's acceptance bar is a >=20%
 * median reduction across the fixture corpus, measured from these two numbers.
 */
export interface ClosureProofV2 {
  readonly schema: "closure-proof-v2";
  readonly sessionId: string;
  /** The closed selection, byte-identical to the conservative VC4C result. */
  readonly selected: readonly string[];
  /** Edges kept in the optimized traversal plan (sorted). */
  readonly retainedEdges: readonly ClosureEdge[];
  /** Edges dropped as transitively implied (sorted). */
  readonly removedEdges: readonly ClosureEdge[];
  /** One row per CONSIDERED edge — retained and removed alike (sorted). */
  readonly rows: readonly ClosureProofRow[];
  /** Edge walks the conservative plan performs. */
  readonly conservativeTraversals: number;
  /** Edge walks the optimized plan performs. */
  readonly optimizedTraversals: number;
}

/**
 * `RestoreHintV1` — the reader-only hint VC6B consumes to fetch missing sources.
 *
 * A hint names a node the optimized plan still needs and the CHEAPEST retained
 * edge that reaches it (`viaEdgeFrom`), so the restorer can walk one edge rather
 * than re-deriving the closure. `protectedNode` marks a node whose edge set was
 * retained for a hard-safety reason (tool pair / anchor), telling VC6B to treat
 * it as non-negotiable.
 *
 * Reader-only by contract: node IDENTITY plus the traversal hint, NEVER source
 * bytes or prompt text (SECURITY_PRIVACY — the exact ledger is not training
 * data and is never rendered through a diagnostic surface).
 */
export interface RestoreHintV1 {
  readonly schema: "restore-hint-v1";
  readonly nodeId: string;
  /** The retained edge's prerequisite endpoint, if the node has one. */
  readonly viaEdgeFrom?: string;
  /** True when the node is anchor-floor or tool-pair protected. */
  readonly protectedNode: boolean;
  /** Deterministic reason label mirroring the retention reason. */
  readonly reason: RetainReason;
}

/** VC6A failure codes (registered HEAL codes). */
export type HealFailureCode =
  /** The replayed selected set diverges from the conservative oracle. */
  | "HEAL_PROOF_SET_MISMATCH"
  /** A considered edge has no proof row (or a removal states no reason). */
  | "HEAL_PROOF_INCOMPLETE"
  /** A proof row removes an edge that is protected and must be retained. */
  | "HEAL_PROOF_PROTECTED_REMOVED"
  /** A removal row's witness path `from -> via -> to` does not exist. */
  | "HEAL_PROOF_WITNESS_INVALID"
  /** The underlying conservative closure itself failed — nothing to optimize. */
  | "HEAL_CLOSURE_REJECTED";

/**
 * Verifier verdict. `ok:true` means the optimized plan is provably equivalent to
 * the conservative closure and mode A may be used. `ok:false` routes to mode B
 * (the conservative VC4C closure, unoptimized) — never to a partially reduced
 * plan.
 */
export type ProofVerification =
  | { readonly ok: true; readonly selected: readonly string[] }
  | { readonly ok: false; readonly codes: readonly HealFailureCode[] };

/**
 * The triad mode VC6A selects (TRIAD_RESILIENCE).
 *
 *   A = the optimized closure whose proof verified;
 *   B = the VC4C conservative closure, forced by proof rejection — an
 *       INDEPENDENT algorithm (fixed-point worklist, no reduction) reached by a
 *       different code path in `reconstruct/closure.ts`;
 *   C = the legacy prompt, forced when BOTH closure paths fail (an unresolved
 *       contradiction or a structurally invalid graph), stating its loss of old
 *       semantic context.
 */
export type HealMode = "A" | "B" | "C";

/** The outcome of the VC6A triad selection. */
export interface HealTriadOutcome {
  readonly mode: HealMode;
  /** The verified optimized proof (mode A only). */
  readonly proof: ClosureProofV2 | null;
  /** The selected node set actually used (empty only in mode C). */
  readonly selected: readonly string[];
  readonly codes: readonly HealFailureCode[];
  /** Set only in mode C (TRIAD_RESILIENCE — "C states its semantic loss"). */
  readonly semanticLossStated: boolean;
}

/** The two structured events the VC6A reporter emits. */
export type HealEventName =
  | "vector_cortex_closure_optimized"
  | "vector_cortex_closure_proof_rejected";

/**
 * Aggregate-only closure-proof metrics for the dashboard (counts only, never
 * node ids, edges, or source payloads).
 */
export interface HealMetricsV1 {
  readonly optimizations: number;
  readonly proofRejections: number;
  readonly retainedEdgeTotal: number;
  readonly removedEdgeTotal: number;
  readonly conservativeTraversalTotal: number;
  readonly optimizedTraversalTotal: number;
}

/**
 * Registered HEAL conformance ID range (HEAL-001..015). The acceptance test
 * reads these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`.
 */
export const HEAL_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `HEAL-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC6A conformance assertions (the sprint's headline rows). */
export const HEAL_NAMED_IDS = [
  "HEAL-REDUCE-001",
  "HEAL-PROTECT-002",
  "HEAL-PROOF-003",
] as const;

export type { ClosureEdge, ClosureEdgeKind };
