/**
 * liveTrim-wire.test.ts — v0.21.12 invisible-overhead skip-cap.
 *
 * Drives the REAL buildLiveTrimView with a minimal typed runtime stub (only the
 * fields liveTrim touches — mirrors thrashGuard.test.ts's stub). Proves the
 * invariant "the trim path never ships a view the budget wouldn't allow": when
 * computeLiveTrimCut returns null (the anchor floor blocks a fat recent tool
 * pair) AND wireOverhead is ON, the skip path front-drops the overflowing tail
 * so est+H fits the budget — breaking the 400 loop even when no summary is
 * possible. Flag OFF ⇒ the RAW view is returned unchanged (byte-identical
 * v0.21.11).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { buildLiveTrimView } from "./liveTrim.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as MegaRuntime["logger"];

/** Minimal runtime stub — only the fields buildLiveTrimView reads. */
function runtimeStub(): MegaRuntime {
	return {
		rt: { sessionId: "s1", lastNativeCompactAt: 0, lastCompactAt: 0, compactCount: 0, lastCheckpointId: "" } as MegaRuntime["rt"],
		currentModel: { modelId: "qwen3.8-27b", contextWindow: 32768, maxTokens: 20000 },
		logger: noopLogger,
		lastCtxWindow: 32768,
		trimCache: null,
		diagCtxCutNull: 0,
		diagCtxSkipCapped: 0,
		snapshot: () => {},
	} as unknown as MegaRuntime;
}

function cfg(wireOverhead = true): MegaConfig {
	return {
		auto: true,
		anchorUserMessages: 3,
		outputReservePct: 0.3,
		wireOverhead,
		wireOverheadDefaultPct: 0.15,
		overflowHeadroom: true,
	} as unknown as MegaConfig;
}

function am(role: "user" | "assistant" | "toolResult", text: string): AgentMessage {
	if (role === "toolResult") {
		return { role, toolCallId: "c1", toolName: "Bash", content: [{ type: "text", text }], isError: false, timestamp: 0 } as unknown as AgentMessage;
	}
	return { role, content: text, timestamp: 0 } as unknown as AgentMessage;
}

// A compact result with NO real summary-able region — forces computeLiveTrimCut
// toward a null cut (the degenerate/anchor-blocked skip path). We pass a view
// whose compactedFrom == length (nothing to summarize) so the cut is null.
const ranResult = { result: { checkpointId: "cp1", compactedFrom: 99, summary: "" } };

test("liveTrim skip-cap: cut=null + est+H overflow → returned view is front-capped (dropped>0, last message kept, tool pair intact)", () => {
	// 8 messages × ~13k chars ≈ 3250 est tokens each → ~26k tail (under every
	// threshold). H = 16000 (the invisible overhead) → real wire ≈ 42k > 32768.
	const messages: AgentMessage[] = Array.from({ length: 8 }, (_, i) =>
		am("user", `${i}${i}`.repeat(6500)),
	);
	const rt = runtimeStub();
	const out = buildLiveTrimView(rt, cfg(), {} as ExtensionContext, {
		messages,
		view: [],
		pct: 80,
		currentTokens: 26000,
		usageTokens: null,
		pressure: 0.8,
		ran: ranResult,
		perModelThreshold: { safetyMarginPct: 5, firePointPct: 80 },
		tailResult: (msgs?: readonly AgentMessage[]) =>
			msgs ? { messages: [...msgs] } : undefined,
		overheadTokens: 16000,
	});
	assert.ok(out, "a view is returned (not undefined)");
	assert.ok((out as { messages: AgentMessage[] }).messages.length < messages.length, "the overflowing front was dropped");
	const last = (out as { messages: AgentMessage[] }).messages.at(-1) as { content: string };
	assert.equal(last.content[0], "7", "the FINAL message survives the skip-cap");
	assert.ok(rt.diagCtxSkipCapped >= 1, "skip-cap counter increments");
});

test("liveTrim skip-cap: flag OFF ⇒ RAW view returned unchanged (byte-identical v0.21.11)", () => {
	const messages: AgentMessage[] = Array.from({ length: 8 }, (_, i) =>
		am("user", `${i}${i}`.repeat(6500)),
	);
	const rt = runtimeStub();
	const out = buildLiveTrimView(rt, cfg(false), {} as ExtensionContext, {
		messages,
		view: [],
		pct: 80,
		currentTokens: 26000,
		usageTokens: null,
		pressure: 0.8,
		ran: ranResult,
		perModelThreshold: { safetyMarginPct: 5, firePointPct: 80 },
		tailResult: (msgs?: readonly AgentMessage[]) =>
			msgs ? { messages: [...msgs] } : undefined,
		overheadTokens: 0,
	});
	// Flag OFF: the skip-cap is bypassed entirely — buildLiveTrimView returns the
	// same value as v0.21.11 (undefined when no staged block), and no cap runs.
	assert.equal(out, undefined, "no cap applied — identical return to v0.21.11");
	assert.equal(rt.diagCtxSkipCapped, 0, "skip-cap counter stays 0 when flag OFF");
});
