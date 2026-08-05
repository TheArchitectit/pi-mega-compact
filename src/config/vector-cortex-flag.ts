/**
 * config/vector-cortex-flag.ts — the single positive sprint-flag reader.
 *
 * Extracted from vector-cortex.ts so the flag groups split across
 * vector-cortex.ts and vector-cortex-early.ts share ONE definition of what
 * "enabled" means. Duplicating this three-line function into each group would
 * be the classic way a sprint flag silently acquires different off-semantics in
 * different files; there is exactly one implementation and both groups import it.
 *
 * Semantics (unchanged, byte-identical to the original in-place definition):
 * every sprint flag is POSITIVE and defaults ON. `MEGACOMPACT_<SPRINT>=0` or
 * `=false` disables it, as does `MEGACOMPACT_<SPRINT>_DISABLED=true`/`=1`.
 *
 * Pi-agnostic, dependency-free (PREVENT-PI-004 / PREVENT-011).
 */

/** Positive sprint flag: `=0` or `_DISABLED=true` disables (default ON). */
export function sprintFlag(name: string): boolean {
  const v = process.env[name];
  if (v === "0" || v === "false") return false;
  const disabled = process.env[name + "_DISABLED"];
  if (disabled === "true" || disabled === "1") return false;
  return true;
}
