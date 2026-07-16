/**
 * memoryIndex.ts — cross-repo async vector index for durable memories (S24).
 *
 * A REDUNDANT, additive, ASYNC index layered over the authoritative node:sqlite
 * `memories` table. The same-repo linear cosine scan over the in-repo memories
 * (src/memoryRecall.ts) stays the DEFAULT recall path; this global PGlite index
 * exists only to provide real cross-repo nearest-neighbor memory recall — so a
 * decision you saved in repo A can be inlined as RAG context when you start a
 * session in repo B. It is best-effort and non-fatal: any init/write failure
 * degrades to the same-repo scan and must NEVER break memory write, recall, or
 * extension load.
 *
 * PREVENT-PI-004: PGlite is WASM Postgres — fully local, zero network. Memory
 * remains AUTHORITATIVE in SQLite; this index only holds (repo_id, memory_id,
 * content, embedding) for NN lookup and is rebuilt from SQLite at any time.
 *
 * Topology mirrors vectorIndex.ts (Slice 2): ONE global PGlite DB, `repo_id` is
 * a first-class column. `searchMemoriesAsync(q, k, {repoId?})` → omit repoId for
 * cross-repo NN, pass repoId to scope to a single repo. Hit content is stored
 * inline because the recall process cannot open every other repo's SQLite dir.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";

// PGlite + pgvector are script-free WASM (no native build) → survive pi's
// install-script block. Imported lazily so a missing/broken package degrades
// gracefully instead of crashing module load.
import { PGlite, type PGlite as PGliteInstance } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/** Vector dimension produced by the default TrigramEmbedder (src/embedder.ts). */
export const MEMORY_INDEX_DIM = 512;

/** A single cross-repo memory hit returned by the async index. */
export interface MemoryIndexHit {
  repoId: string;
  memoryId: number;
  /** Inline content so recall can read it without opening the other repo's db. */
  content: string;
  /** Cosine similarity in [0,1] (1 = identical). */
  score: number;
}

let db: PGliteInstance | undefined;
let initPromise: Promise<PGliteInstance | undefined> | undefined;
let disabled = false;
let warned = false;

function indexDir(): string {
  const override = process.env.MEGACOMPACT_INDEX_DIR;
  if (override && override.trim() !== "") return join(override, "memory");
  try {
    return join(homedir(), ".pi", "mega-compact-vector", "memory");
  } catch {
    return join("/tmp", ".mega-compact-vector", "memory");
  }
}

function logWarn(msg: string): void {
  // Never throw — degradation is the whole point. One warning per process.
  if (warned) return;
  warned = true;
  try {
    console.warn(`[mega-compact:memoryIndex] ${msg} (falling back to same-repo scan)`);
  } catch {
    /* ignore */
  }
}

/** Honor the emergency kill-switch (shared with the checkpoint index). */
export function isMemoryIndexDisabled(): boolean {
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
export function initMemoryIndex(): Promise<PGliteInstance | undefined> {
  if (isMemoryIndexDisabled()) return Promise.resolve(undefined);
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;
  initPromise = openPgLite(/* retryOnCorrupt */ true);
  return initPromise;
}

/**
 * Open + schema-init PGlite. When `retryOnCorrupt` is true, a WASM-level abort
 * (typically from a corrupted/torn data dir) triggers a delete + one retry.
 */
async function openPgLite(
  retryOnCorrupt: boolean,
): Promise<PGliteInstance | undefined> {
  try {
    const dir = indexDir();
    mkdirSync(dir, { recursive: true });
    const pg = await new PGlite({
      dataDir: dir,
      extensions: { vector },
    });
    await pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS memory_index (
        repo_id    TEXT NOT NULL,
        memory_id  INTEGER NOT NULL,
        content    TEXT NOT NULL,
        embedding  vector(${MEMORY_INDEX_DIM}) NOT NULL,
        PRIMARY KEY (repo_id, memory_id)
      );
    `);
    await pg.exec(
      "CREATE INDEX IF NOT EXISTS memory_index_hnsw ON memory_index USING hnsw (embedding vector_cosine_ops);",
    );
    db = pg;
    return pg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (retryOnCorrupt && (msg.includes("Aborted") || msg.includes("RuntimeError"))) {
      try {
        const dir = indexDir();
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        initPromise = undefined;
        return openPgLite(/* retryOnCorrupt */ false);
      } catch {
        /* self-heal failed — fall through to disable */
      }
    }
    disabled = true;
    logWarn(`init failed: ${msg}`);
    return undefined;
  }
}

function toVectorLiteral(v: number[]): string {
  const parts = v.map((x) => (Number.isFinite(x) ? x : 0));
  return `[${parts.join(",")}]`;
}

/**
 * Best-effort upsert of one memory embedding into the global index.
 * Dimension-mismatched vectors (e.g. a BYO embedder with dim ≠ 512) are skipped.
 * Fire-and-forget: callers must NOT await this on the sync write path. Never
 * throws. `content` is stored inline so cross-repo recall can read it directly.
 */
export async function upsertMemoryEmbedding(
  repoId: string,
  memoryId: number,
  content: string,
  embedding: number[],
): Promise<void> {
  if (isMemoryIndexDisabled()) return;
  if (!embedding || embedding.length !== MEMORY_INDEX_DIM) return;
  try {
    const pg = await initMemoryIndex();
    if (!pg) return;
    const lit = toVectorLiteral(embedding);
    await pg.query(
      `INSERT INTO memory_index (repo_id, memory_id, content, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (repo_id, memory_id)
       DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding;`,
      [repoId, memoryId, content, lit],
    );
  } catch (err) {
    disabled = true;
    logWarn(`upsert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface SearchMemoriesAsyncOpts {
  /** When provided, scope the NN search to a single repo; omit for cross-repo. */
  repoId?: string;
  /** Max hits (default 5). */
  k?: number;
}

/**
 * Cross-repo (or single-repo) HNSW nearest-neighbor memory search. Returns hits
 * sorted by descending similarity. Never throws — on any failure returns [].
 */
export async function searchMemoriesAsync(
  query: number[],
  opts: SearchMemoriesAsyncOpts = {},
): Promise<MemoryIndexHit[]> {
  if (isMemoryIndexDisabled() || !query || query.length !== MEMORY_INDEX_DIM) return [];
  const k = opts.k ?? 5;
  const repoId = opts.repoId;
  try {
    const pg = await initMemoryIndex();
    if (!pg) return [];
    const lit = toVectorLiteral(query);
    const params: unknown[] = [lit, k];
    let sql =
      "SELECT repo_id, memory_id, content, 1 - (embedding <=> $1::vector) AS score " +
      "FROM memory_index";
    if (repoId) {
      sql += " WHERE repo_id = $3";
      params.push(repoId);
    }
    sql += " ORDER BY embedding <=> $1::vector LIMIT $2";
    const res = await pg.query(sql, params);
    return res.rows.map((r: any) => ({
      repoId: r.repo_id as string,
      memoryId: Number(r.memory_id),
      content: r.content as string,
      score: r.score as number,
    }));
  } catch (err) {
    disabled = true;
    logWarn(`search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Close the index (test teardown / shutdown). Safe to call when unopened. */
export async function closeMemoryIndex(): Promise<void> {
  if (db) {
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  }
  db = undefined;
  initPromise = undefined;
  disabled = false;
  warned = false;
}
