/**
 * mega-teamrun.test.ts — regression test for the "auto-compact runs but context
 * never relieves during a team run (sub-agents)" bug.
 *
 * Loads the REAL compiled extension (extensions/mega-compact.js) through a
 * faithful mock pi (mirrors mega-compact.test.ts's harness) and drives the
 * exact event sequence a long team run produces:
 *
 *   agent_start -> context (over threshold) xN -> agent_end   (repeat x3)
 *
 * Asserts the TWO fixes:
 *   1. live trim FIRES per-call (computeLiveTrimCut no longer returns null on
 *      the anchor floor — was `cutNull`, liveTrimFires===0 before the fix).
 *   2. the DURABLE trim fires at agent_end while idle + over threshold
 *      (mid-run durable trigger), not only at parent settle.
 *
 * The mock ctx.compact() drives session_before_compact so we observe the
 * durable truncation. Counters come from MegaRuntime.diag* (set behind the
 * real handler code, inert in production).
 *
 * MEGACOMPACT_PGLITE_DISABLED keeps the run fast (no WASM index init).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeVectorIndex } from "../src/store/vectorIndex.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-team-"));
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
process.env.MEGACOMPACT_PGLITE_DISABLED = "true"; // fast: skip WASM index
let counter = 0;

function harness() {
  const stateDir = join(baseTmp, `run-${counter++}`);
  process.env.MEGACOMPACT_STATE_DIR = stateDir;
  process.env.MEGACOMPACT_DEBUG = "true";
  process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
  process.env.MEGACOMPACT_FAST_GATE_PCT = "1";
  // Strict race-guard mode double-counts diagAgentEndDurable (sync++ at branch
  // entry + deferred++ in the setTimeout(500) callback = 6, not 3), lands
  // compactCalls after the synchronous assertions, and leaks timers that hang
  // `node --test`. The strict deferred path is covered by the two S38.5 tests
  // in mega-compact.test.ts. Use the synchronous v0.7.4 path here.
  process.env.MEGACOMPACT_RACE_GUARD_STRICT = "false";
  process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
  process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0"; // piCompactWouldNoop must not skip
  process.env.MEGACOMPACT_MEMORY_AUTO_REVIEW = "false";
  process.env.MEGACOMPACT_RAPTOR_ENABLED = "false";
  delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;

  const handlers: Record<string, Function> = {};
  const compactCalls: any[] = [];

  function msg(role: string, text: string, toolName?: string): AgentMessage {
    if (role === "assistant" && toolName) {
      return { role: "assistant", content: [{ type: "toolCall", name: toolName, id: "c1", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", timestamp: 0 } as unknown as AgentMessage;
    }
    if (role === "toolResult" && toolName) {
      return { role: "toolResult", content: [{ type: "text", text }], toolCallId: "c1", toolName, isError: false, timestamp: 0 } as unknown as AgentMessage;
    }
    return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
  }

  const session: AgentMessage[] = [];
  for (let i = 0; i < 14; i++) {
    session.push(msg("user", `actually we decided to use approach ${i} for module ${i}`));
    session.push(msg("assistant", `edited module ${i}`, "Edit"));
    session.push(msg("toolResult", `edited module ${i}`, "Edit"));
  }

  const toEntry = (m: AgentMessage, i: number): any => ({ type: "message", id: `e${i}`, parentId: null, timestamp: String(i), message: m });
  const sessionManager = {
    getSessionId: () => "sess_team_001",
    getEntries: () => session.map(toEntry),
    getBranch: () => session.map(toEntry),
  };

  function makeCtx(over: Partial<any> = {}) {
    return {
      ui: { setStatus: () => {}, notify: () => {}, select: () => {}, confirm: async () => true, input: async () => "", setWidget: () => {} },
      mode: "tui" as any, hasUI: true, cwd: stateDir, sessionManager,
      modelRegistry: {} as any, model: undefined, isIdle: () => true, isProjectTrusted: () => true,
      signal: undefined, abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
      getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
      // Mock ctx.compact() runs pi's flow and fires session_before_compact.
      compact: (opts?: any) => {
        compactCalls.push(opts);
        if (handlers["session_before_compact"]) {
          return handlers["session_before_compact"](
            { type: "session_before_compact", reason: "threshold", willRetry: false, signal: undefined, preparation: { firstKeptEntryId: "e2", messagesToSummarize: session.slice(0, 2), tokensBefore: 500 } } as any,
            makeCtx(),
          );
        }
        return undefined;
      },
      getSystemPrompt: () => "system base",
      ...over,
    } as any;
  }

  const pi = {
    on: (ev: string, h: Function) => { handlers[ev] = h; },
    registerCommand: () => {}, registerTool: () => {}, registerShortcut: () => {},
    registerFlag: () => {}, getFlag: () => undefined, registerMessageRenderer: () => {},
    registerEntryRenderer: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
    appendEntry: () => {}, setSessionName: () => {}, getSessionName: () => undefined,
    setLabel: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},
    getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off" as any,
    setThinkingLevel: () => {},
  } as any;

  const mod = require("./mega-compact.js") as { default: (p: any) => void };
  mod.default(pi);
  const { lastRuntime } = require("./mega-events.js") as { lastRuntime: any };

  const fire = (ev: string, event: any, ctx: any) => handlers[ev](event, ctx);
  return {
    stateDir, handlers, compactCalls, fire, ctx: makeCtx, session,
    runtime: lastRuntime, // MegaRuntime with diag* counters
    // Advance the debounce so agent_end (same instant) can trigger durable trim.
    clearDebounce: () => { if (lastRuntime) lastRuntime.debounceUntil = 0; },
  };
}

test("team run: live trim fires AND durable trim fires per sub-agent (relieves context)", async () => {
  const h = harness();
  const ctx = h.ctx();
  for (let a = 0; a < 3; a++) {
    await h.fire("agent_start", { type: "agent_start", messages: [] }, ctx);
    for (let i = 0; i < 4; i++) {
      await h.fire("context", { type: "context", messages: h.session }, ctx);
    }
    // Real team runs settle seconds after the last context event; mimic that
    // so the 2s debounce has elapsed and the durable trigger can fire.
    await new Promise((r) => setTimeout(r, 2100));
    h.clearDebounce();
    await h.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
  }
  const rt = h.runtime;
  // FIX 1: live trim must actually fire (was 0 — computeLiveTrimCut returned null).
  assert.ok(rt.diagLiveTrimFires > 0, "live trim fires during the team run (anchor-floor fix)");
  assert.equal(rt.diagCtxCutNull, 0, "no live-trim cut skipped on anchor floor");
  // FIX 2: durable trim must fire at each agent_end (was 0 — only at parent settle).
  assert.equal(rt.diagAgentEndDurable, 3, "mid-run durable trigger fired at each agent_end");
  assert.equal(rt.diagBeforeCompactSupplied, 3, "our durable trim supplied 3x (context relieved)");
  assert.ok(h.compactCalls.length >= 3, "ctx.compact() invoked for durable trim between sub-agents");
});

test("control: session_before_compact supplies a durable compaction (parent settles)", async () => {
  const h = harness();
  const res = await h.fire(
    "session_before_compact",
    { type: "session_before_compact", reason: "threshold", willRetry: false, signal: undefined, preparation: { firstKeptEntryId: "e2", messagesToSummarize: h.session.slice(0, 4), tokensBefore: 500 } } as any,
    h.ctx(),
  );
  assert.ok(res?.compaction, "compaction result returned to pi");
  assert.equal(res.compaction.firstKeptEntryId, "e2", "reuses pi's boundary (PREVENT-PI-002)");
});

test("cleanup", async () => {
  // Race closeVectorIndex with a timeout to prevent 40-min hangs.
  try {
    await Promise.race([
      closeVectorIndex(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } catch { /* ignore */ }
  rmSync(baseTmp, { recursive: true, force: true });
});
