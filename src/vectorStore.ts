/**
 * vectorStore.ts — Layer 3 (CLUSTER): the local vector database.
 *
 * One store, three consumers (per PLAN.md): auto-inline on resume, on-demand
 * /recall-context, and the dedup sentinel. All share `add / search / dedupe`.
 *
 * Backed by the gzipped on-disk checkpoint files (store.ts). Similarity is a
 * linear cosine scan — checkpoint counts are small, so no ANN index is needed.
 */

import { createHash } from "node:crypto";
import type { Embedder, Vector } from "./embedder.js";
import { cosineSimilarity, defaultEmbedder } from "./embedder.js";
import { loadDedupConfig, type DedupConfigShape, type DedupTier } from "./config/dedup.js";
import { logDecision } from "./monitoring.js";
import type { StoredCheckpoint, SessionState } from "./store.js";
import { getStateDir, normalizeSessionId, compressSmart } from "./store.js";
import { computeContentDigest } from "./dedup/digest.js";
import { minhashSignature, SIGNATURE_VERSION, NUM_HASHES } from "./dedup/l1-minhash.js";
import { lshBands } from "./dedup/l1-lsh.js";
import { isNearDuplicate } from "./dedup/l1-verify.js";
import { mmrRerank, type MmrItem } from "./dedup/mmr.js";
import { topK } from "./dedup/topk.js";
import { openBloom, saveBloom } from "./store/bloom.js";
import {
  listCheckpoints,
  nextCheckpointId,
  upsertCheckpoint,
  loadSessionState,
  saveSessionState,
  upsertMinhashSignature,
  insertLshBuckets,
  lshCandidateChunks,
  setDedupStatus,
  addTokensSaved,
  getDedupStats,
  bumpDedupStats,
  repoStats as repoStatsFromStore,
  dataInvariantStats,
} from "./store/sqlite.js";
import { migrateJsonToSqlite } from "./store/migrate.js";

export interface SearchHit {
  checkpoint: StoredCheckpoint;
  score: number;
}

export interface AddInput {
  sessionId: string;
  summary: string;
  /** Compressed topic summary (extractive). When present, embedded instead of regionText. */
  topicSummary?: string;
  keyDecisions?: string[];
  nextSteps?: string[];
  filesModified?: string[];
  tokenEstimate?: number;
  /** Token count of the ORIGINAL dropped region (before compaction). Drives the
   *  honest "tokens saved" = originalTokenEstimate − tokenEstimate (stored), or
   *  the full originalTokenEstimate when the region dedups (nothing new stored).
   *  Optional for back-compat with direct add() callers; defaults to stored. */
  originalTokenEstimate?: number;
  /** Raw text of the compacted region — used to derive the regionHash + vector. */
  regionText: string;
  timestamp: number;
  /** Sync progress callback fired as each dedup tier is evaluated (L0→L1→L2→new).
   *  Lets the UI render live per-tier progress during compaction. Never awaited;
   *  must be cheap. Optional for back-compat. */
  onTier?: (ev: { tier: "L0" | "L1" | "L2" | "new"; status: "scanning" | "deduped" | "passed" | "stored"; detail?: string }) => void;
  /** Context-window pressure (0–1) — escalates the stored checkpoint's sync
   *  compression strength (Fix E). Optional; defaults to 0 (brotli-4). */
  compressionPressure?: number;
}

/** Default L2 semantic-dedup enable flag (trigram embedder is local, zero-network). */
export const L2_ENABLED = true;

export interface AddResult {
  checkpoint: StoredCheckpoint;
  deduped: boolean; // true when an equivalent region already existed (skipped embed)
  /** Which dedup tier matched: regionHash | summaryHash | contentSimilarity | undefined (new). */
  reason?: string;
}

