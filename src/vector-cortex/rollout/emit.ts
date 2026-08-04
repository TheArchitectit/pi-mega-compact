/**
 * vector-cortex/rollout/emit.ts — VC5C rollout emit seam.
 *
 * The structured-event surface for the live graduated rollout: assignment and
 * promotion-blocked observability. Mirrors the VC0C resilience emit seam and
 * the VC0B replay emit seam: the same injected `(event, fields)` callback, the
 * same non-fatal `safe()` best-effort wrapper, and the same per-call
 * `VC5C_ENABLED()` gate. Absent emitter (or flag OFF) degrades to a no-op with
 * byte-identical predecessor behavior (PREVENT-PI-004, structured `ts`+`event`).
 *
 * Carries exactly the two events the sprint names:
 *   - vector_cortex_rollout_assigned         (a session was assigned a bucket)
 *   - vector_cortex_rollout_promotion_blocked (a hard fault froze promotion)
 */

import { VC5C_ENABLED } from "../../config/vector-cortex.js";

export type RolloutEventName =
  | "vector_cortex_rollout_assigned"
  | "vector_cortex_rollout_promotion_blocked";

/** Injected emit callback — same (event, fields) shape as the other seams. */
export type RolloutEmitter = (event: string, fields: Record<string, unknown>) => void;

export interface RolloutAssignedFields {
  readonly sessionId: string;
  readonly bucket: number;
  readonly gateIndex: number;
  readonly gatePct: number;
}

export interface PromotionBlockedFields {
  readonly gateIndex: number;
  readonly kind: string;
  readonly detail: string;
}

/** Typed, best-effort reporter bound to the two rollout event names. */
export interface RolloutReporter {
  readonly assigned: (fields: RolloutAssignedFields) => void;
  readonly promotionBlocked: (fields: PromotionBlockedFields) => void;
}

function safe(fn: (event: RolloutEventName, fields: Record<string, unknown>) => void): (
  event: RolloutEventName,
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
 * `VC5C_ENABLED()` — flag OFF (or absent emitter) means zero rollout
 * observability writes (pre-VC predecessor parity). The flag is read per-call so
 * a live toggle takes effect immediately.
 */
export function createRolloutReporter(emit?: RolloutEmitter): RolloutReporter {
  const fire = safe((event, fields) => {
    if (VC5C_ENABLED()) emit?.(event, fields);
  });
  return {
    assigned(fields) {
      fire("vector_cortex_rollout_assigned", fields as unknown as Record<string, unknown>);
    },
    promotionBlocked(fields) {
      fire("vector_cortex_rollout_promotion_blocked", fields as unknown as Record<string, unknown>);
    },
  };
}

/** Export the event names for consumers that match on them. */
export const ROLLOUT_EVENT_NAMES: readonly RolloutEventName[] = [
  "vector_cortex_rollout_assigned",
  "vector_cortex_rollout_promotion_blocked",
];
