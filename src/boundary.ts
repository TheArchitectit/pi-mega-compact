/**
 * boundary.ts — drop-boundary safety guards for the `context` hook.
 *
 * Two invariants the drop range must never violate (PREVENT-PI-001 / 002):
 *  1. ANCHOR FLOOR: never drop the most recent N user messages.
 *  2. TOOL-PAIR: never split an assistant(toolCall) from its following
 *     tool-result message — an orphaned `tool` role with no preceding
 *     assistant tool call causes a 400 on the OpenAI-compat path. The pair
 *     invariant outranks the anchor floor: on conflict we drop LESS (lower the
 *     drop end), never cross a pair.
 *
 * The engine reasons over EngineMessage; the pi adapter maps role "tool" +
 * toolName to the tool-result shape. EngineMessage carries no tool-call id, so
 * ownership is positional: a tool result's owner is its nearest preceding
 * assistant tool-call (the last assistant message with a `toolName` before it).
 * A preserved tool result is orphaned by a cut when its owner is dropped; the
 * guard rejects any cut that drops an owner while preserving its result, for
 * ARBITRARY interleavings (custom/non-tool messages between call and result,
 * consecutive results sharing one call, a cut landing directly on a call whose
 * results follow).
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
 * Is the drop boundary at `dropEnd` pair-safe? The preserved run is
 * [dropEnd, messages.length). The cut is pair-safe iff NO preserved tool result
 * is orphaned: for every tool result at index >= dropEnd, its nearest preceding
 * assistant tool-call must EXIST and be PRESERVED (index >= dropEnd). A tool
 * result with no preceding assistant tool-call is already orphaned in the
 * input — we treat that as unsafe too, so the guard never endorses shipping an
 * orphaned result to the provider.
 *
 * O(messages.length) single forward pass; early-exits on the first orphan. The
 * owner of each result is the most recent `hasToolUse` message seen so far
 * (tracked across the whole stream, including dropped messages, because a
 * dropped assistant tool-call is exactly the owner we must reject).
 */
export function isPairSafe(messages: EngineMessage[], dropEnd: number): boolean {
  if (dropEnd <= 0 || dropEnd >= messages.length) return true;
  let lastToolCall = -1;
  for (let i = 0; i < messages.length; i++) {
    if (hasToolUse(messages[i])) lastToolCall = i;
    if (i >= dropEnd && isToolResult(messages[i])) {
      if (lastToolCall === -1) return false; // no preceding call → orphaned
      if (lastToolCall < dropEnd) return false; // owner dropped → orphaned
    }
  }
  return true;
}

/**
 * Compute the safe drop range [dropStart, dropEnd) within `messages`.
 *
 * Contract:
 *  - `keepFrom` is the caller's desired first-preserved index (drop [0, keepFrom)).
 *  - `dropEnd` is the first index KEPT; we may LOWER it (keep more) to satisfy the
 *    guards, never raise it above keepFrom.
 *  - The anchor floor (PREVENT-PI-001) caps dropEnd at the index of the
 *    Nth-from-last user message so the last N user messages are never dropped.
 *  - The tool-pair invariant (PREVENT-PI-002) rejects any dropEnd that orphans a
 *    preserved tool result; on conflict with the anchor floor the pair rule wins
 *    (we drop less, never cross a pair).
 *  - We return the LARGEST pair-safe dropEnd <= min(keepFrom, anchorStart) so the
 *    caller drops as much as is safe. When no pair-safe positive cut exists at
 *    or below keepFrom, we return [0, 0] (no-op) — the pair rule outranks
 *    dropping. dropStart is always 0 today (we drop a prefix); reserved for
 *    future two-sided trimming.
 *
 * Returns [0, 0] (empty range, drop nothing) when keepFrom is out of range or no
 * pair-safe positive cut exists.
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
  const anchorStart = anchorActive ? userIndexes[userIndexes.length - anchorUserMessages] : keepFrom;
  // Upper bound on dropEnd: never keep less than the caller asked (dropEnd <= keepFrom)
  // and never drop a must-keep user message (dropEnd <= anchorStart).
  const upperBound = Math.min(keepFrom, anchorActive ? anchorStart : keepFrom);

  // Walk down from the upper bound to find the largest pair-safe cut. dropEnd=0
  // (drop nothing) is always pair-safe; the loop finds the largest positive cut,
  // and falls back to [0, 0] when none exists — the pair rule outranks dropping.
  for (let dropEnd = upperBound; dropEnd > 0; dropEnd--) {
    if (isPairSafe(messages, dropEnd)) return [0, dropEnd];
  }
  return [0, 0];
}

/**
 * Validate that the intended split at `keepFrom` (drop [0, keepFrom), keep the
 * rest) does not orphan any preserved tool result. Checks the FULL preserved
 * run, not just the first message, so it holds for arbitrary interleavings
 * (custom messages between call and result, consecutive shared-call results, a
 * cut landing on a call whose results follow). Used on the every-LLM-call
 * live-trim hot path (extensions/mega-trim.ts) and by dropCompactedRange
 * (src/adapt.ts).
 */
export function isBoundarySafe(messages: EngineMessage[], keepFrom: number): boolean {
  return isPairSafe(messages, keepFrom);
}

/**
 * Drop everything before the safe keep-index, honoring both guards, returning
 * the filtered message list. Returns the original array reference (unchanged)
 * when the safe range is empty so callers can short-circuit on reference
 * equality.
 */
export function dropBefore(messages: EngineMessage[], keepFrom: number, anchorUserMessages: number): EngineMessage[] {
  const [dropStart, dropEnd] = computeDropRange(messages, keepFrom, anchorUserMessages);
  if (dropStart === dropEnd) return messages;
  return messages.slice(dropEnd);
}
