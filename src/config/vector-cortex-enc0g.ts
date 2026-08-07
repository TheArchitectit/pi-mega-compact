/**
 * config/vector-cortex-enc0g.ts — ENC-0g Setup Cortex status route honest state.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts .. enc0f.ts and
 * the VC8C/VC9A-D/ML5A-E/DEDUP_ATTR siblings were. vector-cortex.ts re-exports
 * the flag below and root src/config.ts re-exports it, so no consumer import
 * path changes.
 *
 * ENC-0g makes the Setup Cortex status route honest: the status route reads the
 * latest ENC-0f `QualificationV1` record (when ENC_0F is ON and a record
 * exists) and lets its verdict override the structural verifyEncoderAsset
 * result for the `qualification` field; the blocker list becomes a pure
 * computed function over (platform, qualification record, manifest head-count)
 * with corrected HG statuses/wording; and VC9B action gating is re-derived from
 * the live computed blockers instead of the stale static manifest.
 *
 * `MEGACOMPACT_ENC_0G=0` disables: the status route derives its `qualification`
 * verdict from `verifyEncoderAsset(...).ok` alone, the blocker list is the
 * static `SETUP_CORTEX_BLOCKERS` array exactly as ENC-0f-era, and action gating
 * reads the static table as today — byte-identical to the predecessor. The flag
 * MUST also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0g — Setup Cortex status route honest state (verdict override + live
 * blockers + re-derived gating). Default ON. `MEGACOMPACT_ENC_0G=0` disables
 * and is byte-identical to the predecessor (ENC-0f): verdict from
 * `verifyEncoderAsset` alone, static `SETUP_CORTEX_BLOCKERS`, static
 * `setupCortexActionBlockers`. This flag MUST also be a dashboard SETTINGS
 * toggle (visible in config UI, never in EXCLUDED_SETTINGS), mirroring
 * ENC_0A/ENC_0B/ENC_0C/ENC_0D/ENC_0E/ENC_0F.
 */
export const ENC_0G_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0G");
