/**
 * mega-events/compact-handlers.ts — native compaction event handlers.
 *
 * Registers session_before_compact (supplies durable trim via
 * driveNativeCompaction + fallback) and session_compact (tracks every
 * compaction for the race-closing cooldown). Contains the helper functions
 * fallbackCompaction and nudgeResume.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	driveNativeCompaction,
	type NativeCompactionResult,
} from "../mega-compact-driver.js";
import { estimateBlockTokens } from "../../src/tokens.js";
import { type MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";
import { recordScore, getDedupStats } from "../../src/store/sqlite.js";
import { resolveRepoRoot } from "../mega-config.js";

/**
 * Build a minimal fallback compaction so pi never runs its throwing compact().
 *
 * Used when our Trident/RAPTOR summary is empty or there is nothing to
 * summarize (the anchor floor protects every message). We still record a
 * resume summary + truncate from prep.firstKeptEntryId so the session always
 * gets a compact summary and resumes. Returns undefined only if pi handed us
 * no preparation cut point at all.
 */
function fallbackCompaction(
	event: SessionBeforeCompactEvent,
): NativeCompactionResult | undefined {
	const prep = event.preparation;
	if (!prep?.firstKeptEntryId) return undefined;
	// When messagesToSummarize is empty the anchor floor protects everything,
	// so firstKeptEntryId == current first entry and the trim is a no-op — but
	// we still record a resume summary so the session has context after compaction.
	const tokensBefore = prep.tokensBefore ?? 0;
	const summary =
		`[mega-compact] context compacted at ${tokensBefore.toLocaleString()} tokens ` +
		`(anchor floor active). Continue from the most recent messages above.`;
	return {
		compaction: {
			summary,
			firstKeptEntryId: prep.firstKeptEntryId,
			tokensBefore,
			estimatedTokensAfter: estimateBlockTokens(summary),
		},
	};
}

/**
 * Debounced resume-nudge: restart the agent loop after a compaction (which
 * may have stopped it). Idempotent — one nudge per 30s, never blocks.
 */
function nudgeResume(pi: ExtensionAPI, runtime: MegaRuntime): void {
	try {
		const now = Date.now();
		if (now >= runtime.resumeNudgeUntil) {
			runtime.resumeNudgeUntil = now + 30_000;
			pi.sendUserMessage(
				"[mega-compact] continue from the compacted context above.",
			);
		}
	} catch {
		/* non-fatal: a failed nudge never blocks */
	}
}

/** Register native compaction event handlers. */
export function registerCompactHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// ---- Supply a DURABLE trim to pi's native compaction (Fix B) ----------
	// We run the Trident pipeline to produce a compressed summary, then return
	// it as a CompactionResult. pi writes the summary into a compactionSummary
	// entry AND truncates the on-disk transcript from firstKeptEntryId. This is
	// the durable fix for "tokens grow on read": the trim survives resume, so
	// there is no full-reload + additive recall inflation.
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			runtime.resetRuntime(ctx.sessionManager.getSessionId());
			// DIAG (team-run relief): this is the ONLY durable-trim entry point. Log
			// every fire + whether we supplied a compaction (truncates transcript) or
			// fell through to {} (pi runs its own). If this is sparse during a team
			// run, the durable trim is firing too late (only at parent settle).
			const prep = event.preparation;
			runtime.diagBeforeCompactFires++;
			runtime.logger.info("before-compact-entry", {
				sessionId: runtime.rt.sessionId,
				reason: event.reason,
				hasPrep: !!prep,
				msgsToSummarize: prep?.messagesToSummarize?.length ?? 0,
				firstKeptEntryId: prep?.firstKeptEntryId ?? null,
				activeAgents: runtime.activeAgents,
			});
			if (!config.auto) return {}; // let pi run its own native compaction
			try {
				const result = driveNativeCompaction(event, runtime, config);
				if (result && result.compaction.summary?.trim()) {
					runtime.diagBeforeCompactSupplied++;
					runtime.logger.info("native-compact", {
						sessionId: runtime.rt.sessionId,
						firstKeptEntryId: result.compaction.firstKeptEntryId,
						tokensBefore: result.compaction.tokensBefore,
						summaryTokens: result.compaction.estimatedTokensAfter,
					});
					nudgeResume(pi, runtime);
					return { compaction: result.compaction };
				}
				// FIX "compacts but doesn't resume" + "Nothing to compact" regression:
				// when we have nothing to summarize (anchor floor protects everything →
				// messagesToSummarize empty) or our Trident/RAPTOR summary came back
				// EMPTY, pi's OWN compact() throws "Nothing to compact (session too
				// small)" and leaves the session stuck with no resume context. Instead
				// of returning {} (which makes pi run its throwing compact()), supply a
				// fallback compaction from prep.firstKeptEntryId with a minimal resume
				// summary. This ALWAYS injects a compact summary so the session
				// resumes, and never surfaces the "Nothing to compact" error to the user.
				const fb = fallbackCompaction(event);
				if (fb) {
					runtime.diagBeforeCompactSupplied++;
					runtime.logger.info("native-compact-fallback", {
						sessionId: runtime.rt.sessionId,
						firstKeptEntryId: fb.compaction.firstKeptEntryId,
						tokensBefore: fb.compaction.tokensBefore,
						reason: event.reason,
					});
					nudgeResume(pi, runtime);
					return { compaction: fb.compaction };
				}
			} catch (err) {
				runtime.logger.error("native-compact-failed", {
					sessionId: runtime.rt.sessionId,
					error: String(err instanceof Error ? err.message : err),
				});
			}
			// Absolute last resort: let pi run its own (may throw "Nothing to compact").
			return {};
		},
	);

		// COMPACT-DEDUP FIX: track EVERY compaction (native + extension-supplied)
		// so the agent_end durable-trim guard can skip a redundant ctx.compact()
		// when pi just compacted. Without this, agent_end fires ctx.compact()
		// synchronously AFTER pi's native auto-compaction appended a compaction
		// entry but BEFORE our branch read sees it on the next tick — racing
		// into a user-facing "Already compacted" throw. `lastCompactAt` is the
		// race-closing signal: any compaction (manual/threshold/overflow, ours
		// or pi's own) stamps it, and the agent_end guard skips for 10s.
		pi.on("session_compact", async (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
			runtime.rt.lastNativeCompactAt = Date.now();
			runtime.rt.lastCompactAt = Date.now();
			runtime.logger.info("session-compacted", {
				sessionId: runtime.rt.sessionId,
				at: runtime.rt.lastCompactAt,
			});

			// S33: game-mode dedupe scoring — record the DELTA of cumulative dedup
			// collapses since the last compact (leaderboard SUMs the deltas). Gated
			// behind game_mode_on (no scoring when off). Best-effort + non-fatal (G6).
			try {
				if (runtime.getCachedGameState().game_mode_on) {
					const ds = getDedupStats(runtime.currentStateDir);
					const delta = ds.deduped - runtime.lastDedupCollapsed;
					runtime.lastDedupCollapsed = ds.deduped;
					if (delta > 0) {
						const repo = resolveRepoRoot(_ctx.cwd) ?? runtime.currentStateDir;
						recordScore(runtime.currentStateDir, {
							repo_root: repo,
							metric: "dedupe",
							value: delta,
							meta: { compactCount: runtime.rt.compactCount },
						});
					}
				}
			} catch {
				/* non-fatal: scoring must never break compaction */
			}
		});
}
