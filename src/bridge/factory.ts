/**
 * bridge/factory.ts — `createMegaBridge(opts)` implementation.
 *
 * A thin, pi-agnostic wrapper over the engine's compaction / recall / memory /
 * fork / vector APIs. Stores are constructed lazily on first use (a consumer
 * that only calls recallMemories pays no VectorStore cost). Exceptions
 * propagate from every method except `fork` (catches ForkError by design) and
 * `close` (swallows best-effort cleanup), so failures surface in tests.
 */
import { compactSession } from "../engine.js";
import {
  recallAndInline,
  recallAndInlineAsync,
  recallMemoriesAndInline,
} from "../recall.js";
import type {
  RecallInjectOptions,
  RecallInjectResult,
  MemoryRecallInjectOptions,
} from "../recall/types.js";
import { forkFromConversation, ForkError } from "../fork.js";
import { createTurnStore } from "../store/turns/index.js";
import type { TurnStore, TurnEntry } from "../store/turns/types.js";
import { addMemory } from "../store/sqlite/memories.js";
import { VectorStore, vectorSearch } from "../vectorStore.js";
import type { SearchHit } from "../vectorStore.js";
import { repoKey } from "../store/repoKey.js";
import type {
  BridgeOptions,
  BridgeCompactInput,
  BridgeCompactResult,
  BridgeRecallOptions,
  BridgeRecallResult,
  BridgeMemoryRecallOptions,
  BridgeMemoryRecallResult,
  BridgeForkOptions,
  BridgeForkResult,
  BridgeCortexOptions,
  BridgeCortexResult,
  BridgeAddMemoryInput,
  BridgeRecordTurnInput,
  MegaBridge,
} from "./types.js";

/** Map a RecallInjectResult to the bridge's slimmer result contract. */
function mapRecallResult(r: RecallInjectResult): BridgeRecallResult {
  return {
    block: r.block,
    report: r.report,
    hitCount: r.toInject.length,
    empty: r.empty,
  };
}

/** Map the memoryRecallAndInline tuple result to the bridge contract. */
function mapMemoryResult(
  r: { empty: boolean; block: string; report: string[] },
): BridgeMemoryRecallResult {
  return {
    block: r.block,
    report: r.report,
    hitCount: r.report.length,
    empty: r.empty,
  };
}

/** Map vectorSearch hits to the cortex result contract. */
function mapCortexHits(hits: SearchHit[], limit: number): BridgeCortexResult {
  const top = hits.slice(0, limit);
  return {
    results: top.map((h) => ({
      checkpointId: h.checkpoint.checkpointId,
      score: h.score,
      summary: h.checkpoint.summary,
    })),
    hitCount: top.length,
  };
}

/**
 * Create a MegaBridge over a single stateDir.
 *
 * The VectorStore and TurnStore are lazy: constructed on first use and cached
 * in closures. The stateDir is retained for memory recall, which needs it
 * directly.
 */
