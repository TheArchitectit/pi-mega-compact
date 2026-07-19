/**
 * query.ts — the `recentUserQuery` free function, extracted from the original
 * mega-runtime.ts monolith.
 *
 * Latest user message text — used as the auto-inline recall query.
 * Kept as a free function (not instance state) since it only reads ctx.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

export function recentUserQuery(ctx: ExtensionContext): string {
	try {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const msgs = sessionEntryToContextMessages(entries[i]);
			for (let j = msgs.length - 1; j >= 0; j--) {
				if (msgs[j].role === "user") {
					const c = (msgs[j] as { content: unknown }).content;
					if (typeof c === "string") return c;
					if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join(" ");
				}
			}
		}
	} catch {
		/* best-effort */
	}
	return "";
}
