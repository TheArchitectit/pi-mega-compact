# S41 — Self-RAG Quality Gate (Word-Overlap Critique)

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 8 (SQLite store), Sprint 12 (vector search), `src/recall.ts` recallAndInline, `src/vectorStore.ts` search
**Priority:** P1
**Status:** Draft → implement-ready
**Target version:** v0.8.0

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): recall critique is purely additive — it decides whether to inject recalled context into the system prompt. It never touches the anchor-floor guard in `src/boundary.ts:computeDropRange()`. The anchor floor protects recent messages; critique protects against bad recall injection. These are orthogonal.
- **PREVENT-PI-003** (no system role): recalled context is injected via the `before_agent_start` hook's `systemPrompt` prepend. Critique gates this injection but does not change the injection mechanism.
- **PREVENT-PI-004** (no network): all critique functions are deterministic, in-process word-overlap calculations. Zero network calls. No LLM calls. No external API. This is a pure text-processing module.
- **Feature flag default OFF** (`RECALL_CRITIQUE_ENABLED` = `false`): zero behavior change unless explicitly enabled. When OFF, `recallAndInline()` behaves identically to current production.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Today's `recallAndInline()` in `src/recall.ts` (line ~80–160) retrieves top-K chunks from the VectorStore and injects them into the system prompt without any quality check:

1. **No relevance validation** — `recall()` in `src/engine.ts` (line ~195) does a cosine-similarity search via `VectorStore.search()`. The search returns the top-K hits by vector similarity, but vector similarity is an approximation. A chunk about "database migrations" might score 0.45 cosine similarity to a query about "auth setup" because both share technical vocabulary, but the chunk is irrelevant to the current task. This irrelevant chunk is injected verbatim.

2. **No factual accuracy check** — recalled chunks are treated as ground truth. If a checkpoint summary contains stale information (e.g., "using bcrypt for passwords" when the session later switched to argon2), the stale chunk is injected without verification.

3. **No completeness assessment** — there is no check whether the recalled chunks address the current query at all. If the query is about "setting up CI/CD" but only chunks about "database schema" were recalled (because the vector index has nothing about CI/CD), the injection proceeds anyway.

4. **Token waste** — each injected chunk consumes system-prompt tokens. Irrelevant chunks waste tokens that could be used for actual conversation, potentially pushing the session toward the compaction threshold faster.

5. **No monitoring** — there is no logging of recall quality. The `canary.ts` system tracks compaction performance but has no visibility into whether recall injections are helpful or harmful.

**Root cause:** the recall path does search → format → inject with no quality gate between search and inject. The Rust reference (`agents/src/tools/retrieval/critique.rs`) implements a deterministic word-overlap critique that checks factual accuracy, completeness, relevance, and clarity without needing an LLM call. This should be ported.

---

## SCOPE

**IN SCOPE (new files):**
- `src/recallCritique.ts` — recall quality critique engine (word-overlap metrics, composite scoring, pass/fail gate)
- `src/recallCritique.test.ts` — unit tests for all critique functions

**IN SCOPE (modified files):**
- `src/recall.ts` — integrate critique into `recallAndInline()` between search and inject
- `src/config.ts` — add `RECALL_CRITIQUE_ENABLED` flag and `RECALL_CRITIQUE_THRESHOLD`
- `src/log.ts` — (no changes needed, existing Logger API is sufficient)

**OUT OF SCOPE:**
- Changes to `src/vectorStore.ts` — critique operates on search results, not the search itself
- Changes to `src/engine.ts` — recall is called via `recallAndInline()`, not directly
- Changes to `src/boundary.ts` — critique does not affect message dropping
- LLM-based critique (self-RAG with a language model) — future enhancement
- Adaptive threshold learning from feedback
- Dashboard visualization of critique scores (future sprint)

---

## EXECUTION

### Sprint S41A: Core Critique Engine (`src/recallCritique.ts`)

**Goal:** Build a standalone, deterministic, zero-dependency recall quality critique module with four word-overlap metrics and a composite scoring function.

**Acceptance:** `src/recallCritique.test.ts` passes all unit tests; module imports only from `src/config.js` (for thresholds) and `node:` builtins; zero external dependencies.

**Tasks:**

