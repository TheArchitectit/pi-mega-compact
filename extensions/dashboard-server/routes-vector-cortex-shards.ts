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
import { countVcEvents, vcCount } from "./vc-event-counts.js";
import type { VectorCortexShardsView } from "./api-contracts/vector-cortex.js";
import { deriveVcStatus } from "./vc-status.js";

// Actual events emitted by src/vector-cortex/shards/manifest.ts. VC4A has no
// per-tier (semantic/exact) write event — the manifest build is the single
// shard-write signal — so semanticCount is wired to it and exactCount stays 0
// until a per-tier write event exists.
const SHARD_EVENTS = ["vector_cortex_shard_manifest_built"] as const;

/**
 * Reader-only GET /api/vector-cortex/shards (VC4A).
 */
export function handleVectorCortexShards(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
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
  const counts = countVcEvents(ctx.stateDir, SHARD_EVENTS);
  const body: VectorCortexShardsView = {
    enabled,
    // The manifest-build event is the only VC4A shard-write signal; semanticCount
    // reflects manifests built and exactCount stays 0 (no per-tier write event
    // distinguishes exact shards in events.log yet).
    semanticCount: vcCount(counts, "vector_cortex_shard_manifest_built"),
    exactCount: 0,
    byteTotal: 0,
    protectedByteTotal: 0,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({
      enabled,
      hasData: vcCount(counts, "vector_cortex_shard_manifest_built") > 0,
    }),
  };
  sendJson(res, 200, body);
  return true;
}
