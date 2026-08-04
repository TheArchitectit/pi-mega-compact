/**
 * vector-cortex/resilience/spool.ts — VC0C durable spool barrel (VC0C).
 *
 * Thin barrel over the append/fsync/ack spool implementation in `spool-core.ts`
 * (delegate-shell + impl-file split keeps the frequently-touched file small).
 * Re-exports the public `createSpool` factory, the mode-B spool/session types,
 * and the SHA-256 / CRC32C helpers for the safety adapter and tests.
 *
 * Full protocol semantics live in spool-core.ts (TRIAD_RESILIENCE §spool).
 * Local-only, no network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

export { createSpool, SPOOL_SCHEMA, ACK_EVENT_ID, crc32c, sha256Hex } from "./spool-core.js";
export type {
  SpoolFrame,
  SpoolOptions,
  SpoolAppendResult,
  SpoolDrainResult,
  AuthorityInsert,
  SessionSpool,
  Spool,
} from "./spool-core.js";
