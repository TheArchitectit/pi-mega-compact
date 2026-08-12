/**
 * extensions/mega-events/context-handler/triggerGuard.ts — 3WF-1 TriggerGuard.
 *
 * Production-incident fix: `session_start` can silently never fire (pi host
 * behavior), so the only recall staging point (session-handlers.ts) is skipped
 * and a session replays with NO recall block and NO telemetry. TriggerGuard
 * re-stages at the `context` event seam — the one place that ALWAYS runs and
 * where the staged block is composed into the model view on this same event.
 *
 * Stack position (context-handler.ts): run DIRECTLY BEFORE `buildTailResult` is
 * built, so a freshly staged block is picked up by the existing tail machinery
 * (recall-tail.ts) with zero changes to it.
 *
 * Contract:
 *  - one-shot per MegaRuntime (WeakMap) — recall does NOT re-run on every event.
 *  - if runtime.pendingRecallBlock != null already, no-op (session_start won).
 *  - read-only recall via engine.recall -> formatRecallBlock; no vectorMarkInjected,
 *    no S43 telemetry, no turn writes (this is a guard, not an inline).
 *  - an empty store (checkpointCount == 0) is a genuinely new session: no crash,
 *    no floor staged, just marked done.
 *  - a store WITH checkpoints whose recall returns nothing: stage the provenance
 *    floor (newest checkpoint summary) instead of silence.
 *  - never throws (whole body guarded), non-fatal, PREVENT-PI-003 (block is plain
 *    text; role decided downstream by withRecallTail as user).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { normalizeSessionId } from "../../../src/store.js";
import { recall } from "../../../src/engine.js";
import { formatRecallBlock } from "../../../src/recall.js";
import { vectorStats, vectorList } from "../../../src/vectorStore.js";
import { recentUserQuery } from "../../mega-runtime.js";

/** One-shot completion marker per MegaRuntime (dies with the runtime). */
const guardDone = new WeakMap<MegaRuntime, { done: true }>();

/** The minimal ctx surface the guard reads (query + session id). Accepted instead
 *  of the full ExtensionContext so tests can pass a thin stub without a full
 *  pi ctx; structurally satisfied by the real ExtensionContext. */
interface GuardCtx {
	sessionManager: { getSessionId(): string };
}


/**
 * Run the TriggerGuard for this context event. Best-effort: never throws; any
 * failure degrades to the pre-sprint path (no staged block).
 */
export function runTriggerGuard(
	runtime: MegaRuntime,
	config: MegaConfig,
	ctx: GuardCtx,
): void {
	try {
		// Flag OFF => byte-identical pre-sprint behavior (no touch, no telemetry).
		if (!config.threeWayFailback) return;
		// session_start already staged a block => the normal path wins, no-op.
		if (runtime.pendingRecallBlock != null) return;
		// One-shot: we've already decided for this runtime.
		if (guardDone.has(runtime)) return;

		// recentUserQuery only reads sessionManager.getEntries(); the structural
		// GuardCtx satisfies it at runtime (cast to the full type it expects).
		const query = recentUserQuery(ctx as unknown as ExtensionContext);
		if (!query) {
			guardDone.set(runtime, { done: true });
			return;
		}

		const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
		const stats = vectorStats(runtime.store, sid);
		// Empty store => genuinely new session; not a recall failure. Mark done so
		// we don't re-check forever, stage nothing (no crash, no floor).
		if (stats.checkpointCount <= 0) {
			guardDone.set(runtime, { done: true });
			return;
		}

		// Read-only recall: search + rank only; skipInjected:false means we keep
		// hits already injected this session, but we never call vectorMarkInjected
		// ourselves (A1) — formatRecallBlock does the same as session_start uses.
		const hits = recall(
			{ sessionId: sid, query, limit: config.autoInlineK, skipInjected: false },
			runtime.store,
		).hits;

		if (hits.length > 0) {
			runtime.pendingRecallBlock = formatRecallBlock(hits);
			guardDone.set(runtime, { done: true });
			runtime.appendEvent("three_way_guard_fired", {
				source: "recall",
				hitCount: hits.length,
				topScore: hits[0]?.score ?? null,
			});
			return;
		}

		// Store HAS checkpoints but recall found nothing relevant: stage a
		// provenance floor built from the newest checkpoint summary rather than
		// silence (the incident's "recall silently never ran" shape).
		const floor = buildFloorBlock(runtime, sid);
		runtime.pendingRecallBlock = floor;
		guardDone.set(runtime, { done: true });
		runtime.appendEvent("three_way_floor_used", { basis: "lastCheckpoint" });
	} catch {
		/* never throws; best-effort guard */
	}
}

/** Build the provenance floor string from the session's newest checkpoint. */
function buildFloorBlock(runtime: MegaRuntime, sid: string): string {
	try {
		const cps = vectorList(runtime.store, sid);
		let newest = cps[0];
		for (const cp of cps) {
			if (!newest || (cp.timestamp ?? 0) > (newest.timestamp ?? 0)) newest = cp;
		}
		const summary = newest?.summary?.trim();
		if (summary) {
			return (
				"The following compacted context is the most recent checkpoint from " +
				"this session (recall found no query-relevant match):\n\n" + summary
			);
		}
		return (
			"This session has compacted context but recall could not surface a " +
			"checkpoint relevant to the current request; the most recent checkpoint " +
			"summary is unavailable."
		);
	} catch {
		return (
			"This session has compacted context but recall could not surface a " +
			"checkpoint relevant to the current request."
		);
	}
}
