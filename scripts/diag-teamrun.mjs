// scripts/diag-teamrun.mjs — fast headless reproduction of the "auto-compact
// runs but context never relieves during a team run" bug.
//
// Runs the REAL handler logic (src extensions/mega-events.ts) via jiti against
// a mock pi, with MEGACOMPACT_PGLITE_DISABLED so the slow WASM index never
// inits. No node --test, no dist build, exits fast.
//
// Usage: node scripts/diag-teamrun.mjs
import { createJiti } from "jiti";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- env: keep the run cheap + deterministic ----
process.env.MEGACOMPACT_PGLITE_DISABLED = "true";
process.env.MEGACOMPACT_DEBUG = "true";
process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
process.env.MEGACOMPACT_FAST_GATE_PCT = "1";
process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
process.env.MEGACOMPACT_MEMORY_AUTO_REVIEW = "false"; // skip review work
process.env.MEGACOMPACT_RAPTOR_ENABLED = "false"; // skip tree build
process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0"; // make piCompactWouldNoop() not skip (simulate large transcript)
delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
const stateDir = mkdtempSync(join(tmpdir(), "mc-diag-"));
process.env.MEGACOMPACT_STATE_DIR = stateDir;

const jiti = createJiti(import.meta.url);
const { MegaRuntime } = await jiti.import("../extensions/mega-runtime.ts", { default: false });
const { loadConfig } = await jiti.import("../extensions/mega-config.ts", { default: false });
const { registerEventHandlers, lastRuntime } = await jiti.import("../extensions/mega-events.ts", { default: false });

function msg(role, text, toolName) {
  if (role === "assistant" && toolName)
    return { role: "assistant", content: [{ type: "toolCall", name: toolName, id: "c1", arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", timestamp: 0 };
  if (role === "toolResult" && toolName)
    return { role: "toolResult", content: [{ type: "text", text }], toolCallId: "c1", toolName, isError: false, timestamp: 0 };
  return { role: "user", content: text, timestamp: 0 };
}

const session = [];
for (let i = 0; i < 14; i++) {
  session.push(msg("user", `actually we decided to use approach ${i} for module ${i}`));
  session.push(msg("assistant", `edited module ${i}`, "Edit"));
  session.push(msg("toolResult", `edited module ${i}`, "Edit"));
}
const toEntry = (m, i) => ({ type: "message", id: `e${i}`, parentId: null, timestamp: String(i), message: m });
const sessionManager = {
  getSessionId: () => "sess_team_001",
  getEntries: () => session.map(toEntry),
  getBranch: () => session.map(toEntry),
};

const handlers = {};
let beforeCompactDriven = 0;
let rtRef = undefined; // set after runtime is constructed
function makeCtx(over = {}) {
  return {
    ui: { setStatus: () => {}, notify: () => {}, select: () => {}, confirm: async () => true, input: async () => "", setWidget: () => {} },
    mode: "tui", hasUI: true, cwd: stateDir, sessionManager,
    modelRegistry: {}, model: undefined, isIdle: () => true, isProjectTrusted: () => true,
    signal: undefined, abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
    getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
    compact: () => {
      beforeCompactDriven++;
      // Simulate pi's durable trim: the transcript is truncated, so context
      // drops below threshold and the debounce is cleared (so the next agent
      // that goes over threshold can trigger again).
      if (rtRef) { rtRef.lastCtxTokens = 1000; rtRef.debounceUntil = 0; }
      if (handlers["session_before_compact"]) {
        return handlers["session_before_compact"]({
          type: "session_before_compact", reason: "threshold", willRetry: false, signal: undefined,
          preparation: { firstKeptEntryId: "e2", messagesToSummarize: session.slice(0, 2), tokensBefore: 500 },
        }, makeCtx());
      }
      return undefined;
    },
    getSystemPrompt: () => "system base",
    ...over,
  };
}

const pi = {
  on: (ev, h) => { handlers[ev] = h; },
  registerCommand: () => {}, registerTool: () => {}, registerShortcut: () => {},
  registerFlag: () => {}, getFlag: () => undefined, registerMessageRenderer: () => {},
  registerEntryRenderer: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
  appendEntry: () => {}, setSessionName: () => {}, getSessionName: () => undefined,
  setLabel: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},
  getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off",
  setThinkingLevel: () => {},
};

const config = loadConfig();
const runtime = new MegaRuntime(config);
rtRef = runtime;
registerEventHandlers(pi, runtime, config);

const fire = (ev, event, ctx) => handlers[ev](event, ctx);
const ctx = makeCtx();

// ---- drive a team run: 3 sub-agents, all while over threshold ----
let lastCtx = undefined;
for (let a = 0; a < 3; a++) {
  await fire("agent_start", { type: "agent_start", messages: [] }, ctx);
  for (let i = 0; i < 4; i++) lastCtx = await fire("context", { type: "context", messages: session }, ctx);
  // Real team runs settle seconds after the last context event, so the 2s
  // debounce has elapsed by agent_end. Sleep past it to exercise the trigger.
  await new Promise((r) => setTimeout(r, 2100));
  await fire("agent_end", { type: "agent_end", messages: [] }, ctx);
}

const rt = runtime;
const out = {
  liveTrimFires: rt.diagLiveTrimFires,
  fastGate: rt.diagCtxFastGate,
  noCompact: rt.diagCtxNoCompact,
  debounce: rt.diagCtxDebounce,
  runSkipped: rt.diagCtxRunSkipped,
  cutNull: rt.diagCtxCutNull,
  thrown: rt.diagCtxThrown,
  beforeCompactFires: rt.diagBeforeCompactFires,
  beforeCompactSupplied: rt.diagBeforeCompactSupplied,
  agentEndIdle: rt.diagAgentEndIdle,
  agentEndDurable: rt.diagAgentEndDurable,
  lastCtxReturn: lastCtx === undefined ? "undefined" : (Array.isArray(lastCtx?.messages) ? `trim(${lastCtx.messages.length})` : typeof lastCtx),
  lastCtxTokens: rt.lastCtxTokens,
  persistedThisSession: rt.rt.persistedThisSession,
};
console.log("TEAMRUN_DIAG " + JSON.stringify(out));

// ---- control: drive session_before_compact once (parent settles) ----
const ctrl = await fire("session_before_compact", {
  type: "session_before_compact", reason: "threshold", willRetry: false, signal: undefined,
  preparation: { firstKeptEntryId: "e2", messagesToSummarize: session.slice(0, 4), tokensBefore: 500 },
}, makeCtx());
console.log("CONTROL_DIAG " + JSON.stringify({
  beforeCompactFires: runtime.diagBeforeCompactFires,
  beforeCompactSupplied: runtime.diagBeforeCompactSupplied,
  suppliedCompaction: !!ctrl?.compaction,
}));
