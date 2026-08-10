/**
 * config/vector-cortex-vc9b.ts — VC9B setup-cortex action-drivers sprint flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts was. This is the
 * SETUP-DASHBOARD action flag (the dashboard Setup tab fetch/bench/verify action
 * drivers). vector-cortex.ts re-exports it below and root src/config.ts
 * re-exports it, so no consumer import path changes.
 *
 * The split is purely mechanical: VC9B_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * VC9B — Setup Cortex action drivers (POST /api/setup-cortex-action +
 * GET /api/setup-cortex-action-log). Default ON. `MEGACOMPACT_VC9B=0` disables
 * and is byte-identical to the predecessor (VC9A-era): the action POST returns
 * the disabled shape (404/disabled) and flag-off bytes are unchanged. The
 * actions run in-process: fetch-model downloads via HTTPS (opt-in, confirm-gated)
 * and bench runs ONNX inference directly — no subprocess spawns. verify-asset
 * re-reads the committed encoder assets; install-native-ort uses the npm-delegated
 * install (PREVENT-PI-004 opt-in). Never payload bytes.
 * This flag MUST also be a dashboard SETTINGS toggle (visible in config UI,
 * never in EXCLUDED_SETTINGS), mirroring VC9A.
 */
export const VC9B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC9B");
