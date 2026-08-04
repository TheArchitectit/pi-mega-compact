/**
 * vector-cortex/prompt-dag/types.ts — the exact single-session `PromptDagV1`
 * schema (VC5A, task 1).
 *
 * A PromptDagV1 is the STRUCTURE a plan is selected over: nodes are prompt
 * candidates (events, exact spans, semantic renderings, synthetic citations) and
 * edges are the ordering/atomicity/exclusivity constraints among them. It is
 * strictly SINGLE-SESSION (CONTRACTS §PromptDagV1): every node span MUST carry
 * `dag.sessionId`; cross-session evidence is represented by a SYNTHETIC node
 * whose payload cites a separately validated source manifest, never by a foreign
 * span.
 *
 * Ordering is a total order by construction so the same DAG always yields the
 * same Kahn sequence:
 *
 *   - event/exact/semantic nodes order by their source span (`startSeq`, then
 *     `startByte`);
 *   - synthetic nodes have NO span and sort after every prerequisite, then by
 *     `syntheticOrdinal`, then by node-ID bytes;
 *   - the zero-indegree queue key is `(span.startSeq ?? MAX, syntheticOrdinal ??
 *     0, id bytes)` — never object/map iteration order.
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * A half-open source span. `startSeq`/`endSeq` are INCLUSIVE event sequence
 * numbers; `startByte`/`endByte` are HALF-OPEN byte offsets (CONTRACTS
 * §PromptDagV1). `digest` is the pinned `sha256:<hex>` of the covered bytes —
 * the builder rejects two overlapping spans whose digests disagree, since that
 * is a corrupted or forged source claim rather than a legitimate overlap.
 */
export interface DagSpan {
  readonly sessionId: string;
  readonly startSeq: bigint;
  readonly endSeq: bigint;
  readonly startByte: number;
  readonly endByte: number;
  /** Pinned digest of the covered bytes, `sha256:` prefixed. */
  readonly digest: `sha256:${string}`;
}

/**
 * The kind of a DAG node.
 *
 *   - `event`     — a whole source event record;
 *   - `exact`     — authoritative source bytes (verbatim, never paraphrased);
 *   - `semantic`  — a derived rendering that NEVER claims to recover exact text;
 *   - `synthetic` — no source span (a citation/summary); orders after its
 *                   prerequisites by `syntheticOrdinal` then ID bytes.
 */
export type DagNodeKind = "event" | "exact" | "semantic" | "synthetic";

/**
 * One prompt-DAG node. `span` is present for every non-synthetic kind and absent
 * for `synthetic`. `incompatibleWith` lists node IDs that may NOT be selected
 * together with this node (a mutual-exclusion constraint the planner enforces —
 * distinct from a `contradicts` EDGE, which is a source-level disagreement).
 */
export interface DagNode {
  readonly id: string;
  readonly kind: DagNodeKind;
  /** Source span; absent (and required to be absent) for `synthetic`. */
  readonly span?: DagSpan;
  /** Tie-break ordinal for synthetic nodes, which have no span. */
  readonly syntheticOrdinal?: number;
  /** Digest of this node's payload (identity for the manifest digest). */
  readonly payloadDigest: string;
  /** Node IDs that must never be co-selected with this node. */
  readonly incompatibleWith: readonly string[];
}

/**
 * A directed DAG edge, pointing prerequisite/earlier **from → dependent/later
 * to** (CONTRACTS §PromptDagV1).
 *
 *   - `precedes`    — pure ordering; `from` must appear before `to`;
 *   - `depends`     — `to` requires `from` (closure pulls `from` in);
 *   - `tool-pair`   — an atomic tool call/result pair, never split
 *                     (PREVENT-PI-002);
 *   - `contradicts` — mutually exclusive source claims.
 */
export type DagEdgeKind = "precedes" | "depends" | "tool-pair" | "contradicts";

/** A directed prompt-DAG edge (`from` is the prerequisite/earlier endpoint). */
export interface DagEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: DagEdgeKind;
}

/**
 * The single-session prompt DAG. `sourceHighWater` is the durable contiguous
 * authority high-water this DAG was built against — a derived structure may
 * never claim evidence beyond it (TRIAD_RESILIENCE: derived frontier cannot
 * exceed durable authority high-water).
 */
export interface PromptDagV1 {
  readonly schema: "prompt-dag-v1";
  readonly sessionId: string;
  readonly sourceHighWater: bigint;
  readonly nodes: readonly DagNode[];
  readonly edges: readonly DagEdge[];
}

/**
 * DAG build/validation failure codes. Every code is a HARD rejection: a DAG that
 * produces any of these never reaches the planner (cycles/incompatibilities are
 * rejected 100%, per the sprint acceptance bar).
 */
export type DagFailureCode =
  /** A node span's `sessionId` differs from `dag.sessionId` (single-session). */
  | "DAG_MIXED_SESSION"
  /** Two nodes share an ID. */
  | "DAG_DUPLICATE_ID"
  /** An edge names a node ID absent from the graph. */
  | "DAG_MISSING_ENDPOINT"
  /** A span is malformed (reversed/negative range) or a synthetic node has one. */
  | "DAG_INVALID_SPAN"
  /** Two spans overlap but pin DIFFERENT digests for the shared bytes. */
  | "DAG_SPAN_DIGEST_CONFLICT"
  /** A `precedes` edge points backward against source order. */
  | "DAG_REVERSED_PRECEDES"
  /** The dependency/ordering graph contains a cycle. */
  | "DAG_CYCLE"
  /** A tool-pair edge's endpoints are not both present/whole. */
  | "DAG_TOOL_PAIR_SPLIT"
  /** A node declares `incompatibleWith` naming a node absent from the graph. */
  | "DAG_UNKNOWN_INCOMPATIBLE";

/**
 * The validator verdict. `ok:true` carries the STABLE Kahn topological order —
 * the single authoritative sequence downstream consumers (VC5B) replay.
 */
export type DagValidation =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly codes: readonly DagFailureCode[] };

/**
 * Registered DAG conformance ID range (DAG-001..030). The acceptance aggregator
 * reads these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`.
 */
export const DAG_IDS: readonly string[] = Array.from(
  { length: 30 },
  (_v, i) => `DAG-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC5A DAG conformance assertion (the sprint's headline DAG row). */
export const DAG_NAMED_IDS = ["DAG-CYCLE-001"] as const;
