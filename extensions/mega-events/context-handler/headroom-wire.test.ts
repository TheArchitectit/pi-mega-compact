/**
 * headroom-wire.test.ts — v0.21.12 invisible-overhead H (wireTruth) tail-cap tests.
 *
 * Sibling of headroom.test.ts (the pure-function half), split per the extensions/
 * 400-line soft limit — the repo used the same split for the degenerate-guard
 * tests in v0.21.10. Covers the `overheadTokens` parameter on applyTailCap /
 * recapReplayedTail: the provider's invisible overhead H (system prompt + tool
 * definitions + extension systemPrompt prepends — everything pi adds at request
 * time that NEVER appears in the stored transcript) is subtracted from the
 * tail-cap budget so the cap bounds the REAL wire prompt, not just the counted
 * messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyTailCap,
} from "./headroom.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function am(role: "user" | "assistant" | "toolResult", text: string): AgentMessage {
	if (role === "toolResult") {
		return {
			role,
			toolCallId: "c1",
			toolName: "Bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		} as unknown as AgentMessage;
	}
	return { role, content: text, timestamp: 0 } as unknown as AgentMessage;
}

test("applyTailCap: overheadTokens is subtracted from the budget", () => {
	// window 32768, reserve 20000, margin 5% (1600), summary 0 → bare budget
	// = 11168. Three 3000-token messages (12000 chars) fit the bare budget; add
	// H = 16000 and the budget collapses to -4824 → floored to 1 → only the
	// final message survives.
	const msgs = [am("user", "A".repeat(12000)), am("user", "B".repeat(12000)), am("user", "C".repeat(12000))];
	const noH = applyTailCap({
		recentRaw: msgs, summaryTokens: 0, ctxWindow: 32768, maxOutputTokens: 20000,
		outputReservePct: 0.3, safetyMarginPct: 5,
	});
	assert.equal(noH.dropped, 0, "without H the tail fits");
	const withH = applyTailCap({
		recentRaw: msgs, summaryTokens: 0, ctxWindow: 32768, maxOutputTokens: 20000,
		outputReservePct: 0.3, safetyMarginPct: 5, overheadTokens: 16000,
	});
	assert.ok(withH.dropped >= 1, "H forces front-drops so the wire prompt fits");
	assert.equal((withH.recent[withH.recent.length - 1] as { content: string }).content[0], "C", "final message survives");
});

test("applyTailCap: overhead is percent-based — identical RATIO at 32768 / 204800 / 1048576", () => {
	// With H = 0.5 × window the budget always collapses to ~0 regardless of
	// size; assert the SAME drop ratio (2 of 3 messages) at every window.
	for (const window of [32768, 204800, 1048576]) {
		const per = Math.round(window * 0.03); // ~3% of window per message → 3 msgs ≈ 9% tail
		const msgs = [am("user", "A".repeat(per)), am("user", "B".repeat(per)), am("user", "C".repeat(per))];
		const r = applyTailCap({
			recentRaw: msgs, summaryTokens: 0, ctxWindow: window, maxOutputTokens: Math.round(window * 0.5),
			outputReservePct: 0.3, safetyMarginPct: 5, overheadTokens: Math.round(window * 0.5),
		});
		assert.equal(r.dropped, 2, `window=${window}: same 2-of-3 drop ratio`);
	}
});

test("applyTailCap: regression replicating the 2026-08-19 incident (est fits, H 16000 tips it over, window 32768, reserve 20000, margin 5%)", () => {
	// v0.21.11 blind spot: the message-only estimate reads ~11k tokens (just under
	// the 11130-token budget), so the cap ships the RAW view. But the REAL wire
	// prompt is est + H (the invisible overhead: system prompt + tool defs +
	// extension prepends) ≈ 27k — which overflows the 32768 window → 400. With H
	// subtracted from the budget, the cap drops the overflowing front.
	const window = 32768;
	const reserve = 20000;
	const H = 16000;
	// 8 messages × ~5500 chars ≈ 1376 tokens each → ~11k total (under the budget).
	const msgs = Array.from({ length: 8 }, (_, i) => am("user", `${i}${i}`.repeat(2750)));
	const noH = applyTailCap({
		recentRaw: msgs, summaryTokens: 0, ctxWindow: window, maxOutputTokens: reserve,
		outputReservePct: 0.3, safetyMarginPct: 5,
	});
	assert.equal(noH.dropped, 0, "WITHOUT H the ~11k tail is judged to fit (the v0.21.11 blind spot)");
	const withH = applyTailCap({
		recentRaw: msgs, summaryTokens: 0, ctxWindow: window, maxOutputTokens: reserve,
		outputReservePct: 0.3, safetyMarginPct: 5, overheadTokens: H,
	});
	assert.ok(withH.dropped > 0, "WITH H the cap drops the overflowing front (breaks the 400 loop)");
});
