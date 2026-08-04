/**
 * vector-cortex/ledger/emit.ts — VC1A ledger emit seam.
 *
 * The single structured-event surface for the EventV2 ledger path. It mirrors
 * the VC0B replay emit seam (`src/vector-cortex/replay/emit.ts`): the same
 * non-fatal, structured-JSON `ts`+`event` contract (`src/log.ts` LogEntry),
 * delivered through an injected emit callback so it stays pi-agnostic,
 * deterministically testable, and network-free (PREVENT-PI-004).
 *
 * Carries only the two EventV2 events:
 *   - vector_cortex_event_decoded          (a V2 occurrence was byte-decoded)
 *   - vector_cortex_event_validation_failed (a V2 conformity check failed)
 *
 * Flag gating: this is VC1A's single real consumer of `VC1A_ENABLED()`. When the
 * flag is OFF the reporter emits NOTHING (zero observability writes) — the
 * VC1A mode-C byte-identical behavior — while the codec/validator still operate.
 * The flag is read per-call so a live toggle takes effect immediately.
 */

import { VC1A_ENABLED } from "../../config/vector-cortex.js";

export type LedgerEventName =
  | "vector_cortex_event_decoded"
  | "vector_cortex_event_validation_failed";

/** Injected emit callback — same (event, fields) shape as the eval/replay seams. */
export type LedgerEmitter = (event: string, fields: Record<string, unknown>) => void;

export interface LedgerEventDecodedFields {
  readonly session: string;
  readonly seq: string;
  readonly eventId: string;
  readonly bytes: number;
  readonly utf8Valid: boolean;
}

export interface LedgerValidationFailedFields {
  readonly session: string;
  readonly seq: string;
  readonly eventId: string;
  readonly code: string;
}

/** Typed, best-effort reporter bound to the two ledger event names. */
export interface LedgerReporter {
  readonly eventDecoded: (fields: LedgerEventDecodedFields) => void;
  readonly validationFailed: (fields: LedgerValidationFailedFields) => void;
}

function safe(fn: (event: LedgerEventName, fields: Record<string, unknown>) => void): (
  event: LedgerEventName,
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
 * `VC1A_ENABLED()` — flag OFF means zero ledger observability writes (mode-C
 * parity). `emit` is optional: absent (or flag off) degrades to a no-op.
 */
export function createLedgerReporter(emit?: LedgerEmitter): LedgerReporter {
  const fire = safe((event, fields) => {
    if (VC1A_ENABLED()) emit?.(event, fields);
  });
  return {
    eventDecoded(fields) {
      fire("vector_cortex_event_decoded", fields as unknown as Record<string, unknown>);
    },
    validationFailed(fields) {
      fire("vector_cortex_event_validation_failed", fields as unknown as Record<string, unknown>);
    },
  };
}

/** Export the event names for consumers that match on them. */
export const LEDGER_EVENTS: readonly LedgerEventName[] = [
  "vector_cortex_event_decoded",
  "vector_cortex_event_validation_failed",
] as const;
