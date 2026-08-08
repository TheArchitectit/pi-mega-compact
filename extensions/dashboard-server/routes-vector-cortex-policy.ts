/**
 * dashboard-server/routes-vector-cortex-policy.ts — VC8B policy dashboard route.
 *
 * Reader-only GET /api/vector-cortex/policy returning the shadow adaptive
 * policy aggregate diagnostics: whether the VC8B flag is enabled, the runtime
 * triad mode, how many shadow decisions were evaluated, how many were clamped
 * at a bound, how many were rejected (unknown pressure / bad bounds), the
 * live-mutation count (structurally always 0), the active pressure version,
 * and the last POL_ or M7_ failure code.
 *
 * COUNTS + CODES ONLY. The policy engine carries no payload, so this route
 * NEVER exposes prompt bytes, session content, or free-text — only aggregate
 * counts and machine codes.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC8B_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { deriveVcStatus } from "./vc-status.js";
import { readLivewireSnapshot } from "../../src/vector-cortex/livewire/livewire-registry.js";
import type { VectorCortexPolicyView } from "./api-contracts/vector-cortex-policy.js";

// The flag-off deferred reason, kept byte-identical to the pre-LIVEWIRE
// predecessor (VC8B: `shadow_controller_not_instantiated_v0_20_23`).
const DEFERRED_REASON = "shadow_controller_not_instantiated_v0_20_23";

/** GET /api/vector-cortex/policy — reader-only policy + shadow aggregate (VC8B). */
export function handleVectorCortexPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;

  if (path !== "/api/vector-cortex/policy") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC8B_ENABLED();
  if (!enabled) {
    // Flag-off parity: byte-identical to the predecessor (mode C + deferred).
    const body: VectorCortexPolicyView = {
      enabled: false,
      mode: "C",
      shadowDecisions: 0,
      clampedDecisions: 0,
      rejectedInputs: 0,
      liveMutations: 0,
      pressureVersion: 1,
      lastFailure: null,
      updatedAt: new Date().toISOString(),
      deferredReason: DEFERRED_REASON,
      status: deriveVcStatus({ enabled: false, hasData: false }),
    };
    sendJson(res, 200, body);
    return true;
  }

  const policy = readLivewireSnapshot(ctx.stateDir).policy;
  const body: VectorCortexPolicyView = {
    enabled: true,
    mode: "A",
    shadowDecisions: policy.shadowDecisions,
    clampedDecisions: policy.clampedDecisions,
    rejectedInputs: policy.rejectedInputs,
    liveMutations: policy.liveMutations,
    pressureVersion: policy.pressureVersion,
    lastFailure: policy.lastFailure,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled: true, hasData: policy.shadowDecisions > 0 }),
  };
  sendJson(res, 200, body);
  return true;
}
