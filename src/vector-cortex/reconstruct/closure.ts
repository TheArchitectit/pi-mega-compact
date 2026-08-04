/**
 * vector-cortex/reconstruct/closure.ts — mandatory conservative closure (VC4C).
 *
 * Task 2/3: a WORKLIST recursion that repeatedly adds every `depends`
 * predecessor and every whole tool pair of an already-selected node until the
 * selection stops growing (a FIXED POINT), tracking visited ids so a cyclic
 * graph terminates instead of recursing forever. Task 3: contradictions are
 * resolved by retaining the LATER exact source resolution; an explicit
 * resolution event may name the loser directly; equal/unordered resolutions are
 * an unresolved tie and return `CLO_CONTRADICTION_UNRESOLVED` so the candidate
 * never goes live (CONTRACTS §plan and closure).
 *
 * Determinism: the worklist is drained in sorted id order and every returned
 * array is sorted, so the closed set is identical regardless of the order seeds
 * or edges were supplied in. Time is never read here — contradiction ordering
 * uses the SOURCE `resolvedAtMs` fact carried on the node.
 *
 * OWNERSHIP: `mandatoryTokenEstimate` is CONTENT ONLY (no prompt framing) and is
 * handed unchanged to VC5A, which owns framing + budget admission and returns
 * `MANDATORY_CLOSURE_OVER_BUDGET` on overflow. Closure NEVER truncates a
 * mandatory node.
 *
 * Pure/deterministic: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

import type {
  ClosureEdge,
  ClosureFailureCode,
  ClosureGraph,
  ClosureNode,
  ClosureProofStep,
  ClosureResult,
} from "./types.js";

/** Sorted copy (bytewise id order) — every closure output is order-stable. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Index the graph's nodes by id (last wins is impossible — ids are unique). */
function indexNodes(graph: ClosureGraph): Map<string, ClosureNode> {
  const byId = new Map<string, ClosureNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  return byId;
}

/**
 * Build the "requirement" adjacency: for a selected node `x`, which nodes must
 * ALSO be selected. Edges point prerequisite `from` → dependent `to`, so:
 *
 *   - `depends`   — selecting `to` requires `from` (walk BACKWARD to the
 *                   prerequisite; this is the transitive dependency closure);
 *   - `tool-pair` — the pair is atomic, so selecting EITHER endpoint requires
 *                   the other (walk BOTH directions — a pair is never split,
 *                   PREVENT-PI-002).
 *
 * `contradicts` is deliberately absent: a contradiction never PULLS a node in,
 * it removes one (resolved separately below).
 */
function buildRequirements(
  edges: readonly ClosureEdge[],
): Map<string, Array<{ id: string; rule: "depends" | "tool-pair" }>> {
  const req = new Map<string, Array<{ id: string; rule: "depends" | "tool-pair" }>>();
  const add = (key: string, id: string, rule: "depends" | "tool-pair"): void => {
    const list = req.get(key);
    if (list === undefined) req.set(key, [{ id, rule }]);
    else list.push({ id, rule });
  };
  for (const e of edges) {
    if (e.kind === "depends") {
      add(e.to, e.from, "depends");
      continue;
    }
    if (e.kind === "tool-pair") {
      add(e.to, e.from, "tool-pair");
      add(e.from, e.to, "tool-pair");
    }
  }
  return req;
}

/**
 * Resolve one contradiction pair. Returns the loser id, or `null` when the pair
 * is an unresolved tie.
 *
 * Precedence (CONTRACTS §plan and closure):
 *   1. An explicit resolution event naming the loser wins outright.
 *   2. Otherwise the LATER exact source resolution supersedes the earlier claim.
 *      "Exact" is required: a semantic node never supersedes an exact one, since
 *      semantic vectors never claim to recover exact text (RESIDUAL_CODEC).
 *   3. Equal timestamps, missing timestamps, or two non-exact claims are
 *      UNORDERED — keep both and reject live use.
 */
