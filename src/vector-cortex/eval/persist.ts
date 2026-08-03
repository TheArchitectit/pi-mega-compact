/**
 * vector-cortex/eval/persist.ts — redacted eval JSONL persistence (VC0A).
 *
 * Bridges the in-memory observer (mode A) and the dashboard reader (separate
 * process) via a disk JSONL under the state dir. Writes are append-only and
 * hold only MetricEventV1 metric rows plus redaction metadata — never payloads,
 * prompts, or exact ledger text (EVAL-REDACT-002). Best-effort and non-fatal
 * (PREVENT-PI-004: local filesystem only; no network).
 *
 * PREVENT-011: no `any` type.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricEventV1 } from "./types.js";

/** Location of the redacted evaluation JSONL under a state dir. */
export function evalJsonlPath(stateDir: string): string {
  return join(stateDir, "vector-cortex", "evaluation.jsonl");
}

/** Append one redacted metric row as a canonical JSON line (append-only). */
export function appendEvalRow(
  stateDir: string,
  row: readonly MetricEventV1[],
): void {
  try {
    const path = evalJsonlPath(stateDir);
    mkdirSync(join(stateDir, "vector-cortex"), { recursive: true, mode: 0o700 });
    // PER_EVAL_PERMISSION: 0600 file inherits state-dir permission policy.
    writeFileSync(path, row.map((r) => `${JSON.stringify(r)}\n`).join(""), {
      flag: "a",
      mode: 0o600,
    });
    // guardrails-allow PREVENT-PI-004: local filesystem eval JSONL (no network)
  } catch {
    /* non-fatal observability — never break the agent loop */
  }
}

/**
 * Read every redacted metric row from the JSONL. Malformed or truncated final
 * lines are skipped (callers surface EVAL_JSONL_TRUNCATED); the caller decides
 * whether that is fatal. Returns an empty array when the file is absent.
 */
export function readEvalRows(stateDir: string): MetricEventV1[] {
  const out: MetricEventV1[] = [];
  let raw: string;
  try {
    raw = readFileSync(evalJsonlPath(stateDir), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MetricEventV1>;
      if (
        typeof parsed.session === "string" &&
        typeof parsed.seq === "number" &&
        typeof parsed.event === "string" &&
        typeof parsed.value === "number" &&
        typeof parsed.unit === "string" &&
        (parsed.mode === "A" || parsed.mode === "B" || parsed.mode === "C")
      ) {
        out.push(parsed as MetricEventV1);
      }
    } catch {
      /* malformed line — skip; EVAL_JSONL_TRUNCATED surfaced by caller */
    }
  }
  return out;
}
