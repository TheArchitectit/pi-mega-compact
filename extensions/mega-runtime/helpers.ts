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
