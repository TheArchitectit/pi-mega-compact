/**
 * error-classifier.ts — S38.2 error classification for retry logic.
 *
 * Classifies turn-end error/stop signals into retry categories.
 * Ordering matters: compaction-noop is matched BEFORE generic transient
 * so a pi race / manual compact catch is never misclassified.
 *
 * R3 (retry redesign): a new 'poisoned-context' category for DETERMINISTIC
 * request-rejection failures that retrying cannot fix. See agent-handlers.ts
 * for the poisoned handling (no blind retry; one /clear advise; one guarded
 * compact per signature). Conservative: when unsure between transient and
 * poisoned, choose transient (bounded by R1 dedup + R2 session cap).
 */

/** R7: known-retryable transient markers — network/throughput failures that
 *  retry can fix and /clear cannot. SINGLE SOURCE OF TRUTH: classifyError uses
 *  this for its transient-marker stage, and the agent-handlers R3 repeat
 *  upgrade guard uses it to keep these errors out of poisoned-context. Add new
 *  transient phrasings HERE only.
 *
 *  Non-obvious alternatives:
 *  - `time(?:d[\s-]?out|out)` covers "timeout", "timed out", "timed-out" —
 *    "timed out" does NOT match /timeout/ (the 2026-07-30 incident phrasing).
 *  - `etimedout` is Node's timeout errno lowercased — does NOT contain the
 *    substring "timeout".
 *  - `socket hang up` is Node's ECONNRESET *message*; the errno lives in
 *    error.code, which extractErrorSignature never sees.
 *  - router phrasings (all targets failed / no healthy target / too many
 *    concurrent) -- pi's status prefix is console-only (2026-07-30 incident). */
export const KNOWN_RETRYABLE_TRANSIENT_PATTERN =
	/max(imum)? output token|rate[\s.-]?limit|429|too many requests|too many concurrent|overloaded|5\d\d|internal server|bad gateway|service unavailable|all targets failed|no healthy target|fetch failed|network|time(?:d[\s-]?out|out)|etimedout|econnreset|econnrefused|epipe|eai_again|socket|closed unexpectedly|premature close|other side closed|connection (lost|refused|reset|aborted?|was closed)|stream (interrupted|closed|ended|failed)|disconnected/;

/** R7: true when the error text carries a known-retryable transient marker.
 *  Defensively lowercases so callers can pass raw or normalized text. */
export function isKnownRetryableTransient(text: string): boolean {
	return KNOWN_RETRYABLE_TRANSIENT_PATTERN.test(text.toLowerCase());
}

/** R8: best-effort extraction of HTTP status from pi AgentMessage shapes. */
function extractHttpStatus(m: Record<string, unknown>): number | undefined {
	for (const outer of [m.error, m] as Array<Record<string, unknown> | undefined>) {
		if (!outer || typeof outer !== 'object') continue;
		for (const key of ['status', 'statusCode', 'code']) {
			const v = (outer as Record<string, unknown>)[key];
			if (typeof v === 'number' && v >= 100 && v <= 599) return v;
		}
	}
	return undefined;
}

/** R11: signal tag identifying which classification rule fired. */
export type ErrorSignal =
	| 'length-guard'
	| 'cancelled'
	| 'success'
	| 'stream-death-no-stopreason'
	| 'compaction-noop'
	| 'context-overflow'
	| 'transient-marker'
	| 'transient-status'
	| 'permanent-status'
	| 'poisoned-invalid-request'
	| 'poisoned-request-failed'
	| 'bare-0-token'
	| 'generic-error'
	| 'permanent-auth'
	| 'unknown';

export type ErrorCategory =
	| 'transient'
	| 'permanent'
	| 'compaction-noop'
	| 'context-overflow'
	| 'cancelled'
	| 'poisoned-context'
	| null;

/** R11: detailed classification result with the signal tag and optional httpStatus. */
export interface ClassifyErrorDetail {
	category: ErrorCategory;
	signal: ErrorSignal;
	httpStatus?: number;
}

/** R11: classify a turn-end error/stop signal into a retry category with a
 *  diagnostic signal tag naming the rule that fired, plus the raw httpStatus
 *  when extractHttpStatus found one. */
