/**
 * dashboard-server/routes-vector-cortex-repair.ts — VC6C self-healing
 * derived-state dashboard route.
 *
 * Reader-only GET /api/vector-cortex/repair returning the self-healing
 * controller's aggregate diagnostics: whether the flag is enabled, the runtime
 * triad mode, cumulative rebuild/pointer-switch/backoff counters, the last
 * deterministic backoff delay, and the last HEAL_REPAIR_* failure code.
 *
 * COUNTS + ERROR CODES ONLY. NEVER exposes subsystem source bytes, rebuilt
 * derived rows, per-subsystem gap ranges, high-water marks, root digests, or
 * ledger text (reader-only, SECURITY_PRIVACY — the per-subsystem gap detail
 * lives in the structured event log, not the dashboard). There is no mutation
 * seam here either: rebuilds are driven by the controller's own gap detection,
 * never by a dashboard request, so non-GET is rejected outright.
 *
 * Split into its own file (rather than grown into routes-vector-cortex-heal.ts)
 * to keep every extensions/ file well under the 400-line soft-as-hard limit.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC6C_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexRepairView } from "./api-contracts/vector-cortex.js";

/**
 * Reader-only GET /api/vector-cortex/repair (VC6C).
 *
 * Counts and HEAL_REPAIR_* codes only — this is a static reader-only aggregate
 * seam (same shape as the VC6A/VC6B handlers): there is no payload endpoint and
 * never will be, so no subsystem bytes, gap ranges, high-water marks, or root
 * digests can leak here.
 */
export function handleVectorCortexRepair(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/repair") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC6C_ENABLED();
  // Flag-off routes to mode C: with VC6C off no self-healing controller runs at
  // all, so neither the targeted rebuild (mode A) nor the full deterministic
  // rebuild (mode B) path is available. Mode C is exactly the spec's "derived
  // state disabled" outcome — the honest OFF view is that derived state is not
  // being healed, rather than implying a rebuild path that is not wired.
  // Mirrors how VC6B's OFF view reports the disclose-loss mode it actually takes.
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexRepairView = {
    enabled,
    mode,
    repairAttempts: 0,
    repairsPlanned: 0,
    pointersSwitched: 0,
    backoffs: 0,
    lastBackoffMs: null,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
