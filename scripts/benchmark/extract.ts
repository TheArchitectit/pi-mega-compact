/**
 * extract.ts — shared fact extractor (applied symmetrically to ALL compactors).
 *
 * Two entry points, one output type:
 *   extractFromTranscript(messages) → Facts   — ground truth from raw transcript
 *   extractFromBrief(text)          → Facts   — parses any compactor's output
 *
 * "Both sides use the same parser" (pi-vcc §3.1).
 */

import type { BenchmarkMessage } from "./corpus.js";
import { commandFact, type Facts, buildFacts, type CommandFact, type ToolFact } from "./facts.js";

// ── Transcript → Facts (ground truth) ────────────────────────────────────────

interface TranscriptResult {
	facts: Facts;
	messageCount: number;
	totalChars: number;
}

export const extractFromTranscript = (messages: BenchmarkMessage[]): TranscriptResult => {
	const filesModified = new Set<string>();
	const filesRead = new Set<string>();
	const commits = new Set<string>();
	const commandFacts: CommandFact[] = [];
	const toolFacts: ToolFact[] = [];
	let totalChars = 0;

	for (const m of messages) {
		totalChars += m.text.length;

		if (m.role === "tool") {
			const toolName = m.toolName ?? "";
			const fn = EDIT_TOOL_RE.test(toolName) ? "edit" : READ_TOOL_RE.test(toolName) ? "read" : null;
			if (fn) toolFacts.push({ key: toolName, family: fn });
			const filePaths = filePathsFromOutput(m.text);
			if (fn === "edit") filePaths.forEach((p) => filesModified.add(p));
			else filePaths.forEach((p) => filesRead.add(p));
		}

		if (m.role === "assistant") {
			const cf = extractCommandsFromText(m.text);
			commandFacts.push(...cf);

			// Check for commit hashes in assistant messages
			const commitHashes = m.text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
			if (/commit|committed|merged/i.test(m.text)) {
				commitHashes.forEach((h) => commits.add(h.slice(0, 10)));
			}
		}

		// Also look in system / user messages for git commit output
		if (m.role === "user" || m.role === "custom") {
			const commitMatches = m.text.match(/\[[\w -]+\s+[0-9a-f]{7,10}\]/g);
			if (commitMatches) {
				for (const cm of commitMatches) {
					const h = cm.match(/[0-9a-f]{7,10}/)?.[0];
					if (h) commits.add(h.slice(0, 10));
				}
			}
		}
	}

	// Extract file paths from edit/write tool calls
	for (const t of toolFacts) {
		if (t.family === "edit") filesModified.add(t.key);
	}

	return {
		facts: buildFacts({ filesModified, filesRead, commits, commandFacts, toolFacts }),
		messageCount: messages.length,
		totalChars,
	};
};

// ── Brief text → Facts (shared parser for all compactors) ────────────────────

export const extractFromBrief = (text: string): Facts => {
	const filesModified = new Set<string>();
	const filesRead = new Set<string>();
	const commits = new Set<string>();
	const commandFacts: CommandFact[] = [];
	const toolFacts: ToolFact[] = [];

	// File paths: look for obvious paths (files with extensions)
	const paths =
		text.match(
			/[\w/.@_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|sh|yml|yaml|toml|sql|py|go|rs|yaml|txt|env|lock|test|spec)\b/gi,
		) ?? [];
	const uniquePaths = new Set(paths);
	// Distinguish modified vs read by context
	for (const p of uniquePaths) {
		const ctx = text.slice(Math.max(0, text.indexOf(p) - 80), text.indexOf(p) + 80);
		if (/\b(?:edit(?:ed)?|wrote|write|creat(?:ed|ing)|updat(?:ed|ing)|modif(?:ied|y))\b/i.test(ctx)) {
			filesModified.add(p);
		} else {
			filesRead.add(p);
		}
	}

	// Commands: split lines, run through the same normalizer
	const lines = text.split("\n");
	for (const line of lines) {
		const cmdMatch = line.match(/^[>-]?\s*(?:`\$?\s*)?([a-z][\w.-]*(?:\s+.{2,})?)/i);
		if (cmdMatch) {
			const cmd = cmdMatch[1];
			const cf = commandFact(cmd, /\b(?:fail|error|❌|✗|FAILED)\b/i.test(line));
			if (cf) commandFacts.push(cf);
		}
	}

	// Commits: 7+ hex chars near commit context
	const commitHashes = text.match(/\b[0-9a-f]{7,10}\b/g) ?? [];
	const commitLine = /commit|committed|merged|merge commit|feat\(|fix\(/i;
	for (const h of commitHashes) {
		const ctx = text.slice(Math.max(0, text.indexOf(h) - 40), text.indexOf(h) + 40);
		if (commitLine.test(ctx)) commits.add(h);
	}

	// Tools: look for tool mentions
	const toolMentions =
		text.match(
			/\b(edit|write|multiedit|quick_edit|target_edit|apply_patch|str_replace|create_file|read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show|view|cat|head|tail)\b/gi,
		) ?? [];
	for (const t of new Set(toolMentions)) {
		const family = EDIT_TOOL_RE.test(t) ? "edit" : READ_TOOL_RE.test(t) ? "read" : null;
		if (family) toolFacts.push({ key: t.toLowerCase(), family });
	}

	return buildFacts({ filesModified, filesRead, commits, commandFacts, toolFacts });
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch|str_replace|create_file)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show|view|cat|head|tail)$/i;

function filePathsFromOutput(text: string): string[] {
	return (
		text.match(
			/[\w/.@_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|sh|yml|yaml|toml|sql|py|go|rs|env|lock|test|spec)\b/gi,
		) ?? []
	);
}

function extractCommandsFromText(text: string): CommandFact[] {
	const results: CommandFact[] = [];
	const cmdLines = text.match(/^[\s>]*(?:`\$?\s*)?[a-z][\w.-]*(?:\s+.{2,})?$/gim) ?? [];
	for (const line of cmdLines) {
		const clean = line.replace(/^[\s>`]*\$?\s*/, "").trim();
		if (!clean) continue;
		const cf = commandFact(clean, /\b(?:fail|error|❌|✗|FAILED)\b/i.test(line));
		if (cf) results.push(cf);
	}
	return results;
}
