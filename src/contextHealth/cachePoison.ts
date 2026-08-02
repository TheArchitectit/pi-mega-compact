/**
 * contextHealth/cachePoison.ts — tri-layer KV cache poison validator (v0.9.1).
 *
 * Three validation layers for detecting corrupted KV cache state. Each layer
 * triggers independently; the composite score maps the number of triggered
 * layers to a 0-1 health metric (1 = healthy, 0 = poisoned).
 *
 * Pure functions — zero I/O, zero SQLite, zero network. All inputs are
 * primitive values or arrays passed in; this module makes no external calls
 * and carries no state between invocations.
 *
 * Guardrails: no `any` (PREVENT-011), no un-null-checked JSON.parse
 * (PREVENT-001), zero network (PREVENT-PI-004 trivially satisfied — this
 * module never calls fetch or opens sockets).
 */

/** FNV-1a 32-bit offset basis (must match TrigramEmbedder._embedRaw). */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime (must match TrigramEmbedder._embedRaw). */
const FNV_PRIME = 0x01000193;
/** Max input characters for prefix hash (4 KB of UTF-16). */
const PREFIX_HASH_CAP = 4096;

// ─── Layer 1 — Hash validation ──────────────────────────────────────────────

/**
 * Compute a stable 32-bit FNV-1a hash over the first 4 KB of the concatenated
 * message text. Returns a lower-case hex string.
 *
 * The algorithm is identical to `TrigramEmbedder._embedRaw`'s internal hash
 * (offset basis 0x811c9dc5, prime 0x01000193), so any change visible to the
 * embedder is also visible here.
 */
export function computePrefixHash(messages: string[]): string {
	let combined = "";
	for (let i = 0; i < messages.length; i++) {
		combined += messages[i];
		if (combined.length >= PREFIX_HASH_CAP) break;
	}
	const input = combined.length > PREFIX_HASH_CAP
		? combined.slice(0, PREFIX_HASH_CAP)
		: combined;

	let h = FNV_OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, FNV_PRIME);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Layer 1: detect when the KV cache prefix has been silently mutated.
 *
 * Trigger conditions:
 *   - cacheRead > 0  (cache was actually used)
 *   - storedHash !== null  (we have a baseline from a prior turn)
 *   - currentHash !== storedHash  (prefix text has drifted)
 *
 * Not triggered when: cache was never read, or no baseline exists (first turn).
 */
export function checkPrefixHash(
	currentHash: string,
	storedHash: string | null,
	cacheRead: number,
): { poisoned: boolean; detail: string } {
	if (cacheRead === 0) {
		return { poisoned: false, detail: "no cache read" };
	}
	if (storedHash === null) {
		return { poisoned: false, detail: "no stored hash baseline" };
	}
	if (currentHash !== storedHash) {
		return {
			poisoned: true,
			detail:
				`prefix hash mismatch: cached prefix changed without cache invalidation (current=${currentHash} stored=${storedHash})`,
		};
	}
	return { poisoned: false, detail: "prefix hash matches baseline" };
}

// ─── Layer 2 — Semantic validation ──────────────────────────────────────────

