/**
 * dashboard-server/routes-vector-cortex-topology.ts — VC3A vector-cortex topology
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/topology built ENTIRELY on the CortexReader
 * capability: opens the isolated cortex DB for this repo's state dir and returns
 * the topology summary (enabled, active generation identity, one root digest,
 * derived frontier, record count, ordinal). It is query-only — never
 * append/rebuild/switch. No writer or admin capability is reachable on this path
 * (no writer/admin leakage). Non-fatal: a missing or corrupt cortex DB degrades
 * to `enabled:false`.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC3A_ENABLED } from "../../src/config.js";
import { createCortexStore } from "../../src/vector-cortex/cortex/store.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexTopologyView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/topology (VC3A).
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
  let active = enabled;
  let summary: {
    generationId: string | null;
    rootDigest: string | null;
    sourceHighWater: string;
    recordCount: number;
    ordinal: string | null;
  } = { generationId: null, rootDigest: null, sourceHighWater: "0", recordCount: 0, ordinal: null };

  if (enabled) {
    try {
      const store = createCortexStore({ stateDir: ctx.stateDir });
      try {
        const s = store.reader().topologySummary();
        summary = {
          generationId: s.generationId,
          rootDigest: s.rootDigest,
          sourceHighWater: s.sourceHighWater,
          recordCount: s.recordCount,
          ordinal: s.ordinal,
        };
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
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
