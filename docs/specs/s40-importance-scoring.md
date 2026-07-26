# S40 — Importance Scoring for Compaction

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 8 (SQLite store), Sprint 10 (L0 dedup), S24 (unified pressure), `src/engine.ts` compactSession pipeline
**Priority:** P1
**Status:** Draft → implement-ready
**Target version:** v0.8.0

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): importance scoring must NEVER cause the anchor-floor guard in `src/boundary.ts:computeDropRange()` to be bypassed. The most recent N user messages are always preserved, regardless of their importance score. Importance scoring augments, never replaces, the boundary guard.
- **PREVENT-PI-002** (tool pairs): importance scoring must NEVER split an `assistant(toolCall)` from its following `tool` result. When an important tool-execution message is marked for preservation, its paired assistant call is preserved with it.
- **PREVENT-PI-003** (no system role): scored items are injected via the existing `before_agent_start` systemPrompt prepend path — never as a `role:"system"` message.
- **Feature flag default OFF** (`IMPORTANCE_SCORING` = `false`): zero behavior change unless explicitly enabled. All new code paths are gated behind `if (config.IMPORTANCE_SCORING)`.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's `compactSession()` in `src/engine.ts` (line ~110–185) treats all messages equally:

1. **All old messages are summarized identically** — a decision message ("we decided to use JWT auth") and a filler message ("ok, sounds good") receive the same compaction treatment. The extractive summarizer (`src/extractive.ts:extractiveSummarize()`) does extract key decisions, but the decision text is folded into the summary and the original message is dropped. There is no mechanism to preserve important messages verbatim outside the anchor window.

2. **No importance-aware selection** — `src/supersede.ts:findSuperseded()` handles file-read supersession (Layer 1), but nothing scores non-file messages by importance. `src/compact.ts:isChatty()` detects filler but only for collapse decisions, not for preservation.

3. **No age-weighted importance** — a 3-hour-old decision is treated the same as a 5-minute-old one. The Rust reference (`router/src/context/importance.rs`) implements 5%/hour age decay (capped at 70%), recency boost (1.2x for items <5min old), and retention boost (3x for user-flagged items). None of this exists in the TypeScript codebase.

4. **Aggressive summarization of recent low-importance messages** — when `preserveRecent` is set to e.g. 20, ALL of those 20 messages are kept verbatim, even if some are trivial "ok" responses. Under high pressure, those slots are wasted.

**Root cause:** the compaction pipeline was built as a single-pass summarize-and-drop with no scoring dimension. Importance is a new axis orthogonal to the existing supersede/collapse/cluster pipeline.

---

## SCOPE

**IN SCOPE (new files):**
- `src/importance.ts` — importance scoring engine (types, score function, type detection, preservation logic)
- `src/importance.test.ts` — unit tests for all scoring components

**IN SCOPE (modified files):**
- `src/engine.ts` — integrate importance scoring into `compactSession()` pipeline between SUPERSEDE and COLLAPSE
- `src/config.ts` — add `IMPORTANCE_SCORING` flag, multipliers, decay config
- `src/types.ts` — add `ScoredMessage` type if needed (or define locally in `importance.ts`)

**OUT OF SCOPE:**
- Changes to `src/boundary.ts` — the anchor-floor and tool-pair guards are untouched
- Changes to `src/vectorStore.ts` — scoring happens before persistence
- Dashboard visualization of importance scores (future sprint)
- Learning/reinforcement of multipliers from user feedback
- Per-session adaptive multipliers

---

## EXECUTION

### Sprint S40A: Core Scoring Engine (`src/importance.ts`)

**Goal:** Build a standalone, deterministic, pi-agnostic importance scoring module with no side effects.

**Acceptance:** `src/importance.test.ts` passes all unit tests; module exports match the API below; zero external dependencies (imports only from `src/types.ts`).

**Tasks:**

