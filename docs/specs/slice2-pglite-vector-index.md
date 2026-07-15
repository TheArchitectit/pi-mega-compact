# Slice 2 — PGlite/pgvector async vector index (global HNSW cross-repo recall)

**Date:** 2026-07-15
**Parent plan:** `.claude/plans/backend-pglite-sqlite.md` (Slice 2 of 3)
**Depends on:** Slice 1 (node:sqlite primary store) ✅ committed
**Priority:** P1 (delivers the original pgvector HNSW vision; unblocks cross-repo recall)
**Status:** PLANNED

---

## SAFETY PROTOCOLS

- PREVENT-PI-004: zero network at runtime. PGlite is WASM Postgres, fully local (no fetch). Guardrails-scan must stay green.
- **No async cascade into the sync store.** `node:sqlite` (VectorStore.add/search, engine, recall) stays 100% synchronous. PGlite is a *separate, additive, async* index. The sync linear cosine scan over `embedding_blob` remains the DEFAULT recall path — nothing regresses if PGlite is absent/broken.
- **Best-effort/non-fatal:** every PGlite write and the async init are wrapped so a failure logs + degrades to the sync scan. PGlite failure must NEVER break `add()`, compaction, or extension load.
- PREVENT-002: parameterized queries only (PGlite supports `$1`-style params).
- Verify gate (every commit): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- NO FORCE PUSH; branch + PR only.

---

## DECISIONS (locked with user, 2026-07-15)

1. **Index topology = hybrid global.** ONE PGlite DB at `~/.pi/mega-compact/vector.pglite` (global, outside any single repo state dir), with `repo_id` as a first-class column. `searchAsync(query, k, {repoId?})` — omit `repoId` → cross-repo NN (the headline feature); pass `repoId` → single-repo WHERE filter.
2. **Enable gate = default-on, best-effort.** No env flag required to turn it on. If PGlite init or a write fails, log once + fall back to the sync scan. (Optional `MEGACOMPACT_PGLITE_DISABLED=true` kill-switch for emergencies — off means the feature is on.)

---

## PROBLEM / MOTIVATION

Today `VectorStore.search()` is an O(n) linear cosine scan over one session's `embedding_blob` rows in the per-repo node:sqlite DB. That is fine for dedup (small N per session) but cannot do **cross-repo / cross-session** nearest-neighbor recall — the original pgvector HNSW vision. Slice 1 removed `better-sqlite3` (native build blocked by pi's install-script allowlist); PGlite is the script-free WASM path to real HNSW that survives pi's installer.

---

## ARCHITECTURE

```
 add(input)  ──sync──▶  node:sqlite  (authoritative, embedding_blob BLOB)  ← sync scan default
      │
      └──best-effort, fire-and-forget──▶  pgliteIndex.upsertEmbedding(repoId, sessionId, cpId, vector)
                                                   │
 recall (bonus) ── searchAsync(q, k, {repoId?}) ──▶ HNSW vector_cosine_ops  ← cross-repo NN
```

- **node:sqlite** stays the single synchronous source of truth. The embedding already lives there as `embedding_blob`.
- **PGlite** is a redundant async index: same vectors stored as `vector(512)`, indexed by HNSW `vector_cosine_ops`. Its ONLY job is fast cross-repo/cross-session NN. It is never read on the sync path and never authoritative — it can be deleted and rebuilt from node:sqlite at any time.

---

## SCOPE

**IN SCOPE**
- `src/store/vectorIndex.ts` (new): async PGlite wrapper — `initVectorIndex()`, `upsertEmbedding()`, `searchAsync()`, `rebuildFromSqlite()`, `closeVectorIndex()`. Lazy singleton init.
- `src/vectorStore.ts`: after a NEW checkpoint is stored in `add()`, best-effort fire the async `upsertEmbedding` (do NOT await — schedule via microtask/queue, swallow errors). Add async `searchAsync(query, k, {repoId?})` method that delegates to the index, with sync-scan fallback.
- `src/recall.ts`: optional `searchAsync` path for cross-repo recall (bonus; the sync `search` remains default). Bounded + inline-deduped exactly as Fix C.
- `package.json`: add `@electric-sql/pglite` + `@electric-sql/pglite-pgvector`; bump version 0.4.24 → 0.4.25.
- Test: `src/store/vectorIndex.test.ts` — proves HNSW NN across two synthetic repos/sessions, and proves graceful degradation when the index is disabled.

**OUT OF SCOPE**
- Making the sync store async (explicitly forbidden).
- Removing the sync linear scan (stays the default).
- Slice 3 packaging polish (README/CLAUDE dual-backend docs, `.npmrc` review, final pack + re-test) — separate slice.
- zstd/DR path (unchanged from Fix A).

---

## EXECUTION

