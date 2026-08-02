/**
 * classifier.test.ts — classifyError / classifyErrorDetailed / extractErrorSignature classification.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyError: classifyErrorFn, classifyErrorDetailed: classifyErrorDetailedFn, extractErrorSignature: extractErrorSignatureFn } =
	require("../mega-events.js") as { classifyError: typeof import("../mega-events.js").classifyError; classifyErrorDetailed: typeof import("../mega-events.js").classifyErrorDetailed; extractErrorSignature: typeof import("../mega-events.js").extractErrorSignature };

/** The exact error bodies from the 2026-07-30 incident (GLM router flapping). */
const R8_NO_HEALTHY_TARGET =
	'{"message":"No healthy target selected for alias \'hf:zai-org/GLM-4.7\'","type":"api_error"}';
const R8_SOCKET_CLOSED =
	"All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"; // guardrails-allow PREVENT-PI-004: verbatim 2026-07-30 incident error text (string fixture, not a network call)
const R8_TOO_MANY_CONCURRENT =
	'All targets failed: modal/zai-org/GLM-5.1-FP8. Last error: {"error": "Too many concurrent requests for this model"}';

test("S38: classifyError returns 'transient' for error stopReason", () => {
	assert.equal(classifyErrorFn({ stopReason: "error" }), "transient");
});

test("S38: classifyError returns 'cancelled' for aborted stopReason (ESC/Ctrl-C)", () => {
	assert.equal(classifyErrorFn({ stopReason: "aborted" }), "cancelled");
	assert.equal(classifyErrorFn({ stopReason: "aborted", errorMessage: "Operation aborted" }), "cancelled");
	assert.equal(classifyErrorFn({ stopReason: "aborted", errorMessage: "Aborted after 3 retry attempts" }), "cancelled");
});

test("S38: classifyError does NOT return 'cancelled' for error message containing 'aborted' with non-aborted stopReason", () => {
	// Defense: the old text-based s.includes('aborted') path is gone,
	// but verify that an error message mentioning 'aborted' with stopReason
	// 'error' (not 'aborted') still classifies as transient, not cancelled.
	assert.equal(classifyErrorFn({ stopReason: "error", errorMessage: "Connection aborted" }), "transient");
});

test("S38: classifyError returns 'transient' for max-output-token text", () => {
	assert.equal(classifyErrorFn({ stopReason: "error", content: "reached the maximum output token limit" }), "transient");
	assert.equal(classifyErrorFn("max output token exceeded"), "transient");
});

test("S38: classifyError returns 'permanent' for auth/unauthorized text", () => {
	assert.equal(classifyErrorFn("unauthorized: invalid api key"), "permanent");
	assert.equal(classifyErrorFn("permission denied"), "permanent");
});

test("S38: classifyError returns null for stop/toolUse stopReasons (success)", () => {
	assert.equal(classifyErrorFn({ stopReason: "stop" }), null);
	assert.equal(classifyErrorFn({ stopReason: "toolUse" }), null);
	assert.equal(classifyErrorFn({ stopReason: "tool_use" }), null);
});

test("S38: classifyError returns null for 'length' stopReason (S28 guard)", () => {
	assert.equal(classifyErrorFn({ stopReason: "length" }), null);
});

test("S38: classifyError returns null for missing stopReason without corroborating error/0-tokens", () => {
	assert.equal(classifyErrorFn({}), null);
	assert.equal(classifyErrorFn({ content: [] }), null);
	assert.equal(classifyErrorFn({ stopReason: undefined }), null);
	assert.equal(classifyErrorFn({ stopReason: "" }), null);
});

test("S38: classifyError returns 'transient' for error objects with message field", () => {
	assert.equal(classifyErrorFn({ error: { message: "Stream interrupted" } }), "transient");
	assert.equal(classifyErrorFn({ error: { message: "Connection lost" } }), "transient");
	assert.equal(classifyErrorFn({ error: { message: "500 Internal Server Error" } }), "transient");
	assert.equal(classifyErrorFn({ error: "Connection lost" }), "transient");
});

test("S38: classifyError returns null for content with error text but no error field (not corroborated)", () => {
	// "Error: connection reset" is in the content text, not in a message.error field.
	// Without an error field or 0-token usage, missing stopReason is not stream death.
	assert.equal(classifyErrorFn({ content: [{ type: "text", text: "Processing... Error: connection reset" }] }), null);
	assert.equal(classifyErrorFn({ content: [{ type: "text", text: "Here is the answer..." }], stopReason: "error" }), "transient");
});

