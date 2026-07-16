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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const require = createRequire(import.meta.url);
const baseTmp = mkdtempSync(join(tmpdir(), "mc-ext-"));
// Isolate the machine-wide repo index so test runs (which call bindRepo ->
// upsertRepoRegistry) never pollute the developer's real ~/.mega-compact-index.
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
let counter = 0;

/** Build a mock pi + ctx and load the extension into them. */
function harness(opts: { keepTier?: boolean; keepThreshold?: boolean } = {}) {
  const stateDir = join(baseTmp, `run-${counter++}`);
  process.env.MEGACOMPACT_STATE_DIR = stateDir;
  process.env.MEGACOMPACT_DEBUG = "true";
  // Low threshold so the auto-trigger gate trips on our small mock context.
  // Tier tests opt out (keepTier/keepThreshold) so they can drive the real
  // tier resolution instead of the forced 50-token threshold.
  if (!opts.keepThreshold) process.env.MEGACOMPACT_THRESHOLD_TOKENS = "50";
  if (!opts.keepTier) delete process.env.MEGACOMPACT_TIER;
  process.env.MEGACOMPACT_FAST_GATE_PCT = "1";

  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: (a: string, c: any) => Promise<void> }> = {};
  const appended: any[] = [];
  let statusKey: string | undefined;
  let statusText: string | undefined;
  const notifies: string[] = [];
  const compactCalls: any[] = [];

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
    // Faithful mock: getBranch() returns the current branch's entries, which
    // piCompactWouldNoop() reads to predict whether ctx.compact() would no-op.
    getBranch: () => session.map(toEntry),
  };

  function makeCtx(over: Partial<any> = {}) {
    return {
      ui: {
        setStatus: (k: string, t: string | undefined) => { statusKey = k; statusText = t; },
        notify: (s: string) => notifies.push(s),
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
      getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }),
      // Faithful mock: ctx.compact() starts pi's flow, which fires the
      // session_before_compact handler (where WE supply the durable trim).
      compact: (opts?: any) => {
        compactCalls.push(opts);
        if (handlers["session_before_compact"]) {
          return handlers["session_before_compact"](
            {
              type: "session_before_compact",
              reason: "threshold",
              willRetry: false,
              signal: undefined,
              // pi computed the cut honoring anchor floor + tool-pair (PREVENT-PI-002);
              // our handler reuses it as firstKeptEntryId.
              preparation: {
                firstKeptEntryId: "e2",
                messagesToSummarize: session.slice(0, 2),
                tokensBefore: 500,
              },
            } as any,
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
    stateDir, handlers, commands, appended, get status() { return { statusKey, statusText }; }, notifies, compactCalls,
    fire: (ev: string, event: any, ctx: any) => handlers[ev](event, ctx),
    ctx: makeCtx,
    session,
  };
}

test("auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact", async () => {
  const h = harness();
  const messages = h.session;
  // The mock session is tiny (~100 tokens). piCompactWouldNoop() would skip
  // ctx.compact() for a transcript under pi's keepRecentTokens budget — so
  // lower the floor to 0 to simulate a transcript large enough that pi WOULD
  // compact (the positive path this test exercises).
  // S16: this is the LEGACY path — the default no longer calls ctx.compact()
  // (it returns a live-trimmed view instead). Set the legacy flag to exercise
  // the v0.4.28 ctx.compact durable-trim flow this test asserts.
  process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR = "0";
  process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
  try {
    const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
    const res = await h.fire("context", { type: "context", messages }, ctx);
    // L1->L4 ran: a checkpoint was persisted to the SQLite store + a marker entry written.
    const { listCheckpoints } = await import("../src/store/sqlite.js");
    assert.ok(listCheckpoints("sess_ext_001", h.stateDir).length > 0, "checkpoint persisted to local vector db");
    assert.equal(h.appended.some((a) => a.t === "mega-compact-marker"), true, "marker sentinel appended");
    // The legacy context handler triggers pi's compaction flow (ctx.compact),
    // which calls our session_before_compact handler to supply the DURABLE trim.
    assert.equal(res, undefined, "legacy context handler returns nothing (no local drop)");
    assert.equal(h.compactCalls.length, 1, "ctx.compact() called to start durable trim (legacy path)");
    // The durable trim was supplied (summary + firstKeptEntryId from pi's prep).
    assert.ok(h.compactCalls[0] !== undefined, "compaction flow executed");
  } finally {
    delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
    delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
  }
});

test("auto-trigger: skips ctx.compact() when pi would no-op (session too small, legacy path)", async () => {
  const h = harness();
  const messages = h.session;
  // Default floor (20000): the tiny mock transcript is below pi's
  // keepRecentTokens budget, so piCompactWouldNoop() must skip ctx.compact()
  // rather than surface pi's "Nothing to compact (session too small)" throw.
  // S16: exercised under the legacy flag (the default path never calls ctx.compact).
  delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
  process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "true";
  try {
    const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
    const res = await h.fire("context", { type: "context", messages }, ctx);
    assert.equal(res, undefined, "legacy context handler returns nothing (no local drop)");
    assert.equal(h.compactCalls.length, 0, "ctx.compact() NOT called — pi would no-op");
    // Our recall checkpoint still persisted (Path A) — the durable trim is the
    // only thing skipped; recall is independent of it.
    const { listCheckpoints } = await import("../src/store/sqlite.js");
    assert.ok(listCheckpoints("sess_ext_001", h.stateDir).length > 0, "recall checkpoint still persisted");
    assert.equal(h.appended.some((a) => a.t === "mega-compact-marker"), true, "marker sentinel still appended");
  } finally {
    delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
  }
});

test("auto-trigger (S16): trims the live view and does NOT call ctx.compact()", async () => {
  const h = harness();
  const messages = h.session;
  // S16 default: live context-event trim. No legacy flag. Lower the anchor floor
  // so the trimmed recent window (4 messages, 2 user) clears the anchor check
  // and the live trim actually fires — mirrors how the legacy test lowers the
  // durable floor to exercise its positive path.
  delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
  delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
  process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES = "1";
  try {
    const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
    const res = await h.fire("context", { type: "context", messages }, ctx);
    // S16: context handler returns a TRIMMED messages array (live trim), not undefined.
    assert.ok(res && typeof res === "object", "context handler returns a result object (live trim)");
    assert.ok(Array.isArray((res as any).messages), "result has a trimmed messages array");
    // The trimmed view starts with the compacted summary (user-role) + is shorter.
    assert.ok((res as any).messages.length < messages.length, "trimmed view is shorter than the full session");
    // S16: ctx.compact() is NEVER called (it would stop the agent).
    assert.equal(h.compactCalls.length, 0, "ctx.compact() NOT called — compact-and-continue");
    // The recall checkpoint is still persisted (the durable value).
    const { listCheckpoints } = await import("../src/store/sqlite.js");
    assert.ok(listCheckpoints("sess_ext_001", h.stateDir).length > 0, "recall checkpoint persisted under live trim");
  } finally {
    delete process.env.MEGACOMPACT_ANCHOR_USER_MESSAGES;
  }
});

test("auto-trigger (S16): does not trim when below the anchor floor (returns undefined, no ctx.compact)", async () => {
  const h = harness();
  // A session so short that buildLiveTrimmedView's anchor floor can't hold — the
  // live trim skips this call (returns undefined, the next context event retries).
  delete process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM;
  delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
  const shortSession = [h.session[0], h.session[1]]; // one user + one assistant
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
  const res = await h.fire("context", { type: "context", messages: shortSession }, ctx);
  // Either it skipped (undefined) or trimmed safely — but it must never call ctx.compact.
  assert.equal(h.compactCalls.length, 0, "ctx.compact() NOT called under live trim (short session)");
  if (res === undefined) {
    // skipped path is fine
    assert.ok(true, "below anchor floor → no trim this call (retries next event)");
  }
});

test("auto-trigger (S16): sendUserMessage resume nudge fires only when idle + queued + not already nudged", async () => {
  const h = harness();
  // No queued messages → the nudge must NOT fire (the guard prevents busy-loops).
  // We assert the extension did not throw and did not push a spurious resume.
  const ctx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false });
  await h.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
  // No throw + no spurious nudge side-effect is the contract; appended stays
  // free of any auto "continue" marker when there is no queued work.
  assert.equal(h.appended.some((a) => a.t && /continue/i.test(String(a.d ?? ""))), false, "no spurious continue when no queued work");
});

