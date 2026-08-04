#!/usr/bin/env node
/**
 * vector-cortex-gen-fixtures.mjs — regenerate the VC0A conformance fixtures.
 *
 * Thin orchestrator over the per-domain generators under scripts/gen-fixtures/
 * (schemas, evaluation, replay, events, resilience, ledger) + the canonical writer.
 *
 * Produces every file under conformance/vector-cortex/v2/ in canonical JSON
 * form (see CONFORMANCE.md): UTF-8, NFC, keys sorted by UTF-8 bytes, shortest
 * number representation, final LF, SHA-256 over the declared canonical bytes,
 * and rewrites manifest.json listing each file for the conformance checker.
 *
 * REGENERATION: run after editing fixtures; commit the emitted files. The
 * conformance --check gate verifies the committed bytes are exactly these.
 *
 * LOCAL ONLY: filesystem writes only, zero network (PREVENT-PI-004).
 */

import { writeAll } from "./gen-fixtures/write.mjs";

const {
  evalCount,
  replayCount,
  eventCount,
  resilienceCount,
  ledgerCount,
  ledgerNamedCount,
  namedCount,
  schemaCount,
} = writeAll();

console.log(
  `generated ${evalCount} evaluation + ${replayCount} replay + ${eventCount} event fixtures + ${resilienceCount} resilience + ${ledgerCount} ledger + ${ledgerNamedCount} named ledger + ${namedCount} named resilience fixtures + ${schemaCount} schemas + manifest under conformance/vector-cortex/v2`,
);
console.log("next: node scripts/vector-cortex-conformance.mjs --check");
