/**
 * vector-cortex/encoder/runtime-emit.ts — ML5-C seller event emitter.
 *
 * Emits the `vector_cortex_runtime_selected` seller event to the local
 * events.log so the dashboard Setup Cortex blockers card can surface the HG-3
 * (install budget) / HG-4 (darwin-x64 demotion) closure state. Aggregate
 * fields only — never payload bytes (EVAL-REDACT-002).
 *
 * Extracted from runtime.ts so the runtime delegate-shell stays under the
 * 300-line soft limit after the ML5-C dispatch was added. All writes are
 * best-effort / non-fatal; a disk-full or missing state dir never breaks the
 * encoder loop.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 — local filesystem append only;
 * no network). No `any` (PREVENT-011).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultEventsPath } from "../../monitoring.js";
import type { RuntimeSelectionResult } from "./runtime-select.js";

/**
 * Emit the ML5-C `vector_cortex_runtime_selected` seller event (best-effort).
 * The event carries ONLY the aggregate fields the sprint specs pin
 * ({backend, p95Ms, budgetOk, platform}) plus the ENC-0e additively-carried
 * `demotionReason` (non-null only on a demoted platform under flag ON) —
 * never message content. The event writer never throws.
 */
export function emitRuntimeSelected(
  stateDir: string,
  result: Pick<
    RuntimeSelectionResult,
    "backend" | "p95Ms" | "budgetOk" | "platform" | "demotionReason"
  >,
): void {
  try {
    const path = defaultEventsPath(stateDir);
    const payload: {
      ts: number;
      event: string;
      backend: string;
      p95Ms: number | null;
      budgetOk: boolean;
      platform: string;
      demotionReason?: string;
    } = {
      ts: Date.now(),
      event: "vector_cortex_runtime_selected",
      backend: result.backend,
      p95Ms: result.p95Ms,
      budgetOk: result.budgetOk,
      platform: result.platform,
    };
    // ENC-0e: carry the demotion reason additively, only when present.
    if (result.demotionReason !== null && result.demotionReason !== undefined) {
      payload.demotionReason = result.demotionReason;
    }
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(payload) + "\n", "utf8");
  } catch {
    /* best-effort — never break the encoder loop */
  }
}
