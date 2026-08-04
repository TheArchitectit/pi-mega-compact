/**
 * dashboard-server/routes-vector-cortex-shared.ts — shared HTTP helpers for the
 * per-feature vector-cortex route modules.
 *
 * Homes the small request/response helpers used across the VC0A/VC0C/VC1B/VC3A
 * handler modules (`sendJson`, `readJsonBody`) so the feature modules stay small
 * and within extension line limits.
 *
 * Guardrails: PREVENT-PI-004 (loopback dashboard response only), PREVENT-011 (no
 * `any`), PREVENT-001 (JSON.parse guarded by an object/shape check).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Parse a JSON request body with a size cap. `cb` receives either a validated
 * plain object or an error reason. PREVENT-001: JSON.parse is guarded by a
 * shape check (rejects null / arrays / non-objects).
 */
export function readJsonBody(
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
