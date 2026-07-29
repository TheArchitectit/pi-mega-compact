/**
 * kselection.ts — S51A k-selection criterion math for topic clustering.
 *
 * Pure local math (PREVENT-PI-004): within-cluster sum of squares (cosine
 * distance), mean silhouette score, and the elbow heuristic. k-means++ is
 * reused from src/dedup/raptor/kmeans.ts. No model calls, no network.
 *
 * Extracted from cluster.ts so each module stays under the project's 300-line
 * file-size cap with a single responsibility: this module owns the
 * "which k is best" criterion; cluster.ts owns load + orchestration.
 *
 * Host-agnostic (no pi imports). Parameterized only by Vector arrays.
 */

import {
	cosineDistance,
	kmeanspp,
	meanVector,
} from "../dedup/raptor/kmeans.js";
import type { Vector } from "../embedder.js";
import type { WikiClusterConfig } from "./cluster.js";

/** One k-means candidate result for a single k, kept for criterion scoring. */
export interface Candidate {
	k: number;
	assignments: number[];
	centroids: Vector[];
	wcss: number;
	silhouette: number | null;
}

/** Within-cluster sum of squares (cosine distance) for one clustering. */
export function wcss(
	points: Vector[],
	assignments: number[],
	centroids: Vector[],
): number {
	let s = 0;
	for (let i = 0; i < points.length; i++) {
		const d = cosineDistance(points[i], centroids[assignments[i]]);
		s += d * d;
	}
	return s;
}

/**
 * Mean silhouette score across all points (−1..1); null when undefined
 * (k<=1 or k>=n, or every cluster is a singleton).
 */
export function silhouette(
	points: Vector[],
	assignments: number[],
	k: number,
): number | null {
	const n = points.length;
	if (k <= 1 || k >= n) return null;
	// Precompute cluster sizes once.
	const sizes = new Map<number, number>();
	for (const a of assignments) sizes.set(a, (sizes.get(a) ?? 0) + 1);
	let sum = 0;
	let counted = 0;
	for (let i = 0; i < n; i++) {
		const a = assignments[i];
		const ownSize = sizes.get(a) ?? 0;
		if (ownSize <= 1) continue; // singleton cluster → contribution 0 (skip)
		let aSum = 0;
		const bSum = new Map<number, number>();
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const d = cosineDistance(points[i], points[j]);
			if (assignments[j] === a) {
				aSum += d;
			} else {
				bSum.set(assignments[j], (bSum.get(assignments[j]) ?? 0) + d);
			}
		}
		const aMean = aSum / (ownSize - 1); // exclude self
		let b = Infinity;
		for (const [cluster, total] of bSum) {
			const cnt = sizes.get(cluster) ?? 0;
			if (cnt > 0) b = Math.min(b, total / cnt);
		}
		if (!Number.isFinite(b)) continue;
		const denom = Math.max(aMean, b);
		if (denom > 0) {
			sum += (b - aMean) / denom;
			counted++;
		}
	}
	return counted > 0 ? sum / counted : null;
}

/** Elbow: index of max curvature on the WCSS-vs-k curve. */
export function elbowIndex(ks: number[], wcssVals: number[]): number {
	if (ks.length <= 2) return 0;
	// Normalize and find the point farthest from the line joining the endpoints.
	const x0 = ks[0];
	const y0 = wcssVals[0];
	const x1 = ks[ks.length - 1];
	const y1 = wcssVals[wcssVals.length - 1];
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	let best = 0;
	let bestDist = -1;
	for (let i = 0; i < ks.length; i++) {
		const dist =
			Math.abs(dy * ks[i] - dx * wcssVals[i] + x1 * y0 - y1 * x0) / len;
		if (dist > bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

/** Run k-means with restarts for one k; keep the lowest-WCSS result. */
export function bestForK(
	points: Vector[],
	k: number,
	cfg: WikiClusterConfig,
): Candidate {
	let best: Candidate | null = null;
	for (let r = 0; r < cfg.restarts; r++) {
		const res = kmeanspp(points, k, { seed: cfg.seed + r });
		if (res.k === 0) continue;
		const w = wcss(points, res.assignments, res.centroids);
		if (!best || w < best.wcss) {
			best = {
				k: res.k,
				assignments: res.assignments,
				centroids: res.centroids,
				wcss: w,
				silhouette: null,
			};
		}
	}
	// Degenerate: kmeans collapsed everything to < k clusters.
	if (!best) {
		const mean = meanVector(points);
		best = {
			k: 1,
			assignments: points.map(() => 0),
			centroids: [mean],
			wcss: 0,
			silhouette: null,
		};
	}
	best.silhouette = silhouette(points, best.assignments, best.k);
	return best;
}

/** The chosen candidate + which criterion selected it. */
export interface SelectedK {
	candidate: Candidate;
	criterion: "elbow" | "silhouette";
}

/**
 * Run k-means across the k search space and pick the best candidate:
 * prefer silhouette when any candidate produced a computable score, else
 * the elbow on the WCSS curve. `points` must be non-empty and `ks` non-empty.
 */
export function selectK(
	points: Vector[],
	ks: number[],
	cfg: WikiClusterConfig,
): SelectedK {
	const candidates = ks.map((k) => bestForK(points, k, cfg));
	const withSil = candidates.filter((c) => c.silhouette !== null);
	if (withSil.length > 0) {
		const chosen = withSil.reduce((a, b) =>
			(b.silhouette ?? -1) > (a.silhouette ?? -1) ? b : a,
		);
		return { candidate: chosen, criterion: "silhouette" };
	}
	const idx = elbowIndex(
		candidates.map((c) => c.k),
		candidates.map((c) => c.wcss),
	);
	return { candidate: candidates[idx], criterion: "elbow" };
}
