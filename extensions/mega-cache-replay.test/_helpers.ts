/**
 * Shared helpers for the mega-cache-replay.test split files.
 * Extracted from extensions/mega-cache-replay.test.ts: baseTmp, env, harness().
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const baseTmp = mkdtempSync(join(tmpdir(), "mc-cache-"));

let counter = 0;

export function setupEnv(): void {
  process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
  process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
}

export function harness() {
  const stateDir = join(baseTmp, `run-${counter++}`);
  process.env.MEGACOMPACT_STATE_DIR = stateDir;
  process.env.MEGACOMPACT_DEBUG = "true";
  process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
  process.env.MEGACOMPACT_FAST_GATE_PCT = "1";
  process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
  process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
  process.env.MEGACOMPACT_MEMORY_AUTO_REVIEW = "false";
  process.env.MEGACOMPACT_RAPTOR_ENABLED = "false";
  process.env.MEGACOMPACT_L1_ENABLED = "false";
  process.env.MEGACOMPACT_L2_ENABLED = "false";
  delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;

  const usage = {
    tokens: 200000,
    contextWindow: 200000,
    percent: 100 as number | null,
  };

  const handlers: Record<string, Function[]> = {};
  const compactCalls: any[] = [];

  function msg(role: string, text: string, toolName?: string): AgentMessage {
    if (role === "assistant" && toolName) {
      return {
        role: "assistant",
        content: [
          { type: "toolCall", name: toolName, id: "c1", arguments: {} },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: "tool_use",
        timestamp: 0,
      } as unknown as AgentMessage;
    }
    if (role === "toolResult" && toolName) {
      return {
        role: "toolResult",
        content: [{ type: "text", text }],
        toolCallId: "c1",
        toolName,
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage;
    }
    return {
      role: "user",
      content: text,
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  function buildSession(tag: string, n: number): AgentMessage[] {
    const s: AgentMessage[] = [];
    for (let i = 0; i < n; i++) {
      s.push(
        msg("user", `[${tag}] we decided to use approach ${i} for module ${i}`),
      );
      s.push(msg("assistant", `[${tag}] edited module ${i}`, "Edit"));
      s.push(msg("toolResult", `[${tag}] edited module ${i}`, "Edit"));
    }
    return s;
  }

  const toEntry = (m: AgentMessage, i: number): any => ({
    type: "message",
    id: `e${i}`,
    parentId: null,
    timestamp: String(i),
    message: m,
  });
  const sessionManager = {
    getSessionId: () => "sess_cache_001",
    getEntries: () => buildSession("A", 14).map(toEntry),
    getBranch: () => buildSession("A", 14).map(toEntry),
  };

  function makeCtx(over: Partial<any> = {}) {
    return {
      ui: {
        setStatus: () => {},
        notify: () => {},
        select: () => {},
        confirm: async () => true,
        input: async () => "",
        setWidget: () => {},
      },
      mode: "tui" as any,
      hasUI: true,
      cwd: stateDir,
      sessionManager,
      modelRegistry: {} as any,
      model: undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => ({ ...usage }),
      compact: (opts?: any) => {
        compactCalls.push(opts);
        return undefined;
      },
      getSystemPrompt: () => "system base",
      ...over,
    } as any;
  }

  const pi = {
    on: (ev: string, h: Function) => {
      if (!handlers[ev]) handlers[ev] = [];
      handlers[ev].push(h);
    },
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off" as any,
    setThinkingLevel: () => {},
  } as any;

  const require = createRequire(import.meta.url);
  const mod = require("../mega-compact.js") as { default: (p: any) => void };
  mod.default(pi);
  const { lastRuntime } = require("../mega-events.js") as { lastRuntime: any };

  const fire = async (ev: string, event: any, ctx: any) => {
    let r: any;
    for (const h of handlers[ev] || []) r = await h(event, ctx);
    return r;
  };
  return {
    stateDir,
    handlers,
    compactCalls,
    fire,
    ctx: makeCtx,
    usage,
    buildSession,
    runtime: lastRuntime,
    clearDebounce: () => {
      if (lastRuntime) lastRuntime.debounceUntil = 0;
    },
  };
}