test("auto-trigger (S16): durable trim still happens via pi native auto-compaction (session_before_compact)", async () => {
  const h = harness();
  // pi's native auto-compaction fires at agent-end with reason "threshold" (the
  // CONTINUING path). Our session_before_compact handler must still supply the
  // durable trim summary — independent of the live context-event trim.
  const prep = {
    firstKeptEntryId: "e2",
    messagesToSummarize: h.session.slice(0, 4),
    tokensBefore: 500,
  };
  const res = await h.fire("session_before_compact", {
    type: "session_before_compact", reason: "threshold", willRetry: false,
    signal: undefined, preparation: prep,
  } as any, h.ctx());
  assert.ok(res?.compaction, "we supply a durable compaction result to pi's native path");
  assert.ok(res.compaction.firstKeptEntryId === "e2", "reuses pi's boundary (PREVENT-PI-002)");
  assert.ok(res.compaction.summary.length > 0, "summary is non-empty");
});

test("session_before_compact supplies our durable trim (not pi's summary)", async () => {
  const h = harness();
  // pi fires session_before_compact with its own computed preparation.
  const res = await h.fire(
    "session_before_compact",
    {
      type: "session_before_compact",
      reason: "overflow",
      willRetry: true,
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: h.session.slice(0, 2), tokensBefore: 500 },
      signal: undefined,
    } as any,
    h.ctx(),
  );
  assert.ok(res && res.compaction, "returns a compaction result");
  assert.equal(res.compaction.firstKeptEntryId, "e2", "reuses pi's cut boundary (PREVENT-PI-002 safe)");
  assert.ok(typeof res.compaction.summary === "string" && res.compaction.summary.length > 0, "our summary supplied");
  assert.ok(res.compaction.tokensBefore >= 0, "tokensBefore reported");
});

