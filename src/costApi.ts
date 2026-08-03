/**
 * costApi.ts — optional model pricing lookup from an external API.
 *
 * PREVENT-PI-004 EXEMPTION: This module makes network calls to fetch model
 * pricing data. It is disabled by default and must be explicitly opted in via
 * MEGACOMPACT_COST_API_ENABLED=true + MEGACOMPACT_COST_API_URL=<url>.
 *
 * The dashboard server uses this to enrich the inputRate/outputRate fields
 * when the local pricing table (pricing.ts) has no data for a model.
 *
 * Results are cached for 1 hour to minimize network calls.
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: user-opted-in cost API — fetches model pricing from a user-configured endpoint, never called unless MEGACOMPACT_COST_API_ENABLED=true

export interface ModelPricing {
	inputRate: number | null;
	outputRate: number | null;
}

export interface CostApiConfig {
	enabled: boolean;
	url: string;
}

let _cache: { timestamp: number; data: Map<string, ModelPricing> } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function costApiConfig(): CostApiConfig {
	const enabled =
		process.env.MEGACOMPACT_COST_API_ENABLED === "true" ||
		process.env.MEGACOMPACT_COST_API_ENABLED === "1";
	const url = process.env.MEGACOMPACT_COST_API_URL ?? "";
	return { enabled, url };
}

/**
 * Fetch model pricing from the configured API endpoint.
 *
 * Expects a JSON response of shape:
 *   { "data": [{ "id": "model-name", "pricing": { "prompt": "0.000003", "completion": "0.000015" } }] }
 * (OpenRouter-compatible format). Values are USD per token as strings.
 *
 * Returns a map keyed by lowercase model id → { inputRate, outputRate }.
 * Returns an empty map on any error. Never throws.
 */
export function fetchModelPricing(): Map<string, ModelPricing> {
	const cfg = costApiConfig();
	if (!cfg.enabled || !cfg.url) return new Map();

	// Return cached data if fresh.
	if (_cache && Date.now() - _cache.timestamp < CACHE_TTL_MS) {
		return _cache.data;
	}

	const result = _doFetch(cfg.url);
	_cache = { timestamp: Date.now(), data: result };
	return result;
}

function _doFetch(url: string): Map<string, ModelPricing> {
	// Synchronous bridge: spawnSync an inline worker so the call blocks without
	// deadlocking fetch (mirrors HttpEmbedder / RAPTOR summarizer pattern).
	const WORKER = String.raw`
		try {
			const r = await fetch(process.env.COST_API_URL, { // guardrails-allow PREVENT-PI-004: user-opted-in cost API — fetches model pricing from a user-configured endpoint
				method: "GET",
				headers: { "accept": "application/json" },
			});
			const j = await r.json();
			process.stdout.write(JSON.stringify({ ok: r.ok, data: j }));
		} catch (e) {
			process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
		}
	`;
	const res = spawnSync(process.execPath, ["-e", WORKER], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, COST_API_URL: url },
	});

	const out = new Map<string, ModelPricing>();

	let parsed: { ok: boolean; data?: unknown; error?: string };
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		return out;
	}

	if (!parsed.ok || !parsed.data) return out;

	// OpenRouter-compatible: { data: [{ id, pricing: { prompt, completion } }] }
	const models = (parsed.data as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> })?.data;
	if (!Array.isArray(models)) return out;

	for (const m of models) {
		if (!m.id) continue;
		const prompt = m.pricing?.prompt;
		const completion = m.pricing?.completion;
		const inputRate = prompt != null ? parseFloat(prompt) : null;
		const outputRate = completion != null ? parseFloat(completion) : null;
		if (inputRate != null || outputRate != null) {
			out.set(m.id.toLowerCase(), { inputRate, outputRate });
		}
	}

	return out;
}

/**
 * Look up pricing for a model name from the cost API cache.
 * Tries exact match, then prefix match (same pattern as lookupModelInputRate).
 */
export function lookupCostApiPricing(model: string): ModelPricing | null {
	const data = fetchModelPricing();
	if (data.size === 0) return null;
	const lower = model.toLowerCase();
	// Exact match.
	if (data.has(lower)) return data.get(lower) ?? null;
	// Prefix match.
	for (const [key, pricing] of data) {
		if (lower.startsWith(key)) return pricing;
	}
	return null;
}

/** Clear the pricing cache (useful for testing). */
export function clearCostApiCache(): void {
	_cache = null;
}
