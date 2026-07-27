# S40 — Importance Scoring for Compaction

**Date:** 2026-07-26 (re-planned 2026-07-25)
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 8 (SQLite store), Sprint 10 (L0 dedup), S24 (unified pressure), `src/engine.ts` compactSession pipeline
**Priority:** P1
**Status:** S40A shipped (commit `f24311f`) → S40B-rev implement-ready
**Target version:** v0.8.0

---

## RE-PLAN 2026-07-25

A 5-agent audit of the original S40 spec found three categories of mock/stub data in the integration path that the re-plan removes entirely. The pure math (S40A) was clean and shipped — only the integration layer (S40B) is being rewritten.

### What was wrong

1. **Mock timestamps (THE core defect).** The original S40B-2 spec scored messages with invented position-based timestamps:
   ```ts
   // ORIGINAL (REMOVED):
   timestamp: now - (messages.length - i) * 60_000 // approximate age from position
   ```
   The spec's own RISKS table admitted "Timestamp approximation (position-based age) is inaccurate for real sessions" and promised a "use actual message timestamps if available from the extension adapter" mitigation that was never specced concretely or delivered. This is mock data — every real message carries a real timestamp that the spec chose to invent rather than thread through.

2. **Hardcoded `userFlagged`.** `scoreEngineMessages` hardcoded `userFlagged: false` with no path for real user-flag signals. Mock — there is no real user-flag signal in the current codebase, so hardcoding `false` hides the gap instead of modeling it honestly as an unused-until-wired optional field.

3. **Feature flag default OFF.** The original spec gated all new code behind `IMPORTANCE_SCORING = false` ("zero behavior change unless explicitly enabled"). The re-plan flips this: the memory system REMEMBERS BY DEFAULT — feature ON, env-overridable to opt OUT. The default-ON position reflects what the system should actually do for users.

### The real-signal fix (verified by a real-signal-availability audit)

Real per-message timestamps ARE available all the way from pi to `compactSession`. The chain:

- Every pi message type (`UserMessage`, `AssistantMessage`, `ToolResultMessage`, all custom coding-agent types) carries `timestamp: number` (epoch ms).
- `sessionEntryToContextMessages` in pi's session-manager propagates `entry.timestamp` into `createXXXMessage(..., entry.timestamp)`.
- The compaction handler in `extensions/mega-compact-driver.ts` has the raw `AgentMessage[]` (`prep.messagesToSummarize`) with real timestamps at line ~57.
- `toEngineMessages` in `src/adapt.ts` (line ~88–108) DROPS the timestamp — it only maps role/toolName/text/input/output. This is the ONLY loss point in the chain.
- `EngineMessage` in `src/types.ts` has NO `timestamp` field.

So the fix is 3 surgical edits (S40B-rev-1):

1. `src/types.ts`: add `timestamp?: number` to `EngineMessage`.
2. `src/adapt.ts` (`toEngineMessages`): read `(m as {timestamp?: number}).timestamp` and include it.
3. `src/importance.ts` (`scoreEngineMessages`): use `m.timestamp ?? (now - (messages.length - i) * 60_000)` — the position-based formula becomes a TRUE fallback for synthetic test inputs only, NEVER hit in production where every real message carries a real timestamp.

The `driveNativeCompaction` call site needs NO change — `messagesToSummarize` already has real timestamps; they just need to thread through the adapter.

### The userFlagged signal

There is no real user-flag signal in the current codebase. Rather than hardcode `false` (a mock), the re-plan's honest position: `userFlagged` is an opt-in field on `EngineMessage` (`userFlagged?: boolean`) that the adapter does NOT populate by default (no real signal exists yet), and `score()` honors it when present (3x retention boost). When absent, `retentionBoost` is 1.0. This is honest — it is not a mock, it is a real optional field that is simply unused until a real signal source is wired. Documented that way in S40B-rev-1. Do NOT hardcode `false` silently.

### The calibration contract (applies to EVERY constant in the spec)

Every invented constant becomes:

- A config export in `src/config.ts` (env-overridable).
- Labeled with `uncalibrated: true` by default.
- Backed by a `scripts/calibrate-importance.mjs` script that reads REAL stored data (real `context_chunks` from the SQLite store) and reports the score distribution + recommends a value, writing `~/.pi/mega-compact/calibration.json`.
- Logged with an `uncalibrated: true` field + a `note: "run scripts/calibrate-importance.mjs"` until calibrated.

Constants to make configurable + calibrated:

