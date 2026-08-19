/**
 * compact.ts — the COLLAPSE/summarize engine (Layer 2) + the compaction gate.
 *
 * Ported (conceptually) from claw-code rusty-claude-cli compact.rs
 * (summarize_messages / merge_compact_summaries / format_compact_summary) and
 * from memory-mcp session_context.py auto_compact_check / should_compact.
 * Pure, pi-agnostic, deterministic, no LLM required.
 */

import type { EngineMessage } from "./types.js";
import { estimateSessionTokens } from "./tokens.js";
// Summary tag/format/merge helpers live in the compact-summary sibling (delegate-
// shell split, Phase D follow-up) so this file stays under the 300-line soft
// limit. truncate + summarizeBlock are re-imported here because summarizeMessages
// (kept below) depends on them alongside the inference helpers that stay here.
import {
	truncate,
	summarizeBlock,
	formatCompactSummary,
} from "./compact-summary.js";
// Re-export the public summary API so external consumers importing from
// `../compact.js` are unchanged by the split.
export { formatCompactSummary, mergeCompactSummaries } from "./compact-summary.js";

const INTERESTING_EXT = new Set(["rs", "ts", "tsx", "js", "json", "md"]);
const PENDING_WORDS = ["todo", "next", "pending", "follow up", "remaining"];

const COMPACT_PREAMBLE =
	"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const RECENT_NOTE = "Recent messages are preserved verbatim.";
const DIRECT_RESUME =
	"Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

function firstText(m: EngineMessage): string | undefined {
	// PREVENT crash: pi can hand us a message with text: undefined (pure
	// tool-call/tool-result). Guard the trim so the legacy summarizeMessages
	// path can't throw the same undefined-text crash the extractive path did.
	const raw = m.text ?? "";
	const t = raw.trim();
	return t.length > 0 ? t : undefined;
}

