/**
 * vectorIndex.ts — Slice 2 async vector index (PGlite/pgvector HNSW).
 *
 * A REDUNDANT, additive, ASYNC index layered over the synchronous node:sqlite
 * store (which remains the authoritative source of truth). The sync linear
 * cosine scan over `embedding_blob` stays the DEFAULT recall path; this index
 * exists only to provide real cross-repo / cross-session HNSW nearest-neighbor
 * recall. It is best-effort and non-fatal: any init/write failure degrades to
 * the sync scan and must NEVER break add(), compaction, or extension load.
 *
 * PREVENT-PI-004: PGlite is WASM Postgres — fully local, zero network.
 *
 * Index topology (decision 2026-07-15): ONE global PGlite DB, `repo_id` is a
 * first-class column. `searchAsync(q, k, {repoId?})` → omit repoId for cross-repo
 * NN, pass repoId to scope to a single repo. The sync store is per-repo (state
 * dir); this global index is the thing that makes cross-repo recall possible.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// PGlite + pgvector are script-free WASM (no native build) → survive pi's
// install-script block. Imported lazily so a missing/broken package degrades
// gracefully instead of crashing module load.
import { PGlite, type PGlite as PGliteInstance } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/** Vector dimension produced by the default TrigramEmbedder (src/embedder.ts). */
export const EMBEDDING_DIM = 512;

/** A single recall hit returned by the async index. */
export interface VectorIndexHit {
  repoId: string;
  sessionId: string;
  checkpointId: string;
  /** Cosine similarity in [0,1] (1 = identical). */
  score: number;
}

let db: PGliteInstance | undefined;
let initPromise: Promise<PGliteInstance | undefined> | undefined;
let disabled = false;
let warned = false;

function indexDir(): string {
  const override = process.env.MEGACOMPACT_VECTOR_INDEX_DIR;
  if (override && override.trim() !== "") return override;
  try {
    return join(homedir(), ".pi", "mega-compact-vector");
  } catch {
    return join("/tmp", ".mega-compact-vector");
  }
}

function logWarn(msg: string): void {
  // Never throw — degradation is the whole point. One warning per process.
  if (warned) return;
  warned = true;
  try {
    console.warn(`[mega-compact:vectorIndex] ${msg} (falling back to sync scan)`);
  } catch {
    /* ignore */
  }
}

/** Honor the emergency kill-switch. When set, the index is fully disabled. */
export function isVectorIndexDisabled(): boolean {
  return (
    disabled ||
    process.env.MEGACOMPACT_PGLITE_DISABLED === "true" ||
    process.env.MEGACOMPACT_PGLITE_DISABLED === "1"
  );
}

/**
 * Lazily open + schema-init the global PGlite DB. Idempotent and safe to call
 * from many places. Returns undefined when disabled/unavailable so callers can
 * fall back to the synchronous scan. Never throws.
 */
