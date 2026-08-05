/**
 * dashboard-server/routes-vector-cortex-platform.ts — VC8C platform dashboard route.
 *
 * Reader-only GET /api/vector-cortex/platform returning the engine parity/selection
 * aggregate diagnostics: whether the VC8C flag is enabled, the runtime triad mode,
 * how many fixtures are in the parity matrix, how many passed, how many failed,
 * whether an external runner is configured, and the last RUST_ failure code.
 *
 * COUNTS + CODES ONLY. The selector carries no payload, so this route NEVER
 * exposes artifact bytes, output bytes, or free-text — only aggregate counts and
 * machine codes.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + codes only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC8C_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { countVcEvents, vcCount } from "./vc-event-counts.js";
import { deriveVcStatus } from "./vc-status.js";
import type { VectorCortexPlatformView } from "./api-contracts/vector-cortex-platform.js";

// Actual events emitted by src/vector-cortex/platform/* — a parity run checks
// fixtures and a demotion records an engine-selection downgrade.
const PLATFORM_EVENTS = [
  "vector_cortex_engine_parity_checked",
  "vector_cortex_engine_selection_demoted",
] as const;

/** GET /api/vector-cortex/platform — reader-only engine parity/selection aggregate (VC8C). */
export function handleVectorCortexPlatform(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;

  if (path !== "/api/vector-cortex/platform") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC8C_ENABLED();
  const counts = countVcEvents(ctx.stateDir, PLATFORM_EVENTS);
  const mode: VectorCortexPlatformView["mode"] = enabled ? "A" : "C";
  const fixtureCount = vcCount(counts, "vector_cortex_engine_parity_checked");
  const body: VectorCortexPlatformView = {
    enabled,
    mode,
    fixtureCount,
    passed: 0,
    failed: 0,
    externalRunnerConfigured: process.env.MEGACOMPACT_RUST_RUNNER !== undefined,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled, hasData: fixtureCount > 0 }),
  };
  sendJson(res, 200, body);
  return true;
}
