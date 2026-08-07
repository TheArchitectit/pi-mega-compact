/**
 * dashboard-server/routes-setup-enc2budget.ts — ENC-2a operator-configurable
 * native onnxruntime install budget (MiB) Settings read/write + the additive
 * writer branch.
 *
 * Extracted out of routes-setup.ts (which hovers at the 300-line source soft
 * cap, mirroring the ENC-1a/ENC-1b sibling extracts) so the ENC-2a additive
 * read/write of the per-repo `.mega-compact.env` key lives in a sibling impl
 * file. One key is managed here: `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` — the exact
 * name `installBudgetMib()` (`src/vector-cortex/encoder/decision.ts`) reads at
 * runtime.
 *
 * The write is create-or-append: it upserts the key into the existing per-repo
 * `.mega-compact.env`, preserving every unrelated line and never deleting
 * another key. The read reports the persisted raw string AND the effective
 * integer `installBudgetMib()` resolves to (so the dashboard shows what the
 * runtime will actually use — including the 300 MiB default fallback when the
 * knob is unset or invalid). Reader-only: setter/getter never reimplements
 * `installBudgetMib()`'s clamp rule, it imports it.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem reads/writes only — zero
 * network), PREVENT-001 (null-safe), PREVENT-011 (no `any`).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ENC_2BUDGET_ENABLED,
  ENC_2BUDGET_MAX_MIB,
  ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV,
} from "../../src/config/vector-cortex.js";
import {
  installBudgetMib,
  resolveInstallBudgetMib,
} from "../../src/vector-cortex/encoder/decision.js";
import type { SetupConfigureRequest } from "./api-contracts/setup.js";

function envPath(stateDir: string): string {
  return join(stateDir, ".mega-compact.env");
}

/** Extract the value of `export MEGACOMPACT_X="..."` (or unquoted) from a line. */
function lineValue(line: string, key: string): string | null {
  const m = line.match(new RegExp(`^export\\s+${key}=(.*)$`));
  if (!m) return null;
  const rest = m[1].trim();
  if (rest.length === 0) return null;
  const q = rest.match(/^"([^"]*)"$/);
  return q ? q[1] : rest;
}

/** True when the payload carries the ENC-2a key (flag-gated). */
export function wantsEnc2Budget(body: SetupConfigureRequest): boolean {
  return ENC_2BUDGET_ENABLED() && typeof body.nativeOrtBudgetMib === "string";
}

/** Read the ENC-2a knob from the per-repo `.mega-compact.env`. Returns the raw
 *  persisted string when present, or null when absent. */
export function readEnc2BudgetEnv(stateDir: string): { raw: string | null } {
  try {
    const p = envPath(stateDir);
    if (!existsSync(p)) return { raw: null };
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const v = lineValue(line, ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV);
      if (v !== null && v.length > 0) return { raw: v };
    }
    return { raw: null };
  } catch {
    return { raw: null };
  }
}

/**
 * ENC-2a additive GET status fields. Omitted when flag-off. Surfaces the raw
 * persisted value (when set) AND the effective runtime operand — the integer
 * MiB `installBudgetMib()` actually resolves to. Reading `installBudgetMib()`
 * here (instead of reimplementing the clamp) keeps the dashboard honest when
 * the env var is unset or out-of-range.
 */
export function enc2BudgetStatusFields(stateDir: string): {
  nativeOrtBudgetMib?: string;
  nativeOrtBudgetEffectiveMib?: string;
} {
  if (!ENC_2BUDGET_ENABLED()) return {};
  const { raw } = readEnc2BudgetEnv(stateDir);
  // The EFFECTIVE operand is what the runtime WILL use: if a value has been
  // persisted to the disk file, resolve THAT through the clamp (the operator
  // just POSTed it; the running process has not re-sourced `.mega-compact.env`
  // yet so `installBudgetMib()` reads the stale env). On restart the saved
  // value is what the runtime loads. When nothing is persisted, fall back to
  // the live env var / process.env (= `installBudgetMib()`).
  const effective = raw !== null ? resolveInstallBudgetMib(raw) : installBudgetMib();
  return {
    ...(raw !== null ? { nativeOrtBudgetMib: raw } : {}),
    nativeOrtBudgetEffectiveMib: String(effective),
  };
}

/** Upsert the ENC-2a knob into the per-repo `.mega-compact.env`. Creates the
 *  file if absent; preserves every unrelated line; never deletes other keys.
 *  `entries.raw === null` leaves the key's line untouched. */
export function writeEnc2BudgetEnv(
  stateDir: string,
  entries: { raw?: string | null },
): string {
  const p = envPath(stateDir);
  const existingLines: string[] = existsSync(p) ? readFileSync(p, "utf8").split(/\r?\n/) : [];
  const out: string[] = [];
  let written = false;
  for (const line of existingLines) {
    if (
      entries.raw !== null &&
      entries.raw !== undefined &&
      lineValue(line, ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV) !== null
    ) {
      out.push(`export ${ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV}="${entries.raw}"`);
      written = true;
      continue;
    }
    out.push(line);
  }
  if (entries.raw !== null && entries.raw !== undefined && !written) {
    out.push(`export ${ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV}="${entries.raw}"`);
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(p, out.join("\n"), "utf-8");
  return p;
}

/** Validate `nativeOrtBudgetMib` as a positive integer string within
 *  `ENC_2BUDGET_MAX_MIB`. Returns `null` when valid, else the error code.
 *  Exported so the routes host (combined-payload path) and the aggregator share
 *  the same rule. */
export function validateNativeOrtBudgetMib(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return "invalid_native_ort_budget_mib";
  if (!/^\d+$/.test(value)) return "invalid_native_ort_budget_mib";
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > ENC_2BUDGET_MAX_MIB) {
    return "invalid_native_ort_budget_mib";
  }

  return null;
}

/**
 * Combined-payload upsert: after the main embedder write has freshly written
 * the per-repo env, append the ENC-2a key when carried alongside a valid
 * embedder selection (flag-gated, additive). No-op when flag-off or no ENC-2a
 * key present.
 */
export function tryEnc2BudgetInto(stateDir: string, body: SetupConfigureRequest): void {
  if (!wantsEnc2Budget(body)) return;
  writeEnc2BudgetEnv(stateDir, {
    raw: typeof body.nativeOrtBudgetMib === "string" ? body.nativeOrtBudgetMib : null,
  });
}

/**
 * Combined-path validation: the routes host runs this before the combined
 * upsert when a payload ALSO carries a valid embedder — returned as the error
 * code string, or `null` if validation passes (or the flag is off).
 */
export function enc2BudgetValidateCombined(body: SetupConfigureRequest): string | null {
  if (!ENC_2BUDGET_ENABLED()) return null;
  if (body.nativeOrtBudgetMib !== undefined) {
    const e = validateNativeOrtBudgetMib(body.nativeOrtBudgetMib);
    if (e !== null) return e;
  }
  return null;
}
