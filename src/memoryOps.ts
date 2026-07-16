/**
 * memoryOps.ts — apply reviewConversation() MemoryOp results to the durable
 * memories store (S20.3). Thin layer over the SQLite memories helpers in
 * src/store/sqlite.ts; no raw SQL here. Local only (PREVENT-PI-004).
 * @module
 */
import type { MemoryOp } from "./memory.js";
import {
  addMemory,
  listMemories,
  replaceMemory,
  removeMemory,
  type MemoryRecord,
} from "./store/sqlite.js";

/** Find a memory row whose content exactly matches (case-insensitive). */
function findByContent(memories: MemoryRecord[], content: string): MemoryRecord | undefined {
  const norm = content.trim().toLowerCase();
  return memories.find((m) => m.content.trim().toLowerCase() === norm);
}

/**
 * Apply add/replace/remove ops to the memories table. Replaces are matched by
 * existing content; removes by content. Idempotent: an add that already exists
 * is a no-op, a replace of a missing memory degrades to an add.
 */
export async function applyMemoryOps(ops: MemoryOp[], stateDir: string): Promise<void> {
  if (!ops.length) return;
  const repo = null; // memories are repo-scoped by stateDir, not by the repo arg here
  const existing = listMemories(repo, 1000, stateDir);
  for (const op of ops) {
    if (op.op === "add") {
      // Skip if an identical memory already exists.
      if (findByContent(existing, op.memory.content)) continue;
      addMemory(
        {
          kind: op.memory.category,
          content: op.memory.content,
          tags: [],
          category: op.memory.category,
          target: op.memory.target,
          sourceTurn: op.memory.sourceTurn,
        },
        repo,
        stateDir,
      );
    } else if (op.op === "replace") {
      const match = findByContent(existing, op.targetContent);
      if (match) {
        replaceMemory(match.id, {
          kind: op.memory.category,
          content: op.memory.content,
          category: op.memory.category,
          sourceTurn: op.memory.sourceTurn,
        }, stateDir);
      } else {
        // Target missing (e.g. earlier in-conversation contradiction) → add.
        addMemory(
          {
            kind: op.memory.category,
            content: op.memory.content,
            tags: [],
            category: op.memory.category,
            sourceTurn: op.memory.sourceTurn,
          },
          repo,
          stateDir,
        );
      }
    } else {
      const match = findByContent(existing, op.content);
      if (match) removeMemory(match.id, stateDir);
    }
  }
}
