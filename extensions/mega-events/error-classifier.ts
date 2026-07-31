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

/** S38.2: classify a turn-end error/stop signal into a retry category.
 *
 * `length` is returned as null — S28 owns the max-output-token length stopReason
 * exclusively (its agent_end nudge path is separate and must not be doubled).
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
	// Resolve a searchable text blob from a pi AgentMessage or raw string.
	let text = '';
	// R3: usage-token signal. Only when `usage` is explicitly present with
	// inputTokens=0 AND outputTokens=0 do we know the turn never reached the
	// model. An ABSENT usage field means "unknown" (the event didn't carry
	// token counts) — we do NOT treat that as the 0-token poisoned signal,
	// because mid-response stream deaths and partial-content turns routinely
	// omit usage while still being transient (preserves all pre-R3 tests).
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
		// S28 guard: length stopReason is handled exclusively by the S28 path.
		if (sr === 'length') return null;
		// User ESC / Ctrl-C abort — stopReason === 'aborted'. Not retryable:
		// nudging would restart a task the user explicitly stopped.
		if (sr === 'aborted') return 'cancelled';
		// Success / normal tool flow — not an error, nothing to retry.
		if (sr === 'stop' || sr === 'toolUse' || sr === 'tool_use') return null;
		// R3: extract usage tokens for the 0-token poisoned-context signal.
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
	// --- context-overflow (ORDER BEFORE generic transient!) ---
	// A 400 from the model meaning "the prompt is bigger than the context window."
	// Catches BOTH provider phrasings so the classification does not depend on
	// which backend the router landed on:
	//   - pi/Anthropic wrapper: "too long for this model's context window even
	//     after compaction. Reduce the conversation length..." ->
	//     too long | context window | even after compaction | reduce the conversation
	//   - OpenAI/OpenRouter provider-side (often wrapped in "All targets failed:
	//     <model>. Last error: ..."): "This model's maximum context length is N
	//     tokens. Your request requires at least M tokens. Please reduce your
	//     input or max_tokens." -> maximum context length | context length
	//     exceeded | requires at least N tokens | reduce your input
	// All of these carry `invalid_request_error` (UNDERSCORE, not 'invalid
	// request' space) and would otherwise fall through to the generic
	// `s.includes('error')` transient branch below, misclassifying as
	// 'transient' and firing up to 5 blind retry nudges that re-submit the same
	// oversized prompt -> re-400 -> busy-loop. 'context-overflow' instead forces
	// ONE deferred re-compact (debounce-bypassed, race-guarded) and fires NO
	// blind retry nudge. The forced re-compact is shaped by the existing
	// session_before_compact durable trim (it cannot lower pi's firstKeptEntryId).
	if (/too long|context window|maximum context length|context length exceeded|requires at least \d+ tokens|even after compaction|reduce the conversation|reduce your input/.test(s)) {
		return 'context-overflow';
	}
	// --- transient (known-retryable markers FIRST — these override poisoned signals) ---
	// R3: network/throughput failures (timeout, ECONNRESET, 5xx, 429) MUST stay
	// transient even when usage is 0 tokens, because they are retryable and
	// /clear cannot fix them. 'connection aborted' is a network failure
	// (ECONNABORTED), NOT a user ESC (stopReason 'aborted', early-return above).
	// The marker set is shared with the agent-handlers R3 repeat-upgrade guard
	// (isKnownRetryableTransient) so the two never drift.
	if (isKnownRetryableTransient(s)) return 'transient';
	// R8: structured status wins over phrasing when present -- pi's console
	// "Error: 500:" prefix is not part of the delivered text (2026-07-30).
	if (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)) return 'transient';
	if (httpStatus === 401 || httpStatus === 403) return 'permanent';
	// --- poisoned-context (R3: ORDER AFTER specific transient markers, BEFORE
	// the generic 'error' transient fallthrough) ---
	// A DETERMINISTIC request-rejection that retrying cannot fix. Re-submitting
	// the same prompt re-triggers the same rejection. The 2026-07-28 incident
	// was a provider returning 0-token "Request failed — please retry." turns
	// for every request; classifyError mapped stopReason 'error' → 'transient'
	// and the session emitted ~9 nudge bursts (~60 context-bloating messages)
	// before stopping.
	//
	// Signal 1: provider request-validation 400 that is NOT context-overflow
	// (context-overflow already returned above). Orphaned tool result / malformed
	// message structure / unexpected role ordering / empty content. These were
	// previously classified 'permanent' (max 1 retry) — but a single retry
	// re-submits the SAME malformed structure and re-400s, so they are poisoned,
	// not permanent. Auth/permission 400s stay permanent (separate check below).
	if (/invalid_request_error|invalid request|malformed|bad request|orphaned tool|tool (result )?(without|for )|unexpected role|role (ordering|sequence)|empty (content|message|request)/.test(s)) {
		return 'poisoned-context';
	}
	// Signal 2: generic catch-all "request failed" / "request error" with no
	// specific transient marker (transient markers already returned above).
	// This is the exact phrasing the 2026-07-28 incident used. Without a
	// specific retryable cause, treat the rejection as deterministic.
	if (/request failed|request error/.test(s)) {
		return 'poisoned-context';
	}
	// Signal 3: stopReason 'error' + usage explicitly 0 tokens (the turn never
	// reached the model). Conservative: only when `usage` is PRESENT and 0 — an
	// absent usage field means "unknown" and stays transient (mid-response
	// deaths / partial-content turns often omit usage). The transient markers
	// above already returned, so reaching here with 'error' text and 0 tokens
	// means the request was rejected before any model work.
	//
	// R9 (2026-07-30): returning 'transient' instead of 'poisoned-context'.
	// A router fronting the provider can return 0-token errors on the FIRST
	// turn even when the context is fine — the request never reached any model.
	// The repeat detector in agent-handlers.ts is the corroboration mechanism:
	// bare 0-token errors that repeat >= poisonedContextRepeatThreshold (default
	// 3) upgrade to poisoned via the existing guard (the fallback signature
	// "bare-0-token-error" has no retryable marker, so the upgrade fires).
	if (usagePresent && totalTokens === 0 && /error/.test(s)) {
		return 'transient';
	}
	// --- transient (generic 'error' stopReason fallthrough) ---
	// Reaches here for a generic stopReason 'error' with no specific marker and
	// no 0-token signal (usage absent or > 0). Stays transient — conservative.
	if (s.includes('error') && !/\b(auth|unauthorized|invalid (api )?key|permission)\b/.test(s)) {
		return 'transient'; // generic pi stopReason 'error'
	}
	// NOTE: 'aborted' stopReason is handled by the sr==='aborted' early-return above.
	// The text-based s.includes('aborted') was removed — it was the old path that
	// misclassified user ESC/Ctrl-C as 'transient' (5 retry nudges after cancel).
	// --- permanent (NOT retryable beyond 1) ---
	if (/auth|unauthorized|invalid (api )?key|permission/.test(s)) return 'permanent';
	// Unknown — do not retry (avoid busy-looping on an unclassified signal).
	return null;
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
