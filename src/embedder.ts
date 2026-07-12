/**
 * embedder.ts — pluggable text embedding for the local vector store.
 *
 * Default (and only) embedder is a zero-dependency, deterministic hashed
 * n-gram bag encoder — no native build, no network, no external library,
 * works offline. It is heuristic-strength (good enough to rank "which
 * checkpoint is relevant to this query?"), not RAG-grade. The `Embedder`
 * interface is the seam if a stronger local model is ever added, but the
 * extension ships self-contained with no third-party dependency.
 */

export type Vector = number[];

/** Common embedding contract. Implementations must be deterministic. */
export interface Embedder {
  /** Dimensionality of vectors this embedder produces. */
  readonly dim: number;
  embed(text: string): Vector;
}

/** Normalize a vector to unit length (cosine-sim safe). Returns a new array. */
export function l2Normalize(v: Vector): Vector {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

/** Cosine similarity in [-1, 1]. Assumes inputs are same dim. */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Stable 32-bit string hash (FNV-1a). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Default embedder: character 3-gram bag-of-counts, hashed into a fixed-dim
 * vector, L2-normalized. Captures local lexical/structure overlap well enough
 * for checkpoint relevance ranking.
 */
export class TrigramEmbedder implements Embedder {
  readonly dim: number;
  private readonly seed: number;

  constructor(dim = 512, seed = 0x9e3779b9) {
    this.dim = dim;
    this.seed = seed >>> 0;
  }

  embed(text: string): Vector {
    const vec = new Array<number>(this.dim).fill(0);
    const norm = text.toLowerCase().replace(/\s+/g, " ");
    if (norm.length === 0) return l2Normalize(vec);
    // Whole-string + word + char-trigram signals.
    vec[fnv1a(norm) % this.dim] += 1;
    for (const word of norm.split(" ")) {
      if (word.length === 0) continue;
      vec[fnv1a(word) % this.dim] += 1;
      for (let i = 0; i + 3 <= word.length; i++) {
        const gram = word.slice(i, i + 3);
        const idx = (fnv1a(gram) ^ this.seed) % this.dim;
        vec[idx] += 1;
      }
    }
    // Edge: very short tokens still get a slot.
    if (norm.length < 3) vec[fnv1a(norm) % this.dim] += 1;
    return l2Normalize(vec);
  }
}

export function defaultEmbedder(): Embedder {
  return new TrigramEmbedder();
}
