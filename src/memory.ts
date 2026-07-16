/**
 * memory.ts — auto-review + consolidation + recall-merge for the memories
 * table (S20/S21). Local, hallucination-guarded. No LLM by default (extractive
 * from the conversation); optional localhost Ollama mirroring RAPTOR. The review
 * runs every N turns and emits add/replace/remove ops.
 * PREVENT-PI-004: local only.
 */
import type { EngineMessage } from "./types.js";
import { collectRecentUserRequests } from "./compact.js";

export type MemoryOp =
  | { op: "add"; memory: { content: string; category: string; target?: string; sourceTurn: number } }
  | { op: "replace"; targetContent: string; memory: { content: string; category: string; sourceTurn: number } }
  | { op: "remove"; content: string };

const DECISION_PATTERNS = [
  /\bwe (?:use|chose|decided|will use|standardized on|go with)\b/i,
  /\b(?:the|our) (?:threshold|policy|rule|convention|default) is\b/i,
  /\bactually\b/i, /\braise (?:the )?|lower (?:the )?|switch (?:to )?\b/i,
];

/** Heuristic, extractive review. No LLM. Downgrades un-grounded claims to none. */
export function reviewConversation(messages: EngineMessage[], existing: { content: string }[] = []): MemoryOp[] {
  const ops: MemoryOp[] = [];
  const requests = collectRecentUserRequests(messages, 20);
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const isDecision = DECISION_PATTERNS.some((p) => p.test(r));
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
  // Guardrail: drop any op whose memory content isn't grounded in a real message.
  return ops.filter((o) => messages.some((m) => String(m.text ?? "").includes(o.op === "remove" ? o.content : o.memory.content)));
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
