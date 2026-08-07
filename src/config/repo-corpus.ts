/**
 * config/repo-corpus.ts — REPO-A cross-repo corpus preparation sprint flag.
 *
 * Positive sprint flag sibling (mirrors config/vector-cortex-cosfp.ts), NOT under
 * a vector-cortex- prefix per the REPO-A spec: the reader route + corpus-builder
 * gate on this flag. Root src/config.ts re-exports it so every existing import
 * keeps resolving unchanged. Pi-agnostic, dependency-free (PREVENT-PI-004 /
 * PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/**
 * REPO-A — cross-repo corpus preparation. Default ON.
 * `MEGACOMPACT_REPO_CORPUS=0` disables and is byte-identical to the predecessor:
 * the reader route GET /api/repo-corpus 404s (no derived artifact written), the
 * corpus-builder refuses to run, and the existing single-repo recall path is
 * untouched. This flag MUST also be a dashboard SETTINGS toggle (visible in the
 * config UI, never in EXCLUDED_SETTINGS). The builder + route perform only local
 * filesystem reads / local `git` introspection (PREVENT-PI-004).
 */
export const REPO_CORPUS_ENABLED = (): boolean =>
  sprintFlag("MEGACOMPACT_REPO_CORPUS");
