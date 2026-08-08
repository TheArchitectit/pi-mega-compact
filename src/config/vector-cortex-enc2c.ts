/**
 * config/vector-cortex-enc2c.ts — ENC-2c native onnxruntime lazy-download
 * install-action flag (dashboard-triggered install).
 *
 * Sibling of vector-cortex-enc2a.ts / vector-cortex-enc2b.ts so vector-cortex.ts
 * stays under the 300-line soft limit (soft-as-hard gate). vector-cortex.ts
 * re-exports the flag below and root src/config.ts re-exports it, so no consumer
 * import path changes.
 *
 * ENC-2c turns ENC-2a's operator run-script assist into a dashboard action: the
 * Setup Cortex sub-tab gains an "Install Native ORT" button that, when confirmed
 * by the operator, runs the committed `scripts/encoder/install-native-ort.mjs`
 * subprocess locally (npm-delegated, sha256-verified) and then re-qualifies the
 * binding via the ENC-2b retest path. This is a PREVENT-PI-004 opt-in exemption:
 * it is confirm-gated (never automatic), delegated to a local subprocess of a
 * committed repo script, and carries NO URL literals in src/ or extensions/
 * (the registry URL + sha256 live only in the artifacts-module constants).
 *
 * `MEGACOMPACT_ENC_2C=0` disables: no install action branch, no UI button, no
 * install-related result fields — byte-identical to the ENC-2b predecessor. The
 * flag MUST also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS — see `feedback_dashboard-flags-toggleable` memory).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 *
 * guardrails-allow PREVENT-PI-004: opt-in confirm-gated install action;
 * delegates to local npm install subprocess, no URL literals (registry URL +
 * sha256 live only in native-install-artifacts.ts)
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-2c — lazy-download native onnxruntime install action (dashboard-triggered,
 * npm-delegated, confirm-gated). Default ON. `MEGACOMPACT_ENC_2C=0` disables and
 * is byte-identical to the ENC-2b predecessor: no install action POST branch, no
 * UI button, no install result fields. This flag MUST also be a dashboard SETTINGS
 * toggle (visible in config UI, never in EXCLUDED_SETTINGS).
 */
export const ENC_2C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_2C");
