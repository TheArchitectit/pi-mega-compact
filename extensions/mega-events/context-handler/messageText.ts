/**
 * context-handler/messageText.ts — best-effort text extraction helpers.
 *
 * Extracted from context-handler.ts (delegate-shell split). AgentMessage is a
 * discriminated union; .content exists only on some variants
 * (user/assistant/toolResult/custom). Narrow by role, never assume.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Best-effort text extraction from an AgentMessage for analytics/logging. */
export function messageContentText(m: AgentMessage): string {
	const c = (m as { content?: unknown }).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
			.join(" ");
	}
	return "";
}