- [ ] **S41A-1: Define types and interfaces** (`src/recallCritique.ts`)
  Create the core types:
  ```ts
  /** Breakdown of individual critique dimensions. */
  export interface CritiqueBreakdown {
    factualAccuracy: number;   // 0–1: fraction of answer terms in context
    completeness: number;      // 0–1: fraction of query terms in answer
    relevance: number;         // 0–1: Jaccard similarity(query, context)
    clarity: number;           // 0–1: sentence structure heuristic
  }

  /** Result of a recall critique evaluation. */
  export interface CritiqueResult {
    pass: boolean;             // score >= threshold
    score: number;             // 0–1 composite
    breakdown: CritiqueBreakdown;
    reason: string;            // human-readable: "High relevance (0.82)" or "Low factual accuracy (0.15)"
  }
  ```

- [ ] **S41A-2: Implement text normalization and tokenization** (`src/recallCritique.ts`)
  ```ts
  /** Normalize text for comparison: lowercase, strip punctuation, split on whitespace. */
  export function tokenize(text: string): string[]

  /** Extract significant tokens: filter out stopwords (< 3 chars, common English). */
  export function significantTokens(tokens: string[]): string[]
  ```
  Stopword set (minimal, hardcoded — no npm dependency):
  ```ts
  const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "it", "its",
    "this", "that", "these", "those", "and", "or", "but", "not", "no",
    "so", "if", "then", "than", "too", "very", "just", "also", "more",
    "some", "any", "all", "each", "every", "both", "few", "most", "other",
    "what", "which", "who", "whom", "how", "when", "where", "why",
    "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
    "she", "her", "they", "them", "their",
  ]);
  ```
  Tokens ≤ 2 characters are also filtered (too short to be meaningful overlap signals).

- [ ] **S41A-3: Implement `factualAccuracy()`** (`src/recallCritique.ts`)
  ```ts
  /**
   * What fraction of significant terms in `answer` also appear in `context`?
   * High score = answer is grounded in context (factual accuracy proxy).
   * Returns 0–1. Empty answer → 1.0 (nothing to contradict). Empty context → 0.
   */
  export function factualAccuracy(answer: string, context: string): number
  ```
  Implementation:
  ```
  answerTokens = significantTokens(tokenize(answer))
  contextTokens = set(significantTokens(tokenize(context)))
  if answerTokens.length === 0: return 1.0
  matches = answerTokens.filter(t => contextTokens.has(t))
  return matches.length / answerTokens.length
  ```
  Example: answer = "JWT auth uses tokens", context = "We set up JWT authentication with bearer tokens" → tokens: `{jwt, auth, uses, tokens}` ∩ `{jwt, authentication, bearer, tokens}` = {jwt, tokens} → 2/4 = 0.5

- [ ] **S41A-4: Implement `completeness()`** (`src/recallCritique.ts`)
  ```ts
  /**
   * What fraction of significant terms in `query` are addressed in `answer`?
   * High score = answer covers what the query asks about.
   * Returns 0–1. Empty query → 1.0. Empty answer → 0.
   */
  export function completeness(query: string, answer: string): number
  ```
  Same word-overlap logic as `factualAccuracy` but with (query, answer) as (source, target).

- [ ] **S41A-5: Implement `relevance()`** (`src/recallCritique.ts`)
  ```ts
  /**
   * Jaccard similarity between significant query tokens and significant context tokens.
   * Measures topical overlap between the query and the recalled context.
   * Returns 0–1. Both empty → 1.0. One empty → 0.
   */
  export function relevance(query: string, context: string): number
  ```
  Implementation:
  ```
  qTokens = set(significantTokens(tokenize(query)))
  cTokens = set(significantTokens(tokenize(context)))
  if qTokens.size === 0 && cTokens.size === 0: return 1.0
  intersection = qTokens ∩ cTokens
  union = qTokens ∪ cTokens
  return intersection.size / union.size
  ```

- [ ] **S41A-6: Implement `clarity()`** (`src/recallCritique.ts`)
  ```ts
  /**
   * Sentence structure heuristic: penalizes overly long or fragmented text.
   * Measures avg sentence length — optimal is 10–30 words per sentence.
   * Returns 0–1.
   */
  export function clarity(answer: string): number
  ```
  Implementation:
  ```
  sentences = answer.split(/[.!?]+/).filter(s => s.trim().length > 0)
  if sentences.length === 0: return 1.0
  avgLen = mean(sentences.map(s => s.trim().split(/\s+/).length))
  if avgLen >= 10 && avgLen <= 30: return 1.0
  if avgLen < 10: return avgLen / 10   // too fragmented
  if avgLen > 30: return 30 / avgLen    // too dense
  ```
  Note: clarity is a secondary signal. A recall chunk that is a code block will have low clarity (long unbroken text) but may be highly relevant. The composite scoring weights clarity at only 10% (see S41A-7).