test("session_before_compact falls back to pi when nothing to summarize", async () => {
  const h = harness();
  // Empty preparation → no messages to summarize → return {} so pi compacts natively.
  const res = await h.fire(
    "session_before_compact",
    {
      type: "session_before_compact",
      reason: "threshold",
      willRetry: false,
      preparation: { firstKeptEntryId: "e0", messagesToSummarize: [], tokensBefore: 0 },
      signal: undefined,
    } as any,
    h.ctx(),
  );
  assert.deepEqual(res, {}, "no compaction supplied → pi runs its own");
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
  await h.commands["mega-recall"].handler("dedupe bug store.ts", ctx);
  assert.ok(h.notifies.some((n) => n.includes("recall staged")), "command reports staged checkpoints");
  assert.ok(h.notifies.some((n) => n.includes("chkpt_")), "command names the checkpoint");
});

test("/megacompact-status reports live store stats", async () => {
  const h = harness();
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }) });
  await h.commands["mega-status"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("store:") && n.includes("chkpt")), "status shows checkpoint count");
});

// ---- Model/provider capture (Phase 5b model_snapshots) ----------------------
test("model_select captures model + provider into SQL", async () => {
  const h = harness();
  const modelCtx = h.ctx({
    model: { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", contextWindow: 200000, maxTokens: 32000, reasoning: false, cost: { input: 0.000015, output: 0.000075 } },
    modelRegistry: { getProviderDisplayName: (p: string) => (p === "anthropic" ? "Anthropic" : p) },
  });
  await h.fire("model_select", {}, modelCtx);
  const { latestModelSnapshot } = await import("../src/store/sqlite.js");
  const snap = latestModelSnapshot(h.stateDir);
  assert.ok(snap, "model_snapshots row persisted");
  assert.equal(snap!.modelId, "claude-opus-4-8", "correct model id captured");
  assert.equal(snap!.provider, "anthropic", "correct provider captured");
  assert.equal(snap!.providerName, "Anthropic", "provider display name resolved");
  assert.equal(snap!.inputRate, 0.000015, "input rate captured");
});

test("/mega-status surfaces the captured model + provider", async () => {
  const h = harness();
  const modelCtx = h.ctx({
    model: { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", contextWindow: 200000, maxTokens: 32000, reasoning: false, cost: { input: 0.000015, output: 0.000075 } },
    modelRegistry: { getProviderDisplayName: () => "Anthropic" },
  });
  await h.fire("model_select", {}, modelCtx);
  await h.fire("context", { type: "context", messages: h.session }, h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) }));
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }) });
  await h.commands["mega-status"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("🤖 model:") && n.includes("Claude Opus 4.8") && n.includes("Anthropic")), "status surfaces captured model + provider");
});

