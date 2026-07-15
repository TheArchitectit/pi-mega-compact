/**
 * config.ts — shared default paths/constants for the mega-compact engine.
 *
 * Kept tiny and dependency-free so both the extension entry and unit tests can
 * import it without pulling in pi runtime types.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Default on-disk location for checkpoints + session state. */
export const STATE_DIR_DEFAULT = join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");

/** Pi custom message / entry type used as the dedup sentinel. */
export const MARKER_TYPE = "mega-compact-marker";

/**
 * Derive context-window pressure (0–1) from a usage percentage. Used to scale
 * compression strength + keepFrom depth (Fix E): low pct = room to spare,
 * high pct = near the limit. Deterministic; clamps to [0,1].
 */
export function pressureFromPct(pct: number | null | undefined): number {
  if (pct == null || Number.isNaN(pct)) return 0;
  return pct < 0 ? 0 : pct > 100 ? 1 : pct / 100;
}

/**
 * Map pressure → how many recent messages to preserve verbatim. Under low
 * pressure we keep `preserveRecent`; under high pressure we compact deeper,
 * down to `preserveRecentMin`. Never splits a tool pair / anchor floor — the
 * boundary guard (computeDropRange) enforces that downstream.
 */
export function preserveRecentForPressure(
  pressure: number,
  preserveRecent: number,
  preserveRecentMin: number,
): number {
  const p = pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
  const v = Math.round(preserveRecent - (preserveRecent - preserveRecentMin) * p);
  return Math.max(preserveRecentMin, Math.min(preserveRecent, v));
}
