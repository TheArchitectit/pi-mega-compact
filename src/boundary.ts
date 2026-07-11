/**
 * boundary.ts — drop-boundary safety guards for the `context` hook.
 *
 * Two invariants the drop range must never violate (PREVENT-PI-001 / 002):
 *  1. ANCHOR FLOOR: never drop the most recent N user messages.
 *  2. TOOL-PAIR: never split an assistant(toolCall) from its following
 *     tool-result message — an orphaned `tool` role with no preceding
 *     assistant tool call causes a 400 on the OpenAI-compat path.
 *
 * The engine reasons over EngineMessage; the pi adapter maps role "tool" +
 * toolName to the tool-result shape.
 */

import type { EngineMessage } from "./types.js";

/** Is this message a tool result (pi `tool` role with a tool name)? */
function isToolResult(m: EngineMessage): boolean {
  return m.role === "tool" && Boolean(m.toolName);
}

/** Does this assistant/tool message contain a tool call (toolName set)? */
function hasToolUse(m: EngineMessage): boolean {
  return Boolean(m.toolName) && m.role !== "tool";
}

/**
 * Compute the safe drop range [dropStart, dropEnd) within `messages`.
 * `keepFrom` is the caller's desired first-preserved index. We then:
 *  1. Walk it back (lower dropEnd = keep more) so the first preserved message
 *     is never an orphaned tool result (tool-pair invariant).
 *  2. Raise it (lower dropEnd) to the anchor floor so the last N user messages
 *     are never dropped, when enough user messages exist.
 *
 * dropEnd is the first index KEPT. Returns [dropStart, dropEnd]; empty range
 * if nothing should be dropped.
 */
export function computeDropRange(
  messages: EngineMessage[],
  keepFrom: number,
  anchorUserMessages: number,
): [number, number] {
  if (keepFrom <= 0 || keepFrom >= messages.length) return [0, 0];

  const userIndexes: number[] = [];
  messages.forEach((m, i) => { if (m.role === "user") userIndexes.push(i); });
  const anchorActive = anchorUserMessages > 0 && userIndexes.length >= anchorUserMessages;
  const anchorStart = anchorActive ? userIndexes[userIndexes.length - anchorUserMessages] : 0;
  const floor = anchorActive ? anchorStart : 0;

  // Walk back for the tool-pair invariant (keep more when needed).
  let k = keepFrom;
  while (k > floor) {
    const firstPreserved = messages[k];
    if (!firstPreserved || !isToolResult(firstPreserved)) break;
    const preceding = messages[k - 1];
    if (preceding && hasToolUse(preceding)) {
      k -= 1; // pair intact across boundary — include the assistant turn
      break;
    }
    k -= 1;
  }
  if (k < floor) k = floor;

  // Anchor floor: never drop a must-keep user message. Raise dropEnd so we keep
  // from anchorStart onward when the walk didn't already.
  if (anchorActive && k > anchorStart) k = anchorStart;

  if (k <= 0) return [0, 0];
  return [0, k];
}

/**
 * Validate that the intended split at `keepFrom` (drop [0, keepFrom), keep the
 * rest) does not start the preserved run on an orphaned tool result. Checks
 * messages[keepFrom] against messages[keepFrom-1] directly — independent of the
 * walk-back that computeDropRange may apply.
 */
export function isBoundarySafe(messages: EngineMessage[], keepFrom: number): boolean {
  if (keepFrom <= 0 || keepFrom >= messages.length) return true;
  const firstPreserved = messages[keepFrom];
  if (!isToolResult(firstPreserved)) return true;
  const preceding = messages[keepFrom - 1];
  return Boolean(preceding && hasToolUse(preceding));
}

/**
 * Drop everything before the safe keep-index, honoring both guards, returning
 * the filtered message list.
 */
export function dropBefore(messages: EngineMessage[], keepFrom: number, anchorUserMessages: number): EngineMessage[] {
  const [dropStart, dropEnd] = computeDropRange(messages, keepFrom, anchorUserMessages);
  if (dropStart === dropEnd) return messages;
  return messages.slice(dropEnd);
}
