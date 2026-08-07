/**
 * dashboard-server/qualification-record.ts — ENC-0g QualificationV1 reader.
 *
 * Read-only reader for the ENC-0f qualification record at
 * <stateDir>/encoder-qualification.json. The computed-blocker + action-gating
 * functions live in setup-cortex-blockers.ts (Worker A's canonical module).
 *
 * Reader-only: local filesystem read only (PREVENT-PI-004), no `any`
 * (PREVENT-011), never payloads/prompts/ledger (EVAL-REDACT-002).
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QualificationV1 } from "../../src/vector-cortex/encoder/qualify.js";
import { QUALIFICATION_RECORD_UNAVAILABLE } from "../../src/vector-cortex/setup-cortex-blockers-compute.js";

/** Sentinel appended to thresholdFailures when no valid record is readable (canonical def in setup-cortex-blockers-compute). */
export { QUALIFICATION_RECORD_UNAVAILABLE };

/**
 * Resolve the encoder state dir (the record's home) — same precedence as
 * scripts/encoder/gate-qualify.mjs: MEGACOMPACT_STATE_DIR first, else
 * ~/.pi/mega-compact-encoder.
 */
export function encoderStateDir(): string {
  const env = process.env.MEGACOMPACT_STATE_DIR;
  return env !== undefined && env.length > 0
    ? env
    : join(homedir(), ".pi", "mega-compact-encoder");
}

/**
 * Read + minimally validate the QualificationV1 record. Returns null on a
 * missing/unreadable file, a JSON parse failure, or a shape mismatch (the
 * route degrades to verify-only — never crashes). Read-only (PREVENT-PI-004).
 */
export function readQualificationRecord(stateDir: string): QualificationV1 | null {
  let raw: string;
  try {
    // guardrails-allow PREVENT-PI-004: local qualification-record filesystem read (loopback)
    raw = readFileSync(join(stateDir, "encoder-qualification.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const rec = parsed as Record<string, unknown> | null;
  if (rec === null || typeof rec !== "object") return null;
  if (rec["schema"] !== "qualification-v1") return null;
  if (typeof rec["verdict"] !== "string") return null;
  if (!Array.isArray(rec["reasons"])) return null;
  if (typeof rec["platform"] !== "string") return null;
  const reasons = rec["reasons"].map((r) => String(r));
  return {
    schema: "qualification-v1",
    verdict: rec["verdict"] === "qualified" ? "qualified" : "failed",
    reasons,
    platform: rec["platform"],
    p95Ms: typeof rec["p95Ms"] === "number" ? rec["p95Ms"] : 0,
    rssMib: typeof rec["rssMib"] === "number" ? rec["rssMib"] : 0,
    opset: typeof rec["opset"] === "number" ? rec["opset"] : 0,
    digest: typeof rec["digest"] === "string" ? rec["digest"] : "",
  };
}