/** Heuristic: does this text look like chatty filler we can collapse? */
export function isChatty(text: string): boolean {
	const low = text.toLowerCase();
	if (/\b(hello|thanks|great|ok)\b/i.test(low)) {
		return true;
	}
	return text.length < 40 && !/(\/|\.|\{|import |def |function )/.test(text);
}

/** Extract plausible file paths (contain '/' + an interesting extension).
 * Defensive against a missing/empty payload: pi's adapter can hand the engine
 * a message whose `text`/`input`/`output` is undefined (e.g. a pure tool-call
 * or tool-result message), and `.split` on undefined throws and takes down the
 * whole compaction. Guard once at the source so every caller is safe. */
export function extractFileCandidates(
	content: string | undefined | null,
): string[] {
	if (!content) return [];
	const out: string[] = [];
	for (const raw of content.split(/\s+/)) {
		// Trim surrounding punctuation only — do NOT strip internal dots, or we
		// would erase the extension separator (src/server.ts -> src/server/ts).
		const token = raw.replace(/^[^A-Za-z0-9/]+|[^A-Za-z0-9/]+$/g, "");
		if (!token.includes("/") || !token.includes(".")) continue;
		const ext = token.split(".").pop()?.toLowerCase() ?? "";
		if (INTERESTING_EXT.has(ext)) out.push(token);
	}
	return out;
}

/** Collect unique key files referenced across a set of messages. */
export function collectKeyFiles(messages: EngineMessage[]): string[] {
	const files = new Set<string>();
	for (const m of messages) {
		for (const c of [m.text, m.input, m.output]) {
			if (!c) continue;
			for (const f of extractFileCandidates(c)) files.add(f);
		}
	}
	return [...files].slice(0, 8);
}

/** Infer pending work from recent messages via keyword scan. */
export function inferPendingWork(messages: EngineMessage[]): string[] {
	const out: string[] = [];
	for (const m of [...messages].reverse()) {
		const t = firstText(m);
		if (!t) continue;
		const low = t.toLowerCase();
		if (PENDING_WORDS.some((w) => low.includes(w))) {
			out.push(truncate(t, 160));
			if (out.length >= 3) break;
		}
	}
	return out.reverse();
}

/** Latest user request (for "current work" line). */
export function inferCurrentWork(
	messages: EngineMessage[],
): string | undefined {
	for (const m of [...messages].reverse()) {
		const t = firstText(m);
		if (t && m.role === "user") return truncate(t, 200);
	}
	return undefined;
}

/** Last N user requests, in original order. */
export function collectRecentUserRequests(
	messages: EngineMessage[],
	limit: number,
): string[] {
	const reqs = messages
		.filter((m) => m.role === "user")
		.map((m) => firstText(m))
		.filter((t): t is string => Boolean(t))
		.map((t) => truncate(t, 160));
	return reqs.slice(-limit);
}

/**
 * Build a <summary> block from a slice of messages (the COLLAPSE output).
 * Mirrors claw-code summarize_messages.
 */
export function summarizeMessages(messages: EngineMessage[]): string {
	const users = messages.filter((m) => m.role === "user").length;
	const assistants = messages.filter((m) => m.role === "assistant").length;
	const tools = messages.filter((m) => m.role === "tool").length;

	const toolNames = [
		...new Set(messages.flatMap((m) => (m.toolName ? [m.toolName] : []))),
	].sort();

	const lines: string[] = [
		"<summary>",
		"Conversation summary:",
		`- Scope: ${messages.length} earlier messages compacted (user=${users}, assistant=${assistants}, tool=${tools}).`,
	];
	if (toolNames.length)
		lines.push(`- Tools mentioned: ${toolNames.join(", ")}.`);

	const recent = collectRecentUserRequests(messages, 3);
	if (recent.length) {
		lines.push("- Recent user requests:");
		recent.forEach((r) => lines.push(`  - ${r}`));
	}

	const pending = inferPendingWork(messages);
	if (pending.length) {
		lines.push("- Pending work:");
		pending.forEach((p) => lines.push(`  - ${p}`));
	}

	const files = collectKeyFiles(messages);
	if (files.length) lines.push(`- Key files referenced: ${files.join(", ")}.`);

	const current = inferCurrentWork(messages);
	if (current) lines.push(`- Current work: ${current}`);

	lines.push("- Key timeline:");
	for (const m of messages) {
		const role = m.role;
		lines.push(`  - ${role}: ${summarizeBlock(m)}`);
	}
	lines.push("</summary>");
	return lines.join("\n");
}

/** True when the compactable portion exceeds the budget. */
export function shouldCompact(
	messages: EngineMessage[],
	maxEstimatedTokens: number,
	preserveRecent: number,
): boolean {
	if (messages.length <= preserveRecent) return false;
	const compactable = messages.slice(0, messages.length - preserveRecent);
	return estimateSessionTokens(compactable) >= maxEstimatedTokens;
}

/** Local reimplementation of memory-mcp auto_compact_check.
 *
 * `threshold` is REQUIRED (no default) — every caller (gateCheck.ts) passes the
 * resolved `gateThreshold` (effectiveThresholdImpl: `tierPct × window`, or the
 * custom absolute). A bare default here would silently re-introduce a hardcoded
 * magic-number gate that bypasses the percent-based fire point. */
export function autoCompactCheck(
	currentTokens: number,
	threshold: number,
): {
	shouldCompact: boolean;
	currentTokens: number;
	threshold: number;
	utilizationPct: number;
} {
	return {
		shouldCompact: currentTokens >= threshold,
		currentTokens,
		threshold,
		utilizationPct: Math.round((currentTokens / threshold) * 1000) / 10,
	};
}

/** Build the synthetic continuation message (system-prompt prepend form). */
export function getContinuationMessage(
	summary: string,
	suppressFollowUp: boolean,
	recentPreserved: boolean,
): string {
	let base = COMPACT_PREAMBLE + formatCompactSummary(summary);
	if (recentPreserved) base += `\n\n${RECENT_NOTE}`;
	if (suppressFollowUp) base += `\n${DIRECT_RESUME}`;
	return base;
}
