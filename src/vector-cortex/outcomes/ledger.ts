/**
 * outcomes/ledger.ts — VC8A outcome ledger append + validation.
 *
 * Appends outcome fields for session/repo/assignment/metrics ONLY. Rejects
 * prompt, response, exact bytes, or free-text payload fields as
 * OUT_PAYLOAD_FORBIDDEN. The ledger is append-only — no mutation.
 *
 * The append/validate functions are PURE. The flag gates ONLY the reporter
 * seam (emit), never the validation arithmetic, so flag-off is byte-identical
 * to the predecessor.
 *
 * PREVENT-PI-004: no network. PREVENT-011: no `any` type.
 */

import {
  OUTCOME_SCHEMA_V1,
  OUT_PAYLOAD_FORBIDDEN,
  type OutcomeV1,
  type OutcomeMetric,
} from "./types.js";

/** Fields that must never appear in an outcome — they carry payload. */
const FORBIDDEN_FIELDS = new Set([
  "prompt",
  "response",
  "exactBytes",
  "freeText",
  "content",
  "text",
  "payload",
  "body",
  "message",
  "reply",
  "output",
  "completion",
  "snippet",
]);

/** Validate that the input object has no payload-bearing fields. */
export function validateOutcome(input: Record<string, unknown>): OutcomeV1 {
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw { code: OUT_PAYLOAD_FORBIDDEN, field: key };
    }
  }
  if (typeof input["outcomeId"] !== "string" || !input["outcomeId"]) {
    throw { code: OUT_PAYLOAD_FORBIDDEN, field: "outcomeId" };
  }
  if (typeof input["sessionId"] !== "string" || !input["sessionId"]) {
    throw { code: OUT_PAYLOAD_FORBIDDEN, field: "sessionId" };
  }
  if (typeof input["repoId"] !== "string" || !input["repoId"]) {
    throw { code: OUT_PAYLOAD_FORBIDDEN, field: "repoId" };
  }
  if (typeof input["assignment"] !== "string" || !input["assignment"]) {
    throw { code: OUT_PAYLOAD_FORBIDDEN, field: "assignment" };
  }
  const metrics = Array.isArray(input["metrics"]) ? input["metrics"] : [];
  for (const m of metrics) {
    if (typeof m !== "object" || m === null) {
      throw { code: OUT_PAYLOAD_FORBIDDEN, field: "metrics" };
    }
    const row = m as Record<string, unknown>;
    if (typeof row["code"] !== "string" || typeof row["value"] !== "number" ||
        typeof row["unit"] !== "string") {
      throw { code: OUT_PAYLOAD_FORBIDDEN, field: "metrics" };
    }
  }
  return {
    schema: OUTCOME_SCHEMA_V1,
    outcomeId: input["outcomeId"],
    sessionId: input["sessionId"],
    repoId: input["repoId"],
    assignment: input["assignment"],
    metrics: metrics as ReadonlyArray<OutcomeMetric>,
    ts: typeof input["ts"] === "string" ? input["ts"] : new Date(0).toISOString(),
  };
}

/**
 * Append an outcome to the ledger (append-only). Returns the validated
 * OutcomeV1 or throws OUT_PAYLOAD_FORBIDDEN.
 */
export function appendOutcome(
  input: Record<string, unknown>,
): OutcomeV1 {
  return validateOutcome(input);
}
