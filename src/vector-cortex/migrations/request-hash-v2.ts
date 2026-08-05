/**
 * vector-cortex/migrations/request-hash-v2.ts — M5 request-hash-v2 migration
 * (COPY + VALIDATE + SWITCH).
 *
 * Delegate-shell: types + constants live in request-hash-v2-types.ts and the
 * operational logic (copy/verify/switch/collision) lives in
 * request-hash-v2-ops.ts. This file re-exports the public surface so callers
 * import from a single module. Split to keep under the 300-line soft limit
 * (soft-as-hard gate).
 *
 * M5 versions the canonical request hash: the predecessor hashed the outbound
 * request under the v1 scheme; v2 folds in the provider profile's ECONOMICS
 * version so a pricing/TTL/exclusion change cannot silently reuse a cache
 * identity minted under different economics. Like M4/M6 it follows the
 * copy/validate/switch contract:
 *
 *   - copy:     resumable per (profile, request) — an interrupted run resumes
 *               without duplicate rows or active-pointer drift.
 *   - validate: every v1 row has exactly one v2 row, every v2 digest re-hashes
 *               from its own declared fields, the migration is IDENTITY-PRESERVING
 *               (a v2 row carries the same `requestDigest` as its v1 source — v2
 *               changes how a CACHE KEY is derived, never what the request IS), and
 *               — the M5-specific invariant ADDED in VC7C — there are ZERO
 *               collisions: no two distinct v1 rows may map to one v2 hash. A
 *               collision (`M5_REQUEST_HASH_COLLISION`) means two different
 *               conversations would share a cache key, the most dangerous outcome
 *               in the subsystem, so it blocks the switch outright.
 *   - switch:   ATOMICALLY flip the active pointer to v2 via `host.switchToV2()`.
 *               VC7B deferred this; VC7C performs it — but ONLY after re-validating
 *               against freshly-read host state at switch time.
 *
 * WHY THE COLLISION CHECK RUNS AT SWITCH TIME, NOT VALIDATE TIME. The brief's
 * failure-injection contract is explicit: crash after M5 validation, inject a
 * collision into host state, then resume — and the RESUMED run must detect
 * `M5_REQUEST_HASH_COLLISION`. If the collision were detected only from the result
 * of an earlier `m5Verify` call, the cached result would be replayed and the
 * injected collision would be invisible. So `m5Switch` RE-READS the host (`v1Rows`,
 * `existingV2`, `activeVersion`) and RE-RUNS the collision check against that live
 * state. Validation is a precondition; the switch is the only place that proves the
 * hazard is absent *right now*. This is the same resume-after-crash discipline as
 * M4/M6: a migration that trusts a stale verification is a migration that loses
 * data on restart.
 *
 * M6 INVALIDATION CONSUMPTION. A v2 request hash is only as trustworthy as the
 * generation it was minted under. The switch consumes M6's structured invalidation
 * keys via the REAL API (`invalidationKey` from `../topology/query.js`) rather than
 * inventing one: when a v2 row's economics version maps to an invalidated router
 * generation, that row cannot be promoted to active. We do not re-derive a
 * generation here — topology is the authority on what generation is live — we only
 * refuse to switch a row whose generation is dead. This keeps M5 from resurrecting
 * cache identities tied to a generation the router has already invalidated.
 *
 * PREVENT-002/011/PI-004 honored.
 */

export {
  REQUEST_HASH_V2_VERSION,
  REQUEST_HASH_LEGACY_VERSION,
  M5_FAIL,
  M5_IDS,
  M5_NAMED_IDS,
} from "./request-hash-v2-types.js";
export type {
  M5MigrationCode,
  RequestHashV1Row,
  RequestHashV2Row,
  M5Host,
  M5ValidateResult,
} from "./request-hash-v2-types.js";

export {
  deriveRequestHashV2,
  deriveRequestHashRow,
  detectCollision,
  isGenerationInvalidated,
  m5Copy,
  m5Verify,
  m5Switch,
  migrateRequestHashV2,
} from "./request-hash-v2-ops.js";
