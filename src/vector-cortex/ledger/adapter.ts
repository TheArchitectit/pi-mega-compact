/**
 * vector-cortex/ledger/adapter.ts — EventV2 ledger adapter (VC1A, task 5).
 *
 * A thin, pi-agnostic adapter combining the Mode-A codec, the canonical
 * validator, and the VC1A emit seam so `vector_cortex_event_decoded` and
 * `vector_cortex_event_validation_failed` are emitted by REAL code paths (not a
 * hand-invoked reporter), gated by `VC1A_ENABLED()` inside `createLedgerReporter`.
 *
 * The live producer (wiring this into `extensions/mega-compact.ts` /
 * `src/engine.ts`) is deferred to VC1C/VC1B (mirroring VC0B-I08); this sprint
 * ships the seam + adapter as the clean single surface, with the acceptance
 * aggregator exercising the real gated-emission path.
 *
 * Pure orchestration — no storage, no network, no side effects (PREVENT-PI-004).
 */

import { createEventCodec } from "./event-codec.js";
import { validateEvents } from "./validator.js";
import { createLedgerReporter, type LedgerReporter } from "./emit.js";
import type { EventCodec, EventEncodeInput, EventV2, ValidationResult } from "./types.js";

export interface LedgerAdapter {
  /** Encode raw bytes into a V2 occurrence (digest + strict UTF-8 + NFC derived). */
  readonly encode: (input: EventEncodeInput) => EventV2;
  /** Byte-decode an occurrence, emitting `vector_cortex_event_decoded`. */
  readonly decode: (event: EventV2) => Uint8Array;
  /** Canonical-validate a batch, emitting `..._validation_failed` on failure. */
  readonly validate: (events: readonly EventV2[]) => ValidationResult;
  /** The underlying codec (for tests that need a bare codec). */
  readonly codec: EventCodec;
  /** The underlying reporter (flag OFF emits nothing). */
  readonly reporter: LedgerReporter;
}

/** Build the ledger adapter over an injected emit callback (optional). */
export function createLedgerAdapter(emit?: (event: string, fields: Record<string, unknown>) => void): LedgerAdapter {
  const codec = createEventCodec();
  const reporter = createLedgerReporter(emit);
  return {
    encode: (input) => codec.encode(input),
    decode(event) {
      const bytes = codec.decode(event);
      reporter.eventDecoded({
        session: event.sessionId,
        seq: event.seq.toString(),
        eventId: event.eventId,
        bytes: bytes.length,
        utf8Valid: event.utf8.valid,
      });
      return bytes;
    },
    validate(events) {
      const result = validateEvents(events);
      if (!result.ok) {
        // Emit one event per failing occurrence with its REAL locator — a
        // consumer of the feed can identify WHICH event failed (VC1A-I05).
        for (const issue of result.issues) {
          reporter.validationFailed({
            session: issue.sessionId,
            seq: issue.seq.toString(),
            eventId: issue.eventId,
            code: issue.code,
          });
        }
      }
      return result;
    },
    codec,
    reporter,
  };
}
