/**
 * memories.ts — durable "save to memory" store (taken over from memory extensions).
 *
 * One SQLite store for user-saved memories, scoped by repo. Mirrors the
 * lessons/sessions pattern: all state lives in SQLite from day one.
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

// S24 storage hardening: keep each memory row bounded so the durable store can
// never blow a downstream consumer's per-entry buffer (e.g. pi's native
// file-backed memory caps a single entry at ~5k chars). We truncate content at
// MEMORY_MAX_CHARS and evict the least-recently-referenced rows past
// MEMORY_MAX_ROWS per repo via LRU. Both are SQLite-only (PREVENT-PI-004): no
// file-backed memory is written anywhere. Defaults are overridable via env
// (MEGACOMPACT_MEMORY_MAX_CHARS / MEGACOMPACT_MEMORY_MAX_ROWS).
export const MEMORY_MAX_CHARS = 4000;
export const MEMORY_MAX_ROWS = 500;

/** Read an env override as a positive int, falling back to `fallback`. */
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Effective per-entry char cap (env-overridable, default MEMORY_MAX_CHARS). */
export function memoryMaxChars(): number {
  return envInt("MEGACOMPACT_MEMORY_MAX_CHARS", MEMORY_MAX_CHARS);
}

/** Effective per-repo row cap (env-overridable, default MEMORY_MAX_ROWS). */
export function memoryMaxRows(): number {
  return envInt("MEGACOMPACT_MEMORY_MAX_ROWS", MEMORY_MAX_ROWS);
}

/** Truncate memory content to the per-entry cap, preserving a trailing marker. */
function capMemoryContent(content: string): string {
  const cap = memoryMaxChars();
  if (content.length <= cap) return content;
  return content.slice(0, cap) + "…[truncated]";
}

/**
 * Evict the least-recently-referenced rows for a repo past MEMORY_MAX_ROWS.
 * LRU key = COALESCE(last_referenced, last_recalled_at, created_at) so a memory
 * that is recalled/referenced survives over a stale one. Best-effort: any error
 * is swallowed by the caller. Repo-scoped so one noisy repo can't evict another.
 */
function evictMemoryLru(repo: string | null, stateDir: string): void {
  const db = openStore(stateDir);
  const maxRows = memoryMaxRows();
  // SQLite `= NULL` is never true, so the null-repo scope (memories are
  // stateDir-scoped when repo is null — the applyMemoryOps path) needs `IS NULL`.
  const where = repo == null ? "repo IS NULL" : "repo = ?";
  const countRow = repo == null
    ? db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get()
    : db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(repo);
  const count = (countRow as { n: number }).n;
  const over = count - maxRows;
  if (over <= 0) return;
  // Delete the `over` least-recently-used rows. ORDER BY the LRU key ASC, id ASC
  // (id ASC breaks ties deterministically — oldest created first). The `where`
  // clause is a code-controlled constant (never user input) → PREVENT-002 OK.
  const sql =
    `DELETE FROM memories WHERE ${where} AND id IN (
       SELECT id FROM memories WHERE ${where}
       ORDER BY COALESCE(last_referenced, last_recalled_at, created_at) ASC, id ASC
       LIMIT ?
     )`;
  if (repo == null) db.prepare(sql).run(over);
  else db.prepare(sql).run(repo, repo, over);
}

export interface MemoryRecord {
  id: number;
  repo: string | null;
  kind: string;
  content: string;
  tags: string[];
  createdAt: number;
  lastRecalledAt: number | null;
  category: string | null;
  target: string | null;
  lastReferenced: number | null;
  sourceTurn: number | null;
}

/** Save a memory to the current repo's store. Returns the new row id.
 *  S24 hardening: content is truncated to MEMORY_MAX_CHARS and, once the per-repo
 *  row count exceeds MEMORY_MAX_ROWS, the least-recently-used rows are evicted
 *  (LRU) so the store stays bounded. */
