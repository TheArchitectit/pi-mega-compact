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

// ---- Limits ----------------------------------------------------------------

const MAX_RECENT_USER = 3;
const MAX_DECISIONS = 5;
const MAX_FILES = 10;
const MAX_PENDING = 5;
const MAX_TOPIC_LINES = 12;

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
): string {
  const lines: string[] = [];

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

  // Key files
  if (keyFiles.length) lines.push(`Key files: ${keyFiles.join(", ")}.`);

  // Pending work
  if (pending.length) {
    lines.push("Pending work:");
    for (const p of pending) lines.push(`  • ${p}`);
  }

  // Cap total length
  return lines.slice(0, MAX_TOPIC_LINES).join("\n");
}

// ---- File path extraction --------------------------------------------------

const INTERESTING_EXT = new Set(["rs", "ts", "tsx", "js", "json", "md"]);
const FILE_PATH_RE = /(?:^|\s)([^\s"`']+\.(rs|ts|tsx|js|json|md|py|sh|sql|toml|yaml|yml|css|html))\b/g;

function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(FILE_PATH_RE)) {
    const filePath = m[1];
    const ext = m[2];
    const basename = filePath.split("/").pop() ?? filePath;
    if (basename === "node_modules" || filePath.includes("node_modules/")) continue;
    if (INTERESTING_EXT.has(ext)) paths.push(filePath);
  }
  return paths;
}

// ---- Recent user requests (existing logic, kept) ---------------------------

function collectRecentUserRequests(
  messages: EngineMessage[],
  limit: number,
): string[] {
  const requests: string[] = [];
  for (let i = messages.length - 1; i >= 0 && requests.length < limit; i--) {
    if (messages[i].role === "user") {
      let snippet = messages[i].text.split("\n").slice(0, 3).join(" ");
      snippet = snippet.replace(/^.+\nProcessed\$?\s*/i, "").replace(/\n/g, " ");
      requests.push(truncate(snippet, 200));
    }
  }
  return requests.reverse();
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
    const path = m.text.match(
      /(?:^|\s)([^\s"`':]+\.(rs|ts|tsx|js|json|md|py|toml|yaml|yml|sql))\b/m,
    );
    if (path) {
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

// ---- Files modified --------------------------------------------------------

function extractFilesModified(tools: EngineMessage[]): string[] {
  const files = new Set<string>();
  for (const m of tools) {
    if (!m.toolName) continue;
    const name = m.toolName.toLowerCase();
    if (name === "write" || name === "edit" || name === "notebookedit") {
      // Extract file path from input payload
      const input = m.input ?? m.text;
      const pathMatch = input.match(/["']?(\/[^\s"']+\.\w+)["']?/);
      if (pathMatch) files.add(pathMatch[1]);
    }
    if (name === "bash") {
      const cmd = m.input ?? m.text;
      if (cmd.includes("git add") || cmd.includes("git commit") || cmd.includes("git diff")) {
        for (const p of extractFilePaths(cmd)) files.add(p);
      }
    }
  }
  return [...files].slice(0, MAX_FILES);
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

  const toolMsgs = messages.filter((m) => m.role === "tool");
  const tools = [...new Set(messages.flatMap((m) => (m.toolName ? [m.toolName] : [])))].sort();

  const recentUser = collectRecentUserRequests(messages, MAX_RECENT_USER);
  const currentWork = inferCurrentWork(messages);
  const keyFiles = collectKeyFiles(messages);
  const pending = inferPendingWork(messages);
  const keyDecisions = extractDecisions(messages);
  const filesModified = extractFilesModified(toolMsgs);

  const topicSummary = buildTopicSummary(
    messages, tools, recentUser, currentWork, keyFiles, pending,
  );

  const tokenEstimate = estimateBlockTokens(topicSummary);

  return { topicSummary, keyDecisions, nextSteps: pending, filesModified, tokenEstimate };
}

// ---- Key files (existing logic from compact.ts, moved here) ----------------

const MAX_KEY_FILES = 5;
const FRESHNESS_WINDOW = 10;

function collectKeyFiles(messages: EngineMessage[]): string[] {
  const recent = messages.slice(-FRESHNESS_WINDOW);
  const pathFreq = new Map<string, number>();
  for (const m of recent) {
    for (const p of extractFilePaths(m.text)) {
      pathFreq.set(p, (pathFreq.get(p) ?? 0) + 1);
    }
  }
  return [...pathFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEY_FILES)
    .map(([p]) => p);
}
