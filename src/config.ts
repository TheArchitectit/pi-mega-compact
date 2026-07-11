/**
 * config.ts — shared default paths/constants for the mega-compact engine.
 *
 * Kept tiny and dependency-free so both the extension entry and unit tests can
 * import it without pulling in pi runtime types.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Default on-disk location for checkpoints + session state. */
export const STATE_DIR_DEFAULT = join(homedir(), ".pi", "agent", "extensions", "mega-compact");

/** Pi custom message / entry type used as the dedup sentinel. */
export const MARKER_TYPE = "mega-compact-marker";
