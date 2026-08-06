/**
 * config/vector-cortex-ml5b.ts — ML5-B production bench harness flag.
 *
 * Sibling extract mirroring vector-cortex-ml5a.ts, so vector-cortex.ts stays
 * under its 300-line soft limit (soft-as-hard gate). This is the ONNX Runtime
 * evaluation/benchmark sprint flag. vector-cortex.ts re-exports the ENUM below
 * and root src/config.ts re-exports it, so no consumer import path changes.
 *
 * ML5-B introduces NO runtime code path: the bench harness and corpus export
 * are developer/evidence tooling (scripts/) plus a consumer-facing TypeScript
 * shell (src/vector-cortex/encoder/bench.ts) that only writes monitoring
 * events. The flag records intent and scopes the sprint's evidence assets; it
 * gates nothing at runtime today. There is no HTTP endpoint and no dashboard
 * change, so there is no SETTINGS toggle and no EXCLUDED_SETTINGS interaction.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ML5-B — production bench harness (ONNX Runtime eval). Default ON.
 * `MEGACOMPACT_ML5_B=0` disables and is byte-identical to the ML5-A survivor:
 * no bench endpoint exists and mode B continues to serve all clients exactly as
 * before. The flag does not gate the harness itself — the harness is an on-demand
 * developer tool with no runtime path.
 */
export const ML5B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ML5_B");
