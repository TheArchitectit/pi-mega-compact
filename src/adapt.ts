/**
 * adapt.ts — the adapter between pi's runtime message types and the engine's
 * pi-agnostic `EngineMessage` shape.
 *
 * The engine (src/compact.ts, supersede.ts, boundary.ts, vectorStore.ts) only
 * ever reasons about EngineMessage, so it stays unit-testable without a pi
 * runtime. This module is the single conversion boundary. The conversion is
 * 1:1 and index-aligned: every output EngineMessage corresponds to exactly one
 * input AgentMessage at the same index, which lets the extension apply
 * drop-range indices computed on the engine view straight back onto the real
 * message array.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { EngineMessage } from "./types.js";
import { computeDropRange } from "./boundary.js";

/** Coarse role the engine cares about. */
export type EngineRole = "user" | "assistant" | "tool" | "custom";

/** Map a pi AgentMessage role to the engine's coarse role. */
export function messageRole(m: AgentMessage): EngineRole {
  if (m.role === "toolResult") return "tool";
  if (m.role === "user" || m.role === "assistant") return m.role;
  // custom / bashExecution / branchSummary / compactionSummary — all non-LLM
  // bookkeeping as far as the engine is concerned.
  return "custom";
}

/** Extract a tool name from a message, if it carries a tool call/result. */
export function messageToolName(m: AgentMessage): string | undefined {
  if (m.role === "toolResult") return m.toolName;
  if (m.role === "assistant") {
    const tc = (m.content as Array<{ type: string; name?: string }>).find(
      (c) => c.type === "toolCall",
    );
    return tc?.name;
  }
  return undefined;
}

/** Pull the text out of a string-or-blocks content field. */
function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  // PREVENT crash: pi blocks can arrive with `text: undefined` or a missing
  // `content` field (tool/custom messages). Coerce to a string at the single
  // choke point so every downstream `.matchAll`/`.split`/`.toLowerCase` is safe
  // (extractive.ts, compact.ts, supersede.ts, summarizer.ts, boundary.ts).
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** Project any AgentMessage into a single text blob the engine can reason on. */
function messageText(m: AgentMessage): string {
  let out: string;
  switch (m.role) {
    case "toolResult":
    case "user":
    case "assistant":
    case "custom":
      out = contentText((m as { content: string | Array<{ type: string; text?: string }> }).content);
      break;
    case "bashExecution":
      out = `${(m as { command: string }).command ?? ""}\n${(m as { output: string }).output ?? ""}`;
      break;
    case "branchSummary":
    case "compactionSummary":
      out = (m as { summary: string }).summary ?? "";
      break;
    default:
      out = "";
      break;
  }
  // PREVENT crash: final safety net — never let `undefined`/`null` escape the
  // adapter into the engine, which assumes `text: string` everywhere.
  return out ?? "";
}

/**
 * Convert a pi message array into the engine's EngineMessage view, keeping
 * index alignment (output[i] corresponds to input[i]).
 */
export function toEngineMessages(messages: AgentMessage[]): EngineMessage[] {
  return messages.map((m) => {
    const role = messageRole(m);
    const toolName = messageToolName(m);
    const text = messageText(m);
    if (m.role === "toolResult") {
      return { role, text, toolName, output: text } satisfies EngineMessage;
    }
    if (m.role === "assistant") {
      const blocks = m.content as Array<{ type: string; text?: string; arguments?: unknown }>;
      const callBlock = blocks.find((c) => c.type === "toolCall");
      const input = callBlock
        ? typeof callBlock.arguments === "string"
          ? callBlock.arguments
          : JSON.stringify(callBlock.arguments ?? {})
        : undefined;
      return { role, text, toolName, input } satisfies EngineMessage;
    }
    return { role, text, toolName } satisfies EngineMessage;
  });
}

/**
 * Project session entries into the engine view. Reuses pi's own
 * sessionEntryToContextMessages so branching/compaction entries are resolved the
 * same way the runtime would.
 */
export function toEngineFromEntries(entries: SessionEntry[]): EngineMessage[] {
  return entries.flatMap((e) => toEngineMessages(sessionEntryToContextMessages(e)));
}

/**
 * Compute the safe drop range over a pi message array using the engine's
 * boundary guards (anchor floor + tool-pair), then return the surviving
 * messages. Reuses the tested `computeDropRange` on an engine view and maps the
 * indices back onto the original array (index alignment guarantees correctness).
 */
export function dropCompactedRange(
  messages: AgentMessage[],
  keepFrom: number,
  anchorUserMessages: number,
): AgentMessage[] {
  if (messages.length === 0) return messages;
  const view = toEngineMessages(messages);
  const [, dropEnd] = computeDropRange(view, keepFrom, anchorUserMessages);
  if (dropEnd <= 0) return messages;
  return messages.slice(dropEnd);
}
