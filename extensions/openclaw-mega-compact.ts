/**
 * openclaw-mega-compact — OpenClaw plugin adapter for the pi-mega-compact engine.
 *
 * Wires the pi-agnostic Trident engine (src/) into OpenClaw's plugin lifecycle:
 *  - Registers a CompactionProvider that replaces the built-in summarizeInStages.
 *  - Exposes `mega_status` and `mega_recall` tools for on-demand inspection.
 *  - Hooks into `before_compaction` / `after_compaction` for diagnostics.
 *
 * Design constraints:
 *  - NO imports from `@earendil-works/pi-coding-agent` or pi-agent-core.
 *  - The engine core (src/) is pi-agnostic; this file is the sole OpenClaw boundary.
 *  - No network at runtime — everything is local (stores + extractive summarizer).
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CompactionProvider } from "openclaw/plugin-sdk/compaction-provider";

import {
  compactSession,
  setDefaultStore,
  type CompactInput,
  type CompactResult,
} from "../src/engine.js";
import { recallAndInline, recallMemoriesAndInline, type RecallInjectResult } from "../src/recall.js";
import { VectorStore } from "../src/vectorStore.js";
import type { EngineMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "mega-compact";
const PLUGIN_LABEL = "Mega Compact (Trident)";

/** Default state directory for vector store persistence. */
const STATE_DIR = process.env.MEGA_COMPACT_STATE_DIR ?? undefined;

/** Minimum messages before we bother compacting. */
const MIN_MESSAGES_FOR_COMPACT = 6;

// ---------------------------------------------------------------------------
// Message conversion — OpenClaw unknown[] → EngineMessage[]
// ---------------------------------------------------------------------------

/**
 * Best-effort conversion from OpenClaw's opaque message array to our
 * EngineMessage shape. OpenClaw messages are typed as `unknown[]` so we
 * handle whatever shape comes through gracefully.
 */
function toEngineMessages(messages: unknown[]): EngineMessage[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      // Primitive fallback — treat as custom text.
      return {
        role: "custom" as const,
        text: String(msg ?? ""),
      };
    }

    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "custom";

    // Normalize role to one of our four engine roles.
    let engineRole: EngineMessage["role"];
    switch (role) {
      case "user":
        engineRole = "user";
        break;
      case "assistant":
        engineRole = "assistant";
        break;
      case "tool":
      case "function":
        engineRole = "tool";
        break;
      default:
        engineRole = "custom";
        break;
    }

    // Extract text content from common message shapes.
    const text =
      typeof m.content === "string"
        ? m.content
        : typeof m.text === "string"
          ? m.text
          : Array.isArray(m.content)
            ? (m.content as Array<{ type?: string; text?: string }>)
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("\n")
            : "";

    // Preserve tool metadata when present.
    const toolName =
      typeof m.name === "string"
        ? m.name
        : typeof m.toolName === "string"
          ? m.toolName
          : undefined;

    const input =
      typeof m.input === "string"
        ? m.input
        : typeof m.arguments === "string"
          ? m.arguments
          : m.arguments !== undefined
            ? JSON.stringify(m.arguments)
            : undefined;

    const output =
      typeof m.output === "string"
        ? m.output
        : engineRole === "tool" && typeof m.content === "string"
          ? m.content
          : undefined;

    return { role: engineRole, text, toolName, input, output };
  });
}

// ---------------------------------------------------------------------------
// Compaction provider
// ---------------------------------------------------------------------------