test("S38: classifyError returns null for partial content with NO stopReason and no error", () => {
	// Without an error field or 0-token usage, partial content without stopReason
	// is not classified as stream death — it may be a normal completion from a
	// runtime that omits stopReason.
	assert.equal(classifyErrorFn({ role: "assistant", content: [{ type: "text", text: "partial response..." }], stopReason: undefined }), null);
	assert.equal(classifyErrorFn({ role: "assistant", content: [{ type: "text", text: "Here is the start of the answer" }] }), null);
	assert.equal(classifyErrorFn({ role: "assistant", content: "partial response..." }), null);
});

test("S38: classifyError returns 'transient' for missing stopReason + error field (corroborated)", () => {
	assert.equal(classifyErrorFn({ stopReason: undefined, error: { message: "stream crashed" } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "", error: "stream error" }), "transient");
});

test("S38: classifyError returns 'transient' for missing stopReason + 0-token usage (corroborated)", () => {
	assert.equal(classifyErrorFn({ stopReason: undefined, usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
});

test("S38: classifyError returns null for normal completion stopReasons from multi-agent runtimes", () => {
	assert.equal(classifyErrorFn({ stopReason: "endTurn" }), null);
	assert.equal(classifyErrorFn({ stopReason: "end_turn" }), null);
	assert.equal(classifyErrorFn({ stopReason: "maxTokens" }), null);
	assert.equal(classifyErrorFn({ stopReason: "max_tokens" }), null);
	assert.equal(classifyErrorFn({ stopReason: "complete" }), null);
	assert.equal(classifyErrorFn({ stopReason: "finished" }), null);
	assert.equal(classifyErrorFn({ stopReason: "done" }), null);
});

test("S38: classifyError returns 'compaction-noop' for 'Already compacted' text", () => {
	assert.equal(classifyErrorFn("Error: Already compacted"), "compaction-noop");
});

test("S38: classifyError returns 'compaction-noop' for 'Nothing to compact' text", () => {
	assert.equal(classifyErrorFn("Nothing to compact (session too small)"), "compaction-noop");
});

test("S38: classifyError returns 'compaction-noop' for 'Auto compaction failed' text", () => {
	assert.equal(classifyErrorFn("Auto compaction failed"), "compaction-noop");
	assert.equal(classifyErrorFn("Auto-compaction failed"), "compaction-noop");
});

test("S38: classifyError returns 'context-overflow' for the literal user 400 string", () => {
	assert.equal(
		classifyErrorFn("Your conversation is too long for this model's context window even after compaction. Reduce the conversation length or enable/allow compaction."),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for 'All targets failed' wrapper", () => {
	assert.equal(
		classifyErrorFn("All targets failed: ... Last error: ... too long ... context window even after compaction"),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for invalid_request_error JSON shape", () => {
	assert.equal(
		classifyErrorFn('{"type":"invalid_request_error","message":"... too long for context window ..."}'),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for OpenRouter 'All targets failed' max-context 400 (FAIL-20260725)", () => {
	// Regression: the OpenAI/OpenRouter provider-side phrasing
	// "maximum context length is N tokens ... requires at least M tokens ...
	// reduce your input or max_tokens" does NOT contain "too long" / "context
	// window" / "reduce the conversation", so it slipped past the original S38.8
	// regex and fell through to the generic transient branch, firing 5 blind
	// retry nudges that re-submitted the same oversized prompt -> re-400 ->
	// busy-loop. The exact user-facing wrapper string from the router:
	assert.equal(
		classifyErrorFn('Error: 400: {"message":"All targets failed: neuralwatt/glm-5.2-short. Last error: This model\'s maximum context length is 200000 tokens. Your request requires at least 201070 tokens (201070 prompt + 0 max_tokens). Please reduce your input or max_tokens.","type":"invalid_request_error"}'),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for bare 'maximum context length' phrasing", () => {
	assert.equal(
		classifyErrorFn("This model's maximum context length is 128000 tokens. Your request requires at least 130000 tokens. Please reduce your input or max_tokens."),
		"context-overflow",
	);
});

test("S38: classifyError returns 'context-overflow' for 'context length exceeded' phrasing", () => {
	assert.equal(
		classifyErrorFn("This model's context length exceeded: 200000 tokens"),
		"context-overflow",
	);
});

test("R9 classifier: bare 0-token generic error (usage present, 0 tokens) → transient (corroboration required)", () => {
	// R9: The 2026-07-30 incidents proved that 0-token ≠ deterministic rejection
	// when a router fronts the provider (the request never reached any model).
	// Signal 3 now returns 'transient'; the repeat detector in agent-handlers.ts
	// becomes the corroboration mechanism. A bare 0-token error that repeats
	// ≥ poisonedContextRepeatThreshold (default 3) upgrades to poisoned.
	assert.equal(classifyErrorFn({ stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	// Bare stopReason 'error' with NO usage field stays transient (unknown tokens
	// — conservative; preserves the pre-R3 mid-response/partial-content behavior).
	assert.equal(classifyErrorFn({ stopReason: "error" }), "transient");
});

test("R3 classifier: ECONNRESET (0-token) → transient (network failures stay transient)", () => {
	// R3: network failures must stay transient even with 0 tokens.
	assert.equal(classifyErrorFn({ stopReason: "error", content: "ECONNRESET", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "connection reset by peer", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "timeout", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
	assert.equal(classifyErrorFn({ stopReason: "error", content: "503 service unavailable", usage: { inputTokens: 0, outputTokens: 0 } }), "transient");
});

test("R3 classifier: 'request failed' generic (no transient marker) → poisoned-context", () => {
	// The exact incident phrasing: "Request failed — please retry." with no
	// specific transient cause → deterministic rejection.
	assert.equal(classifyErrorFn({ stopReason: "error", content: "Request failed — please retry.", usage: { inputTokens: 0, outputTokens: 0 } }), "poisoned-context");
	assert.equal(classifyErrorFn("request failed"), "poisoned-context");
});

test("R3 classifier: orphaned-tool-result 400 (non-overflow) → poisoned-context", () => {
	// Provider request-validation 400 that is NOT context-overflow: orphaned
	// tool result / malformed message structure. Previously 'permanent' (1
	// retry), now 'poisoned-context' (retry re-submits the same malformed shape).
	assert.equal(classifyErrorFn('{"type":"invalid_request_error","message":"orphaned tool result: tooluse ids mismatch"}'), "poisoned-context");
	assert.equal(classifyErrorFn("invalid request: unexpected role ordering"), "poisoned-context");
	assert.equal(classifyErrorFn("malformed message structure"), "poisoned-context");
});

test("R3 classifier: context-overflow phrasing still context-overflow (not poisoned)", () => {
	// Regression guard: the context-overflow check runs BEFORE the poisoned
	// signals, so a 400 "too long" stays context-overflow (forced re-compact),
	// not poisoned (advise + compact).
	assert.equal(
		classifyErrorFn({ stopReason: "error", content: "Your conversation is too long for this model's context window even after compaction.", usage: { inputTokens: 0, outputTokens: 0 } }),
		"context-overflow",
	);
	assert.equal(
		classifyErrorFn('{"type":"invalid_request_error","message":"maximum context length is 200000 tokens. requires at least 201070 tokens."}'),
		"context-overflow",
	);
});

test("R3 classifier: auth/permission stays permanent (not poisoned)", () => {
	// Auth errors are retryable-once (permanent), not poisoned — the user can
	// fix the key and retry.
	assert.equal(classifyErrorFn("unauthorized: invalid api key"), "permanent");
	assert.equal(classifyErrorFn("permission denied"), "permanent");
});

test("R9: extractErrorSignature fallback — bare 0-token error -> 'bare-0-token-error'", () => {
	// The repeat detector needs a non-empty signature to track bare 0-token errors.
	assert.equal(extractErrorSignatureFn({ stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }), "bare-0-token-error");
	// Without usage, stopReason alone does NOT get the fallback (mid-response deaths stay out of repeat tracking).
	assert.equal(extractErrorSignatureFn({ stopReason: "error" }), "");
	// Normal text content is returned as-is.
	assert.equal(extractErrorSignatureFn({ stopReason: "error", content: "x" }), "x");
});

test("R7 classifier: 0-token 'timed out' error → transient (not poisoned)", () => {
	// Unit-level pin of the R7(e) gap.
	assert.equal(
		classifyErrorFn({
			stopReason: "error",
			content: "Request timed out or failed. Try again",
			usage: { inputTokens: 0, outputTokens: 0 },
		}),
		"transient",
	);
});

test("R7 classifier: bare network phrasings → transient", () => {
	assert.equal(classifyErrorFn("socket hang up"), "transient");
	assert.equal(classifyErrorFn("the operation timed out"), "transient");
	assert.equal(classifyErrorFn("connect ETIMEDOUT 10.0.0.1:443"), "transient");
});

test("R7 classifier: 429/rate-limit → transient (control)", () => {
	assert.equal(classifyErrorFn("429 Too Many Requests: rate limit exceeded"), "transient");
});

test("R8 classifier: router phrasings → transient, even at 0 tokens", () => {
	for (const text of [R8_NO_HEALTHY_TARGET, R8_SOCKET_CLOSED, R8_TOO_MANY_CONCURRENT]) {
		assert.equal(
			classifyErrorFn({ stopReason: "error", content: text, usage: { inputTokens: 0, outputTokens: 0 } }),
			"transient",
			`0-token router error must be transient: ${text.slice(0, 60)}`,
		);
	}
});

test("R8 classifier: structured status field wins over phrasing", () => {
	// 5xx → transient even with zero recognizable text.
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 502, message: "???" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"transient",
	);
	// 429 structured → transient.
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { statusCode: 429, message: "???" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"transient",
	);
	// 401 → permanent (not transient, not poisoned).
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 401, message: "???" } }),
		"permanent",
	);
	// 400 with deterministic-rejection text → still poisoned (text rules 4xx).
	assert.equal(
		classifyErrorFn({ stopReason: "error", error: { status: 400, message: "orphaned tool result: tooluse ids mismatch" }, usage: { inputTokens: 0, outputTokens: 0 } }),
		"poisoned-context",
	);
});

test("R11 classifier: classifyErrorDetailed signal tags", () => {
	// length → signal 'length-guard', category null
	const len = classifyErrorDetailedFn({ stopReason: "length" });
	assert.equal(len.signal, "length-guard");
	assert.equal(len.category, null);

	// aborted → 'cancelled'
	const abort = classifyErrorDetailedFn({ stopReason: "aborted" });
	assert.equal(abort.signal, "cancelled");
	assert.equal(abort.category, "cancelled");

	// stop → 'success'
	assert.equal(classifyErrorDetailedFn({ stopReason: "stop" }).signal, "success");

	// compaction-noop
	const compact = classifyErrorDetailedFn("Error: Already compacted");
	assert.equal(compact.signal, "compaction-noop");
	assert.equal(compact.category, "compaction-noop");

	// context-overflow
	const overflow = classifyErrorDetailedFn("too long for this model");
	assert.equal(overflow.signal, "context-overflow");
	assert.equal(overflow.category, "context-overflow");

	// transient-marker (text-matched)
	const tm = classifyErrorDetailedFn("socket hang up");
	assert.equal(tm.signal, "transient-marker");
	assert.equal(tm.category, "transient");

	// transient-status (HTTP status-matched) — use outer-level status + non-5xx-matching error text
	// so extractHttpStatus finds it but the text doesn't contain "5xx" digits
	const ts = classifyErrorDetailedFn({ stopReason: "error", error: { type: "upstream_error", message: "request aborted" }, status: 502 });
	assert.equal(ts.signal, "transient-status");
	assert.equal(ts.category, "transient");
	assert.equal(ts.httpStatus, 502);

	// permanent-status
	const ps = classifyErrorDetailedFn({ stopReason: "error", error: { type: "auth_error", message: "session expired" }, status: 401 });
	assert.equal(ps.signal, "permanent-status");
	assert.equal(ps.category, "permanent");
	assert.equal(ps.httpStatus, 401);

	// poisoned-invalid-request (needs stopReason so sr is non-empty)
	const pir = classifyErrorDetailedFn({ stopReason: "error", error: { type: "invalid_request_error", message: "bad request" } });
	assert.equal(pir.signal, "poisoned-invalid-request");
	assert.equal(pir.category, "poisoned-context");

	// poisoned-request-failed (from R9/R3)
	const prf = classifyErrorDetailedFn("Request failed — please retry.");
	assert.equal(prf.signal, "poisoned-request-failed");
	assert.equal(prf.category, "poisoned-context");

	// bare-0-token (R9) — usage present with 0 tokens, stopReason error
	const b0 = classifyErrorDetailedFn({ stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } });
	assert.equal(b0.signal, "bare-0-token");
	assert.equal(b0.category, "transient");

	// generic-error
	const ge = classifyErrorDetailedFn({ stopReason: "error", content: "something odd" });
	assert.equal(ge.signal, "generic-error");
	assert.equal(ge.category, "transient");

	// permanent-auth
	const pa = classifyErrorDetailedFn("unauthorized: invalid api key");
	assert.equal(pa.signal, "permanent-auth");
	assert.equal(pa.category, "permanent");

	// unknown (plain string, no markers)
	const unk = classifyErrorDetailedFn("some random text with no pattern");
	assert.equal(unk.signal, "unknown");
	assert.equal(unk.category, null);
});

