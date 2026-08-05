/**
 * vector-cortex/migrations/pressure-v2.ts — M7 pressure-v2 migration
 * (COPY + VALIDATE + SWITCH).
 *
 * Delegate-shell: types + constants live in pressure-v2-types.ts and the
 * operational logic (copy/verify/switch/label mapping) lives in
 * pressure-v2-ops.ts. This file re-exports the public surface so callers import
 * from a single module. Split to keep under the 300-line soft limit
 * (soft-as-hard gate).
 *
 * M7 canonicalizes the context-pressure label. The predecessor stored whatever
 * label a producer happened to write; v2 admits EXACTLY five — `low`, `medium`,
 * `high`, `ultra`, `mega` — and rejects everything else as
 * `M7_PRESSURE_UNKNOWN`. The rejection is the feature: coercing an unrecognized
 * legacy label onto the nearest level would silently reclassify a workload, and
 * the direction of that error is unknowable from the label alone.
 *
 * Like M4/M5/M6 it follows the copy/validate/switch contract:
 *
 *   - copy:     resumable per (session, effectiveSeq) — an interrupted run
 *               resumes without duplicate rows or active-pointer drift.
 *   - validate: every v1 row has exactly one v2 row, every v2 digest re-derives
 *               from its own declared fields, and every legacy label is
 *               canonical.
 *   - switch:   ATOMICALLY flip the active pointer via `host.switchToV2()`, but
 *               only after RE-READING host state and re-validating. The sprint's
 *               failure injection kills the process after the copy and then
 *               inserts an unknown legacy pressure; the resumed run must return
 *               `M7_PRESSURE_UNKNOWN` and KEEP THE OLD POINTER. A migration that
 *               trusts a stale verification is a migration that corrupts on
 *               restart.
 *
 * PREVENT-002/011/PI-004 honored.
 */

export {
  PRESSURE_V2_VERSION,
  PRESSURE_LEGACY_VERSION,
  M7_FAIL,
  M7_IDS,
  M7_NAMED_IDS,
} from "./pressure-v2-types.js";
export type {
  M7MigrationCode,
  PressureV1Row,
  PressureV2Row,
  M7Host,
  M7ValidateResult,
} from "./pressure-v2-types.js";

export {
  derivePressureDigest,
  mapPressureRow,
  allLabelsCanonical,
  m7Copy,
  m7Verify,
  m7Switch,
  migratePressureV2,
} from "./pressure-v2-ops.js";