/** Arithmetic mean of a non-empty number array. */
function mean(values: number[]): number {
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/**
 * Layer 2: detect when cache-hit outputs are semantically worse than cache-miss
 * outputs.
 *
 * Trigger conditions:
 *   - both groups have at least 3 samples (statistical floor)
 *   - cache-hit mean quality is more than 0.15 below cache-miss mean quality
 *
 * Not triggered when: insufficient data in either group.
 */
export function compareOutputQualityByCacheHit(
	qualityByCacheHit: number[],
	qualityByCacheMiss: number[],
): { poisoned: boolean; detail: string } {
	const hitN = qualityByCacheHit.length;
	const missN = qualityByCacheMiss.length;

	if (hitN < 3 || missN < 3) {
		return {
			poisoned: false,
			detail: `insufficient quality samples: hit=${hitN} miss=${missN} (need >= 3 each)`,
		};
	}

	const hitMean = mean(qualityByCacheHit);
	const missMean = mean(qualityByCacheMiss);
	const threshold = missMean - 0.15;

	if (hitMean < threshold) {
		return {
			poisoned: true,
			detail:
				`cache-hit quality degraded: hitMean=${hitMean.toFixed(3)} missMean=${missMean.toFixed(3)} (threshold=${threshold.toFixed(3)})`,
		};
	}
	return {
		poisoned: false,
		detail: `quality comparable: hitMean=${hitMean.toFixed(3)} missMean=${missMean.toFixed(3)}`,
	};
}

// ─── Layer 3 — Behavioral validation ────────────────────────────────────────

/**
 * Layer 3: detect when errors cluster on cache-hit turns (indicating the cache
 * is returning corrupt state rather than fresh computation catching them).
 *
 * Trigger conditions (all three must hold):
 *   - sampleCount >= 5
 *   - errorRateCacheHit > errorRateCacheMiss * 2  (hit error rate is >2x miss rate)
 *   - errorRateCacheHit > 0.1  (absolute hit error rate is non-trivial)
 *
 * Not triggered when: insufficient observations.
 */
export function correlateErrorsWithCacheHits(
	errorRateCacheHit: number,
	errorRateCacheMiss: number,
	sampleCount: number,
): { poisoned: boolean; detail: string } {
	if (sampleCount < 5) {
		return {
			poisoned: false,
			detail: `insufficient behavioral samples: n=${sampleCount} (need >= 5)`,
		};
	}
	if (
		errorRateCacheHit > errorRateCacheMiss * 2 &&
		errorRateCacheHit > 0.1
	) {
		return {
			poisoned: true,
			detail:
				`error rate inflated on cache hits: hit=${errorRateCacheHit.toFixed(3)} miss=${errorRateCacheMiss.toFixed(3)} (2x breach + absolute floor)`,
		};
	}
	return {
		poisoned: false,
		detail:
			`error rates normal: hit=${errorRateCacheHit.toFixed(3)} miss=${errorRateCacheMiss.toFixed(3)}`,
	};
}

// ─── Composite score ─────────────────────────────────────────────────────────

/**
 * Compute a 0-1 composite cache poison score from layer triggers.
 *
 * | triggered layers | score |
 * |-----------------|-------|
 * | 0               | 1.0   |
 * | 1               | 0.3   |
 * | 2               | 0.15  |
 * | 3               | 0.0   |
 *
 * Higher = healthier.  Scores below ~0.3 warrant immediate cache invalidation.
 */
export function computeCachePoisonScore(
	l1: boolean,
	l2: boolean,
	l3: boolean,
): number {
	const triggers = (l1 ? 1 : 0) + (l2 ? 1 : 0) + (l3 ? 1 : 0);
	switch (triggers) {
		case 0: return 1.0;
		case 1: return 0.3;
		case 2: return 0.15;
		case 3: return 0.0;
		default: return 0.0; // should never reach
	}
}

/** Result shape returned by `evaluateCachePoison`. */
export interface CachePoisonResult {
	score: number;
	layer1: { poisoned: boolean; detail: string };
	layer2: { poisoned: boolean; detail: string };
	layer3: { poisoned: boolean; detail: string };
}

/**
 * Run all three validation layers and return a composite result.
 *
 * All arguments are primitive values; this function is pure and stateless.
 */
export function evaluateCachePoison(args: {
	currentHash: string;
	storedHash: string | null;
	cacheRead: number;
	qualityByCacheHit: number[];
	qualityByCacheMiss: number[];
	errorRateCacheHit: number;
	errorRateCacheMiss: number;
	sampleCount: number;
}): CachePoisonResult {
	const l1 = checkPrefixHash(args.currentHash, args.storedHash, args.cacheRead);
	const l2 = compareOutputQualityByCacheHit(
		args.qualityByCacheHit,
		args.qualityByCacheMiss,
	);
	const l3 = correlateErrorsWithCacheHits(
		args.errorRateCacheHit,
		args.errorRateCacheMiss,
		args.sampleCount,
	);

	return {
		score: computeCachePoisonScore(l1.poisoned, l2.poisoned, l3.poisoned),
		layer1: l1,
		layer2: l2,
		layer3: l3,
	};
}