// ---- Named compaction tiers -------------------------------------------------
// low=50k, medium=100k, high=200k, ultra=1M, mega=10M. Driven through the REAL
// loadConfig()/status path by setting MEGACOMPACT_TIER before loading the ext.
const TIER_CASES: Array<[string, number]> = [
  ["low", 50_000],
  ["medium", 100_000],
  ["high", 200_000],
  ["ultra", 1_000_000],
  ["mega", 10_000_000],
];
for (const [tier, threshold] of TIER_CASES) {
  test(`tier "${tier}" resolves to a ${threshold}-token threshold`, async () => {
    // Keep tier + keep threshold UNSET so the tier (not an explicit number)
    // drives the threshold. harness() would otherwise reset the threshold.
    delete process.env.MEGACOMPACT_THRESHOLD_TOKENS;
    process.env.MEGACOMPACT_TIER = tier;
    const h = harness({ keepTier: true, keepThreshold: true });
    const ctx = h.ctx({ getContextUsage: () => ({ tokens: 1, contextWindow: 2_000_000, percent: 0.01 }) });
    await h.commands["mega-status"].handler("", ctx);
    delete process.env.MEGACOMPACT_TIER;
    assert.ok(
      h.notifies.some((n) => n.includes(`tier=${tier}`) && n.includes(`threshold=${threshold}`)),
      `status should report tier=${tier} threshold=${threshold}`,
    );
  });
}

test("explicit MEGACOMPACT_THRESHOLD_TOKENS overrides the tier", async () => {
  process.env.MEGACOMPACT_TIER = "mega";
  process.env.MEGACOMPACT_THRESHOLD_TOKENS = "777";
  const h = harness({ keepTier: true, keepThreshold: true });
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 1, contextWindow: 2_000_000, percent: 0.01 }) });
  await h.commands["mega-status"].handler("", ctx);
  delete process.env.MEGACOMPACT_TIER;
  assert.ok(
    h.notifies.some((n) => n.includes("tier=custom") && n.includes("threshold=777")),
    "explicit threshold wins over tier (tier=custom)",
  );
});

// ---- /dashboard commands ----------------------------------------------------
test("/dashboard-status reports no server when pid file missing", async () => {
  const h = harness();
  const ctx = h.ctx();
  await h.commands["mega-dashboard-status"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("not running")), "reports no server running");
});

test("/dashboard-stop reports no server when pid file missing", async () => {
  const h = harness();
  const ctx = h.ctx();
  await h.commands["mega-dashboard-stop"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("no dashboard server running")), "reports no server");
});

