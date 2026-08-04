/**
 * vector-cortex/cortex/store.ts — VC3A capability-separated cortex store contracts.
 *
 * Owns the `createCortexStore` factory producing `CortexReader` / `CortexWriter`
 * / `CortexAdmin` capability views over the isolated cortex SQLite store. The
 * writer exposes append only, the reader exposes query only, and the admin alone
 * can rebuild/switch generations (task 2). No callbacks or event emitters flow
 * from the store; writes are non-fatal (a failure logs and never breaks the agent
 * loop).
 *
 * The two VC3A events (task 5) are emitted by this store:
 *
 *   vector_cortex_record_append_failed    — an append was rejected / failed
 *   vector_cortex_generation_rebuilt      — the admin rebuilt + activated a generation
 *
 * Both are gated on `MEGACOMPACT_VC3A` so the flag-OFF path emits zero events
 * (mode C parity, byte-identical predecessor).
 *
 * Capability gating mirrors the host `asReader/asWriter/asAdmin` and VC1B ledger
 * pattern. Each consumer receives ONLY what it needs. The dashboard reader-only
 * GET is built on the reader surface alone.
 *
 * Pi-agnostic. No console.log. No network (PREVENT-PI-004). No `any`
 * (PREVENT-011).
 */

import { VC3A_ENABLED } from "../../config/vector-cortex.js";
import { Logger } from "../../log.js";
import type {
  CortexAdmin,
  CortexAppendInput,
  CortexGenerationV1,
  CortexReader,
  CortexTopologySummary,
  CortexWriter,
} from "./types.js";
import {
  openCortexStore,
  insertCortexRecord,
  readCortexRecord,
  countCortexRecords,
  readCortexRecords,
  rebuildCortexGeneration,
  switchCortexGeneration,
  activeGeneration,
  listCortexGenerations,
  maxSourceHighWater,
} from "./sqlite.js";
import type { DatabaseSync } from "node:sqlite";

/** Optional structured-event emitter (same shape as the other VC seams). */
export type CortexEmit = (event: string, fields: Record<string, unknown>) => void;

/** The token that gates closures to a single capability (PREVENT-011-free). */
const _capability: unique symbol = Symbol("mc-cortex-capability");

interface ReaderToken {
  readonly [_capability]: "reader";
}
interface WriterToken {
  readonly [_capability]: "writer";
}
interface AdminToken {
  readonly [_capability]: "admin";
}

/** A capability-gated cortex handle: access only what you were handed. */
export interface CortexHandle {
  readonly reader: () => CortexReader & ReaderToken;
  readonly writer: () => CortexWriter & WriterToken;
  readonly admin: () => CortexAdmin & AdminToken;
  /** Close the underlying DB handle (test/sandbox teardown). */
  readonly close: () => void;
}

/**
 * Create the capability-separated cortex derived store over its OWN isolated
 * SQLite DB. `emit` is optional; the two VC3A events are only emitted when
 * `VC3A_ENABLED()` and an emitter is supplied (mode-C parity: flag OFF / no
 * emitter => zero observability writes).
 *
 * Normalization: `stateDir` gives the standard daemon location
 * `<stateDir>/vector-cortex/cortex.db`; a bare `dbPath` overrides it
 * (tests/rehearsal isolate the cortex store). An injected `db` (an already-open
 * `DatabaseSync`) is a dependency-injection seam used by the failure-injection
 * tests to drive the REAL storage-refusal path (e.g. `PRAGMA query_only`) through
 * the store's own writer — a genuine store, no mock.
 */
