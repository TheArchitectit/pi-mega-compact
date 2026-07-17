# Work Status — pi-mega-compact (as of v0.6.6 → v0.6.7)

> Living snapshot of what is SHIPPED vs IN-PROGRESS vs PLANNED across the
> PGlite/pgvector, RAPTOR, cross-repo, and memory-RAG work streams.

---

## 1. SHIPPED (live in npm, through v0.6.6)

### PGlite / pgvector — ✅ COMPLETE
| Milestone | Version | What |
|-----------|---------|------|
| Slice 1: node:sqlite sync store | v0.4.23 | `DatabaseSync` replaces better-sqlite3; in-process, no install-script block. FTS5 trigram tokenizer. |
| Slice 2: PGlite + pgvector HNSW | v0.4.25 | WASM Postgres + `vector_cosine_ops` at `~/.pi/mega-compact-vector`. Global topology, `repo_id` first-class. `searchAsync(query,k,{repoId?})` — cross-repo NN by default, `repoId` filters to one repo. Sync store stays authoritative; index is best-effort. |
| PGlite lazy-import fix | v0.6.3 | Static top-level `import` → lazy `loadPgLite()`. Missing package degrades to sync scan instead of crashing extension load. |
| Cross-repo recall wire-up (S17–S18) | v0.5.0 | `recallAndInlineAsync`, `/mega-recall --cross-repo`, machine-wide injected-set dedup markers, source labels. `mega-events.ts:61` calls `doRecallAsync({crossRepo})` on resume. |
| Cross-repo memory index (S24) | v0.6.2 | `src/store/memoryIndex.ts` — `searchMemoriesAsync`, `upsertMemoryEmbedding`. Memory-RAG auto-review (`src/memory.ts`), recall (`memoryRecall.ts`), consolidate (`memoryConsolidate.ts`). |
| Cross-repo benchmark | v0.5.0 | `scripts/crossrepo-benchmark.mjs` — p95 < 50ms target, foreign-checkpoint-in-top-K proof. |

### RAPTOR — ⚠️ PROMOTED BUT UNHARDENED (code shipped, S25 hardening in-progress)
| Milestone | Version | What |
|-----------|---------|------|
| Shadow build (S13) | v0.4.x | `src/dedup/raptor/*` — kmeans++, extractive+Ollama summarizer, 4-layer guardrails, staged expansion. `raptor_nodes` table. Shadow-only (built + logged, not served). |
| Live promotion (Fix D) | v0.6.0 | `raptorSearchHits` in `vectorStore.ts:559` merges tree hits into `search()`. `RAPTOR_ENABLED=true`. Tree rebuilt at compaction (`mega-pipeline.ts:232`). Root summary feeds durable trim. |
| **S25 hardening** | **v0.6.7 (in-progress)** | Shadow SERVE gate, freshness guard, `timedOut` guard, `raptor_serve` event — **code done, uncommitted**. Acceptance tests **not written**. |

### Compaction, memory, dashboard — ✅ COMPLETE
- S16 compaction continuity (live trim + native durable), S20–S21 memory-RAG, S19 multi-repo dashboard, S22 docs, S23 benchmarks/DR — all shipped v0.5.0.
- S24 unified pressure signal — v0.6.2. Dashboard overhaul, Savings-by-Model — v0.4–v0.6.5.
- Toolbar widget — v0.6.5/v0.6.6 (retro gradient bars).

---

## 2. IN-PROGRESS (uncommitted working tree → v0.6.7)

### 2a. 🔴 LIVE CRASH FIX (highest priority — pi is crashing every compaction)
**Root cause:** pi tool/custom messages arrive with `text: undefined` (only `input`/`output` set). `extractFilePaths` called `text.matchAll` → `Cannot read properties of undefined`.

| File | Fix | Status |
|------|-----|--------|
| `src/adapt.ts` | **Choke-point fix** — `contentText` adds `Array.isArray` guard; `messageText` adds `?? ""` final coercion + `default: ""`. Every downstream file (extractive, compact, supersede, summarizer, boundary) safe in one shot. | ✅ done |
| `src/extractive.ts` | **Defense-in-depth** — `extractiveSummarize` entry: `const safe = messages.map((m) => ({ ...m, text: m.text ?? "" }))`. | ✅ done |
| `src/extractive.test.ts` | Crash regression test: messages with `undefined` text no longer throw. | ✅ done |
| **Publish v0.6.7** | `npm publish` → `pi update --extensions` stops the crash. | ⬜ PENDING |

### 2b. S25 RAPTOR Promotion — hardening the live path
**Spec:** `docs/specs/s25-raptor-promote.md`

