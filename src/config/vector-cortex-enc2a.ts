/**
 * config/vector-cortex-enc2a.ts — ENC-2a native onnxruntime install-guide flag
 * (operator run-script assist).
 *
 * Sibling of vector-cortex-enc1a.ts / vector-cortex-enc1b.ts /
 * vector-cortex-enc2budget.ts so vector-cortex.ts stays under the 300-line soft
 * limit (soft-as-hard gate). vector-cortex.ts re-exports the flag below and
 * root src/config.ts re-exports it, so no consumer import path changes.
 *
 * ENC-2a, when the operator opted into the native backend
 * (`MEGACOMPACT_ENCODER_NATIVE=1`) but `encoderBackend` is still `"wasm"`
 * (onnxruntime-node absent / not yet installed), surfaces an "Encoder Runtime
 * Install" card on the Cortex sub-tab with copy-paste operator commands: the
 * install + restart + verify steps built ONLY from the artifacts-module
 * constants (`src/vector-cortex/encoder/native-install-artifacts.ts`) — never
 * an inline registry URL or hash in the route (PREVENT-PI-004). The guide
 * renders only on an installable host platform; the ENC-0e darwin-x64 demotion
 * sentinel keeps it absent on an Intel Mac (no native binding upstream).
 *
 * `MEGACOMPACT_ENC_2A=0` disables: no guide fields, no install card, no absent
 * read — byte-identical to the ENC-1b predecessor. The flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS
 * — see `feedback_dashboard-flags-toggleable` memory).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-2a — operator run-script assist (dashboard install guide for the
 * onnxruntime-node native binding). Default ON. `MEGACOMPACT_ENC_2A=0` disables
 * and is byte-identical to the ENC-1b predecessor: no guide/absent fields, no
 * install card. This flag MUST also be a dashboard SETTINGS toggle (visible in
 * config UI, never in EXCLUDED_SETTINGS).
 */
export const ENC_2A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_2A");