export function createCortexStore(
  opts:
    | { readonly stateDir: string }
    | { readonly dbPath: string }
    | { readonly db: DatabaseSync },
  emit?: CortexEmit,
): CortexHandle {
  const db =
    "db" in opts
      ? opts.db
      : openCortexStore(
          "dbPath" in opts
            ? opts.dbPath
            : `${opts.stateDir}/vector-cortex/cortex.db`,
        );

  // A caller that invokes the writer/admin seam without injecting an emitter gets
  // a REAL default producer (structured logger) so telemetry is never silently
  // dropped — an explicit `emit:` replaces it. The dashboard reader-only route
  // never appends/rebuilds, so it fires nothing regardless; a future writer/admin
  // host integration enjoys default observability out of the box (VC3B wiring).
  const sink = emit ?? defaultEmitFor();
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC3A_ENABLED()) return;
    try {
      sink(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };

  const asReader = (): CortexReader & ReaderToken => ({
    kind: "CortexReader",
    [_capability]: "reader" as const,
    recordCount: () => countCortexRecords(db),
    readRecords: () => readCortexRecords(db),
    readRecord: (sourceHighWater, algorithmVersion, id) =>
      readCortexRecord(db, sourceHighWater, algorithmVersion, id),
    latestGeneration: () => activeGeneration(db),
    topologySummary: () => topologyOf(db, VC3A_ENABLED()),
  });

  const asWriter = (): CortexWriter & WriterToken => ({
    kind: "CortexWriter",
    [_capability]: "writer" as const,
    append(input) {
      const result = insertCortexRecord(db, input);
      // Any rejected/failed append (CTX_KEY_CONFLICT, CTX_APPEND_FAILED, or any
      // future code) surfaces the SAME event; the `code` field distinguishes a
      // key-conflict (rejected append) from a storage failure (CTX_APPEND_FAILED).
      if (!result.ok) {
        fire("vector_cortex_record_append_failed", {
          sourceHighWater: input.sourceHighWater.toString(),
          algorithmVersion: input.algorithmVersion,
          id: input.id,
          kind: input.kind,
          code: result.code,
        });
      }
      return result;
    },
  });

  const asAdmin = (): CortexAdmin & AdminToken => ({
    kind: "CortexAdmin",
    [_capability]: "admin" as const,
    rebuild(authorityHighWater?: bigint) {
      const result = rebuildCortexGeneration(db, { authorityHighWater });
      if (result.ok) {
        fire("vector_cortex_generation_rebuilt", {
          generationId: result.generation.id,
          ordinal: result.generation.ordinal.toString(),
          sourceHighWater: result.generation.sourceHighWater.toString(),
          recordCount: result.generation.recordCount,
          rootDigest: result.generation.rootDigest,
        });
      }
      return result;
    },
    switchGeneration: (generationId) => switchCortexGeneration(db, generationId),
    listGenerations: () => listCortexGenerations(db),
  });

  return { reader: asReader, writer: asWriter, admin: asAdmin, close: () => db.close() };
}

/** Build the reader-only topology summary (the dashboard GET payload). */
function topologyOf(db: DatabaseSync, enabled: boolean): CortexTopologySummary {
  const gen = activeGeneration(db);
  return {
    enabled,
    generationId: gen ? gen.id : null,
    rootDigest: gen ? gen.rootDigest : null,
    sourceHighWater: (gen ? gen.sourceHighWater : maxSourceHighWater(db)).toString(),
    recordCount: countCortexRecords(db),
    ordinal: gen ? gen.ordinal.toString() : null,
  };
}

/**
 * A deterministic default emitter backed by the structured logger. Supplying an
 * explicit `emit:` replaces it. Making the default a REAL producer means a caller
 * that just invokes the writer/admin seam without injecting an emitter still
 * yields structured telemetry instead of silently dropping every event.
 */
function defaultEmitFor(): CortexEmit {
  const logger = new Logger();
  return (event, fields) => {
    logger.info(event, fields);
  };
}

/** A flag-gated reporter over the store's two named events (test seam). */
export interface CortexReporter {
  readonly recordAppendFailed: (fields: Record<string, unknown>) => void;
  readonly generationRebuilt: (fields: Record<string, unknown>) => void;
}

export function createCortexReporter(emit?: CortexEmit): CortexReporter {
  const sink = emit ?? defaultEmitFor();
  const fire = (event: string, fields: Record<string, unknown>): void => {
    if (!VC3A_ENABLED()) return;
    try {
      sink(event, fields);
    } catch {
      /* non-fatal observability */
    }
  };
  return {
    recordAppendFailed: (fields) => fire("vector_cortex_record_append_failed", fields),
    generationRebuilt: (fields) => fire("vector_cortex_generation_rebuilt", fields),
  };
}

/** Re-export the generation type for convenience in admin consumers. */
export type { CortexGenerationV1, CortexAppendInput };