- `IMPORTANCE_PRESERVE_RATIO` (default 0.2)
- `IMPORTANCE_DECAY_RATE` (default 0.05 = 5%/hr)
- `IMPORTANCE_MAX_DECAY` (default 0.7)
- `IMPORTANCE_RECENCY_THRESHOLD_MS` (default 300_000 = 5min)
- The 8 `DEFAULT_MULTIPLIERS` (UserMessage 1.5, AssistantMessage 1.0, SystemMessage 0.5, CodeBlock 1.2, Error 2.0, Decision 2.5, FileModification 1.8, ToolExecution 1.3) — these come from the Rust reference; label them `uncalibrated` (sourced from the reference, not locally measured) and note they need local calibration.

### The error-logging + gating contract

- Every feature gated on a config flag (default ON, env-overridable to OFF).
- Every scoring run logs a structured event via `Logger` (injected via `CompactInput.logger?`) with real field values: `{totalScored, preserved, preserveRatio, topScore, threshold, uncalibrated}`.
- When `uncalibrated: true`, the log includes `note: "run scripts/calibrate-importance.mjs"`.
- No silent failures: if `score()` throws, the error propagates AND an `importance_scoring_failed` event is logged with the real error; importance preservation is skipped but compaction continues. Never a silent no-op.
- Gating: scoring block runs when `importanceCfg.enabled && keep.length > 0`. When OFF, the block is a complete no-op (byte-identical to pre-S40 — the flag-off regression test asserts this).

### S40A status (already shipped clean)

S40A shipped as commit `f24311f`. `src/importance.ts` + `src/importance.test.ts` exist with 32 passing tests — the pure scoring math (`ageDecay`, `recencyBoost`, `retentionBoost`, `detectItemType`, `score`, `preservationCutoff`, `itemsToPreserve`, `scoreEngineMessages`). S40A is clean (pure functions, no mocks). The ONLY mock in S40A is `scoreEngineMessages`'s position-based fallback, which S40B-rev-1 fixes by threading real timestamps. This is called out in the spec; the rest of S40A is not re-executed.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): importance scoring must NEVER cause the anchor-floor guard in `src/boundary.ts:computeDropRange()` to be bypassed. The most recent N user messages are always preserved, regardless of their importance score. Importance scoring augments, never replaces, the boundary guard.
- **PREVENT-PI-002** (tool pairs): importance scoring must NEVER split an `assistant(toolCall)` from its following `tool` result. A tool result (role "tool") is paired with the preceding assistant tool-call (role "assistant" with `toolName`). If either is preserved, both are preserved (partner-expansion in S40B-rev-2).
- **PREVENT-PI-003** (no system role): scored items are injected via the existing `before_agent_start` systemPrompt prepend path — never as a `role:"system"` message.
- **Feature flag default ON** (`IMPORTANCE_SCORING` = `true`): the memory system remembers by default. Env-overridable to OFF via `MEGACOMPACT_IMPORTANCE_SCORING=0`. All new code paths are gated behind `if (importanceCfg.enabled)`. When the flag is OFF, the scoring block is a complete no-op (byte-identical to pre-S40 output — asserted by the flag-off regression test).
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's `compactSession()` in `src/engine.ts` (line ~110–185) treats all messages equally:

1. **All old messages are summarized identically** — a decision message ("we decided to use JWT auth") and a filler message ("ok, sounds good") receive the same compaction treatment. The extractive summarizer (`src/extractive.ts:extractiveSummarize()`) does extract key decisions, but the decision text is folded into the summary and the original message is dropped. There is no mechanism to preserve important messages verbatim outside the anchor window.

2. **No importance-aware selection** — `src/supersede.ts:findSuperseded()` handles file-read supersession (Layer 1), but nothing scores non-file messages by importance. `src/compact.ts:isChatty()` detects filler but only for collapse decisions, not for preservation.

3. **No age-weighted importance** — a 3-hour-old decision is treated the same as a 5-minute-old one. The Rust reference (`router/src/context/importance.rs`) implements 5%/hour age decay (capped at 70%), recency boost (1.2x for items <5min old), and retention boost (3x for user-flagged items). None of this exists in the TypeScript codebase.

4. **Aggressive summarization of recent low-importance messages** — when `preserveRecent` is set to e.g. 20, ALL of those 20 messages are kept verbatim, even if some are trivial "ok" responses. Under high pressure, those slots are wasted.

**Root cause:** the compaction pipeline was built as a single-pass summarize-and-drop with no scoring dimension. Importance is a new axis orthogonal to the existing supersede/collapse/cluster pipeline. The re-plan additionally fixes an adjacent root cause: real per-message timestamps existed in pi's runtime but were dropped at the `toEngineMessages` adapter boundary, so any scoring that wanted real age had no path to get it.

---

## SCOPE

**IN SCOPE (new files):**
- `src/importance.ts` — already shipped in S40A (commit `f24311f`); S40B-rev-1 patches `scoreEngineMessages` to use real timestamps.
- `src/importance.test.ts` — already shipped in S40A; S40B-rev-7 adds integration scenarios.
- `scripts/calibrate-importance.mjs` — calibration script (reads REAL `context_chunks` from the SQLite store, reports score distribution, recommends values, writes `~/.pi/mega-compact/calibration.json`).

