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

const INTERESTING_EXT = new Set(["rs", "ts", "tsx", "js", "json", "md"]);
const PENDING_WORDS = ["todo", "next", "pending", "follow up", "remaining"];

const COMPACT_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const RECENT_NOTE = "Recent messages are preserved verbatim.";
const DIRECT_RESUME = "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function firstText(m: EngineMessage): string | undefined {
  const t = m.text.trim();
  return t.length > 0 ? t : undefined;
}

/** Heuristic: does this text look like chatty filler we can collapse? */
export function isChatty(text: string): boolean {
  const low = text.toLowerCase();
  if (low.includes("hello") || low.includes("thanks") || low.includes("great") || low.includes("ok")) {
    return true;
  }
  return text.length < 40 && !/(\/|\.|\{|import |def |function )/.test(text);
}

/** Extract plausible file paths (contain '/' + an interesting extension). */
export function extractFileCandidates(content: string): string[] {
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
export function inferCurrentWork(messages: EngineMessage[]): string | undefined {
  for (const m of [...messages].reverse()) {
    const t = firstText(m);
    if (t && m.role === "user") return truncate(t, 200);
  }
  return undefined;
}

/** Last N user requests, in original order. */
export function collectRecentUserRequests(messages: EngineMessage[], limit: number): string[] {
  const reqs = messages
    .filter((m) => m.role === "user")
    .map((m) => firstText(m))
    .filter((t): t is string => Boolean(t))
    .map((t) => truncate(t, 160));
  return reqs.slice(-limit);
}

/** Summarize a block to a one-line description. */
function summarizeBlock(m: EngineMessage): string {
  if (m.role === "tool") return `tool_result ${m.toolName ?? "?"}: ${truncate(m.output ?? m.text, 160)}`;
  if (m.toolName) return `tool_use ${m.toolName}(${truncate(m.input ?? "", 160)})`;
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

/**
 * Build a <summary> block from a slice of messages (the COLLAPSE output).
 * Mirrors claw-code summarize_messages.
 */
export function summarizeMessages(messages: EngineMessage[]): string {
  const users = messages.filter((m) => m.role === "user").length;
  const assistants = messages.filter((m) => m.role === "assistant").length;
  const tools = messages.filter((m) => m.role === "tool").length;

  const toolNames = [...new Set(messages.flatMap((m) => (m.toolName ? [m.toolName] : [])))].sort();

  const lines: string[] = [
    "<summary>",
    "Conversation summary:",
    `- Scope: ${messages.length} earlier messages compacted (user=${users}, assistant=${assistants}, tool=${tools}).`,
  ];
  if (toolNames.length) lines.push(`- Tools mentioned: ${toolNames.join(", ")}.`);

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

/** Extract the prior "highlights" + "timeline" sections from an existing summary. */
function extractSummaryHighlights(summary: string): string[] {
  const lines = formatCompactSummary(summary).split("\n");
  const out: string[] = [];
  let inTimeline = false;
  for (const line of lines) {
    const t = line.trimEnd();
    if (!t || t === "Summary:" || t === "Conversation summary:") continue;
    if (t === "- Key timeline:") { inTimeline = true; continue; }
    if (inTimeline) continue;
    out.push(t);
  }
  return out;
}

function extractSummaryTimeline(summary: string): string[] {
  const lines = formatCompactSummary(summary).split("\n");
  const out: string[] = [];
  let inTimeline = false;
  for (const line of lines) {
    const t = line.trimEnd();
    if (t === "- Key timeline:") { inTimeline = true; continue; }
    if (!inTimeline) continue;
    if (!t) break;
    out.push(t);
  }
  return out;
}

/** Merge an existing compact summary with a new one (accumulate, don't overwrite). */
export function mergeCompactSummaries(existing: string | undefined, newSummary: string): string {
  if (!existing) return newSummary;
  const prevHighlights = extractSummaryHighlights(existing);
  const newHighlights = extractSummaryHighlights(formatCompactSummary(newSummary));
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

/** True when the compactable portion exceeds the budget. */
export function shouldCompact(messages: EngineMessage[], maxEstimatedTokens: number, preserveRecent: number): boolean {
  if (messages.length <= preserveRecent) return false;
  const compactable = messages.slice(0, messages.length - preserveRecent);
  return estimateSessionTokens(compactable) >= maxEstimatedTokens;
}

/** Local reimplementation of memory-mcp auto_compact_check. */
export function autoCompactCheck(currentTokens: number, threshold = 50000): {
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
export function getContinuationMessage(summary: string, suppressFollowUp: boolean, recentPreserved: boolean): string {
  let base = COMPACT_PREAMBLE + formatCompactSummary(summary);
  if (recentPreserved) base += `\n\n${RECENT_NOTE}`;
  if (suppressFollowUp) base += `\n${DIRECT_RESUME}`;
  return base;
}