export function classifyErrorDetailed(message: unknown): ClassifyErrorDetail {
	let text = '';
	let usagePresent = false;
	let totalTokens = 0;
	let httpStatus: number | undefined;
	if (typeof message === 'string') {
		text = message;
	} else if (message && typeof message === 'object') {
		const m = message as {
			stopReason?: string;
			content?: unknown;
			error?: unknown;
			usage?: { inputTokens?: number; outputTokens?: number } | undefined;
		};
		const sr = typeof m.stopReason === 'string' ? m.stopReason : '';
		if (sr === 'length') return { category: null, signal: 'length-guard' };
		if (sr === 'aborted') return { category: 'cancelled', signal: 'cancelled' };
		if (sr === 'stop' || sr === 'toolUse' || sr === 'tool_use') return { category: null, signal: 'success' };
		const usage = m.usage;
		usagePresent = usage != null && typeof usage === 'object';
		if (usagePresent) {
			const u = usage as { inputTokens?: number; outputTokens?: number };
			totalTokens =
				(typeof u.inputTokens === 'number' ? u.inputTokens : 0) +
				(typeof u.outputTokens === 'number' ? u.outputTokens : 0);
		}
		httpStatus = extractHttpStatus(m as Record<string, unknown>);
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
			const err = m.error;
			if (typeof err === 'string') parts.push(err);
			else if (err && typeof err === 'object') {
				const errObj = err as Record<string, unknown>;
				if (typeof errObj.message === 'string') parts.push(errObj.message);
				else parts.push(JSON.stringify(err));
			}
		}
		if (!sr) {
			const r: ClassifyErrorDetail = { category: 'transient', signal: 'stream-death-no-stopreason' };
			if (httpStatus !== undefined) r.httpStatus = httpStatus;
			return r;
		}
		text = parts.join(' ');
	}
	if (!text) return { category: null, signal: 'unknown' };
	const s = text.toLowerCase();
	if (/already compacted|compaction failed|nothing to compact|auto[\s-]?compaction failed/.test(s)) {
		return { category: 'compaction-noop', signal: 'compaction-noop' };
	}
	if (/too long|context window|maximum context length|context length exceeded|requires at least \d+ tokens|even after compaction|reduce the conversation|reduce your input/.test(s)) {
		return { category: 'context-overflow', signal: 'context-overflow' };
	}
	if (isKnownRetryableTransient(s)) {
		const r: ClassifyErrorDetail = { category: 'transient', signal: 'transient-marker' };
		if (httpStatus !== undefined) r.httpStatus = httpStatus;
		return r;
	}
	if (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)) {
		return { category: 'transient', signal: 'transient-status', httpStatus };
	}
	if (httpStatus === 401 || httpStatus === 403) {
		return { category: 'permanent', signal: 'permanent-status', httpStatus };
	}
	if (/invalid_request_error|invalid request|malformed|bad request|orphaned tool|tool (result )?(without|for )|unexpected role|role (ordering|sequence)|empty (content|message|request)/.test(s)) {
		return { category: 'poisoned-context', signal: 'poisoned-invalid-request' };
	}
	if (/request failed|request error/.test(s)) {
		return { category: 'poisoned-context', signal: 'poisoned-request-failed' };
	}
	if (usagePresent && totalTokens === 0 && /error/.test(s)) {
		return { category: 'transient', signal: 'bare-0-token' };
	}
	if (s.includes('error') && !/\b(auth|unauthorized|invalid (api )?key|permission)\b/.test(s)) {
		return { category: 'transient', signal: 'generic-error' };
	}
	if (/auth|unauthorized|invalid (api )?key|permission/.test(s)) {
		return { category: 'permanent', signal: 'permanent-auth' };
	}
	return { category: null, signal: 'unknown' };
}

/** S38.2: classify a turn-end error/stop signal into a retry category.
 *
 * `length` is returned as null — S28 owns the max-output-token length stopReason
 * exclusively (its agent_end nudge path is separate and must not be doubled).
 *
 * Thin wrapper around classifyErrorDetailed — returns only the category.
 *
 * @param message  the event.message (a pi AgentMessage) or an error string
 * @returns 'transient' | 'permanent' | 'compaction-noop' | 'context-overflow' | 'cancelled' | 'poisoned-context' | null (success/unknown)
 */
export function classifyError(message: unknown):
	| 'transient'
	| 'permanent'
	| 'compaction-noop'
	| 'context-overflow'
	| 'cancelled'
	| 'poisoned-context'
	| null {
	return classifyErrorDetailed(message).category;
}

/** S38.2: exponential backoff for error-retry nudges.
 *  count is 1-based (the retry about to fire). baseMs is the unit
 *  (config.errorRetryBackoffMs, default 5000 → 5s/10s/20s/30s cap).
 *  R1: errorRetryUntil is now GATING — a nudge cannot fire before the previous
 *  backoff elapses (previously documented as non-gating). */
export function errorRetryBackoffMs(count: number, baseMs = 5000): number {
	switch (count) {
		case 1: return baseMs;
		case 2: return baseMs * 2;
		case 3: return baseMs * 4;
		default: return baseMs * 6; // cap from the 4th retry onward
	}
}

/** R3: extract a normalized error-signature string from a turn_end message for
 *  the stateful "repeated identical error text" signal. Returns the lowercased
 *  content + error.message blob (WITHOUT the stopReason, which is constant
 *  'error' for retryable turns) so two turns with the same error content share
 *  a signature. Empty string when there is no error text (e.g. a bare
 *  stopReason 'error' with no content) — the caller skips repeat detection in
 *  that case (the stateless 0-token signal handles bare errors).
 *
 *  R9: when the joined text is empty AND stopReason is 'error' AND usage is
 *  present with 0 total tokens, returns the constant "bare-0-token-error" so
 *  the repeat detector can corroborate bare 0-token errors (first turn is
 *  transient; repeated occurrences upgrade to poisoned at threshold). Bare
 *  'error' WITHOUT usage keeps returning '' (absent usage = unknown; mid-
 *  response deaths stay out of repeat tracking). */
export function extractErrorSignature(message: unknown): string {
	if (typeof message === 'string') return message.toLowerCase().trim();
	if (!message || typeof message !== 'object') return '';
	const m = message as {
		content?: unknown;
		error?: unknown;
		stopReason?: string;
		usage?: { inputTokens?: number; outputTokens?: number };
	};
	const parts: string[] = [];
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
		const err = m.error;
		if (typeof err === 'string') parts.push(err);
		else if (err && typeof err === 'object') {
			const errObj = err as Record<string, unknown>;
			if (typeof errObj.message === 'string') parts.push(errObj.message);
			else parts.push(JSON.stringify(err));
		}
	}
	const joined = parts.join(' ').toLowerCase().trim();
	if (
		joined === '' &&
		m.stopReason === 'error' &&
		m.usage &&
		typeof m.usage === 'object' &&
		(m.usage.inputTokens ?? 0) + (m.usage.outputTokens ?? 0) === 0
	) {
		return 'bare-0-token-error';
	}
	return joined;
}