export function createMegaBridge(opts: BridgeOptions): MegaBridge {
  const stateDir = opts.stateDir;
  let vectorStore: VectorStore | undefined;
  let turnStore: TurnStore | undefined;

  const getVectorStore = (): VectorStore => {
    if (!vectorStore) vectorStore = new VectorStore({ stateDir });
    return vectorStore;
  };
  const getTurnStore = (): TurnStore => {
    if (!turnStore) turnStore = createTurnStore({ stateDir });
    return turnStore;
  };

  return {
    compact(input: BridgeCompactInput): BridgeCompactResult {
      const result = compactSession(
        {
          sessionId: input.sessionId,
          messages: input.messages,
          keepFrom: input.keepFrom,
          summary: input.summary,
          keyDecisions: input.keyDecisions,
          nextSteps: input.nextSteps,
          filesModified: input.filesModified,
          compressionPressure: input.compressionPressure,
        },
        getVectorStore(),
      );
      return {
        skipped: result.skipped,
        deduped: result.deduped,
        summary: result.summary,
        checkpointId: result.checkpointId,
        tokenEstimate: result.tokenEstimate,
        originalTokenEstimate: result.originalTokenEstimate,
        compactedFrom: result.compactedFrom,
      };
    },

    recallCheckpoints(opts: BridgeRecallOptions): BridgeRecallResult {
      const recallOpts: RecallInjectOptions = {
        sessionId: opts.sessionId,
        query: opts.query,
        limit: opts.limit ?? 3,
        source: "command",
        skipInjected: opts.skipInjected,
        recallMaxTokens: opts.recallMaxTokens,
      };
      return mapRecallResult(recallAndInline(recallOpts, getVectorStore()));
    },

    async recallMemories(opts: BridgeMemoryRecallOptions): Promise<BridgeMemoryRecallResult> {
      const memOpts: MemoryRecallInjectOptions = {
        query: opts.query,
        stateDir,
        limit: opts.limit,
        minSimilarity: opts.minSimilarity,
        crossRepo: opts.crossRepo,
        crossRepoCosine: opts.crossRepoCosine,
        recallMaxTokens: opts.recallMaxTokens,
      };
      const r = await recallMemoriesAndInline(memOpts);
      return mapMemoryResult(r);
    },

    async recallAndInlineAsync(opts: BridgeRecallOptions): Promise<BridgeRecallResult> {
      const recallOpts: RecallInjectOptions = {
        sessionId: opts.sessionId,
        query: opts.query,
        limit: opts.limit ?? 3,
        source: "command",
        skipInjected: opts.skipInjected,
        recallMaxTokens: opts.recallMaxTokens,
      };
      const r = await recallAndInlineAsync(recallOpts, getVectorStore());
      return mapRecallResult(r);
    },

    fork(opts: BridgeForkOptions): BridgeForkResult {
      try {
        const outcome = forkFromConversation(
          getTurnStore(),
          opts.parentConversationId,
          opts.turnIndex,
        );
        return {
          childConversationId: outcome.childConversationId,
          checkpointIds: outcome.checkpointIds,
          forkTurnIndex: opts.turnIndex,
        };
      } catch (e) {
        if (e instanceof ForkError) {
          return { error: e.code };
        }
        // The bridge is pi-agnostic (no runtime handle) — the host-side adapter
        // (ithacus) owns the internal-error ring for fork failures, so this
        // re-thrown non-ForkError is recorded there, not here.
        // guardrails-allow INTERNAL-ERR: bridge is pi-agnostic; no runtime handle — host adapter records fork failures
        throw e;
      }
    },

    cortexQuery(opts: BridgeCortexOptions): BridgeCortexResult {
      const limit = opts.limit ?? 3;
      const scope = opts.repo ?? repoKey(stateDir);
      const hits = vectorSearch(getVectorStore(), scope, opts.query, limit);
      return mapCortexHits(hits, limit);
    },

    addMemory(input: BridgeAddMemoryInput): number | void {
      // repo === null ⇒ stateDir-scoped durable memory (matches recallMemories).
      return addMemory(
        {
          kind: input.kind,
          content: input.content,
          tags: input.tags,
          category: input.category,
        },
        null,
        stateDir,
      );
    },

    recordTurn(input: BridgeRecordTurnInput): void {
      // S49R: child turns get the conversation-monotonic index (MAX+1) so a
      // re-dispatched child (same conversation, restarted session counter) never
      // collides with UNIQUE(conversation_id, turn_index). Carry the child's
      // session counter as sessionTurnIndex for the raw_transcript join.
      const turnIndex = getTurnStore().asReader().nextTurnIndexFor(input.conversationId);
      const turn: TurnEntry = {
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnIndex,
        sessionTurnIndex: input.turnIndex,
        role: (input.role as TurnEntry["role"]) ?? "assistant",
        endedAt: input.endedAt ?? Date.now(),
        ctxTokens: input.ctxTokens,
        ctxPercent: input.ctxPercent,
        model: input.model,
      };
      // The bridge is pi-agnostic (no runtime handle); the host-side adapter
      // (ithacus) owns the internal-error ring for appendTurn failures. The
      // recordTurn child-path twin of Finding 2 is recorded there, not here.
      // guardrails-allow INTERNAL-ERR: bridge is pi-agnostic; no runtime handle — host adapter records appendTurn failures
      getTurnStore().asWriter().appendTurn(turn);
    },

    close(): void {
      if (turnStore) {
        try {
          turnStore.close();
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
