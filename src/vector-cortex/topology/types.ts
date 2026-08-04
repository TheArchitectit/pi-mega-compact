/**
 * vector-cortex/topology/types.ts — deterministic cortical topology contract (VC3B).
 *
 * Owns `TopologyV1` / `EdgeV1` / `TopologyNodeV1` — the pure graph produced by
 * the deterministic build (build.ts). The build is the mode-A multi-head
 * topology index: for each (source, head) it retains only calibrated-threshold
 * edges, stable-sorts by score descending then unsigned target-ID bytes, and
 * caps each source/head at top-k=16. Dependency edges are directed records;
 * contradiction edges are emitted as symmetric PAIRED records (source→target
 * and target→source) so the encoded graph is directional even though the
 * relation is symmetric.
 *
 * Consumes only reviewer-accepted predecessor contracts (VC3A CortexRecordV1
 * aggregates, VC2B heads) and the [common contracts](../../../../docs/vector-cortex/CONTRACTS.md).
 * Pure types/schema + small predicates: no storage, no console, no network,
 * no side effects (PREVENT-PI-004 / PREVENT-011). The acceptance contract and
 * conformance IDs (TOP-001..020 + named TOP-K/TIE/KIND) live here.
 */

/**
 * A graph node — identity plus the record kind it is derived from. The build
 * produces `"dependency"` (a dependency candidate's endpoint) and
 * `"contradiction"` (a contradiction candidate's endpoint); `"synthetic"` is
 * reserved for future record kinds that may be surfaced as nodes (it is not
 * produced by the current build, but matches the CortexRecordV1 kind set).
 * Every emitted node kind is one the node was actually derived from — a node is
 * never labelled with a kind its producing record did not carry (Q02).
 */
export interface TopologyNodeV1 {
  readonly id: string;
  readonly kind:
    | "semantic"
    | "dependency"
    | "contradiction"
    | "synthetic";
}

/**
 * A directed edge. `direction` encodes the semantic kind:
 *   - "dependency" — a directed prerequisite relation (one record, source→target);
 *   - "contradiction" — a symmetric relation emitted as a PAIR of records
 *     (source→target and target→source). Both records share the same `score`.
 * `head` names the producing encoder head; `score` is the retained score.
 */
export interface TopologyEdgeV1 {
  readonly source: string;
  readonly target: string;
  readonly head: string;
  readonly score: number;
  readonly direction: "dependency" | "contradiction";
}

/**
 * One calibrated-threshold candidate edge from the build input. `kind` selects
 * the edge direction encoding (dependency directed, contradiction symmetric
 * pair). Candidates are never mutated by the build.
 */
export interface TopologyCandidate {
  readonly source: string;
  readonly target: string;
  readonly head: string;
  readonly score: number;
  readonly kind: "dependency" | "contradiction";
}

/** Input to the deterministic topology build (mode-A producer). */
export interface TopologyInput {
  readonly sessionId: string;
  /** Durable authority high-water the derived graph is built AT. */
  readonly sourceHighWater: bigint;
  /** Calibrated score threshold; candidates at or below it are dropped. */
  readonly threshold: number;
  readonly candidates: readonly TopologyCandidate[];
}

/**
 * A rejected candidate edge. The build rejects a candidate in isolation and
 * continues with every other head — one bad edge never poisons the graph.
 */
export interface TopologyRejection {
  readonly source: string;
  readonly target: string;
  readonly head: string;
  readonly score: number;
  readonly code: TopologyRejectCode;
}

/** Failure codes for a rejected candidate edge. */
export type TopologyRejectCode =
  | "TOP_SCORE_NONFINITE"
  | "TOP_SELF_EDGE"
  | "TOP_FRAMING_SEP";

/** Result of a deterministic topology build (task 3). */
export type TopologyBuildResult =
  | { ok: true; topology: TopologyV1; rejected: readonly TopologyRejection[] }
  | { ok: false; code: string };

/**
 * The derived graph. `generationDigest` is ONE deterministic SHA-256 (hex)
 * over the canonical, order-independent serialization of nodes + edges —
 * identical across any input ordering (graph digest ignores input order).
 * `nodes`/`edges` are exposed in their CANONICAL order through the stated
 * topology endpoint/client: nodes sorted by id bytes, edges sorted by
 * (source, target, head, direction bytes) then score.
 */
export interface TopologyV1 {
  readonly schema: "topology-v1";
  readonly sessionId: string;
  readonly sourceHighWater: bigint;
  readonly threshold: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly generationDigest: string;
  readonly nodes: readonly TopologyNodeV1[];
  readonly edges: readonly TopologyEdgeV1[];
}

/**
 * Registered TOP conformance ID range (TOP-001..020). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/code. The three NAMED assertions (TOP-K-001 / TOP-TIE-002 /
 * TOP-KIND-003) live in the acceptance test.
 */
export const TOP_IDS = [
  "TOP-001",
  "TOP-002",
  "TOP-003",
  "TOP-004",
  "TOP-005",
  "TOP-006",
  "TOP-007",
  "TOP-008",
  "TOP-009",
  "TOP-010",
  "TOP-011",
  "TOP-012",
  "TOP-013",
  "TOP-014",
  "TOP-015",
  "TOP-016",
  "TOP-017",
  "TOP-018",
  "TOP-019",
  "TOP-020",
] as const;

/** Named TOP conformance assertions (spec: TOP-K/TOP-TIE/TOP-KIND). */
export const TOP_NAMED_IDS = [
  "TOP-K-001",
  "TOP-TIE-002",
  "TOP-KIND-003",
] as const;

/** Deterministic per-source/head edge cap (top-k=16). */
export const TOP_K = 16;
