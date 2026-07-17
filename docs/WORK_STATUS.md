# Work Status — pi-mega-compact (as of v0.7.3)

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
| S25 hardening | v0.7.0 | Shadow SERVE gate, freshness guard, `timedOut` guard, `raptor_serve` event. All acceptance tests passing. |

### Compaction, memory, dashboard — ✅ COMPLETE

- S16 compaction continuity (live trim + native durable), S20–S21 memory-RAG, S19 multi-repo dashboard, S22 docs, S23 benchmarks/DR — all shipped v0.5.0.
- S24 unified pressure signal — v0.6.2. Dashboard overhaul, Savings-by-Model — v0.4–v0.6.5.
- Toolbar widget — v0.6.5/v0.6.6 (retro gradient bars).

---

## 2. IN-PROGRESS

*(None — all work streams complete through v0.7.3)*

---

## 3. TODO (planned, not started)

### 3a. S25 Cross-repo E2E — `docs/specs/s25-cross-repo.md` (ALL ⬜)

The headline "start in repo B, recall repo A” capability has no automated two-repo proof.

- [ ] `src/store/repoKey.ts` — shared `repoKey()` + `stateDirForRepo()`
- [ ] `src/vectorStore.ts` — repoId = `repoKey(stateDir)`; hydrate via `stateDirForRepo`
- [ ] `src/memoryOps.ts` — use `repoKey()` instead of local `resolveRepoRootLocal`
- [ ] `extensions/mega-conflict-cmds.ts` — assert `repo == repoKey(stateDir)`
- [ ] `scripts/cross-repo-e2e.mjs` — headless two-repo driver (A/B/C phases)
- [ ] `src/store/vectorIndex.test.ts` — corrupt-self-heal + dim-guard tests
- [ ] `src/recall.test.ts` — replace mock `searchAsync` with real two-repo HNSW
- [ ] `src/memoryRecall.test.ts` — content de-dup in cross-repo path
- [ ] `TESTER_GUIDE.md` + map updates

### 3b. S25 Durable-Memory DB Round-Trip — `docs/specs/s25-memory-db-roundtrip.md` (PLANNED, all ⬜)

Test + doc only by default; any `src/` edit requires a confirmed bug.

- [ ] `extensions/mega-memory-roundtrip.test.ts` — headless E2E driver (turn_end→write, session_start→inline)
- [ ] `src/memory.test.ts` — hallucination guard + `consolidateMemories` unit coverage
- [ ] `src/memoryRoundtrip.test.ts` — full src-level write→recall→inline
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`
- [ ] Cross-repo floor: wired value pinned; docs and code agree
- [ ] `TESTER_GUIDE.md` §10 + map updates

---

## 4. Release plan

- **v0.7.3 (current)** — widget wrap layout, S25 RAPTOR complete, S27 widget complete.
- **v0.7.4+** — S25 cross-repo E2E (3a) + memory DB round-trip (3b).
