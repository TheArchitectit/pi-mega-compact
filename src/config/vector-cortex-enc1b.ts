/**
 * config/vector-cortex-enc1b.ts — ENC-1b ONNX runtime backend + embedder API
 * Settings fields.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as the ENC-1a sibling was. vector-cortex.ts
 * re-exports the flag + constants below and root src/config.ts re-exports them,
 * so no consumer import path changes.
 *
 * ENC-1b adds two Settings surfaces. (A) Embedder API completion: the three
 * remaining env vars the runtime reads (src/httpEmbedder.ts:embeddingConfigFromEnv)
 * gain dashboard-visible fields — `MEGACOMPACT_EMBEDDING_DIM` (numeric, validated
 * positive int bounded by `ENC_1B_MAX_EMBEDDING_DIM`), `MEGACOMPACT_EMBEDDING_HEADERS`
 * (JSON object string — secret-bearing, written verbatim to the per-repo
 * `.mega-compact.env`, NEVER echoed raw; the GET reports only a boolean
 * presence marker), and `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER` (boolDirect toggle,
 * default off — a deliberate escape hatch that skips the loopback-only check).
 * (B) ONNX runtime selection surface: `MEGACOMPACT_ENCODER_NATIVE` is persisted
 * to the per-repo env + surfaced as a Settings toggle, and the GET status route
 * computes the current effective backend + demotion reason through the existing
 * `selectRuntimeBackend` (reader-only — no selection literals reimplemented).
 *
 * `MEGACOMPACT_ENC_1B=0` disables: no new GET fields, no writer branch, no new
 * Settings rows or toggle — byte-identical to the ENC-1a predecessor. The flag
 * MUST also be a dashboard SETTINGS toggle (visible in config UI, never in
 * EXCLUDED_SETTINGS).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/** ENC-1b `MEGACOMPACT_EMBEDDING_DIM` upper bound (positive integer string). */
export const ENC_1B_MAX_EMBEDDING_DIM = 8192;

/** Persisted env names pinned here so the aggregator scan + the routes share
 *  one source of truth (exactly the names embeddingConfigFromEnv reads). */
export const ENC_1B_EMBEDDING_DIM_ENV = "MEGACOMPACT_EMBEDDING_DIM";
export const ENC_1B_EMBEDDING_HEADERS_ENV = "MEGACOMPACT_EMBEDDING_HEADERS";
export const ENC_1B_ALLOW_REMOTE_EMBEDDER_ENV = "MEGACOMPACT_ALLOW_REMOTE_EMBEDDER";
export const ENC_1B_ENCODER_NATIVE_ENV = "MEGACOMPACT_ENCODER_NATIVE";

/**
 * ENC-1b — ONNX runtime backend + embedder API Settings fields. Default ON.
 * `MEGACOMPACT_ENC_1B=0` disables and is byte-identical to the ENC-1a
 * predecessor: no new GET fields, no writer branch, no new Settings rows or
 * toggle. This flag MUST also be a dashboard SETTINGS toggle (visible in config
 * UI, never in EXCLUDED_SETTINGS).
 */
export const ENC_1B_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_1B");
