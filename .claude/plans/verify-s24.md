# Verify S24 — Grounded state + verification gate

**Date:** 2026-07-16
**Branch:** `feat/verify-s24` (off `master` @ `eb59e07`, v0.6.2). The older `feat/unified-pressure`, `feat/durable-trim`, and `feature/memory-rag-auto-review` branches were deleted (all merged/empty). Do NOT commit to `master`; one focused, AI-attributed commit per spec.

---

## Current state (grounded in code — distilled from the three S25 research drafts)

### RAPTOR (hierarchical recall) — `src/dedup/raptor/*`, `src/vectorStore.ts`
- RAPTOR is already LIVE, not shadow: `RAPTOR_ENABLED` defaults `true` (`src/config/dedup.ts:73`); `VectorStore.search` merges RAPTOR hits at `src/vectorStore.ts:469-485`.
- The shadow gate is inert for serving: `isShadowMode()` (`src/dedup/raptor/index.ts:21-23`) only affects logging (`:64-69`); setting `RAPTOR_SHADOW_MODE=false` does NOT disable the live path — contradicting the Sprint-13 contract.
- `recallRaptor` (`index.ts:86-95`) returns raw leaf **ids** that are checkpoint ids; injection resolves them via `all.find(c => c.checkpointId === id)` (`vectorStore.ts:559-583`) and injects the checkpoint's own `.summary`, NOT the RAPTOR node summary (which only surfaces via `recallRaptorRootSummary`, `index.ts:141-153`, for durable-trim).
- Config flags verbatim: `RAPTOR_BUDGET_MS` (dedup.ts:87, 5000), `RAPTOR_CLUSTERS_PER_LEVEL` (dedup.ts:88, 5), `RAPTOR_CONSISTENCY` (dedup.ts:89, 0.6), `MMR_LAMBDA` (dedup.ts:81, 0.5). `parentId` is always `null` in the tree (`tree.ts:140,179,210,226,247`).
- Fallback is safe already: `raptorSearchHits` is fully `try/catch`-wrapped returning `[]` (`vectorStore.ts:560,580-582`); `search` falls through to plain MMR (`:487-493`). Latency risk: `rehydrateRaptorTree` rebuilds the whole Map per call (`:106-131`) plus a linear `all.find` per leaf (`:573-577`), O(n·leaves) per recall.

### Durable memory (write→persist→recall→inline) — `memory.ts`, `memoryOps.ts`, `memoryRecall.ts`, `recall.ts`, `store/sqlite.ts`, `mega-events.ts`
- Full chain is wired: `turn_end` → `runMemoryReview` (`mega-events.ts:231-234`, `mega-pipeline.ts:50-54`) → `applyMemoryOps` → `addMemory`/`replaceMemory`/`removeMemory` (`sqlite.ts:800-900`, schema `:523-537`); recall via `recallMemoriesAndInline` (`recall.ts:186-236`) → `recallMemories` (`memoryRecall.ts:46-83`); inline prepend via `before_agent_start` (`mega-events.ts:113-122`, PREVENT-PI-003 compliant).
- Hallucination guard (`memory.ts:70-74`) drops any add/replace whose content is not a verbatim substring of a real message; REMOVE ops are exempt (`:71`) and use weak `sharesTopic` (≥1 token >3 chars, `:77-82`). Stored content is the **160-char-truncated** request (`collectRecentUserRequests` in `compact.ts`) — long decisions silently clipped.
- Store bounds are real and tested at low env cap: `MEMORY_MAX_CHARS=4000` / `MEMORY_MAX_ROWS=500` (`sqlite.ts:723-724`), `capMemoryContent` (`:745-749`), `evictMemoryLru` by recency (`:757-780`). But no test proves the **review→persist** path stays bounded at the production default (only forced cap 10, `memoryOps.test.ts:80-113`).
- Cross-repo floor inconsistency (code-vs-docs): bare helper `recallMemoriesCrossRepo` defaults `crossRepoCosine` 0.30 (`memoryRecall.ts:104`, `recall.ts:206`), but the extension passes `config.crossRepoCosine` = **0.90** (`mega-config.ts:140`, `mega-events.ts:75/101`) — so the effective wired floor is 0.90; TESTER_GUIDE §9 documents 0.90. No test pins the wired value.
- Three correctness properties are UNPROVEN by tests: (a) no full write→recall→inline E2E; (b) `pendingMemoryRecallBlock` never asserted in a `systemPrompt` through the handler chain (`mega-compact.test.ts:346-361` covers only the checkpoint path); (c) `consolidateMemories` (`memory.ts:123-164`) has zero coverage.