**IN SCOPE (modified files):**
- `src/types.ts` — add `timestamp?: number` and `userFlagged?: boolean` to `EngineMessage` (S40B-rev-1).
- `src/adapt.ts` (`toEngineMessages`) — thread `(m as {timestamp?: number}).timestamp` into the engine view (S40B-rev-1). Single-line-per-branch edit; no other behavior change.
- `src/engine.ts` — insert LAYER 1.5 (importance scoring) between LAYER 1 (supersede) and LAYER 2 (collapse); add `importancePreserved` to `CompactResult`; add `logger?` + `importanceConfig?` to `CompactInput`.
- `src/config.ts` — add `IMPORTANCE_SCORING` (default ON), `IMPORTANCE_PRESERVE_RATIO`, `IMPORTANCE_DECAY_RATE`, `IMPORTANCE_MAX_DECAY`, `IMPORTANCE_RECENCY_THRESHOLD_MS`, `IMPORTANCE_MULTIPLIERS` — all env-overridable, all carrying an `uncalibrated: true` marker.
- `src/compact.ts` (or `src/engine.ts`) — add `formatPreservedContext()` helper that prepends a `## Preserved context (high importance)` section to the summary.

**OUT OF SCOPE:**
- Changes to `src/boundary.ts` — the anchor-floor and tool-pair guards are untouched.
- Changes to `src/vectorStore.ts` — scoring happens before persistence.
- Dashboard visualization of importance scores (future sprint).
- Learning/reinforcement of multipliers from user feedback.
- Per-session adaptive multipliers.
- Wiring a real `userFlagged` signal source (e.g., a pi command, a `@remember` mention). The field exists; population is deferred until a real signal lands.

---

## EXECUTION

### Sprint S40A: Core Scoring Engine — SHIPPED

S40A shipped as commit `f24311f`. `src/importance.ts` (312 lines) + `src/importance.test.ts` (538 lines, 32 passing tests) exist with the pure scoring math: `ContextItemType`, `ScoredItem`, `PreservationResult`, `DEFAULT_MULTIPLIERS`, `ageDecay()`, `recencyBoost()`, `retentionBoost()`, `detectItemType()`, `score()`, `preservationCutoff()`, `itemsToPreserve()`, `scoreEngineMessages()`. Not re-executed.

The one S40A mock — `scoreEngineMessages`'s position-based timestamp fallback — is patched in S40B-rev-1 below.

---

### Sprint S40B-rev: Integration into `compactSession()` Pipeline (real signals only)

**Goal:** Wire importance scoring into the compaction pipeline so high-importance old messages are preserved verbatim and low-importance recent messages are compressed. Use real per-message timestamps threaded from the adapter; make every constant configurable + calibration-labeled; log every run with real fields; never fail silently.

**Acceptance:** With `IMPORTANCE_SCORING=true` (the default), a session containing a decision message outside the anchor window preserves that message verbatim in the compacted output. With `IMPORTANCE_SCORING=false`, behavior is byte-identical to current production (no preserved section, no scoring log). Every constant is configurable + carries an `uncalibrated` marker until calibrated. Every scoring run logs a structured event with real fields. `score()` throwing never silently skips compaction.

**Tasks:**

