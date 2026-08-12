/**
 * noop.ts — pi durable-compact no-op prediction (moved from compact.ts as part
 * of the delegate-shell split; the shell re-exports the public API unchanged).
 *
 * See piCompactWouldNoop's JSDoc for the full rationale (predicting pi's
 * `ctx.compact()` no-op throw before it surfaces a user-facing error).
 */

import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateBlockTokens } from "../../../src/tokens.js";

/**
 * Predict whether pi's `ctx.compact()` would throw a no-op error — "Already
 * compacted" or "Nothing to compact (session too small)" — so the auto-trigger
 * can SKIP the call instead of surfacing a hard, user-facing error.
 *
 * Why we can't intercept or suppress it: pi's public `compact()` computes
 * `prepareCompaction()` and throws *before* it emits `session_before_compact`,
 * so our handler there never runs on the no-op path. And `ctx.compact()`'s
 * `onError` callback fires only AFTER pi has already emitted a `compaction_end`
 * event carrying the error message (which the interactive UI renders) — so
 * `onError` cannot mute it either. The only robust fix is to not call
 * `ctx.compact()` when pi would no-op. (pi's own `_runAutoCompaction` path is
 * silent on this same condition; the public path we're forced through is the
 * one that throws.)
 *
 * Skipping is correct, not a compromise: by the time this runs, `runCompact()`
 * has already persisted the recall checkpoint (Path A). The durable on-disk
 * trim is only useful when pi can actually summarize a region; a transcript
 * under pi's `keepRecentTokens` budget is small enough that reloading it on
 * resume isn't a token-growth problem, so the durable trim is unnecessary
 * there anyway.
 *
 * Mirrors pi's `prepareCompaction()` return-undefined conditions (compaction.js):
 *  (1) last entry is a compaction      → "Already compacted"
 *  (2) <2 cut-point messages since the last compaction → nothing to summarize
 *      (a cut point = any non-toolResult message — user/assistant/bash/custom/
 *       branchSummary/compactionSummary — matching pi's isCutPointMessage)
 *  (3) transcript tokens since the last compaction < keepRecentTokens → pi
 *      keeps everything → nothing to summarize
 * `keepRecentTokens` isn't readable from the extension API, so (3) uses the pi
 * default (20000) as a conservative floor; raise it via
 * `MEGACOMPACT_DURABLE_TRIM_FLOOR` if you raise pi's `compact.keepRecentTokens`.
 *
 * Best-effort: on any read error returns true (skip) — skipping a durable trim
 * is always safe; calling `ctx.compact()` on a no-op throws to the user.
 */
export function piCompactWouldNoop(ctx: ExtensionContext): boolean {
	try {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length === 0) return true;
		// (1) already compacted — pi throws "Already compacted"
		if (branch[branch.length - 1].type === "compaction") return true;
		// boundaryStart = index just after the most recent compaction entry (or 0)
		let boundaryStart = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type === "compaction") { boundaryStart = i + 1; break; }
		}
		void boundaryStart;
		let cutPoints = 0;
		let tokens = 0;
		for (let i = boundaryStart; i < branch.length; i++) {
			const e = branch[i];
			if (e.type === "compaction") continue;
			let isCut = false;
			for (const m of sessionEntryToContextMessages(e)) {
				// pi's isCutPointMessage: every role except toolResult
				if ((m as { role?: string }).role !== "toolResult") isCut = true;
				const c = (m as { content?: unknown }).content;
				const text =
					typeof c === "string" ? c
						: Array.isArray(c)
							? (c as { text?: string }[]).map((b) => b?.text ?? "").join(" ")
							: "";
				if (text) tokens += estimateBlockTokens(text);
			}
			if (isCut) cutPoints++;
		}
		// (2) need >=2 cut points so the kept cut isn't the first message
		if (cutPoints < 2) return true;
		// (3) transcript under pi's keepRecentTokens budget → pi keeps everything
		if (tokens < durableTrimFloorTokens()) return true;
		return false;
	} catch {
		return true; // safe: skip the durable trim rather than risk a user-facing throw
	}
}

/** pi's default keepRecentTokens (compaction settings). Override with
 *  MEGACOMPACT_DURABLE_TRIM_FLOOR if you raise pi's compact.keepRecentTokens. */
function durableTrimFloorTokens(): number {
	const raw = process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
	if (raw !== undefined && Number.isFinite(Number(raw))) return Number(raw);
	return 20_000;
}
