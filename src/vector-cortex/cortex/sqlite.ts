/**
 * vector-cortex/cortex/sqlite.ts — cortex derived-record SQLite store, Mode A
 * (VC3A).
 *
 * A self-contained, isolated SQLite store (`node:sqlite` `DatabaseSync`) over its
 * OWN database file — NOT the host `sqlite.db` — so the derived cortex store is a
 * separate additive artifact. Holds the immutable derived `cortex_record_v1`
 * rows keyed by `(source_high_water, algorithm_version, id)` (CTX-KEY-002: the
 * same id at a different algorithm version stays DISTINCT) and the
 * `cortex_generation_v1` generation rows (the digest-pinned derived front).
 *
 * Append enforces composite-key immutability: an exact
 * `(source_high_water, algorithm_version, id)` re-append with the SAME
 * `payload_digest` is acknowledged idempotently; the same key with a DIFFERENT
 * digest is a `CTX_KEY_CONFLICT` (immutable derived records never mutate).
 *
 * Rebuild is deterministic: it sorts records by
 * `(source_high_water, algorithm_version, id)`, verifies every `payload_digest`,
 * computes ONE `root_digest` over the canonical sorted key list (order
 * independent, CTX-REBUILD-003), and writes + activates a new generation.
 *
 * PREVENT-002: every query is parameterized. PREVENT-011: no `any`.
 * PREVENT-PI-004: local filesystem only, no network. No console.log.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type {
  CortexAppendResult,
  CortexGenerationV1,
  CortexRebuildCode,
  CortexRecordV1,
} from "./types.js";

/** DB row shape for cortex_record_v1 (snake_case columns). */
interface CortexRecordRow {
  // With readBigInts:true (set in openCortexStore) node:sqlite returns EVERY
  // INTEGER column as bigint — not only values >MAX_SAFE_INTEGER. rowToRecord
  // normalizes via BigInt(...)/Number(...) for both the number|bigint union.
  source_high_water: number | bigint;
  algorithm_version: number;
  id: string;
  kind: string;
  payload_digest: string;
  payload_bytes: Uint8Array | null;
}