- [ ] **S40B-rev-1: Thread real signals through `EngineMessage` + adapter** (`src/types.ts`, `src/adapt.ts`, `src/importance.ts`)

  `src/types.ts` — extend `EngineMessage`:
  ```ts
  export interface EngineMessage {
    role: "user" | "assistant" | "tool" | "custom";
    text: string;
    toolName?: string;
    input?: string;
    output?: string;
    /** Epoch ms (real per-message timestamp threaded from the pi adapter;
     *  undefined only for synthetic test inputs — score() falls back to a
     *  position-based estimate in that case, never hit in production). */
    timestamp?: number;
    /** Opt-in user-flagged retention signal. The adapter does NOT populate
     *  this by default (no real signal source exists yet). When present and
     *  true, score() applies a 3x retentionBoost. Honest optional, not a
     *  hardcoded false. */
    userFlagged?: boolean;
  }
  ```

  `src/adapt.ts` (`toEngineMessages`) — thread the timestamp. One added field per return branch:
  ```ts
  export function toEngineMessages(messages: AgentMessage[]): EngineMessage[] {
    return messages.map((m) => {
      const role = messageRole(m);
      const toolName = messageToolName(m);
      const text = messageText(m);
      // S40B-rev-1: thread real per-message timestamp from pi. This is the
      // ONLY place the chain could lose it; every AgentMessage carries one.
      const ts = (m as { timestamp?: number }).timestamp;
      if (m.role === "toolResult") {
        return { role, text, toolName, output: text, timestamp: ts } satisfies EngineMessage;
      }
      if (m.role === "assistant") {
        const blocks = m.content as Array<{ type: string; text?: string; arguments?: unknown }>;
        const callBlock = blocks.find((c) => c.type === "toolCall");
        const input = callBlock
          ? typeof callBlock.arguments === "string"
            ? callBlock.arguments
            : JSON.stringify(callBlock.arguments ?? {})
          : undefined;
        return { role, text, toolName, input, timestamp: ts } satisfies EngineMessage;
      }
      return { role, text, toolName, timestamp: ts } satisfies EngineMessage;
    });
  }
  ```
  The `userFlagged` field is intentionally NOT populated by the adapter — no real signal exists yet. Documented honestly as an unused optional, not a silent `false`.

  `src/importance.ts` (`scoreEngineMessages`) — use real timestamp when present; demote the position-based formula to a TRUE fallback for synthetic test inputs only:
  ```ts
  export function scoreEngineMessages(
    messages: EngineMessage[],
    now: number,
    multipliers?: Partial<Record<ContextItemType, number>>,
    opts?: { decayRatePerHour?: number; maxDecay?: number; recencyThresholdMs?: number },
  ): ScoredItem[] {
    return messages.map((m, i) => {
      // S40B-rev-1: real per-message timestamp threaded from the adapter.
      // The position-based formula below is a SYNTHETIC-TEST-INPUT FALLBACK
      // ONLY — it is NEVER hit in production where every real message
      // carries a real timestamp. Do not treat it as the primary path.
      const timestamp = m.timestamp ?? (now - (messages.length - i) * 60_000);
      return score(
        {
          id: String(i),
          content: m.text ?? "",
          role: m.role,
          timestamp,
          // Honest optional: undefined when no real user-flag signal is wired.
          // score() treats undefined as false (retentionBoost 1.0). Do NOT
          // hardcode false here — that would hide the missing-signal gap.
          userFlagged: m.userFlagged,
        },
        now,
        multipliers,
        opts,
      );
    });
  }
  ```

  `driveNativeCompaction` in `extensions/mega-compact-driver.ts` needs NO change — `messagesToSummarize` already carries real timestamps; they now thread through the adapter.

  **Acceptance for S40B-rev-1:** `EngineMessage` carries `timestamp?` + `userFlagged?`; `toEngineMessages` populates `timestamp` from `AgentMessage.timestamp`; `scoreEngineMessages` reads `m.timestamp`; existing 372 tests pass unchanged (timestamp is optional, additive).

