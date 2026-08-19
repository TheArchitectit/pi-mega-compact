/**
 * compact-summary.ts — summary tag helpers, formatting, and merging (Layer 2).
 *
 * Extracted from compact.ts (delegate-shell split, Phase D follow-up) so
 * compact.ts stays under the 300-line soft limit without squeezing. These
 * functions form a cohesive unit: they all operate on the `<summary>…</summary>`
 * tag block produced by the COLLAPSE output and consumed by the continuation
 * message builder. Kept pi-agnostic (only `EngineMessage` type imported).
 */
import type { EngineMessage } from "./types.js";

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function summarizeBlock(m: EngineMessage): string {
	if (m.role === "tool")
		return `tool_result ${m.toolName ?? "?"}: ${truncate(m.output ?? m.text, 160)}`;
	if (m.toolName)
		return `tool_use ${m.toolName}(${truncate(m.input ?? "", 160)})`;
	return truncate(m.text, 160);
}

function stripTag(block: string, tag: string): string {
	const start = `<${tag}>`;
	const end = `</${tag}>`;
	const s = block.indexOf(start);
	const e = block.indexOf(end);
	if (s === -1 || e === -1) return block;
	return block.slice(0, s) + block.slice(e + end.length);
}

function extractTag(block: string, tag: string): string | undefined {
	const s = block.indexOf(`<${tag}>`);
	const e = block.indexOf(`</${tag}>`);
	if (s === -1 || e === -1) return undefined;
	return block.slice(s + `<${tag}>`.length, e);
}

/** Normalize a raw summary into user-facing "Summary: ..." text. */
export function formatCompactSummary(summary: string): string {
	const withoutAnalysis = stripTag(summary, "analysis");
	let formatted = withoutAnalysis;
	const content = extractTag(withoutAnalysis, "summary");
	if (content !== undefined) {
		formatted = withoutAnalysis.replace(
			`<summary>${content}</summary>`,
			`Summary:\n${content.trim()}`,
		);
	}
	return formatted.replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract the prior "highlights" + "timeline" sections from an existing summary. */
export function extractSummaryHighlights(summary: string): string[] {
	const lines = formatCompactSummary(summary).split("\n");
	const out: string[] = [];
	let inTimeline = false;
	for (const line of lines) {
		const t = line.trimEnd();
		if (!t || t === "Summary:" || t === "Conversation summary:") continue;
		if (t === "- Key timeline:") {
			inTimeline = true;
			continue;
		}
		if (inTimeline) continue;
		out.push(t);
	}
	return out;
}

export function extractSummaryTimeline(summary: string): string[] {
	const lines = formatCompactSummary(summary).split("\n");
	const out: string[] = [];
	let inTimeline = false;
	for (const line of lines) {
		const t = line.trimEnd();
		if (t === "- Key timeline:") {
			inTimeline = true;
			continue;
		}
		if (!inTimeline) continue;
		if (!t) break;
		out.push(t);
	}
	return out;
}

/** Merge an existing compact summary with a new one (accumulate, don't overwrite). */
export function mergeCompactSummaries(
	existing: string | undefined,
	newSummary: string,
): string {
	if (!existing) return newSummary;
	const prevHighlights = extractSummaryHighlights(existing);
	const newHighlights = extractSummaryHighlights(
		formatCompactSummary(newSummary),
	);
	const newTimeline = extractSummaryTimeline(formatCompactSummary(newSummary));

	const lines = ["<summary>", "Conversation summary:"];
	if (prevHighlights.length) {
		lines.push("- Previously compacted context:");
		prevHighlights.forEach((l) => lines.push(`  ${l}`));
	}
	if (newHighlights.length) {
		lines.push("- Newly compacted context:");
		newHighlights.forEach((l) => lines.push(`  ${l}`));
	}
	if (newTimeline.length) {
		lines.push("- Key timeline:");
		newTimeline.forEach((l) => lines.push(`  ${l}`));
	}
	lines.push("</summary>");
	return lines.join("\n");
}

// Private helpers re-exported for the shell's summarizeMessages (which stays
// in compact.ts because it depends on the inference helpers there).
export { truncate, summarizeBlock };
