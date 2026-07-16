/**
 * memory.ts — auto-review + consolidation + recall-merge for the memories
 * table (S20/S21). Local, hallucination-guarded. No LLM by default (extractive
 * from the conversation); optional localhost Ollama mirroring RAPTOR. The review
 * runs every N turns and emits add/replace/remove ops.
 * PREVENT-PI-004: local only.
 */
import type { EngineMessage } from "./types.js";
import { collectRecentUserRequests } from "./compact.js";
import { cosineSimilarity, defaultEmbedder } from "./embedder.js";
import { DedupConfig } from "./config/dedup.js";
import { listMemories, removeMemory, replaceMemory } from "./store/sqlite.js";
import { getStateDir } from "./store.js";
export type MemoryOp =
  | { op: "add"; memory: { content: string; category: string; target?: string; sourceTurn: number } }
  | { op: "replace"; targetContent: string; memory: { content: string; category: string; sourceTurn: number } }
  | { op: "remove"; content: string };

const DECISION_PATTERNS = [
  /\bwe (?:use|chose|decided|will use|standardized on|go with)\b/i,
  /\b(?:the|our) (?:threshold|policy|rule|convention|default) is\b/i,
  /\bactually\b/i, /\braise (?:the )?|lower (?:the )?|switch (?:to )?\b/i,
];

// Patterns that signal an explicit memory drop. Grounded only when the user
// references an existing memory's content (handled in reviewConversation).
const DROP_PATTERNS = [
  /\b(?:stop using|don't use|dont use|drop(?:ping)?|forget|remove from memory|no longer)\b/i,
];

/** Heuristic, extractive review. No LLM. Downgrades un-grounded claims to none. */
export function reviewConversation(messages: EngineMessage[], existing: { content: string }[] = []): MemoryOp[] {
  const ops: MemoryOp[] = [];
  const requests = collectRecentUserRequests(messages, 20);
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const isDecision = DECISION_PATTERNS.some((p) => p.test(r));
    const isDrop = DROP_PATTERNS.some((p) => p.test(r));
    // A "stop using/drop/forget" signal takes precedence over a decision — the
    // user asking to forget a memory supersedes any "switch to" phrasing it
    // happens to contain (which would otherwise route into REPLACE).
    if (isDrop && existing.some((e) => sharesTopic(e.content, r))) {
      const target = existing.find((e) => sharesTopic(e.content, r));
      if (target) ops.push({ op: "remove", content: target.content });
      continue;
    }
    if (isDrop) {
      // Drop pattern matched but no existing topic-overlapping memory — nothing
      // to remove. Don't fall through to the decision branch (the request might
      // also contain 'switch to' phrasing).
      continue;
    }
    if (!isDecision) continue;
    // Treat earlier in-conversation decisions as "existing" too, so later messages
    // that contradict them emit a REPLACE instead of an ADD.
    const inConvoExisting = requests.slice(0, i).map((r) => ({ content: r }));
    const contradicted = [...inConvoExisting, ...existing].find(
      (e) => sharesTopic(e.content, r) && differs(e.content, r),
    );
    if (contradicted) {
      ops.push({ op: "replace", targetContent: contradicted.content, memory: { content: r, category: "decision", sourceTurn: i } });
    } else if (!existing.some((e) => nearDup(e.content, r))) {
      ops.push({ op: "add", memory: { content: r, category: "decision", sourceTurn: i } });
    }
  }
  // Guardrail: drop any add/replace op whose memory content isn't grounded in a
  // real message (hallucination prevention). REMOVE ops are exempt — their
  // `content` is an EXISTING memory (matched by topic overlap), so it predates
  // the current conversation and won't appear verbatim in any message.
  return ops.filter((o) =>
    o.op === "remove"
      ? true
      : messages.some((m) => String(m.text ?? "").includes(o.memory.content)),
  );
}

function sharesTopic(a: string, b: string): boolean {
  const aw = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const bw = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let shared = 0; for (const w of bw) if (aw.has(w)) shared++;
  return shared >= 1;
}
function differs(a: string, b: string): boolean { return !nearDup(a, b); }
function nearDup(a: string, b: string): boolean {
  const aw = new Set(a.toLowerCase().split(/\W+/));
  const bw = new Set(b.toLowerCase().split(/\W+/));
  let shared = 0; for (const w of bw) if (aw.has(w)) shared++;
  return shared / Math.max(1, bw.size) >= 0.8;
}

/**
 * mergePhrases — for two near-duplicate texts (cosine >= threshold), build a
 * merged content string. If the loser's token set is mostly contained in the
 * survivor's, the survivor already covers the meaning and we keep it as-is.
 * Otherwise we append the loser's text as a new paragraph so no phrasing is
 * lost.
 */
function mergePhrases(survivor: string, loser: string): string {
  if (nearDup(survivor, loser)) return survivor;
  return `${survivor}\n\n${loser}`;
}

/**
 * consolidateMemories — merge near-duplicate rows in the `memories` table
 * (Sprint 21, Task S21.2). Pure local cosine over `defaultEmbedder`
 * embeddings (zero-net, deterministic, no LLM). Uses the consolidation
 * threshold `DedupConfig.CONSOLIDATE_COSINE` (default 0.7) — lower than the
 * off-line SemDeDup threshold (0.95) because drift between manually-typed
 * memories about the same topic is expected, and the goal is to clean it up
 * rather than be paranoid about over-merging. One row survives; redundant
 * rows are removed. Returns the number of merges performed.
 *
 * Algorithm:
 *   1. Load all memories for the repo (or all repos when repo is null).
 *   2. Embed their `content` field.
 *   3. For every pair, if cosine >= threshold AND same category → merge:
 *      survivor is the newest (largest id). Loser's content is appended as a
 *      paragraph to the survivor's content if it adds non-redundant phrasing,
 *      otherwise dropped. Loser's row is removed.
 *
 * PREVENT-PI-004: local-only embedding, no network.
 */
export async function consolidateMemories(
  stateDir: string = getStateDir(),
  repo: string | null = null,
  threshold: number = DedupConfig.CONSOLIDATE_COSINE,
): Promise<number> {
  const rows = listMemories(repo, 1000, stateDir);
  if (rows.length < 2) return 0;

  const emb = defaultEmbedder();
  const vectors = rows.map((r) => emb.embed(r.content));

  let merges = 0;
  // Iterate once per row. Older rows are processed first; the merge keeps the
  // newer (larger id), so we always merge away the older side.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id == null) continue; // safety: in case the row was removed mid-loop
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].id == null) continue;
      if (rows[i].category !== rows[j].category) continue; // different buckets: not a dup
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim < threshold) continue;

      // Pick survivor: largest id (most recently inserted / referenced wins).
      const survivorId = rows[i].id! > rows[j].id! ? rows[i].id! : rows[j].id!;
      const loserId = survivorId === rows[i].id! ? rows[j].id! : rows[i].id!;

      const survivor = survivorId === rows[i].id! ? rows[i] : rows[j];
      const loser = survivorId === rows[i].id! ? rows[j] : rows[i];

      // Merge content: keep survivor's content; if loser's content adds a
      // phrase (token overlap < 80% with survivor) append it as a paragraph.
      const mergedContent = mergePhrases(survivor.content, loser.content);
      replaceMemory(survivorId, { content: mergedContent }, stateDir);
      removeMemory(loserId, stateDir);

      // Mark the loser row in the surviving array so we skip it on later pairs.
      rows[loserId === rows[i].id! ? i : j] = { ...loser, id: undefined } as any;
      merges++;
    }
  }
  return merges;
}
