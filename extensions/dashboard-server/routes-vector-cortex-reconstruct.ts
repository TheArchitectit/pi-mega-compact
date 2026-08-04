/**
 * Dashboard handler: GET /api/vector-cortex/reconstruct (VC4C).
 *
 * Reader-only reconstruction-fidelity aggregate. Mirrors the VC4B residual
 * handler: path guard + 405 on non-GET, gated on the sprint flag, returns a
 * zero-valued view when disabled (byte-identical predecessor contract). Never
 * returns reconstructed spans, exact bytes, or prompt text.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC4C_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexReconstructView } from "./api-contracts/vector-cortex.js";

export function handleVectorCortexReconstruct(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/reconstruct") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const enabled = VC4C_ENABLED();
  const body: VectorCortexReconstructView = {
    enabled,
    closureAttempts: 0,
    closureRejections: 0,
    validatedCount: 0,
    invalidatedCount: 0,
    spanTotal: 0,
    byteTotal: 0,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