/** DB row shape for cortex_generation_v1 (snake_case columns). */
interface CortexGenerationRow {
  id: string;
  ordinal: number | bigint;
  source_high_water: number | bigint;
  record_count: number;
  root_digest: string;
  active: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cortex_record_v1 (
  source_high_water  INTEGER NOT NULL,
  algorithm_version  INTEGER NOT NULL,
  id                 TEXT    NOT NULL,
  kind               TEXT    NOT NULL,
  payload_digest     TEXT    NOT NULL,
  payload_bytes      BLOB    NOT NULL,
  PRIMARY KEY (source_high_water, algorithm_version, id)
) STRICT;

CREATE TABLE IF NOT EXISTS cortex_generation_v1 (
  id                 TEXT    PRIMARY KEY,
  ordinal            INTEGER NOT NULL,
  source_high_water  INTEGER NOT NULL,
  record_count       INTEGER NOT NULL,
  root_digest        TEXT    NOT NULL,
  active             INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

/** Default digest for a record when the caller omits one (sha256 over bytes). */
export function cortexDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Toggle real storage writability on a cortex store connection. `readOnly=true`
 * sets `PRAGMA query_only`, making SQLite itself refuse every INSERT/UPDATE —
 * the genuine storage-failure (SQLITE_FULL-class) path used by the failure
 * injection tests. Reads (SELECT) remain available, so a read-only store still
 * serves the reader and rebuild recovery.
 */
export function setStoreReadOnly(db: DatabaseSync, readOnly: boolean): void {
  db.exec(readOnly ? "PRAGMA query_only = ON" : "PRAGMA query_only = OFF");
}

/** Open (or reuse) the isolated cortex derived-store DB handle. */
export function openCortexStore(dbPath: string): DatabaseSync {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // readBigInts: return INTEGER columns exceeding Number.MAX_SAFE_INTEGER as BigInt
  // so a caller's `bigint` sourceHighWater/ordinal round-trips exactly (Q06 —
  // never truncate through a `Number()` double).
  const db = new DatabaseSync(dbPath, { readBigInts: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

function rowToRecord(row: CortexRecordRow): CortexRecordV1 {
  return {
    schema: "cortex-record-v1",
    sourceHighWater: BigInt(row.source_high_water),
    algorithmVersion: Number(row.algorithm_version),
    id: row.id,
    kind: row.kind,
    payloadDigest: row.payload_digest,
    payloadBytes: row.payload_bytes ? Buffer.from(row.payload_bytes) : new Uint8Array(0),
  };
}

/** Count accepted derived records. */
export function countCortexRecords(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM cortex_record_v1`).get() as { cnt: number | bigint };
  return typeof row.cnt === "bigint" ? Number(row.cnt) : row.cnt;
}

/** Accepted records in ascending (sourceHighWater, algorithmVersion, id). */
export function readCortexRecords(db: DatabaseSync): CortexRecordV1[] {
  const rows = db
    .prepare(
      `SELECT source_high_water, algorithm_version, id, kind, payload_digest, payload_bytes
       FROM cortex_record_v1
       ORDER BY source_high_water ASC, algorithm_version ASC, id ASC`,
    )
    .all() as unknown as CortexRecordRow[];
  return rows.map(rowToRecord);
}

/** The single record at a composite key, or undefined. */
export function readCortexRecord(
  db: DatabaseSync,
  sourceHighWater: bigint,
  algorithmVersion: number,
  id: string,
): CortexRecordV1 | undefined {
  const row = db
    .prepare(
      `SELECT source_high_water, algorithm_version, id, kind, payload_digest, payload_bytes
       FROM cortex_record_v1
       WHERE source_high_water = @hw AND algorithm_version = @av AND id = @id LIMIT 1`,
    )
    .get({
      "@hw": sourceHighWater,
      "@av": algorithmVersion,
      "@id": id,
    }) as CortexRecordRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/** Whether an exact composite-key record already exists. */
function findRecordByKey(
  db: DatabaseSync,
  sourceHighWater: bigint,
  algorithmVersion: number,
  id: string,
): CortexRecordV1 | undefined {
  return readCortexRecord(db, sourceHighWater, algorithmVersion, id);
}

/**
 * Classify an existing-key hit: an exact `(key, digest)` match is an idempotent
 * ack of the immutable record; the same key with a DIFFERENT digest is a
 * `CTX_KEY_CONFLICT` (immutable derived records never mutate).
 */
function idempotentOrConflict(
  existing: CortexRecordV1,
  candidate: CortexRecordV1,
  payloadDigest: string,
): CortexAppendResult {
  if (existing.payloadDigest === payloadDigest) {
    // Idempotent ack of an identical immutable record.
    return { ok: true, record: existing };
  }
  return { ok: false, code: "CTX_KEY_CONFLICT", rejected: candidate };
}

/**
 * Append one derived record. Exact `(sourceHighWater, algorithmVersion, id)`
 * with the SAME payloadDigest is acknowledged idempotently (returning the
 * existing immutable row); the same key with a DIFFERENT digest is a conflict.
 * A storage error is surfaced as `CTX_APPEND_FAILED` so the caller's writer can
 * treat it non-fatally. A concurrent unique-constraint race is classified as an
 * idempotent ack / key-conflict (re-checked against the committed row), never
 * misreported as a storage failure.
 */
export function insertCortexRecord(
  db: DatabaseSync,
  input: {
    readonly sourceHighWater: bigint;
    readonly algorithmVersion: number;
    readonly id: string;
    readonly kind: string;
    readonly payloadDigest?: string;
    readonly payloadBytes: Uint8Array;
  },
): CortexAppendResult {
  const payloadDigest = input.payloadDigest ?? cortexDigest(input.payloadBytes);
  const record: CortexRecordV1 = {
    schema: "cortex-record-v1",
    sourceHighWater: input.sourceHighWater,
    algorithmVersion: input.algorithmVersion,
    id: input.id,
    kind: input.kind,
    payloadDigest,
    payloadBytes: input.payloadBytes,
  };

  const existing = findRecordByKey(db, input.sourceHighWater, input.algorithmVersion, input.id);
  if (existing) {
    return idempotentOrConflict(existing, record, payloadDigest);
  }

  try {
    db.prepare(
      `INSERT INTO cortex_record_v1
         (source_high_water, algorithm_version, id, kind, payload_digest, payload_bytes)
       VALUES (@hw, @av, @id, @kind, @digest, @bytes)`,
    ).run({
      "@hw": input.sourceHighWater,
      "@av": input.algorithmVersion,
      "@id": input.id,
      "@kind": input.kind,
      "@digest": payloadDigest,
      "@bytes": Buffer.from(input.payloadBytes),
    });
  } catch {
    // A UNIQUE/PK constraint race (two writers pass the SELECT above, the loser
    // hits the composite PK) is semantically an idempotent ack or a key conflict
    // — NOT a storage failure — so re-check the now-committed row and classify it
    // correctly instead of misreporting CTX_APPEND_FAILED. Any other error is a
    // genuine non-fatal storage failure (e.g. SQLITE_FULL) and surfaces as-is.
    const recheck = readCortexRecord(db, input.sourceHighWater, input.algorithmVersion, input.id);
    if (recheck) {
      return idempotentOrConflict(recheck, record, payloadDigest);
    }
    return { ok: false, code: "CTX_APPEND_FAILED", rejected: record };
  }
  return { ok: true, record };
}

/**
 * ONE deterministic root digest over the canonical sorted key list. Records are
 * sorted by `(sourceHighWater, algorithmVersion, id)`; each key contributes
 * `sourceHighWater|algorithmVersion|id|kind|payloadDigest`. Order-independent
 * (CTX-REBUILD-003): shuffled insertion yields an identical root digest.
 */
export function generationRootDigest(records: readonly CortexRecordV1[]): string {
  const sorted = [...records].sort(cmpRecordKey);
  const h = createHash("sha256");
  for (const r of sorted) {
    h.update(`${r.sourceHighWater.toString()}|${r.algorithmVersion}|${r.id}|${r.kind}|${r.payloadDigest}\n`);
  }
  return h.digest("hex");
}

/** Stable record ordering by the composite key. */
export function cmpRecordKey(a: CortexRecordV1, b: CortexRecordV1): number {
  if (a.sourceHighWater < b.sourceHighWater) return -1;
  if (a.sourceHighWater > b.sourceHighWater) return 1;
  if (a.algorithmVersion < b.algorithmVersion) return -1;
  if (a.algorithmVersion > b.algorithmVersion) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The active generation, or undefined. */
export function activeGeneration(db: DatabaseSync): CortexGenerationV1 | undefined {
  const row = db
    .prepare(
      `SELECT id, ordinal, source_high_water, record_count, root_digest, active
       FROM cortex_generation_v1 WHERE active = 1 LIMIT 1`,
    )
    .get() as CortexGenerationRow | undefined;
  return row ? rowToGeneration(row) : undefined;
}

/** All generations in ascending ordinal order (evidence retained). */
export function listCortexGenerations(db: DatabaseSync): CortexGenerationV1[] {
  const rows = db
    .prepare(
      `SELECT id, ordinal, source_high_water, record_count, root_digest, active
       FROM cortex_generation_v1 ORDER BY ordinal ASC`,
    )
    .all() as unknown as CortexGenerationRow[];
  return rows.map(rowToGeneration);
}

/** A generation by id, or undefined. */
function generationById(db: DatabaseSync, generationId: string): CortexGenerationV1 | undefined {
  const row = db
    .prepare(
      `SELECT id, ordinal, source_high_water, record_count, root_digest, active
       FROM cortex_generation_v1 WHERE id = @id LIMIT 1`,
    )
    .get({ "@id": generationId }) as CortexGenerationRow | undefined;
  return row ? rowToGeneration(row) : undefined;
}

/**
 * The existing generation carrying the SAME rootDigest and recordCount, or
 * undefined. Deterministic rebuild of unchanged inputs must REUSE the identical
 * generation already recorded durably rather than append a fresh duplicate
 * (idempotency) — this scan is what makes that reuse reachable, since the
 * ordinal-derived id is always new in the no-opts flow.
 */
function generationByRootDigest(
  db: DatabaseSync,
  rootDigest: string,
  recordCount: number,
): CortexGenerationV1 | undefined {
  const row = db
    .prepare(
      `SELECT id, ordinal, source_high_water, record_count, root_digest, active
       FROM cortex_generation_v1
       WHERE root_digest = @digest AND record_count = @count LIMIT 1`,
    )
    .get({ "@digest": rootDigest, "@count": recordCount }) as CortexGenerationRow | undefined;
  return row ? rowToGeneration(row) : undefined;
}

function rowToGeneration(row: CortexGenerationRow): CortexGenerationV1 {
  return {
    schema: "cortex-generation-v1",
    id: row.id,
    sourceHighWater: BigInt(row.source_high_water),
    recordCount: typeof row.record_count === "bigint" ? Number(row.record_count) : row.record_count,
    rootDigest: row.root_digest,
    ordinal: BigInt(row.ordinal),
  };
}

/**
 * Deterministically rebuild a generation from ALL accepted records. Sorts keys,
 * verifies each payload digest (CTX_PAYLOAD_DIGEST_MISMATCH on corruption),
 * computes ONE root digest, and writes + activates a new generation with an
 * incrementing ordinal. Does NOT delete prior generations (evidence retained).
 *
 * Idempotency (DTST-CORE invariant): a rebuild of UNCHANGED accepted inputs
 * (same sorted set → same rootDigest + recordCount) REUSES the identical
 * generation already recorded durably — it activates and returns that existing
 * generation instead of appending a fresh duplicate row, so repeated rebuilds
 * with no record changes yield one generation, not gen-1, gen-2, ... carrying
 * the same digest.
 *
 * When `opts.authorityHighWater` is supplied, the derived frontier (max record
 * sourceHighWater) must not exceed the contiguous durable authority high-water
 * (normative in CONTRACTS.md); an over-run is rejected with
 * `CTX_HIGH_WATER_EXCEEDED` and NO generation is written.
 *
 * A rebuild only reports `ok:true` when the generation INSERT + activate actually
 * persisted. If the write degrades (any storage failure, e.g. SQLITE_FULL via
 * `PRAGMA query_only`), it returns `ok:false, code:"CTX_REBUILD_FAILED"` — never
 * a fabricated generation that has no durable row. That non-ok result is what
 * prevents the caller from emitting a misleading `vector_cortex_generation_rebuilt`
 * event or exposing a generation id that does not exist.
 *
 * The reuse path (a prior generation already carries the same rootDigest +
 * recordCount) also runs its activation through the SAME error-to-CTX_REBUILD_FAILED
 * conversion: under read-only storage (`PRAGMA query_only`) the activation UPDATE
 * is refused by SQLite, and the rebuild must surface `CTX_REBUILD_FAILED` rather
 * than let a raw SQLITE_READONLY escape to `store.admin().rebuild()` and break
 * the agent loop. Reads remain available, so the durable generation is intact.
 */
export function rebuildCortexGeneration(
  db: DatabaseSync,
  opts: {
    readonly generationOrdinal?: bigint;
    readonly authorityHighWater?: bigint;
  } = {},
): { ok: true; generation: CortexGenerationV1 } | { ok: false; code: CortexRebuildCode } {
  const records = readCortexRecords(db);
  const sorted = [...records].sort(cmpRecordKey);
  // Verify every record digest against its immutable payload bytes.
  for (const r of sorted) {
    if (r.payloadDigest !== cortexDigest(r.payloadBytes)) {
      return { ok: false, code: "CTX_PAYLOAD_DIGEST_MISMATCH" };
    }
  }
  const rootDigest = generationRootDigest(sorted);
  const sourceHighWater = sorted.length > 0 ? sorted[sorted.length - 1]!.sourceHighWater : 0n;

  // Normative derived-frontier invariant (CONTRACTS.md): the derived frontier can
  // never exceed the contiguous durable authority high-water. Reject the rebuild
  // (write nothing) when a bound is supplied and the derived records outrun it.
  if (opts.authorityHighWater !== undefined && sourceHighWater > opts.authorityHighWater) {
    return { ok: false, code: "CTX_HIGH_WATER_EXCEEDED" };
  }

  const sortedCount = sorted.length;
  // Deterministic rebuild of unchanged inputs must REUSE the identical generation
  // already recorded durably (idempotent, no duplicate generation bloat). If a
  // prior generation carries the same rootDigest + recordCount, activate it and
  // return it instead of appending a fresh duplicate row.
  const reused = generationByRootDigest(db, rootDigest, sortedCount);
  if (reused) {
    // The generation row ALREADY exists durably (reads still work under
    // `PRAGMA query_only`), but activating it is a write. Guard it the same way
    // as the insert path so a storage failure (e.g. SQLITE_READONLY) degrades to
    // CTX_REBUILD_FAILED instead of escaping uncaught into admin.rebuild().
    try {
      activateGeneration(db, reused.id);
    } catch {
      return { ok: false, code: "CTX_REBUILD_FAILED" };
    }
    return { ok: true, generation: reused };
  }

  const existing = listCortexGenerations(db);
  const base = opts.generationOrdinal ?? (existing.length ? existing[existing.length - 1]!.ordinal + 1n : 1n);
  const ordinal = base > 0n ? base : 1n;
  const generationId = `gen-${ordinal.toString()}`;

  db.exec("SAVEPOINT mc_cortex_gen");
  try {
    db.prepare(
      `INSERT INTO cortex_generation_v1
         (id, ordinal, source_high_water, record_count, root_digest, active)
       VALUES (@id, @ordinal, @hw, @count, @digest, 0)`,
    ).run({
      "@id": generationId,
      "@ordinal": ordinal,
      "@hw": sourceHighWater,
      "@count": sortedCount,
      "@digest": rootDigest,
    });
    activateGeneration(db, generationId);
    db.exec("RELEASE mc_cortex_gen");
  } catch {
    try {
      db.exec("ROLLBACK TO mc_cortex_gen");
    } catch {
      /* savepoint may already be gone on a failed exec */
    }
    try {
      db.exec("RELEASE mc_cortex_gen");
    } catch {
      /* savepoint may already be gone */
    }
    // The generation INSERT/activate did not persist. Report the non-fatal
    // storage failure — never a fabricated generation that has no durable row.
    return { ok: false, code: "CTX_REBUILD_FAILED" };
  }
  const gen = generationById(db, generationId);
  if (!gen) {
    // Defensive: no durable row is visible, so this rebuild did not persist.
    return { ok: false, code: "CTX_REBUILD_FAILED" };
  }
  return { ok: true, generation: gen };
}

/** Switch the active generation pointer (evidence retained; nothing deleted). */
export function switchCortexGeneration(db: DatabaseSync, generationId: string): { ok: boolean; code?: string } {
  if (!generationById(db, generationId)) return { ok: false, code: "CTX_GENERATION_NOT_FOUND" };
  // Activating writes to cortex_generation_v1.active; under read-only storage
  // (`PRAGMA query_only`) SQLite refuses the UPDATE. Convert that storage failure
  // into the documented `{ok:false}` result so a caller of the typed admin surface
  // never receives an uncaught SQLITE_READONLY exception (Q02 — every store
  // mutation is non-fatal).
  try {
    activateGeneration(db, generationId);
  } catch {
    return { ok: false, code: "CTX_SWITCH_FAILED" };
  }
  return { ok: true };
}

function activateGeneration(db: DatabaseSync, generationId: string): void {
  db.prepare(`UPDATE cortex_generation_v1 SET active = 0 WHERE active = 1`).run();
  db.prepare(`UPDATE cortex_generation_v1 SET active = 1 WHERE id = @id`).run({ "@id": generationId });
}

/** Highest sourceHighWater across all accepted records (the derived frontier). */
export function maxSourceHighWater(db: DatabaseSync): bigint {
  const row = db
    .prepare(`SELECT MAX(source_high_water) AS m FROM cortex_record_v1`)
    .get() as { m: number | bigint | null };
  return row.m === null ? 0n : BigInt(row.m);
}
