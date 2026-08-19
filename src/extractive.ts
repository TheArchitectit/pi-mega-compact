/**
 * extractive.ts — deterministic, LLM-free extractive summary engine.
 *
 * Replaces the "Key timeline" dump in compact.ts with structured extraction:
 * topicSummary (one paragraph), keyDecisions, nextSteps, filesModified.
 *
 * Target compression: 70K tokens → ~2K tokens (35:1).
 * Deterministic: same messages → same output, every time.
 */

import type { EngineMessage } from "./types.js";
import { estimateBlockTokens } from "./tokens.js";
import {
  CURRENT_WORK_PATH_RE,
  isInterestingPath,
  isPlaceholderRequest,
  isSkeletonSummary,
  buildSalvageDigest,
  collectKeyFiles,
  extractFilesModified,
} from "./extractive-salvage.js";

// ---- Limits ----------------------------------------------------------------

const MAX_RECENT_USER = 3;
const MAX_DECISIONS = 5;
const MAX_PENDING = 5;
const MAX_TOPIC_LINES = 12;
/** Cap for the merged keyFiles ∪ filesModified "Key files" line (A2a). */
const MAX_SUMMARY_FILES = 8;

// ---- Truncation helper -----------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

// ---- Turn brief (conversation arc) -----------------------------------------

export interface TurnBrief {
  role: string;
  action: string;
}

// ---- Full extracted summary ------------------------------------------------

export interface ExtractiveSummary {
  topicSummary: string;
  keyDecisions: string[];
  nextSteps: string[];
  filesModified: string[];
  tokenEstimate: number;
}

/**
 * Build a one-paragraph topic summary from the message slice.
 *
 * This is the compressed replacement for the raw "Key timeline" loop.
 * Captures: tools used, recent user requests, current work, key files,
 * pending work. Typically 12 lines / ~500 tokens instead of ~70K.
 */
function buildTopicSummary(
  messages: EngineMessage[],
  tools: string[],
  recentUser: string[],
  currentWork: string | undefined,
  keyFiles: string[],
  pending: string[],
  filesModified: string[],
  decisions: string[],
): string {
  const lines: string[] = [];

  // A2a: files captured from write/edit tool inputs are extracted
  // extension-agnostically but never reached the summary. Fold them in so work
  // outside the recency window (and outside the path regex) is still reported.
  // Drop an absolute path when a kept relative path already names the SAME file.
  // Only MULTI-COMPONENT relative paths fold ("engine/mesh.go" absorbs
  // "/proj/engine/mesh.go"); a bare basename ("mesh.go") is never folded into an
  // absolute path, since "/proj/other/x/mesh.go" may be a genuinely different
  // file (QA lens 1 finding: the naive endsWith dropped different directories).
  const combined = [...keyFiles, ...filesModified];
  const allFiles = [...new Set(combined)].filter((p) => {
    if (!p.startsWith("/")) return true;
    return !combined.some(
      (r) => r !== p && !r.startsWith("/") && r.includes("/") && p.endsWith("/" + r),
    );
  }).slice(0, MAX_SUMMARY_FILES);

  // Scope line
  const users = messages.filter((m) => m.role === "user");
  const assistants = messages.filter((m) => m.role === "assistant");
  const toolMsgs = messages.filter((m) => m.role === "tool");
  lines.push(
    `Conversation: ${messages.length} messages (${users.length} user, ` +
      `${assistants.length} assistant, ${toolMsgs.length} tool). ` +
      (tools.length ? `Tools: ${tools.join(", ")}.` : "No tools used."),
  );

  // Recent user requests
  if (recentUser.length) {
    lines.push("User requests:");
    for (const r of recentUser) lines.push(`  • ${r}`);
  }

  // Current work
  if (currentWork) lines.push(`Current work: ${currentWork}`);

  // Key files (keyFiles ∪ filesModified)
  if (allFiles.length) lines.push(`Key files: ${allFiles.join(", ")}.`);

  // Pending work
  if (pending.length) {
    lines.push("Pending work:");
    for (const p of pending) lines.push(`  • ${p}`);
  }

  // A2c: a scope-line-only summary carries zero information and strands a
  // resumed session. Salvage the tail of the conversation instead. The line cap
  // is raised ONLY here: the salvage block is bounded at 5 lines + 1 header, and
  // a skeleton by definition contributed just the 1 scope line, so the worst
  // case is 7 lines — still well under the normal 12-line budget.
  const skeleton = isSkeletonSummary({ recentUser, keyFiles: allFiles, currentWork, decisions, pending });
  if (skeleton) {
    const digest = buildSalvageDigest(messages);
    if (digest.length) {
      lines.push("Recent activity:");
      for (const d of digest) lines.push(`  • ${d}`);
    }
    return lines.join("\n");
  }

  // Cap total length
  return lines.slice(0, MAX_TOPIC_LINES).join("\n");
}

// ---- Recent user requests --------------------------------------------------