export function addMemory(
  memory: { kind?: string; content: string; tags?: string[]; category?: string; target?: string; sourceTurn?: number },
  repo: string | null,
  stateDir: string = getStateDir(),
): number {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db
    .prepare(
      `INSERT INTO memories(repo, kind, content, tags, created_at, last_recalled_at, category, target, source_turn)
       VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      repo ?? null,
      memory.kind ?? "note",
      capMemoryContent(memory.content),
      JSON.stringify(memory.tags ?? []),
      now,
      memory.category ?? null,
      memory.target ?? null,
      memory.sourceTurn ?? null,
    );
  try {
    evictMemoryLru(repo, stateDir);
  } catch {
    /* non-fatal: eviction must never fail an add */
  }
  return Number(res.lastInsertRowid);
}

/** List recent memories for a repo (or all repos when repo is null). */
export function listMemories(repo: string | null, limit = 50, stateDir: string = getStateDir()): MemoryRecord[] {
  const db = openStore(stateDir);
  const rows = repo
    ? db.prepare("SELECT * FROM memories WHERE repo = ? ORDER BY created_at DESC LIMIT ?").all(repo, limit)
    : db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(mapMemoryRow);
}

/** Substring search across content + tags. */
export function searchMemories(query: string, repo: string | null = null, limit = 50, stateDir: string = getStateDir()): MemoryRecord[] {
  const db = openStore(stateDir);
  const like = `%${query}%`;
  const rows = repo
    ? db.prepare("SELECT * FROM memories WHERE repo = ? AND (content LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?").all(repo, like, like, limit)
    : db.prepare("SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT ?").all(like, like, limit);
  return (rows as any[]).map(mapMemoryRow);
}

/** Mark a memory as recalled (updates last_recalled_at). Returns true if found. */
export function recallMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare("UPDATE memories SET last_recalled_at = ? WHERE id = ?").run(now, id);
  return res.changes > 0;
}

/** Mark a memory as referenced (updates last_referenced). Returns true if found. */
export function referenceMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run(now, id);
  return res.changes > 0;
}

/** Replace a memory's mutable fields by id. Returns true if a row was updated. */
export function replaceMemory(
  id: number,
  patch: { kind?: string; content?: string; tags?: string[]; category?: string; target?: string; sourceTurn?: number },
  stateDir: string = getStateDir(),
): boolean {
  const db = openStore(stateDir);
  const res = db
    .prepare(
      `UPDATE memories
       SET kind = COALESCE(?, kind),
           content = COALESCE(?, content),
           tags = COALESCE(?, tags),
           category = COALESCE(?, category),
           target = COALESCE(?, target),
           source_turn = COALESCE(?, source_turn)
       WHERE id = ?`,
    )
    .run(
      patch.kind ?? null,
      patch.content != null ? capMemoryContent(patch.content) : null,
      patch.tags ? JSON.stringify(patch.tags) : null,
      "category" in patch ? (patch.category ?? null) : null,
      "target" in patch ? (patch.target ?? null) : null,
      "sourceTurn" in patch ? (patch.sourceTurn ?? null) : null,
      id,
    );
  return res.changes > 0;
}

/** Remove a memory by id. Returns true if a row was deleted. */
export function removeMemory(id: number, stateDir: string = getStateDir()): boolean {
  const db = openStore(stateDir);
  const res = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return res.changes > 0;
}

/** Look up a single memory by id (or undefined). */
export function getMemory(id: number, stateDir: string = getStateDir()): MemoryRecord | undefined {
  const db = openStore(stateDir);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  return row ? mapMemoryRow(row) : undefined;
}

function mapMemoryRow(row: any): MemoryRecord {
  return {
    id: row.id,
    repo: row.repo ?? null,
    kind: row.kind ?? "note",
    content: row.content ?? "",
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdAt: row.created_at ?? 0,
    lastRecalledAt: row.last_recalled_at ?? null,
    category: row.category ?? null,
    target: row.target ?? null,
    lastReferenced: row.last_referenced ?? null,
    sourceTurn: row.source_turn ?? null,
  };
}
