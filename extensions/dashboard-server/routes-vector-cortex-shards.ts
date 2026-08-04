/**
 * dashboard-server/routes-vector-cortex-shards.ts — VC4A dual-tier shard
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/shards returning a COUNT/BYTE aggregate
 * (semantic shards, exact shards, protected byte total) — never shard payloads,
 * verbatim exact bytes, or prompt text. Flag-gated on MEGACOMPACT_VC4A:
 * `enabled:false` when off (byte-identical to the pre-VC4A predecessor).
 *
 * The VC4A shard partition is PURE IN-MEMORY logic in this sprint (it has no
 * durable manifest store yet), so the aggregate reports the current status
 * truthfully: `enabled` reflects the flag, and the count/byte fields are zero
 * until a future sprint persists a staged manifest. This route is the seam that
 * sprint will populate. Non-fatal: a missing state dir degrades to
 * `enabled:false`.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only / in-process state),
 * PREVENT-011 (no `any`), reader-only aggregate (counts/bytes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC4A_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexShardsView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/shards (VC4A).
 */
export function handleVectorCortexShards(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/shards") return false;
  if (req.method !== "GET") {
    // Reader-only path: cannot be "off" without a GET; it is genuinely read-only.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC4A_ENABLED();
  const body: VectorCortexShardsView = {
    enabled,
    // No durable shard manifest is staged yet in this sprint (pure in-memory
    // partition), so the aggregates are truthfully zero.
    semanticCount: 0,
    exactCount: 0,
    byteTotal: 0,
    protectedByteTotal: 0,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
