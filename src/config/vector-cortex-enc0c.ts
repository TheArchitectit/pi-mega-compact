/**
 * config/vector-cortex-enc0c.ts — ENC-0c five-head supervision transfer flag.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts / enc0b.ts and
 * the VC8C/VC9A-D/ML5A-E/DEDUP_ATTR siblings were. vector-cortex.ts re-exports
 * the flag below and root src/config.ts re-exports it, so no consumer import
 * path changes.
 *
 * ENC-0c trains the five real heads onto the frozen ENC-0b bge-small trunk via
 * supervision transfer, and stages a qualified candidate under
 * ~/.pi/mega-compact-encoder/candidates/ (only when the developer trains it —
 * the extension never stages one by itself). When the flag is ON and a
 * qualified candidate exists, `loadHeadCandidate` (encoder/heads.ts seam) serves
 * the trained head weights; when the flag is OFF (MEGACOMPACT_ENC_0C=0) or no
 * candidate is staged, the heads keep serving the ENC-0b survivor exactly —
 * byte-identical, no weight change. The flag gates ONLY the candidate-load seam;
 * the survivor path is untouched.
 *
 * The split is purely mechanical: ENC_0C_ENABLED follows ENC_0B_ENABLED in name,
 * semantics, and default, and vector-cortex.ts re-exports it so every existing
 * `from "./config/vector-cortex.js"` import keeps resolving unchanged.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0c — five-head supervision transfer on the frozen bge-small trunk.
 * Default ON. `MEGACOMPACT_ENC_0C=0` disables and is byte-identical to the
 * predecessor (ENC-0b): no head candidate is loaded and the heads keep serving
 * the ENC-0b survivor defaults exactly as before. This flag MUST also be a
 * dashboard SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS),
 * mirroring ENC_0A and ENC_0B.
 */
export const ENC_0C_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0C");