- [ ] **S40A-1: Define types and enums** (`src/importance.ts`)
  Create the `ContextItemType` enum with 8 variants:
  ```ts
  export enum ContextItemType {
    UserMessage = "user_message",
    AssistantMessage = "assistant_message",
    SystemMessage = "system_message",
    CodeBlock = "code_block",
    Error = "error",
    Decision = "decision",
    FileModification = "file_modification",
    ToolExecution = "tool_execution",
  }
  ```
  Create the `ScoredItem` interface:
  ```ts
  export interface ScoredItem {
    id: string;            // message index or checkpoint ID
    type: ContextItemType;
    content: string;
    role: string;          // raw role from EngineMessage
    timestamp: number;     // epoch ms
    rawMultiplier: number; // type-based, before decay/boost
    ageDecay: number;      // 0–0.7
    recencyBoost: number;  // 1.0 or 1.2
    retentionBoost: number; // 1.0 or 3.0
    finalScore: number;    // composite
  }
  ```
  Create the `PreservationResult` interface:
  ```ts
  export interface PreservationResult {
    preservedIds: Set<string>;
    threshold: number;     // score cutoff used
    totalScored: number;
    totalPreserved: number;
  }
  ```

- [ ] **S40A-2: Implement type multipliers** (`src/importance.ts`)
  Default multipliers (ported from `router/src/context/importance.rs`):
  ```ts
  export const DEFAULT_MULTIPLIERS: Record<ContextItemType, number> = {
    [ContextItemType.UserMessage]: 1.5,
    [ContextItemType.AssistantMessage]: 1.0,
    [ContextItemType.SystemMessage]: 0.5,
    [ContextItemType.CodeBlock]: 1.2,
    [ContextItemType.Error]: 2.0,
    [ContextItemType.Decision]: 2.5,
    [ContextItemType.FileModification]: 1.8,
    [ContextItemType.ToolExecution]: 1.3,
  };
  ```
  Make multipliers overridable via a `Partial<Record<ContextItemType, number>>` parameter.

- [ ] **S40A-3: Implement age decay** (`src/importance.ts`)
  ```ts
  export function ageDecay(
    itemAgeMs: number,
    decayRatePerHour: number = 0.05,
    maxDecay: number = 0.7,
  ): number
  ```
  Formula: `min(maxDecay, (ageMs / 3_600_000) * decayRatePerHour)`.
  Returns the fraction to SUBTRACT from score (0 = fresh, 0.7 = very old).
  At 14 hours: `14 * 0.05 = 0.70` (capped). At 1 hour: `0.05`. At 0: `0`.

- [ ] **S40A-4: Implement recency and retention boosts** (`src/importance.ts`)
  ```ts
  export function recencyBoost(ageMs: number, thresholdMs: number = 300_000): number
  ```
  Returns `1.2` if `ageMs < thresholdMs` (5 minutes), else `1.0`.

  ```ts
  export function retentionBoost(userFlagged: boolean): number
  ```
  Returns `3.0` if flagged, else `1.0`. User-flagged items are detected by `detect_item_type` returning `Decision` or `Error`, or by an explicit flag in the message metadata.