- [ ] **S41A-7: Implement `critiqueRecall()` composite function** (`src/recallCritique.ts`)
  ```ts
  /**
   * Run all four critique dimensions on a query + recalled chunks.
   * Chunks are concatenated into a single context string for scoring.
   * Returns a CritiqueResult with pass/fail, composite score, and breakdown.
   */
  export function critiqueRecall(
    query: string,
    recalledChunks: string[],
    opts?: {
      threshold?: number;     // default 0.3
      weights?: {             // default: factual 0.35, completeness 0.30, relevance 0.25, clarity 0.10
        factualAccuracy?: number;
        completeness?: number;
        relevance?: number;
        clarity?: number;
      };
    },
  ): CritiqueResult
  ```
  Composite score formula:
  ```
  context = recalledChunks.join("\n\n")
  factual = factualAccuracy(context, query)  // fraction of context terms in query (grounding)
  comp = completeness(query, context)        // fraction of query terms in context
  rel = relevance(query, context)            // Jaccard overlap
  clr = clarity(context)                     // sentence structure
  score = 0.35 * factual + 0.30 * comp + 0.25 * rel + 0.10 * clr
  pass = score >= threshold
  ```
  Default weights: factual accuracy 35%, completeness 30%, relevance 25%, clarity 10%.
  Reason string: highest-scoring dimension → "High relevance (0.82)" or lowest → "Low factual accuracy (0.15)".

- [ ] **S41A-8: Unit tests** (`src/recallCritique.test.ts`)
  Test matrix (≥35 tests):
  - `tokenize`: normal text, empty string, punctuation-only, unicode, code blocks
  - `significantTokens`: filters stopwords, filters short tokens, passes through technical terms
  - `factualAccuracy`: full overlap (1.0), partial overlap, no overlap (0), empty answer (1.0), empty context (0)
  - `completeness`: full coverage (1.0), partial, no coverage (0), empty query (1.0), empty answer (0)
  - `relevance`: identical texts (1.0), no overlap (0), partial, both empty (1.0), one empty (0)
  - `clarity`: optimal sentences (10–30 words → 1.0), very short (<10 → <1.0), very long (>30 → <1.0), empty (1.0), code block (low clarity but acceptable)
  - `critiqueRecall`: high-quality recall passes (≥0.3), irrelevant recall fails (<0.3), borderline at exactly 0.3, empty chunks, single chunk
  - `critiqueRecall` with custom weights: verify weights change the composite score
  - `critiqueRecall` with custom threshold: verify pass/fail boundary
  - Determinism: same inputs → same output every time

---

### Sprint S41B: Integration into `recallAndInline()` Pipeline

**Goal:** Wire the critique gate into the recall path so irrelevant recalled chunks are rejected before injection.

**Acceptance:** With `RECALL_CRITIQUE_ENABLED=true`, recall of irrelevant chunks is blocked (empty block returned). With `RECALL_CRITIQUE_ENABLED=false`, behavior is identical to current production. Critique scores are logged to events.log.

**Tasks:**

- [ ] **S41B-1: Add configuration to `src/config.ts`**
  Add the following exports:
  ```ts
  /** Enable recall quality critique gate (S41). Default: false. */
  export const RECALL_CRITIQUE_ENABLED = false;
  // Override: set MEGACOMPACT_RECALL_CRITIQUE=1 in env

  /** Minimum composite score for recall injection (0–1). Below this, recall is skipped. */
  export const RECALL_CRITIQUE_THRESHOLD = 0.3;
  // Override: MEGACOMPACT_RECALL_CRITIQUE_THRESHOLD

  /** Score below this triggers a warning log but still allows injection. */
  export const RECALL_CRITIQUE_WARN_THRESHOLD = 0.5;
  ```
  Read from env: `MEGACOMPACT_RECALL_CRITIQUE`, `MEGACOMPACT_RECALL_CRITIQUE_THRESHOLD`.

