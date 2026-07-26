/**
 * send-safe.ts — queue-safe wrapper for pi.sendUserMessage.
 *
 * All extension-initiated user-role nudges (resume after compaction, length-stop
 * continue, error-retry) MUST go through this wrapper. It:
 *   1. Passes { deliverAs: 'followUp' } so that when the agent is busy (e.g. a
 *      resume nudge fired during session_before_compact, which is mid-prompt
 *      submission) pi QUEUES the message instead of throwing
 *      "Agent is already processing. Specify streamingBehavior (steer or
 *      followUp) to queue the message" (pi agent-session.js:830).
 *   2. Awaits the call and catch-guards it so a failed/queued nudge never throws
 *      or produces an unhandled rejection — it must never block the agent loop.
 *
 * PREVENT-PI-003: user-role sendUserMessage only (no role:'system' injection).
 * PREVENT-PI-004: local pi ctx call, no network.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * safeSendUserMessage — await + catch-guard + queue-safe wrapper for
 * pi.sendUserMessage. Never throws; never produces an unhandled rejection.
 */
export async function safeSendUserMessage(
	pi: ExtensionAPI,
	content: string,
): Promise<void> {
	try {
		await (
			pi.sendUserMessage as (
				c: string,
				o?: { deliverAs?: "steer" | "followUp" },
			) => Promise<void> | void
		)(content, { deliverAs: "followUp" });
	} catch {
		/* non-fatal: a failed/queued nudge never blocks the agent loop */
	}
}
