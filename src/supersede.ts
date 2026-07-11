/**
 * supersede.ts — Layer 1 (SUPERSEDE): zero-cost factual pruning.
 *
 * If you read server.py, the previous read of server.py is factually obsolete
 * once you write it. We detect file-read turns that are superseded by a later
 * write (or a later read) to the same path and mark them for pruning — no
 * summarization, no token cost. Mirrors memory-mcp MemoryCompactor Stage 1.
 */

import type { EngineMessage } from "./types.js";
import { extractFileCandidates } from "./compact.js";

/** Classify a message's relationship to a file path. */
function fileOps(msg: EngineMessage): { path: string; op: "read" | "write" }[] {
  const paths = extractFileCandidates(msg.text);
  if (paths.length === 0) return [];
  const low = msg.text.toLowerCase();
  const isWrite = /\b(write|edit|create|save|append|overwrite|update|patch|modify)\b/.test(low);
  return paths.map((p) => ({ path: p, op: isWrite ? "write" : "read" }));
}

/**
 * Return the indexes (into `messages`) of file-read turns superseded by a later
 * operation on the same path. A read is obsolete once a write touches the same
 * path, or once a newer read of the same path exists (keep only the latest).
 */
export function findSuperseded(messages: EngineMessage[]): number[] {
  // Build, per path, the latest operation index and whether a write occurred.
  const lastWriteAt = new Map<string, number>();
  const lastReadAt = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const { path, op } of fileOps(m)) {
      if (op === "write") lastWriteAt.set(path, i);
      else lastReadAt.set(path, i);
    }
  });

  const superseded = new Set<number>();
  // Reads before a write to the same path are obsolete.
  messages.forEach((m, i) => {
    for (const { path, op } of fileOps(m)) {
      if (op !== "read") continue;
      const writeAt = lastWriteAt.get(path);
      if (writeAt !== undefined && i < writeAt) superseded.add(i);
    }
  });
  // For paths with multiple reads and no write, keep only the latest read.
  const readsByPath = new Map<string, number[]>();
  messages.forEach((m, i) => {
    for (const { path, op } of fileOps(m)) {
      if (op !== "read") continue;
      if (!readsByPath.has(path)) readsByPath.set(path, []);
      readsByPath.get(path)!.push(i);
    }
  });
  for (const [, idxs] of readsByPath) {
    if (idxs.length > 1) idxs.slice(0, -1).forEach((i) => superseded.add(i));
  }

  return [...superseded].sort((a, b) => a - b);
}

/** Convenience: drop superseded messages, preserving order. */
export function supersede(messages: EngineMessage[]): EngineMessage[] {
  const drop = new Set(findSuperseded(messages));
  return messages.filter((_m, i) => !drop.has(i));
}
