/**
 * vector-cortex/vc3b-support.ts — VC3B acceptance test support (mode-B reference
 * scan + shared helper producers).
 *
 * Exact-algorithm sibling to the acceptance aggregator (vc3b-acceptance.test.ts).
 * Splitting the mode-B linear VectorSet scan into its own file keeps the
 * aggregator under its headroom limits (Q03) while preserving the forced-triad
 * A/B digest agreement check: build.ts is mode A (multi-head index), this
 * linear scan is mode B (same thresholds/cap/encoding), and they must agree on
 * the graph digest for the same eligible candidate set.
 *
 * The scan mirrors build.ts semantics deliberately — including keeping the
 * MAXIMUM score across a collapsed relation (contradiction pair or duplicate
 * directed edge) so a real calibrated-threshold builder and the reference scan
 * agree even when duplicate candidates carry different scores (Q01).
 *
 * Test-support only: no production code imports this module, no console, no
 * network (PREVENT-PI-004), no `any` (PREVENT-011).
 */
import { graphDigest, TOP_K } from "./topology/index.js";
import type { TopologyCandidate, TopologyEdgeV1, TopologyInput } from "./topology/index.js";

/** Shared candidate-rows producer used by several acceptance tests. */
export type CandidateRow = [
  source: string,
  target: string,
  head: string,
  score: number,
  kind: "dependency" | "contradiction",
];

export function candidates(rows: readonly CandidateRow[]): TopologyCandidate[] {
  return rows.map(([source, target, head, score, kind]) => ({
    source,
    target,
    head,
    score,
    kind,
  }));
}

interface ReferenceGraph {
  nodes: { id: string; kind: string }[];
  edges: readonly TopologyEdgeV1[];
  digest: string;
}

/**
 * Reference mode-B linear VectorSet scan: same calibrated threshold and cap as
 * THE documented builder. For each (source, head) it scans ALL records, keeps
 * those strictly above threshold, sorts by score descending then target bytes,
 * keeps the top-k, and encodes dependency/contradiction directions. It is a
 * separate linear implementation from build.ts's grouped byGroup path, so the
 * two independent implementations must agree on the digest.
 */
export function linearScan(input: TopologyInput): ReferenceGraph {
  const groups = new Map<string, TopologyCandidate[]>();
  for (const c of input.candidates) {
    if (!Number.isFinite(c.score)) continue;
    if (c.source === c.target) continue;
    if (c.score <= input.threshold) continue;
    const key = `${c.source}::${c.head}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const selected: TopologyCandidate[] = [];
  for (const g of groups.values()) {
    g.sort((x, y) => (x.score !== y.score ? (x.score > y.score ? -1 : 1) : x.target < y.target ? -1 : x.target > y.target ? 1 : 0));
    for (let i = 0; i < Math.min(g.length, TOP_K); i++) selected.push(g[i]);
  }
  // Sort score DESCENDING first so dedup keeps the MAXIMUM score per collapsed
  // relation, mirroring build.ts (Q01). Score ties fall through to bytewise
  // source/target/head/kind keys — INCLUDING `kind` as the final tie-break — so
  // the total order is exactly compareSelected in build.ts (mode A). Without the
  // `kind` tie-break, two equal-(score,source,target,head) candidates of
  // differing kind would fall back to stable input order, which depends on input
  // ordering: the deterministic last-writer for a node's kind (and hence the
  // graph digest) would diverge from mode A whenever such a pair produces the
  // node-kind map entry. Adding `kind` keeps mode B reference-faithful to mode A
  // (Q01: 'contradiction' sorts before 'dependency', bytewise).
  selected.sort((x, y) =>
    x.score !== y.score ? (x.score > y.score ? -1 : 1) :
    x.source < y.source ? -1 : x.source > y.source ? 1 :
    x.target < y.target ? -1 : x.target > y.target ? 1 :
    x.head < y.head ? -1 : x.head > y.head ? 1 :
    x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0,
  );
  const nodes = new Map<string, "dependency" | "contradiction">();
  const edges: TopologyEdgeV1[] = [];
  const seen = new Set<string>();
  for (const c of selected) {
    const kind = c.kind === "contradiction" ? "contradiction" : "dependency";
    nodes.set(c.source, kind);
    nodes.set(c.target, kind);
    if (c.kind === "contradiction") {
      const fwd = `${c.source}::${c.target}`;
      const rev = `${c.target}::${c.source}`;
      if (!seen.has(fwd) && !seen.has(rev)) {
        seen.add(fwd); seen.add(rev);
        edges.push({ source: c.source, target: c.target, head: c.head, score: c.score, direction: "contradiction" });
        edges.push({ source: c.target, target: c.source, head: c.head, score: c.score, direction: "contradiction" });
      }
      continue;
    }
    const depKey = `${c.source}::${c.target}::${c.head}::dependency`;
    if (!seen.has(depKey)) {
      seen.add(depKey);
      edges.push({ source: c.source, target: c.target, head: c.head, score: c.score, direction: "dependency" });
    }
  }
  const nodeList = [...nodes.entries()]
    .map(([id, kind]) => ({ id, kind }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const edgeList = [...edges].sort((x, y) =>
    x.source < y.source ? -1 : x.source > y.source ? 1 :
    x.target < y.target ? -1 : x.target > y.target ? 1 :
    x.head < y.head ? -1 : x.head > y.head ? 1 :
    x.direction < y.direction ? -1 : x.direction > y.direction ? 1 :
    x.score < y.score ? -1 : x.score > y.score ? 1 : 0,
  );
  const digest = graphDigest({
    schema: "topology-v1",
    sessionId: input.sessionId,
    sourceHighWater: input.sourceHighWater,
    threshold: input.threshold,
    nodeCount: nodeList.length,
    edgeCount: edgeList.length,
    generationDigest: "",
    nodes: nodeList,
    edges: edgeList,
  });
  return { nodes: nodeList, edges: edgeList, digest };
}
