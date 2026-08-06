/**
 * dashboard-server/routes-setup-detect-cache.ts — memoized embedder-barrier
 * detection (VC9D).
 *
 * The three raw fresh detectors (`detectOllama` / `detectLlamaCpp` /
 * `detectOnnx`) moved verbatim out of routes-setup.ts — they are the source of
 * truth for "is this embedder backend present". Each also has a memoized
 * sibling (`memoizedDetectOllama` / `memoizedDetectLlamaCpp` /
 * `memoizedDetectOnnx`) that runs the expensive spawn ONLY when its mutable
 * input changes, matching the `healthFactCacheKey` invalidation semantics from
 * routes-vector-cortex-health.ts:71-122: the cache key is the resolved binary
 * path + its size/mtime (onnx: resolved module path + package mtime), so an
 * install/upgrade on PATH or in node_modules naturally invalidates the entry,
 * while a steady environment reuses the result instead of re-spawning.
 *
 * A single module-level slot per target is shared across every
 * /api/setup-detect request, so consecutive polls reuse the result.
 *
 * Guardrails: PREVENT-PI-004 (local subprocess + filesystem reads only, no
 * network), PREVENT-011 (no `any`). Each decoration line carries a
 * guardrails-allow annotation.
 */

import { spawnSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: local subprocess detection only
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import type { DetectResult, OllamaDetectResult } from "./api-contracts/setup.js";

// ---------------------------------------------------------------------------
// Raw fresh detectors (moved verbatim from routes-setup.ts — single source).
// ---------------------------------------------------------------------------

export function detectOllama(): OllamaDetectResult | null {
	try {
		const version = spawnSync("ollama", ["--version"], {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (version.status !== 0) {
			return { installed: false, models: [], running: false, detail: version.stderr?.trim() || "not found" };
		}
		// Check for running server
		let running = false;
		let models: string[] = [];
		try {
			const listResult = spawnSync("ollama", ["list"], {
				timeout: 5000,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (listResult.status === 0) {
				running = true;
				// Parse lines: NAME  ID  SIZE  MODIFIED
				const lines = listResult.stdout?.split("\n") ?? [];
				for (const line of lines) {
					const name = line.split(/\s+/)[0];
					if (name && name !== "NAME") models.push(name);
				}
			}
		} catch {
			// ollama list failed — server may not be running
			running = false;
		}
		return {
			installed: true,
			models,
			running,
			detail: version.stdout?.trim() || null,
		};
	} catch {
		return { installed: false, models: [], running: false, detail: "detection error" };
	}
}

export function detectLlamaCpp(): DetectResult | null {
	try {
		const which = spawnSync("which", ["llama-server", "llama.cpp"], {
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const installed = which.status === 0 && which.stdout.trim().length > 0;
		return {
			installed,
			detail: installed ? which.stdout.trim() : null,
		};
	} catch {
		return { installed: false, detail: "detection error" };
	}
}

export function detectOnnx(): DetectResult | null {
	try {
		// Check for onnxruntime-node in a parent node_modules
		const req = createRequire(import.meta.url);
		try {
			req.resolve("onnxruntime-node");
			return { installed: true, detail: "onnxruntime-node found in node_modules" };
		} catch {
			return { installed: false, detail: "onnxruntime-node not found in node_modules" };
		}
	} catch {
		return { installed: false, detail: "detection error" };
	}
}

// ---------------------------------------------------------------------------
// Detect memo slot — generic, deterministic, unit-testable.
// ---------------------------------------------------------------------------

export interface DetectMemoSlot<V> {
	/** Return the stored value when `key` matches the cached key, else null. */
	get(key: string): V | null;
	/** Store a value under a key. */
	set(key: string, value: V): void;
	/** Drop the cached entry. */
	clear(): void;
}

/** A single memo slot. `value` is never null for a detect result (objects only). */
export function createDetectMemo<V>(): DetectMemoSlot<V> {
	let key: string | null = null;
	let value: V | null = null;
	return {
		get(k: string): V | null {
			return key !== null && key === k ? value : null;
		},
		set(k: string, v: V): void {
			key = k;
			value = v;
		},
		clear(): void {
			key = null;
			value = null;
		},
	};
}

/**
 * Run `compute` only when the derived key changes; a null key (inputs not
 * resolvable — e.g. the binary is absent) is never cached, so every call runs
 * the (cheap, fast-failing) detect fresh. This ordering is what the
 * SETUP-CORTEX-030/031 fixtures pin: an unchanged key returns the stored value
 * without re-running compute; a key mutation forces a recompute.
 */
export function withDetectMemo<V>(
	slot: DetectMemoSlot<V>,
	deriveKey: () => string | null,
	compute: () => V,
): V {
	const key = deriveKey();
	const cached = key !== null ? slot.get(key) : null;
	if (cached !== null) return cached;
	const value = compute();
	if (key !== null) slot.set(key, value);
	return value;
}

// ---------------------------------------------------------------------------
// Mutable-input cache-key derivations.
// ---------------------------------------------------------------------------

/** Resolve the first PATH entry for a binary, or null when absent. */
function whichBin(bin: string): string | null {
	const r = spawnSync("which", [bin], {
		timeout: 3000,
		encoding: "utf-8",
		// guardrails-allow PREVENT-PI-004: local which lookup only
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.status !== 0 || !r.stdout) return null;
	const first = r.stdout.trim().split("\n")[0]?.trim();
	return first && first.length > 0 ? first : null;
}

/** Key = resolved path + size + mtimeMs, so an install/upgrade invalidates. */
function fileKey(p: string | null): string | null {
	if (p === null || p.length === 0) return null;
	try {
		const s = statSync(p);
		return `${p}:${s.size}:${s.mtimeMs}`;
	} catch {
		return null;
	}
}

/** Key = resolved module path + its package.json mtime (node_modules rebuild). */
function moduleKey(packageName: string): string | null {
	try {
		const req = createRequire(import.meta.url);
		const resolved = req.resolve(packageName + "/package.json");
		return fileKey(resolved);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Memoized wrappers (shared module-level slots across requests).
// ---------------------------------------------------------------------------

const ollamaSlot = createDetectMemo<OllamaDetectResult | null>();
const llamaSlot = createDetectMemo<DetectResult | null>();
const onnxSlot = createDetectMemo<DetectResult | null>();

const ollamaKey = (): string | null => fileKey(whichBin("ollama"));
const llamaKey = (): string | null => fileKey(whichBin("llama-server") ?? whichBin("llama.cpp"));
const onnxKey = (): string | null => moduleKey("onnxruntime-node");

export function memoizedDetectOllama(): OllamaDetectResult | null {
	// guardrails-allow PREVENT-PI-004: local subprocess detection only
	return withDetectMemo(ollamaSlot, ollamaKey, detectOllama);
}

export function memoizedDetectLlamaCpp(): DetectResult | null {
	// guardrails-allow PREVENT-PI-004: local subprocess detection only
	return withDetectMemo(llamaSlot, llamaKey, detectLlamaCpp);
}

export function memoizedDetectOnnx(): DetectResult | null {
	// guardrails-allow PREVENT-PI-004: local module resolution only
	return withDetectMemo(onnxSlot, onnxKey, detectOnnx);
}
