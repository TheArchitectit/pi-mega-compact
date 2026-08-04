/**
 * vector-cortex/topology/index.ts — topology barrel + stable graph digest (VC3B).
 *
 * Typical role: a thin barrel + a few derived helpers. The build algorithm lives
 * in build.ts; this file:
 *   - re-exports the TopologyV1 / EdgeV1 contracts;
 *   - computes ONE deterministic graph digest over the canonical, order-
 *     independent serialization of nodes + edges (task 4);
 *   - compose `buildTopologyGraph` = build + digest + emit on one seam.
 *
 * Ordinal-order independence: the digest is computed over nodes sorted by id
 * bytes and edges sorted by (source, target, head, direction) then score, so
 * any permutation of the build input yields an identical digest (verified by the
 * acceptance consumer across 1,000 distinct input orderings — Q02).
 *
 * Pure deterministic helpers: no I/O, no console, no network (PREVENT-PI-004),
 * no `any` (PREVENT-011).
 */
import { createHash } from "node:crypto";
import { buildTopology } from "./build.js";
import {
  type TopologyBuildResult,
  type TopologyEdgeV1,
  type TopologyInput,
  type TopologyNodeV1,
  type TopologyV1,
} from "./types.js";

export type {
  TopologyBuildResult,
  TopologyEdgeV1,
  TopologyInput,
  TopologyNodeV1,
  TopologyV1,
  TopologyCandidate,
  TopologyRejection,
  TopologyRejectCode,
} from "./types.js";
export { TOP_IDS, TOP_NAMED_IDS, TOP_K } from "./types.js";
export { buildTopology } from "./build.js";

/** Emitter shape for the two VC3B topology events. */
export type TopologyEmit = (
  event: "vector_cortex_topology_built" | "vector_cortex_topology_edge_rejected",
  fields: Record<string, unknown>,
) => void;

/**
 * Deterministic topological-construction seam (task 5). Runs the build, fills
 * the stable generationDigest, and optionally emits:
 *   - `vector_cortex_topology_built`        — once, when a graph is produced;
 *   - `vector_cortex_topology_edge_rejected`— once per rejected edge with code.
 * Emission is best-effort and non-fatal (never breaks the agent loop).
 */
export function buildTopologyGraph(
  input: TopologyInput,
  emit?: TopologyEmit,
): TopologyBuildResult {
  const result = buildTopology(input);
  if (!result.ok) return result;
  const topology: TopologyV1 = {
    ...result.topology,
    generationDigest: graphDigest(result.topology),
  };
  const out: TopologyBuildResult = { ok: true, topology, rejected: result.rejected };
  if (emit) {
    try {
      emit("vector_cortex_topology_built", {
        sessionId: topology.sessionId,
        sourceHighWater: topology.sourceHighWater.toString(),
        nodeCount: topology.nodeCount,
        edgeCount: topology.edgeCount,
        generationDigest: topology.generationDigest,
      });
      for (const r of result.rejected) {
        emit("vector_cortex_topology_edge_rejected", {
          sessionId: topology.sessionId,
          source: r.source,
          target: r.target,
          head: r.head,
          code: r.code,
        });
      }
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  }
  return out;
}

/**
 * ONE deterministic SHA-256 (hex) over the canonical serialization of the graph.
 * Canonical form is a compact stream: `topology-v1|` + sorted nodes + `|` +
 * sorted edges, where nodes are sorted by id bytes and edges by
 * (source, target, head, direction) then score. Order-independence is achieved
 * by that canonical sort, never by input order.
 *
 * Printable framing (no control bytes): FIELD_SEP (`|`) separates fields and
 * RECORD_SEP (`~`) separates records. The project-controlled field values (ids,
 * kinds, heads, directions, scores) contain neither `|` nor `~`, so the framing
 * never collides, and keeping the file control-byte-free lets git treat this
 * core sprint file as text (prevents a spurious "binary file" classification).
 */
// Printable, unambiguous framing delimiters for the canonical serialization.
const FIELD_SEP = "|";
const RECORD_SEP = "~";

export function graphDigest(topology: TopologyV1): string {
  const nodes = canonicalNodes(topology.nodes);
  const edges = canonicalEdges(topology.edges);
  const hash = createHash("sha256");
  hash.update(`topology-v1${FIELD_SEP}`);
  hash.update(nodes);
  hash.update(FIELD_SEP);
  hash.update(edges);
  return `sha256:${hash.digest("hex")}`;
}

function canonicalNodes(nodes: readonly TopologyNodeV1[]): Buffer {
  const sorted = [...nodes]
    .map((n) => `${n.id}${FIELD_SEP}${n.kind}`)
    .sort(unsignedBytesCompare)
    .join(RECORD_SEP);
  return Buffer.from(sorted, "utf8");
}

function canonicalEdges(edges: readonly TopologyEdgeV1[]): Buffer {
  const parts = edges
    .map((e) => `${e.source}${FIELD_SEP}${e.target}${FIELD_SEP}${e.head}${FIELD_SEP}${e.direction}${FIELD_SEP}${e.score}`)
    .sort(unsignedBytesCompare)
    .join(RECORD_SEP);
  return Buffer.from(parts, "utf8");
}

function unsignedBytesCompare(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  return ba.length < bb.length ? -1 : ba.length > bb.length ? 1 : 0;
}
