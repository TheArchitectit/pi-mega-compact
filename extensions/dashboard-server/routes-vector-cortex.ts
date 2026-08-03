/**
 * dashboard-server/routes-vector-cortex.ts — vector-cortex dashboard routes.
 *
 * VC0A ships a single reader-only GET /api/vector-cortex/evaluation that
 * aggregates redacted evaluation rows (persisted JSONL under the state dir)
 * via the reader. No writable capability — no reset/mutation here; VC0C adds
 * breaker health + reset endpoints into this same file, keeping it additive
 * and within extension limits.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate (never payloads/prompts/ledger — EVAL-REDACT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC0A_ENABLED } from "../../src/config.js";
import { readEvalRows } from "../../src/vector-cortex/eval/persist.js";
import { summarizeEvalRows } from "../../src/vector-cortex/eval/reader.js";
import type { VectorCortexEvaluationSummary } from "./api-contracts/vector-cortex.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

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
    // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
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
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
