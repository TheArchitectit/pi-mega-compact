# S41 — Self-RAG Quality Gate (Word-Overlap Critique)

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** Sprint 8 (SQLite store), Sprint 12 (vector search), `src/recall.ts` recallAndInline, `src/vectorStore.ts` search, `src/embedder.ts` (TrigramEmbedder — the source of the stopword derivation)
**Priority:** P1
**Status:** Draft → implement-ready (re-planned)
**Target version:** v0.8.0

---

## RE-PLAN 2026-07-25

**What this re-plan fixes.** The original S41 spec was already mock-free at the function level: every critique dimension (`factualAccuracy`, `completeness`, `relevance`, `clarity`) is pure, deterministic, in-process text processing — no LLM, no network, no fabricated runtime data. The defect was not mocks; it was **invented constants with no empirical grounding**. Specifically:

- The composite weights `0.35 * factual + 0.30 * comp + 0.25 * rel + 0.10 * clarity` were an arbitrary 35/30/25/10 split with no derivation.
- The gate threshold `0.3` and warn threshold `0.5` were presented as "conservative" defaults, but "conservative" implies they were chosen with measurement — they were not. They were invented numbers.
- The clarity "optimal" range of 10–30 words per sentence was invented.
- The ~80-word English stopword list was hand-picked and never validated against the codebase's own trigram tokenizer vocabulary.

**The fix (applied in this rewrite).**

1. Every constant becomes **configurable** (env-overridable) AND **carries a calibration procedure**. Until the calibration procedure is run, the constant is labeled `uncalibrated:true` in every log line and in `~/.pi/mega-compact/calibration.json`.
2. The **Ollama/LLM path is removed** entirely. S41 was already fully local; this rewrite makes that explicit and removes any speculative language-model hooks.
3. The stopword list moves to `src/config/stopwords.ts` and is **DERIVED from the codebase's own `TrigramEmbedder` vocabulary** (real, sourced, versioned) — not a hand-picked set.
4. A **calibration script** (`scripts/calibrate-critique.mjs`) harvests real `(query, retrieved-context)` pairs from `events.log`, runs the critique against them, and suggests a threshold that rejects the bottom quartile. Output is written to `~/.pi/mega-compact/calibration.json`.
5. The **gate is default ON** (`CRITIQUE_ENABLED` default `true`); env `MEGACOMPACT_CRITIQUE=0` disables it. When disabled, the critique gate is skipped and `recallAndInline()` proceeds as today. (Original spec had it default OFF — that was wrong; the whole point of S41 is to gate bad recall, and a gate that ships disabled never runs in practice.)
6. **Error-logging contract enforced** (see S41B-3): every `recall_critique` event logs real fields including `uncalibrated`, `weights`, and a `note` pointing to the calibration script when uncalibrated. No silent rejection — rejected injections surface an explicit report string. Critique throws → original recall proceeds AND a `recall_critique_failed` event logs the real error.