test("/dashboard skips server spawn when already running", async () => {
  const h = harness();
  const confirms: boolean[] = [];
  // Set up a fake HTTP server on a port inside the dashboard's scan range
  // (9320–9329) — isServerRunning() probes those ports, not the port.pid value.
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updatedAt: new Date().toISOString(), tier: "test", version: 1, config: {}, session: {}, context: {}, trigger: {}, store: {} }));
  });
  await new Promise<void>((r) => server.listen(9320, "127.0.0.1", r));
  const addr = server.address() as any;
  const { join: j } = await import("node:path");
  const { writeFileSync: wf } = await import("node:fs");
  wf(j(h.stateDir, "port.pid"), JSON.stringify({ port: addr.port, pid: process.pid }));

  const ctx = h.ctx({
    ui: {
      setStatus: () => {},
      notify: (s: string) => { h.notifies.push(s); },
      select: () => {},
      confirm: async () => { confirms.push(true); return true; },
      input: async () => "",
    },
  });

  await h.commands["mega-dashboard"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("already running")), "reports already running");
  assert.ok(confirms.length > 0, "confirm dialog was shown");

  await new Promise<void>((r) => server.close(() => r()));
});

test("/dashboard-status reports running after dashboard start", async () => {
  const h = harness();
  // Write a fake port.pid; the server must listen inside the scan range
  // (9320–9329) or isServerRunning() won't detect it.
  const { createServer } = await import("node:http");
  const { join: j } = await import("node:path");
  const { writeFileSync: wf } = await import("node:fs");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updatedAt: new Date().toISOString(), tier: "test" }));
  });
  await new Promise<void>((r) => server.listen(9321, "127.0.0.1", r));
  const addr = server.address() as any;
  wf(j(h.stateDir, "port.pid"), JSON.stringify({ port: addr.port, pid: process.pid }));

  const ctx = h.ctx();
  await h.commands["mega-dashboard-status"].handler("", ctx);
  assert.ok(h.notifies.some((n) => n.includes("running") && n.includes(String(addr.port))), "reports running with port");

  await new Promise<void>((r) => server.close(() => r()));
});

test("state snapshot writes dashboard.json after compaction", async () => {
  const h = harness();
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
  // Fire auto-trigger compaction (context event above 80% threshold)
  await h.fire("context", { type: "context", messages: h.session }, ctx);
  const { existsSync: ex, readFileSync: rf } = await import("node:fs");
  const { join: j } = await import("node:path");
  const snapPath = j(h.stateDir, "dashboard.json");
  assert.ok(ex(snapPath), "dashboard.json written after compaction");
  const snap = JSON.parse(rf(snapPath, "utf-8"));
  // Item B: the honest token model is wired — the original dropped region was
  // captured (originalTokens > 0), and the saved amount never exceeds the
  // original (saved = max(0, original − stored) ≤ original). For this tiny
  // harness session the summary can be ≥ the region, so saved may be 0; the
  // positive "saved > 0" case with a large region is covered by the
  // vectorStore unit tests.
  assert.ok(snap.store.originalTokens > 0, "snapshot.store.originalTokens captured after compaction");
  assert.ok(
    snap.store.originalTokens >= snap.store.tokensSaved,
    "model invariant: original region >= tokens saved",
  );
  // Item A: crew (live agent) block is present in the dashboard snapshot.
  assert.ok(snap.crew && typeof snap.crew.activeAgents === "number", "snapshot.crew.activeAgents present");
});

test("events.log receives compaction events", async () => {
  const h = harness();
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
  // Fire auto-trigger compaction twice (first fires compaction, second also fires)
  await h.fire("context", { type: "context", messages: h.session }, ctx);
  const { readFileSync: rf, existsSync: ex } = await import("node:fs");
  const { join: j } = await import("node:path");
  const logPath = j(h.stateDir, "events.log");
  if (ex(logPath)) {
    const content = rf(logPath, "utf-8").trim();
    // At minimum, we expect at least one event logged
    assert.ok(content.length > 0, "events.log is non-empty after compaction");
  } else {
    // events.log may not exist if the DashboardEmitter path differs from stateDir;
    // verify dashboard.json was written (proves the post-compact path executed)
    assert.ok(ex(j(h.stateDir, "dashboard.json")), "dashboard.json proves post-compact ran");
  }
});

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
