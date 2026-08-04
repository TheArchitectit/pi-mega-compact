/**
 * dashboard-server/routes-vector-cortex.ts — vector-cortex dashboard routes.
 *
 * VC0A ships a single reader-only GET /api/vector-cortex/evaluation that
 * aggregates redacted evaluation rows (persisted JSONL under the state dir)
 * via the reader. No writable capability — no reset/mutation here; VC0C adds
 * breaker health + reset endpoints into this same file, keeping it additive
 * and within extension limits.
 *
 * VC0C (task 5) adds:
 *   GET  /api/vector-cortex/health          — reader-only aggregate health card
 *   POST /api/vector-cortex/breakers/reset  — explicit admin capability
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-011 (no
 * `any`), reader-only aggregate (never payloads/prompts/ledger — EVAL-REDACT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { VC0A_ENABLED, VC0C_ENABLED, VC1B_ENABLED } from "../../src/config.js";
import { readEvalRows } from "../../src/vector-cortex/eval/persist.js";
import { summarizeEvalRows } from "../../src/vector-cortex/eval/reader.js";
import { createVectorCortexSafety } from "../mega-runtime/vector-cortex-safety.js";
import { createLedgerStore } from "../../src/vector-cortex/ledger/store.js";
import type {
  VectorCortexEvaluationSummary,
  VectorCortexHealthCard,
  VectorCortexLedgerView,
  VectorCortexResetResult,
} from "./api-contracts/vector-cortex.js";

/** Admin capability: an actor-supplied subsystem selector for breaker reset. */
function readJsonBody(
  req: IncomingMessage,
  cb: (
    result: { ok: true; value: Record<string, unknown> } | { ok: false; error: string },
  ) => void,
): void {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk: Buffer) => {
    if (body.length > 65536) {
      tooBig = true;
      return;
    }
    body += chunk.toString();
  });
  req.on("end", () => {
    if (tooBig) return cb({ ok: false, error: "body_too_large" });
    try {
      const v = body ? JSON.parse(body) : {};
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return cb({ ok: false, error: "invalid_object" });
      }
      cb({ ok: true, value: v as Record<string, unknown> });
    } catch {
      cb({ ok: false, error: "invalid_json" });
    }
  });
}

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

/**
 * Reader-only GET /api/vector-cortex/health (VC0C).
 *
 * Aggregate health card: breaker state (window/probe/backoff), durable spool
 * frontier/authority/lag, and a worst-state aggregate. Constructs the safety
 * adapter over the state dir — durable spool state (frontier-frozen, lag) is
 * read from disk, so it reflects restart. Purely read: no mutation, never
 * payloads/prompts/ledger.
 */
export function handleVectorCortexHealth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/vector-cortex/health") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /health.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const enabled = VC0C_ENABLED();
  const safety = enabled ? createVectorCortexSafety({ stateDir: ctx.stateDir }) : null;
  const card = safety ? safety.health() : null;

  const fallback: VectorCortexHealthCard = {
    enabled: false,
    mode: "C",
    state: "CLOSED_A",
    subsystem: "provider",
    sinceMs: 0,
    windowMs: 0,
    probeCount: 0,
    backoffDelayMs: 0,
    frontierFrozen: false,
    authorityOutage: false,
    spoolLag: 0,
    attempts: 0,
    failures: 0,
    p95Ms: 0,
    failureRate: 0,
    updatedAt: new Date().toISOString(),
    aggregate: "CLOSED_A",
    stateSource: "ephemeral",
  };
  if (!card) {
    sendJson(res, 200, fallback);
    return true;
  }

  const mode: "A" | "B" | "C" =
    card.state === "CLOSED_A" ? "A" : card.state === "MANUAL_HALT" ? "C" : "B";
  const aggregate =
    card.state === "MANUAL_HALT"
      ? "MANUAL_HALT"
      : card.state === "OPEN_C"
        ? "OPEN_C"
        : card.state === "OPEN_B"
          ? "OPEN_B"
          : card.state === "PROBE_B" || card.state === "PROBE_A"
            ? "PROBE"
            : "CLOSED_A";

  const body: VectorCortexHealthCard = {
    enabled,
    mode,
    state: card.state,
    subsystem: card.subsystem,
    sinceMs: card.sinceMs,
    reason: card.reason,
    windowMs: card.windowMs,
    probeCount: card.probeCount,
    backoffDelayMs: card.backoffDelayMs,
    frontierFrozen: card.frontierFrozen,
    authorityOutage: card.authorityOutage,
    spoolLag: card.spoolLag,
    attempts: card.attempts,
    failures: card.failures,
    p95Ms: card.p95Ms,
    failureRate: card.failureRate,
    updatedAt: new Date().toISOString(),
    aggregate,
    stateSource: card.stateSource,
  };
  sendJson(res, 200, body);
  return true;
}