/** Stable hash of a compacted region, the dedup sentinel key. */
export function computeRegionHash(regionText: string): string {
  // Normalize whitespace before hashing so "foo  bar" and "foo bar" dedup.
  const normalized = regionText.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export class VectorStore {
  private readonly embedder: Embedder;
  private readonly stateDir: string;
  private readonly l2Threshold: number;
  /** Single source of truth for tier flags + thresholds (Sprint 14). */
  private readonly cfg: DedupConfigShape;
  /** Optional monitoring target (Sprint 14). Undefined → no monitoring. */
  private readonly eventsPath?: string;

  constructor(
    opts: {
      embedder?: Embedder;
      dedupSim?: number;
      stateDir?: string;
      l2Enabled?: boolean;
      l2Threshold?: number;
      /** Override the dedup config (defaults to env/file snapshot). */
      config?: DedupConfigShape;
      /** Optional events.log path for decision monitoring (Sprint 14). */
      eventsPath?: string;
    } = {},
  ) {
    this.embedder = opts.embedder ?? defaultEmbedder();
    this.stateDir = opts.stateDir ?? getStateDir();
    // Sprint 14: all tier flags/thresholds flow from the single config source
    // (DedupConfig). The legacy opts.dedupSim / opts.l2Enabled remain accepted
    // for backward-compat callers but flags are authoritative via `cfg`.
    void opts.dedupSim;
    void opts.l2Enabled;
    // Sprint 12 L2 semantic tier. Threshold 0.85 is the default trigram
    // embedder's honest firing point; a direct override is allowed for tests.
    this.cfg = opts.config ?? loadDedupConfig();
    this.l2Threshold = opts.l2Threshold ?? this.cfg.L2_COSINE;
    this.eventsPath = opts.eventsPath;
    // Sprint 8: bring any v0.1.0 JSON checkpoint files into SQLite (idempotent).
    migrateJsonToSqlite(this.stateDir);
    // Sprint 10: warm the bloom accelerator (accelerator only — SQLite stays
    // source of truth; a bloom hit is always confirmed by a query below).
    openBloom(this.stateDir);
  }

  /** Emit a structured dedup-decision event (best-effort, never throws). */
  private record(tier: DedupTier, result: "deduped" | "new" | "mark_only", reason: string | undefined, latencyMs: number): void {
    if (!this.eventsPath) return;
    logDecision(this.eventsPath, {
      ts: Date.now(),
      tier,
      result,
      reason,
      latencyMs: Math.round(latencyMs * 100) / 100,
    });
  }

  /**
   * Add a checkpoint. Dedup cascade:
   *   1. regionHash exact match (legacy, backward-compat)
   *   2. summaryHash exact match (new: catches same-topic incremental compactions)
   *   3. content similarity ≥ dedupSim (catches near-identical summaries)
   *   4. If none match → create new checkpoint
   */
  add(input: AddInput): AddResult {
    const t0 = Date.now();
    const sessionId = normalizeSessionId(input.sessionId);
    const regionHash = computeRegionHash(input.regionText);
    const all = listCheckpoints(sessionId, this.stateDir);
    // Honest "tokens saved" base for this region. For a deduped add the whole
    // original region is discarded (nothing new stored); for a new checkpoint
    // we persist (orig − stored). Falls back to stored when orig is unknown.
    const origTokens = input.originalTokenEstimate ?? input.tokenEstimate ?? 0;
    const cfg = this.cfg;
    // Live per-tier progress hook (Phase 1). Sync + optional; fired at each tier
    // so the UI can paint "L0 ✓ → L1 ✓ → L2 0.91 → stored" during a compaction.
    const onTier = input.onTier;
    // Tracks whether a tier matched while in MARK_ONLY (record-but-don't-collapse),
    // and which tier.
    let markOnly: DedupTier | null = null;

    // 0. L0 content-hash dedup (Sprint 9) — catches identical content arriving
    //    under different regionText. Normalization handles case/whitespace/ANSI so
    //    variants collapse to one row. Dual-hash guards a single-hash collision.
    //    Sprint 10: bloom is the accelerator — a miss means "definitely new" and
    //    skips the scan; a hit is only a candidate, confirmed against `all` below.
    //    Gated by L0_ENABLED (Sprint 14). MARK_ONLY_L0 records the decision but
    //    does not collapse — the new region is still stored.
    onTier?.({ tier: "L0", status: "scanning" });
    const digest = computeContentDigest(input.regionText);
    const bloom = openBloom(this.stateDir);
    if (cfg.L0_ENABLED && bloom.maybeHas(digest.contentHash)) {
      const contentMatch = all.find(
        (cp) =>
          cp.contentHash === digest.contentHash &&
          cp.contentHash2 === digest.contentHash2,
      );
      if (contentMatch) {
        if (cfg.MARK_ONLY_L0) {
          markOnly = "L0"; // Record-but-don't-collapse: fall through.
        } else {
          contentMatch.timestamp = input.timestamp;
          upsertCheckpoint(contentMatch, this.stateDir);
          bumpDedupStats(true, this.stateDir);
          // Deduped: whole original region discarded, nothing new stored.
          addTokensSaved(origTokens, this.stateDir);
          const r = { checkpoint: contentMatch, deduped: true, reason: "contentHash" };
          this.record("L0", "deduped", "contentHash", Date.now() - t0);
          onTier?.({ tier: "L0", status: "deduped", detail: "contentHash" });
          return r;
        }
      }
    }

    // 1. Legacy regionHash dedup (backward-compat) — part of L0 tier gating.
    if (cfg.L0_ENABLED) {
      const regionMatch = all.find((cp) => cp.regionHash === regionHash);
      if (regionMatch) {
        if (cfg.MARK_ONLY_L0) {
          markOnly = "L0"; // fall through
        } else {
          bumpDedupStats(true, this.stateDir);
          // Deduped: whole original region discarded, nothing new stored.
          addTokensSaved(origTokens, this.stateDir);
          const r = { checkpoint: regionMatch, deduped: true, reason: "regionHash" };
          this.record("L0", "deduped", "regionHash", Date.now() - t0);
          onTier?.({ tier: "L0", status: "deduped", detail: "regionHash" });
          return r;
        }
      }
    }

    // 2. SummaryHash dedup — catches same-topic incremental compactions.
    //    Full 64-hex SHA-256 (was 16-hex in Sprint 8 — collision-prone).
    const summaryHash = input.topicSummary
      ? createHash("sha256").update(input.topicSummary).digest("hex")
      : undefined;
    if (summaryHash && cfg.L0_ENABLED) {
      const summaryMatch = all.find((cp) => cp.summaryHash === summaryHash);
      if (summaryMatch) {
        if (cfg.MARK_ONLY_L0) {
          markOnly = "L0"; // fall through
        } else {
          summaryMatch.timestamp = input.timestamp;
          upsertCheckpoint(summaryMatch, this.stateDir);
          bumpDedupStats(true, this.stateDir);
          // Deduped: whole original region discarded, nothing new stored.
          addTokensSaved(origTokens, this.stateDir);
          const r = { checkpoint: summaryMatch, deduped: true, reason: "summaryHash" };
          this.record("L0", "deduped", "summaryHash", Date.now() - t0);
          onTier?.({ tier: "L0", status: "deduped", detail: "summaryHash" });
          return r;
        }
      }
    }
    // L0 did not collapse this region.
    onTier?.({ tier: "L0", status: "passed" });

    // 2b. L1 MinHash/LSH near-duplicate dedup (Sprint 11) — catches one-word
    //     edits / rewordings that L0's exact hash misses. Cheap LSH bucket
    //     retrieval → trigram verification (pg_trgm-equivalent) as the final gate.
    //     Gated by L1_ENABLED (Sprint 14); MARK_ONLY_L1 records but doesn't collapse.
    onTier?.({ tier: "L1", status: "scanning" });
    if (cfg.L1_ENABLED) {
      const l1 = this.findL1Duplicate(sessionId, input.regionText, all);
      if (l1 && !cfg.MARK_ONLY_L1) {
        l1.timestamp = input.timestamp;
        upsertCheckpoint(l1, this.stateDir);
        bumpDedupStats(true, this.stateDir);
        const r = { checkpoint: l1, deduped: true, reason: "l1MinHash" };
        this.record("L1", "deduped", "l1MinHash", Date.now() - t0);
        onTier?.({ tier: "L1", status: "deduped", detail: "l1MinHash" });
        return r;
      }
      if (l1 && cfg.MARK_ONLY_L1) markOnly = "L1";
    }
    onTier?.({ tier: "L1", status: "passed" });

    // 3. L2 semantic dedup — catches near-identical / semantically-similar regions
    //    via cosine over the embedding. topicSummary is used for summaryHash dedup
    //    (tier 2); the vector index is keyed on the original region for backward-
    //    compat search semantics. Threshold from cfg (L2_COSINE trigram honest
    //    firing point). QA #13 timeout guard: if the O(n) scan exceeds the budget,
    //    degrade to "store without dedup this pass" so we never lose a checkpoint.
    //    Gated by L2_ENABLED (Sprint 14); MARK_ONLY_L2 records but doesn't collapse.
    const SIMILARITY_BUDGET_MS = cfg.SIMILARITY_BUDGET_MS;
    const simThreshold = this.l2Threshold; // from cfg.L2_COSINE (default 0.85 trigram)
    const embedding = this.embedder.embed(input.regionText);
    onTier?.({ tier: "L2", status: "scanning" });
    if (cfg.L2_ENABLED && all.length > 0) {
      const start = Date.now();
      let timedOut = false;
      const nearest = all.reduce(
        (best, cp) => {
          if (!timedOut && Date.now() - start > SIMILARITY_BUDGET_MS) timedOut = true;
          if (timedOut) return best;
          const sim = cosineSimilarity(embedding, cp.embedding);
          return sim > best.sim ? { checkpoint: cp, sim } : best;
        },
        { checkpoint: all[0], sim: -1 },
      );
      if (!timedOut && nearest.sim >= simThreshold) {
        if (!cfg.MARK_ONLY_L2) {
          // Near-identical — update timestamp on existing checkpoint
          nearest.checkpoint.timestamp = input.timestamp;
          upsertCheckpoint(nearest.checkpoint, this.stateDir);
          bumpDedupStats(true, this.stateDir);
          // Deduped: whole original region discarded, nothing new stored.
          addTokensSaved(origTokens, this.stateDir);
          const r = { checkpoint: nearest.checkpoint, deduped: true, reason: "contentSimilarity" };
          this.record("L2", "deduped", "contentSimilarity", Date.now() - t0);
          onTier?.({ tier: "L2", status: "deduped", detail: nearest.sim.toFixed(2) });
          return r;
        }
        markOnly = "L2";
      }
      onTier?.({ tier: "L2", status: "passed", detail: `best ${nearest.sim.toFixed(2)}` });
    }

    // 4. Genuinely new — create checkpoint
    const checkpointId = nextCheckpointId(sessionId, this.stateDir);
    const checkpoint: StoredCheckpoint = {
      checkpointId,
      sessionId,
      summary: input.summary,
      topicSummary: input.topicSummary,
      summaryHash,
      keyDecisions: input.keyDecisions ?? [],
      nextSteps: input.nextSteps ?? [],
      filesModified: input.filesModified ?? [],
      tokenEstimate: input.tokenEstimate ?? 0,
      originalTokenEstimate: input.originalTokenEstimate,
      regionHash,
      contentHash: digest.contentHash,
      contentHash2: digest.contentHash2,
      contentHashVersion: digest.contentHashVersion,
      normalizedText: digest.normalizedText,
      compressedOriginal: compressSmart(
        Buffer.from(input.regionText, "utf-8"),
        input.compressionPressure,
      ),
      embedding,
      timestamp: input.timestamp,
    };
    // Persistence is SQLite (store/sqlite.ts). upsertCheckpoint keeps the
    // idempotent-by-id semantics the old JSON append implied.
    upsertCheckpoint(checkpoint, this.stateDir);
    // Cumulative "tokens saved" counter (per-repo SQLite meta). For a NEW
    // checkpoint the saved amount is (original − stored); for a deduped add the
    // whole original region is discarded (handled in the deduped return paths
    // below). Survives sessions and travels with the repo.
    const stored = input.tokenEstimate ?? 0;
    addTokensSaved(Math.max(0, origTokens - stored), this.stateDir);
    // L1: persist this checkpoint's MinHash signature + LSH buckets so future
    // near-duplicate inserts can find it. Deterministic given the seed.
    const sig = minhashSignature(input.regionText);
    upsertMinhashSignature(checkpointId, sessionId, SIGNATURE_VERSION, sig, this.stateDir);
    insertLshBuckets(
      checkpointId,
      sessionId,
      SIGNATURE_VERSION,
      lshBands(sig, sessionId, SIGNATURE_VERSION),
      this.stateDir,
    );
    // Bloom accelerator: record the new content_hash so a future add() can short-
    // circuit the scan on a hit (still confirmed by the SELECT-based `all` above).
    bloom.add(digest.contentHash);
    saveBloom(this.stateDir);

    // Track the region hash in session state for fast sentinel checks.
    const state = loadSessionState(sessionId, this.stateDir);
    if (!state.storedRegionHashes.includes(regionHash)) {
      state.storedRegionHashes.push(regionHash);
      saveSessionState(sessionId, state, this.stateDir);
    }
    // A new checkpoint. If a tier matched while MARK_ONLY, record that (the
    // decision fired but we intentionally did not collapse).
    if (markOnly) {
      this.record(markOnly, "mark_only", "mark_only", Date.now() - t0);
    } else {
      this.record("L0", "new", undefined, Date.now() - t0);
    }
    // Cumulative store-wide dedup accounting (attempt, not collapsed).
    bumpDedupStats(false, this.stateDir);
    onTier?.({ tier: "new", status: "stored" });
    return { checkpoint, deduped: false };
  }

  /**
   * L1 near-duplicate lookup: MinHash → LSH candidate retrieval → trigram verify.
   * Returns the matching checkpoint or undefined. Bounded by a 100-candidate cap
   * and a 20ms verify budget (QA #7/#15) so it never hangs a large session.
   */
  private findL1Duplicate(
    sessionId: string,
    regionText: string,
    all: StoredCheckpoint[],
  ): StoredCheckpoint | undefined {
    if (all.length === 0) return undefined;
    const sig = minhashSignature(regionText);
    if (sig.length !== NUM_HASHES) return undefined;
    const bands = lshBands(sig, sessionId, SIGNATURE_VERSION);
    // Cheap candidate retrieval (single query, capped). Exclude nothing yet —
    // the new checkpoint has no id, so pass a sentinel that never matches.
    const candidateIds = lshCandidateChunks(
      bands,
      sessionId,
      "__new__",
      this.stateDir,
      100,
    );
    if (candidateIds.length === 0) return undefined;
    const byId = new Map(all.map((cp) => [cp.checkpointId, cp]));
    const VERIFY_BUDGET_MS = 20;
    const start = Date.now();
    for (const id of candidateIds) {
      if (Date.now() - start > VERIFY_BUDGET_MS) break; // QA #15: abort → "not dup"
      const cand = byId.get(id);
      if (!cand) continue;
      const candText = cand.normalizedText ?? cand.summary ?? "";
      if (isNearDuplicate(regionText, candText)) return cand;
    }
    return undefined;
  }

  /**
   * Semantic search within a session's checkpoints. Returns top-K by cosine
   * similarity, diversified via MMR (QA #10) so a cluster of near-identical
   * hits yields at most a few distinct-relevance results.
   *
   * Heap-based top-K (QA #4, O(N log k)) replaces the old full sort; MMR then
   * reranks the candidate window for diversity.
   */
  search(sessionId: string, query: string, k = 3): SearchHit[] {
    const sid = normalizeSessionId(sessionId);
    const checkpoints = listCheckpoints(sid, this.stateDir).filter(
      (cp) => cp.dedupStatus !== "removed", // SemDeDup: exclude removed rows
    );
    if (checkpoints.length === 0) return [];
    const qv = this.embedder.embed(query);

    const scored: SearchHit[] = checkpoints.map((cp) => ({
      checkpoint: cp,
      score: cosineSimilarity(qv, cp.embedding),
    }));

    // Heap top-K over a widened window (2k) so MMR has diverse candidates.
    const window = topK(
      scored.map((h) => ({ item: h, score: h.score })),
      Math.max(k * 2, k),
    ).map((s) => s.item);
    // MMR (QA #10) is part of the L2 semantic tier: skip it when L2 is disabled
    // (Sprint 14 flag), returning the plain relevance-ranked window instead.
    if (!this.cfg.L2_ENABLED) return window.slice(0, k);
    const mmrItems: MmrItem<SearchHit>[] = window.map((h) => ({
      item: h,
      vector: h.checkpoint.embedding,
      relevance: h.score,
    }));
    const ranked = mmrRerank(mmrItems, k, this.cfg.MMR_LAMBDA);
    return ranked;
  }

  /**
   * SemDeDup offline cleanup (Sprint 12, QA #17): within a session, mark the
   * lower-quality row of any pair scoring cosine > `threshold` as
   * `dedup_status='removed'` (kept, not deleted — retrieval excludes it). Keeps
   * the row with the higher `tokenEstimate` (more context preserved). Runs as a
   * single scan; idempotent (re-running skips already-removed rows).
   *
   * Returns the number of rows marked removed.
   */
  semDedup(sessionId: string, threshold = this.cfg.SEMDEDUP_COSINE): number {
    const sid = normalizeSessionId(sessionId);
    const cps = listCheckpoints(sid, this.stateDir).filter(
      (c) => c.dedupStatus !== "removed",
    );
    let removed = 0;
    for (let i = 0; i < cps.length; i++) {
      for (let j = i + 1; j < cps.length; j++) {
        const a = cps[i];
        const b = cps[j];
        if (a.dedupStatus === "removed" || b.dedupStatus === "removed") continue;
        if (cosineSimilarity(a.embedding, b.embedding) > threshold) {
          // Keep the higher-tokenEstimate row; remove the other.
          const keep = a.tokenEstimate >= b.tokenEstimate ? a : b;
          const drop = keep === a ? b : a;
          setDedupStatus(drop.checkpointId, sid, "removed", this.stateDir);
          drop.dedupStatus = "removed";
          removed++;
        }
      }
    }
    return removed;
  }

  /**
   * Dedup sentinel check: has this region already been stored/represented?
   * Consulted by both the persist path and the recall/inline path.
   */
  dedupe(sessionId: string, regionHashOrText: string, isText = false): boolean {
    const sid = normalizeSessionId(sessionId);
    const hash = isText
      ? computeRegionHash(regionHashOrText)
      : regionHashOrText;
    const state = loadSessionState(sid, this.stateDir);
    if (state.storedRegionHashes.includes(hash)) return true;
    return listCheckpoints(sid, this.stateDir).some(
      (c) => c.regionHash === hash,
    );
  }

  /** Mark a checkpoint as injected into the window (recall dedup). */
  markInjected(sessionId: string, checkpointId: string): void {
    const sid = normalizeSessionId(sessionId);
    const state = loadSessionState(sid, this.stateDir);
    if (!state.injectedCheckpointIds.includes(checkpointId)) {
      state.injectedCheckpointIds.push(checkpointId);
      saveSessionState(sid, state, this.stateDir);
    }
  }

  /** True if this checkpoint was already injected this session. */
  wasInjected(sessionId: string, checkpointId: string): boolean {
    const state: SessionState = loadSessionState(
      normalizeSessionId(sessionId),
      this.stateDir,
    );
    return state.injectedCheckpointIds.includes(checkpointId);
  }

  /** Convenience for a raw vector cosine (exposed for tests). */
  similarity(a: Vector, b: Vector): number {
    return cosineSimilarity(a, b);
  }

  /** All checkpoints for a session (sorted by checkpointId). */
  list(sessionId: string): StoredCheckpoint[] {
    return listCheckpoints(normalizeSessionId(sessionId), this.stateDir);
  }

  /**
   * Return the n most similar checkpoints to the current (most recent) checkpoint
   * by cosine similarity. Returns fewer than n if the session has fewer checkpoints.
   * The current checkpoint itself is excluded from results.
   */
  topSimilar(sessionId: string, n: number): SearchHit[] {
    const sid = normalizeSessionId(sessionId);
    const checkpoints = listCheckpoints(sid, this.stateDir);
    if (checkpoints.length <= 1) return [];

    // Find the most recent checkpoint (by checkpointId, which is sequential)
    const ordered = [...checkpoints].sort((a, b) =>
      a.checkpointId.localeCompare(b.checkpointId),
    );
    const current = ordered[ordered.length - 1];

    // Score all other checkpoints by similarity to current
    const scored: SearchHit[] = ordered
      .filter((cp) => cp.checkpointId !== current.checkpointId)
      .map((cp) => ({
        checkpoint: cp,
        score: cosineSimilarity(current.embedding, cp.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, n);
  }

  /**
   * Store statistics for status reporting / logging. Returns counts + the last
   * (highest-numbered) checkpoint, or nulls when the session is empty.
   */
  stats(sessionId: string): {
    checkpointCount: number;
    totalTokenEstimate: number;
    lastCheckpointId: string | undefined;
    lastSummary: string | undefined;
    injectedCount: number;
    dedupHitRate: number; // injected / checkpoints, 0..1
    storageDedupRate: number; // deduped adds / total adds, 0..1 (cumulative)
    tokensSaved: number; // Σ(original − stored) for this session's checkpoints
    originalTokens: number; // Σ original region size for this session's checkpoints
    dedupAttempts: number; // cumulative add() calls (store-wide)
    dedupCollapsed: number; // cumulative deduped collapses (store-wide)
  } {
    const sid = normalizeSessionId(sessionId);
    const cps = listCheckpoints(sid, this.stateDir);
    const state = loadSessionState(sid, this.stateDir);
    const ordered = [...cps].sort((a, b) =>
      a.checkpointId.localeCompare(b.checkpointId),
    );
    const last = ordered[ordered.length - 1];
    const injected = state.injectedCheckpointIds.length;
    const ds = getDedupStats(this.stateDir);
    const sessionTok = cps.reduce((s, c) => s + (c.tokenEstimate ?? 0), 0);
    const sessionOrig = cps.reduce((s, c) => s + (c.originalTokenEstimate ?? 0), 0);
    // Per-session "tokens saved" = Σ(original − stored) over this session's
    // stored checkpoints. Deduped adds (whole region discarded, nothing stored)
    // are counted in the repo-wide meta counter via repoStats(); the per-session
    // DB sum here covers the rows that exist.
    const sessionSaved = cps.reduce(
      (s, c) => s + Math.max(0, (c.originalTokenEstimate ?? 0) - (c.tokenEstimate ?? 0)),
      0,
    );
    return {
      checkpointCount: cps.length,
      totalTokenEstimate: sessionTok,
      lastCheckpointId: last?.checkpointId,
      lastSummary: last?.summary,
      injectedCount: injected,
      dedupHitRate: cps.length === 0 ? 0 : injected / cps.length,
      storageDedupRate: ds.attempts === 0 ? 0 : ds.deduped / ds.attempts,
      tokensSaved: sessionSaved,
      originalTokens: sessionOrig,
      dedupAttempts: ds.attempts,
      dedupCollapsed: ds.deduped,
    };
  }

  /**
   * Repo-wide stats — aggregates every session in this store (one per repo).
   * Cumulative, resumable, cross-device. Surfaces the dashboard's "Repo …"
   * figures; distinct from {@link stats} (per-session).
   */
  repoStats(): ReturnType<typeof repoStatsFromStore> {
    return repoStatsFromStore(this.stateDir);
  }
  /** Data-safety invariant (Phase 0): regions retained vs bytes permanently deleted. */
  dataInvariant(): ReturnType<typeof dataInvariantStats> {
    return dataInvariantStats(this.stateDir);
  }
}
