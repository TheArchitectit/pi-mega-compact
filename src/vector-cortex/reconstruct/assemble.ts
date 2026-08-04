/**
 * vector-cortex/reconstruct/assemble.ts — source-order assembly (VC4C).
 *
 * Task 4: given a CLOSED + VALIDATED selection, decode the relevant shards,
 * insert protected exact bytes unchanged, then lay the spans out SOLELY by their
 * source range (`ShardRange`) before concatenation — never by closure order,
 * which carries no positional meaning. The deterministic content-only
 * `mandatoryTokenEstimate` from the closure is carried through UNCHANGED to VC5A
 * (VC5A owns framing + budget admission).
 *
 * OWNERSHIP BOUNDARY (CONTRACTS plan + TRIAD_RESILIENCE): assemble produces the
 * raw, ordered, content-only reconstruction. It does NOT frame it, does NOT
 * admit against a budget, and NEVER truncates a mandatory node. Any byte/order
 * error produces a hard rejection (REC_SPAN_OVERLAP / REC_TOOL_PAIR_SPLIT)
 * because a corrupted layout must never reach a live prompt.
 *
 * Determinism: sorting is bytewise on (sessionId, seqStart, byteStart). The
 * output digest is over the CONCATENATED BYTES so any reorder is itself detected
 * downstream (RESIDUAL_CODEC admission parity).
 *
 * Pure/deterministic: no storage, no console, no network.
 */

import type { ShardRange } from "../shards/types.js";
import type {
  ClosureEdge,
  ClosureNode,
  ReconstructionFailureCode,
  ReconstructionSpan,
  ReconstructionV1,
} from "./types.js";

/** A decode result the caller supplies; assemble stays secret-free about format. */
export interface DecodedShard {
  readonly nodeId: string;
  readonly range: ShardRange;
  readonly bytes: Uint8Array;
  readonly source: "exact" | "residual" | "semantic";
  readonly digest: string;
  readonly protectedSpan: boolean;
}

/** SHA-256 hex of an arbitrary byte array (Web Crypto; no network, no deps). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const out = new Uint8Array(digest);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable source-order comparator: (sessionId, seqStart, byteStart). */
function bySourceOrder(a: { range: ShardRange }, b: { range: ShardRange }): number {
  if (a.range.sessionId !== b.range.sessionId) {
    return a.range.sessionId < b.range.sessionId ? -1 : 1;
  }
  if (a.range.seqStart !== b.range.seqStart) {
    return a.range.seqStart < b.range.seqStart ? -1 : 1;
  }
  return a.range.byteStart - b.range.byteStart;
}

/**
 * Detect a hard layout failure BEFORE concatenation:
 *   - REC_SPAN_OVERLAP: two spans intersect in the source byte space.
 *   - REC_TOOL_PAIR_SPLIT: a node bound by a tool-pair edge must be adjacent to
 *     its partner (end of one == start of the other) in source order
 *     (PREVENT-PI-002 restated at assembly time — a toolCall/toolResult pair is
 *     never split across a gap).
 * Returns the first failure code found, or null when the layout is clean.
 */
function detectLayoutFailure(
  spans: readonly ReconstructionSpan[],
  nodes: readonly ClosureNode[],
  edges: readonly ClosureEdge[],
): ReconstructionFailureCode | null {
  const ordered = [...spans].sort(bySourceOrder);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].range;
    const cur = ordered[i].range;
    const prevEnd = prev.byteEnd; // half-open: [byteStart, byteEnd)
    if (cur.byteStart < prevEnd) return "REC_SPAN_OVERLAP";
  }

  // Tool-pair adjacency: every tool-pair edge names two partners that must be
  // immediately adjacent in source order. We check each edge once.
  const rangeById = new Map(spans.map((s) => [s.nodeId, s.range] as const));
  const inOrder = new Map(ordered.map((s) => [s.nodeId, s.range] as const));
  const seenEdges = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "tool-pair") continue;
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    // Both endpoints must be present in the selection to be a split concern.
    const a = rangeById.get(e.from);
    const b = rangeById.get(e.to);
    if (a === undefined || b === undefined) continue;
    const aEnd = a.byteEnd;
    const bEnd = b.byteEnd;
    const adjacent = aEnd === b.byteStart || bEnd === a.byteStart;
    if (!adjacent) return "REC_TOOL_PAIR_SPLIT";
  }
  // `nodes` kept in the signature for call symmetry with the composed validator;
  // it is the authoritative kind source but not needed for these two checks.
  void nodes;
  void inOrder;
  return null;
}

/**
 * Assemble a closed+validated selection into source order (task 4).
 *
 * `shards` must be EXACTLY one `DecodedShard` per node id in `selected` — the
 * caller (validate.ts) guarantees availability. A missing shard is therefore a
 * programming error surfaced as REC_SOURCE_UNAVAILABLE, never a silent gap.
 */
export async function assembleSourceOrder(args: {
  readonly sessionId: string;
  readonly selected: readonly string[];
  readonly nodes: readonly ClosureNode[];
  readonly edges: readonly ClosureEdge[];
  readonly shards: readonly DecodedShard[];
  readonly mandatoryTokenEstimate: number;
}): Promise<{ readonly reconstruction: ReconstructionV1 | null; readonly code: ReconstructionFailureCode | null }> {
  const { sessionId, selected, nodes, edges, mandatoryTokenEstimate } = args;
  const shardById = new Map(args.shards.map((s) => [s.nodeId, s] as const));

  // Every selected node MUST have a decoded shard; a missing one is the unique
  // failure-injection path (erase a dependency shard -> REC_SOURCE_UNAVAILABLE).
  for (const id of selected) {
    if (!shardById.has(id)) return { reconstruction: null, code: "REC_SOURCE_UNAVAILABLE" };
  }

  const spans: ReconstructionSpan[] = selected.map((id) => {
    const s = shardById.get(id)!;
    return {
      nodeId: s.nodeId,
      range: s.range,
      source: s.source,
      bytes: s.bytes,
      digest: s.digest,
      protectedSpan: s.protectedSpan,
    };
  });

  const layoutFailure = detectLayoutFailure(spans, nodes, edges);
  if (layoutFailure !== null) return { reconstruction: null, code: layoutFailure };

  const ordered = [...spans].sort(bySourceOrder);
  const byteTotal = ordered.reduce((sum, s) => sum + s.bytes.length, 0);
  const concatenated = new Uint8Array(byteTotal);
  let offset = 0;
  for (const s of ordered) {
    concatenated.set(s.bytes, offset);
    offset += s.bytes.length;
  }
  const digest = await sha256Hex(concatenated);

  return {
    reconstruction: {
      schema: "reconstruction-v1",
      sessionId,
      spans: ordered,
      digest,
      byteTotal,
      mandatoryTokenEstimate,
    },
    code: null,
  };
}
