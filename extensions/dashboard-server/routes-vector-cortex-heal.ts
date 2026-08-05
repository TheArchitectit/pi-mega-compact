/**
 * dashboard-server/routes-vector-cortex-heal.ts — VC6A closure-optimization and
 * VC6B exact-source-restoration dashboard routes.
 *
 * Reader-only GET /api/vector-cortex/closure-proof returning aggregate-only
 * closure diagnostics: whether the flag is enabled, the runtime triad mode, and
 * cumulative edge/traversal counters. NEVER exposes per-edge proof rows, the
 * closed selection, node ids, or any source payload (reader-only, SECURITY_PRIVACY
 * — the detailed proof lives in the structured event log, not the dashboard).
 *
 * When the flag is OFF (`MEGACOMPACT_VC6A=0`) the runtime falls back to mode B
 * (the conservative VC4C closure, no reduction) — that is exactly the spec's
 * fallback rule — so `mode:"B"` + `enabled:false` is the byte-stable OFF view.
 *
 * Reader-only GET /api/vector-cortex/restore (VC6B) returns restore COUNTS and
 * HEAL_RESTORE_* error codes only. There is NO payload endpoint for restoration,
 * ever — no restored bytes, span ids, node ids, byte ranges, or ledger text.
 *
 * Guardrails: PREVENT-PI-004 (local in-process state only), PREVENT-011 (no
 * `any`), reader-only aggregate (counts + mode only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC6A_ENABLED, VC6B_ENABLED } from "../../src/config.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { countVcEvents, vcCount } from "./vc-event-counts.js";
import type {
  VectorCortexClosureProofView,
  VectorCortexRestoreView,
} from "./api-contracts/vector-cortex.js";

// Actual event names emitted by src/vector-cortex/heal/emit.ts + restore-emit.ts.
const CLOSURE_EVENTS = [
  "vector_cortex_closure_optimized",
  "vector_cortex_closure_proof_rejected",
] as const;
const RESTORE_EVENTS = [
  "vector_cortex_source_restored",
  "vector_cortex_restore_digest_rejected",
] as const;

/** Reader-only GET /api/vector-cortex/closure-proof (VC6A). */
export function handleVectorCortexClosureProof(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/closure-proof") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC6A_ENABLED();
  const counts = countVcEvents(ctx.stateDir, CLOSURE_EVENTS);
  // Flag-off routes to mode B (conservative closure, no reduction) per spec.
  const mode: "A" | "B" | "C" = enabled ? "A" : "B";
  const body: VectorCortexClosureProofView = {
    enabled,
    mode,
    optimizations: vcCount(counts, "vector_cortex_closure_optimized"),
    proofRejections: vcCount(counts, "vector_cortex_closure_proof_rejected"),
    retainedEdgeTotal: 0,
    removedEdgeTotal: 0,
    conservativeTraversalTotal: 0,
    optimizedTraversalTotal: 0,
    lastRejection: null,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * Reader-only GET /api/vector-cortex/restore (VC6B).
 *
 * Counts and HEAL_RESTORE_* codes only — this is a static reader-only aggregate
 * seam (same shape as the VC6A handler): there is no payload endpoint and never
 * will be, so no restored bytes/span ids/node ids/ledger text can leak here.
 */
export function handleVectorCortexRestore(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/restore") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC6B_ENABLED();
  const counts = countVcEvents(ctx.stateDir, RESTORE_EVENTS);
  // Flag-off routes to mode C: with VC6B off there is no exact-restoration path
  // at all, so the honest OFF view is the disclose-loss mode (old context is
  // omitted rather than inferred) — mirroring how VC6A's OFF view reports the
  // conservative fallback it actually takes.
  const mode: "A" | "B" | "C" = enabled ? "A" : "C";
  const body: VectorCortexRestoreView = {
    enabled,
    mode,
    restoreAttempts: vcCount(counts, "vector_cortex_source_restored"),
    restoredCount: 0,
    missingCount: 0,
    digestRejections: vcCount(counts, "vector_cortex_restore_digest_rejected"),
    lastRejection: null,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
