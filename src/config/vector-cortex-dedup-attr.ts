/**
 * config/vector-cortex-dedup-attr.ts — DEDUP-ATTR tier-attribution flag.
 *
 * The single positive sprint flag for the dedup tier-attribution rollup
 * (external-audit item #6). Default ON; `MEGACOMPACT_DEDUP_ATTR=0` / `=false` /
 * `_DISABLED=true` disables and is byte-identical to the predecessor: the
 * `/api/dedup-tier-attribution` endpoint 404s and no rollup cache file is
 * written.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

import { sprintFlag } from "./vector-cortex-flag.js";

/** Positive sprint flag: `=0` or `_DISABLED=true` disables (default ON). */
export const DEDUP_ATTR_ENABLED = (): boolean => sprintFlag("MEGACOMPACT_DEDUP_ATTR");