/**
 * A2b: skip content-free "resume"/"continue" turns and look further back to
 * fill the quota, so a resumed session surfaces its real requests. Falls back
 * to the placeholders when EVERY user turn is one (an honest "• resume" beats
 * an empty section).
 */
function collectRecentUserRequests(
  messages: EngineMessage[],
  limit: number,
): string[] {
  const substantive: string[] = [];
  const placeholders: string[] = [];
  for (let i = messages.length - 1; i >= 0 && substantive.length < limit; i--) {
    if (messages[i].role !== "user") continue;
    let snippet = messages[i].text.split("\n").slice(0, 3).join(" ");
    snippet = snippet.replace(/^.+\nProcessed\$?\s*/i, "").replace(/\n/g, " ");
    const cleaned = truncate(snippet, 200);
    if (!cleaned.trim()) continue;
    if (isPlaceholderRequest(cleaned)) {
      if (placeholders.length < limit) placeholders.push(cleaned);
      continue;
    }
    substantive.push(cleaned);
  }
  return (substantive.length ? substantive : placeholders).reverse();
}

// ---- Pending work (existing logic, kept) -----------------------------------

const PENDING_WORDS = ["todo", "next", "pending", "follow up", "remaining"];

function inferPendingWork(messages: EngineMessage[]): string[] {
  const pending: string[] = [];
  const recent = messages.slice(-5);
  for (const m of recent) {
    const t = m.text.toLowerCase();
    if (PENDING_WORDS.some((w) => t.includes(w))) {
      const snippet = m.text.split("\n").find((l) => PENDING_WORDS.some((w) => l.toLowerCase().includes(w)));
      if (snippet) pending.push(truncate(snippet.trim(), 180));
    }
  }
  return [...new Set(pending)].slice(0, MAX_PENDING);
}

// ---- Current work (existing logic, kept) -----------------------------------

function inferCurrentWork(messages: EngineMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    // A1: same language-agnostic policy as extractFilePaths.
    const path = m.text.match(CURRENT_WORK_PATH_RE);
    if (path && isInterestingPath(path[1], path[2])) {
      const line = m.text.split("\n").slice(0, 2).join(" ");
      return truncate(line, 200);
    }
  }
  return undefined;
}

// ---- Key decisions ---------------------------------------------------------

const DECISION_PATTERNS = [
  /(?:I('ll| will| decided to| chose to| recommend| suggest))\s+(.{10,120})/i,
  /(?:let's|we('ll| should| can| will))\s+(.{10,120})/i,
  /(?:the (?:plan|approach|decision|strategy) is (?:to )?)\s*(.{10,120})/i,
  /(?:going (?:with|forward))\s+(.{10,120})/i,
];

function extractDecisions(messages: EngineMessage[]): string[] {
  const decisions: string[] = [];
  // Only look at assistant messages (they make/receive decisions)
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = m.text;
    if (!text || text.length < 20) continue;
    for (const pat of DECISION_PATTERNS) {
      const match = text.match(pat);
      if (match) {
        const decision = match[2]?.trim();
        if (decision && decision.length > 10) {
          decisions.push(truncate(decision, 150));
        }
      }
    }
    if (decisions.length >= MAX_DECISIONS) break;
  }
  return [...new Set(decisions)];
}

// ---- Public API ------------------------------------------------------------

/**
 * Deterministic extractive summary. Same messages → same output, every time.
 *
 * Returns structured data + a pre-formatted topicSummary string.
 * Compression target: 70K tokens → ~2K tokens.
 */
export function extractiveSummarize(messages: EngineMessage[]): ExtractiveSummary {
  if (messages.length === 0) {
    return { topicSummary: "(empty)", keyDecisions: [], nextSteps: [], filesModified: [], tokenEstimate: 0 };
  }

  // PREVENT crash: tool/custom messages can arrive with `text: undefined` when
  // only `input`/`output` is set (the type says string, but pi's runtime does
  // not always fill it). Coerce to "" once at the entry so every downstream
  // `.text` / `.matchAll` / `.split` access is safe.
  const safe = messages.map((m) => ({ ...m, text: m.text ?? "" }));

  const toolMsgs = safe.filter((m) => m.role === "tool");
  const tools = [...new Set(messages.flatMap((m) => (m.toolName ? [m.toolName] : [])))].sort();

  const recentUser = collectRecentUserRequests(safe, MAX_RECENT_USER);
  const currentWork = inferCurrentWork(safe);
  const keyFiles = collectKeyFiles(safe);
  const pending = inferPendingWork(safe);
  const keyDecisions = extractDecisions(safe);
  const filesModified = extractFilesModified(toolMsgs);

  const topicSummary = buildTopicSummary(
    safe, tools, recentUser, currentWork, keyFiles, pending, filesModified, keyDecisions,
  );

  const tokenEstimate = estimateBlockTokens(topicSummary);

  return { topicSummary, keyDecisions, nextSteps: pending, filesModified, tokenEstimate };
}
