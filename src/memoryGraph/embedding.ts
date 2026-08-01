/**
 * embedding.ts — D3 embedding helpers for memoryGraph source builders.
 *
 * Uses TrigramEmbedder with an in-memory SQLite cache table.
 * Isolated here so the main module stays under the 500-line limit.
 */
import type { DatabaseSync } from "node:sqlite";
import { TrigramEmbedder } from "../embedder.js";

let _trigramEmbedder: TrigramEmbedder | null = null;

function lazyEmbedder(): TrigramEmbedder {
  if (!_trigramEmbedder) {
    _trigramEmbedder = new TrigramEmbedder();
  }
  return _trigramEmbedder;
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h.toString(36);
}

/** Compute or retrieve a cached embedding vector for a text string.
 *  Uses the embedding_cache table (created by the A2 migration) for
 *  persistence. Falls back to uncached TrigramEmbedder on table error. */
export function getOrComputeEmbedding(db: DatabaseSync, content: string): number[] {
  try {
    const hash = simpleHash(content);
    const cached = db
      .prepare("SELECT embedding FROM embedding_cache WHERE content_hash = ?")
      .get(hash) as { embedding: string } | undefined;
    if (cached && typeof cached.embedding === "string") {
      return JSON.parse(cached.embedding) as number[];
    }
    const vec = lazyEmbedder().embed(content);
    db.prepare(
      "INSERT OR REPLACE INTO embedding_cache (content_hash, content, embedding) VALUES (?, ?, ?)",
    ).run(hash, content, JSON.stringify(vec));
    return vec;
  } catch {
    return lazyEmbedder().embed(content);
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}