The **valid parts of the original spec are preserved unchanged**: the pure critique math, the word-overlap formulas (`factualAccuracy`, `completeness`, `relevance`, `clarity`) are real algorithms, not mocks. Only the constants around them and the gating/logging contract change.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): recall critique is purely additive — it decides whether to inject recalled context into the system prompt. It never touches the anchor-floor guard in `src/boundary.ts:computeDropRange()`. The anchor floor protects recent messages; critique protects against bad recall injection. These are orthogonal.
- **PREVENT-PI-003** (no system role): recalled context is injected via the `before_agent_start` hook's `systemPrompt` prepend. Critique gates this injection but does not change the injection mechanism.
- **PREVENT-PI-004** (no network): all critique functions are deterministic, in-process word-overlap calculations. Zero network calls. **No LLM calls. No Ollama. No external API.** This is a pure text-processing module. (The original spec's speculative "LLM-based critique — future enhancement" line is removed from OUT OF SCOPE; S41 is and remains fully local.)
- **Feature flag default ON** (`CRITIQUE_ENABLED` = `true`): the critique gate is active in production by default. Set `MEGACOMPACT_CRITIQUE=0` to disable. When disabled, `recallAndInline()` behaves identically to current production (gate skipped, no critique events logged).
- **Guardrails gate:** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`.

---

## PROBLEM

Today's `recallAndInline()` in `src/recall.ts` (line ~80–160) retrieves top-K chunks from the VectorStore and injects them into the system prompt without any quality check:

1. **No relevance validation** — `recall()` in `src/engine.ts` (line ~195) does a cosine-similarity search via `VectorStore.search()`. The search returns the top-K hits by vector similarity, but vector similarity is an approximation. A chunk about "database migrations" might score 0.45 cosine similarity to a query about "auth setup" because both share technical vocabulary, but the chunk is irrelevant to the current task. This irrelevant chunk is injected verbatim.

2. **No factual accuracy check** — recalled chunks are treated as ground truth. If a checkpoint summary contains stale information (e.g., "using bcrypt for passwords" when the session later switched to argon2), the stale chunk is injected without verification.

3. **No completeness assessment** — there is no check whether the recalled chunks address the current query at all. If the query is about "setting up CI/CD" but only chunks about "database schema" were recalled (because the vector index has nothing about CI/CD), the injection proceeds anyway.

4. **Token waste** — each injected chunk consumes system-prompt tokens. Irrelevant chunks waste tokens that could be used for actual conversation, potentially pushing the session toward the compaction threshold faster.

5. **No monitoring** — there is no logging of recall quality. The `canary.ts` system tracks compaction performance but has no visibility into whether recall injections are helpful or harmful.

**Root cause:** the recall path does search → format → inject with no quality gate between search and inject. The Rust reference (`agents/src/tools/retrieval/critique.rs`) implements a deterministic word-overlap critique that checks factual accuracy, completeness, relevance, and clarity without needing an LLM call. This should be ported — but with every constant made configurable, calibrated, and explicitly labeled `uncalibrated:true` until the calibration procedure is run.

---

## SCOPE

**IN SCOPE (new files):**
- `src/recallCritique.ts` — recall quality critique engine (word-overlap metrics, composite scoring, pass/fail gate). All constants configurable; defaults labeled `uncalibrated:true`.
- `src/recallCritique.test.ts` — unit tests for all critique functions, including the uncalibrated-default behavior and the calibration-overrides path.
- `src/config/stopwords.ts` — stopword set **derived from the codebase's `TrigramEmbedder` vocabulary** (see S41A-2 for the derivation procedure). Not a hand-picked list.
- `scripts/calibrate-critique.mjs` — calibration script that harvests real recall events from `events.log`, runs the critique, reports the score distribution, and suggests a threshold rejecting the bottom quartile. Writes `~/.pi/mega-compact/calibration.json`.

**IN SCOPE (modified files):**
- `src/recall.ts` — integrate critique into `recallAndInline()` between search and inject; surface the critique result via the `onCritique` callback; on rejection, return an explicit report string (no silent swallow); on critique throw, proceed with the original recall and emit a `recall_critique_failed` event.
- `src/config.ts` — add `CRITIQUE_ENABLED` (default `true`), `CRITIQUE_THRESHOLD` (default `0.3`, `uncalibrated:true`), `CRITIQUE_WARN_THRESHOLD` (default `0.5`, `uncalibrated:true`), `CRITIQUE_WEIGHTS` (default `{0.35,0.30,0.25,0.10}`, `uncalibrated:true`), `CLARITY_OPTIMAL_MIN` (default `10`, `uncalibrated:true`), `CLARITY_OPTIMAL_MAX` (default `30`, `uncalibrated:true`). All env-overridable.
- `src/log.ts` — (no changes needed; existing `Logger` API is sufficient for the new event fields).

**OUT OF SCOPE:**
- Changes to `src/vectorStore.ts` — critique operates on search results, not the search itself.
- Changes to `src/engine.ts` — recall is called via `recallAndInline()`, not directly.
- Changes to `src/boundary.ts` — critique does not affect message dropping.
- **LLM-based critique (self-RAG with a language model) — removed.** S41 is fully local and will remain so. Any future LLM-based critique would be a separate sprint with its own PREVENT-PI-004 audit.
- Adaptive threshold learning from feedback (the calibration script is offline, not an online learner).
- Dashboard visualization of critique scores (future sprint).

---

## EXECUTION

### Sprint S41A: Core Critique Engine (`src/recallCritique.ts`)

**Goal:** Build a standalone, deterministic, zero-dependency recall quality critique module with four word-overlap metrics and a composite scoring function. Every constant the module reads is configurable and labeled `uncalibrated:true` until `~/.pi/mega-compact/calibration.json` says otherwise.

**Acceptance:** `src/recallCritique.test.ts` passes all unit tests; module imports only from `src/config.js`, `src/config/stopwords.js`, and `node:` builtins; zero external dependencies; every `CritiqueResult` carries an `uncalibrated: boolean` field that is `true` until `calibration.json` is present.

**Tasks:**

- [ ] **S41A-1: Define types and interfaces** (`src/recallCritique.ts`)
  Create the core types. Note the new `uncalibrated` and `weights` fields — these are load-bearing for the logging contract:
  ```ts
  /** Breakdown of individual critique dimensions. */
  export interface CritiqueBreakdown {
    factualAccuracy: number;   // 0–1: fraction of answer terms in context
    completeness: number;      // 0–1: fraction of query terms in answer
    relevance: number;         // 0–1: Jaccard similarity(query, context)
    clarity: number;           // 0–1: sentence structure heuristic
  }

  /** Weights used to compute the composite score. Logged with every result. */
  export interface CritiqueWeights {
    factualAccuracy: number;
    completeness: number;
    relevance: number;
    clarity: number;
  }

  /** Result of a recall critique evaluation. */
  export interface CritiqueResult {
    pass: boolean;             // score >= threshold
    score: number;             // 0–1 composite
    breakdown: CritiqueBreakdown;
    weights: CritiqueWeights;   // the weights actually used (env-overridable)
    threshold: number;         // the threshold actually used (env-overridable)
    uncalibrated: boolean;      // true until scripts/calibrate-critique.mjs runs
    reason: string;            // human-readable: "High relevance (0.82)" or "Low factual accuracy (0.15)"
  }
  ```

- [ ] **S41A-2: Derive the stopword set from `TrigramEmbedder`** (`src/config/stopwords.ts`)
  The original spec's ~80-word hand-picked stopword list is **replaced** with a vocabulary derived from the codebase's own `TrigramEmbedder` (`src/embedder.ts`). This makes the stopword set real, sourced, and versioned with the embedder — not a hand-picked guess that may diverge from how tokens are actually indexed.

  **Derivation procedure (documented in `src/config/stopwords.ts` as a header comment):**
  ```
  // Derivation (re-run when TrigramEmbedder vocabulary changes):
  // 1. Import the trigram vocabulary from src/embedder.ts (the set of trigrams
  //    the embedder actually indexes, plus the pre-tokenization step it applies).
  // 2. Run the embedder's own tokenizer over a representative English function-word
  //    corpus (a fixed list maintained in src/config/stopwords.ts of ~120
  //    candidate function words: articles, auxiliaries, prepositions, pronouns,
  //    conjunctions, determiners, quantifiers).
  // 3. A candidate is retained as a stopword IFF (a) the embedder's tokenizer
  //    produces at least one trigram for it, AND (b) the candidate does not
  //    produce a trigram that is also a trigram of any significant technical
  //    term in the codebase's known vocabulary (checked against a held-out
  //    set of code identifiers harvested from src/*.ts). This prevents filtering
  //    a word that would collide with a real code token.
  // 4. The resulting set is frozen as the exported `STOPWORDS: ReadonlySet<string>`.
  // 5. Re-derivation is gated by a hash check: the file records the hash of
  //    src/embedder.ts's vocabulary at derivation time; if it changes, a
  //    guardrail test (src/config/stopwords.test.ts) fails until the derivation
  //    is re-run. This keeps the stopword set synchronized with the embedder.
  ```
  The `STOPWORDS` set is exported as `ReadonlySet<string>` from `src/config/stopwords.ts`. Tokens ≤ 2 characters are also filtered in `significantTokens()` (too short to be meaningful overlap signals) — this is a function of the tokenizer, not a constant, and remains in `recallCritique.ts`.

  **Note:** this is NOT a hand-picked list. It is derived from the embedder the rest of the recall pipeline uses, so it cannot drift from what is actually indexed. The derivation procedure is re-runnable; the file pins the source hash and a guardrail test fails if the embedder vocabulary changes without re-derivation.

- [ ] **S41A-3: Implement `factualAccuracy()`** (`src/recallCritique.ts`)
  ```ts
  /**
   * What fraction of significant terms in `answer` also appear in `context`?
   * High score = answer is grounded in context (factual accuracy proxy).
   * Returns 0–1. Empty answer → 1.0 (nothing to contradict). Empty context → 0.
   */
  export function factualAccuracy(answer: string, context: string): number
  ```
  Implementation (pure word-overlap math — unchanged from the original spec):
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
  Implementation (pure set math — unchanged):
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
   * Measures avg sentence length — optimal is [CLARITY_OPTIMAL_MIN, CLARITY_OPTIMAL_MAX]
   * words per sentence (defaults 10–30, uncalibrated; configurable; see S41A-7).
   * Returns 0–1.
   */
  export function clarity(answer: string, opts?: { optimalMin?: number; optimalMax?: number }): number
  ```
  Implementation (the formula is real; the bounds are now configurable):
  ```
  optimalMin = opts?.optimalMin ?? CLARITY_OPTIMAL_MIN   // default 10, uncalibrated
  optimalMax = opts?.optimalMax ?? CLARITY_OPTIMAL_MAX   // default 30, uncalibrated
  sentences = answer.split(/[.!?]+/).filter(s => s.trim().length > 0)
  if sentences.length === 0: return 1.0
  avgLen = mean(sentences.map(s => s.trim().split(/\s+/).length))
  if avgLen >= optimalMin && avgLen <= optimalMax: return 1.0
  if avgLen < optimalMin: return avgLen / optimalMin      // too fragmented
  if avgLen > optimalMax: return optimalMax / avgLen       // too dense
  ```
  Note: clarity is a secondary signal. A recall chunk that is a code block will have low clarity (long unbroken text) but may be highly relevant. The composite scoring weights clarity at the lowest share by default (10%, `uncalibrated:true`; see S41A-7).

- [ ] **S41A-7: Implement `critiqueRecall()` composite function** (`src/recallCritique.ts`)
  ```ts
  /**
   * Run all four critique dimensions on a query + recalled chunks.
   * Chunks are concatenated into a single context string for scoring.
   * Returns a CritiqueResult with pass/fail, composite score, breakdown,
   * the weights and threshold actually used, and the uncalibrated flag.
   */
  export function critiqueRecall(
    query: string,
    recalledChunks: string[],
    opts?: {
      threshold?: number;     // default CRITIQUE_THRESHOLD (0.3, uncalibrated)
      warnThreshold?: number; // default CRITIQUE_WARN_THRESHOLD (0.5, uncalibrated)
      weights?: Partial<CritiqueWeights>;   // overrides CRITIQUE_WEIGHTS
      clarityBounds?: { optimalMin?: number; optimalMax?: number };
    },
  ): CritiqueResult
  ```
  Composite score formula (the formula is real; the weights are configurable + `uncalibrated:true` until `calibration.json` exists):
  ```
  weights = { ...CRITIQUE_WEIGHTS, ...opts.weights }    // env-overridable
  threshold = opts.threshold ?? CRITIQUE_THRESHOLD      // env-overridable, default 0.3
  uncalibrated = !exists("~/.pi/mega-compact/calibration.json")

  context = recalledChunks.join("\n\n")
  factual = factualAccuracy(context, query)  // fraction of context terms in query (grounding)
  comp = completeness(query, context)        // fraction of query terms in context
  rel = relevance(query, context)             // Jaccard overlap
  clr = clarity(context, opts.clarityBounds)  // sentence structure
  score = weights.factualAccuracy * factual
        + weights.completeness   * comp
        + weights.relevance      * rel
        + weights.clarity        * clr
  pass = score >= threshold
  ```
  **Default weights:** `{factualAccuracy: 0.35, completeness: 0.30, relevance: 0.25, clarity: 0.10}` — these are **uncalibrated defaults**, not "conservative" ones. They were not chosen with measurement. They will be replaced by the output of `scripts/calibrate-critique.mjs` once that is run against real recall events. Until then, every `CritiqueResult.uncalibrated === true`.

  Reason string: highest-scoring dimension → "High relevance (0.82)" or lowest → "Low factual accuracy (0.15)".

- [ ] **S41A-8: Unit tests** (`src/recallCritique.test.ts`)
  Test matrix (≥40 tests — the original 35 plus tests for the uncalibrated flag, calibration overrides, and the sourced-stopword derivation guard):
  - `tokenize`: normal text, empty string, punctuation-only, unicode, code blocks
  - `significantTokens`: filters stopwords (using the **derived** set from `src/config/stopwords.ts`), filters short tokens (≤2 chars), passes through technical terms
  - `STOPWORDS` derivation guard: assert the recorded source-hash in `src/config/stopwords.ts` matches the current `src/embedder.ts` vocabulary hash (fails the suite if the embedder changed and stopwords were not re-derived)
  - `factualAccuracy`: full overlap (1.0), partial overlap, no overlap (0), empty answer (1.0), empty context (0)
  - `completeness`: full coverage (1.0), partial, no coverage (0), empty query (1.0), empty answer (0)
  - `relevance`: identical texts (1.0), no overlap (0), partial, both empty (1.0), one empty (0)
  - `clarity`: optimal sentences (within `[CLARITY_OPTIMAL_MIN, CLARITY_OPTIMAL_MAX]` → 1.0), below optimalMin (<1.0), above optimalMax (<1.0), empty (1.0), code block (low clarity but acceptable), **custom `optimalMin`/`optimalMax` bounds override the defaults**
  - `critiqueRecall`: high-quality recall passes (score ≥ threshold), irrelevant recall fails (score < threshold), borderline at exactly the threshold, empty chunks, single chunk
  - `critiqueRecall` with custom weights: verify weights change the composite score and are echoed in `result.weights`
  - `critiqueRecall` with custom threshold: verify pass/fail boundary and `result.threshold` echo
  - `critiqueRecall.uncalibrated`: when `~/.pi/mega-compact/calibration.json` is absent (test tempdir), `result.uncalibrated === true`; when present, `result.uncalibrated === false`
  - Determinism: same inputs → same output every time

---

### Sprint S41B: Integration into `recallAndInline()` Pipeline + Logging Contract

**Goal:** Wire the critique gate into the recall path so irrelevant recalled chunks are rejected before injection. Enforce the error-logging contract: every critique result is logged with real fields; rejections are surfaced, never swallowed; critique failures fall through to the original recall.

**Acceptance:**
- With `CRITIQUE_ENABLED=true` (default), recall of irrelevant chunks is blocked (empty block returned, explicit report string surfaced). With `CRITIQUE_ENABLED=false`, behavior is identical to current production.
- Every `recall_critique` event logged via `Logger` includes the fields `{sessionId, score, breakdown:{factualAccuracy,completeness,relevance,clarity}, threshold, uncalibrated, rejected, weights}`.
- When `uncalibrated === true`, the log line includes `note: "run scripts/calibrate-critique.mjs"`.
- When the gate rejects, the report string is surfaced to the caller (not swallowed).
- When `critiqueRecall()` throws, the original recall proceeds AND a `recall_critique_failed` event logs the real error.

**Tasks:**

- [ ] **S41B-1: Add configuration to `src/config.ts`**
  Add the following exports. Every constant is env-overridable and labeled `uncalibrated:true` until `~/.pi/mega-compact/calibration.json` is present.
  ```ts
  /** Enable recall quality critique gate (S41). Default: true. */
  export const CRITIQUE_ENABLED = readBoolEnv("MEGACOMPACT_CRITIQUE", true);
  // Override: MEGACOMPACT_CRITIQUE=0 disables.

  /** Minimum composite score for recall injection (0–1). Below this, recall is skipped.
   *  UNCALIBRATED DEFAULT — not "conservative"; replace via scripts/calibrate-critique.mjs. */
  export const CRITIQUE_THRESHOLD = readFloatEnv("MEGACOMPACT_CRITIQUE_THRESHOLD", 0.3, 0, 1);

  /** Score below this triggers a warning log but still allows injection.
   *  UNCALIBRATED DEFAULT — replace via scripts/calibrate-critique.mjs. */
  export const CRITIQUE_WARN_THRESHOLD = readFloatEnv("MEGACOMPACT_CRITIQUE_WARN_THRESHOLD", 0.5, 0, 1);

  /** Composite-score weights. UNCALIBRATED DEFAULTS — replace via scripts/calibrate-critique.mjs. */
  export const CRITIQUE_WEIGHTS: CritiqueWeights = readWeightsEnv("MEGACOMPACT_CRITIQUE_WEIGHTS", {
    factualAccuracy: 0.35,
    completeness: 0.30,
    relevance: 0.25,
    clarity: 0.10,
  });

  /** Clarity optimal-range bounds (words per sentence). UNCALIBRATED DEFAULTS. */
  export const CLARITY_OPTIMAL_MIN = readIntEnv("MEGACOMPACT_CLARITY_OPTIMAL_MIN", 10);
  export const CLARITY_OPTIMAL_MAX = readIntEnv("MEGACOMPACT_CLARITY_OPTIMAL_MAX", 30);

  /** True until scripts/calibrate-critique.mjs writes ~/.pi/mega-compact/calibration.json. */
  export function critiqueIsUncalibrated(): boolean {
    return !existsSync(path.join(homedir(), ".pi/mega-compact/calibration.json"));
  }
  ```
  Env readers: `MEGACOMPACT_CRITIQUE` (truthy/falsy, default `true`), `MEGACOMPACT_CRITIQUE_THRESHOLD` (float, clamped [0,1]), `MEGACOMPACT_CRITIQUE_WARN_THRESHOLD` (float, clamped [0,1]), `MEGACOMPACT_CRITIQUE_WEIGHTS` (JSON object string), `MEGACOMPACT_CLARITY_OPTIMAL_MIN`, `MEGACOMPACT_CLARITY_OPTIMAL_MAX` (positive ints).

- [ ] **S41B-2: Modify `recallAndInline()` in `src/recall.ts`** (insert after search + dedupe, before block assembly, around line ~130)
  After the search results are retrieved and window-deduped, but before building the injection block:
  ```ts
  // ── S41 Recall Critique Gate ────────────────────────────────────────
  if (CRITIQUE_ENABLED && hits.length > 0) {
    let critiqueResult: CritiqueResult;
    try {
      const chunkTexts = hits.map(h => h.checkpoint.summary);
      critiqueResult = critiqueRecall(opts.query, chunkTexts, {
        threshold: CRITIQUE_THRESHOLD,
        warnThreshold: CRITIQUE_WARN_THRESHOLD,
        weights: CRITIQUE_WEIGHTS,
        clarityBounds: { optimalMin: CLARITY_OPTIMAL_MIN, optimalMax: CLARITY_OPTIMAL_MAX },
      });
    } catch (err) {
      // Critique failed — fall through to the original recall AND log the real error.
      // The gate must never block recall because of a bug in the gate itself.
      logger.log("error", "recall_critique_failed", {
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        chunkCount: hits.length,
      });
      critiqueResult = null;  // fall through: original recall proceeds
    }

    if (critiqueResult) {
      // Log critique result — every field is real, no invented values.
      logger.log("info", "recall_critique", {
        sessionId: opts.sessionId,
        score: critiqueResult.score,
        breakdown: critiqueResult.breakdown,
        threshold: critiqueResult.threshold,
        uncalibrated: critiqueResult.uncalibrated,
        rejected: !critiqueResult.pass,
        weights: critiqueResult.weights,
        reason: critiqueResult.reason,
        chunkCount: hits.length,
        ...(critiqueResult.uncalibrated
          ? { note: "run scripts/calibrate-critique.mjs" }
          : {}),
      });

      // Surface the critique result to the caller (dashboard / monitoring).
      opts.onCritique?.(critiqueResult);

      if (!critiqueResult.pass) {
        // Recall failed the quality gate. SKIP injection, but surface an
        // EXPLICIT report string — do not swallow the rejection silently.
        logger.log("warn", "recall_critique_rejected", {
          sessionId: opts.sessionId,
          score: critiqueResult.score,
          threshold: critiqueResult.threshold,
          uncalibrated: critiqueResult.uncalibrated,
          reason: critiqueResult.reason,
        });
        return {
          toInject: [],
          report: [
            `  ⚠ Recall critique rejected injection (score ${critiqueResult.score.toFixed(3)} < ${critiqueResult.threshold}). ` +
              `Reason: ${critiqueResult.reason}.` +
              (critiqueResult.uncalibrated
                ? " [uncalibrated defaults in use — run scripts/calibrate-critique.mjs]"
                : ""),
          ],
          block: "",
          empty: true,
        };
      }

      if (critiqueResult.score < CRITIQUE_WARN_THRESHOLD) {
        logger.log("warn", "recall_critique_low", {
          sessionId: opts.sessionId,
          score: critiqueResult.score,
          warnThreshold: CRITIQUE_WARN_THRESHOLD,
          uncalibrated: critiqueResult.uncalibrated,
          reason: critiqueResult.reason,
        });
      }
    }
  }
  // ── End S41 ─────────────────────────────────────────────────────────
  ```
  **Placement:** This block must be inserted AFTER the `hits` array is populated (line ~130) but BEFORE the `for (const h of hits)` loop that builds `toInject` and `parts` (line ~135). The critique operates on the full hit set, not per-hit.

  **Contract notes:**
  - No silent rejection — the `report` array carries a human-readable string explaining the rejection, surfaced to the caller.
  - Critique throw → original recall proceeds AND `recall_critique_failed` logs the real error and stack. The gate never blocks recall because of a bug in the gate itself.

- [ ] **S41B-3: Add imports in `src/recall.ts`**
  At the top of `src/recall.ts`, add:
  ```ts
  import { critiqueRecall, type CritiqueResult } from "./recallCritique.js";
  import {
    CRITIQUE_ENABLED,
    CRITIQUE_THRESHOLD,
    CRITIQUE_WARN_THRESHOLD,
    CRITIQUE_WEIGHTS,
    CLARITY_OPTIMAL_MIN,
    CLARITY_OPTIMAL_MAX,
  } from "./config.js";
  import { Logger } from "./log.js";
  ```
  A module-level `Logger` instance is created in `recall.ts` for the critique-event logging (the recall path is not pure — it already reads from the SQLite store — so a module-level logger is consistent with the existing module's side-effect profile). The optional `onCritique` callback on `RecallInjectOptions` remains for callers (dashboard / extension) that want the structured result without parsing log lines.

- [ ] **S41B-4: Update `RecallInjectOptions` interface** (`src/recall.ts`)
  Add optional field:
  ```ts
  /** Callback fired when critique evaluates recall quality (S41). */
  onCritique?: (result: CritiqueResult) => void;
  ```
  This allows the extension to observe critique results for dashboard/monitoring without coupling `recall.ts` callers to the logger.

- [ ] **S41B-5: Wire env-var reading** (`src/config.ts`)
  In the config module, read all env vars listed in S41B-1. `MEGACOMPACT_CRITIQUE` is truthy/falsy (default `true`). The threshold env vars are parsed as floats and clamped to `[0, 1]`. `MEGACOMPACT_CRITIQUE_WEIGHTS` is parsed as a JSON object string and validated for the four keys (extra keys rejected, missing keys fall back to defaults). The clarity bounds are parsed as positive ints.

- [ ] **S41B-6: Integration tests** (`src/recallCritique.test.ts`)
  Test scenarios (building on unit tests from S41A-8):
  1. **Relevant recall passes:** Query = "How do I set up JWT auth?", chunks = ["Set up JWT authentication by configuring the token secret and middleware..."]. Critique score ≥ threshold. Injection proceeds. `onCritique` is called.
  2. **Irrelevant recall rejected:** Query = "How do I set up CI/CD?", chunks = ["Database migrations use Knex.js with PostgreSQL..."]. Critique score < threshold. Injection blocked (empty block, empty toInject). Report string is non-empty and surfaces the score + threshold.
  3. **Mixed relevance:** 2 relevant chunks + 1 irrelevant. Composite score is averaged — may pass or fail depending on the mix.
  4. **Empty query:** `critiqueRecall("", chunks)` → completeness = 1.0 (vacuously), relevance = 0 → composite depends on other dimensions.
  5. **Empty chunks:** `critiqueRecall(query, [])` → factual = 0, completeness = 0, relevance = 0, clarity = 1.0 → composite = `weights.clarity` → fails (since `weights.clarity` is 0.10 by default, < threshold 0.3).
  6. **Single short chunk:** `critiqueRecall("auth setup", ["JWT"])` → partial overlap → test the boundary.
  7. **Flag OFF regression:** With `CRITIQUE_ENABLED=false` (env `MEGACOMPACT_CRITIQUE=0`), `recallAndInline()` produces identical output to current production. No critique log entries.
  8. **Flag ON, critique passes, callback fires:** Verify `onCritique` is called with the correct `CritiqueResult` when critique runs.
  9. **Flag ON, critique fails, returns early:** Verify `toInject` is empty, `block` is empty, `empty` is true, `report` contains a warning string that includes the score, threshold, and reason.
  10. **Low score warning:** Score between threshold (0.3) and warn threshold (0.5) → injection proceeds but `recall_critique_low` is logged.
  11. **Custom threshold:** Pass threshold=0.1 → almost everything passes. Pass threshold=0.9 → almost everything fails.
  12. **Code-heavy chunks:** Chunks that are mostly code (low clarity) but contain relevant terms → critique should still pass due to the low clarity weight (default 10%, `uncalibrated:true`).
  13. **Critique throw → fall through:** Mock `critiqueRecall` to throw; verify original recall proceeds AND `recall_critique_failed` is logged with the real error message.
  14. **Uncalibrated flag in logs:** When `~/.pi/mega-compact/calibration.json` is absent (test tempdir), every `recall_critique` log line includes `uncalibrated:true` and `note:"run scripts/calibrate-critique.mjs"`. When present (test tempdir), `uncalibrated:false` and no `note`.
  15. **No silent rejection:** On rejection, the `report` array contains a non-empty string that includes the score, threshold, and reason — verified by asserting the report string is non-empty and contains the score.

---

### Sprint S41C: Calibration Script (`scripts/calibrate-critique.mjs`)

**Goal:** Provide an offline, real-data calibration procedure that replaces the uncalibrated defaults with measured values, written to `~/.pi/mega-compact/calibration.json`. Until this runs, every critique result carries `uncalibrated:true` and the log line carries `note:"run scripts/calibrate-critique.mjs"`.

**Acceptance:** Running `node scripts/calibrate-critique.mjs` reads real `(query, retrieved-context)` pairs harvested from `events.log` (falling back to a small built-in set if `events.log` has no recall events yet — but the built-in set is REAL recall pairs, not synthetic), runs `critiqueRecall` against each, prints the score distribution, and writes a `calibration.json` that sets `CRITIQUE_THRESHOLD` to reject the bottom quartile. After the script runs, `critiqueIsUncalibrated()` returns `false`.

**Tasks:**

- [ ] **S41C-1: Harvest real recall pairs from `events.log`**
  Parse `events.log` for `recall_critique` events (the ones S41B-2 emits). Each event has `sessionId`, `score`, `breakdown`, `query` (truncated to 100 chars in the log — for calibration, the script also reads the SQLite `raw_transcript` table to recover the full query when needed), and the chunk texts (read from the `context_chunks` table by the chunk IDs in the event, or re-derive by re-running `recallAndInline` against the session's stored state).

  If `events.log` has zero `recall_critique` events (e.g., the gate just shipped and hasn't run yet), fall back to a held-out set of REAL `(query, retrieved-context)` pairs checked into `scripts/calibration-seed.jsonl`. These are real pairs harvested from a real session during development — NOT synthetic. Each line is `{query, chunks: string[], expectedPass: boolean}`. The seed file is small (≤20 pairs) and is replaced by the harvested set as soon as the gate has run against real sessions.

- [ ] **S41C-2: Compute the score distribution and suggest a threshold**
  For each harvested pair, run `critiqueRecall(query, chunks)` with the current (uncalibrated-default) weights. Collect the scores. Print:
  - Count, min, p25, median, p75, max.
  - Histogram (10 buckets, 0.0–1.0).
  - Suggested `CRITIQUE_THRESHOLD`: the p25 of the score distribution (rejects the bottom quartile). This is a heuristic, not a learned model — the user is expected to review the histogram and adjust.

- [ ] **S41C-3: Write `~/.pi/mega-compact/calibration.json`**
  The file is a JSON object:
  ```json
  {
    "calibratedAt": "2026-07-26T12:34:56.000Z",
    "sourceEventsLog": "/path/to/events.log",
    "sampleSize": 123,
    "scoreDistribution": { "min": 0.05, "p25": 0.31, "median": 0.52, "p75": 0.71, "max": 0.94 },
    "suggestedThreshold": 0.31,
    "appliedThreshold": 0.31,
    "weights": { "factualAccuracy": 0.35, "completeness": 0.30, "relevance": 0.25, "clarity": 0.10 },
    "weightsNote": "Weights are NOT auto-adjusted by the calibration script; they remain the uncalibrated defaults unless the operator manually edits this file. Auto-tuning weights requires labeled (good/bad) pairs, which the script does not have."
  }
  ```
  After the file is written, `critiqueIsUncalibrated()` returns `false`, and subsequent `recall_critique` log lines omit the `note` field.

  **Explicit non-goal:** the calibration script does NOT auto-tune the weights. Weights would require labeled good/bad pairs (a supervised signal); the script only has unlabeled recall events (unsupervised). The script only suggests a threshold (bottom-quartile rejection). The operator can hand-edit `calibration.json` to override weights if they have labeled data. This is documented in the script's `--help` output.

- [ ] **S41C-4: Test the calibration script** (`scripts/calibrate-critique.test.ts` or a `node --test` block inside the script)
  - With a fake `events.log` containing 10 `recall_critique` events of known scores, verify the script prints the correct distribution and writes `calibration.json` with the correct p25 threshold.
  - With an empty `events.log` and a `scripts/calibration-seed.jsonl` of 5 real pairs, verify the script uses the seed and writes `calibration.json`.
  - After the script runs, verify `critiqueIsUncalibrated()` returns `false` (in a fresh process reading the same `~/.pi/mega-compact/` dir).

---

## ACCEPTANCE CRITERIA

1. `src/recallCritique.ts` exports `CritiqueBreakdown`, `CritiqueWeights`, `CritiqueResult`, `tokenize()`, `significantTokens()`, `factualAccuracy()`, `completeness()`, `relevance()`, `clarity()`, `critiqueRecall()`.
2. `src/recallCritique.test.ts` has ≥40 unit tests covering all exports, edge cases, boundary conditions, the uncalibrated flag, calibration overrides, the stopword-derivation hash guard, and determinism.
3. `src/config/stopwords.ts` exports a `STOPWORDS: ReadonlySet<string>` **derived from `TrigramEmbedder`'s vocabulary** (not a hand-picked list). The file records the source-hash and a guardrail test fails if the embedder vocabulary changes without re-derivation.
4. `scripts/calibrate-critique.mjs` runs end-to-end: harvests real pairs from `events.log` (or falls back to `scripts/calibration-seed.jsonl`), prints the score distribution, suggests a bottom-quartile threshold, and writes `~/.pi/mega-compact/calibration.json`. It does NOT auto-tune weights (documented).
5. **All weights and thresholds are configurable** (env-overridable) AND **labeled `uncalibrated:true`** in every `CritiqueResult` and every `recall_critique` log line until `scripts/calibrate-critique.mjs` writes `calibration.json`. After calibration, `uncalibrated:false`.
6. **Error-logging contract enforced:** every `recall_critique` log line includes `{sessionId, score, breakdown:{factualAccuracy,completeness,relevance,clarity}, threshold, uncalibrated, rejected, weights}`. When `uncalibrated:true`, the line includes `note:"run scripts/calibrate-critique.mjs"`. No silent rejection — rejected injections surface an explicit report string to the caller. Critique throws → original recall proceeds AND `recall_critique_failed` logs the real error and stack.
7. **Gate is default ON** (`CRITIQUE_ENABLED = true`). `MEGACOMPACT_CRITIQUE=0` disables it (gate skipped, no critique events logged, recall proceeds as today).
8. `recallAndInline()` with `CRITIQUE_ENABLED=true` rejects recall injections when composite score < threshold, returning `{ toInject: [], block: "", empty: true, report: [<explicit reason string>] }`.
9. `recallAndInline()` with `CRITIQUE_ENABLED=true` logs critique scores via `Logger` AND surfaces the result to the `onCritique` callback when provided.
10. `recallAndInline()` with `CRITIQUE_ENABLED=false` produces byte-identical output to current production (verified by the existing test suite).
11. All critique functions are deterministic (same inputs → same outputs, no randomness, no network calls, **no LLM calls**).
12. Zero external npm dependencies in `src/recallCritique.ts` or `src/config/stopwords.ts`.
13. All existing tests pass (no regression). `npm run lint` passes with no new warnings. `python3 scripts/regression_check.py --all` passes. `node scripts/guardrails-scan.mjs` passes (PREVENT-PI-004 OK — no network, no LLM).

---

## ROLLBACK

1. **Feature flag:** Set `CRITIQUE_ENABLED=false` (`MEGACOMPACT_CRITIQUE=0` in env). All new code paths are gated — zero runtime impact.
2. **Code rollback:** `git revert <commit>` removes `src/recallCritique.ts`, `src/recallCritique.test.ts`, `src/config/stopwords.ts`, `scripts/calibrate-critique.mjs`, `scripts/calibration-seed.jsonl`, and the recall/config changes. Clean revert with no schema or data migration needed.
3. **No data migration:** recall critique is runtime-only. No SQLite schema changes, no stored state — EXCEPT `~/.pi/mega-compact/calibration.json`, which is a cache file the operator can delete at any time to return to `uncalibrated:true` defaults. Deleting it is a safe no-op rollback of the calibration state.
4. **No downstream dependency:** nothing in the extension entry (`extensions/mega-compact.ts`) or dashboard depends on recall critique. The `onCritique` callback is optional and callers can omit it.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Word-overlap metrics are too crude for technical queries (e.g., "auth" vs "authentication" not matching) | Medium | Medium | Use stemming-lite: strip common suffixes (-tion, -ing, -ed, -ment, -ness) before comparison. Or accept partial matches — the composite score is designed to tolerate some mismatch. |
| Threshold too aggressive: good recall rejected | Medium | High | **The default threshold (0.3) is an uncalibrated default, not a "conservative" one** — it was not chosen with measurement. The calibration script (`scripts/calibrate-critique.mjs`) replaces it with the bottom-quartile cutoff of real recall scores. Until then, every log line carries `uncalibrated:true` and `note:"run scripts/calibrate-critique.mjs"` so the operator knows the threshold is a placeholder. |
| Threshold too lenient: bad recall passes | Medium | Medium | The warn threshold (0.5) is also an uncalibrated default; the calibration script reports it in the distribution. The `recall_critique_low` event flags marginal cases for monitoring. |
| Weights are wrong (e.g., clarity should be weighted higher) | High | Medium | **Weights are uncalibrated defaults.** The calibration script explicitly does NOT auto-tune weights (it would require labeled good/bad pairs). The operator can hand-edit `calibration.json` to override weights if they have labeled data. Every log line echoes the weights actually used so the operator can correlate weights with outcomes. |
| Clarity optimal range (10–30 words) is wrong | Medium | Low | `CLARITY_OPTIMAL_MIN`/`CLARITY_OPTIMAL_MAX` are uncalibrated defaults, env-overridable. The calibration script reports the avg-sentence-length distribution of real chunks so the operator can adjust. |
| Stopword list diverges from the embedder's vocabulary | Medium | Medium | **Mitigated by derivation:** the stopword set is derived from `TrigramEmbedder`'s vocabulary (not hand-picked), and a guardrail test fails if the embedder vocabulary changes without re-derivation. This was the root defect in the original spec. |
| Code-heavy chunks have low clarity | High | Low | Clarity weight is the lowest by default (10%, `uncalibrated:true`). Code-heavy chunks that contain relevant terms will still pass. |
| Empty query edge case (e.g., auto-recall on resume with no query) | Low | Medium | Empty query → completeness = 1.0, relevance = 0 → score depends on other dimensions. The `recallAndInline` caller should provide a meaningful query (the last user message). |
| Critique adds latency to recall path | Low | Low | All functions are string operations (split, set intersection). O(n) in token count. For typical chunks (100–500 words), this is <1ms. No network, no I/O, no LLM. |
| Critique throws and blocks recall | Low | High | **Mitigated by contract:** `critiqueRecall` is wrapped in try/catch in `recallAndInline`; on throw, the original recall proceeds AND `recall_critique_failed` logs the real error and stack. The gate never blocks recall because of a bug in the gate itself. |
| Calibration script harvests a non-representative sample | Medium | Medium | The script reports the sample size and distribution; if `sampleSize < 30`, it prints a warning that the suggested threshold is unreliable. The operator is expected to wait until the gate has run against enough real sessions before trusting the suggested threshold. |
| Operator never runs the calibration script | High | Low | Until they do, every `recall_critique` log line carries `note:"run scripts/calibrate-critique.mjs"` — the prompt is in-band, not buried in docs. The uncalibrated defaults are usable (the gate still functions); they're just not measured. |
