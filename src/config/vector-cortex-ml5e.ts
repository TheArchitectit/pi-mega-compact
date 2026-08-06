/**
 * config/vector-cortex-ml5e.ts — ML5-E nightly retraining cron + feedback loop.
 *
 * Sibling extract mirroring vector-cortex-ml5a.ts / ml5b.ts / ml5c.ts / ml5d.ts,
 * so vector-cortex.ts stays under its 300-line soft limit (soft-as-hard gate).
 * vector-cortex.ts re-exports the ENUM below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ML5-E turns one-shot training (ML5-D's Improve button) into a living loop:
 * the user's own post-redaction conversation turns become fresh training signal,
 * the five heads are re-fit nightly, calibration is re-validated, and mode-A
 * promotion is re-checked without human intervention. The cron is system-
 * configured (`crontab -e` on the operator device); the extension never installs
 * or writes a crontab. The flag gates **invocation** only — the scripts
 * (retrain-nightly.mjs, promotion-gate.mjs, promotion.ts) exist on disk
 * regardless; `=0` means the runtime never invokes them and the dashboard's
 * Improve Cortex flow is byte-identical to the ML5-D survivor.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ML5-E — nightly retraining cron + feedback loop. Default ON.
 * `MEGACOMPACT_ML5_E=0` disables and is byte-identical to the ML5-D survivor:
 * the nightly retraining scripts are never invoked by the runtime, the
 * promotion gate is inert, and the dashboard's Improve Cortex flow is
 * byte-identical to the ML5-D tab. The flag gates invocation only — the scripts
 * exist on disk regardless.
 */
export const ML5E_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ML5_E");
