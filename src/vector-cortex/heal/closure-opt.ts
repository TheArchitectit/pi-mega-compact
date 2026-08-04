/**
 * vector-cortex/heal/closure-opt.ts — VC6A deterministic transitive reduction
 * over the ALREADY-MANDATORY VC4C closure.
 *
 * WHAT THIS DOES NOT DO: it does not close anything and it does not change which
 * nodes are selected. `closeSelection` (VC4C) has already run and produced the
 * mandatory set; CONTRACTS §plan and closure is explicit that "VC6 only
 * optimizes restoration/self-healing". This module takes that closed set and
 * shrinks the EDGE PLAN used to justify/re-walk it.
 *
 * THE REDUCTION. Requirements flow prerequisite `from` → dependent `to`, and
 * closure walks them BACKWARD (selecting `to` pulls in `from`). So the
 * requirement relation is `to ⇒ from`. If `c ⇒ b` and `b ⇒ a` are both in the
 * plan, then a third edge `c ⇒ a` adds nothing: walking `c` already reaches `a`
 * through `b`. That third edge is transitively implied and is the only kind of
 * edge this module removes.
 *
 * WHAT IS NEVER REMOVED (task 3):
 *   - a `tool-pair` edge          — the pair is atomic (PREVENT-PI-002);
 *   - any edge touching an anchor — the floor is preserved (PREVENT-PI-001);
 *   - a `contradicts` edge        — the resolver reads it directly, so removing
 *                                   it would change the resolved set;
 *   - a SOLE dependency edge      — the only edge pulling its prerequisite in.
 * Every considered edge — retained or removed — is recorded in the proof, so the
 * verifier can replay the decision rather than trust it.
 *
 * DETERMINISM. Vertices and edges are sorted by ID BYTES (the same bytewise
 * comparator `reconstruct/closure.ts` uses), the reachability search drains a
 * sorted worklist, and every emitted array is sorted. Two graphs that differ
 * only in input order produce byte-identical proofs.
 *
 * PURITY. No storage, no console, no clock, no network (PREVENT-PI-004 /
 * PREVENT-011). The FLAG DOES NOT GATE THIS ARITHMETIC: `MEGACOMPACT_VC6A=0`
 * gates the reporter + dashboard seam only (see `emit.ts`), exactly as
 * VC5B/VC5C do, so flag-off is byte-identical to the predecessor.
 */

import type { ClosureEdge, ClosureGraph, ClosureResult } from "../reconstruct/types.js";
import type { ClosureProofRow, ClosureProofV2, RetainReason } from "./types.js";

/** Bytewise id comparator — identical to `reconstruct/closure.ts::sortedIds`. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order over edges: `from`, then `to`, then `kind` — all bytewise. */
function compareEdges(x: ClosureEdge, y: ClosureEdge): number {
  return byBytes(x.from, y.from) || byBytes(x.to, y.to) || byBytes(x.kind, y.kind);
}

/** Sorted copy of an edge list (never mutates the caller's array). */
function sortedEdges(edges: readonly ClosureEdge[]): ClosureEdge[] {
  return [...edges].sort(compareEdges);
}

/**
 * The requirement adjacency of a plan: for a dependent node, which prerequisites
 * it pulls in. Mirrors `reconstruct/closure.ts::buildRequirements` — `depends`
 * walks backward to the prerequisite, `tool-pair` walks BOTH ways because a pair
 * is atomic. `contradicts` never pulls a node in and is therefore absent here
 * (it is still protected from removal; it simply is not a traversal edge).
 */
function requirementAdjacency(edges: readonly ClosureEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (key: string, value: string): void => {
    const list = adj.get(key);
    if (list === undefined) adj.set(key, [value]);
    else list.push(value);
  };
  for (const e of edges) {
    if (e.kind === "depends") add(e.to, e.from);
    else if (e.kind === "tool-pair") {
      add(e.to, e.from);
      add(e.from, e.to);
    }
  }
  for (const list of adj.values()) list.sort(byBytes);
  return adj;
}

/**
 * Is `target` reachable from `start` through the requirement adjacency WITHOUT
 * using the direct `start ⇒ target` hop? Returns the witnessing intermediate
 * vertex (the first hop of the detour, bytewise-smallest) or `null`.
 *
 * This is the "alternate path exists" test that licenses a removal. The direct
 * hop is excluded so an edge can never justify its own removal; a cycle simply
 * revisits `seen` and terminates.
 */
function alternatePathVia(
  adj: ReadonlyMap<string, string[]>,
  start: string,
  target: string,
): string | null {
  // First hops other than the direct one, in bytewise order so the witness is
  // deterministic when several detours exist.
  const firstHops = (adj.get(start) ?? []).filter((n) => n !== target);
  for (const hop of firstHops) {
    // Breadth-first from this hop; `seen` excludes `start` so a detour that
    // loops back through the origin cannot be counted as progress.
    const seen = new Set<string>([start]);
    const worklist: string[] = [hop];
    while (worklist.length > 0) {
      worklist.sort(byBytes);
      const current = worklist.shift();
      if (current === undefined) break;
      if (current === target) return hop;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adj.get(current) ?? []) {
        if (!seen.has(next)) worklist.push(next);
      }
    }
  }
  return null;
}