- [ ] **S41B-2: Modify `recallAndInline()` in `src/recall.ts`** (insert after search + dedupe, before block assembly, around line ~130)
  After the search results are retrieved and window-deduped, but before building the injection block:
  ```ts
  // ── S41 Recall Critique Gate ────────────────────────────────────────
  if (RECALL_CRITIQUE_ENABLED && hits.length > 0) {
    const chunkTexts = hits.map(h => h.checkpoint.summary);
    const critiqueResult = critiqueRecall(opts.query, chunkTexts, {
      threshold: RECALL_CRITIQUE_THRESHOLD,
    });

    // Log critique result for monitoring / canary tracking
    log("info", "recall_critique", {
      query: opts.query.slice(0, 100),
      score: critiqueResult.score,
      pass: critiqueResult.pass,
      breakdown: critiqueResult.breakdown,
      reason: critiqueResult.reason,
      chunkCount: hits.length,
      sessionId: opts.sessionId,
    });

    if (!critiqueResult.pass) {
      // Recall failed quality gate — skip injection entirely.
      // Better to have no recall than bad recall polluting the context.
      log("warn", "recall_critique_rejected", {
        score: critiqueResult.score,
        threshold: RECALL_CRITIQUE_THRESHOLD,
        reason: critiqueResult.reason,
        sessionId: opts.sessionId,
      });
      return {
        toInject: [],
        report: [`  ⚠ Recall critique failed (${critiqueResult.reason}). Skipping injection.`],
        block: "",
        empty: true,
      };
    }

    if (critiqueResult.score < RECALL_CRITIQUE_WARN_THRESHOLD) {
      // Low quality but above threshold — inject with warning
      log("warn", "recall_critique_low", {
        score: critiqueResult.score,
        reason: critiqueResult.reason,
        sessionId: opts.sessionId,
      });
    }
  }
  // ── End S41 ─────────────────────────────────────────────────────────
  ```
  **Placement:** This block must be inserted AFTER the `hits` array is populated (line ~130) but BEFORE the `for (const h of hits)` loop that builds `toInject` and `parts` (line ~135). The critique operates on the full hit set, not per-hit.

- [ ] **S41B-3: Add import in `src/recall.ts`**
  At the top of `src/recall.ts`, add:
  ```ts
  import { critiqueRecall } from "./recallCritique.js";
  import { RECALL_CRITIQUE_ENABLED, RECALL_CRITIQUE_THRESHOLD, RECALL_CRITIQUE_WARN_THRESHOLD } from "./config.js";
  import { Logger } from "./log.js";
  ```
  Note: `recall.ts` currently does not import from `log.ts`. A module-level logger instance should be created or the existing logging mechanism used. If `recallAndInline` is a pure function (no side effects), logging should be done via a callback parameter rather than a module-level logger, to preserve testability. Add an optional `onCritique?: (result: CritiqueResult) => void` parameter to `RecallInjectOptions`.

- [ ] **S41B-4: Update `RecallInjectOptions` interface** (`src/recall.ts`)
  Add optional field:
  ```ts
  /** Callback fired when critique evaluates recall quality (S41). */
  onCritique?: (result: CritiqueResult) => void;
  ```
  This allows the extension to observe critique results for dashboard/monitoring without coupling `recall.ts` to the logger.

- [ ] **S41B-5: Wire env-var reading** (`src/config.ts`)
  In the config module, read `process.env.MEGACOMPACT_RECALL_CRITIQUE` and convert to boolean (`"1"` or `"true"` → `true`). Read `MEGACOMPACT_RECALL_CRITIQUE_THRESHOLD` as float, clamp to [0, 1].

- [ ] **S41B-6: Integration tests** (`src/recallCritique.test.ts`)
  Test scenarios (building on unit tests from S41A-8):
  1. **Relevant recall passes:** Query = "How do I set up JWT auth?", chunks = ["Set up JWT authentication by configuring the token secret and middleware..."]. Critique score ≥ 0.3. Injection proceeds.
  2. **Irrelevant recall rejected:** Query = "How do I set up CI/CD?", chunks = ["Database migrations use Knex.js with PostgreSQL..."]. Critique score < 0.3. Injection blocked (empty block, empty toInject).
  3. **Mixed relevance:** 2 relevant chunks + 1 irrelevant. Composite score is average — may pass or fail depending on the mix.
  4. **Empty query:** `critiqueRecall("", chunks)` → completeness = 1.0 (vacuously), relevance = 0 → composite depends on other dimensions.
  5. **Empty chunks:** `critiqueRecall(query, [])` → factual = 0, completeness = 0, relevance = 0, clarity = 1.0 → composite = 0.1 → fails.
  6. **Single short chunk:** `critiqueRecall("auth setup", ["JWT"])` → partial overlap → test the boundary.
  7. **Flag OFF regression:** With `RECALL_CRITIQUE_ENABLED=false`, `recallAndInline()` produces identical output to current production. No critique log entries.
  8. **Flag ON, critique passes, callback fires:** Verify `onCritique` is called with the correct `CritiqueResult` when critique runs.
  9. **Flag ON, critique fails, returns early:** Verify `toInject` is empty, `block` is empty, `empty` is true, report contains warning.
  10. **Low score warning:** Score between threshold (0.3) and warn threshold (0.5) → injection proceeds but warning is logged.
  11. **Custom threshold:** Pass threshold=0.1 → almost everything passes. Pass threshold=0.9 → almost everything fails.
  12. **Code-heavy chunks:** Chunks that are mostly code (low clarity) but contain relevant terms → critique should still pass due to low clarity weight (10%).