export function initVectorIndex(): Promise<PGliteInstance | undefined> {
  if (isVectorIndexDisabled()) return Promise.resolve(undefined);
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<PGliteInstance | undefined> => {
    try {
      const dir = indexDir();
      mkdirSync(dir, { recursive: true });
      const pg = await new PGlite({
        dataDir: dir,
        extensions: { vector },
      });
      await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS vector_index (
          repo_id       TEXT NOT NULL,
          session_id    TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          embedding     vector(${EMBEDDING_DIM}) NOT NULL,
          PRIMARY KEY (repo_id, session_id, checkpoint_id)
        );
      `);
      // HNSW index over cosine distance for fast NN. Created idempotently.
      await pg.exec(
        "CREATE INDEX IF NOT EXISTS vector_index_hnsw ON vector_index USING hnsw (embedding vector_cosine_ops);",
      );
      db = pg;
      return pg;
    } catch (err) {
      disabled = true;
      logWarn(`init failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();
  return initPromise;
}

function toVectorLiteral(v: number[]): string {
  // pgvector text form: [a,b,c]. Guard against NaN/Inf for a clean literal.
  const parts = v.map((x) => (Number.isFinite(x) ? x : 0));
  return `[${parts.join(",")}]`;
}

/**
 * Best-effort upsert of one checkpoint embedding into the global index.
 * Dimension-mismatched vectors (e.g. a BYO embedder with dim ≠ 512) are skipped
 * rather than corrupting the index. Fire-and-forget: resolved promise only;
 * callers must NOT await this on the sync path. Never throws.
 */
export async function upsertEmbedding(
  repoId: string,
  sessionId: string,
  checkpointId: string,
  embedding: number[],
): Promise<void> {
  if (isVectorIndexDisabled()) return;
  if (!embedding || embedding.length !== EMBEDDING_DIM) {
    // Dimension guard: skip without corrupting the fixed-dim index.
    return;
  }
  try {
    const pg = await initVectorIndex();
    if (!pg) return;
    const lit = toVectorLiteral(embedding);
    await pg.query(
      `INSERT INTO vector_index (repo_id, session_id, checkpoint_id, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (repo_id, session_id, checkpoint_id)
       DO UPDATE SET embedding = EXCLUDED.embedding;`,
      [repoId, sessionId, checkpointId, lit],
    );
  } catch (err) {
    disabled = true;
    logWarn(`upsert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface SearchAsyncOpts {
  /** When provided, scope the NN search to a single repo; omit for cross-repo. */
  repoId?: string;
  /** Max hits (default 3). */
  k?: number;
}

/**
 * Cross-repo (or single-repo) HNSW nearest-neighbor search. Returns hits sorted
 * by descending similarity. Never throws — on any failure returns [].
 */
export async function searchAsync(
  query: number[],
  opts: SearchAsyncOpts = {},
): Promise<VectorIndexHit[]> {
  if (isVectorIndexDisabled() || !query || query.length !== EMBEDDING_DIM) return [];
  const k = opts.k ?? 3;
  const repoId = opts.repoId;
  try {
    const pg = await initVectorIndex();
    if (!pg) return [];
    const lit = toVectorLiteral(query);
    const params: unknown[] = [lit, k];
    let sql =
      "SELECT repo_id, session_id, checkpoint_id, 1 - (embedding <=> $1::vector) AS score " +
      "FROM vector_index";
    if (repoId) {
      sql += " WHERE repo_id = $3";
      params.push(repoId);
    }
    sql += " ORDER BY embedding <=> $1::vector LIMIT $2";
    const res = await pg.query(sql, params);
    return res.rows.map((r: any) => ({
      repoId: r.repo_id as string,
      sessionId: r.session_id as string,
      checkpointId: r.checkpoint_id as string,
      score: r.score as number,
    }));
  } catch (err) {
    disabled = true;
    logWarn(`search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Close the index (test teardown / shutdown). Safe to call when unopened. */
export async function closeVectorIndex(): Promise<void> {
  if (db) {
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  }
  db = undefined;
  initPromise = undefined;
}

/**
 * Rebuild the entire index from the authoritative node:sqlite store. Used for
 * backfill + DR. `enumerateRepoStateDirs` yields each repo's state dir; we read
 * its checkpoint embeddings and bulk upsert. Best-effort: counts successes and
 * skips failures. Returns {upserted, errors}.
 */
export async function rebuildFromSqlite(
  enumerateRepoStateDirs: () => Iterable<{ repoId: string; stateDir: string }>,
  readCheckpoints: (
    stateDir: string,
  ) => Iterable<{ sessionId: string; checkpointId: string; embedding: number[] }>,
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;
  const pg = await initVectorIndex();
  if (!pg) return { upserted, errors: 1 };
  for (const repo of enumerateRepoStateDirs()) {
    for (const cp of readCheckpoints(repo.stateDir)) {
      try {
        await upsertEmbedding(repo.repoId, cp.sessionId, cp.checkpointId, cp.embedding);
        upserted++;
      } catch {
        errors++;
      }
    }
  }
  return { upserted, errors };
}