/**
 * Admin POST /api/vector-cortex/breakers/reset (VC0C).
 *
 * Explicit admin capability (separate from the reader GET). Clears a breaker's
 * cooldown — or unwires a MANUAL_HALT — but NEVER evidence (attempts/failures
 * are retained, per TRIAD_RESILIENCE). The subsystem is actor-supplied via the
 * JSON body `{ subsystem }`. Every reset is documented in the returned record
 * (state, retained evidence, updatedAt) — an auditable mutation surface; the
 * GET path can never mutate.
 */
export function handleVectorCortexBreakersReset(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/vector-cortex/breakers/reset") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!VC0C_ENABLED()) {
    sendJson(res, 409, { error: "vco_c_disabled" });
    return true;
  }

  readJsonBody(req, (parsed) => {
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const subsystem = parsed.value.subsystem;
    if (typeof subsystem !== "string" || subsystem.length === 0) {
      sendJson(res, 400, { error: "subsystem_required" });
      return;
    }
    try {
      const safety = createVectorCortexSafety({ stateDir: ctx.stateDir });
      const rec = safety.reset(subsystem);
      const body: VectorCortexResetResult = {
        subsystem: rec.subsystem,
        state: rec.state,
        cooldownCleared: true,
        attempts: rec.attempts,
        failures: rec.failures,
        probeCount: rec.probeCount,
        manualReason: rec.manualReason,
        updatedAt: rec.updatedAt,
      };
      sendJson(res, 200, body);
    } catch {
      sendJson(res, 500, { error: "reset_failed" });
    }
  });
  return true;
}

/**
 * Reader-only GET /api/vector-cortex/ledger (VC1B).
 *
 * Built on the LedgerReader capability: opens the occurrence-v2 ledger for this
 * repo's state dir and returns the session's occurrence IDENTITY rows
 * (seq/eventId/kind/digest/toolCallId) plus high-water/count. NEVER ships
 * sourceBytes or prompt text (reader-only no-ledger-text rule). Optional
 * `?session=<id>` query selects the session (default "default").
 */
export function handleVectorCortexLedger(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? url;
  if (path !== "/api/vector-cortex/ledger") return false;
  if (req.method !== "GET") {
    // Reader-only path: no mutation endpoint lives at /ledger.
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  // Parse the optional session query parameter.
  let session = "default";
  const qs = url.split("?")[1];
  if (qs !== undefined) {
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=");
      if (k === "session" && v !== undefined && v.length > 0) {
        session = decodeURIComponent(v);
      }
    }
  }

  const enabled = VC1B_ENABLED();
  let active = enabled;
  let highWater = "0";
  let count = 0;
  let occurrences: VectorCortexLedgerView["occurrences"] = [];

  if (enabled) {
    try {
      const store = createLedgerStore({ stateDir: ctx.stateDir });
      try {
        const reader = store.reader();
        highWater = reader.highWater(session).toString();
        const rows = reader.readSession(session);
        count = rows.length;
        // Identity only: never sourceBytes or prompt text (reader-only rule).
        occurrences = rows.slice(-500).map((occ) => ({
          seq: occ.seq.toString(),
          eventId: occ.eventId,
          kind: occ.kind,
          digest: occ.digest,
          ...(occ.toolCallId !== undefined ? { toolCallId: occ.toolCallId } : {}),
        }));
      } finally {
        store.close();
      }
    } catch {
      // Non-fatal: a missing/corrupt ledger DB degrades to `enabled:false`.
      active = false;
    }
  }

  const body: VectorCortexLedgerView = {
    enabled: active,
    session,
    highWater,
    count,
    occurrences,
    updatedAt: new Date().toISOString(),
  };
  sendJson(res, 200, body);
  return true;
}
