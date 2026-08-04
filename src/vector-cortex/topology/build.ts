/**
 * vector-cortex/topology/build.ts — deterministic cortical topology builder (VC3B).
 *
 * Implements the deterministic graph construction (tasks 2–4):
 *   - For each (source, head) retain only candidates whose score is strictly
 *     above the calibrated threshold.
 *   - Stable-sort winning candidates by score DESCENDING, then by unsigned
 *     target-ID bytes ASCENDING (TOP-TIE-002 — equal scores sort by target ID).
 *   - Cap each (source, head) at top-k=16; the seventeenth eligible neighbor is
 *     excluded (TOP-K-001).
 *   - Remove self edges (source === target); reject them as TOP_SELF_EDGE.
 *   - Reject non-finite scores as TOP_SCORE_NONFINITE — a single bad head's NaN
 *     rejects only its own edge and never poisons other heads.
 *   - Encode dependency edges as single directed records; contradiction edges as
 *     symmetric PAIRED records (source→target and target→source) (TOP-KIND-003).
 *
 * This is the mode-A producer in the sprint triad: a multi-head topology index.
 * The other two modes (B linear VectorSet scan, C source-seq/keyword) must yield
 * the same threshold/tie/cap invariants and the same graph digest. Pure
 * deterministic function — no I/O, no console, no network (PREVENT-PI-004),
 * no `any` (PREVENT-011).
 */
import {
  TOP_K,
  type TopologyBuildResult,
  type TopologyCandidate,
  type TopologyEdgeV1,
  type TopologyInput,
  type TopologyNodeV1,
  type TopologyRejection,
  type TopologyV1,
} from "./types.js";

/**
 * Build the deterministic topology graph from calibrated-threshold candidates.
 * Order-independent across any permutation of `input.candidates`.
 */
