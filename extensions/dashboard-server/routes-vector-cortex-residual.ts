/**
 * dashboard-server/routes-vector-cortex-residual.ts — VC4B residual basis parity
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/residual returning a COUNT/BYTE aggregate
 * (encode attempts, admitted/rejected counts, recovery failures, encoded/exact
 * byte totals) — never residual payloads, correction streams, shard bytes, or
 * original source bytes. Flag-gated on MEGACOMPACT_VC4B: `enabled:false` when off
 * (byte-identical to the pre-VC4B predecessor).
 *
 * The VC4B residual codec is PURE IN-MEMORY logic in this sprint (it has no
 * durable metrics store yet), so the aggregate reports the current status
 * truthfully: `enabled` reflects the flag, and the count/byte fields are zero
 * until a future sprint persists a metrics store. This route is the seam that
 * sprint will populate. Non-fatal: a missing state dir degrades to
 * `enabled:false`.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only / in-process state),
 * PREVENT-011 (no `any`), reader-only aggregate (counts/bytes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC4B_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexResidualView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/residual (VC4B).
 */
export function handleVectorCortexResidual(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/residual") return false;
  if (req.method !== "GET") {
    // Reader-only path: cannot be "off" without a GET; it is genuinely read-only.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC4B_ENABLED();
  const body: VectorCortexResidualView = {
    enabled,
    // No durable residual metrics store is staged yet in this sprint (pure
    // in-memory encode), so the aggregates are truthfully zero.
    encodeAttempts: 0,
    admittedCount: 0,
    rejectedCount: 0,
    recoveryFailures: 0,
    encodedByteTotal: 0,
    exactByteTotal: 0,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