function resolveContradiction(
  a: ClosureNode,
  b: ClosureNode,
  explicit: ReadonlyMap<string, string>,
): string | null {
  // 1. Explicit resolution event names the loser directly.
  const aLoses = explicit.get(a.id);
  if (aLoses === b.id) return a.id;
  const bLoses = explicit.get(b.id);
  if (bLoses === a.id) return b.id;

  // 2. Later EXACT source resolution supersedes the earlier claim. Both sides
  //    must be exact and both must carry a source resolution time.
  const aExact = a.kind === "exact";
  const bExact = b.kind === "exact";
  const aAt = a.resolvedAtMs;
  const bAt = b.resolvedAtMs;
  if (aExact && bExact && aAt !== undefined && bAt !== undefined && aAt !== bAt) {
    return aAt < bAt ? a.id : b.id;
  }

  // 3. Equal / unordered / non-exact — unresolved tie.
  return null;
}

/** Seeds for a closure run: the explicitly requested node ids. */
export interface ClosureInput {
  readonly graph: ClosureGraph;
  /** The initially requested node ids (the selection to close over). */
  readonly seeds: readonly string[];
}

/**
 * Close a selection conservatively to a fixed point (task 2 + 3).
 *
 * Algorithm: seed the worklist with the requested ids (plus the anchor floor,
 * which is always mandatory), then repeatedly pop the smallest id and add every
 * node it requires. A `visited` set makes each node expand exactly once, so a
 * cycle (`a depends b`, `b depends a`) terminates at the fixed point rather than
 * recursing forever. Contradictions among the CLOSED set are then resolved; an
 * unresolved tie fails the closure.
 */
