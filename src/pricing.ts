/**
 * pricing.ts — Reusable pricing constants and cache-savings computation.
 *
 * Single source of truth for provider prompt-cache pricing multipliers and
 * known model input rates. Extracted from routes-cache.ts inline arithmetic.
 *
 * PREVENT-PI-004: compute-only, zero network. No SQL, no IO.
 */

// ─── Cache Pricing Multipliers ──────────────────────────────────────────────

/**
 * Fraction of input cost saved per cache-read token.
 * Cache reads cost 10% of full input → you save 90% of the input cost.
 */
export const CACHE_READ_MULTIPLIER = 0.9;

/**
 * Fraction of input cost incurred as a premium per cache-write token.
 * Cache writes cost 125% of full input → a 25% premium over a normal input token.
 */
export const CACHE_WRITE_MULTIPLIER = 0.25;

// ─── Known Model Input Rates ─────────────────────────────────────────────────
// USD per input token. Exact-match first, then prefix-match.

export const MODEL_INPUT_RATES: Record<string, number> = {
	"claude-sonnet-4": 3e-6, // $3/Mtok
	"claude-3.5-sonnet": 3e-6,
	"claude-3-opus": 15e-6,
	"claude-3-haiku": 0.25e-6,
	"claude-3.5-haiku": 0.8e-6,
	"gpt-4o": 2.5e-6,
	"gpt-4o-mini": 0.15e-6,
	"gpt-4-turbo": 10e-6,
	"gpt-3.5-turbo": 0.5e-6,
	"gemini-2.5-pro": 1.25e-6,
	"gemini-2.5-flash": 0.15e-6,
	"gemini-2.0-flash": 0.1e-6,
	"deepseek-chat": 0.14e-6,
	"deepseek-reasoner": 0.55e-6,
	codestral: 0.3e-6,
	"mistral-large": 2e-6,
	"llama-3.1-405b": 1.33e-6,
	"llama-3.1-70b": 0.8e-6,
	"llama-3.1-8b": 0.05e-6,
};

/**
 * Look up the input-token rate (USD) for a model string.
 * Exact match first, then prefix match (e.g. "claude-sonnet-4-20250514" → 3e-6).
 */
export function lookupModelInputRate(model: string): number | undefined {
	// exact match first
	if (MODEL_INPUT_RATES[model] != null) return MODEL_INPUT_RATES[model];
	// prefix match
	for (const [key, rate] of Object.entries(MODEL_INPUT_RATES)) {
		if (model.startsWith(key)) return rate;
	}
	return undefined;
}

// ─── Cache Savings Computation ──────────────────────────────────────────────

export interface CacheSavings {
	readonly cacheReadSaved: number;
	readonly cacheWriteCost: number;
	readonly netSaved: number;
}

/**
 * Compute dollar savings from provider prompt cache read/write token counts.
 *
 * @param totalCacheRead — total cache-read tokens over the lifetime.
 * @param totalCacheWrite — total cache-write tokens over the lifetime.
 * @param inputRate — the model's input-token rate in USD (e.g. 3e-6 for Sonnet).
 * @returns `{ cacheReadSaved, cacheWriteCost, netSaved }` — or all zeros when
 *   `inputRate` is zero or negative.
 */
export function computeCacheSavings(
	totalCacheRead: number,
	totalCacheWrite: number,
	inputRate: number,
): CacheSavings {
	if (inputRate <= 0) {
		return { cacheReadSaved: 0, cacheWriteCost: 0, netSaved: 0 };
	}
	const cacheReadSaved = totalCacheRead * inputRate * CACHE_READ_MULTIPLIER;
	const cacheWriteCost = totalCacheWrite * inputRate * CACHE_WRITE_MULTIPLIER;
	return {
		cacheReadSaved,
		cacheWriteCost,
		netSaved: cacheReadSaved - cacheWriteCost,
	};
}
