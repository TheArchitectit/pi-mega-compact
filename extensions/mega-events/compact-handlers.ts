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
import { evaluateAndUnlockAchievements } from "../../src/store/sqlite/game-achievements.js";
import { resolveRepoRoot } from "../mega-config.js";
import { safeSendInvisibleMessage } from "./send-safe.js";

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
 *
 * Uses safeSendInvisibleMessage ({ deliverAs: 'followUp' } + catch-guard) so that a
 * nudge fired during session_before_compact (which is mid-prompt-submission,
 * so the agent can be busy) QUEUES instead of throwing
 * "Agent is already processing. Specify streamingBehavior (steer or followUp)".
 */
async function nudgeResume(pi: ExtensionAPI, runtime: MegaRuntime): Promise<void> {
	try {
		const now = Date.now();
		if (now >= runtime.resumeNudgeUntil) {
			runtime.resumeNudgeUntil = now + 30_000;
			runtime.rt.extensionInitiatedTurn = true; // R13: suppress self-classification
			await safeSendInvisibleMessage(
				pi,
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

			// S38.5: COMPACT-DEDUP RACE GUARD — pi's _runAutoCompaction fires
			// session_before_compact from within the agent loop (after agent_end,
			// _handlePostAgentRun → _checkCompaction → _runAutoCompaction). If a
			// compaction just completed (within the cooldown window), pi's
			// prepareCompaction may still see the last entry as a compaction but
			// the extension's session_compact handler hasn't been called yet, OR
			// the setTimeout deferred ctx.compact() from the agent_end handler is
			// about to race. Skip the durable trim and let pi run its own compact
			// (or no-op if the branch is already compacted). Matches the cooldown
			// in agent-handlers.ts so both call sites are consistent.
			const cooldownMs = config.raceGuardStrict ? 30_000 : 10_000;
			const sinceCompact = Date.now() - (runtime.rt.lastNativeCompactAt ?? 0);
			if (sinceCompact < cooldownMs) {
				runtime.logger.info("before-compact-skip-recent", {
					sessionId: runtime.rt.sessionId,
					reason: event.reason,
					sinceCompactMs: sinceCompact,
					cooldownMs,
				});
				runtime.diagBeforeCompactSupplied++;
				const fb = fallbackCompaction(event);
				if (fb) {
					return { compaction: fb.compaction };
				}
				return {};
			}

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
					await nudgeResume(pi, runtime);
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
					await nudgeResume(pi, runtime);
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
			runtime.trimCache = null; // v0.8.6: durable truncation changes the transcript — never replay the stale cached cut (PREVENT-PI-001/002)
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
			// S35: evaluate achievements after scoring; arm the one-time flare.
			const newTitles = evaluateAndUnlockAchievements(runtime.currentStateDir);
			if (newTitles.length) runtime.armAchievementFlare(newTitles);
			} catch {
				/* non-fatal: scoring must never break compaction */
			}
		});
}
