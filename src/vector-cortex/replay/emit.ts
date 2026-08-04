/**
 * vector-cortex/replay/emit.ts — VC0B replay emit seam (VC0B).
 *
 * The single structured-event surface for the replay/effective-cut path. It is
 * the replay analogue of the VC0A eval observer (`src/vector-cortex/eval/
 * observer.ts`): the same non-fatal, structured-JSON `ts`+`event` contract
 * (see `src/log.ts` LogEntry), delivered through an injected emit callback so it
 * stays pi-agnostic, deterministically testable, and network-free
 * (PREVENT-PI-004). A future VC0C breaker/dashboard consumes these lines.
 *
 * This is deliberately MINIMAL — it is NOT a second metrics pipeline. It carries
 * only the two events the replay/effective-cut path emits:
 *   - vector_cortex_replay_cut_retreat     (a pair/anchor/lowest-source retreat)
 *   - vector_cortex_replay_highwater_frozen (mode C: host transcript unchanged)
 *
 * Flag gating: this is VC0B's single real consumer of `VC0B_ENABLED`. When the
 * flag is OFF, the reporter emits NOTHING (zero observability writes) — mirroring
 * the VC0A mode-C pattern where flag-off produces zero evaluation writes. The
 * ReplayReportV2 data (cut/effectiveSeq/capturedHighWater/mode) is returned by
 * `runReplayV2` regardless; only the emitted observability is gated. The flag is
 * read per-call so a live toggle takes effect immediately.
 */

import { VC0B_ENABLED } from "../../config/vector-cortex.js";

export type ReplayEventName =
  | "vector_cortex_replay_cut_retreat"
  | "vector_cortex_replay_highwater_frozen";

/** Injected emit callback — same (event, fields) shape as the eval observer. */
export type ReplayEmitter = (event: string, fields: Record<string, unknown>) => void;

export interface ReplayCutRetreatFields {
  readonly session: string;
  readonly code: string;
  readonly fromSeq: string;
  readonly toSeq: string;
}

export interface ReplayHighWaterFrozenFields {
  readonly session: string;
  readonly committedSeq: string;
  readonly frozenHighWater: string;
}

/** Typed, best-effort reporter bound to the two replay event names. */
export interface ReplayReporter {
  readonly cutRetreat: (fields: ReplayCutRetreatFields) => void;
  readonly highWaterFrozen: (fields: ReplayHighWaterFrozenFields) => void;
}

function safe(fn: (event: ReplayEventName, fields: Record<string, unknown>) => void): (
  event: ReplayEventName,
  fields: Record<string, unknown>,
) => void {
  return (event, fields) => {
    try {
      fn(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };
}

/**
 * Build a typed reporter over an injected emit callback. Observability emission
 * is gated on `VC0B_ENABLED()` — flag OFF means zero replay observability writes
 * (VC0A mode-C parity). `emit` is optional: absent (or flag off) degrades to a
 * no-op. The flag is read per-call so a live toggle takes effect immediately.
 */
export function createReplayReporter(emit?: ReplayEmitter): ReplayReporter {
  const fire = safe((event, fields) => {
    if (VC0B_ENABLED()) emit?.(event, fields);
  });
  return {
    cutRetreat(fields) {
      fire("vector_cortex_replay_cut_retreat", fields as unknown as Record<string, unknown>);
    },
    highWaterFrozen(fields) {
      fire("vector_cortex_replay_highwater_frozen", fields as unknown as Record<string, unknown>);
    },
  };
}

/** Export the event names for consumers that match on them. */
export const REPLAY_EVENTS: readonly ReplayEventName[] = [
  "vector_cortex_replay_cut_retreat",
  "vector_cortex_replay_highwater_frozen",
] as const;