export function closeSelection(input: ClosureInput): ClosureResult {
  const { graph, seeds } = input;
  const byId = indexNodes(graph);
  const failures: ClosureFailureCode[] = [];

  // Structural validation: every edge endpoint and every seed must exist.
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      if (!failures.includes("CLO_MISSING_NODE")) failures.push("CLO_MISSING_NODE");
    }
  }
  for (const s of seeds) {
    if (!byId.has(s)) {
      if (!failures.includes("CLO_UNKNOWN_SEED")) failures.push("CLO_UNKNOWN_SEED");
    }
  }
  if (failures.length > 0) {
    return {
      ok: false,
      selected: [],
      addedDependencies: [],
      removedContradictions: [],
      unresolved: [],
      proof: [],
      failures,
      mandatoryTokenEstimate: 0,
    };
  }

  const requirements = buildRequirements(graph.edges);
  const selected = new Set<string>();
  const proof: ClosureProofStep[] = [];
  const seedSet = new Set(seeds);

  // The anchor floor is ALWAYS mandatory: an anchor is never dropped by closure
  // (PREVENT-PI-001's anchor-floor discipline restated for the closed prompt).
  const anchorIds = graph.nodes.filter((n) => n.anchor === true).map((n) => n.id);

  // Seed the worklist deterministically (sorted), anchors after explicit seeds
  // so the proof reads "what was asked for, then what the floor forced".
  const worklist: string[] = [];
  for (const id of sortedIds(seedSet)) {
    if (selected.has(id)) continue;
    selected.add(id);
    proof.push({ added: id, rule: "seed" });
    worklist.push(id);
  }
  for (const id of sortedIds(anchorIds)) {
    if (selected.has(id)) continue;
    selected.add(id);
    proof.push({ added: id, rule: "anchor-floor" });
    worklist.push(id);
  }

  // ── Worklist recursion to a FIXED POINT (visited = `selected`) ─────────────
  // Each id is expanded at most once because it can only enter the worklist at
  // the moment it is inserted into `selected`. A cyclic graph therefore
  // terminates: the second traversal of the cycle finds every node already
  // selected and adds nothing.
  while (worklist.length > 0) {
    // Drain in sorted order so the proof is deterministic across input orders.
    worklist.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const current = worklist.shift();
    if (current === undefined) break;
    const required = requirements.get(current) ?? [];
    // Sort the requirements of one node so sibling additions are ordered too.
    const ordered = [...required].sort((x, y) =>
      x.id < y.id ? -1 : x.id > y.id ? 1 : x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0,
    );
    for (const { id, rule } of ordered) {
      if (selected.has(id)) continue; // already at the fixed point for this node
      selected.add(id);
      proof.push({ added: id, requiredBy: current, rule });
      worklist.push(id);
    }
  }

  // ── Contradiction resolution over the CLOSED set (task 3) ─────────────────
  const explicit = new Map<string, string>();
  for (const r of graph.resolutions ?? []) explicit.set(r.loserId, r.winnerId);

  const removed = new Set<string>();
  const unresolved = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== "contradicts") continue;
    // Only contradictions BETWEEN TWO SELECTED nodes matter: an unselected claim
    // cannot contradict the prompt that is actually being built.
    if (!selected.has(e.from) || !selected.has(e.to)) continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a === undefined || b === undefined) continue;
    // A pair already decided by an earlier edge (duplicate contradiction) is
    // skipped so one resolution is not re-litigated into a false tie.
    if (removed.has(a.id) || removed.has(b.id)) continue;
    const loser = resolveContradiction(a, b, explicit);
    if (loser === null) {
      unresolved.add(a.id);
      unresolved.add(b.id);
      continue;
    }
    removed.add(loser);
  }

  // A node that lost a contradiction leaves the selection. An unresolved tie
  // keeps BOTH (CONTRACTS: "ties keep both and reject live use") and fails.
  for (const id of removed) selected.delete(id);

  const selectedIds = sortedIds(selected);
  const addedDependencies = selectedIds.filter((id) => !seedSet.has(id));
  const mandatoryTokenEstimate = selectedIds.reduce(
    (sum, id) => sum + (byId.get(id)?.tokenEstimate ?? 0),
    0,
  );

  const ok = unresolved.size === 0;
  return {
    ok,
    selected: selectedIds,
    addedDependencies,
    removedContradictions: sortedIds(removed),
    unresolved: sortedIds(unresolved),
    proof,
    failures: ok ? [] : ["CLO_CONTRADICTION_UNRESOLVED"],
    mandatoryTokenEstimate,
  };
}

/**
 * Whether a closure result is a genuine fixed point: re-running the closure over
 * its own output adds nothing. Used by the acceptance invariant ("closure reaches
 * a fixed point") — an independent CHECK rather than a restatement of the loop.
 */
export function isFixedPoint(graph: ClosureGraph, result: ClosureResult): boolean {
  if (!result.ok) return true; // a rejected closure is not required to be closed
  const again = closeSelection({ graph, seeds: result.selected });
  if (!again.ok) return false;
  return (
    again.selected.length === result.selected.length &&
    again.selected.every((id, i) => id === result.selected[i])
  );
}

/**
 * Mode B: a GREEDY EXACT-ONLY closure, forced when semantic validation fails.
 * Independent of mode A by construction — it consults no semantic node and no
 * semantic index, deriving purely from the exact/event source tiers
 * (TRIAD_RESILIENCE: A/B must not share the same algorithm or index).
 */
export function closeExactOnly(input: ClosureInput): ClosureResult {
  const exactGraph: ClosureGraph = {
    sessionId: input.graph.sessionId,
    nodes: input.graph.nodes.filter((n) => n.kind !== "semantic"),
    edges: input.graph.edges.filter((e) => {
      const kinds = new Map(input.graph.nodes.map((n) => [n.id, n.kind]));
      return kinds.get(e.from) !== "semantic" && kinds.get(e.to) !== "semantic";
    }),
    resolutions: input.graph.resolutions,
  };
  const seeds = input.seeds.filter((id) =>
    exactGraph.nodes.some((n) => n.id === id),
  );
  return closeSelection({ graph: exactGraph, seeds });
}
