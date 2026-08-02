/**
 * mega-events/agent-handlers.ts — agent/turn tracking event handlers.
 *
 * Delegate-shell (extensions split): registers agent_start/end + turn_start/end.
 * The two heavy handlers live in ./agent-handlers/impl files to stay under the
 * extensions line limit:
 *  - agentEndHandler.ts  (agent_end: status line, durable trim, nudge)
 *  - turnEndHandler.ts   (turn_end: turn row, scoring, retry net, stripes, health)
 * agent_start + turn_start are small enough to keep inline here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";
import { handleAgentEnd } from "./agent-handlers/agentEndHandler.js";
import { handleTurnEnd } from "./agent-handlers/turnEndHandler.js";

/** Register agent/turn tracking event handlers. */
export function registerAgentHandlers(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	// ---- Agent tracking for real-time widget + status-line updates ---------
	pi.on("agent_start", async (_event, ctx) => {
		runtime.activeAgents++;
		runtime.dashboard.event("agent_start", {
			activeAgents: runtime.activeAgents,
		});
		// Surface live agent activity on the status line (toolbar), not just the
		// above-editor widget — otherwise concurrent agents look frozen.
		runtime.setStatus(
			ctx,
			`mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`,
		);
		runtime.snapshot(ctx);
	});

	pi.on("agent_end", (_event, ctx) =>
		handleAgentEnd(ctx, pi, runtime, config),
	);

	pi.on("turn_start", async (event, ctx) => {
		runtime.currentTurn = event.turnIndex;
		runtime.rt.lengthStopPending = false; // S28: re-arm defensively each user turn
		runtime.rt.errorRetryCount = 0; // S38: reset error-retry counter each user turn
		// R4 (turn_end hygiene): a genuine new user prompt consumes any queued
		// retry nudge (deliverAs:'followUp') — pi dispatches it as the prompt for
		// this turn. Clearing retryNudgePending re-arms the dedup gate so the
		// next error turn can fire a fresh nudge (subject to backoff).
		// NOTE: the poisoned-repeat tracker (lastErrorText / errorTextRepeatCount)
		// is NOT reset here — a retry turn consuming the queued nudge is still the
		// same error sequence. The tracker resets on a SUCCESSFUL turn (null) or
		// when a different error text appears, not on the turn boundary.
		runtime.rt.retryNudgePending = false;
		runtime.dashboard.event("turn_start", { turnIndex: event.turnIndex });
		runtime.snapshot(ctx);
	});

	pi.on("turn_end", (event, ctx) =>
		handleTurnEnd(event, ctx, pi, runtime, config),
	);
}
