/**
 * dashboard-server/routes-vector-cortex-topology.ts — VC3A/VC3B vector-cortex
 * topology dashboard route.
 *
 * Reader-only GET /api/vector-cortex/topology built ENTIRELY on the CortexReader
 * capability: opens the isolated cortex DB for this repo's state dir and returns
 * the topology summary (enabled, active generation identity, one root digest,
 * derived frontier, record count, ordinal). It is query-only — never
 * append/rebuild/switch. No writer or admin capability is reachable on this path
 * (no writer/admin leakage). Non-fatal: a missing or corrupt cortex DB degrades
 * to `enabled:false`.
 *
 * VC3B adds the deterministic node/edge shapes (TopologyV1) when both VC3A and
 * VC3B are enabled: the accepted derived records of kind "topology" that carry a
 * canonical TopologyCandidate JSON payload are fed through the deterministic
 * build (buildTopologyGraph), whose stable generation digest + sorted node/edge
 * arrays are returned. Bad/unparseable records are skipped (PREVENT-001), and
 * with VC3B off the node/edge fields are omitted entirely — byte-identical to
 * the VC3A predecessor view.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC3A_ENABLED, VC3B_ENABLED } from "../../src/config.js";
import { Logger } from "../../src/log.js";
import { createCortexStore } from "../../src/vector-cortex/cortex/store.js";
import { buildTopologyGraph } from "../../src/vector-cortex/topology/index.js";
import type { TopologyCandidate, TopologyEmit } from "../../src/vector-cortex/topology/index.js";
import type { CortexRecordV1 } from "../../src/vector-cortex/cortex/types.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexTopologyView } from "./api-contracts/vector-cortex.js";

/** Well-known cortex record kind that carries a canonical candidate payload. */
const TOPOLOGY_RECORD_KIND = "topology";

/**
 * Reader-only GET /api/vector-cortex/topology (VC3A + VC3B node/edge shapes).
 */
export function handleVectorCortexTopology(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/topology") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /topology.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC3A_ENABLED();
  const topologyEnabled = VC3B_ENABLED();
  let active = enabled;
  let summary: {
    generationId: string | null;
    rootDigest: string | null;
    sourceHighWater: string;
    recordCount: number;
    ordinal: string | null;
  } = { generationId: null, rootDigest: null, sourceHighWater: "0", recordCount: 0, ordinal: null };
  let nodes: { id: string; kind: string }[] | undefined;
  let edges: {
    source: string;
    target: string;
    head: string;
    score: number;
    direction: string;
  }[] | undefined;
  let generationDigest: string | null | undefined;

  if (enabled) {
    try {
      const store = createCortexStore({ stateDir: ctx.stateDir });
      try {
        const reader = store.reader();
        const s = reader.topologySummary();
        summary = {
          generationId: s.generationId,
          rootDigest: s.rootDigest,
          sourceHighWater: s.sourceHighWater,
          recordCount: s.recordCount,
          ordinal: s.ordinal,
        };
        if (topologyEnabled) {
          const built = buildFromRecords(reader.readRecords());
          nodes = built.nodes;
          edges = built.edges;
          generationDigest = built.generationDigest;
        }
      } finally {
        store.close();
      }
    } catch {
      // Non-fatal: a missing/corrupt cortex DB degrades to `enabled:false`.
      active = false;
    }
  }

  const body: VectorCortexTopologyView = {
    enabled: active,
    generationId: summary.generationId,
    rootDigest: summary.rootDigest,
    sourceHighWater: summary.sourceHighWater,
    recordCount: summary.recordCount,
    ordinal: summary.ordinal,
    ...(topologyEnabled
      ? { nodes, edges, generationDigest }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * Reconstruct the deterministic topology graph from the accepted derived records
 * (reader-only, best-effort). Only records of kind "topology" whose payload is a
 * canonical TopologyCandidate JSON are consumed; everything else is ignored.
 * Returns empty arrays + null digest when no valid candidates are stored.
 *
 * The build seam is invoked with a logger-derived emit so the VC3B observability
 * events (`vector_cortex_topology_built` / `vector_cortex_topology_edge_rejected`)
 * fire on this production path — not just under unit tests. Best-effort and
 * non-fatal: a failing emitter never breaks the agent loop.
 *
 * Q04 — DIVERGENCE RISK (documented, currently latent): the build is invoked
 * with a hardcoded `threshold: 0` (plus `sessionId: "dashboard"` and
 * `sourceHighWater: 0n`). This reflects the VC3B state where no production
 * writer emits calibrated-threshold candidates yet, so retaining ALL stored
 * "topology" records is correct for now. Once a real calibrated-threshold
 * producer lands (VC3C), this dashboard digest will NOT derive from the
 * authoritative threshold and can diverge from the canonical build for the same
 * stored candidate set. The calibrated threshold must then be threaded through
 * (e.g. sourced from the authority/config, not zero) before this route is treated
 * as authoritative. Until then the route is explicitly best-effort display only.
 */
function buildFromRecords(records: readonly CortexRecordV1[]): {
  nodes: { id: string; kind: string }[];
  edges: { source: string; target: string; head: string; score: number; direction: string }[];
  generationDigest: string | null;
} {
  const candidates: TopologyCandidate[] = [];
  for (const r of records) {
    if (r.kind !== TOPOLOGY_RECORD_KIND) continue;
    const parsed = parseCandidatePayload(r);
    if (parsed) candidates.push(parsed);
  }
  const result = buildTopologyGraph(
    { sessionId: "dashboard", sourceHighWater: 0n, threshold: 0, candidates },
    topologyEmit,
  );
  if (!result.ok) return { nodes: [], edges: [], generationDigest: null };
  return {
    nodes: result.topology.nodes.map((n) => ({ id: n.id, kind: n.kind })),
    edges: result.topology.edges.map((e) => ({
      source: e.source,
      target: e.target,
      head: e.head,
      score: e.score,
      direction: e.direction,
    })),
    generationDigest: result.topology.generationDigest,
  };
}

/**
 * Logger-derived default emitter for the VC3B topology events. Mirrors the
 * cortex store's `defaultEmitFor()` convention: a REAL structured-log producer so
 * a caller that invokes the build seam without injecting an emitter still yields
 * telemetry (best-effort, non-fatal). This is the production invoke point that
 * makes the task-5 emission capable live (not dead under unit tests only).
 */
const topologyEmit: TopologyEmit = (event, fields) => {
  new Logger().info(event, fields);
};

/**
 * PREVENT-001: parse + shape-check a candidate payload before use. Returns
 * undefined on any malformed/non-object input (best-effort, non-fatal).
 */
function parseCandidatePayload(r: CortexRecordV1): TopologyCandidate | undefined {
  let text: string;
  try {
    text = new TextDecoder().decode(r.payloadBytes);
  } catch {
    return undefined;
  }
  try {
    const v: unknown = JSON.parse(text);
    if (
      v === null ||
      typeof v !== "object" ||
      Array.isArray(v)
    ) {
      return undefined;
    }
    const o = v as Record<string, unknown>;
    if (
      typeof o.source !== "string" ||
      typeof o.target !== "string" ||
      typeof o.head !== "string" ||
      typeof o.score !== "number" ||
      (o.kind !== "dependency" && o.kind !== "contradiction")
    ) {
      return undefined;
    }
    return {
      source: o.source,
      target: o.target,
      head: o.head,
      score: o.score,
      kind: o.kind,
    };
  } catch {
    return undefined;
  }
}