- [ ] **S40A-5: Implement `detect_item_type()`** (`src/importance.ts`)
  ```ts
  export function detectItemType(content: string, role: "user" | "assistant" | "tool" | "custom"): ContextItemType
  ```
  Classification rules (ordered by priority — first match wins):
  1. `role === "tool"` → `ToolExecution`
  2. `role === "custom"` → `SystemMessage`
  3. Content matches `/error|exception|failure|crash|panic|traceback|E\d{4}/i` → `Error`
  4. Content matches `/decided|we chose|going with|switching to|using .* instead|final decision|let's go with/i` → `Decision`
  5. Content matches `/```[\s\S]{20,}`/ (triple-backtick fenced block ≥20 chars) → `CodeBlock`
  6. Content matches `/(wrote|edited|created|modified|updated|patched)\s+\S+\.\w+/i` → `FileModification`
  7. `role === "user"` → `UserMessage`
  8. `role === "assistant"` → `AssistantMessage`
  9. Fallback → `AssistantMessage`

- [ ] **S40A-6: Implement `score()` composite function** (`src/importance.ts`)
  ```ts
  export function score(
    item: { id: string; content: string; role: string; timestamp: number; userFlagged?: boolean },
    now: number,
    multipliers?: Partial<Record<ContextItemType, number>>,
    opts?: { decayRatePerHour?: number; maxDecay?: number; recencyThresholdMs?: number },
  ): ScoredItem
  ```
  Formula:
  ```
  type = detectItemType(content, role)
  rawMult = multipliers[type] ?? DEFAULT_MULTIPLIERS[type]
  decay = ageDecay(now - timestamp, opts?.decayRatePerHour, opts?.maxDecay)
  recency = recencyBoost(now - timestamp, opts?.recencyThresholdMs)
  retention = retentionBoost(userFlagged)
  finalScore = rawMult * (1 - decay) * recency * retention
  ```
  Clamps: `finalScore` minimum 0.01 (never zero).

- [ ] **S40A-7: Implement `preservation_cutoff()` and `items_to_preserve()`** (`src/importance.ts`)
  ```ts
  export function preservationCutoff(
    items: ScoredItem[],
    preserveRatio: number, // 0.0–1.0: fraction of items to preserve
  ): number
  ```
  Sort items by `finalScore` descending. Return the score at the `preserveRatio` percentile boundary (e.g., ratio=0.3 means preserve top 30%). If ratio=1.0, return 0 (preserve all). If ratio=0, return Infinity (preserve none — but callers should not pass 0).

  ```ts
  export function itemsToPreserve(
    items: ScoredItem[],
    preserveRatio: number,
  ): PreservationResult
  ```
  Calls `preservationCutoff`, returns items with `finalScore >= threshold`.

- [ ] **S40A-8: Unit tests** (`src/importance.test.ts`)
  Test matrix:
  - `detectItemType`: all 8 types, edge cases (empty string, mixed patterns)
  - `ageDecay`: fresh (0), 1hr (0.05), 14hr (0.7 cap), negative age (0)
  - `recencyBoost`: <5min (1.2), >5min (1.0), exactly 5min (1.0)
  - `retentionBoost`: flagged (3.0), unflagged (1.0)
  - `score`: full composite with known inputs → expected output
  - `preservationCutoff`: 10 items at ratio 0.3 → 3 preserved
  - `itemsToPreserve`: verify threshold, count, IDs
  - Determinism: same inputs → same output (no randomness)

---

### Sprint S40B: Integration into `compactSession()` Pipeline

**Goal:** Wire importance scoring into the compaction pipeline so high-importance old messages are preserved verbatim and low-importance recent messages are compressed.

**Acceptance:** With `IMPORTANCE_SCORING=true`, a session containing a decision message outside the anchor window preserves that message verbatim in the compacted output. With `IMPORTANCE_SCORING=false`, behavior is identical to current production.

**Tasks:**

- [ ] **S40B-1: Add configuration to `src/config.ts`**
  Add the following exports:
  ```ts
  /** Enable importance-aware compaction (S40). Default: false. */
  export const IMPORTANCE_SCORING = false;
  // Override: set MEGACOMPACT_IMPORTANCE_SCORING=1 in env

  /** Fraction of old messages to preserve verbatim based on importance (0–1). */
  export const IMPORTANCE_PRESERVE_RATIO = 0.2;

  /** Per-type multiplier overrides (empty = use defaults). */
  export const IMPORTANCE_MULTIPLIERS: Partial<Record<string, number>> = {};

  /** Age decay rate per hour (default 0.05 = 5%/hr). */
  export const IMPORTANCE_DECAY_RATE = 0.05;

  /** Max age decay cap (default 0.7 = 70%). */
  export const IMPORTANCE_MAX_DECAY = 0.7;

  /** Recency boost threshold in ms (default 5 minutes). */
  export const IMPORTANCE_RECENCY_THRESHOLD_MS = 300_000;
  ```
  Read from env: `MEGACOMPACT_IMPORTANCE_SCORING`, `MEGACOMPACT_IMPORTANCE_PRESERVE_RATIO`, `MEGACOMPACT_IMPORTANCE_DECAY_RATE`.

- [ ] **S40B-2: Modify `compactSession()` in `src/engine.ts`** (insert between LAYER 1 and LAYER 2, after line ~120)
  After supersession pruning (`keep` is computed), before collapse:
  ```ts
  // LAYER 1.5 — IMPORTANCE SCORING (S40): score and optionally preserve
  // high-importance messages outside the anchor window.
  let importancePreserved: EngineMessage[] = [];
  if (IMPORTANCE_SCORING && keep.length > 0) {
    const now = input.timestamp ?? Date.now();
    const scored = keep.map((m, i) => score({
      id: String(i),
      content: m.text ?? "",
      role: m.role,
      timestamp: now - (keep.length - i) * 60_000, // approximate age from position
      userFlagged: false,
    }, now, IMPORTANCE_MULTIPLIERS, {
      decayRatePerHour: IMPORTANCE_DECAY_RATE,
      maxDecay: IMPORTANCE_MAX_DECAY,
      recencyThresholdMs: IMPORTANCE_RECENCY_THRESHOLD_MS,
    }));
    const { preservedIds } = itemsToPreserve(scored, IMPORTANCE_PRESERVE_RATIO);
    importancePreserved = keep.filter((_, i) => preservedIds.has(String(i)));
    // Rebuild `keep` to exclude preserved items (they bypass summarization)
    // but ONLY items outside the anchor window — anchor-floor items are
    // already protected by computeDropRange() downstream.
  }
  ```
  **Critical:** importance-preserved messages are prepended to the summary output (not mixed into the summary text). They appear as a `## Preserved context` section before the compacted summary. This ensures the model sees them verbatim.

