/**
 * helpers.ts — shared constants, the SessionRuntime interface, and the
 * ownVersion() package-version reader extracted from the original
 * mega-runtime.ts monolith.
 *
 * These are pure constants/helpers with no class-state dependencies.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// ── Public string constants ────────────────────────────────────────────────
// Exported via the barrel — consumers (mega-events.ts, mega-pipeline.ts) use
// these keys to register widgets/markers with pi.
export const STATUS_KEY = "mega-compact";
export const WIDGET_KEY = "mega-compact-stats";
export const MARKER_TYPE = "mega-compact-marker";

// ── Internal shared constants ──────────────────────────────────────────────

// Rough tokens-processed-per-second heuristic for the dashboard's "time saved"
// estimate. Throughput varies by model/hardware; this is order-of-magnitude so
// the dashboard can show a human-readable figure, not a precise measurement.
export const TOKENS_PER_SEC_ESTIMATE = 2000;

// ── SessionRuntime interface ───────────────────────────────────────────────

/** Per-session runtime state kept in the closure (mirrors neuralwatt-mcr). */
export interface SessionRuntime {
	sessionId: string;
	persistedThisSession: boolean;
	lastCheckpointId: string | undefined;
	lastCompactedFrom: number;
	lastCompactedTokens: number;
	dedupSkips: number; // compactions skipped because regionHash already stored
	dedupAttempts: number; // total compaction attempts (for hit-rate denominator)
	tokensSaved: number; // this session-instance only: reset on session_start
	lastCompactAt: number | null; // wall-clock ms of the last compaction this session
	lastNativeCompactAt: number | null; // COMPACT-DEDUP FIX: wall-clock ms of the last NATIVE pi compaction (session_compact event) — used by the agent_end/legacy race guard to skip a redundant ctx.compact() that would throw "Already compacted".
	// S25: live dashboard counters (reset on session_start, mirrored to SQLite).
	compactCount: number; // compactions performed this session-instance
	recallInjections: number; // recall blocks injected this session-instance
	cacheHitTokens: number; // tokens saved via cache hits (dedup + recall) this session
	lengthStopPending: boolean; // S28: set on turn_end when stopReason==='length'
	errorRetryCount: number; // S38: consecutive error turns, reset on success/turn_start
	errorRetryUntil: number; // S38: wall-clock ms before which the next nudge is suppressed (R1: now gating)
	// S38.6: circuit-breaker state — consecutive error turns across the session.
	// When this exceeds maxConsecutiveErrors, the extension stops retrying.
	consecutiveErrors: number; // reset to 0 on successful turn_end
	// R1 (retry redesign): in-flight nudge dedup. A nudge queued via
	// deliverAs:'followUp' must not be re-sent until it has been consumed by an
	// actual new agent turn (turn_start) or superseded by a successful turn.
	// Without this, a fast-erroring provider + a per-turn nudge → N nudges queue
	// up and pi dispatches N retry turns, each re-submitting the same failing
	// prompt (the 2026-07-28 incident: ~60-message spam storm).
	lastErrorRetryAt: number; // wall-clock ms of the last fired nudge (diagnostics)
	retryNudgePending: boolean; // true while a queued nudge awaits consumption
	// R2: session-global cap. Total S38 nudges per session across ALL bursts;
	// independent of the per-burst max and the circuit breaker. Hitting it is
	// terminal for the session — the extension stops nudging entirely.
	errorRetrySessionCount: number; // nudges fired this session (across all bursts)
	// R3: poisoned-context detection state. The classifier is stateless; the
	// stateful "repeated identical error text" signal is tracked here and upgrades
	// a 'transient' classification to 'poisoned-context' after the threshold.
	lastErrorText: string | undefined; // normalized error signature from the last error turn
	errorTextRepeatCount: number; // consecutive count of identical error signatures
	// R3b: one-per-session /clear advise message throttle.
	poisonedAdviseSent: boolean; // true after the advise message fires once
	// R10: provider-outage advisory throttle (one per flapping episode).
	providerOutageAdvised: boolean; // true after the outage advise message fires once
	// R3c: one guarded compact per error signature (avoids re-compacting the
	// same poisoned region repeatedly).
	poisonedCompactSignatures: Set<string>; // signatures already attempted a compact for
	// S53: recall tail injection state — tracks whether a tail was injected this turn.
	recallInjectedThisTurn: boolean;
	// R7: poisoned-context event counter for the dashboard.
	poisonedCount: number;
}

// ── ownVersion ─────────────────────────────────────────────────────────────

/** Cached npm version, read once from this extension's own package.json. */
let CACHED_VERSION: string | null = null;

/** Read this extension's own version from its package.json (cached). */
export function ownVersion(): string {
	if (CACHED_VERSION !== null) return CACHED_VERSION;
	let v = "?";
	try {
		const here = dirname(fileURLToPath(import.meta.url)); // .../extensions/mega-runtime
		const pkg = JSON.parse(
			readFileSync(join(here, "..", "..", "package.json"), "utf-8"),
		);
		v = pkg.version ?? "?";
	} catch {
		v = "?";
	}
	CACHED_VERSION = v;
	return v;
}
