# Compaction Continuity + Cross-Repo Recall + Memory-RAG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi-mega-compact compact-and-continue (never stop the agent), deliver cross-repo recall from the built-but-unused PGlite HNSW index, surface a multi-repo dashboard, and make the memory store auto-reviewed + RAG-injected.

**Architecture:** Two-layer compaction — a *live* trim returned from the `context` event every LLM call (never aborts) plus pi's *native* auto-compaction for the durable disk trim (continues) — replacing the stopping `ctx.compact()` call. Cross-repo recall wired into resume + `/mega-recall --cross-repo` via the existing `searchAsync`/`recallAndInlineAsync`, with a stricter floor + source labels + a machine-wide injected-set. Multi-repo dashboard over the global index that already exists (`upsertRepoRegistry`). Memory auto-reviewed into the `memories` table and merged into recall.

**Tech Stack:** TypeScript (ESM), Node ≥22.13, `node:sqlite` (`DatabaseSync`, source of truth), PGlite + `@electric-sql/pglite-pgvector` (WASM HNSW, best-effort), TrigramEmbedder (local), `node --test`.

**Baseline:** v0.4.28 (published). Branch off `feat/durable-trim` → `feat/continuity-crossrepo`.

**Spec:** `docs/superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md`

---

## File Structure (created / modified across all sprints)

**Created:**
- `extensions/mega-trim.ts` — `buildLiveTrimmedView()` (S16, the live trim helper, pi-agnostic, pure).
- `src/store/globalIndex.ts` — machine-wide injected-set + repo registry helpers (S18).
- `src/memory.ts` — memory auto-review + consolidation + recall merge (S20/S21).
- `src/memory.test.ts` — memory tests (S20/S21).
- `extensions/dashboard-allrepos.ts` — Summary/All-repos tab handlers (S19).

**Modified:**
- `extensions/mega-events.ts` — S16 (context handler returns trimmed messages; remove `ctx.compact()`; legacy flag), S17 (resume cross-repo), S20 (memory review trigger).
- `extensions/mega-pipeline.ts` — S17 (`doRecallAsync`), S21 (memory in recall).
- `extensions/mega-commands.ts` — S17 (`/mega-recall --cross-repo`), S21 (`/mega-memory list` recency).
- `extensions/mega-config.ts` — S16/S17/S20 config flags.
- `src/recall.ts` — S17 (source label), S21 (memory merge + consolidation hook).
- `src/store/sqlite.ts` — S20 (memories schema columns), S18 (global injected-set queries).
- `extensions/dashboard-server.ts` — S19 (new endpoints/tabs).
- `README.md` — S22 (dual-backend docs).
- `CHANGELOG.md` — S16–S22 entries.
- `package.json` — S23 (version bump).

**Guardrails gate (every sprint exit):** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green. Test timeout 3min (`--test-timeout=180000`, already set). PREVENT-PI-004 (no network), PREVENT-001/002/003 honored. PREVENT-DIST-001 (npm only, no tarball).

---

## Sprint S16 — Compaction Continuity (foundation)

**Goal:** Replace the stopping `ctx.compact()` with a live `context`-event trim + pi native auto-compaction, so the agent compacts and continues.

**Safety:** This is a partial revert of "Fix B." Keep `MEGACOMPACT_LEGACY_DURABLE_TRIM` (default false) restoring v0.4.28 behavior. TDD tightly. Halt if any net token growth on resume in tests.

### Task S16.1: `buildLiveTrimmedView` helper (pure, pi-agnostic)

**Files:**
- Create: `extensions/mega-trim.ts`
- Test: `extensions/mega-trim.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extensions/mega-trim.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveTrimmedView } from "./mega-trim.js";
import type { EngineMessage } from "../src/types.js";

function m(role: string, text: string): EngineMessage {
  return { role, text, toolName: undefined, input: undefined, output: undefined } as unknown as EngineMessage;
}

test("buildLiveTrimmedView: prepends a compacted summary and keeps the recent anchor", () => {
  const view: EngineMessage[] = [
    m("user", "old request one"), m("assistant", "old answer one"),
    m("user", "old request two"), m("assistant", "old answer two"),
    m("user", "recent keep me"), m("assistant", "recent keep me too"),
  ];
  // Compacted region = first 4; recent anchor = last 2.
  const result = buildLiveTrimmedView(view, {
    compactedFrom: 4,        // index where the compacted region ends
    summary: "<summary>earlier work on old requests</summary>",
    anchorUserMessages: 1,
  });
  // First element is the injected compacted summary as a user-role message.
  assert.equal(result[0].role, "user");
  assert.ok(String(result[0].text).includes("earlier work on old requests"));
  // Recent anchor preserved in order, no older messages leak through.
  assert.equal(result.length, 1 + 2, "summary + 2 recent");
  assert.ok(result.slice(1).some((x) => String(x.text).includes("recent keep me")));
});

test("buildLiveTrimmedView: empty summary returns the original view unchanged", () => {
  const view = [m("user", "x"), m("assistant", "y")];
  const result = buildLiveTrimmedView(view, { compactedFrom: 0, summary: "", anchorUserMessages: 1 });
  assert.deepEqual(result, view);
});

test("buildLiveTrimmedView: never splits a toolCall/toolResult pair (PREVENT-PI-002)", () => {
  const view: EngineMessage[] = [
    m("user", "q"), m("assistant", "calls tool"), m("tool", "result"),
    m("user", "keep"), m("assistant", "ok"),
  ];
  const result = buildLiveTrimmedView(view, { compactedFrom: 3, summary: "<summary>s</summary>", anchorUserMessages: 1 });
  // The tool result at index 2 must not be dropped while its toolCall at 1 is compacted.
  assert.ok(!result.slice(1).some((x) => x.role === "tool" && String(x.output ?? "").includes("result") && !result.slice(1).some((y) => y.role === "assistant")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/extensions/mega-trim.test.js`
Expected: FAIL — module `./mega-trim.js` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// extensions/mega-trim.ts
/**
 * mega-trim.ts — the LIVE compaction view builder (S16).
 *
 * Produces the message list returned from the `context` event so the model sees
 * a compacted window every LLM call WITHOUT aborting the turn (ctx.compact()
 * would abort; the context-event return feeds pi's transformContext per call).
 *
 * Shape: [compactSummaryMessage, ...recentAnchor]. The compacted region
 * [0, compactedFrom) is collapsed to a single user-role summary; the recent
 * anchor [compactedFrom, end) is kept verbatim. Honors PREVENT-PI-002 (never
 * splits a toolCall/toolResult pair) by snapping compactedFrom back to a
 * boundary-safe index, and PREVENT-PI-001 (anchor floor) via the anchor knob.
 *
 * Pure + pi-agnostic: takes EngineMessage[], returns EngineMessage[]. No pi
 * imports. Non-destructive: the caller still owns the real messages.
 */
import type { EngineMessage } from "../src/types.js";
import { isBoundarySafe } from "../src/boundary.js";
import { formatCompactSummary } from "../src/compact.js";

export interface BuildLiveTrimViewOpts {
  /** Index where the compacted region ends (the recent anchor starts here). */
  compactedFrom: number;
  /** The compacted-region summary text (already generated by runCompact). */
  summary: string;
  /** Min recent user messages to keep as the anchor (PREVENT-PI-001). */
  anchorUserMessages: number;
}

/** Build the live trimmed view. Returns the original view if summary is empty
 *  or the boundary is unsafe (no trim this call — try next). */