---

## ACCEPTANCE CRITERIA

1. `src/recallCritique.ts` exports `CritiqueBreakdown`, `CritiqueResult`, `tokenize()`, `significantTokens()`, `factualAccuracy()`, `completeness()`, `relevance()`, `clarity()`, `critiqueRecall()`.
2. `src/recallCritique.test.ts` has ≥35 unit tests covering all exports, edge cases, boundary conditions, and determinism.
3. `src/config.ts` exports `RECALL_CRITIQUE_ENABLED` (default `false`), `RECALL_CRITIQUE_THRESHOLD` (default `0.3`), `RECALL_CRITIQUE_WARN_THRESHOLD` (default `0.5`), all env-overridable.
4. `recallAndInline()` with `RECALL_CRITIQUE_ENABLED=true` rejects recall injections when composite score < threshold, returning `{ toInject: [], block: "", empty: true }`.
5. `recallAndInline()` with `RECALL_CRITIQUE_ENABLED=true` logs critique scores via the `onCritique` callback.
6. `recallAndInline()` with `RECALL_CRITIQUE_ENABLED=false` produces byte-identical output to current production (verified by existing test suite).
7. All critique functions are deterministic (same inputs → same outputs, no randomness, no network calls).
8. Zero external npm dependencies in `src/recallCritique.ts`.
9. All 372+ existing tests pass (no regression).
10. `npm run lint` passes with no new warnings.
11. `python3 scripts/regression_check.py --all` passes.

---

## ROLLBACK

1. **Feature flag:** Set `RECALL_CRITIQUE_ENABLED=false` (or remove the env var). All new code paths are gated — zero runtime impact.
2. **Code rollback:** `git revert <commit>` removes `src/recallCritique.ts`, `src/recallCritique.test.ts`, and the recall/config changes. Clean revert with no schema or data migration needed.
3. **No data migration:** recall critique is runtime-only. No SQLite schema changes, no stored state. Revert is purely a code change.
4. **No downstream dependency:** nothing in the extension entry (`extensions/mega-compact.ts`) or dashboard depends on recall critique. The `onCritique` callback is optional and callers can omit it.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Word-overlap metrics are too crude for technical queries (e.g., "auth" vs "authentication" not matching) | Medium | Medium | Use stemming-lite: strip common suffixes (-tion, -ing, -ed, -ment, -ness) before comparison. Or accept partial matches — the composite score is designed to tolerate some mismatch. |
| Threshold too aggressive: good recall rejected | Medium | High | Default threshold is conservative (0.3). Test with real session data before tightening. Log all rejections with reason for tuning. |
| Threshold too lenient: bad recall passes | Medium | Medium | The warn threshold (0.5) flags marginal cases for monitoring. Canary can tighten over time. |
| Code-heavy chunks have low clarity | High | Low | Clarity weight is only 10%. Code-heavy chunks that contain relevant terms will still pass. |
| Empty query edge case (e.g., auto-recall on resume with no query) | Low | Medium | Empty query → completeness = 1.0, relevance = 0 → score depends on other dimensions. The `recallAndInline` caller should provide a meaningful query (the last user message). |
| Critique adds latency to recall path | Low | Low | All functions are string operations (split, set intersection). O(n) in token count. For typical chunks (100–500 words), this is <1ms. No network, no I/O. |
| Stopword list misses domain-specific stopwords | Low | Low | The list is conservative (English function words). Domain terms like "function", "class", "import" are NOT filtered — they are significant in technical contexts. |
