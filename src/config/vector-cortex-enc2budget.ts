/**
 * config/vector-cortex-enc2budget.ts — ENC-2a operator-configurable native
 * onnxruntime install-budget knob (dashboard Settings surface).
 *
 * Sibling of vector-cortex-enc1a.ts / vector-cortex-enc1b.ts so vector-cortex.ts
 * stays under the 300-line soft limit (soft-as-hard gate). vector-cortex.ts
 * re-exports the flag + constants below and root src/config.ts re-exports them,
 * so no consumer import path changes.
 *
 * ENC-2a exposes the runtime's operator knob `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB`
 * as a dashboard Settings field. The knob itself is read at runtime by
 * `installBudgetMib()` (`src/vector-cortex/encoder/decision.ts`) and gates the
 * `budgetOk` decision in `src/vector-cortex/encoder/runtime-select.ts`. Setting
 * it persists to the per-repo `.mega-compact.env` via the same upsert-writer
 * path ENC-1a/ENC-1b use (never the global state dir — see the
 * `statedir-per-repo-vs-global` memory).
 *
 * Bounds (mirror `decision.ts` clamp): positive integer, 1..8192 MiB. Out-of-
 * range input is rejected by validation (400) and falls back to the default
 * (300) in `installBudgetMib()` at runtime. Default 300 MiB was set on
 * 2026-08-07 when the user lifted the prior 80 MiB restriction ("remove the
 * 80mb limit that wasn't my design decision" → "set it to a number that is in
 * the dashboard that defaults to lets say 300mb").
 *
 * `MEGACOMPACT_ENC_2BUDGET=0` disables: no new GET fields, no writer branch, no
 * new Settings rows — byte-identical to the ENC-1b predecessor. The flag MUST
 * also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS — see `feedback_dashboard-flags-toggleable` memory).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/** ENC-2a knob: persisted env name, read by `installBudgetMib()` at runtime. */
export const ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV = "MEGACOMPACT_NATIVE_ORT_BUDGET_MIB";

/** Upper bound on the budget (MiB). Mirrors decision.ts's clamp. */
export const ENC_2BUDGET_MAX_MIB = 8192;

/** Default budget (MiB) when the env var is unset or invalid. */
export const ENC_2BUDGET_DEFAULT_MIB = 300;

/**
 * ENC-2a — operator-configurable native install budget Settings surface.
 * Default ON. `MEGACOMPACT_ENC_2BUDGET=0` disables and is byte-identical to the
 * ENC-1b predecessor: no new GET fields, no writer branch, no new Settings rows.
 * This flag MUST also be a dashboard SETTINGS toggle (visible in config UI,
 * never in EXCLUDED_SETTINGS).
 */
export const ENC_2BUDGET_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_2BUDGET");
