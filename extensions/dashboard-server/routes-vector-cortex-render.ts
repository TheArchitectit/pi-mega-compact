/**
 * dashboard-server/routes-vector-cortex-render.ts — VC5B render + provider-profile
 * dashboard route.
 *
 * Reader-only GET /api/vector-cortex/render returning the registered render
 * (REN-001..020) and provider-profile (PRO-001..015) identifier counts plus the
 * known base provider-profile keys. NEVER exposes rendered node bytes, prompt
 * text, or the canonical outbound request (reader-only, SECURITY_PRIVACY).
 * Flag-gated on MEGACOMPACT_VC5B: `enabled:false` when off (byte-identical to
 * the pre-VC5B predecessor).
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + profile keys only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC5B_ENABLED } from "../../src/config.js";
import { REN_IDS } from "../../src/vector-cortex/render/types.js";
import { PRO_IDS } from "../../src/vector-cortex/provider/types.js";
import { KNOWN_PROVIDER_KEYS } from "../../src/vector-cortex/provider/registry.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexRenderView } from "./api-contracts/vector-cortex.js";

/** Reader-only GET /api/vector-cortex/render (VC5B). */
export function handleVectorCortexRender(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/render") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC5B_ENABLED();
  const body: VectorCortexRenderView = {
    enabled,
    renderCount: enabled ? REN_IDS.length : 0,
    providerCount: enabled ? PRO_IDS.length : 0,
    knownProfiles: enabled ? KNOWN_PROVIDER_KEYS : [],
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