- [ ] **S40B-3: Update `CompactResult` interface** (`src/engine.ts`)
  Add optional field:
  ```ts
  /** Messages preserved verbatim due to high importance score (S40). */
  importancePreserved?: EngineMessage[];
  ```
  The extension can use this to render preserved messages in the compacted context block.

- [ ] **S40B-4: Update `formatCompactSummary()` or add new formatter** (`src/compact.ts` or `src/engine.ts`)
  When `importancePreserved.length > 0`, prepend to the summary:
  ```
  ## Preserved context (high importance)
  - [User]: "We decided to use JWT auth for the API layer"
  - [Assistant]: "Error: ENOENT — file not found at src/config.ts:42"
  
  ## Compacted summary
  <existing summary text>
  ```

- [ ] **S40B-5: Wire env-var reading** (`src/config.ts`)
  In the config module, read `process.env.MEGACOMPACT_IMPORTANCE_SCORING` and convert to boolean. Also read ratio and decay rate from env, clamping to valid ranges.

- [ ] **S40B-6: Add logging** (`src/engine.ts`)
  Log to the existing `Logger` when importance scoring runs:
  ```ts
  log("info", "importance_scoring", {
    totalScored: scored.length,
    preserved: importancePreserved.length,
    preserveRatio: IMPORTANCE_PRESERVE_RATIO,
    topScore: scored[0]?.finalScore,
    threshold: preservationThreshold,
  });
  ```

