/**
 * embedding-cache.ts — read-or-compute embedding with content-hash caching.
 *
 * The `embedding_cache` table (schema at schema.ts:421) avoids re-embedding the
 * same content on every graph build. D3 Source B/C callers first hit this cache;
 * only cache misses run the embedder.
 *
 * Non-fatal: all errors are caught and return [] so the graph build never breaks.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultEmbedder } from "../../embedder.js";
import { encodeEmbedding } from "./utils.js";

/**
 * Decode a Float32 BLOB back to a number[].
 *
 * Mirrors decodeEmbedding from utils.ts but accepts a Buffer explicitly (the
 * type node:sqlite returns for BLOB columns). Also handles Uint8Array (the
 * common node:sqlite runtime type) via DataView.
 *
 * Returns an empty array for null/undefined/zero-length input.
 */
export function decodeEmbeddingBlob(buf: Buffer | Uint8Array | null | undefined): number[] {
  if (!buf || buf.byteLength === 0) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.byteLength / 4;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/**
 * Read an embedding for `content` from the cache, or compute and store it.
 *
 * 1. Hash content with SHA-256 → hex digest (matches the content_hash convention).
 * 2. SELECT from embedding_cache — hit → decode blob → return number[].
 * 3. Miss → embed via defaultEmbedder() → encode → INSERT OR REPLACE → return.
 *
 * Non-fatal: any error is caught, logged, and returns [].
 *
 * @param db - Open node:sqlite DatabaseSync (embedding_cache table must exist).
 * @param content - Text to embed (e.g. a context chunk's raw text).
 * @returns The 512‑dim embedding vector, or [] on cache-hit decode failure or
 *          any error.
 */
export function getOrComputeEmbedding(db: DatabaseSync, content: string): number[] {
  try {
    const hash = createHash("sha256").update(content).digest("hex");

    // Parameterized query — PREVENT-002
    const row = db
      .prepare("SELECT embedding FROM embedding_cache WHERE content_hash = ?")
      .get(hash) as { embedding: Buffer } | undefined;

    if (row) {
      return decodeEmbeddingBlob(row.embedding);
    }

    // Cache miss: embed, store, return
    const embedder = defaultEmbedder();
    const vec = embedder.embed(content);
    const blob = encodeEmbedding(vec);

    db.prepare(
      "INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, computed_at) VALUES (?, ?, ?)"
    ).run(hash, blob, Date.now());

    return vec;
  } catch (err) {
    // Non-fatal: log and degrade gracefully
    const msg = err instanceof Error ? err.message : String(err);
    // Logger not imported here to keep this leaf self-contained; stderr is
    // acceptable for an error path that signals a bug, not a user‑facing log.
    process.stderr.write(
      `[embedding-cache] getOrComputeEmbedding error: ${msg}\n`
    );
    return [];
  }
}
