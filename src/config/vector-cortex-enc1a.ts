/**
 * config/vector-cortex-enc1a.ts — ENC-1a external embedder API key + endpoint
 * Settings fields.
 *
 * Extracted from vector-cortex.ts so that file stays under the 300-line soft
 * limit (soft-as-hard gate), exactly as the ENC-0a..ENC-0g siblings were.
 * vector-cortex.ts re-exports the flag below and root src/config.ts re-exports
 * it, so no consumer import path changes.
 *
 * ENC-1a adds a Settings-visible field pair for the external embedder endpoint
 * URL + optional Bearer API key. The runtime already reads
 * `MEGACOMPACT_EMBEDDING_URL` and `MEGACOMPACT_EMBEDDING_KEY` from the process
 * env (src/httpEmbedder.ts:embeddingConfigFromEnv) and the Setup tab's
 * CustomEndpointSection already accepts a custom URL — but there is no
 * dashboard-visible API-key field and no server route persists the pair to the
 * per-repo `.mega-compact.env` so the session survives a restart. ENC-1a adds
 * two additive contract fields on GET /api/setup-status (`embeddingEndpointUrl`
 * echoed + `embeddingApiKeySet` boolean only — the raw key is NEVER returned),
 * an additive writer branch on POST /api/setup-configure accepting
 * `embeddingEndpointUrl` / `embeddingApiKey`, and two additive Setup text rows.
 *
 * `MEGACOMPACT_ENC_1A=0` disables: the Settings panel renders no ENC-1a text
 * fields (only the existing boolDirect toggles remain), the GET body omits the
 * two new fields, and the POST handler does not recognize the new keys —
 * byte-identical to the ENC-0g predecessor. The flag MUST also be a dashboard
 * SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS).
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * ENC-1a — external embedder API key + endpoint Settings fields. Default ON.
 * `MEGACOMPACT_ENC_1A=0` disables and is byte-identical to the predecessor
 * (ENC-0g): no new GET fields, no writer branch, no new Setup text rows (only
 * the existing boolDirect toggles remain). This flag MUST also be a dashboard
 * SETTINGS toggle (visible in config UI, never in EXCLUDED_SETTINGS), mirroring
 * ENC_0A..ENC_0G.
 */
export const ENC_1A_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_ENC_1A");
