/**
 * outage-advisor.ts — R10: calm "provider outage" advisory.
 *
 * When a provider/router flaps (transient errors: timeouts, 5xx, 429s),
 * the extension retries silently and eventually goes quiet after caps. This
 * module sends ONE user-facing advisory per outage episode so the user knows
 * to wait rather than running /clear.
 *
 * Distinct from the poisoned-context /clear advise: the outage advisory is
 * for transient errors where the user's context is fine.
 *
 * PREVENT-PI-003: sends via safeSendUserMessage (user-role only).
 * PREVENT-PI-004: local ctx call, no network.
 */

import type { MegaRuntime } from "../mega-runtime.js";
import { safeSendUserMessage } from "./send-safe.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Check the provider-outage advisory condition and fire once per episode.
 *
 * Called from the transient/permanent retry branch of the turn_end handler,
 * AFTER consecutiveErrors is incremented.
 *
 * @param effectiveCategory — must be "transient" for the advisory to fire.
 * @param runtime   — the live MegaRuntime (mutated on advisory fire).
 * @param pi        — pi ExtensionAPI for safeSendUserMessage.
 */
export async function maybeSendProviderOutageAdvisory(
	effectiveCategory: string,
	runtime: MegaRuntime,
	pi: ExtensionAPI,
	config: { providerOutageAdviseThreshold: number },
): Promise<void> {
	if (effectiveCategory !== "transient") return;
	if (config.providerOutageAdviseThreshold <= 0) return;
	if (runtime.rt.providerOutageAdvised) return;
	if (runtime.rt.consecutiveErrors < config.providerOutageAdviseThreshold)
		return;

	runtime.rt.providerOutageAdvised = true;

	runtime.dashboard.event("provider_outage_advised", {
		consecutiveErrors: runtime.rt.consecutiveErrors,
		turnIndex: runtime.currentTurn,
		sessionId: runtime.rt.sessionId,
	});

	runtime.logger.info("provider-outage-advised", {
		sessionId: runtime.rt.sessionId,
		consecutiveErrors: runtime.rt.consecutiveErrors,
		turnIndex: runtime.currentTurn,
	});

	await safeSendUserMessage(
		pi,
		`[mega-compact] the provider is having issues (${runtime.rt.consecutiveErrors} consecutive failures — timeouts/5xx/rate-limits). Retries are bounded and continue automatically; your context is fine — do NOT clear or reset it. Work resumes as soon as the provider recovers.`,
	);
}
