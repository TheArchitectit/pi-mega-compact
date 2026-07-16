# S25 — RAPTOR Promotion: Harden Live Hierarchical Recall

**Date:** 2026-07-16
**Parent plan:** feat/unified-pressure (unified pressure signal + memory hardening)
**Depends on:** S13 RAPTOR shadow build (src/dedup/raptor/*), S14 dedup config single-source (src/config/dedup.ts), S24 unified pressure
**Priority:** P1 (correctness + latency hardening of an already-shipping path)
**Status:** Draft → implement-ready
**Target version:** v0.6.2

---

## SAFETY PROTOCOLS

- PREVENT-PI-001/002/003: recall block injection unchanged — still `before_agent_start` systemPrompt prepend (recall.ts:10-14). Never split tool pairs; never inject as `role:system`.
- PREVENT-PI-004: ZERO network at runtime. RAPTOR summarize uses localhost-only Ollama (summarizer.ts, annotated) or deterministic extractive. `raptorSearchHits`/`rehydrateRaptorTree` are pure in-memory + SQLite reads (node:sqlite, in-process). No fetch.
- PREVENT-002: all SQLite via parameterized queries (sqlite.ts upsert/select). Do NOT string-concatenate.
- PREVENT-011: no `any` in new code; type `StoredCheckpoint`, `SearchHit`, `RaptorTree` explicitly.
- Four Laws (AGENT_GUARDRAILS.md): Read First (this spec + the 6 files cited), Stay in Scope (recall merge only), Verify Before Commit (`npm run lint` + `python3 scripts/regression_check.py --all` + new tests), Halt When Uncertain.
- Guardrails gate: every change must pass `npm run lint` + regression check. RAPTOR promotion is canary-sequenced LAST (L0→L1→L2→RAPTOR) in canary.ts; auto-disable on p95 breach.
- Non-fatal invariant: RAPTOR serving MUST never block compaction or recall. Any failure → fall back to flat MMR (already wired at vectorStore.ts:580-582, 487-493).

---

## PROBLEM

RAPTOR was promoted from shadow to live between S13 and this branch, but the promotion is *implicit and fragile*:

1. **Shadow gate is inert for serving.** `isShadowMode()` (index.ts:21-23) only affects logging (index.ts:64-69). Setting `RAPTOR_SHADOW_MODE=false` does NOT disable the live serve path (vectorStore.ts:469) — contradicting the Sprint-13 contract that this env var gates serving during transition.
2. **No freshness check.** `raptorSearchHits` (vectorStore.ts:559) rehydrates whatever tree exists. A tree built before checkpoints were dedup-removed (SemDeDup) or trimmed can serve stale root summaries / reference removed checkpoints. There is no "tree build timestamp vs max checkpoint timestamp" guard.
3. **`parentId` is always null** (tree.ts:140,179,210,226,247). `rehydrateRaptorTree` copies it (index.ts:115), and `leafDescendants` BFS (retrieval.ts:36-50) works only because leaf ids are stored flat in `children`. Any future parent-walk (e.g., to inject high-level summaries) breaks silently.
4. **High-level summaries are NOT injected.** `raptorSearchHits` resolves RAPTOR leaf ids → checkpoint ids → injected checkpoint `.summary` (vectorStore.ts:575-577). The RAPTOR node `summary` (the actual consolidation win) is never injected; only `recallRaptorRootSummary` (index.ts:141) surfaces it for durable-trim. So "broader O(log n) coverage" is real for *selection* but the *content* is still flat per-checkpoint text.
5. **Per-recall rebuild + linear scan.** `rehydrateRaptorTree` rebuilds the full node Map on EVERY `search` (index.ts:106-131); `raptorSearchHits` then does `all.find` per leaf id (vectorStore.ts:576). O(n·leaves) per recall with no cache.
6. **No coverage/latency acceptance tests.** promote.test.ts only asserts "hits are real checkpoints" (promote.test.ts:33-69), not that RAPTOR improves breadth or stays within p95.

Goal: make the live RAPTOR path *observable, fresh, and bounded* — honoring the shadow gate, adding a freshness guard, caching the rehydrated tree, and adding testable acceptance for coverage-breadth + p95 latency. Keep all behavior non-fatal.

---

## SCOPE

### IN
- Honor `RAPTOR_SHADOW_MODE` env as a hard SERVE gate (not just logging) at the `search` merge point (vectorStore.ts:469).
- Add a freshness guard: store a `built_at` epoch on the RAPTOR tree; in `raptorSearchHits`, skip RAPTOR (fall back to flat) when the tree is stale relative to `max(checkpoint.timestamp)` or when `timedOut` extractive root was used.
- Cache the rehydrated `RaptorTree` per (sessionId) keyed on tree version/`built_at`, invalidated on `saveRaptorTree`, so `search` does not rebuild the Map every call.
- Add a `raptorSummaryHits` option to also surface top-level RAPTOR node summaries (not just selected checkpoints) when `RAPTOR_INJECT_SUMMARIES=true` (default false — Phase-2, behind flag), formatted via a new `formatRaptorBlock`.
- Add acceptance tests: (a) shadow mode `=false` disables serving; (b) stale tree falls back to flat; (c) RAPTOR widens recall coverage vs flat-only on a 2-cluster fixture; (d) p95 latency of `search` with RAPTOR stays under `P95_BUDGET_MS` (dedup.ts:93, default 100ms) on a 200-checkpoint fixture.
- Record RAPTOR serve events to monitoring (events.log) via the existing `eventsPath` for canary p95.

### OUT
- Changing the RAPTOR build algorithm (kmeans/summarizer) — out of scope; tree.ts unchanged except `built_at` plumbing.
- MiniLM embedder — off, not shipped (CLAUDE.md §5).
- Cross-repo RAPTOR (S17 PGlite path) — recallAndInlineAsync untouched.
- Durable-trim root-summary changes (already works via recallRaptorRootSummary) — out of scope.
- Removing `parentId` column — retained for future parent-walk; do NOT rely on it yet.

---

## EXECUTION

1. **Plumb `built_at` into the tree.**
   - `src/store/sqlite.ts:451` schema: add column `built_at INTEGER` to `raptor_nodes` (and to `StoredRaptorNode` at :1399-1408, `upsertRaptorNode` :1413-1429, `saveRaptorTree` :1433-1454, `listRaptorNodes` :1457-1473). Store the max checkpoint timestamp at build time (pipeline already has `all` with timestamps at mega-pipeline.ts:235).
   - `src/dedup/raptor/index.ts:44-78` `runRaptor`: accept `builtAt?: number` in `RaptorOrchestratorOptions` (add to interface :25-34); pass `builtAt` through `saveRaptorTree` to `upsertRaptorNode`. Default `builtAt = Date.now()` if omitted.
   - `src/dedup/raptor/tree.ts`: no change to shape; `built_at` is a persistence concern only.

2. **Rehydrate returns freshness metadata.**
   - `src/dedup/raptor/index.ts:102-133` `rehydrateRaptorTree`: add fields `builtAt: number` and `timedOut: boolean` to the returned `RaptorTree` (extend interface at tree.ts:37-43 with optional `builtAt`). Derive `builtAt` = max of node rows' `built_at`; `timedOut` from the existing `r99_0` level===99 marker or a stored flag.

3. **Serve gate + freshness + cache in `VectorStore`.**
   - `src/vectorStore.ts:103-110` class: add private `raptorCache: Map<string, { tree: RaptorTree; builtAt: number }>` (keyed by `sid`).
   - New private `getRaptorTree(sid)`: if cache hit with `builtAt` ≥ `maxCheckpointTimestamp(sid)` return it; else `rehydrateRaptorTree` (index.ts:102), cache, return (or `null`).
   - `src/vectorStore.ts:559-583` `raptorSearchHits`: BEFORE calling `stagedExpansion`, apply gates:
     a. `if (process.env.RAPTOR_SHADOW_MODE === "false") return [];` — honors the shadow contract at SERVE time (was logging-only).
     b. `const tree = this.getRaptorTree(sid); if (!tree || tree.timedOut) return [];` — skip stale/extractive-fallback trees.
     c. Replace inline `rehydrateRaptorTree(sid, ...)` call (was :561) with cached `tree`.
   - Keep the existing `try/catch → []` (vectorStore.ts:560,580-582) and the dedup-key collision guard (`:474`) — RAPTOR leaf ids ARE checkpoint ids, so no double-inject.

4. **Optional high-level summary injection (flag-gated, Phase-2 default OFF).**
   - `src/config/dedup.ts:54-56` area: add `RAPTOR_INJECT_SUMMARIES: envBool("MEGACOMPACT_RAPTOR_INJECT_SUMMARIES", false)`.
   - `src/recall.ts:59-80` `formatRecallBlock`: add sibling `formatRaptorBlock(hits: {summary:string; score:number; level:number}[])` that labels a RAPTOR node summary as "hierarchical summary". Wire into `recallAndInline` (recall.ts:116-134) only when `opts.raptorSummaries` true AND `RAPTOR_INJECT_SUMMARIES` set — out of default path.
   - This step is OPTIONAL for v0.6.2; the merge step (3) is mandatory.

5. **Monitoring / canary hook.**
   - In `raptorSearchHits`, when `eventsPath` set (vectorStore.ts:110), `this.recordEvent("raptor_serve", { sid, leaves: leafIds.length, served: hits.length, ms: elapsed })` using the existing `events.log` writer. Reuse canary.ts p95 machinery (no new schema).

6. **Pipeline freshness source.**
   - `extensions/mega-pipeline.ts:232-258`: pass `builtAt: Math.max(...all.map(c => c.timestamp))` into `runRaptor` opts (use the `all` already fetched at :235). Guard with `Number.isFinite`.

7. **Tests (new file `src/dedup/raptor/serve-gate.test.ts` + extend `promote.test.ts`).**
   - Shadow: `process.env.RAPTOR_SHADOW_MODE="false"` → `s.search()` returns same hits as with no tree (RAPTOR not merged). Restore env after.
   - Stale: build tree, then `compactSession` a new checkpoint; assert `raptorSearchHits` falls back (flat hits unchanged, no RAPTOR errors).
   - Coverage breadth: 2 well-separated topics (20 checkpoints each); `RAPTOR_ENABLED` search hits span BOTH topics; flat-only (disable RAPTOR) misses one. Assert RAPTOR set ⊇ flat set on at least one topic.
   - p95: 200-checkpoint fixture, 20 queries; assert median `search` latency < `P95_BUDGET_MS` (100ms). Use `performance.now()` around `s.search`.

---

## ACCEPTANCE

- [ ] `RAPTOR_SHADOW_MODE=false` disables RAPTOR serving in `VectorStore.search` (test in serve-gate.test.ts). Setting it `true` (or unset) serves as today.
- [ ] A RAPTOR tree built before a new checkpoint is added does NOT inject/merge stale hits; `search` returns flat-MMR result with no RAPTOR merge (freshness guard fires).
- [ ] `raptorSearchHits` returns `[]` (→ flat fallback) when the only tree is a `timedOut` extractive root (`r99_0`).
- [ ] Rehydrated tree is cached: calling `search` N times on an unchanged session rebuilds the node Map ≤1 time (verified via a spy on `rehydrateRaptorTree` or cache-size assertion).
- [ ] Coverage test: RAPTOR-enabled recall covers both separated topics where flat-only misses one (breadth improvement proven, not just "real checkpoints").
- [ ] p95 latency test: 200-checkpoint fixture, median `search` < 100ms with RAPTOR enabled.
- [ ] `npm run lint` clean; `python3 scripts/regression_check.py --all` passes; all 280+ existing tests still green (no regression to recall.ts / promote.test.ts).
- [ ] `raptor_serve` event recorded to events.log when `eventsPath` set (canary-replayable).
- [ ] `RAPTOR_INJECT_SUMMARIES` defaults false; high-level node summaries only inject when explicitly enabled (no change to default recall block).

---

## ROLLBACK

- Single flag: set `MEGACOMPACT_RAPTOR_ENABLED=false` → `vectorStore.ts:469` short-circuits, `search` returns flat MMR (vectorStore.ts:487-493). `runRaptor` is also skipped at mega-pipeline.ts:232.
- Shadow revert: set `RAPTOR_SHADOW_MODE=false` → `raptorSearchHits` returns `[]` at gate (step 3a); build/persist continues (non-fatal, logged).
- If p95 breaches in canary: canary.ts auto-disables RAPTOR tier (L0→L1→L2→RAPTOR sequencing); monitoring `FP_RATE_L1L2`/`P95_BUDGET_MS` (dedup.ts:91,93) trigger.
- Schema: `built_at` column is additive (nullable INTEGER); old DBs simply have `NULL` → treated as stale → flat fallback. No migration needed (SQLite ADD COLUMN is online). `clearRaptorNodes` (sqlite.ts:1475) still full-clears for cleanup.
- Revert commit: this is one focused commit; `git revert` restores shadow-only logging + per-call rehydrate behavior.
