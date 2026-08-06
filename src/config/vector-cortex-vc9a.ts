/**
 * config/vector-cortex-vc9a.ts — VC9A setup-cortex status-read-path sprint flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc8c.ts,
 * vector-cortex-breakers.ts and vector-cortex-early.ts were. This is the
 * SETUP-DASHBOARD reader flag (the dashboard Setup tab cortex status endpoint).
 * vector-cortex.ts re-exports it below and root src/config.ts re-exports it, so
 * no consumer import path changes.
 *
 * The split is purely mechanical: VC9A_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * VC9A — Setup Cortex status read path (GET /api/setup-cortex-status).
 * Default ON. `MEGACOMPACT_VC9A=0` disables and is byte-identical to the
 * predecessor (VC8C-era shape): the endpoint returns `{enabled:false,
 * mode:"C", status:"off"}` and surfaces no qualification/blocker/health detail —
 * a pure reader-only projection, never a mutation. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring VC4A..VC8C. The dashboard reader itself performs only local
 * filesystem reads (no network, PREVENT-PI-004).
 */
export const VC9A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC9A");
