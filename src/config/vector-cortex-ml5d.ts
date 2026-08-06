/**
 * config/vector-cortex-ml5d.ts — ML5-D dashboard "Improve Cortex" flag.
 *
 * Sibling extract mirroring vector-cortex-ml5a.ts / vector-cortex-ml5b.ts /
 * vector-cortex-ml5c.ts, so vector-cortex.ts stays under its 300-line soft
 * limit (soft-as-hard gate). This is the dashboard "Improve Cortex" surface +
 * promote workflow sprint flag.
 * vector-cortex.ts re-exports the ENUM below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ML5-D adds the dashboard ModelImprovementCard + the POST /api/cortex/improve
 * and GET /api/cortex/improve/status/:jobId endpoints. The flag gates that
 * surface only; when OFF the endpoints return 404/disabled and VectorCortexTab
 * renders exactly as before (byte-identical to the ML5-C-era tab — no
 * ModelImprovementCard, no improve job is ever spawned).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ML5-D — dashboard "Improve Cortex" surface + promote workflow. Default ON.
 * `MEGACOMPACT_ML5_D=0` disables and is byte-identical to the ML5-C survivor:
 * both `/api/cortex/improve*` endpoints return 404 and VectorCortexTab omits the
 * ModelImprovementCard. The flag gates the dashboard surface only; it does not
 * gate the underlying ML5-A training pipeline or the encoder's mode-A/B/C
 * selection (those are governed by ML5-A and the encoder independently).
 */
export const ML5D_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ML5_D");
