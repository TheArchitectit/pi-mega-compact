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
import { defaultEmbedder } from "./embedder.js";
import { upsertMemoryEmbedding } from "./store/memoryIndex.js";
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only `git rev-parse` to scope the memory index per-repo

/** Resolve the current repo's git root (mirrors extensions/mega-config.ts but
 *  kept local so src/ stays pi-agnostic — no extension-layer import). */
function resolveRepoRootLocal(cwd: string): string | undefined {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Find a memory row whose content exactly matches (case-insensitive). */
function findByContent(memories: MemoryRecord[], content: string): MemoryRecord | undefined {
  const norm = content.trim().toLowerCase();
  return memories.find((m) => m.content.trim().toLowerCase() === norm);
}

/**
 * Fire-and-forget mirror of a memory write into the cross-repo PGlite index
 * (S24 optional memory-RAG mirror). Best-effort + non-fatal: never blocks the
 * SQLite write and degrades to the same-repo scan if the index is disabled or
 * fails. `repoId` is the resolved git root so the memory is findable from other
 * repos; falls back to the state dir when outside git.
 */
function indexMemoryWrite(stateDir: string, memoryId: number, content: string): void {
  const repoId = resolveRepoRootLocal(stateDir) ?? stateDir;
  try {
    const vec = defaultEmbedder().embed(content);
    void upsertMemoryEmbedding(repoId, memoryId, content, vec);
  } catch {
    /* non-fatal — embedding/index failure must never break the SQLite write */
  }
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
      const id = addMemory(
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
      // S24: mirror into the cross-repo index (fire-and-forget; non-fatal).
      indexMemoryWrite(stateDir, id, op.memory.content);
    } else if (op.op === "replace") {
      const match = findByContent(existing, op.targetContent);
      if (match) {
        replaceMemory(match.id, {
          kind: op.memory.category,
          content: op.memory.content,
          category: op.memory.category,
          sourceTurn: op.memory.sourceTurn,
        }, stateDir);
        // S24: re-mirror under the same memory id (fire-and-forget; non-fatal).
        indexMemoryWrite(stateDir, match.id, op.memory.content);
      } else {
        // Target missing (e.g. earlier in-conversation contradiction) → add.
        const id = addMemory(
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
        indexMemoryWrite(stateDir, id, op.memory.content);
      }
    } else {
      const match = findByContent(existing, op.content);
      if (match) removeMemory(match.id, stateDir);
    }
  }
}
