/**
 * reset-runtime.ts — extracted `MegaRuntime.resetRuntime()`: the per-session
 * state reset used by the session_start / session_tree handlers. The class
 * keeps a thin `resetRuntimeImpl(this, sessionId)` delegate so every call
 * site is unchanged.
 *
 * Follows the same context-interface + free-function + thin-delegate pattern as
 * effects.ts / game-state.ts / capture-model.ts / bind-repo.ts / perf.ts /
 * runtime-helpers.ts.
 */

import { normalizeSessionId } from "../../src/store.js";
import type { TickerEntry } from "./widget.js";
import type { GameState } from "../../src/store/sqlite.js";
import type { SessionRuntime } from "./helpers.js";

// ---------------------------------------------------------------------- types

/**
 * The slice of `MegaRuntime` resetRuntime mutates. `trimCache` is typed
 * `unknown` — this function only ever *clears* it, so the precise
 * snapshot-cache shape does not need to be imported.
 */
export interface ResetRuntimeContext {
	rt: SessionRuntime;
	trimCache: unknown;
	ticker: TickerEntry[];
	cachedGameState: GameState | undefined;
	statusKey: string | undefined;
	activeAgents: number;
	currentTurn: number;
	lastActivityAt: number;
	tierTrace: string | undefined;
	pulsing: boolean;
	savedGoal: number;
	lastWhy: string | undefined;
}

// --------------------------------------------------------------- resetRuntime

export function resetRuntimeImpl(
	self: ResetRuntimeContext,
	sessionId: string | undefined,
): void {
	const sid = normalizeSessionId(sessionId);
	if (self.rt.sessionId === sid && self.rt.persistedThisSession) return; // same session, keep checkpoint memory
	self.rt = {
		sessionId: sid,
		persistedThisSession: false,
		lastCheckpointId: undefined,
		lastCompactedFrom: 0,
		lastCompactedTokens: 0,
		dedupSkips: 0,
		dedupAttempts: 0,
		tokensSaved: 0,
		lastCompactAt: null,
		lastRecallAt: null,
		lastInjectAt: null,
		_prevCacheHitPct: null,
		_lastCacheHealthScore: undefined,
		lastNativeCompactAt: null,
		compactCount: 0,
		recallInjections: 0,
		cacheHitTokens: 0,
		lengthStopPending: false,
		errorRetryCount: 0,
		errorRetryUntil: 0,
		consecutiveErrors: 0,
		lastErrorRetryAt: 0,
		retryNudgePending: false,
		errorRetrySessionCount: 0,
		lastErrorText: undefined,
		errorTextRepeatCount: 0,
		poisonedAdviseSent: false,
		providerOutageAdvised: false,
		poisonedCompactSignatures: new Set(),
		recallInjectedThisTurn: false,
		poisonedCount: 0,
		extensionInitiatedTurn: false,
	};
	self.trimCache = null; // v0.8.6: never replay a stale trim into a new session
	self.statusKey = undefined;
	self.activeAgents = 0;
	self.currentTurn = 0;
	self.lastActivityAt = 0;
	self.tierTrace = undefined;
	self.ticker.length = 0;
	self.pulsing = false;
	self.savedGoal = 50_000;
	self.lastWhy = undefined;
	// S31 audit P2: symmetry with bindRepo — a reset can coincide with a context
	// that re-binds the repo, so drop the memo too. Cheap; the next
	// getCachedGameState() re-queries lazily.
	self.cachedGameState = undefined;
}