- [ ] **S40B-rev-2: Insert LAYER 1.5 into `compactSession()` in `src/engine.ts`**

  Between LAYER 1 (supersede) and LAYER 2 (collapse), after `keep` is computed:
  ```ts
  // LAYER 1.5 — IMPORTANCE SCORING (S40): score the compactable slice and
  // preserve the highest-importance items verbatim. Preserved items bypass
  // summarization (no duplication); the summary covers only the remainder.
  // Real per-message timestamps are threaded from the adapter (S40B-rev-1).
  let importancePreserved: EngineMessage[] = [];
  const importanceCfg = input.importanceConfig ?? {
    enabled: IMPORTANCE_SCORING,
    preserveRatio: IMPORTANCE_PRESERVE_RATIO,
    multipliers: IMPORTANCE_MULTIPLIERS,
    decayRatePerHour: IMPORTANCE_DECAY_RATE,
    maxDecay: IMPORTANCE_MAX_DECAY,
    recencyThresholdMs: IMPORTANCE_RECENCY_THRESHOLD_MS,
  };
  if (importanceCfg.enabled && keep.length > 0) {
    const now = input.timestamp ?? Date.now();
    try {
      const scored = scoreEngineMessages(keep, now, importanceCfg.multipliers, {
        decayRatePerHour: importanceCfg.decayRatePerHour,
        maxDecay: importanceCfg.maxDecay,
        recencyThresholdMs: importanceCfg.recencyThresholdMs,
      });
      const { preservedIds, threshold } = itemsToPreserve(scored, importanceCfg.preserveRatio);

      // PREVENT-PI-002: partner-expand preserved IDs so toolCall/toolResult
      // pairs survive intact. A tool result (role "tool") is paired with the
      // preceding assistant tool-call (role "assistant" with toolName). If
      // either is preserved, both are.
      const expandedIds = new Set<string>(preservedIds);
      for (let i = 0; i < keep.length; i++) {
        if (!expandedIds.has(String(i))) continue;
        const m = keep[i];
        if (m.role === "tool" && i > 0 && keep[i - 1].role === "assistant" && keep[i - 1].toolName) {
          expandedIds.add(String(i - 1));
        } else if (m.role === "assistant" && m.toolName && i + 1 < keep.length && keep[i + 1].role === "tool") {
          expandedIds.add(String(i + 1));
        }
      }

      importancePreserved = keep.filter((_, i) => expandedIds.has(String(i)));
      // Rebuild `keep` to exclude preserved items — they bypass summarization.
      keep = keep.filter((_, i) => !expandedIds.has(String(i)));

      // S40B-rev-6: structured logging with REAL field values.
      input.logger?.("info", "importance_scoring", {
        totalScored: scored.length,
        preserved: importancePreserved.length,
        preserveRatio: importanceCfg.preserveRatio,
        topScore: scored.length ? Math.max(...scored.map(s => s.finalScore)) : 0,
        threshold,
        uncalibrated: true,
        note: "run scripts/calibrate-importance.mjs",
      });
    } catch (err) {
      // No silent failures: log the real error and skip preservation,
      // but compaction MUST continue. The error propagates to the caller
      // AND the event is logged with the real error.
      input.logger?.("error", "importance_scoring_failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Re-throw per the no-silent-failure contract; the caller's
      // driveNativeCompaction wraps compactSession in try/catch and continues
      // with summarization-only when importance throws.
      throw err;
    }
  }
  ```

  After LAYER 2 builds the summary, prepend the preserved section:
  ```ts
  if (importancePreserved.length > 0) {
    summary = formatPreservedContext(importancePreserved) + "\n\n" + summary;
  }
  ```

  `formatPreservedContext()` (new helper in `src/compact.ts` or `src/engine.ts`):
  ```ts
  /** Format preserved high-importance messages as a verbatim section. */
  export function formatPreservedContext(messages: EngineMessage[]): string {
    const lines = messages.map((m) => {
      const label = m.role === "user" ? "User"
        : m.role === "assistant" ? "Assistant"
        : m.role === "tool" ? `Tool(${m.toolName ?? "unknown"})`
        : "System";
      return `- [${label}]: ${m.text}`;
    });
    return `## Preserved context (high importance)\n${lines.join("\n")}`;
  }
  ```

- [ ] **S40B-rev-3: Update `CompactResult` + `CompactInput` interfaces** (`src/engine.ts`)

  `CompactResult`:
  ```ts
  export interface CompactResult {
    // ... existing fields ...
    /** Messages preserved verbatim due to high importance score (S40).
     *  Empty when importance scoring is OFF or nothing scored high enough. */
    importancePreserved?: EngineMessage[];
  }
  ```

  `CompactInput`:
  ```ts
  export interface CompactInput {
    // ... existing fields ...
    /** Optional logger for structured scoring events (S40B-rev-6). When
     *  absent, scoring runs silently — the no-silent-failure contract
     *  still applies to score() throws, which propagate to the caller. */
    logger?: (level: "info" | "error" | "warn", event: string, fields: Record<string, unknown>) => void;
    /** Per-call override of importance-scoring config (S40B-rev). Tests
     *  inject config here to avoid ESM env coupling. Production callers
     *  leave this undefined and the module-level defaults apply. */
    importanceConfig?: {
      enabled: boolean;
      preserveRatio: number;
      multipliers?: Partial<Record<ContextItemType, number>>;
      decayRatePerHour?: number;
      maxDecay?: number;
      recencyThresholdMs?: number;
    };
  }
  ```

- [ ] **S40B-rev-4: Config + calibration contract** (`src/config.ts`, `scripts/calibrate-importance.mjs`)

  `src/config.ts` — add env-overridable exports. Each constant carries an `uncalibrated: true` marker until `~/.pi/mega-compact/calibration.json` is written by the calibration script:
  ```ts
  /** Enable importance-aware compaction (S40). Default ON — the memory
   *  system remembers by default. Env MEGACOMPACT_IMPORTANCE_SCORING=0
   *  disables. */
  export const IMPORTANCE_SCORING = process.env.MEGACOMPACT_IMPORTANCE_SCORING !== "0";

  /** Fraction of old messages to preserve verbatim based on importance (0–1).
   *  Uncalibrated — run scripts/calibrate-importance.mjs to calibrate. */
  export const IMPORTANCE_PRESERVE_RATIO = Number(process.env.MEGACOMPACT_IMPORTANCE_PRESERVE_RATIO ?? 0.2);

  /** Per-type multiplier overrides (empty = use DEFAULT_MULTIPLIERS).
   *  The defaults are sourced from the Rust reference, not locally measured
   *  — uncalibrated until scripts/calibrate-importance.mjs is run. */
  export const IMPORTANCE_MULTIPLIERS: Partial<Record<string, number>> =
    JSON.parse(process.env.MEGACOMPACT_IMPORTANCE_MULTIPLIERS ?? "{}");

  /** Age decay rate per hour (default 0.05 = 5%/hr). Uncalibrated. */
  export const IMPORTANCE_DECAY_RATE = Number(process.env.MEGACOMPACT_IMPORTANCE_DECAY_RATE ?? 0.05);

  /** Max age decay cap (default 0.7 = 70%). Uncalibrated. */
  export const IMPORTANCE_MAX_DECAY = Number(process.env.MEGACOMPACT_IMPORTANCE_MAX_DECAY ?? 0.7);

  /** Recency boost threshold in ms (default 5 minutes). Uncalibrated. */
  export const IMPORTANCE_RECENCY_THRESHOLD_MS = Number(process.env.MEGACOMPACT_IMPORTANCE_RECENCY_THRESHOLD_MS ?? 300_000);

  /** True until scripts/calibrate-importance.mjs writes
   *  ~/.pi/mega-compact/calibration.json. Logged with every scoring run. */
  export const IMPORTANCE_UNCALIBRATED = !existsSync(join(STATE_DIR_DEFAULT, "calibration.json"));
  ```

  `scripts/calibrate-importance.mjs` — reads REAL stored data and reports the score distribution + recommends values:
  - Opens the SQLite store at `STATE_DIR_DEFAULT` (or `MEGACOMPACT_STATE_DIR`).
  - Reads real `context_chunks` rows (real summaries + real timestamps + real `region_text`).
  - Runs `scoreEngineMessages` over each chunk's reconstructed messages (or scores the chunk summaries directly when reconstruction is not feasible — document which).
  - Reports the score distribution (min/p50/p95/max per `ContextItemType`), the count preserved at `IMPORTANCE_PRESERVE_RATIO=0.2`, and the implied cutoff.
  - Recommends a calibrated `preserveRatio`, `decayRate`, and per-type multipliers based on the real distribution.
  - Writes `~/.pi/mega-compact/calibration.json` with the recommended values + a `calibratedAt` timestamp.
  - When the JSON exists, `IMPORTANCE_UNCALIBRATED` flips to `false` and the scoring log drops the `note`.

  The 8 `DEFAULT_MULTIPLIERS` in `src/importance.ts` (UserMessage 1.5, AssistantMessage 1.0, SystemMessage 0.5, CodeBlock 1.2, Error 2.0, Decision 2.5, FileModification 1.8, ToolExecution 1.3) come from the Rust reference `router/src/context/importance.rs`. They are labeled `uncalibrated` (sourced from the reference, not locally measured) and need local calibration via the script.

- [ ] **S40B-rev-5: Update `formatCompactSummary()` / formatter** (`src/compact.ts` or `src/engine.ts`)

  When `importancePreserved.length > 0`, the summary output begins with:
  ```
  ## Preserved context (high importance)
  - [User]: "We decided to use JWT auth for the API layer"
  - [Assistant]: "Error: ENOENT — file not found at src/config.ts:42"
  - [Tool(read_file)]: <result text>

  ## Compacted summary
  <existing summary text>
  ```
  Implemented via the `formatPreservedContext()` helper from S40B-rev-2. The extension can also read `CompactResult.importancePreserved` directly to render preserved messages in the compacted context block.

- [ ] **S40B-rev-6: Error-logging + gating contract** (`src/engine.ts`)

  Enforced as part of S40B-rev-2's try/catch block. Stated here as a standalone contract so it is auditable:

  - **Logger injection:** `CompactInput.logger?` (added in S40B-rev-3). When absent, scoring runs silently EXCEPT for `score()` throws, which propagate to the caller.
  - **Structured event on every scoring run:** `logger("info", "importance_scoring", {totalScored, preserved, preserveRatio, topScore, threshold, uncalibrated, note?})` — all fields populated from REAL scoring results, not invented.
  - **`uncalibrated: true` + `note: "run scripts/calibrate-importance.mjs"`** included when `IMPORTANCE_UNCALIBRATED` is true (S40B-rev-4).
  - **No silent failures:** if `score()` throws, `logger("error", "importance_scoring_failed", {error, stack})` is logged with the REAL error, then the error is re-thrown. The caller's `driveNativeCompaction` wraps `compactSession` in try/catch and continues with summarization-only (preservation skipped, compaction continues). Never a silent no-op.
  - **Gating:** the scoring block runs when `importanceCfg.enabled && keep.length > 0`. When OFF, the block is a complete no-op — no scoring, no logging, no preserved section. Byte-identical to pre-S40 output. The flag-off regression test (S40B-rev-7 scenario 6) asserts this.

- [ ] **S40B-rev-7: Integration tests** (`src/importance.test.ts` or `src/engine.test.ts`)

  Test scenarios. Where a scenario exercises the integration path (scoring real EngineMessages through compactSession), it uses REAL per-message timestamps set explicitly on each EngineMessage — not the position-based fallback. The fallback is only exercised in a dedicated unit test that asserts it activates when `m.timestamp` is undefined.

  Reference pattern: `src/recall.test.ts` was already migrated (in a committed PR0 change) from `as any` mock stores with canned `searchAsync` returns to real-data integration tests — real foreign `VectorStore` + `rebuildFromSqlite` + real `recallAndInlineAsync` cross-repo recall. New S40 integration tests follow this real-data pattern: real `EngineMessage[]` with real timestamps, real `compactSession` calls, asserting remembering behavior on the actual output string.

  1. **Decision preserved:** Session of 30 messages, message #5 is a decision ("decided to use JWT"). With `IMPORTANCE_SCORING=true` (default), `IMPORTANCE_PRESERVE_RATIO=0.2`, the decision appears verbatim in the compacted output's `## Preserved context` section. Uses real timestamps: message #5 has a timestamp ~25 minutes in the past.
  2. **Error preserved:** Message #10 contains an error trace. Scored as `Error` type (2.0x). Preserved when ratio allows. Real timestamp ~20 minutes in the past.
  3. **Filler not preserved:** Message #3 is "ok, sounds good". Type = `AssistantMessage` (1.0x). Old age (real timestamp ~27 min past) → low score. Not preserved.
  4. **Anchor floor unaffected:** With `preserveRecent=10` and importance scoring on, the last 10 messages are still verbatim (boundary guard is untouched). Verified by reading the drop range, not the importance-preserved set.
  5. **Tool pair intact:** If a tool-execution message (role "tool") is preserved, its paired assistant call (role "assistant" with `toolName`) is also preserved via S40B-rev-2's partner-expansion. Assert both appear in `importancePreserved`.
  6. **Flag OFF byte-identical:** With `importanceConfig.enabled=false` (or `MEGACOMPACT_IMPORTANCE_SCORING=0`), `compactSession()` produces byte-identical output to current production — no preserved section, no scoring log, no `importancePreserved` entries. This is the no-regression gate.
  7. **Empty messages don't crash:** Messages with `text: ""` or `text: undefined` score as `AssistantMessage` (1.0x) and don't crash `score()` or `scoreEngineMessages()`. Real timestamps present.
  8. **`ratio=1.0` preserves all:** `IMPORTANCE_PRESERVE_RATIO=1.0` preserves every compactable item (no summarization — effectively a no-op compaction). `importancePreserved.length === keep.length`.
  9. **`ratio=0.0` preserves none:** `IMPORTANCE_PRESERVE_RATIO=0.0` preserves nothing (all old messages summarized — equivalent to flag OFF for the preserved section, but the structured log still fires with `preserved: 0`).

  **Test reconciliation (no escape hatches):** existing `e2e.test.ts` + `dedup-engine.test.ts` assertions that break because the summary now includes a `## Preserved context` section get UPDATED to assert the remembering behavior — they assert that preserved items appear in the output, NOT that scoring is disabled. No `enabled: false` escape hatches to make a breaking test pass. If a test breaks, the test asserts the new behavior; the behavior is not regressed to make the test pass.

