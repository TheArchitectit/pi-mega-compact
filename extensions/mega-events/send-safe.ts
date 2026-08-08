/**
 * send-safe.ts — queue-safe wrappers for pi.sendUserMessage / pi.sendMessage.
 *
 * All extension-initiated user-role nudges (resume after compaction, length-stop
 * continue, error-retry) MUST go through these wrappers. They:
 *   1. Pass { deliverAs: 'followUp' } so that when the agent is busy (e.g. a
 *      resume nudge fired during session_before_compact, which is mid-prompt
 *      submission) pi QUEUES the message instead of throwing
 *      "Agent is already processing. Specify streamingBehavior (steer or
 *      followUp) to queue the message" (pi agent-session.js:830).
 *   2. Await the call and catch-guard it so a failed/queued nudge never throws
 *      or produces an unhandled rejection — it must never block the agent loop.
 *
 * safeSendUserMessage renders the text in the conversation UI (visible).
 * safeSendInvisibleMessage delivers via pi.sendMessage with display: false —
 * the agent receives the retry trigger but the user never sees the text.
 *
 * PREVENT-PI-003: user-role sendUserMessage only (no role:'system' injection).
 * PREVENT-PI-004: local pi ctx call, no network.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * safeSendUserMessage — await + catch-guard + queue-safe wrapper for
 * pi.sendUserMessage. Never throws; never produces an unhandled rejection.
 * The message IS visible in the conversation UI ("Follow-up:").
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

/**
 * safeSendInvisibleMessage — like safeSendUserMessage but uses pi.sendMessage
 * with `display: false` so the retry trigger is delivered to the agent WITHOUT
 * rendering in the conversation UI. Fixes the "Follow-up: [mega-compact] ..."
 * pile-up when the API retries repeatedly — the retry mechanism still fires,
 * the user just doesn't see the queued messages.
 */
export async function safeSendInvisibleMessage(
	pi: ExtensionAPI,
	content: string,
): Promise<void> {
	try {
		await (
			pi.sendMessage as (
				m: { customType: string; content: string; display: boolean },
				o?: { deliverAs?: "steer" | "followUp" },
			) => Promise<void> | void
		)(
			{ customType: "mega-compact-retry", content, display: false },
			{ deliverAs: "followUp" },
		);
	} catch {
		/* non-fatal: a failed/queued nudge never blocks the agent loop */
	}
}
