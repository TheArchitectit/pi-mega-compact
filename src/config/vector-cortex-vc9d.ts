/**
 * config/vector-cortex-vc9d.ts — VC9D embedder-detect consolidation sprint flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-vc9a.ts..vector-cortex-vc9c.ts
 * were. This is the SETUP-DASHBOARD consolidation flag (the embedder-detect
 * memoization + the shared 5s embedder poll). vector-cortex.ts re-exports it
 * below and root src/config.ts re-exports it, so no consumer import path
 * changes.
 *
 * The split is purely mechanical: VC9D_ENABLED is byte-identical in name,
 * semantics, and default to the definition it replaces, and vector-cortex.ts
 * re-exports it so every existing `from "./config/vector-cortex.js"` import
 * keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * VC9D — embedder detect consolidation + conformance roll-up. Default ON.
 * `MEGACOMPACT_VC9D=0` disables and is byte-identical to the predecessor
 * (VC9C-era): /api/setup-detect spawns its detectors fresh per request (no
 * memoization) and the embedder sub-tab keeps its previous poll cadence. When
 * ON, the detect path is memoized against the mutable input (resolved binary
 * path + mtime) so consecutive requests reuse the result without re-spawning,
 * and the embedder + cortex sub-tabs share the 5s poll contract. Detection is
 * READ-ONLY — local binary spawns + filesystem stat only, no network
 * (PREVENT-PI-004), never payload bytes/prompts/ledger (EVAL-REDACT-002). This
 * flag MUST also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS), mirroring VC9A/VC9B/VC9C.
 */
export const VC9D_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_VC9D");