---

## ACCEPTANCE CRITERIA

1. `src/importance.ts` exports `ContextItemType`, `ScoredItem`, `PreservationResult`, `DEFAULT_MULTIPLIERS`, `detectItemType()`, `ageDecay()`, `recencyBoost()`, `retentionBoost()`, `score()`, `preservationCutoff()`, `itemsToPreserve()`, `scoreEngineMessages()` — already shipped in S40A; S40B-rev-1 patches `scoreEngineMessages` to use real timestamps.
2. `src/importance.test.ts` has ≥30 unit tests covering all exports, edge cases, and determinism — already shipped in S40A; S40B-rev-7 adds integration scenarios.
3. `src/config.ts` exports `IMPORTANCE_SCORING` (default `true` — ON by default), `IMPORTANCE_PRESERVE_RATIO` (default `0.2`), `IMPORTANCE_DECAY_RATE`, `IMPORTANCE_MAX_DECAY`, `IMPORTANCE_RECENCY_THRESHOLD_MS`, `IMPORTANCE_MULTIPLIERS`, `IMPORTANCE_UNCALIBRATED` — all env-overridable, all carrying an `uncalibrated` marker until calibrated.
4. **Real timestamps used in production:** `EngineMessage.timestamp?` exists, `toEngineMessages` populates it from `AgentMessage.timestamp`, `scoreEngineMessages` reads `m.timestamp`. The position-based formula is a synthetic-test-input fallback only — never hit in production. Verified by a unit test that asserts the fallback activates when `m.timestamp` is undefined, and an integration test that asserts real timestamps flow through `toEngineMessages` into `scoreEngineMessages`.
5. **Every constant configurable + calibrated-or-uncalibrated-labeled:** every constant in `src/config.ts` is env-overridable; `IMPORTANCE_UNCALIBRATED` is true until `scripts/calibrate-importance.mjs` writes `~/.pi/mega-compact/calibration.json`; the scoring log includes `uncalibrated: true` + `note: "run scripts/calibrate-importance.mjs"` until calibrated.
6. **Error-logging contract enforced:** every scoring run logs `importance_scoring` with `{totalScored, preserved, preserveRatio, topScore, threshold, uncalibrated, note?}` — all fields from REAL scoring results. `score()` throws log `importance_scoring_failed` with the real error + stack, then propagate. No silent no-ops.
7. **Flag-ON is the default:** `IMPORTANCE_SCORING = true` unless `MEGACOMPACT_IMPORTANCE_SCORING=0`. The memory system remembers by default.
8. `compactSession()` with `IMPORTANCE_SCORING=true` preserves decision/error messages verbatim and includes them as a `## Preserved context` section in the output.
9. `compactSession()` with `IMPORTANCE_SCORING=false` produces byte-identical output to current production (verified by existing test suite + the flag-off regression test).
10. **Existing tests updated to assert remembering (not patched to disable):** `e2e.test.ts` + `dedup-engine.test.ts` assertions broken by the new `## Preserved context` section assert that preserved items appear in the output. No `enabled: false` escape hatches.
11. Anchor-floor guard (`src/boundary.ts:computeDropRange()`) is never bypassed — verified by existing boundary tests + new tests.
12. Tool pairs are never split — verified by the S40B-rev-2 partner-expansion logic + new integration test (scenario 5).
13. `userFlagged` is an honest optional on `EngineMessage` — not hardcoded `false`. The adapter does not populate it; `score()` treats `undefined` as `false` (retentionBoost 1.0). Documented.
14. All 372+ existing tests pass (no regression).
15. `npm run lint` passes with no new warnings.
16. `python3 scripts/regression_check.py --all` passes.

