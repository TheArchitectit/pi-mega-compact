/**
 * config/vector-cortex-vc9c.ts — VC9C SetupTab Cortex sub-tab sprint flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts and
 * vector-cortex-vc9b.ts were. This is the SETUP-DASHBOARD UI flag (the Cortex
 * sub-tab inside SetupTab). vector-cortex.ts re-exports it below and root
 * src/config.ts re-exports it, so no consumer import path changes.
 *
 * The split is purely mechanical: VC9C_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * The client gates the Cortex sub-tab's visible state on the flag via the
 * VC0E honest-status pattern: when the VC9A status payload reports the
 * off/disabled shape (or VC9C is off), the sub-tab is filtered from
 * SUB_TABS. Flag-off is byte-identical to the predecessor (VC9B-era).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * VC9C — SetupTab Cortex sub-tab (client UI). Default ON. `MEGACOMPACT_VC9C=0`
 * disables and is byte-identical to the predecessor (VC9B-era): the Cortex
 * sub-tab is filtered from SUB_TABS and the Setup tab renders exactly as it
 * did before this sprint. The sub-tab is a pure consumer of the VC9A status
 * endpoint (GET /api/setup-cortex-status) + VC9B action endpoints (POST
 * /api/setup-cortex-action, GET /api/setup-cortex-action-log); it adds NO
 * server logic and never surfaces payload bytes/prompts/ledger. This flag MUST
 * also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC9A/VC9B.
 */
export const VC9C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC9C");
