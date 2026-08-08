/**
 * vector-cortex/livewire/livewire-snapshot.ts — LIVEWIRE aggregate persistence.
 *
 * The four LV subsytems are in-process live objects, but the dashboard server may
 * run in a SEPARATE process from the runtime that accumulates the counts. To keep
 * the reader-only routes honest when they run in their own process, this module
 * persists a COUNT-ONLY aggregate snapshot (`vector-cortex-livewire.json`) to the
 * per-repo `stateDir`, and `openLivewire` rehydrates a fresh process from it on
 * first access. This is the same DR-snapshot philosophy as the legacy JSON
 * checkpoints, but reduced to counts + codes (SECURITY_PRIVACY — see these types).
 *
 * BEST-EFFORT + NON-FATAL. A failed write is logged as a structured event and
 * never breaks the agent loop; a missing/unreadable snapshot reads as null and
 * the process starts from zero (matches the non-fatal-stores invariant). Every
 * write is atomic-ish: the JSON is fully serialized to a temp name then renamed
 * so a reader never observes a partial snapshot.
 *
 * PREVENT-PI-004: local filesystem read/write only, no network. PREVENT-011: no
 * `any`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LivewireSnapshot } from "./livewire-types.js";

/** The snapshot filename in the per-repo stateDir (counts + codes only). */
export const LIVEWIRE_SNAPSHOT_FILE = "vector-cortex-livewire.json";

/** Resolve the snapshot path for a stateDir. */
export function livewireSnapshotPath(stateDir: string): string {
  return join(stateDir, LIVEWIRE_SNAPSHOT_FILE);
}

/**
 * Best-effort type guard over a parsed snapshot. Rejects anything that is not
 * the exact aggregate shape so a corrupted or stale file cannot poison the
 * rehydrated counters.
 */
function isSnapshot(value: unknown): value is LivewireSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s.schema === "vector-cortex-livewire-v1" &&
    typeof s.crystals === "object" &&
    s.crystals !== null &&
    typeof s.diagnostics === "object" &&
    s.diagnostics !== null &&
    typeof s.economics === "object" &&
    s.economics !== null &&
    typeof s.policy === "object" &&
    s.policy !== null
  );
}

/**
 * Read the persisted aggregate for a stateDir, or null when absent/unreadable/
 * malformed. Best-effort and non-fatal by construction.
 */
export function loadLivewireSnapshot(stateDir: string): LivewireSnapshot | null {
  const path = livewireSnapshotPath(stateDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort write of the aggregate snapshot (atomic rename). Never throws to
 * the caller: a persistence failure logs a structured event and is swallowed.
 *
 * @param logger  optional structured logger `(line: unknown) => void`; when
 *                omitted no event is emitted (tests pass `undefined`).
 */
export function saveLivewireSnapshot(
  stateDir: string,
  snapshot: LivewireSnapshot,
  logger?: (line: unknown) => void,
): void {
  const dir = stateDir;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = livewireSnapshotPath(dir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    if (logger !== undefined) {
      try {
        logger({
          ts: new Date().toISOString(),
          event: "vector_cortex_livewire_snapshot_write_failed",
          stateDir,
          reason: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // A failing logger must not recurse into another failure.
      }
    }
  }
}