export function buildTopology(input: TopologyInput): TopologyBuildResult {
  const { sessionId, sourceHighWater, threshold } = input;

  // Group winning candidates by (source, head), stable-sorting each group by
  // score desc then unsigned target-ID bytes, capping at top-k.
  const byGroup = new Map<string, TopologyCandidate[]>();
  const rejections: TopologyRejection[] = [];

  for (const c of input.candidates) {
    // Non-finite score: reject this candidate in isolation (never poison others).
    if (!Number.isFinite(c.score)) {
      rejections.push(reject(c, "TOP_SCORE_NONFINITE"));
      continue;
    }
    if (c.source === c.target) {
      rejections.push(reject(c, "TOP_SELF_EDGE"));
      continue;
    }
    if (c.score <= threshold) continue; // below calibrated threshold
    const key = groupKey(c.source, c.head);
    const group = byGroup.get(key);
    if (group) group.push(c);
    else byGroup.set(key, [c]);
  }

  // Stable sort each (source, head) group: score desc, then unsigned target-ID
  // bytes asc. Keep exactly the top-k=16 (the 17th eligible neighbor is excluded).
  const selected: TopologyCandidate[] = [];
  for (const group of byGroup.values()) {
    group.sort(compareCandidates);
    for (let i = 0; i < Math.min(group.length, TOP_K); i++) {
      selected.push(group[i]);
    }
  }

  // Encode dependency edges as directed records; contradiction edges as
  // symmetric PAIRED records. Duplicate (source,target,head) contradictions
  // collapse: the same symmetric pair is emitted once per direction — dedupe to
  // keep the paired graph well-formed and the digest stable.
  //
  // IMPORTANT: `selected` is first ordered by a canonical global comparator so
  // every dedup decision (which head represents a collapsed contradiction pair,
  // which identical directed edge is kept) is deterministic and INDEPENDENT of
  // the incoming candidate order. Without this, reversing the input order could
  // flip which head represents a symmetric pair and change the digest.
  //
  // The comparator sorts by SCORE DESCENDING FIRST, so first-writer-wins dedup
  // keeps the MAXIMUM score per collapsed relation. Two candidates emitting the
  // same directed edge (same source,target,head) with different scores keep the
  // higher one; a contradiction pair a↔b with different scores is claimed by the
  // higher-scoring candidate regardless of which end is "source". A downstream
  // consumer (VC3C receives TopologyV1) therefore gets the strongest score for a
  // collapsed relation, never the weakest, and the winner is decided by score —
  // not by source-ID byte order. (Score ties fall through to bytewise keys so
  // the total order stays deterministic.)
  selected.sort(compareSelected);
  const edges: Map<string, TopologyEdgeV1> = new Map();
  const nodes = new Map<string, TopologyNodeKind>();
  for (const c of selected) {
    nodes.set(c.source, nodeKind(c));
    nodes.set(c.target, nodeKind(c));
    if (c.kind === "contradiction") {
      // Symmetric pair: emit source→target and target→source exactly once, keyed
      // so that a reversed duplicate from another candidate collapses to one pair.
      const fwd = pairKey(c.source, c.target);
      const rev = pairKey(c.target, c.source);
      const hasFwd = edges.has(fwd) || edges.has(rev);
      if (!hasFwd) {
        edges.set(fwd, { source: c.source, target: c.target, head: c.head, score: c.score, direction: "contradiction" });
        edges.set(rev, { source: c.target, target: c.source, head: c.head, score: c.score, direction: "contradiction" });
      }
      continue;
    }
    // Directed dependency: distinct per (source, target, head).
    const depKey = dirKey(c.source, c.target, c.head, "dependency");
    if (!edges.has(depKey)) {
      edges.set(depKey, { source: c.source, target: c.target, head: c.head, score: c.score, direction: "dependency" });
    }
  }

  const nodeList: TopologyNodeV1[] = [...nodes.entries()]
    .map(([id, kind]) => ({ id, kind }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edgeList = [...edges.values()].sort(compareEdges);

  const graph: TopologyV1 = {
    schema: "topology-v1",
    sessionId,
    sourceHighWater,
    threshold,
    nodeCount: nodeList.length,
    edgeCount: edgeList.length,
    generationDigest: "",
    nodes: nodeList,
    edges: edgeList,
  };

  return { ok: true, topology: graph, rejected: rejections };
}

function reject(c: TopologyCandidate, code: TopologyRejection["code"]): TopologyRejection {
  return { source: c.source, target: c.target, head: c.head, score: c.score, code };
}

function groupKey(source: string, head: string): string {
  return JSON.stringify([source, head]);
}

function pairKey(a: string, b: string): string {
  return JSON.stringify([a, b, " "]);
}

function dirKey(a: string, b: string, head: string, direction: string): string {
  return JSON.stringify([a, b, head, direction]);
}

function compareCandidates(a: TopologyCandidate, b: TopologyCandidate): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  // Equal scores: sort by unsigned target-ID bytes ascending (TOP-TIE-002).
  return unsignedBytesCompare(a.target, b.target);
}

/**
 * Total, deterministic order over selected candidates used to drive dedup before
 * encoding. Independent of the incoming input order so a collapsed contradiction
 * pair always picks the same representing head and identical directed edges keep
 * the same winner.
 *
 * SCORE DESCENDING IS THE PRIMARY KEY: first-writer-wins dedup on this order
 * retains the highest score for every collapsed relation (Q01). Only after
 * scores are equal do we fall through to bytewise source/target/head/kind keys,
 * which keeps a sound deterministic tie-break (a score tie collapses to the
 * same representing head regardless of input order).
 */
function compareSelected(a: TopologyCandidate, b: TopologyCandidate): number {
  return (
    (a.score < b.score ? 1 : a.score > b.score ? -1 : 0) ||
    unsignedBytesCompare(a.source, b.source) ||
    unsignedBytesCompare(a.target, b.target) ||
    unsignedBytesCompare(a.head, b.head) ||
    unsignedBytesCompare(a.kind, b.kind)
  );
}

function compareEdges(a: TopologyEdgeV1, b: TopologyEdgeV1): number {
  return (
    unsignedBytesCompare(a.source, b.source) ||
    unsignedBytesCompare(a.target, b.target) ||
    unsignedBytesCompare(a.head, b.head) ||
    unsignedBytesCompare(a.direction, b.direction) ||
    (a.score < b.score ? -1 : a.score > b.score ? 1 : 0)
  );
}

/**
 * Unsigned bytewise comparison over UTF-8 bytes of two strings. String
 * `<`/`>` in JS is UTF-16 code-unit order, which equals UTF-8 byte order for
 * the ASCII identifiers used (and for our domain); we implement an explicit
 * unsigned-byte comparator so ordering is defined by spec, not JS internals.
 */
function unsignedBytesCompare(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  return ba.length < bb.length ? -1 : ba.length > bb.length ? 1 : 0;
}

/**
 * Node kind for a retained edge: a node is marked by the record kind it is
 * derived from. A contradiction candidate marks both endpoints "contradiction";
 * a dependency candidate marks both endpoints "dependency" (Q02) — the node
 * kind matches the producing record kind, never a synthetic placeholder.
 *
 * NODE-KIND SEMANTICS (documented, Q03): a node participates in the kind of
 * whichever retained edge LABELLED it LAST during the linear pass over `selected`.
 * Because `selected` is sorted SCORE-DESCENDING first, the last label a node
 * receives comes from its LOWEST-scoring retained edge — i.e. when a node is
 * touched by both a dependency and a contradiction edge (of equal or lower
 * score), the WEAKEST relation's kind wins the node's `kind` field, not the
 * strongest. This is deliberate and DETERMINISTIC (the total compareSelected
 * order, with the Q01 `kind` tie-break, fixes the pass order independent of
 * input order), and mode B reproduces it exactly. A downstream VC3C consumer
 * must read node.kind as "the relation kind of the weakest retained edge
 * incident to this node", not "the dominant/strongest relation". Per-edge
 * direction + kind are authoritative on the edges themselves.
 */
function nodeKind(c: TopologyCandidate): TopologyNodeKind {
  return c.kind === "contradiction" ? "contradiction" : "dependency";
}

type TopologyNodeKind = "semantic" | "dependency" | "contradiction" | "synthetic";