| Step | Status |
|------|--------|
| 1. `built_at` column in `raptor_nodes` + `ensureColumn` migration + `StoredRaptorNode.builtAt` + `saveRaptorTree(...,builtAt,...)` | ✅ code done |
| 2. `RaptorTree.builtAt`; `rehydrateRaptorTree` returns `builtAt` (max node) + `timedOut` (root level ≥ 99) | ✅ code done |
| 3. `raptorSearchHits`: shadow SERVE gate (`isShadowMode()→[]`), freshness guard (`builtAt < maxCheckpointTimestamp→[]`), `timedOut→[]`, `raptor_serve` event via `this.record("RAPTOR",...)` | ✅ code done (no in-mem cache — uses SQL `maxCheckpointTimestamp` per your "all data in SQL" rule) |
| 4. `formatRaptorBlock` / `RAPTOR_INJECT_SUMMARIES` high-level summary injection | ⏸ SKIPPED (optional, Phase-2, flag-gated default OFF) |
| 5. `raptor_serve` monitoring event | ✅ code done |
| 6. pipeline `builtAt = max(all.map(c=>c.timestamp))` | ✅ code done (mega-pipeline.ts + backfill.ts) |
| 7. `serve-gate.test.ts` acceptance tests | ❌ **NOT WRITTEN** (→ v0.6.8) |

### 2c. Widget redesign (uncommitted)
- L1 widened: 20-cell context-fill bar (green=room→red=full) + tokens + status glyph + checkpoints.
- L2: saturated savings bars replaced with explanatory `in→kept (X% freed)` framing (the `freed/(freed+kept)` ratio pegs ~100% once cumulative freed dwarfs live kept — 4.8mil freed vs 612 kept — so a bar carries no info).
- L4 accounting line removed (folded into L2).

---

## 3. TODO (planned, not started)

### 3a. S25 RAPTOR acceptance tests — `serve-gate.test.ts` (v0.6.8)
From `docs/specs/s25-raptor-promote.md` ACCEPTANCE:
- [ ] `RAPTOR_SHADOW_MODE=false` disables serving in `VectorStore.search`
- [ ] Stale tree (built before new checkpoint) falls back to flat, no stale merge
- [ ] `raptorSearchHits` returns `[]` when only tree is a `timedOut` extractive root
- [ ] Coverage breadth: 2-cluster fixture, RAPTOR spans both topics where flat misses one
- [ ] p95 latency: 200-checkpoint fixture, median `search` < 100ms with RAPTOR
- [ ] `raptor_serve` event recorded to events.log when `eventsPath` set

### 3b. S25 RAPTOR summary injection (Phase-2, optional)
- [ ] `formatRaptorBlock` in `recall.ts`
- [ ] `RAPTOR_INJECT_SUMMARIES` config flag (default false)
- [ ] Wire into `recallAndInline` only when flag set

### 3c. S25 Cross-repo E2E — `docs/specs/s25-cross-repo.md` (ALL ⬜)
The headline "start in repo B, recall repo A" capability has no automated two-repo proof.
- [ ] `src/store/repoKey.ts` — shared `repoKey()` + `stateDirForRepo()`
- [ ] `src/vectorStore.ts` — repoId = `repoKey(stateDir)`; hydrate via `stateDirForRepo`
- [ ] `src/memoryOps.ts` — use `repoKey()` instead of local `resolveRepoRootLocal`
- [ ] `extensions/mega-conflict-cmds.ts` — assert `repo == repoKey(stateDir)`
- [ ] `scripts/cross-repo-e2e.mjs` — headless two-repo driver (A/B/C phases)
- [ ] `src/store/vectorIndex.test.ts` — corrupt-self-heal + dim-guard tests
- [ ] `src/recall.test.ts` — replace mock `searchAsync` with real two-repo HNSW
- [ ] `src/memoryRecall.test.ts` — content de-dup in cross-repo path
- [ ] `TESTER_GUIDE.md` + map updates

### 3d. S25 Durable-Memory DB Round-Trip — `docs/specs/s25-memory-db-roundtrip.md` (PLANNED, all ⬜)
Test + doc only by default; any `src/` edit requires a confirmed bug.
- [ ] `extensions/mega-memory-roundtrip.test.ts` — headless E2E driver (turn_end→write, session_start→inline)
- [ ] `src/memory.test.ts` — hallucination guard + `consolidateMemories` unit coverage
- [ ] `src/memoryRoundtrip.test.ts` — full src-level write→recall→inline
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`
- [ ] Cross-repo floor: wired value pinned; docs and code agree
- [ ] `TESTER_GUIDE.md` §10 + map updates

---

## 4. Release plan
1. **v0.6.7 (NOW)** — crash fix + widget redesign + S25 RAPTOR code (steps 1–3,5–6). 367 tests green. Stops the live crash.
2. **v0.6.8 (next)** — `serve-gate.test.ts` S25 acceptance tests.
3. **v0.6.9+** — S25 cross-repo E2E (3c) + memory DB round-trip (3d).
4. **Phase-2 (future)** — RAPTOR summary injection (3b).
