/**
 * extensions/mega-events/separated-prompt.ts — A1+A2 PLAN_V2 Phase 2+3
 * Message Separation + Cache-Optimized Prompt Builder:
 *   - buildSeparatedPrompt(): Basic 4-layer message separation (Phase 2).
 *   - buildCacheOptimizedPrompt(): Insert Layer 2 (vector-optimized stable
 *     context) between summary (Layer 1) and thread (Layer 3), ordered by
 *     stripe stability DESC (Phase 3).
 *   - detectTopicShift(): Cosine-similarity-based topic-shift detection.
 *   - cosineSimilarity(): cosine similarity of two Float32Array embeddings.
 *
 * Layer order (Phase 3): 0 (system) -> 1 (summary) -> 2 (cache stripes) ->
 * 3 (thread: user/assistant turns) -> 4 (tool results at tail).
 *
 * Feature-gated by MEGACOMPACT_CACHE_STRIPING (default OFF).
 * Flag-OFF = byte-identical to pre-sprint — returns messages unchanged.
 *
 * PC-A: buildSeparatedPrompt is PURE — the MEGACOMPACT_MESSAGE_SEPARATION gate
 * lives at the single call site (tailResult.ts, config.messageSeparation),
 * not inside this function.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { openStore } from "../../src/store/sqlite/utils.js";
import { getStateDir } from "../../src/store.js";

// ─── Exported types ──────────────────────────────────────────────────────────

export interface SeparatedPromptOptions {
  /** Path to the SQLite store directory. Defaults to getStateDir(). */
  stateDir?: string;
  /** Conversation/agent ID for stripe lookups. Defaults to 'main'. */
  conversationId?: string;
  /** Current turn index for embedding_cache lookups. Defaults to 0. */
  turnIndex?: number;
}

export interface CacheStripeRow {
  chunk_id: string;
  stripe: number;
  stability: number;
  assigned_at: number;
  epoch_id: string | null;
}

export interface EmbeddingCacheRow {
  content_hash: string;
  embedding: Buffer;
  computed_at: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default stripe limit: top 10 most stable chunks. */
const DEFAULT_STRIPE_LIMIT = 10;

/** Topic-shift threshold: similarity below this triggers a stripe refresh. */
const TOPIC_SHIFT_THRESHOLD = 0.7;

// ─── Build separated prompt (Phase 2) ────────────────────────────────────────

/**
 * Reorganize messages into stable layers for better prompt caching.
 *
 * Layer order: 0 (system) -> 1 (summary) -> 3 (thread: user/assistant turns) ->
 * 4 (tool results at tail).
 *
 * PURE function: the MEGACOMPACT_MESSAGE_SEPARATION gate moved to the single
 * call site (tailResult.ts, config.messageSeparation) — this never reads env.
 * When there is nothing to reorder, returns `messages` unchanged (byte-identical).
 */
export function buildSeparatedPrompt(
  messages: AgentMessage[],
  _opts?: SeparatedPromptOptions,
): AgentMessage[] {
  // pi's AgentMessage union has no "system" role — the system prompt lives in
  // AgentState.systemPrompt, separate from this array. The cache-relevant,
  // low-risk transformation is moving volatile tool results/executions to the
  // tail so the stable prefix (user/assistant/summaries/custom) stays contiguous.
  // Discriminate by role only — never reach into `.content`/`.tool_calls`,
  // which are variant-specific and require narrowing.
  const main: AgentMessage[] = [];
  const tail: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "toolResult" || m.role === "bashExecution") {
      tail.push(m);
    } else {
      main.push(m);
    }
  }
  if (tail.length === 0) return messages; // nothing to reorder — byte-identical
  return [...main, ...tail];
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Array embeddings.
 * Returns a value in [0, 1] where 1 = identical direction.
 * Returns 0 if either vector is zero or inputs are mismatched.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ─── Buffer ↔ Float32Array helpers ───────────────────────────────────────────

/**
 * Decode a Float32Array from a Buffer (little-endian float32 blob).
 * Returns null on empty/undefined input.
 */
