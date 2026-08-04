/**
 * vector-cortex/prompt-dag/builder.ts — single-session PromptDagV1 construction
 * (VC5A, task 2).
 *
 * The builder is the STRUCTURAL gate: it rejects a graph that could never be
 * planned safely, before any ordering or selection is attempted. Rejections are
 * hard and total (the sprint bar: "cycles/incompatibilities rejected 100%"):
 *
 *   - `DAG_MIXED_SESSION`        — a span whose sessionId differs from the DAG's.
 *                                  Cross-session evidence MUST be a synthetic
 *                                  node citing a separately validated manifest,
 *                                  never a foreign span (CONTRACTS §PromptDagV1).
 *   - `DAG_DUPLICATE_ID`         — two nodes sharing an id.
 *   - `DAG_MISSING_ENDPOINT`     — an edge naming an absent node.
 *   - `DAG_INVALID_SPAN`         — reversed/negative range, or a synthetic node
 *                                  carrying a span (synthetics have no source
 *                                  position by definition).
 *   - `DAG_SPAN_DIGEST_CONFLICT` — two overlapping spans pinning DIFFERENT
 *                                  digests for the same bytes: a corrupted or
 *                                  forged source claim, not a legal overlap.
 *   - `DAG_UNKNOWN_INCOMPATIBLE` — `incompatibleWith` naming an absent node.
 *   - `DAG_TOOL_PAIR_SPLIT`      — a tool-pair edge whose endpoints are not both
 *                                  present (PREVENT-PI-002).
 *
 * Cycle and reversed-`precedes` detection belong to the VALIDATOR, which owns
 * the topological order; the builder only guarantees the graph is structurally
 * well-formed and single-session.
 *
 * Determinism: nodes and edges are emitted in a canonical sorted order so the
 * same inputs always produce byte-identical DAG bytes, whatever order the caller
 * supplied them in. Pure: no storage, no console, no network (PREVENT-PI-004).
 */

import type {
  DagEdge,
  DagFailureCode,
  DagNode,
  DagSpan,
  PromptDagV1,
} from "./types.js";

/** Bytewise string comparison — the universal deterministic tie-break. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical node order: source position first (`startSeq`, then `startByte`),
 * synthetics last (they have no span), then `syntheticOrdinal`, then id bytes.
 * This mirrors the validator's queue key so the emitted DAG and its topological
 * order agree on what "earlier" means.
 */
export function compareNodes(a: DagNode, b: DagNode): number {
  const aSeq = a.span?.startSeq;
  const bSeq = b.span?.startSeq;
  if (aSeq !== undefined && bSeq !== undefined) {
    if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  } else if (aSeq !== undefined) {
    return -1; // spanned nodes precede synthetics
  } else if (bSeq !== undefined) {
    return 1;
  }
  // Contract key: (startSeq, syntheticOrdinal, id bytes) — byte offset is NOT a
  // tie-break, so the emitted DAG and its topological order agree exactly.
  const aOrd = a.syntheticOrdinal ?? 0;
  const bOrd = b.syntheticOrdinal ?? 0;
  if (aOrd !== bOrd) return aOrd < bOrd ? -1 : 1;
  return byBytes(a.id, b.id);
}

/** Canonical edge order: from, then to, then kind — a total order. */
export function compareEdges(a: DagEdge, b: DagEdge): number {
  const f = byBytes(a.from, b.from);
  if (f !== 0) return f;
  const t = byBytes(a.to, b.to);
  if (t !== 0) return t;
  return byBytes(a.kind, b.kind);
}

/** Whether two half-open byte ranges in the same session intersect. */
function spansOverlap(a: DagSpan, b: DagSpan): boolean {
  if (a.sessionId !== b.sessionId) return false;
  return a.startByte < b.endByte && b.startByte < a.endByte;
}

/** A span is well-formed when both its seq and byte ranges are non-decreasing. */
function spanIsValid(span: DagSpan): boolean {
  if (span.startSeq > span.endSeq) return false;
  if (span.startByte < 0 || span.endByte < 0) return false;
  return span.startByte <= span.endByte;
}