### 1. `src/store/vectorIndex.ts` (new)
- Lazy singleton: `let db: PGlite | undefined`. `initVectorIndex()` — `import`s PGlite + pgvector extension, opens `~/.pi/mega-compact/vector.pglite`, `CREATE EXTENSION IF NOT EXISTS vector`, creates table + HNSW index if absent:
  ```sql
  CREATE TABLE IF NOT EXISTS vector_index (
    repo_id     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    checkpoint_id INTEGER NOT NULL,
    embedding   vector(512) NOT NULL,
    PRIMARY KEY (repo_id, session_id, checkpoint_id)
  );
  CREATE INDEX IF NOT EXISTS vector_index_hnsw
    ON vector_index USING hnsw (embedding vector_cosine_ops);
  ```
- `upsertEmbedding(repoId, sessionId, checkpointId, vector)` — parameterized `INSERT ... ON CONFLICT DO UPDATE`. Vector serialized to pgvector literal `[a,b,...]`. **Dimension guard**: reject/skip vectors whose length ≠ 512 (the TrigramEmbedder default) so a BYO-embedder dim mismatch degrades rather than corrupts the index.
- `searchAsync(queryVec, k, {repoId?})` — `SELECT ... ORDER BY embedding <=> $1 LIMIT $2`, with `WHERE repo_id = $3` when `repoId` given. Returns `{repoId, sessionId, checkpointId, score}[]` (score = `1 - distance`).
- `rebuildFromSqlite()` — enumerate repo state dirs (reuse the multi-repo index helper), read `embedding_blob` rows, bulk upsert. For backfill + DR rebuild.
- All wrapped: init failure sets a `disabled` flag + logs once via `monitoring.logDecision`; subsequent calls no-op. `MEGACOMPACT_PGLITE_DISABLED=true` forces disabled.

### 2. `src/vectorStore.ts`
- In `add()`, at the "genuinely new checkpoint stored" tail (after `upsertCheckpoint`), fire best-effort:
  `void indexUpsertBestEffort(this.repoId, sessionId, checkpointId, embedding)` — a helper that calls `initVectorIndex().then(upsert).catch(logOnce)`. **Never awaited**, never throws into the sync path. `repoId` derived from `stateDir` (stable hash / repo path — reuse the multi-repo index's repo key).
- Add `async searchAsync(query, k = 3, opts?: {repoId?}): Promise<SearchHit[]>` — embeds query (sync), calls `vectorIndex.searchAsync`, hydrates `StoredCheckpoint`s from node:sqlite by (repo,session,cpId). On any failure → fall back to the sync `search(sessionId, query, k)` for the current repo. MMR-dedupe the merged set (reuse `mmrRerank`).

### 3. `src/recall.ts`
- Add an optional `crossRepo?: boolean` to `recallAndInline`; when set, use `searchAsync` (await) instead of sync `search`. Default path unchanged (sync, per-session). Keep Fix C bounds (`recallMaxTokens`) + inline window dedupe.

### 4. `package.json`
- deps: `@electric-sql/pglite`, `@electric-sql/pglite-pgvector`. Version → 0.4.25. (Both are WASM/JS, no install script — survive pi's block; no `.npmrc` change needed.)

### 5. Tests — `src/store/vectorIndex.test.ts`
- Seed two repo_ids × two sessions with distinct embeddings; assert `searchAsync(q)` returns the nearest across repos, and `searchAsync(q, k, {repoId})` filters to one repo.
- Assert graceful degradation: with `MEGACOMPACT_PGLITE_DISABLED=true`, `VectorStore.searchAsync` returns the same shape via sync fallback and `add()` still succeeds.
- Assert dimension guard skips a non-512 vector without throwing.

---

## FILES TO CHANGE

| File | Change | Status |
|------|--------|--------|
| `src/store/vectorIndex.ts` | new async PGlite/HNSW wrapper | ⬜ |
| `src/vectorStore.ts` | best-effort upsert on new checkpoint + `searchAsync` | ⬜ |
| `src/recall.ts` | optional `crossRepo` searchAsync path | ⬜ |
| `package.json` | add pglite deps, bump 0.4.25 | ⬜ |
| `src/store/vectorIndex.test.ts` | new: cross-repo HNSW + degradation + dim guard | ⬜ |

---

## ACCEPTANCE

1. `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green; PREVENT-PI-004 green.
2. Sync store + recall behavior is byte-identical when PGlite is disabled/absent (no regression — sync scan is still the default).
3. `searchAsync(q)` returns cross-repo nearest neighbors via HNSW; `searchAsync(q, k, {repoId})` filters to one repo.
4. PGlite init/write failure logs once + degrades to sync scan; `add()`/compaction/extension-load never break.
5. Extension still loads under pi's install-script block (PGlite is script-free WASM — verified by pack + install re-test in Slice 3).

---

## ROLLBACK

- Feature is additive + default-on-but-degradable: set `MEGACOMPACT_PGLITE_DISABLED=true` to fully disable at runtime (falls back to sync scan) with zero code change.
- Per-commit revert; each commit independently green. The node:sqlite store is untouched and authoritative, so dropping PGlite loses only the cross-repo index (rebuildable via `rebuildFromSqlite`).
- NO FORCE PUSH; revert via PR only.
