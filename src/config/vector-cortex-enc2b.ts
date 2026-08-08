/**
 * config/vector-cortex-enc2b.ts — ENC-2b native onnxruntime qualification
 * retest flag.
 *
 * Sibling of vector-cortex-enc2a.ts / vector-cortex-enc2budget.ts so
 * vector-cortex.ts stays under the 300-line soft limit (soft-as-hard gate).
 * vector-cortex.ts re-exports the flag below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ENC-2b re-probes and re-qualifies the installed native onnxruntime binding
 * (`onnxruntime-node` in `~/.pi/mega-compact/native-ort/`, operator-installed
 * via the ENC-2a guide). When the operator installs the binding the read path
 * does not automatically re-evaluate the qualification verdict; this sprint
 * delivers a reader-only retest that loads the LOCAL on-disk binding, runs a
 * bounded warmup + p95 probe against it, measures RSS, computes a fresh
 * qualification verdict against the ENC-0f p95 budget + the operator
 * install-budget, and surfaces it on the Setup Cortex sub-tab and the GET
 * `/api/setup-status` response.
 *
 * `MEGACOMPACT_ENC_2B=0` disables: the GET omits both new retest fields, the
 * POST ignores the retest-request key, the Cortex sub-tab renders no retest
 * card — byte-identical to the ENC-2a predecessor. The flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS
 * — see `feedback_dashboard-flags-toggleable` memory).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-2b — native onnxruntime qualification retest (detect installed binding,
 * re-probe p95/RSS, re-qualify). Default ON. `MEGACOMPACT_ENC_2B=0` disables and
 * is byte-identical to the ENC-2a predecessor: no retest GET fields, no retest
 * POST branch, no retest card. This flag MUST also be a dashboard SETTINGS
 * toggle (visible in config UI, never in EXCLUDED_SETTINGS).
 */
export const ENC_2B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_2B");
