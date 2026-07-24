/**
 * error-classifier.ts — S38.2 error classification for retry logic.
 *
 * Classifies turn-end error/stop signals into retry categories.
 * Ordering matters: compaction-noop is matched BEFORE generic transient
 * so a pi race / manual compact catch is never misclassified.
 */

/** S38.2: classify a turn-end error/stop signal into a retry category.
 *
 * `length` is returned as null — S28 owns the max-output-token length stopReason
 * exclusively (its agent_end nudge path is separate and must not be doubled).
 *
 * @param message  the event.message (a pi AgentMessage) or an error string
 * @returns 'transient' | 'permanent' | 'compaction-noop' | null (success/unknown)
 */
export function classifyError(message: unknown):
	| 'transient'
	| 'permanent'
	| 'compaction-noop'
	| null {
	// Resolve a searchable text blob from a pi AgentMessage or raw string.
	let text = '';
	if (typeof message === 'string') {
		text = message;
	} else if (message && typeof message === 'object') {
		const m = message as {
			stopReason?: string;
			content?: unknown;
			error?: unknown;
		};
		const sr = typeof m.stopReason === 'string' ? m.stopReason : '';
		// S28 guard: length stopReason is handled exclusively by the S28 path.
		if (sr === 'length') return null;
		// Success / normal tool flow — not an error, nothing to retry.
		if (sr === 'stop' || sr === 'toolUse' || sr === 'tool_use') return null;
		const parts: string[] = [];
		if (sr) parts.push(sr);
		const c = m.content;
		if (typeof c === 'string') parts.push(c);
		else if (Array.isArray(c)) {
			for (const b of c) {
				if (b && typeof b === 'object' && 'text' in b) {
					parts.push(String((b as { text?: string }).text ?? ''));
			}
			}
		}
		if (m.error) {
			// Extract message from error objects for pattern matching.
			const err = m.error;
			if (typeof err === 'string') {
				parts.push(err);
			} else if (err && typeof err === 'object') {
				const errObj = err as Record<string, unknown>;
				if (typeof errObj.message === 'string') {
					parts.push(errObj.message);
				} else {
					parts.push(JSON.stringify(err));
				}
			}
		}
		// S38: detect mid-response errors where the stream died without a
		// proper stopReason (empty/undefined) — this catches provider failures
		// that cut off the response mid-stream, INCLUDING the case where the
		// provider emitted partial content before dying (a truncated response
		// with no stop reason is a mid-stream death, not a success).
		// A genuine success ALWAYS carries stop/tool_use/toolUse (which
		// short-circuit to null at the top), so any message reaching here with a
		// falsy stopReason is a stream failure → retryable.
		if (!sr) {
			return 'transient';
		}
		text = parts.join(' ');
	}
	if (!text) return null;
	const s = text.toLowerCase();
	// --- compaction-noop (ORDER FIRST: pi race / manual compact catch) ---
	// FAIL-2026071701: these are NOT retryable — the compaction already
	// succeeded via pi's native path; retrying would race again.
	if (/already compacted/.test(s)) return 'compaction-noop';
	if (/compaction failed/.test(s)) return 'compaction-noop';
	if (/nothing to compact/.test(s)) return 'compaction-noop';
	if (/auto[\s-]?compaction failed/.test(s)) return 'compaction-noop';
	// --- transient (retryable) ---
	if (s.includes('error') && !/\b(permanent|invalid request|malformed|bad request|auth|unauthorized|invalid (api )?key|permission)\b/.test(s)) {
		return 'transient'; // generic pi stopReason 'error' / 'aborted'
	}
	if (s.includes('aborted')) return 'transient';
	if (/max(imum)? output token/.test(s)) return 'transient';
	if (/rate[\s.-]?limit|429|too many requests/.test(s)) return 'transient';
	if (/5\d\d|internal server|bad gateway|service unavailable/.test(s)) return 'transient';
	if (/network|timeout|connection (lost|refused|reset)|stream (interrupted|closed|ended|failed)|disconnected/.test(s)) return 'transient';
	// --- permanent (NOT retryable beyond 1) ---
	if (/auth|unauthorized|invalid (api )?key|permission/.test(s)) return 'permanent';
	if (/invalid request|malformed|bad request/.test(s)) return 'permanent';
	// Unknown — do not retry (avoid busy-looping on an unclassified signal).
	return null;
}

/** S38.2: exponential backoff for error-retry nudges (5s,10s,20s,30s,30s cap).
 *  count is 1-based (the retry about to fire). */
export function errorRetryBackoffMs(count: number): number {
	switch (count) {
		case 1: return 5_000;
		case 2: return 10_000;
		case 3: return 20_000;
		default: return 30_000; // cap from the 4th retry onward
	}
}
