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
  minhashCount,
  migrationCount,
  conformanceCount,
  encoderCount,
  encoderNamedCount,
  encoderHeadsCount,
  encoderHeadsNamedCount,
  encoderQualCount,
  encoderQualNamedCount,
  cortexCount,
  cortexNamedCount,
  topologyCount,
  topologyNamedCount,
  shardCount,
  shardNamedCount,
  residualCount,
  residualNamedCount,
  reconstructionCount,
  reconstructionNamedCount,
  promptDagCount,
  promptDagNamedCount,
  plannerCount,
  plannerNamedCount,
  renderCount,
  renderNamedCount,
  providerCount,
  providerNamedCount,
  rolloutCount,
  rolloutNamedCount,
  healCount,
  healNamedCount,
  restorationCount,
  restorationNamedCount,
  healingCount,
  healingNamedCount,
  crystalCount,
  crystalNamedCount,
  economicsCount,
  economicsNamedCount,
} = writeAll();

console.log(
  `generated ${evalCount} evaluation + ${replayCount} replay + ${eventCount} event fixtures + ${resilienceCount} resilience + ${ledgerCount} ledger + ${ledgerNamedCount} named ledger + ${namedCount} named resilience fixtures + ${minhashCount} minhash + ${migrationCount} migration + ${conformanceCount} conformance fixtures + ${encoderCount} encoder-runtime + ${encoderNamedCount} named encoder-runtime fixtures + ${encoderHeadsCount} encoder-heads + ${encoderHeadsNamedCount} named encoder-heads fixtures + ${encoderQualCount} encoder-qualification + ${encoderQualNamedCount} named encoder-qualification fixtures + ${cortexCount} cortex-store + ${cortexNamedCount} named cortex-store fixtures + ${topologyCount} topology + ${topologyNamedCount} named topology fixtures + ${shardCount} shard + ${shardNamedCount} named shard + ${residualCount} residual + ${residualNamedCount} named residual fixtures + ${reconstructionCount} reconstruction + ${reconstructionNamedCount} named reconstruction fixtures + ${promptDagCount} prompt-dag + ${promptDagNamedCount} named prompt-dag + ${plannerCount} planner + ${plannerNamedCount} named planner fixtures + ${renderCount} render + ${renderNamedCount} named render + ${providerCount} provider + ${providerNamedCount} named provider fixtures + ${rolloutCount} rollout + ${rolloutNamedCount} named rollout fixtures + ${healCount} closure-optimization + ${healNamedCount} named closure-optimization fixtures + ${restorationCount} restoration + ${restorationNamedCount} named restoration fixtures + ${healingCount} healing-controller + ${healingNamedCount} named healing-controller fixtures + ${crystalCount} cache-crystal + ${crystalNamedCount} named cache-crystal fixtures + ${economicsCount} cache-economics + ${economicsNamedCount} named cache-economics fixtures + ${schemaCount} schemas + manifest under conformance/vector-cortex/v2`,
);
console.log("next: node scripts/vector-cortex-conformance.mjs --check");
