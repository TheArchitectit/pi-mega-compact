/**
 * config/vector-cortex-enc0f.ts — ENC-0f p95 + marginal-RSS qualification gate.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as vector-cortex-enc0a.ts / enc0b.ts /
 * enc0c.ts / enc0d.ts / enc0e.ts and the VC8C/VC9A-D/ML5A-E/DEDUP_ATTR
 * siblings were. vector-cortex.ts re-exports the flag below and root
 * src/config.ts re-exports it, so no consumer import path changes.
 *
 * ENC-0f closes HG-5 (RSS margin) with a real asset: the qualification gate
 * that admits the ENC-0d-promoted trained asset to mode A. The gate runs the
 * ML5-B bench under --expose-gc and asserts p95 ≤ ENCODER_LATENCY_P95_MS
 * (40 ms @ 512 tokens / 4 threads), marginal RSS ≤ ENCODER_RSS_BUDGET_BYTES
 * (150 MiB, baseline-subtracted), determinism (distinct digests == 1), and
 * the opset-21 handshake. On pass it emits a QualificationV1 record that flips
 * the runtime to qualified mode A; on any failure the asset stays demoted.
 *
 * `MEGACOMPACT_ENC_0F=0` disables the gate entirely: no qualification gate
 * runs, no QualificationV1 record is written for the real trained asset, and
 * the runtime keeps serving the ENC-0d survivor. Flag-off is byte-identical to
 * the predecessor. The flag MUST also be a dashboard SETTINGS toggle (visible
 * in config UI, never in EXCLUDED_SETTINGS).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-0f — p95 + marginal-RSS qualification gate for the real trained asset.
 * Default ON. `MEGACOMPACT_ENC_0F=0` disables and is byte-identical to the
 * predecessor (ENC-0e): no qualification gate runs, no QualificationV1 record
 * is written for the real trained asset, and the runtime keeps serving the
 * ENC-0d survivor. This flag MUST also be a dashboard SETTINGS toggle (visible
 * in config UI, never in EXCLUDED_SETTINGS), mirroring
 * ENC_0A/ENC_0B/ENC_0C/ENC_0D/ENC_0E.
 */
export const ENC_0F_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_0F");
