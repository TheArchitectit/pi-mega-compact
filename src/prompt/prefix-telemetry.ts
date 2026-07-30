/**
 * prompt/prefix-telemetry.ts — S54 cache prefix-break detection (pure).
 *
 * Provider prompt caching pays only when each request shares a long identical
 * PREFIX with the previous one (Anthropic matches from the start of the
 * prompt). This module decides, per LLM call, whether the outgoing message
 * array's prefix survived the previous call, and when it did not, WHY — so
 * the dashboard can attribute cache misses to their real causes
 * (epoch re-compaction vs tool-result insertion vs recall injection)
 * instead of the single unexplained provider number.
 *
 * The extension hashes each outgoing message (computeContentDigest — the same
 * digest the DB mirror uses, so telemetry linkage keys match downstream) and
 * hands this module the two chains. All math here is pure + pi-agnostic.
 *
 * Persistence: one `cache_prefix_break` perf_samples row per detected break
 * (written by the caller — this module performs no I/O). Flag:
 * MEGACOMPACT_PREFIX_TELEMETRY=0/false disables (byte-identical OFF path in
 * the caller); default ON.
 */

export type PrefixBreakCause =
	| "epoch-change"
	| "recall-injection"
	| "tool-insertion"
	| "other";

export interface PrefixBreakResult {
	/** True when the current array's head diverges from the previous chain. */
	readonly broke: boolean;
	/** First diverging message index (valid only when broke). */
	readonly breakIndex: number;
	readonly cause: PrefixBreakCause | null;
	readonly prevLen: number;
	readonly currLen: number;
}

/** Flag gate (engineering practices: default ON, env OFF). */
export function isPrefixTelemetryEnabled(): boolean {
	const v = process.env.MEGACOMPACT_PREFIX_TELEMETRY;
	return v !== "0" && v !== "false";
}

/**
 * Cheap per-message digest for chain comparison (FNV-1a, 8 hex chars).
 * Telemetry only ever compares consecutive in-process states, so a fast
 * non-crypto hash is sufficient — and much cheaper per LLM call than the
 * dual-SHA-256 content digest the DB mirror computes (S27's `Future Work:
 * O(n²) hot path` note covers that heavier path).
 */
export function hashPrefixMessage(role: string, contentBytes: string): string {
	let h = 0x811c9dc5;
	const s = `${role}\n${contentBytes}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compare the previous per-message digest chain against the current one.
 *
 * Rules:
 * - No previous chain → first sample is the baseline, never a break.
 * - append-only growth (or pure truncation of the tail — rewind still leaves
 *   the shared head intact) is NOT a break: the provider only needs the
 *   current array's head to match a cached prefix, and it does.
 * - A break is the first index i < min(len) with prev[i] !== curr[i].
 *
 * Cause precedence: epoch-change > recall-injection > tool-insertion > other.
 * An epoch roll rewrites the summary that heads the trimmed view, which is the
 * strongest known breaker; a recall prepend mutates the system prompt (visible
 * to the provider but outside this chain), so the marker wins over message
 * position when both coincide; otherwise a tool-ish message at the break point
 * (tool result / tool call) indicates insertion-style churn.
 */
export function diffPrefixChain(
	prev: readonly string[] | null,
	curr: readonly string[],
	signals: {
		readonly epochChanged: boolean;
		readonly recallInjected: boolean;
		readonly isToolMessage: (index: number) => boolean;
	},
): PrefixBreakResult {
	const currLen = curr.length;
	if (prev == null) {
		return {
			broke: false,
			breakIndex: 0,
			cause: null,
			prevLen: 0,
			currLen,
		};
	}
	const prevLen = prev.length;
	const bound = Math.min(prevLen, currLen);
	let breakIndex = -1;
	for (let i = 0; i < bound; i++) {
		if (prev[i] !== curr[i]) {
			breakIndex = i;
			break;
		}
	}
	if (breakIndex < 0) {
		return { broke: false, breakIndex: 0, cause: null, prevLen, currLen };
	}
	const cause: PrefixBreakCause = signals.epochChanged
		? "epoch-change"
		: signals.recallInjected
			? "recall-injection"
			: signals.isToolMessage(breakIndex)
				? "tool-insertion"
				: "other";
	return { broke: true, breakIndex, cause, prevLen, currLen };
}
