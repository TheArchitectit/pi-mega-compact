/**
 * mega-compact.extension.test.ts — end-to-end drive of the REAL extension
 * entry (extensions/mega-compact.ts) through a faithful mock pi.
 *
 * This is the closest we get to "a live pi session" without a model: it
 * loads the compiled extension, captures its event/command handlers, and
 * fires them with mock ctx objects — proving the three compact layers
 * (auto-trigger -> compactSession) AND the three recall entries all
 * route through the real code, not just the unit-tested src/ modules.
 *
 * Uses a per-test isolated state dir (process.env.MEGACOMPACT_STATE_DIR)
 * so concurrent node --test runs do not collide on disk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-ext-"));
let counter = 0;

/** Build a mock pi + ctx and load the extension into them. */
function harness() {
  const stateDir = join(baseTmp, `run-${counter++}`);
  process.env.MEGACOMPACT_STATE_DIR = stateDir;
  process.env.MEGACOMPACT_DEBUG = "true";
  // Low threshold so the auto-trigger gate trips on our small mock context.
  process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
  process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: (a: string, c: any) => Promise<void> }> = {};
  const appended: any[] = [];
  let statusKey: string | undefined;
  let statusText: string | undefined;
  const notifies: string[] = [];

  // Minimal AgentMessage factory for the session we project into the extension.
  function msg(role: string, text: string, toolName?: string): AgentMessage {
    if (role === "assistant" && toolName) {
      return { role: "assistant", content: [{ type: "toolCall", name: toolName, id: "c1", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", timestamp: 0 } as unknown as AgentMessage;
    }
    if (role === "toolResult" && toolName) {
      return { role: "toolResult", toolCallId: "c1", toolName, content: [{ type: "text", text }], isError: false, timestamp: 0 } as unknown as AgentMessage;
    }
    return { role: "user", content: text, timestamp: 0 } as unknown as AgentMessage;
  }

  const session: AgentMessage[] = [
    msg("user", "read src/vec.ts and understand the index"),
    msg("assistant", "ok", "Read"),
    msg("user", "edit src/vec.ts to add a cosine helper"),
    msg("assistant", "ok", "Edit"),
    msg("user", "now fix the dedupe bug in store.ts"),
    msg("assistant", "ok", "Edit"),
    msg("user", "actually we should add recall sorting too"),
    msg("assistant", "ok", "Edit"),
  ];

  // Mirror the REAL SessionManager: getEntries() returns SessionEntry objects,
  // which the extension projects to messages via the SDK's
  // sessionEntryToContextMessages(entry). The harness must use the same shape
  // (type:"message" with a .message) or recentUserQuery() silently queries "".
  const toEntry = (m: AgentMessage, i: number): any => ({
    type: "message",
    id: `e${i}`,
    parentId: null,
    timestamp: String(i),
    message: m,
  });
  const sessionManager = {
    getSessionId: () => "sess_ext_001",
    getEntries: () => session.map(toEntry),
  };

  function makeCtx(over: Partial<any> = {}) {
    return {
      ui: {
        setStatus: (k: string, t: string | undefined) => { statusKey = k; statusText = t; },
        notify: (s: string) => notifies.push(s),
        select: () => {},
        confirm: async () => true,
        input: async () => "",
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
      getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
      compact: () => {},
      getSystemPrompt: () => "system base",
      ...over,
    } as any;
  }

  const pi = {
    on: (ev: string, h: Function) => { handlers[ev] = h; },
    registerCommand: (name: string, opts: any) => { commands[name] = opts; },
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: (_m: any) => {},
    sendUserMessage: () => {},
    appendEntry: (t: string, d: any) => appended.push({ t, d }),
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

  // Import the compiled extension (same dist/extensions dir as this test).
  const mod = require("./mega-compact.js") as { default: (p: any) => void };
  mod.default(pi);

  return {
    stateDir, handlers, commands, appended, get status() { return { statusKey, statusText }; }, notifies,
    fire: (ev: string, event: any, ctx: any) => handlers[ev](event, ctx),
    ctx: makeCtx,
    session,
  };
}

test("auto-trigger: past threshold persists a chkpt and drops context", async () => {
  const h = harness();
  const messages = h.session;
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
  const res = await h.fire("context", { type: "context", messages }, ctx);
  // L1->L4 ran: a checkpoint file + a marker entry were written.
  assert.ok(existsSync(join(h.stateDir, "sess_ext_001.checkpoints.json.gz")), "checkpoint persisted to local vector db");
  assert.equal(h.appended.some((a) => a.t === "mega-compact-marker"), true, "marker sentinel appended");
  // Context dropped (the compacted range was trimmed).
  assert.ok(res && Array.isArray(res.messages), "context handler returns filtered messages");
  assert.ok((res.messages as any[]).length < messages.length, "outgoing context shrank");
});

test("session_before_compact cancels once we've persisted", async () => {
  const h = harness();
  const ctx = h.ctx();
  // First fire the auto-trigger so a checkpoint is persisted this session.
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  // Now pi tries to compact natively — we must cancel (no double-compact).
  const res = await h.fire("session_before_compact", { type: "session_before_compact", reason: "overflow", willRetry: true, preparation: {}, signal: undefined } as any, ctx);
  assert.deepEqual(res, { cancel: true });
});

test("session_before_compact does NOT cancel when nothing persisted", async () => {
  const h = harness();
  const ctx = h.ctx();
  // Do NOT fire context first; this session has no checkpoint.
  const res = await h.fire("session_before_compact", { type: "session_before_compact", reason: "threshold", willRetry: false, preparation: {}, signal: undefined } as any, ctx);
  assert.deepEqual(res, {});
});

test("resume auto-inline stages recall into the system prompt", async () => {
  const h = harness();
  // Seed a checkpoint first (simulate a prior session that compacted).
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  // Fresh resume: session_start with reason "resume".
  const ctx = h.ctx();
  await h.fire("session_start", { type: "session_start", reason: "resume", previousSessionFile: undefined } as any, ctx);
  // The next before_agent_start must prepend the recalled block.
  const res = await h.fire("before_agent_start", { type: "before_agent_start", prompt: "base system", images: undefined, systemPrompt: "base system", systemPromptOptions: {} } as any, ctx);
  assert.ok(res && typeof res.systemPrompt === "string", "before_agent_start returns a systemPrompt");
  assert.ok(res.systemPrompt.includes("Recalled context"), "recalled block injected into system prompt");
});

test("/recall-context reports and stages the top checkpoint", async () => {
  const h = harness();
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  const ctx = h.ctx();
  await h.commands["recall-context"].handler("dedupe bug store.ts", ctx);
  assert.ok(h.notifies.some((n) => n.includes("recall staged")), "command reports staged checkpoints");
  assert.ok(h.notifies.some((n) => n.includes("chkpt_")), "command names the checkpoint");
});

test("/megacompact-status reports live store stats", async () => {
  const h = harness();
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }) });
  await h.commands["megacompact-status"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("store:") && n.includes("chkpt")), "status shows checkpoint count");
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