export function decodeEmbeddingBlob(buf: Buffer | undefined | null): Float32Array | null {
  if (!buf || buf.length === 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Encode a Float32Array into a Buffer for DB storage.
 */
export function encodeEmbeddingBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ─── Topic-shift detection ───────────────────────────────────────────────────

/**
 * Detect whether the conversation topic has shifted between the current turn
 * and the previous turn. Uses cosine similarity between topic embeddings.
 *
 * Returns `true` when similarity < TOPIC_SHIFT_THRESHOLD (0.7), meaning the
 * stable cache prefix may need reordering.
 *
 * Returns `false` (no shift) when either embedding is missing.
 */
export function detectTopicShift(
  currentEmb: Float32Array | null | undefined,
  previousEmb: Float32Array | null | undefined,
): boolean {
  if (!currentEmb || !previousEmb) return false;
  return cosineSimilarity(currentEmb, previousEmb) < TOPIC_SHIFT_THRESHOLD;
}

// ─── Load embeddings from store ──────────────────────────────────────────────

/**
 * Load the topic embedding for a given turn from the embedding_cache table.
 * Returns null if no embedding is stored for that turn.
 */
export function loadTopicEmbedding(
  stateDir: string,
  conversationId: string,
  turnIndex: number,
): Float32Array | null {
  const db = openStore(stateDir);
  try {
    const row = db.prepare(
      `SELECT embedding FROM embedding_cache WHERE content_hash = ?`,
    ).get(`topic:${conversationId}:${turnIndex}`) as { embedding: Buffer } | undefined;

    if (!row) return null;
    return decodeEmbeddingBlob(row.embedding);
  } finally {
    db.close();
  }
}

/**
 * Store a topic embedding for a given turn in the embedding_cache table.
 * Idempotent (INSERT OR REPLACE).
 */
export function storeTopicEmbedding(
  stateDir: string,
  conversationId: string,
  turnIndex: number,
  embedding: Float32Array,
): void {
  const db = openStore(stateDir);
  try {
    const contentHash = `topic:${conversationId}:${turnIndex}`;
    const blob = encodeEmbeddingBlob(embedding);
    db.prepare(
      `INSERT OR REPLACE INTO embedding_cache (content_hash, embedding, computed_at) VALUES (?, ?, ?)`,
    ).run(contentHash, blob, Date.now());
  } finally {
    db.close();
  }
}

// ─── Cache stripe management ─────────────────────────────────────────────────

/**
 * Refresh cache stripe assignments from the cache_stripes table for a given
 * conversation/epoch. Returns rows ordered by stability DESC.
 *
 * This is called at the start of each turn (or on topic-shift) to ensure the
 * stripe assignments reflect the latest stability scores.
 */
export function refreshStripeAssignments(
  stateDir: string,
  epochId: string,
  limit = DEFAULT_STRIPE_LIMIT,
): CacheStripeRow[] {
  const db = openStore(stateDir);
  try {
    const rows = db.prepare(
      `SELECT chunk_id, stripe, stability, assigned_at, epoch_id
       FROM cache_stripes
       WHERE epoch_id = ?
       ORDER BY stability DESC
       LIMIT ?`,
    ).all(epochId, limit) as unknown as CacheStripeRow[];

    return rows;
  } finally {
    db.close();
  }
}

// ─── Build cache-optimized prompt (Phase 3) ──────────────────────────────────

/**
 * Build a cache-optimized prompt with 5 layers:
 *   0 (system) -> 1 (summary) -> 2 (cache stripes) -> 3 (thread) -> 4 (tool)
 *
 * Feature gate: MEGACOMPACT_CACHE_STRIPING (default OFF). When OFF, delegates
 * to buildSeparatedPrompt (byte-identical to Phase 2 behavior).
 *
 * When ON but MEGACOMPACT_MESSAGE_SEPARATION is OFF, also delegates to
 * buildSeparatedPrompt (which returns messages unchanged).
 */
export function buildCacheOptimizedPrompt(
  messages: AgentMessage[],
  opts?: SeparatedPromptOptions,
): AgentMessage[] {
  const flag = process.env.MEGACOMPACT_CACHE_STRIPING;
  if (flag === "0" || flag === "false" || flag === undefined || flag === "") {
    // Flag OFF: delegate to buildSeparatedPrompt (byte-identical).
    return buildSeparatedPrompt(messages, opts);
  }

  // Build the base 4-layer structure first.
  const base = buildSeparatedPrompt(messages, opts);

  // If base equals messages, separation is OFF — return unchanged.
  if (base === messages) return base;

  const stateDir = opts?.stateDir ?? getStateDir();

  // Layer 1 = leading branch/compaction summaries (the stable summary layer).
  // There is no "system" role in pi's AgentMessage union, so Layer 0 is empty.
  // Count leading summaries to find where to insert the cache-stripe layer.
  let layer1End = 0;
  for (let i = 0; i < base.length; i++) {
    const r = base[i].role;
    if (r === "branchSummary" || r === "compactionSummary") {
      layer1End = i + 1;
    } else {
      break;
    }
  }

  // Lay out the result: Layer 1 (summaries) first.
  const result: AgentMessage[] = base.slice(0, layer1End);

  // Insert Layer 2: cache stripes (stable context ordered by stability DESC).
  // Try to find the most recent epoch.
  const db = openStore(stateDir);
  let epochId: string | null = null;
  try {
    const epoch = db.prepare(
      `SELECT epoch_id FROM checkpoint_epochs ORDER BY created_at DESC LIMIT 1`,
    ).get() as { epoch_id: string } | undefined;
    epochId = epoch?.epoch_id ?? null;
  } finally {
    db.close();
  }

  if (epochId) {
    const stripes = refreshStripeAssignments(stateDir, epochId);
    if (stripes.length > 0) {
      // Build a single user message with concatenated stripe content.
      const stripeBlocks: string[] = [];
      for (const s of stripes) {
        // Load chunk content from context_chunks table.
        const db2 = openStore(stateDir);
        try {
          const chunk = db2.prepare(
            `SELECT normalized_text FROM context_chunks WHERE id = ?`,
          ).get(s.chunk_id) as { normalized_text: string } | undefined;
          if (chunk?.normalized_text) {
            stripeBlocks.push(chunk.normalized_text);
          }
        } finally {
          db2.close();
        }
      }

      if (stripeBlocks.length > 0) {
        result.push({
          role: "user",
          content: stripeBlocks.join("\n\n---\n\n"),
          timestamp: Date.now(),
        } as AgentMessage);
      }
    }
  }

  // Append remaining layers (3: thread, 4: tool results).
  for (let i = layer1End; i < base.length; i++) {
    result.push(base[i]);
  }

  return result;
}