function createCompactionProvider(store: VectorStore): CompactionProvider {
  return {
    id: PLUGIN_ID,
    label: PLUGIN_LABEL,

    async summarize({
      messages,
      signal,
      compressionRatio,
    }): Promise<string> {
      // Abort check — bail early if the caller cancelled.
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const engineMessages = toEngineMessages(messages);

      // Nothing meaningful to compact.
      if (engineMessages.length < MIN_MESSAGES_FOR_COMPACT) {
        return "";
      }

      // Map compression ratio → keepFrom boundary.
      // compressionRatio=0.5 means "compact the oldest 50%".
      // Default to compacting the oldest half if not specified.
      const ratio = compressionRatio ?? 0.5;
      const keepFrom = Math.max(
        MIN_MESSAGES_FOR_COMPACT,
        Math.floor(engineMessages.length * (1 - ratio)),
      );

      // Abort check after conversion (conversion is cheap but check anyway).
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const sessionId = `openclaw-${Date.now()}`;

      const input: CompactInput = {
        sessionId,
        messages: engineMessages,
        keepFrom,
      };

      const result: CompactResult = compactSession(input, store);

      if (result.skipped) {
        return "";
      }

      return result.summary;
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Mega Compact",
  description:
    "Layered, local, vector-backed context compressor (Trident engine) for OpenClaw compaction.",

  register(api: OpenClawPluginApi) {
    const logger = api.logger;

    // Resolve state directory — prefer plugin config override.
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const stateDir =
      typeof pluginCfg.stateDir === "string" && pluginCfg.stateDir.length > 0
        ? pluginCfg.stateDir
        : STATE_DIR;

    // Initialize vector store.
    let store: VectorStore;
    try {
      store = new VectorStore({ stateDir });
      setDefaultStore(store);
      logger.info?.(`${PLUGIN_ID}: vector store initialized (stateDir=${stateDir ?? "default"})`);
    } catch (err) {
      logger.error?.(`${PLUGIN_ID}: failed to init vector store:`, err);
      return; // Hard bail — no point registering if store is broken.
    }

    // -----------------------------------------------------------------------
    // Register compaction provider
    // -----------------------------------------------------------------------
    const provider = createCompactionProvider(store);

    api.registerCompactionProvider(provider);
    logger.info?.(`${PLUGIN_ID}: registered compaction provider "${provider.id}"`);

    // -----------------------------------------------------------------------
    // Hooks — before / after compaction diagnostics
    // -----------------------------------------------------------------------
    api.registerHook({
      event: "before_compaction",
      handler: async (ctx) => {
        const msgCount = Array.isArray(ctx?.messages) ? ctx.messages.length : 0;
        logger.info?.(`${PLUGIN_ID}: before_compaction — ${msgCount} messages in scope`);
      },
    });

    api.registerHook({
      event: "after_compaction",
      handler: async (ctx) => {
        const summaryLen =
          typeof ctx?.summary === "string" ? ctx.summary.length : 0;
        logger.info?.(
          `${PLUGIN_ID}: after_compaction — summary ${summaryLen} chars`,
        );
      },
    });

    // -----------------------------------------------------------------------
    // Tool: mega_status
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "mega_status",
      description:
        "Show the current status of the mega-compact engine: vector store stats, checkpoint count, and recent compaction activity.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Optional session ID to scope stats to.",
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const sessionId = (args as Record<string, string>)?.sessionId ?? "global";

        try {
          const stats = store.stats(sessionId);
          const parts: string[] = [
            `**Mega Compact Status**`,
            `Session: ${sessionId}`,
            `Checkpoints: ${stats.checkpointCount}`,
            `Total tokens saved: ${stats.totalTokenEstimate}`,
            `Last checkpoint: ${stats.lastCheckpointId ?? "—"}`,
            `Injected count: ${stats.injectedCount}`,
            `Dedup hit rate: ${(stats.dedupHitRate * 100).toFixed(0)}%`,
          ];

          if (stats.lastSummary) {
            parts.push(
              `\nLast summary (truncated):\n  ${stats.lastSummary.slice(0, 120).replace(/\n/g, " ")}…`,
            );
          }

          return { content: [{ type: "text", text: parts.join("\n") }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error reading mega-compact status: ${err}` }],
            isError: true,
          };
        }
      },
    });

    // -----------------------------------------------------------------------
    // Tool: mega_recall
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "mega_recall",
      description:
        "Recall and inline relevant context from the mega-compact vector store for the current session.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID to recall context for.",
          },
          query: {
            type: "string",
            description: "Natural language query for relevant context.",
          },
          limit: {
            type: "number",
            description: "Max checkpoints to recall (default 3).",
          },
        },
        required: ["sessionId", "query"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const { sessionId, query, limit } = args as {
          sessionId: string;
          query: string;
          limit?: number;
        };

        if (!sessionId || !query) {
          return {
            content: [{ type: "text", text: "Both `sessionId` and `query` are required." }],
            isError: true,
          };
        }

        try {
          const result: RecallInjectResult = recallAndInline(
            { sessionId, query, limit: limit ?? 3, source: "command", skipInjected: false },
            store,
          );

          // S21: parallel memory recall for the slash command. Same query so the
          // output combines checkpoint + memory context the user actually needs.
          let memBlock = "";
          let memReport: string[] = [];
          try {
            const mr = await recallMemoriesAndInline({ query, stateDir, limit: 5 });
            if (!mr.empty) {
              memBlock = mr.block;
              memReport = mr.report;
            }
          } catch {
            // best-effort — never break the command over memory recall
          }

          if (result.toInject.length === 0 && !memBlock) {
            return {
              content: [{ type: "text", text: "No relevant context found in the mega-compact store." }],
            };
          }

          const parts: string[] = [];
          if (result.toInject.length) {
            parts.push(`**Recalled ${result.toInject.length} checkpoint(s):**`, ...result.report, "");
          }
          if (memBlock) {
            parts.push(`**Recalled ${memReport.length} memory record(s):**`, ...memReport, "");
          }
          parts.push("---", result.block, memBlock);

          return { content: [{ type: "text", text: parts.join("\n") }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Error during mega-recall: ${err}` }],
            isError: true,
          };
        }
      },
    });

    // -----------------------------------------------------------------------
    // Cleanup on shutdown
    // -----------------------------------------------------------------------
    api.on("shutdown", () => {
      logger.info?.(`${PLUGIN_ID}: shutting down — clearing default store`);
      setDefaultStore(undefined);
    });

    logger.info?.(`${PLUGIN_ID}: plugin registered (tools: mega_status, mega_recall)`);
  },
});