/** Push a failure code once (codes are a SET, reported in discovery order). */
function pushCode(codes: DagFailureCode[], code: DagFailureCode): void {
  if (!codes.includes(code)) codes.push(code);
}

/** The inputs a DAG is built from. */
export interface DagBuildInput {
  readonly sessionId: string;
  /** The durable contiguous authority high-water this DAG is built against. */
  readonly sourceHighWater: bigint;
  readonly nodes: readonly DagNode[];
  readonly edges: readonly DagEdge[];
}

/** Build outcome: the canonical DAG, or the exact structural failure codes. */
export type DagBuildResult =
  | { readonly ok: true; readonly dag: PromptDagV1 }
  | { readonly ok: false; readonly codes: readonly DagFailureCode[] };

/**
 * Build a canonical single-session `PromptDagV1`, or reject with the exact
 * structural failure codes (task 2).
 *
 * Every check runs before returning so a caller sees ALL structural problems at
 * once rather than fixing them one round-trip at a time; the codes array is
 * deduplicated and ordered by discovery.
 */
export function buildPromptDag(input: DagBuildInput): DagBuildResult {
  const codes: DagFailureCode[] = [];

  // ── Node identity + span validity + single-session enforcement ─────────────
  const byId = new Map<string, DagNode>();
  for (const n of input.nodes) {
    if (byId.has(n.id)) pushCode(codes, "DAG_DUPLICATE_ID");
    else byId.set(n.id, n);

    if (n.kind === "synthetic") {
      // A synthetic node has no source position by definition; carrying a span
      // would make its ordering ambiguous against real source nodes.
      if (n.span !== undefined) pushCode(codes, "DAG_INVALID_SPAN");
      continue;
    }
    if (n.span === undefined) continue; // a spanless non-synthetic orders last
    if (!spanIsValid(n.span)) pushCode(codes, "DAG_INVALID_SPAN");
    // Single-session: cross-session evidence must be a synthetic citation.
    if (n.span.sessionId !== input.sessionId) pushCode(codes, "DAG_MIXED_SESSION");
  }

  // ── Overlapping spans must agree on the digest of the shared bytes ─────────
  const spanned = input.nodes.filter(
    (n): n is DagNode & { span: DagSpan } => n.span !== undefined,
  );
  for (let i = 0; i < spanned.length; i++) {
    for (let j = i + 1; j < spanned.length; j++) {
      const a = spanned[i]!;
      const b = spanned[j]!;
      if (!spansOverlap(a.span, b.span)) continue;
      if (a.span.digest !== b.span.digest) {
        pushCode(codes, "DAG_SPAN_DIGEST_CONFLICT");
      }
    }
  }

  // ── Incompatibility targets must exist ────────────────────────────────────
  for (const n of input.nodes) {
    for (const other of n.incompatibleWith) {
      if (!byId.has(other)) pushCode(codes, "DAG_UNKNOWN_INCOMPATIBLE");
    }
  }

  // ── Edge endpoints must exist; tool pairs must be whole ───────────────────
  for (const e of input.edges) {
    const hasFrom = byId.has(e.from);
    const hasTo = byId.has(e.to);
    if (!hasFrom || !hasTo) {
      pushCode(codes, "DAG_MISSING_ENDPOINT");
      // A tool pair missing an endpoint is ALSO a split pair (PREVENT-PI-002):
      // the atomic unit cannot be represented, let alone selected whole.
      if (e.kind === "tool-pair") pushCode(codes, "DAG_TOOL_PAIR_SPLIT");
    }
  }

  if (codes.length > 0) return { ok: false, codes };

  const nodes = [...input.nodes].sort(compareNodes);
  const edges = [...input.edges].sort(compareEdges);
  return {
    ok: true,
    dag: {
      schema: "prompt-dag-v1",
      sessionId: input.sessionId,
      sourceHighWater: input.sourceHighWater,
      nodes,
      edges,
    },
  };
}