### Cross-repo (two PGlite HNSW indexes) — `vectorIndex.ts`, `memoryIndex.ts`, `recall.ts`, `mega-events.ts`
- Two global indexes exist: checkpoint (`vector_index`, `vectorIndex.ts:46`, dir `MEGACOMPACT_VECTOR_INDEX_DIR`) and memory (`memory_index`, `memoryIndex.ts:51`, dir `MEGACOMPACT_INDEX_DIR/memory`); both keyed by `repo_id`, content stored inline for memory (`memoryIndex.ts:18`).
- Both paths are individually unit-tested but NO test drives them end-to-end across two real repos: `memoryRecall.test.ts:103` calls the recall fn directly (no `session_start` handler); `recall.test.ts` mocks `searchAsync`. Wiring: `doRecallAsync` (`mega-pipeline.ts:446`, `mega-events.ts:61`) for checkpoints; `recallMemoriesAndInline` (`mega-events.ts:72` → `recall.ts:186` → `recallMemoriesCrossRepo` `memoryRecall.ts:95`) for memory.
- Kill-switch + degradation proven: `MEGACOMPACT_PGLITE_DISABLED` honored by both `isVectorIndexDisabled`/`isMemoryIndexDisabled`; all init/write/search failures log-once + degrade (tested `memoryIndex.test.ts:17`, `memoryRecall.test.ts:134`); corruption self-heals via `retryOnCorrupt` delete+retry (`vectorIndex.ts:124`, `memoryIndex.ts:125`).
- **Latent repo_id scoping DIVERGENCE (must fix):** checkpoint index keys on `stateDir` (`vectorStore.ts:136` `this.repoId = opts.repoId ?? this.stateDir`); memory index keys on **git root** (`memoryOps.ts:48` `resolveRepoRootLocal(stateDir) ?? stateDir`); cross-repo hydration `getCheckpoint(..., h.repoId)` (`vectorStore.ts:538`) assumes repoId==stateDir. The two indexes use DIFFERENT keys today.
- Memory cross-repo has NO machine-wide injected-set marker (only content de-dup `memoryRecall.ts:114`), unlike checkpoints which have per-session `wasInjected` + machine-wide `injected_global` (`recall.ts:279,283`, `sqlite.ts:362`) — possible double-inject across a shared memory in 3+ repos (low impact).

---

## Scope decision
- RAPTOR spec (`s25-raptor-promote.md`): harden the already-live path — honor the shadow gate at serve time, add a `built_at` freshness guard, cache the rehydrated tree, add p95/breadth acceptance + monitoring. Mandatory = serve gate + freshness + cache; high-level summary injection is Phase-2 flag-gated (default off).
- Memory spec (`s25-memory-db-roundtrip.md`): **test + doc only by default**. No `src/` behavior change unless a bug is confirmed under the Risk Gate. Deliverables: headless E2E driver, full-round-trip test, bloat assertion, hallucination-guard + consolidate unit coverage, and a doc fix (not code change) for the cross-repo floor wording.
- Cross-repo spec (`s25-cross-repo.md`): add a `repoKey()` shared helper to unify checkpoint vs memory scope, a headless two-repo driver (`scripts/cross-repo-e2e.mjs`) proving Phase A (checkpoint-on-resume), B (memory augmentation), C (disabled + corrupt fallback), plus unit-test hardening to replace mocked `searchAsync`.

## Execution order
1. **Cross-repo first** — the `repoKey()` unification (EXECUTION §1) is a prerequisite so RAPTOR/memory scope reasoning is consistent; deliver `scripts/cross-repo-e2e.mjs` and the `repoKey.ts` helper.
2. **Memory round-trip** — add E2E driver + tests (no behavior change); emit the TESTER_GUIDE §9 doc fix for the cross-repo floor.
3. **RAPTOR promotion** — build-time `built_at` plumbing, serve gate, freshness guard, tree cache, then acceptance tests + `raptor_serve` monitoring hook.
4. Keep canary sequencing LAST: RAPTOR promotion is the final tier in `canary.ts` (L0→L1→L2→RAPTOR), auto-disable on p95 breach.

## Verify gate (every commit)
- `npm run build && npm test` (all tests green) + `npm run lint` + `python3 scripts/regression_check.py --all` + `node scripts/guardrails-scan.mjs`.
- RAPTOR: serve-gate tests (shadow disables, stale falls back, coverage breadth, p95 < 100ms) must pass.
- Memory: E2E proves `turn_end→write` and `session_start→before_agent_start` inline; bloat + hallucination + consolidate green.
- Cross-repo: `node scripts/cross-repo-e2e.mjs` passes Phases A/B/C with no throw; PREVENT-PI-004 stays green.
- NO network at runtime; guardrails-scan must report clean.

## Branch hygiene
- Branch: `feat/verify-s24` (off `master` @ `eb59e07`, v0.6.2). Do NOT commit to `master`.
- One focused commit per spec; AI-attribution required (`Co-Authored-By:`) — pre-commit hook enforces it.
- `git revert` is the rollback mechanism (each spec is independently revertable; RAPTOR also fully disables via `MEGACOMPACT_RAPTOR_ENABLED=false`; PGlite fully disables via `MEGACOMPACT_PGLITE_DISABLED=true`).
- NO FORCE PUSH; publish via `npm publish` + `pi update --extensions` only (PREVENT-DIST-001 — never a `.tgz`).