---

## ROLLBACK

1. **Feature flag:** Set `IMPORTANCE_SCORING=false` (or `MEGACOMPACT_IMPORTANCE_SCORING=0` in env). All new code paths are gated — zero runtime impact. The flag is now default-ON, so rollback is "set env to 0", not "set flag to false in code."
2. **Code rollback:** `git revert <commit>` removes `src/importance.ts`, `src/importance.test.ts`, `scripts/calibrate-importance.mjs`, and the engine/config/types/adapt changes. Clean revert with no schema or data migration needed.
3. **No data migration:** importance scoring is runtime-only. No SQLite schema changes, no stored state (except the optional `calibration.json` which is safe to delete). Revert is purely a code change.
4. **No downstream dependency:** nothing in the extension entry (`extensions/mega-compact.ts`) or dashboard depends on importance scoring. `driveNativeCompaction` already wraps `compactSession` in try/catch; a reverted scoring path degrades cleanly to summarization-only.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Timestamp approximation (position-based age) is inaccurate for real sessions | — | — | **RESOLVED 2026-07-25:** real per-message timestamps threaded via `EngineMessage.timestamp` + the `toEngineMessages` adapter (S40B-rev-1); the position-based formula is a synthetic-test-input fallback only, never hit in production where every real message carries a real timestamp. |
| High `preserveRatio` defeats compaction entirely | Low | Medium | Clamp ratio to [0, 0.5] in config validation; log warning if > 0.3. Scenario 8 (ratio=1.0) documents the all-preserve edge case. |
| Pattern-based `detectItemType` misclassifies messages | Medium | Low | Prioritized rule ordering; fallback to role-based type; unit tests cover edge cases. |
| Preserved messages exceed token budget | Low | Medium | After importance preservation, compute preserved tokens and fall back to summarization if preserved tokens > 50% of the compaction budget. |
| Feature-flag-off regression from code reorganization | Low | High | Existing 372 tests are the regression gate; new flag-OFF test (scenario 6) explicitly verifies byte-identical output. Flag is now default-ON; the OFF path is the regression baseline. |
| `score()` called with undefined/null content | Medium | Medium | All content paths use `content ?? ""` — tested with empty/undefined inputs. Scenario 7 (empty messages don't crash). |
| `score()` throws mid-compaction | Low | Medium | No silent failures: `importance_scoring_failed` logged with real error + stack; error re-thrown; `driveNativeCompaction` continues with summarization-only (S40B-rev-6 contract). |
| `userFlagged` field exists but no real signal populates it | High (by design) | Low | Honest optional: adapter does NOT populate it; `score()` treats `undefined` as `false` (retentionBoost 1.0). When a real signal lands (pi command, `@remember` mention), the adapter is the wiring point. Not a mock — a real unused-until-wired field. |
| Constants are uncalibrated (Rust-reference defaults) | High (initially) | Low | Every constant carries `uncalibrated: true` + `note` in the scoring log until `scripts/calibrate-importance.mjs` writes `calibration.json`. Defaults are sourced from the Rust reference, not locally measured; local calibration is the documented next step. |