- [ ] **S40B-7: Integration tests** (`src/importance.test.ts` or `src/engine.test.ts`)
  Test scenarios:
  1. **Decision preserved:** Session of 30 messages, message #5 is a decision ("decided to use JWT"). With `IMPORTANCE_SCORING=true`, `IMPORTANCE_PRESERVE_RATIO=0.2`, the decision appears verbatim in the compacted output's "Preserved context" section.
  2. **Error preserved:** Message #10 contains an error trace. Scored as `Error` type (2.0x). Preserved when ratio allows.
  3. **Filler not preserved:** Message #3 is "ok, sounds good". Type = `AssistantMessage` (1.0x). Old age → low score. Not preserved.
  4. **Anchor floor unaffected:** With `preserveRecent=10` and importance scoring on, the last 10 messages are still verbatim (boundary guard is untouched).
  5. **Tool pair intact:** If a tool-execution message is preserved, its paired assistant call is also preserved (S40B-2 logic must handle this).
  6. **Flag OFF regression:** With `IMPORTANCE_SCORING=false`, `compactSession()` produces identical output to current production (no preserved section, no scoring log).
  7. **Empty messages:** Messages with `text: ""` or `text: undefined` score as `AssistantMessage` (1.0x) and don't crash.
  8. **High ratio:** `IMPORTANCE_PRESERVE_RATIO=1.0` preserves everything (no summarization — effectively a no-op compaction).
  9. **Low ratio:** `IMPORTANCE_PRESERVE_RATIO=0.0` preserves nothing (all old messages summarized — equivalent to flag OFF).

---

## ACCEPTANCE CRITERIA

1. `src/importance.ts` exports `ContextItemType`, `ScoredItem`, `PreservationResult`, `DEFAULT_MULTIPLIERS`, `detectItemType()`, `ageDecay()`, `recencyBoost()`, `retentionBoost()`, `score()`, `preservationCutoff()`, `itemsToPreserve()`.
2. `src/importance.test.ts` has ≥30 unit tests covering all exports, edge cases, and determinism.
3. `src/config.ts` exports `IMPORTANCE_SCORING` (default `false`), `IMPORTANCE_PRESERVE_RATIO` (default `0.2`), and related config constants, all env-overridable.
4. `compactSession()` with `IMPORTANCE_SCORING=true` preserves decision/error messages verbatim and includes them as a `## Preserved context` section in the output.
5. `compactSession()` with `IMPORTANCE_SCORING=false` produces byte-identical output to current production (verified by existing test suite).
6. Anchor-floor guard (`src/boundary.ts:computeDropRange()`) is never bypassed — verified by existing boundary tests + new tests.
7. Tool pairs are never split — verified by new integration test.
8. All 372+ existing tests pass (no regression).
9. `npm run lint` passes with no new warnings.
10. `python3 scripts/regression_check.py --all` passes.

---

## ROLLBACK

1. **Feature flag:** Set `IMPORTANCE_SCORING=false` (or remove the env var). All new code paths are gated — zero runtime impact.
2. **Code rollback:** `git revert <commit>` removes `src/importance.ts`, `src/importance.test.ts`, and the engine/config changes. Clean revert with no schema or data migration needed.
3. **No data migration:** importance scoring is runtime-only. No SQLite schema changes, no stored state. Revert is purely a code change.
4. **No downstream dependency:** nothing in the extension entry (`extensions/mega-compact.ts`) or dashboard depends on importance scoring.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Timestamp approximation (position-based age) is inaccurate for real sessions | Medium | Low | Use actual message timestamps if available from the extension adapter; fall back to position-based only when timestamps are missing |
| High `preserveRatio` defeats compaction entirely | Low | Medium | Clamp ratio to [0, 0.5] in config validation; log warning if > 0.3 |
| Pattern-based `detectItemType` misclassifies messages | Medium | Low | Prioritized rule ordering; fallback to role-based type; unit tests cover edge cases |
| Preserved messages exceed token budget | Low | Medium | After importance preservation, compute preserved tokens and fall back to summarization if preserved tokens > 50% of the compaction budget |
| Feature-flag-off regression from code reorganization | Low | High | Existing 372 tests are the regression gate; new flag-OFF test explicitly verifies byte-identical output |
| `score()` called with undefined/null content | Medium | Medium | All content paths use `content ?? ""` — tested with empty/undefined inputs |
