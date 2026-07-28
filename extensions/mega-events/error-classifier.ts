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
	// --- transient (specific markers FIRST — these override poisoned signals) ---
	// R3: network failures (timeout, ECONNRESET, 5xx, 429) MUST stay transient
	// even when usage is 0 tokens, because they are retryable. The specific
	// markers below return before any poisoned signal is evaluated.
	if (/max(imum)? output token/.test(s)) return 'transient';
	if (/rate[\s.-]?limit|429|too many requests/.test(s)) return 'transient';
	if (/5\d\d|internal server|bad gateway|service unavailable/.test(s)) return 'transient';
	// 'connection aborted' is a network failure (ECONNABORTED), NOT a user ESC
	// (which is stopReason 'aborted', handled by the early-return above). Added
	// so "Connection aborted by peer" stays transient under R3. ECONNRESET and
	// common errno names are included so a bare 0-token 'ECONNRESET' turn is not
	// misclassified as poisoned (R6: ECONNRESET → transient).
	if (/network|timeout|econnreset|econnrefused|epipe|connection (lost|refused|reset|aborted)|stream (interrupted|closed|ended|failed)|disconnected/.test(s)) return 'transient';
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
	if (usagePresent && totalTokens === 0 && /error/.test(s)) {
		return 'poisoned-context';
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
 *  that case (the stateless 0-token signal handles bare errors). */
export function extractErrorSignature(message: unknown): string {
	if (typeof message === 'string') return message.toLowerCase().trim();
	if (!message || typeof message !== 'object') return '';
	const m = message as {
		content?: unknown;
		error?: unknown;
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
	return parts.join(' ').toLowerCase().trim();
}