/**
 * Is `target` reachable from `start` using ONLY the edges in `others` (a path of
 * length >= 2, never the direct hop)? Returns the bytewise-smallest first-hop
 * vertex (the witness `via`) or `null`.
 *
 * The transitive-reduction correctness rule: an edge `start ⇒ target` is
 * redundant only if a length>=2 path exists through the OTHER edges. Crucially
 * we EXCLUDE the edge under consideration, so removing one edge never invalidates
 * the witness used to justify removing ANOTHER — a plain single-pass check over
 * the full adjacency over-removes (HEAL-PROTECT-002: a tool pair backs two
 * depends edges that would each look implied by the full graph but only survive
 * together).
 */
function alternatePathExcluding(
  others: readonly ClosureEdge[],
  start: string,
  target: string,
): string | null {
  const adj = requirementAdjacency(others);
  return alternatePathVia(adj, start, target);
}

/** The set of node ids marked as anchor-floor members in the graph. */
function anchorIds(graph: ClosureGraph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) if (n.anchor === true) out.add(n.id);
  return out;
}

/**
 * Count how many `depends` edges pull in each prerequisite. A prerequisite with
 * exactly one such edge has a SOLE dependency edge: removing it would drop the
 * prerequisite from the closure entirely, so it is protected regardless of any
 * alternate path.
 */
function dependsFanIn(edges: readonly ClosureEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== "depends") continue;
    counts.set(e.from, (counts.get(e.from) ?? 0) + 1);
  }
  return counts;
}

/**
 * Classify a NON-removable edge, or return `null` when the edge is an ordinary
 * `depends` edge that removal is at least allowed to consider.
 *
 * Order matters and is deliberate: the strongest structural guarantee is
 * reported first, so a tool-pair edge that also touches an anchor is recorded as
 * `tool-pair` and the proof reads as the reason a reviewer would give.
 */
function protectedReason(
  edge: ClosureEdge,
  anchors: ReadonlySet<string>,
  fanIn: ReadonlyMap<string, number>,
): RetainReason | null {
  if (edge.kind === "tool-pair") return "tool-pair";
  if (edge.kind === "contradicts") return "contradiction";
  if (anchors.has(edge.from) || anchors.has(edge.to)) return "anchor";
  if ((fanIn.get(edge.from) ?? 0) <= 1) return "sole-dependency";
  return null;
}

/** Input to one optimization run: the graph plus the conservative VC4C result. */
export interface ClosureOptInput {
  readonly graph: ClosureGraph;
  /** The ALREADY-COMPUTED conservative closure (VC4C `closeSelection`). */
  readonly conservative: ClosureResult;
}

/**
 * Optimize the already-mandatory closure by transitive reduction (task 2).
 *
 * Only edges INSIDE the closed selection are considered: an edge touching an
 * unselected node is not part of the traversal plan for this closure at all, so
 * it is neither retained nor removed — it is simply out of scope and produces no
 * proof row.
 *
 * `selected` is copied through UNCHANGED. That is the whole safety property: the
 * optimizer is allowed to make the plan cheaper, never to make it smaller.
 */
export function optimizeClosure(input: ClosureOptInput): ClosureProofV2 {
  const { graph, conservative } = input;
  const selected = new Set(conservative.selected);
  const anchors = anchorIds(graph);

  // Consider only in-selection edges, in deterministic bytewise order.
  const considered = sortedEdges(
    graph.edges.filter((e) => selected.has(e.from) && selected.has(e.to)),
  );
  const fanIn = dependsFanIn(considered);

  const rows: ClosureProofRow[] = [];
  const retained: ClosureEdge[] = [];
  const removed: ClosureEdge[] = [];

  for (const e of considered) {
    const guard = protectedReason(e, anchors, fanIn);
    if (guard !== null) {
      // Protected: retained unconditionally, EVEN WHEN an alternate path exists
      // (HEAL-PROTECT-002). The reason names the guarantee, not the topology.
      rows.push({ from: e.from, to: e.to, kind: e.kind, decision: "retained", reason: guard });
      retained.push(e);
      continue;
    }
    // Ordinary `depends` edge: removable iff the requirement it carries is
    // already carried by a longer path `to ⇒ via ⇒ ... ⇒ from` through the OTHER
    // edges (the edge under test is excluded so removals stay mutually valid).
    const others = considered.filter((o) => o !== e);
    const via = alternatePathExcluding(others, e.to, e.from);
    if (via === null) {
      rows.push({
        from: e.from,
        to: e.to,
        kind: e.kind,
        decision: "retained",
        reason: "no-alternate-path",
      });
      retained.push(e);
      continue;
    }
    rows.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      decision: "removed",
      reason: "transitively-implied",
      via,
    });
    removed.push(e);
  }

  return {
    schema: "closure-proof-v2",
    sessionId: graph.sessionId,
    selected: [...conservative.selected],
    retainedEdges: sortedEdges(retained),
    removedEdges: sortedEdges(removed),
    rows,
    conservativeTraversals: considered.length,
    optimizedTraversals: retained.length,
  };
}

// Metrics + VC6B handoff (traversal savings, RestoreHintV1) live in the
// delegate-shell sibling `closure-metrics.ts` to keep this core reduction
// algorithm under the 300-line soft limit.
export { traversalSavings, restoreHints } from "./closure-metrics.js";
