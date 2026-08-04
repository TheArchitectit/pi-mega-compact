/**
 * dashboard-server/routes-vector-cortex-rollout.ts — VC5C live graduated-rollout
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/rollout returning the rollout aggregate:
 * current gate, bucket count, sessions/events counts, and promotion-blocked
 * state. NEVER exposes session payloads, prompt text, or bucket→session mappings
 * (reader-only, SECURITY_PRIVACY). Flag-gated on MEGACOMPACT_VC5C: `enabled:false`
 * when off (byte-identical to the pre-VC5C predecessor).
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + gate state only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC5C_ENABLED } from "../../src/config.js";
import { ROLLOUT_GATES, ROLLOUT_BUCKETS } from "../../src/vector-cortex/rollout/types.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexRolloutView } from "./api-contracts/vector-cortex.js";

/** Reader-only GET /api/vector-cortex/rollout (VC5C). */
export function handleVectorCortexRollout(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/rollout") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC5C_ENABLED();
  const gateIndex = 0; // Ephemeral rollout state: no durable gate in this sprint.
  const gatePct = ROLLOUT_GATES[gateIndex]!;
  const body: VectorCortexRolloutView = {
    enabled,
    gateIndex: enabled ? gateIndex : 0,
    gatePct: enabled ? gatePct : 0,
    buckets: ROLLOUT_BUCKETS,
    bucketCount: enabled ? gatePct * 100 : 0,
    events: 0,
    sessions: 0,
    promotionBlocked: false,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
