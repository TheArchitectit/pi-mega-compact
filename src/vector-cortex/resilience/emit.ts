/**
 * vector-cortex/resilience/emit.ts — VC0C resilience emit seam (VC0C).
 *
 * The single structured-event surface for the live safety envelope: the breaker
 * opening/probing and frontier-freeze observability that a live provider path (or
 * dashboard) consumes. It mirrors the VC0B replay emit seam (`replay/emit.ts`)
 * and the VC0A eval observer: the same injected `(event, fields)` callback, the
 * same non-fatal `safe()` best-effort wrapper, and the same per-call
 * `VC0C_ENABLED()` gate. Absent emitter (or flag OFF) degrades to a no-op with
 * byte-identical predecessor behavior (PREVENT-PI-004, structured `ts`+`event`).
 *
 * Carries exactly the three events the sprint names:
 *   - vector_cortex_breaker_opened      (a breaker tripped to an OPEN state)
 *   - vector_cortex_probe_promoted      (recovery probes advanced a state)
 *   - vector_cortex_frontier_frozen     (authority outage froze derived frontiers)
 */

import { VC0C_ENABLED } from "../../config/vector-cortex.js";

export type ResilienceEventName =
  | "vector_cortex_breaker_opened"
  | "vector_cortex_probe_promoted"
  | "vector_cortex_frontier_frozen";

/** Injected emit callback — same (event, fields) shape as the other seams. */
export type ResilienceEmitter = (event: string, fields: Record<string, unknown>) => void;

export interface BreakerOpenedFields {
  readonly subsystem: string;
  readonly fromState: string;
  readonly toState: string;
  readonly code: string;
  readonly attempts: number;
  readonly failures: number;
}

export interface ProbePromotedFields {
  readonly subsystem: string;
  readonly fromState: string;
  readonly toState: string;
  readonly probeCount: number;
  readonly retryAttempt: number;
}

export interface FrontierFrozenFields {
  readonly session: string;
  readonly committedSeq: string;
  readonly frozenHighWater: string;
}

/** Typed, best-effort reporter bound to the three resilience event names. */
export interface ResilienceReporter {
  readonly breakerOpened: (fields: BreakerOpenedFields) => void;
  readonly probePromoted: (fields: ProbePromotedFields) => void;
  readonly frontierFrozen: (fields: FrontierFrozenFields) => void;
}

function safe(fn: (event: ResilienceEventName, fields: Record<string, unknown>) => void): (
  event: ResilienceEventName,
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
 * Build a typed reporter over an injected emit callback. Emission is gated on
 * `VC0C_ENABLED()` — flag OFF (or absent emitter) means zero resilience
 * observability writes (mode-C predecessor parity). The flag is read per-call so
 * a live toggle takes effect immediately.
 */
export function createResilienceReporter(emit?: ResilienceEmitter): ResilienceReporter {
  const fire = safe((event, fields) => {
    if (VC0C_ENABLED()) emit?.(event, fields);
  });
  return {
    breakerOpened(fields) {
      fire("vector_cortex_breaker_opened", fields as unknown as Record<string, unknown>);
    },
    probePromoted(fields) {
      fire("vector_cortex_probe_promoted", fields as unknown as Record<string, unknown>);
    },
    frontierFrozen(fields) {
      fire("vector_cortex_frontier_frozen", fields as unknown as Record<string, unknown>);
    },
  };
}

/** Export the event names for consumers that match on them. */
export const RESILIENCE_EVENTS: readonly ResilienceEventName[] = [
  "vector_cortex_breaker_opened",
  "vector_cortex_probe_promoted",
  "vector_cortex_frontier_frozen",
] as const;
