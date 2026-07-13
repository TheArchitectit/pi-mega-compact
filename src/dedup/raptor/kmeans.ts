/**
 * kmeans.ts — k-means++ clustering over embeddings (Sprint 13, RAPTOR Phase 6).
 *
 * Pure TS, zero deps, deterministic (seeded). Used to group leaf chunks into
 * nodes for the RAPTOR summary tree. QA #11: GMM is the spec's long-term target
 * for cosine space; k-means++ is the shippable local default, with a
 * near-zero-variance merge guard so degenerate inputs can't spin forever.
 *
 * PREVENT-PI-004: math only, no network, no model.
 */

import type { Vector } from "../../embedder.js";
import { cosineSimilarity } from "../../embedder.js";

/** Seeded PRNG (mulberry32) so clustering is deterministic across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L2 distance squared between two equal-length vectors. */
function dist2(a: Vector, b: Vector): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

export interface KMeansResult {
  /** Cluster assignment per input point (index → cluster id). */
  assignments: number[];
  /** Centroids, one per cluster. */
  centroids: Vector[];
  /** Number of clusters actually produced (may be < k for degenerate input). */
  k: number;
}

/**
 * k-means++ clustering. Deterministic given `seed`.
 *
 * Near-zero-variance guard (QA #11): if the max pairwise distance among input
 * points is below `varianceFloor`, all points are effectively identical — return
 * a single cluster (the mean) instead of iterating. Prevents the centroid-init
 * from dividing by ~0 and keeps degenerate sessions from spinning.
 */
export function kmeanspp(
  points: Vector[],
  k: number,
  opts: { seed?: number; maxIter?: number; varianceFloor?: number } = {},
): KMeansResult {
  const n = points.length;
  const seed = opts.seed ?? 0x9e3779b9;
  const maxIter = opts.maxIter ?? 25;
  const varianceFloor = opts.varianceFloor ?? 1e-12;

  if (n === 0) return { assignments: [], centroids: [], k: 0 };
  if (n === 1) return { assignments: [0], centroids: [points[0].slice()], k: 1 };

  // Near-zero-variance merge guard.
  let maxPair = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist2(points[i], points[j]);
      if (d > maxPair) maxPair = d;
    }
  }
  if (maxPair < varianceFloor) {
    const mean = new Array<number>(points[0].length).fill(0);
    for (const p of points) for (let i = 0; i < mean.length; i++) mean[i] += p[i] / n;
    return { assignments: new Array<number>(n).fill(0), centroids: [mean], k: 1 };
  }

  const kk = Math.min(k, n);
  const rand = rng(seed);

  // k-means++ seeding: first centroid random, rest weighted by squared distance.
  const centroids: Vector[] = [points[Math.floor(rand() * n)].slice()];
  const d2 = new Array<number>(n).fill(Infinity);
  while (centroids.length < kk) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(points[i], centroids[centroids.length - 1]);
      if (d < d2[i]) d2[i] = d;
      sum += d2[i];
    }
    if (sum === 0) {
      // All remaining points coincide with an existing centroid.
      for (const p of points) if (!centroids.some((c) => dist2(c, p) < 1e-12)) centroids.push(p.slice());
      break;
    }
    let target = rand() * sum;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) { chosen = i; break; }
    }
    centroids.push(points[chosen].slice());
  }

  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    // Assign each point to its nearest centroid.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = dist2(points[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    // Recompute centroids as the mean of assigned points.
    const sums = centroids.map(() => new Array<number>(points[0].length).fill(0));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < points[i].length; d++) sums[c][d] += points[i][d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue; // keep prior centroid if a cluster emptied
      centroids[c] = sums[c].map((s) => s / counts[c]);
    }
    if (!changed && iter > 0) break;
  }

  return { assignments, centroids, k: centroids.length };
}

/** Mean embedding of a set of vectors (used to reduce a cluster to its centroid). */
export function meanVector(vectors: Vector[]): Vector {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map((s) => s / vectors.length);
}

/** Centroid of the union of two clusters (cosine-space "midpoint" via mean). */
export function mergeCentroids(a: Vector, b: Vector): Vector {
  return meanVector([a, b]);
}

/** Cosine distance (1 - cosine) — used by tree.ts for budget/quality checks. */
export function cosineDistance(a: Vector, b: Vector): number {
  return 1 - cosineSimilarity(a, b);
}
