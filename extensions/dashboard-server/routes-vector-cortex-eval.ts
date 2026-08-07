/**
 * dashboard-server/routes-vector-cortex-eval.ts — VC0A vector-cortex evaluation
 * dashboard route.
 *
 * A single reader-only GET /api/vector-cortex/evaluation that aggregates redacted
 * evaluation rows (persisted JSONL under the state dir) via the reader. No
 * writable capability — no reset/mutation here.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate (never payloads/prompts/ledger — EVAL-REDACT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC0A_ENABLED, ML5D_ENABLED } from "../../src/config.js";
import { readEvalRows } from "../../src/vector-cortex/eval/persist.js";
import { summarizeEvalRows } from "../../src/vector-cortex/eval/reader.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import type { VectorCortexEvaluationSummary } from "./api-contracts/vector-cortex.js";
import { deriveVcStatus } from "./vc-status.js";

/** Reader-only aggregate GET /api/vector-cortex/evaluation. */
export function handleVectorCortexEvaluation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/vector-cortex/evaluation") return false;
  if (req.method !== "GET") {
    // Reader-only: no mutation endpoints exist on this path.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC0A_ENABLED();
  const rows = enabled ? readEvalRows(ctx.stateDir) : [];
  const summary = summarizeEvalRows(rows);

  const body: VectorCortexEvaluationSummary = {
    enabled,
    mode: enabled ? "A" : "C",
    samples: summary.samples,
    byMode: {
      A: summary.byMode.A,
      B: summary.byMode.B,
      C: summary.byMode.C,
    },
    histogram: {
      edges: [...summary.histogram.edges],
      cells: [...summary.histogram.cells],
      overflow: summary.histogram.overflow,
      total: summary.histogram.total,
    },
    rejects: [], // VC0C wires live breaker/reject telemetry here
    // ML5-D: additive, present only when the flag is enabled → the client can
    // omit the ModelImprovementCard when off (byte-identical to ML5-C-era tab).
    ...(ML5D_ENABLED() ? { ml5dEnabled: true } : {}),
    updatedAt: new Date().toISOString(),
    status: deriveVcStatus({ enabled, hasData: summary.samples > 0 }),
  };
  sendJson(res, 200, body);
  return true;
}
