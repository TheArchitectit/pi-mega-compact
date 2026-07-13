/**
 * store.ts — persistence primitives for checkpoints + session state.
 *
 * Mirrors memory-mcp session_context.py: sessions normalize to `sess_xxx`,
 * checkpoints are sequential `chkpt_001` per session. State lives under
 * ~/.pi/agent/extensions/mega-compact/ as gzipped JSON.
 */

import { randomBytes } from "node:crypto";
import {
  gzipSync, gunzipSync,
  brotliCompressSync, brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  embedding: number[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Dynamic compression — picks algorithm/level based on payload size
// ---------------------------------------------------------------------------

/** Tag byte prefix for each compression tier. */
const TAG_RAW     = 0x00; // no compression (< 512 bytes)
const TAG_GZIP_1  = 0x01; // gzip level 1 (fast, 512B–4KB)
const TAG_GZIP_6  = 0x02; // gzip level 6 (default, 4KB–32KB)
const TAG_BROTLI  = 0x03; // brotli level 4 (> 32KB)

/** Gzip magic bytes — used to detect legacy untagged files. */
const GZIP_MAGIC = 0x1f;

/**
 * Compress a buffer using the best algorithm for its size.
 *
 * Tier strategy:
 *   < 512 B  → raw (tag 0x00) — overhead of compression exceeds savings
 *   512B–4KB → gzip level 1  — fast, acceptable ratio for small blobs
 *   4KB–32KB → gzip level 6  — solid general-purpose default
 *   > 32 KB  → brotli level 4 — best text compression ratio
 *
 * Always prepends a 1-byte tag so `decompressSmart` can dispatch.
 */
export function compressSmart(data: Buffer): Buffer {
  const len = data.length;
  if (len < 512) {
    // No compression — prepend tag
    return Buffer.concat([Buffer.from([TAG_RAW]), data]);
  }
  if (len < 4096) {
    const compressed = gzipSync(data, { level: 1 });
    return Buffer.concat([Buffer.from([TAG_GZIP_1]), compressed]);
  }
  if (len < 32768) {
    const compressed = gzipSync(data, { level: 6 });
    return Buffer.concat([Buffer.from([TAG_GZIP_6]), compressed]);
  }
  // Large payload — brotli for best text ratio
  const compressed = brotliCompressSync(data, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
    },
  });
  return Buffer.concat([Buffer.from([TAG_BROTLI]), compressed]);
}

/**
 * Decompress a buffer written by `compressSmart`.
 *
 * Backward-compat: if the first byte is 0x1f (gzip magic), the file was
 * written by the old `gzipSync` path — decompress as plain gzip.
 */
export function decompressSmart(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const tag = buf[0];
  const payload = buf.subarray(1);

  // Legacy untagged gzip file
  if (tag === GZIP_MAGIC) {
    return gunzipSync(buf);
  }

  switch (tag) {
    case TAG_RAW:
      return payload;
    case TAG_GZIP_1:
    case TAG_GZIP_6:
      return gunzipSync(payload);
    case TAG_BROTLI:
      return brotliDecompressSync(payload);
    default:
      // Unknown tag — try legacy gzip as fallback
      return gunzipSync(buf);
  }
}

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