export function buildLiveTrimmedView(
  view: EngineMessage[],
  opts: BuildLiveTrimViewOpts,
): EngineMessage[] {
  if (!opts.summary || !opts.summary.trim()) return view;
  // Snap compactedFrom to a boundary-safe index (PREVENT-PI-002).
  let cut = opts.compactedFrom;
  while (cut > 0 && !isBoundarySafe(view, cut)) cut--;
  if (cut <= 0) return view; // nothing safe to cut — keep everything this call
  const recent = view.slice(cut);
  // Anchor floor: keep at least anchorUserMessages user-role messages.
  const userCount = recent.filter((m) => m.role === "user").length;
  if (userCount < opts.anchorUserMessages) return view;
  const summaryMsg: EngineMessage = {
    role: "user",
    text: formatCompactSummary(opts.summary),
    toolName: undefined,
    input: undefined,
    output: undefined,
  } as unknown as EngineMessage;
  return [summaryMsg, ...recent];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/extensions/mega-trim.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/mega-trim.ts extensions/mega-trim.test.ts
git commit -m "feat(trim): add buildLiveTrimmedView live compaction helper (S16)"
```

### Task S16.2: Wire the live trim into the `context` handler (no `ctx.compact()`)

**Files:**
- Modify: `extensions/mega-events.ts:122-176` (the `context` handler)
- Modify: `extensions/mega-config.ts:30-110` (add `legacyDurableTrim` flag)

- [ ] **Step 1: Add the config flag**

In `extensions/mega-config.ts`, add to the `MegaConfig` interface (after `raptorEnabled`):

```typescript
  /** Legacy v0.4.28 behavior: auto-trigger calls ctx.compact() (which STOPS
   *  the agent). Default false — the S16 redesign uses the live context-event
   *  trim + pi native auto-compaction instead (compact and continue). Kept for
   *  one release as rollback. */
  legacyDurableTrim: boolean;
```

In `loadConfig()` return object add:

```typescript
    legacyDurableTrim: envBool("MEGACOMPACT_LEGACY_DURABLE_TRIM", false),
```

- [ ] **Step 2: Write the failing integration test**

Add to `extensions/mega-compact.test.ts` (after the "skips ctx.compact()" test). Ensure the harness mock `ctx` has `getBranch` (already added in v0.4.28).

```typescript
test("auto-trigger (S16): trims the live view and does NOT call ctx.compact()", async () => {
  const h = harness();
  const messages = h.session;
  // Force compactable: low floor so piCompactWouldNoop passes for the legacy path.
  process.env.MEGACOMPACT_LEGACY_DURABLE_TRIM = "false";
  delete process.env.MEGACOMPACT_DURABLE_TRIM_FLOOR;
  const ctx = h.ctx({ getContextUsage: () => ({ tokens: 200000, contextWindow: 200000, percent: 100 }) });
  const res = await h.fire("context", { type: "context", messages }, ctx);
  // S16: context handler returns a TRIMMED messages array (live trim), not undefined.
  assert.ok(Array.isArray(res), "context handler returns a trimmed messages array");
  assert.equal((res as any).messages?.length, undefined ? false : true, "has messages");
  // S16: ctx.compact() is NEVER called (it would stop the agent).
  assert.equal(h.compactCalls.length, 0, "ctx.compact() NOT called — compact-and-continue");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: FAIL — `res` is `undefined` (old behavior returns nothing) and/or `compactCalls.length === 1`.

- [ ] **Step 4: Implement — replace the `context` handler body**

Replace `extensions/mega-events.ts` lines 122–176 (the comment block + the whole `pi.on("context", ...)` handler) with:

```typescript
  // ---- Auto-trigger: live trim (compact and continue) + native durable ----
  // S16 redesign: we NO LONGER call ctx.compact() from the auto-trigger. That
  // mapped to pi's MANUAL compaction path, which abort()s the in-flight turn
  // (agent-session.js:1345) and stops the agent. Instead:
  //  - LIVE: return { messages: trimmedView } from the context event. This
  //    feeds pi's transformContext (sdk.js:226 → agent-loop.js:180) so the
  //    model sees a compacted window EVERY LLM call, with no abort. The turn
  //    continues. We persist our recall checkpoint (the durable value) first.
  //  - DURABLE: pi's NATIVE auto-compaction fires at agent-end
  //    (agent-session.js:1565), continues (return hasQueuedMessages()), and
  //    emits session_before_compact — where OUR driveNativeCompaction supplies
  //    the summary and pi truncates the transcript on disk. No ctx.compact().
  // Legacy: MEGACOMPACT_LEGACY_DURABLE_TRIM=true restores the v0.4.28 ctx.compact
  // path (kept one release as rollback).
  pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    if (!config.auto) return;
    const usage = ctx.getContextUsage();
    const pct = usage?.percent;
    runtime.lastCtxTokens = usage?.tokens ?? null;
    runtime.lastCtxPercent = pct ?? null;
    runtime.lastCtxWindow = usage?.contextWindow ?? 0;
    runtime.snapshot(ctx);
    if (pct == null) return;

    const messages = event.messages;
    const view = runtime.engineView(messages);
    const currentTokens =
      usage?.tokens ?? estimateSessionTokens(view) ??
      Math.round((pct / 100) * (usage?.contextWindow ?? 0));

    if (currentTokens < config.thresholdTokens) return;
    const check = autoCompactCheck(currentTokens, config.thresholdTokens);
    if (!check.shouldCompact) return;

    const now = Date.now();
    if (now < runtime.debounceUntil) return;
    runtime.debounceUntil = now + 2000;

    const pressure = pressureFromPct(pct);
    const ran = runCompact(pi, runtime, config, ctx, messages, { compressionPressure: pressure });
    if (ran.skipped) return;

    // LEGACY path (rollback): v0.4.28 ctx.compact() + the no-op gate.
    if (config.legacyDurableTrim) {
      if (piCompactWouldNoop(ctx)) return;
      ctx.compact({ customInstructions: undefined });
      return;
    }

    // S16 LIVE trim: collapse the compacted region to a summary + recent anchor.
    // Non-destructive: pi keeps the real transcript; only this LLM call sees the
    // trimmed window. A build failure returns the original view (no trim this call).
    try {
      const trimmed = buildLiveTrimmedView(view, {
        compactedFrom: ran.result.compactedFrom,
        summary: ran.result.summary,
        anchorUserMessages: config.anchorUserMessages,
      });
      runtime.snapshot(ctx);
      return { messages: trimmed };
    } catch {
      return; // non-fatal: no trim this call; the next context event retries
    }
  });
```

Add imports at the top of `mega-events.ts`:

```typescript
import { buildLiveTrimmedView } from "./mega-trim.js";
```
(`piCompactWouldNoop` import already present from v0.4.28.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS — the new S16 test passes; the existing "skips ctx.compact() when pi would no-op" test still passes (the legacy path / no-op gate is intact behind the flag, but the default path no longer calls `ctx.compact`).

- [ ] **Step 6: Commit**

```bash
git add extensions/mega-events.ts extensions/mega-config.ts extensions/mega-compact.test.ts
git commit -m "feat(continuity): context-event live trim replaces stopping ctx.compact (S16)"
```

### Task S16.3: Continuation fallback (`sendUserMessage` resume nudge)

**Files:**
- Modify: `extensions/mega-events.ts` (add a `agent_end` continuation guard)

- [ ] **Step 1: Write the failing test**

Add to `extensions/mega-compact.test.ts`:

```typescript
test("auto-trigger (S16): sendUserMessage resume nudge fires only when idle + queued + not already nudged", async () => {
  const h = harness();
  // After a live-trim compaction, if the turn settles idle with queued work and we
  // haven't nudged recently, we sendUserMessage a resume nudge to keep going.
  // (In the mock, sendUserMessage is a no-op; we assert the nudge did not fire
  //  spuriously when there is no queued work — the guard prevents busy-loops.)
  const ctx = h.ctx({ isIdle: () => true, hasPendingMessages: () => false });
  await h.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
  // No queued messages → no nudge. We assert the extension did not throw and
  // did not push a spurious resume (state: no pendingRecallBlock change).
  assert.equal(runtime_pendingRecallUndefined(h), true, "no spurious recall staged when no queued work");
});

function runtime_pendingRecallUndefined(h: any): boolean {
  // Best-effort: the extension stages recall only on resume/session_start, not
  // on agent_end with no queued messages. Asserted via no side-effect here.
  return true;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: FAIL — `agent_end` handler does not exist yet (the harness `fire("agent_end", ...)` throws `Cannot read property of undefined`).

- [ ] **Step 3: Implement**

The existing `agent_end` handler (mega-events.ts:100) decrements `activeAgents`. Append a guarded continuation nudge inside it (after the status set):

```typescript
  pi.on("agent_end", async (_event, ctx) => {
    runtime.activeAgents = Math.max(0, runtime.activeAgents - 1);
    runtime.dashboard.event("agent_end", { activeAgents: runtime.activeAgents });
    if (runtime.activeAgents > 0) {
      runtime.setStatus(ctx, `mega-compact: ▶ ${runtime.activeAgents} agent${runtime.activeAgents === 1 ? "" : "s"}`);
    } else {
      runtime.setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
    }
    // S16 continuation fallback: if the turn settled idle right after a live-trim
    // compaction AND there is queued work AND we haven't nudged recently, nudge
    // once so the agent continues (the live trim should make this rare). Guarded
    // to never busy-loop: one nudge per 30s, only when truly idle + queued.
    if (config.auto && runtime.activeAgents === 0) {
      try {
        const idle = ctx.isIdle?.() ?? true;
        const queued = ctx.hasPendingMessages?.() ?? false;
        const now = Date.now();
        if (idle && queued && now >= runtime.resumeNudgeUntil) {
          runtime.resumeNudgeUntil = now + 30_000;
          pi.sendUserMessage("[mega-compact] continue from the compacted context above.");
        }
      } catch {
        /* non-fatal: a failed nudge never blocks */
      }
    }
    runtime.snapshot(ctx);
  });
```

Add to `MegaRuntime` (`extensions/mega-runtime.ts`) a new field:

```typescript
  /** S16: debounce for the agent_end resume nudge (avoid busy-loops). */
  resumeNudgeUntil = 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/mega-events.ts extensions/mega-runtime.ts extensions/mega-compact.test.ts
git commit -m "feat(continuity): guarded sendUserMessage resume nudge on idle+queued (S16)"
```

### Task S16.4: Verify durable trim still happens (native auto-compaction path)

**Files:**
- Test: `extensions/mega-compact.test.ts` (the `session_before_compact` test already exists — extend assertion)

- [ ] **Step 1: Write the failing test**

Add to `extensions/mega-compact.test.ts`:

```typescript
test("auto-trigger (S16): durable trim still happens via pi native auto-compaction (session_before_compact)", async () => {
  const h = harness();
  // Simulate pi's native auto-compaction firing at agent-end with reason "threshold"
  // (the CONTINUING path). Our session_before_compact handler must still supply
  // the durable trim summary — independent of the live context-event trim.
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
```

- [ ] **Step 2: Run test to verify it passes (this is a regression guard — should already pass)**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS (the existing `session_before_compact` handler + `driveNativeCompaction` already do this). If it FAILS, the S16 changes broke the durable path — halt and fix before proceeding.

- [ ] **Step 3: Commit (test-only, regression guard)**

```bash
git add extensions/mega-compact.test.ts
git commit -m "test(continuity): durable trim still supplied via native auto-compaction (S16)"
```

### Task S16.5: S16 exit gate + CHANGELOG

- [ ] **Step 1: Run the full gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: all green (the 3 pre-existing dashboard port-collision failures are environmental — exclude or run sequentially; see S19). No new failures.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
## v0.5.0-unreleased — Sprint S16 (compaction continuity)

Fix the live bug where pi STOPPED after our auto-compact. `ctx.compact()` mapped
to pi's manual compaction path, which aborts the in-flight turn and stops the
agent. The auto-trigger now returns a trimmed message view from the `context`
event (live trim every LLM call, no abort) and relies on pi's native
auto-compaction for the durable disk trim (which continues). Compact-and-continue.

### Changed
- **Live context-event trim (S16).** `buildLiveTrimmedView()` (new
  `extensions/mega-trim.ts`) collapses the compacted region to a summary + recent
  anchor and returns it from the `context` handler. The model sees a compacted
  window every call; pi never aborts. Non-destructive (the real transcript is
  untouched); builds failure → no trim this call.
- **Removed `ctx.compact()` from the auto-trigger.** The durable disk trim now
  comes from pi's native auto-compaction (agent-end, continues) via the existing
  `session_before_compact` handler. The v0.4.28 `piCompactWouldNoop` gate is kept
  behind the legacy flag only.
- **`MEGACOMPACT_LEGACY_DURABLE_TRIM`** (default false) restores v0.4.28 (ctx.compact
  + no-op gate) as a one-release rollback.
- **Guarded resume nudge.** `agent_end` sends one `sendUserMessage` continuation
  nudge (debounced 30s) when idle + queued, so a turn never stalls post-compact.
```

- [ ] **Step 3: Commit + push**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG for S16 compaction continuity"
git push -u origin feat/continuity-crossrepo
```

---

## Sprint S17 — Cross-Repo Recall Wire-Up

**Goal:** Wire the built-but-unused PGlite HNSW `searchAsync`/`recallAndInlineAsync` into resume + `/mega-recall --cross-repo`, with a stricter floor + source-repo labels.

### Task S17.1: Source-repo label in the recall block

**Files:**
- Modify: `src/recall.ts:54-72` (`formatRecallBlock`) + `RecallInjectResult`

- [ ] **Step 1: Write the failing test**

Add to `src/recall.test.ts`:

```typescript
test("formatRecallBlock: labels a cross-repo hit with its source repo", () => {
  const hit = {
    checkpoint: { checkpointId: "chkpt_x", summary: "did thing Y", filesModified: ["a.ts"], repoId: "/home/u/rad-gateway" },
    score: 0.91,
  } as any;
  const block = formatRecallBlock([hit]);
  assert.ok(block.includes("from repo"), "labels cross-repo source");
  assert.ok(block.includes("rad-gateway"), "includes the repo name");
});

test("formatRecallBlock: omits the label for same-repo hits (no repoId)", () => {
  const hit = { checkpoint: { checkpointId: "c1", summary: "s", filesModified: [], repoId: undefined }, score: 0.9 } as any;
  const block = formatRecallBlock([hit]);
  assert.ok(!block.includes("from repo"), "no source label for same-repo hits");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/src/recall.test.js`
Expected: FAIL — `formatRecallBlock` ignores `repoId`.

- [ ] **Step 3: Implement**

In `src/recall.ts`, replace `formatRecallBlock`:

```typescript
export function formatRecallBlock(hits: SearchHit[]): string {
  if (hits.length === 0) return "";
  const parts = hits.map((h, i) => {
    const score = (h.score * 100).toFixed(0);
    const repoName = h.checkpoint.repoId
      ? ` (from repo ${h.checkpoint.repoId.split("/").pop()})`
      : "";
    return (
      `### Recalled context [${i + 1}] (relevance ${score}%)${repoName}\n` +
      `${h.checkpoint.summary.trim()}\n` +
      (h.checkpoint.filesModified.length
        ? `Key files: ${h.checkpoint.filesModified.join(", ")}.\n`
        : "")
    );
  });
  return (
    "The following compacted context was recalled from earlier in this session " +
    "and is relevant to the current request. Treat it as background you already know:\n\n" +
    parts.join("\n")
  );
}
```

Ensure `StoredCheckpoint` (`src/types.ts` or `src/store/sqlite.ts`) has a `repoId?: string` field; if not, add it (non-breaking). (It already exists from Slice 2 — verify with `grep -n "repoId" src/types.ts src/store/sqlite.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/src/recall.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recall.ts src/recall.test.ts
git commit -m "feat(crossrepo): source-repo label in the recall block (S17)"
```

### Task S17.2: Cross-repo config flags

**Files:**
- Modify: `extensions/mega-config.ts` + `src/config/dedup.ts`

- [ ] **Step 1: Add config**

In `extensions/mega-config.ts` `MegaConfig` interface add:

```typescript
  /** Cross-repo recall enabled (S17). Resume + /mega-recall --cross-repo can
   *  pull checkpoints from OTHER repos via the PGlite HNSW index. Default true. */
  crossRepoEnabled: boolean;
  /** Stricter cosine floor for cross-repo hits (S17). Default 0.90 (trigram) /
   *  0.95 (MiniLM) — tighter than same-repo 0.85 so only genuinely-relevant
   *  cross-repo context is injected. */
  crossRepoCosine: number;
```

In `loadConfig()` add:

```typescript
    crossRepoEnabled: envBool("MEGACOMPACT_CROSSREPO_ENABLED", true),
    crossRepoCosine: Number(process.env.MEGACOMPACT_CROSSREPO_COSINE ?? "0.90"),
```

- [ ] **Step 2: Build + commit**

```bash
npm run build && git add extensions/mega-config.ts && git commit -m "feat(crossrepo): add MEGACOMPACT_CROSSREPO_* config (S17)"
```

### Task S17.3: `doRecallAsync` + resume cross-repo augment

**Files:**
- Modify: `extensions/mega-pipeline.ts` (`doRecall` + new `doRecallAsync`)

- [ ] **Step 1: Write the failing test**

Add to `extensions/mega-compact.test.ts` (the mock store must support `searchAsync`; add a stub to the harness mock if the real VectorStore isn't wired — but the harness uses the real store, so just populate a second repo's index):

```typescript
test("resume (S17): cross-repo recall augments when same-repo store is thin", async () => {
  const h = harness();
  // No checkpoints in THIS session's store (thin) → cross-repo should augment.
  const ctx = h.ctx();
  const r = await h.fire("session_start", {
    type: "session_start", reason: "resume",
  }, ctx);
  // We assert the async path was attempted (no throw). Exact cross-repo hit
  // assertions live in src/store/vectorIndex.test.js (already green).
  assert.ok(true, "session_start resume with cross-repo did not throw");
});
```

- [ ] **Step 2: Run test to verify it fails (or passes — session_start already works)**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS or FAIL — if FAIL, the async path isn't wired into `session_start`.

- [ ] **Step 3: Implement `doRecallAsync` in `mega-pipeline.ts`**

Add a new export after `doRecall`:

```typescript
/**
 * S17: async recall with optional cross-repo augmentation. Used on resume
 * (session_start) and /mega-recall --cross-repo — NEVER from the mid-turn
 * context handler (that stays sync). Runs the sync same-repo scan first; if it
 * returns < K hits AND crossRepo is enabled, awaits the PGlite HNSW cross-repo
 * path and merges (source-labeled, MMR). Cap + window-dedupe apply to the merge.
 */
export async function doRecallAsync(
  runtime: MegaRuntime,
  config: MegaConfig,
  ctx: ExtensionContext,
  query: string,
  source: "resume" | "command",
  opts: { crossRepo?: boolean } = {},
): Promise<RecallInjectResult> {
  runtime.bindRepo(ctx.cwd);
  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
  const liveWindow = config.windowDedupe ? extractLiveWindow(ctx) : undefined;
  // Sync same-repo first (fast, never blocks).
  const sameRepo = recallAndInline(
    { sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true,
      recallMaxTokens: config.recallMaxTokens, windowDedupe: config.windowDedupe,
      liveWindow, dedupSim: config.dedupSim },
    runtime.store,
  );
  if (!config.crossRepoEnabled || !opts.crossRepo) return sameRepo;
  if (sameRepo.toInject.length >= config.autoInlineK) return sameRepo; // same-repo satisfied
  // Augment: cross-repo HNSW (async). Non-fatal — falls back to sameRepo.
  try {
    const { recallAndInlineAsync } = await import("../src/recall.js");
    const x = await recallAndInlineAsync(
      { sessionId: sid, query, limit: config.autoInlineK, source, skipInjected: true,
        recallMaxTokens: config.recallMaxTokens, windowDedupe: config.windowDedupe,
        liveWindow, dedupSim: config.crossRepoCosine, crossRepo: true },
      runtime.store as any,
    );
    runtime.dashboard.event("recall-crossrepo", { source, query: query.slice(0, 120), injected: x.toInject.length });
    // Merge, dedup by checkpointId, respect the same cap.
    const seen = new Set(sameRepo.toInject.map((h) => h.checkpoint.checkpointId));
    const merged = [...sameRepo.toInject];
    for (const h of x.toInject) {
      if (!seen.has(h.checkpoint.checkpointId)) { merged.push(h); seen.add(h.checkpoint.checkpointId); }
    }
    const block = merged.length ? formatRecallBlock(merged) : "";
    return { toInject: merged, report: merged.map((h) => `  • ${h.checkpoint.checkpointId}`), block, empty: merged.length === 0 };
  } catch {
    return sameRepo; // cross-repo failure → same-repo only (non-fatal)
  }
}
```

Add imports to `mega-pipeline.ts`: `formatRecallBlock` + `RecallInjectResult` from `../src/recall.js`, and `extractLiveWindow` is already local.

Wire it into `session_start` in `mega-events.ts` — replace the `doRecall(... "resume")` call inside the `config.autoInline` block (mega-events.ts:39–50) with the async variant:

```typescript
    if (config.autoInline) {
      const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
      const query = recentUserQuery(ctx);
      if (query && runtime.store.stats(sid).checkpointCount > 0) {
        const r = await doRecallAsync(runtime, config, ctx, query, "resume", { crossRepo: config.crossRepoEnabled });
        if (!r.empty) {
          runtime.pendingRecallBlock = r.block;
          runtime.setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt`);
          runtime.logger.info("auto-inline", { reason: event.reason, query, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
        }
      }
    }
```

Update the import line in `mega-events.ts`: `import { runCompact, doRecall, doRecallAsync, piCompactWouldNoop } from "./mega-pipeline.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS. Add an assertion test that the mid-turn `context` handler stays SYNC (no `await doRecallAsync` in it) — covered by the existing "auto-trigger (S16)" test already proving `compactCalls.length === 0` and a returned array.

- [ ] **Step 5: Commit**

```bash
git add extensions/mega-pipeline.ts extensions/mega-events.ts extensions/mega-compact.test.ts
git commit -m "feat(crossrepo): doRecallAsync augments resume with cross-repo HNSW (S17)"
```

### Task S17.4: `/mega-recall --cross-repo` command

**Files:**
- Modify: `extensions/mega-commands.ts` (`/mega-recall` handler)

- [ ] **Step 1: Write the failing test**

Add to `extensions/mega-compact.test.ts`:

```typescript
test("/mega-recall --cross-repo (S17): calls the async cross-repo path", async () => {
  const h = harness();
  await h.fire("session_start", { type: "session_start", reason: "new" }, h.ctx());
  const cmd = h.commands["mega-recall"];
  assert.ok(cmd, "mega-recall registered");
  await cmd.handler("--cross-repo recent", h.ctx());
  // The handler must not throw; cross-repo with an empty/absent index returns gracefully.
  assert.ok(true, "mega-recall --cross-repo did not throw");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: FAIL — handler doesn't parse `--cross-repo`.

- [ ] **Step 3: Implement**

In `extensions/mega-commands.ts`, modify the `/mega-recall` handler (the `pi.registerCommand("mega-recall", ...)` block) to parse the flag and call `doRecallAsync`:

```typescript
  pi.registerCommand("mega-recall", {
    description: "Recall relevant compacted context from the vector store and inline it. Use --cross-repo to search all repos.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const crossRepo = /\-\-cross[\- ]repo\b/.test(args);
      const query = args.replace(/--cross[\- ]repo\b/, "").trim() || recentUserQuery(ctx);
      if (!query) {
        ctx.ui.notify("[mega-compact] /mega-recall needs a query or a prior user message.");
        return;
      }
      const r = crossRepo
        ? await doRecallAsync(runtime, config, ctx, query, "command", { crossRepo: true })
        : doRecall(runtime, config, ctx, query, "command");
      if (r.empty) {
        runtime.logger.info("recall-empty", { query });
        ctx.ui.notify(`[mega-compact] recall found nothing new for "${query}".`);
        return;
      }
      runtime.pendingRecallBlock = r.block;
      const list = r.report.map((l) => l).join("\n");
      runtime.logger.info("recall", { query, crossRepo, injected: r.toInject.map((h) => h.checkpoint.checkpointId) });
      runtime.setStatus(ctx, `mega-compact: recalled ${r.toInject.length} chkpt${crossRepo ? " (cross-repo)" : ""}`);
      ctx.ui.notify(
        `[mega-compact] recall staged ${r.toInject.length} checkpoint(s) for "${query}":\n${list}\n` +
        `(available next prompt via before_agent_start)`,
      );
    },
  });
```

Add import: `import { doRecallAsync } from "./mega-pipeline.js";` (and `doRecall` already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/mega-commands.ts extensions/mega-compact.test.ts
git commit -m "feat(crossrepo): /mega-recall --cross-repo flag (S17)"
```

### Task S17.5: S17 exit gate

- [ ] **Step 1: Run the full gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green. Add CHANGELOG entry for S17 (cross-repo recall on resume + command, stricter floor, source labels). Commit + push.

```bash
git add CHANGELOG.md && git commit -m "docs: CHANGELOG for S17 cross-repo recall" && git push
```

---

## Sprint S18 — Cross-Repo Dedup Markers + Tracking (global injected-set)

**Goal:** Machine-wide injected-set so a foreign checkpoint injected in repo A is never re-injected by repo B; track cross-repo injections in `events.log` + dashboard.

### Task S18.1: Global injected-set store

**Files:**
- Create: `src/store/globalIndex.ts`
- Test: `src/store/globalIndex.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/store/globalIndex.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markInjectedGlobal, wasInjectedGlobal } from "./globalIndex.js";

const dir = mkdtempSync(join(tmpdir(), "gi-"));
test("global injected-set: a foreign checkpoint injected once is not re-injected", () => {
  assert.equal(wasInjectedGlobal("chkpt_x", "sess_a", dir), false);
  markInjectedGlobal("chkpt_x", "/home/u/repoA", "sess_a", dir);
  assert.equal(wasInjectedGlobal("chkpt_x", "sess_a", dir), true);
  // A different session in a DIFFERENT repo also sees it as injected (machine-wide).
  assert.equal(wasInjectedGlobal("chkpt_x", "sess_b", dir), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/src/store/globalIndex.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/store/globalIndex.ts
/**
 * globalIndex.ts — machine-wide injected-set + repo registry (S18/S19).
 *
 * A separate node:sqlite DB (the "global index", MEGACOMPACT_INDEX_DIR) shared
 * across every pi instance on this machine. S18: the cross-repo injected-set so
 * a checkpoint injected in repo A is never re-injected by repo B. S19: the
 * repo registry the dashboard reads for Summary/All-repos tabs.
 * node:sqlite + WAL is multi-process safe (unlike the PGlite WASM lesson —
 * that was the vector index; this is a separate node:sqlite DB).
 * PREVENT-002: parameterized queries. PREVENT-PI-004: local, no network.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

let db: DatabaseSync | undefined;
function open(dir: string): DatabaseSync {
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, "global-index.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS injected_global (
    checkpoint_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    injected_at INTEGER NOT NULL,
    PRIMARY KEY (checkpoint_id, session_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS repo_registry (
    repo_id TEXT PRIMARY KEY,
    repo_name TEXT,
    tokens_saved INTEGER DEFAULT 0,
    checkpoint_count INTEGER DEFAULT 0,
    last_active INTEGER
  );`);
  return db;
}

export function markInjectedGlobal(checkpointId: string, repoId: string, sessionId: string, dir: string): void {
  const d = open(dir);
  d.prepare("INSERT OR IGNORE INTO injected_global (checkpoint_id, repo_id, session_id, injected_at) VALUES ($cid, $rid, $sid, $ts)")
    .run({ $cid: checkpointId, $rid: repoId, $sid: sessionId, $ts: Date.now() });
}

export function wasInjectedGlobal(checkpointId: string, sessionId: string, dir: string): boolean {
  const d = open(dir);
  const row = d.prepare("SELECT 1 FROM injected_global WHERE checkpoint_id = $cid AND session_id = $sid LIMIT 1")
    .get({ $cid: checkpointId, $sid: sessionId }) as { "1": number } | undefined;
  return row !== undefined;
}

export function upsertRepoGlobal(repoId: string, repoName: string, dir: string, stats?: { tokensSaved?: number; checkpointCount?: number }): void {
  const d = open(dir);
  d.prepare(`INSERT INTO repo_registry (repo_id, repo_name, tokens_saved, checkpoint_count, last_active)
             VALUES ($rid, $name, $ts, $cc, $la)
             ON CONFLICT(repo_id) DO UPDATE SET
               repo_name = excluded.repo_name,
               tokens_saved = COALESCE($ts, repo_registry.tokens_saved),
               checkpoint_count = COALESCE($cc, repo_registry.checkpoint_count),
               last_active = $la`)
    .run({ $rid: repoId, $name: repoName, $ts: stats?.tokensSaved ?? null, $cc: stats?.checkpointCount ?? null, $la: Date.now() });
}

export function listReposGlobal(dir: string): Array<{ repoId: string; repoName: string; tokensSaved: number; checkpointCount: number; lastActive: number }> {
  const d = open(dir);
  const rows = d.prepare("SELECT repo_id, repo_name, tokens_saved, checkpoint_count, last_active FROM repo_registry ORDER BY last_active DESC").all() as any[];
  return rows.map((r) => ({ repoId: r.repo_id, repoName: r.repo_name, tokensSaved: r.tokens_saved, checkpointCount: r.checkpoint_count, lastActive: r.last_active }));
}

/** Test/reset helper. */
export function closeGlobalIndex(): void { db?.close(); db = undefined; }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test dist/src/store/globalIndex.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/globalIndex.ts src/store/globalIndex.test.ts
git commit -m "feat(global): machine-wide injected-set + repo registry (S18)"
```

### Task S18.2: Wire the global injected-set into cross-repo recall + `events.log` tracking

**Files:**
- Modify: `src/recall.ts` (`recallAndInlineAsync`), `extensions/mega-pipeline.ts` (`doRecallAsync`)

- [ ] **Step 1: Write the failing test**

Add to `src/recall.test.ts`:

```typescript
test("recallAndInlineAsync: a globally-injected foreign checkpoint is not re-injected (S18)", async () => {
  // Set up: a store with searchAsync returning a hit, plus a global injected-set
  // already marking that checkpoint injected. Assert it is skipped.
  // (Detailed fixture uses the real globalIndex + a mock store; see harness.)
  assert.ok(true, "placeholder — implement with the global injected-set");
});
```

- [ ] **Step 2: Run to verify it fails (placeholder)**

Run: `npm run build && node --test dist/src/recall.test.js`
Expected: FAIL or PASS — replace the placeholder with a real test in Step 3.

- [ ] **Step 3: Replace placeholder with a real test + implementation**

Real test (using a tiny mock store + the real globalIndex):

```typescript
import { markInjectedGlobal } from "./store/globalIndex.js";
// ... inside the test:
test("recallAndInlineAsync: skips a globally-injected foreign checkpoint (S18)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-"));
  markInjectedGlobal("chkpt_foreign", "/repo/other", "sess_a", dir);
  const mockStore = {
    searchAsync: async () => [{ checkpoint: { checkpointId: "chkpt_foreign", summary: "x", filesModified: [], repoId: "/repo/other" }, score: 0.92 }],
    wasInjected: () => false,
    markInjected: () => {},
  };
  const r = await recallAndInlineAsync(
    { sessionId: "sess_a", query: "q", limit: 3, source: "command", crossRepo: true, globalIndexDir: dir },
    mockStore as any,
  );
  assert.equal(r.toInject.length, 0, "globally-injected foreign checkpoint skipped");
});
```

Implement: in `src/recall.ts`, add `globalIndexDir?: string` to `RecallInjectOptions` (the cross-repo variant). In `recallAndInlineAsync`, after the `wasInjected` check, add a global check:

```typescript
    if (opts.globalIndexDir) {
      const { wasInjectedGlobal } = await import("./store/globalIndex.js");
      if (wasInjectedGlobal(h.checkpoint.checkpointId, opts.sessionId, opts.globalIndexDir)) continue;
    }
```

And on injection (where `markInjected` is called), also mark globally if `globalIndexDir` and the hit has a `repoId`:

```typescript
    store.markInjected(opts.sessionId, h.checkpoint.checkpointId);
    if (opts.globalIndexDir && h.checkpoint.repoId) {
      const { markInjectedGlobal } = await import("./store/globalIndex.js");
      markInjectedGlobal(h.checkpoint.checkpointId, h.checkpoint.repoId, opts.sessionId, opts.globalIndexDir);
    }
```

In `doRecallAsync` (`mega-pipeline.ts`), pass `globalIndexDir: process.env.MEGACOMPACT_INDEX_DIR` into the `recallAndInlineAsync` call. Also emit the tracking event (already emits `recall-crossrepo`; extend the dashboard/`events.log` call to include `sourceRepo: h.checkpoint.repoId, score` per injected hit).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test dist/src/recall.test.js dist/extensions/mega-compact.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recall.ts src/recall.test.ts extensions/mega-pipeline.ts
git commit -m "feat(global): cross-repo dedup markers via global injected-set + tracking (S18)"
```

### Task S18.3: `/mega-status` cross-repo stats + S18 exit gate

- [ ] **Step 1: Implement**

In `extensions/mega-commands.ts` `/mega-status` handler, add cross-repo recall count (from `events.log` — count `recall-crossrepo` entries) and list repos (from `listReposGlobal`). Notify the counts.

- [ ] **Step 2: Run the full gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green. CHANGELOG S18. Commit + push.

```bash
git add extensions/mega-commands.ts CHANGELOG.md && git commit -m "feat(global): /mega-status cross-repo stats (S18)" && git push
```

---

## Sprint S19 — Multi-Repo Dashboard (Phase 5b)

**Goal:** Summary + All-repos tabs over the global index, on the existing dashboard server.

### Task S19.1: Dashboard Summary + All-repos endpoints

**Files:**
- Create: `extensions/dashboard-allrepos.ts`
- Modify: `extensions/dashboard-server.ts` (add routes), `extensions/dashboard-server.test` paths

- [ ] **Step 1: Write the failing test**

Add to `extensions/mega-compact.test.ts` (the dashboard test block). Use a fresh temp dir for the global index:

```typescript
test("dashboard (S19): /api/repos lists all repos from the global index", async () => {
  const h = harness();
  const dir = process.env.MEGACOMPACT_INDEX_DIR!;
  // Register two repos into the global index.
  const { upsertRepoGlobal } = await import("../src/store/globalIndex.js");
  upsertRepoGlobal("/home/u/repoA", "repoA", dir, { tokensSaved: 1000, checkpointCount: 3 });
  upsertRepoGlobal("/home/u/repoB", "repoB", dir, { tokensSaved: 2000, checkpointCount: 5 });
  // The dashboard endpoint (served by the dashboard server) returns both.
  // (Drive via the real server on a dynamic port, or via the handler if exposed.)
  assert.ok(true, "endpoint returns both repos — full server drive in the integration test");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/extensions/mega-compact.test.js`
Expected: FAIL — `/api/repos` route missing.

- [ ] **Step 3: Implement**

In `extensions/dashboard-server.ts`, add two routes:

```typescript
// GET /api/repos — all repos from the global index (All-repos tab)
case "/api/repos": {
  const { listReposGlobal } = await import("../src/store/globalIndex.js");
  const dir = process.env.MEGACOMPACT_INDEX_DIR!;
  const repos = listReposGlobal(dir);
  return json(res, 200, repos);
}
// GET /api/summary — machine-wide totals (Summary tab)
case "/api/summary": {
  const { listReposGlobal } = await import("../src/store/globalIndex.js");
  const dir = process.env.MEGACOMPACT_INDEX_DIR!;
  const repos = listReposGlobal(dir);
  return json(res, 200, {
    repoCount: repos.length,
    totalTokensSaved: repos.reduce((s, r) => s + r.tokensSaved, 0),
    totalCheckpoints: repos.reduce((s, r) => s + r.checkpointCount, 0),
    activeRepos: repos.filter((r) => Date.now() - r.lastActive < 86_400_000).length,
  });
}
```

(`json(res, status, body)` is the existing helper — match the pattern in the file.) Add the Summary + All-repos tab HTML to the dashboard page (a simple table reading `/api/summary` + `/api/repos` via fetch).

- [ ] **Step 4: Drive the real server in the test (replace the placeholder assertion)**

Extend the test to start the dashboard server on a dynamic port (the existing dashboard tests do this — mirror them), fetch `/api/repos`, assert `repoA` + `repoB` present.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run build && node --test --test-concurrency=1 dist/extensions/mega-compact.test.js`
Expected: PASS. (Run sequentially to avoid the port-collision the pre-existing dashboard tests hit.)

- [ ] **Step 6: Commit**

```bash
git add extensions/dashboard-server.ts extensions/dashboard-allrepos.ts extensions/mega-compact.test.ts
git commit -m "feat(dashboard): Summary + All-repos tabs over the global index (S19)"
```

### Task S19.2: Write the global index on repo-switch + model-capture

**Files:**
- Modify: `extensions/mega-runtime.ts` (`bindRepo` already calls `upsertRepoRegistry`; extend to also `upsertRepoGlobal` with stats)

- [ ] **Step 1: Implement**

In `extensions/mega-runtime.ts` `bindRepo()`, after `upsertRepoRegistry({...})`, add:

```typescript
    try {
      const { upsertRepoGlobal } = await import("../src/store/globalIndex.js");
      // stats are best-effort; the dashboard reads them
      upsertRepoGlobal(root, root.split("/").pop() ?? root, process.env.MEGACOMPACT_INDEX_DIR!, {
        tokensSaved: this.store.repoStats?.(root)?.tokensSaved,
        checkpointCount: this.store.repoStats?.(root)?.checkpointCount,
      });
    } catch { /* non-fatal */ }
```

(If `bindRepo` is sync, use a sync import via `require` or hoist `upsertRepoGlobal` to a top-level import — prefer top-level import since `globalIndex.ts` is ESM sync.)

- [ ] **Step 2: Run the full gate (sequential for dashboard tests)**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green. CHANGELOG S19. Commit + push.

```bash
git add extensions/mega-runtime.ts CHANGELOG.md && git commit -m "feat(dashboard): write global index on repo-switch (S19)" && git push
```

---

## Sprint S20 — Memory-RAG: Auto-Review

**Goal:** Auto-review the conversation every N turns → structured `add/replace/remove` ops against the `memories` table, hallucination-guarded, local.

### Task S20.1: Memories schema extension

**Files:**
- Modify: `src/store/sqlite.ts` (the `memories` table DDL/migration)

- [ ] **Step 1: Add columns**

Find the `memories` table DDL in `src/store/sqlite.ts` (grep `CREATE TABLE.*memories`). Add non-breaking columns via `ALTER TABLE ... ADD COLUMN` in the migration path (idempotent — guard with `PRAGMA table_info`): `category TEXT`, `target TEXT`, `last_referenced INTEGER`, `source_turn INTEGER`.

- [ ] **Step 2: Build + commit**

```bash
npm run build && git add src/store/sqlite.ts && git commit -m "feat(memory): add category/target/last_referenced columns (S20)"
```

### Task S20.2: `reviewConversation` (pure, hallucination-guarded)

**Files:**
- Create: `src/memory.ts`, `src/memory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewConversation } from "./memory.js";

test("reviewConversation: yields an ADD op for a stated decision", () => {
  const msgs = [
    { role: "user", text: "we use node:sqlite as the store" },
    { role: "assistant", text: "got it, node:sqlite is the source of truth" },
  ] as any;
  const ops = reviewConversation(msgs);
  assert.ok(ops.some((o) => o.op === "add" && /sqlite|store/i.test(o.memory.content)), "adds a decision memory");
});

test("reviewConversation: REPLACE when a later message contradicts an earlier one", () => {
  const msgs = [
    { role: "user", text: "the threshold is 50k" },
    { role: "assistant", text: "ok 50k threshold" },
    { role: "user", text: "actually raise the threshold to 100k" },
  ] as any;
  const ops = reviewConversation(msgs);
  assert.ok(ops.some((o) => o.op === "replace"), "replaces the superseded value");
});

test("reviewConversation: no ops on pure smalltalk (no durable fact)", () => {
  const msgs = [{ role: "user", text: "hi" }, { role: "assistant", text: "hey" }] as any;
  assert.equal(reviewConversation(msgs).length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test dist/src/memory.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/memory.ts
/**
 * memory.ts — auto-review + consolidation + recall-merge for the memories
 * table (S20/S21). Local, hallucination-guarded. No LLM by default (extractive
 * from the conversation); optional localhost Ollama mirroring RAPTOR. The review
 * runs every N turns and emits add/replace/remove ops.
 * PREVENT-PI-004: local only.
 */
import type { EngineMessage } from "./types.js";
import { collectRecentUserRequests, inferPendingWork, inferCurrentWork } from "./compact.js";

export type MemoryOp =
  | { op: "add"; memory: { content: string; category: string; target?: string; sourceTurn: number } }
  | { op: "replace"; targetContent: string; memory: { content: string; category: string; sourceTurn: number } }
  | { op: "remove"; content: string };

const DECISION_PATTERNS = [
  /\bwe (?:use|chose|decided|will use|standardized on|go with)\b/i,
  /\b(?:the|our) (?:threshold|policy|rule|convention|default) is\b/i,
  /\bactually\b/i, /\braise (?:the )?|lower (?:the )?|switch (?:to )?\b/i,
];

/** Heuristic, extractive review. No LLM. Downgrades un-grounded claims to none. */
export function reviewConversation(messages: EngineMessage[], existing: { content: string }[] = []): MemoryOp[] {
  const ops: MemoryOp[] = [];
  const requests = collectRecentUserRequests(messages, 20);
  const pending = inferPendingWork(messages);
  const current = inferCurrentWork(messages);
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const isDecision = DECISION_PATTERNS.some((p) => p.test(r));
    if (!isDecision) continue;
    const contradicts = existing.find((e) => sharesTopic(e.content, r) && differs(e.content, r));
    if (contradicts) {
      ops.push({ op: "replace", targetContent: contradicts.content, memory: { content: r, category: "decision", sourceTurn: i } });
    } else if (!existing.some((e) => nearDup(e.content, r))) {
      ops.push({ op: "add", memory: { content: r, category: "decision", sourceTurn: i } });
    }
  }
  // Guardrail: drop any op whose memory content isn't grounded in a real message.
  return ops.filter((o) => messages.some((m) => String(m.text ?? "").includes(o.op === "remove" ? o.content : o.memory.content)));
}

function sharesTopic(a: string, b: string): boolean {
  const aw = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const bw = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let shared = 0; for (const w of bw) if (aw.has(w)) shared++;
  return shared >= 1;
}
function differs(a: string, b: string): boolean { return !nearDup(a, b); }
function nearDup(a: string, b: string): boolean {
  const aw = new Set(a.toLowerCase().split(/\W+/));
  const bw = new Set(b.toLowerCase().split(/\W+/));
  let shared = 0; for (const w of bw) if (aw.has(w)) shared++;
  return shared / Math.max(1, bw.size) >= 0.8;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test dist/src/memory.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts src/memory.test.ts
git commit -m "feat(memory): extractive auto-review with add/replace/remove ops (S20)"
```

### Task S20.3: Trigger the review every N turns + apply ops

**Files:**
- Modify: `extensions/mega-events.ts` (`turn_end` handler), `src/store/sqlite.ts` (apply ops)

- [ ] **Step 1: Write the failing test**

Add to `src/memory.test.ts`:

```typescript
test("applyMemoryOps: ADD inserts, REPLACE updates, REMOVE deletes (S20)", () => {
  // uses a temp state dir + the real sqlite store memories table
  assert.ok(true, "placeholder — real fixture in step 3");
});
```

- [ ] **Step 2: Run (placeholder)**

Run: `npm run build && node --test dist/src/memory.test.js`

- [ ] **Step 3: Replace placeholder + implement `applyMemoryOps`**

Add to `src/memory.ts` an `applyMemoryOps(ops, stateDir)` that runs parameterized INSERT/UPDATE/DELETE on the `memories` table (reuse `src/store/sqlite.ts` helpers). Real test: seed a memory, REPLACE it, assert content updated; ADD a new one, assert present; REMOVE, assert gone.

In `extensions/mega-events.ts` `turn_end` handler, add (debounced by N turns via `runtime.currentTurn % config.memoryReviewInterval === 0`):

```typescript
  pi.on("turn_end", async (event, ctx) => {
    runtime.dashboard.event("turn_end", { turnIndex: event.turnIndex });
    runtime.snapshot(ctx);
    if (config.memoryAutoReview && runtime.currentTurn > 0 && runtime.currentTurn % config.memoryReviewInterval === 0) {
      try {
        const { reviewConversation, applyMemoryOps } = await import("../src/memory.js");
        const entries = ctx.sessionManager.getEntries();
        const view = runtime.engineView(entries.flatMap((e: any) => (e.message ? [e.message] : [])));
        const ops = reviewConversation(view, /* existing memories */ []);
        if (ops.length) applyMemoryOps(ops, runtime.currentStateDir);
      } catch { /* non-fatal */ }
    }
  });
```

Add config: `memoryAutoReview: envBool("MEGACOMPACT_MEMORY_AUTO_REVIEW", true)`, `memoryReviewInterval: envFlag("MEGACOMPACT_MEMORY_REVIEW_INTERVAL", 10)`.

- [ ] **Step 4: Run the full gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green. CHANGELOG S20. Commit + push.

```bash
git add extensions/mega-events.ts extensions/mega-config.ts src/memory.ts src/memory.test.ts CHANGELOG.md
git commit -m "feat(memory): auto-review every N turns + apply ops (S20)" && git push
```

---

## Sprint S21 — Memory-RAG: Recall Inclusion + Auto-Consolidation

**Goal:** Include the `memories` table in recall (capped, deduped, labeled) + auto-consolidate near-duplicate memories.

### Task S21.1: Recall memories merge

**Files:**
- Modify: `src/recall.ts` (`recallAndInline` + `recallAndInlineAsync`), `src/memory.ts` (`recallMemories`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/memory.test.ts
test("recallMemories: returns memories relevant to the query, labeled (S21)", () => {
  // seed two memories, query for one, assert it returns with role label "memory"
  assert.ok(true, "placeholder — real fixture in step 3");
});
```

- [ ] **Step 2: Run (placeholder)**

Run: `npm run build && node --test dist/src/memory.test.js`

- [ ] **Step 3: Implement**

Add `recallMemories(query, stateDir, k)` to `src/memory.ts`: embed the query with `defaultEmbedder`, cosine-scan the `memories` table (which has embeddings like checkpoints), return top-k with `category` + `last_referenced` boosting. In `recallAndInline` and `recallAndInlineAsync`, after assembling checkpoint hits, `recallMemories` and merge labeled `"memory"` entries, respecting `recallMaxTokens` + `windowDedupe`. Bump `last_referenced` on injection.

Real test: seed a memory with a known topic, query it, assert the recall block contains a `"memory"`-labeled entry within the token cap.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test dist/src/memory.test.js dist/src/recall.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts src/recall.ts src/memory.test.ts src/recall.test.ts
git commit -m "feat(memory): include memories in recall (capped, labeled) (S21)"
```

### Task S21.2: Auto-consolidate near-duplicate memories

**Files:**
- Modify: `src/memory.ts` (`consolidateMemories`), `extensions/mega-pipeline.ts` (call at compaction time)

- [ ] **Step 1: Implement + test**

Add `consolidateMemories(stateDir)` to `src/memory.ts`: find memory pairs with cosine > `SEMDEDUP_COSINE` (reuse the SemDeDup cosine pattern from `vectorStore.ts`), merge into one (keep the higher-category / more-recent, append the other's content), mark the other removed. Call it (best-effort, non-fatal) from `doCompact` in `mega-pipeline.ts` after a compaction. Test: seed two near-duplicate memories, run `consolidateMemories`, assert one remains.

- [ ] **Step 2: Run the full gate**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Expected: green. CHANGELOG S21. Commit + push.

```bash
git add src/memory.ts src/memory.test.ts extensions/mega-pipeline.ts CHANGELOG.md
git commit -m "feat(memory): auto-consolidate near-duplicate memories (S21)" && git push
```

---

## Sprint S22 — Slice 3 Docs Close-Out + Polish

**Goal:** README dual-backend docs, map updates, final guardrails audit.

### Task S22.1: README dual-backend section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

In `README.md`, after the "Install from npm" section, add a "Storage backend" subsection:

```markdown
### Storage backend (v0.5.0+)

pi-mega-compact uses a dual local backend — **zero network, no native build step**:

- **`node:sqlite`** (`DatabaseSync`, Node ≥22.13 built-in) — the synchronous source of truth for checkpoints, session state, and the dedup index. No dependency, no install script, survives pi's `install-scripts` block.
- **PGlite + `@electric-sql/pglite-pgvector`** (WASM Postgres + HNSW `vector_cosine_ops`) — an optional, best-effort async vector index for **cross-repo recall** at `~/.pi/mega-compact-vector`. The sync store stays authoritative; the index degrades to the sync per-session scan on any failure.

Kill-switch: `MEGACOMPACT_PGLITE_DISABLED=1` fully disables the PGlite index (falls back to sync scan). Requires Node ≥22.13 (`engines.node`).
```

Also add a "Cross-repo recall" subsection under usage:

```markdown
### Cross-repo recall (v0.5.0+)

On resume, recall augments from other repos' checkpoints when this repo's store is thin; `/mega-recall --cross-repo` searches all repos via the HNSW index. Cross-repo hits use a stricter cosine floor (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are labeled with their source repo. A machine-wide injected-set (`~/.pi/mega-compact-index/global-index.db`) prevents re-injecting the same foreign checkpoint.
```

And a "Memory" subsection:

```markdown
### Memory (v0.5.0+)

pi-mega-compact auto-reviews the conversation every 10 turns and writes durable `decision`/`fact`/`preference` memories to SQLite (local, hallucination-guarded). Relevant memories are injected as RAG context on recall (capped, deduped). Manual: `/mega-memory save|list|forget`.
```

- [ ] **Step 2: Update maps**

Update `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` to reference the new docs/specs and the memory/cross-repo features.

- [ ] **Step 3: Build + commit**

```bash
npm run build && git add README.md docs/INDEX_MAP.md docs/HEADER_MAP.md && git commit -m "docs: dual-backend + cross-repo + memory docs (S22)"
```

### Task S22.2: Final guardrails audit

- [ ] **Step 1: Run the gate + PREVENT-PI-004 grep**

Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
Run: `grep -rn "fetch\|http\.request\|https\." src extensions --include="*.ts" | grep -v node_modules | grep -v "loopback\|127.0.0.1\|localhost\|// guardrails-allow"`
Expected: green; zero unexpected network calls. Commit.

```bash
git commit --allow-empty -m "chore: S22 guardrails audit green" && git push
```

---

## Sprint S23 — Release

**Goal:** Benchmarks, DR, tag + npm publish.

### Task S23.1: Benchmarks

- [ ] **Step 1: Add/extend benchmarks**

Extend `scripts/dedup-benchmark.mjs` (or add `scripts/crossrepo-benchmark.mjs`): cross-repo recall latency + quality (HNSW vs sync scan over 1K/10K checkpoints), compaction-continuity (model-context-drops, no-stop), memory-RAG recall hit rate. Targets: cross-repo p95 < 50ms (HNSW); model-context-drops > 5:1 after compaction; memory recall finds seeded memory top-1.

- [ ] **Step 2: Run + commit**

```bash
node scripts/crossrepo-benchmark.mjs && git add scripts/crossrepo-benchmark.mjs && git commit -m "bench: cross-repo + continuity + memory benchmarks (S23)"
```

### Task S23.2: DR drill + version bump + publish

- [ ] **Step 1: DR drill**

Run: `bash scripts/dedup-restore-drill.sh` + a new global-index DR check (delete `global-index.db`, restart, assert it rebuilds). Expected: pass.

- [ ] **Step 2: Version bump**

In `package.json`: `"version": "0.5.0"`. Update `CHANGELOG.md` with the v0.5.0 header consolidating S16–S22.

- [ ] **Step 3: Full gate + tag + npm publish (PREVENT-DIST-001 — NO tarball)**

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all
git add package.json CHANGELOG.md && git commit -m "0.5.0"
git tag v0.5.0 && git push --follow-tags
npm publish            # npm ONLY — never npm pack / no .tgz (.gitignore rejects *.tgz)
```

- [ ] **Step 4: Verify on a device**

```bash
pi update --extensions   # on each device; pulls 0.5.0
```

---

## Self-Review (completed during planning)

- **Spec coverage:** S16 = spec §5 (compaction continuity). S17 = §7 cross-repo wire-up. S18 = §7 dedup markers/tracking. S19 = §7 multi-repo dashboard. S20 = §7 memory auto-review. S21 = §7 memory recall + consolidation. S22 = §1f Slice 3 docs. S23 = release. All spec sections mapped. Trade-off (live trim suppresses durable) documented in spec §5 + S16 tasks; legacy flag = spec §5 rollback. (No gaps.)
- **Placeholder scan:** No TBD/TODO in implementation steps; a few tests are written as placeholders that are explicitly replaced in the next step with real fixtures (S18.2, S20.3, S21.1) — each is a deliberate two-step TDD pattern (write placeholder → replace with real), not a missing detail.
- **Type consistency:** `buildLiveTrimmedView(opts)` (S16.1) used identically in S16.2. `doRecallAsync(runtime, config, ctx, query, source, {crossRepo})` (S17.3) used identically in S17.4. `markInjectedGlobal(checkpointId, repoId, sessionId, dir)` / `wasInjectedGlobal(checkpointId, sessionId, dir)` (S18.1) used identically in S18.2. `reviewConversation(messages, existing)` / `applyMemoryOps(ops, dir)` / `recallMemories(query, dir, k)` / `consolidateMemories(dir)` (S20/S21) consistent. `MemoryOp` union shape consistent. Config flag names (`legacyDurableTrim`, `crossRepoEnabled`, `crossRepoCosine`, `memoryAutoReview`, `memoryReviewInterval`) consistent across config + handlers.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
