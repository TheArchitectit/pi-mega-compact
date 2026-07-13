/**
 * store.ts — persistence primitives for checkpoints + session state.
 *
 * Mirrors memory-mcp session_context.py: sessions normalize to `sess_xxx`,
 * checkpoints are sequential `chkpt_001` per session. State lives under
 * ~/.pi/agent/extensions/mega-compact/ as gzipped JSON.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { compressSmart, decompressSmart } from "./store/compression.js";

// Re-export the compression primitives from their extracted home so existing
// imports (`import { compressSmart } from "./store.js"`) keep working.
export {
  compressSmart,
  decompressSmart,
  compressZstd,
  compressZstdMax,
  decompressZstd,
  isVersioned,
  isZstd,
  detectFormat,
  decompressSyncAuto,
} from "./store/compression.js";
export type { CompressedFormat } from "./store/compression.js";

/**
 * State directory. Read lazily (per call) so tests can redirect it via
 * MEGACOMPACT_STATE_DIR without re-importing the module. Defaults to
 * ~/.pi/agent/extensions/mega-compact/.
 */
export function getStateDir(): string {
  return process.env.MEGACOMPACT_STATE_DIR ?? join(homedir(), ".pi", "agent", "extensions", "mega-compact");
}

/** Normalize an arbitrary session id to the `sess_xxx` form (port of memory-mcp). */
export function normalizeSessionId(sessionId: string | undefined | null): string {
  if (!sessionId) return `sess_${randomBytes(8).toString("hex")}`;
  if (sessionId.startsWith("sess_")) return sessionId;
  if (sessionId.length >= 32 && sessionId.includes("-")) {
    return `sess_${sessionId.replace(/-/g, "").slice(0, 16)}`;
  }
  return `sess_${sessionId}`;
}

export interface StoredCheckpoint {
  checkpointId: string;
  sessionId: string;
  summary: string;
  /** Compressed topic summary (extractive, ~2K tokens vs ~70K raw). */
  topicSummary?: string;
  /** SHA-256 of topicSummary — summary-content dedup key. */
  summaryHash?: string;
  keyDecisions: string[];
  nextSteps: string[];
  filesModified: string[];
  tokenEstimate: number;
  regionHash: string;
  /** Primary content-addressable hash (full 64-hex SHA-256 of normalized text). */
  contentHash?: string;
  /** Secondary independent hash (reversed-text view) — guards single-hash collisions. */
  contentHash2?: string;
  contentHashVersion?: number;
  /** Whitespace/ANSI-normalized text the content hashes were computed over. */
  normalizedText?: string;
  /** Reconstructible raw region (sync-compressed) for audit/replay/re-summarize. */
  compressedOriginal?: Buffer;
  embedding: number[];
  timestamp: number;
  /** Dedup lifecycle: 'active' | 'removed' (SemDeDup) | 'dup-resolved' (backfill). */
  dedupStatus?: string;
}

// ---------------------------------------------------------------------------
// JSON persistence (DR snapshots + migration source).
// Compression lives in ./store/compression.ts; compressSmart/decompressSmart
// are imported above and re-exported for backward-compatible call sites.
// ---------------------------------------------------------------------------

/**
 * Read smart-compressed JSON, returning `fallback` on missing/corrupt file.
 *
 * Backward-compatible: detects legacy gzip files (magic byte 0x1f) and
 * decompresses them correctly alongside new tagged files.
 */
export function readGzJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const buf = readFileSync(path);
    const out = decompressSmart(buf);
    return JSON.parse(out.toString("utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON with dynamic compression; creates parent dirs. */
export function writeGzJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const jsonBuf = Buffer.from(JSON.stringify(data), "utf-8");
  const compressed = compressSmart(jsonBuf);
  writeFileSync(path, compressed);
}

/** Append a checkpoint to the per-session checkpoint file (gzipped). */
export function appendCheckpoint(cp: StoredCheckpoint, stateDir: string = getStateDir()): void {
  const file = join(stateDir, `${cp.sessionId}.checkpoints.json.gz`);
  const existing = readGzJson<StoredCheckpoint[]>(file, []);
  existing.push(cp);
  writeGzJson(file, existing);
}

/** All checkpoints for a session (across branches). */
export function listCheckpoints(sessionId: string, stateDir: string = getStateDir()): StoredCheckpoint[] {
  const file = join(stateDir, `${normalizeSessionId(sessionId)}.checkpoints.json.gz`);
  return readGzJson<StoredCheckpoint[]>(file, []);
}

/**
 * Rewrite ALL checkpoints for a session (in-place update).
 *
 * Used by VectorStore when summaryHash or contentSimilarity dedup updates an
 * existing checkpoint's timestamp/metadata instead of creating a new one.
 */
export function rewriteCheckpoints(
  sessionId: string,
  checkpoints: StoredCheckpoint[],
  stateDir: string = getStateDir(),
): void {
  const file = join(stateDir, `${normalizeSessionId(sessionId)}.checkpoints.json.gz`);
  writeGzJson(file, checkpoints);
}

/**
 * Generate the next sequential checkpoint id for a session (chkpt_001 ...).
 */
export function nextCheckpointId(sessionId: string, stateDir: string = getStateDir()): string {
  const list = listCheckpoints(sessionId, stateDir);
  const max = list.reduce((m, c) => {
    const n = parseInt(c.checkpointId.replace("chkpt_", ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `chkpt_${String(max + 1).padStart(3, "0")}`;
}

export interface SessionState {
  /** checkpointIds already injected into the current window this session. */
  injectedCheckpointIds: string[];
  /** regionHashes already represented (for sentinel dedup). */
  storedRegionHashes: string[];
}

/** Load mutable session state (created on demand). */
export function loadSessionState(sessionId: string, stateDir: string = getStateDir()): SessionState {
  const file = join(stateDir, `${normalizeSessionId(sessionId)}.state.json.gz`);
  return readGzJson<SessionState>(file, {
    injectedCheckpointIds: [],
    storedRegionHashes: [],
  });
}

export function saveSessionState(sessionId: string, state: SessionState, stateDir: string = getStateDir()): void {
  const file = join(stateDir, `${normalizeSessionId(sessionId)}.state.json.gz`);
  writeGzJson(file, state);
}
