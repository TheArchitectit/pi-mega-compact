# Plan: dual-backend storage — node:sqlite primary + PGlite/pgvector index

> Date: 2026-07-14. Scope: pi-mega-compact. Fixes the pi `install-scripts`-blocked
> native-addon crash AND delivers real pgvector HNSW indexing (the original vision).

## Root cause (verified by running it)
pi's npm installer runs with the `install-scripts` allowlist **blocking every
third-party install script**. `better-sqlite3`'s only install job is
`prebuild-install || node-gyp rebuild`; that script is blocked, so the `.node`
binary is never built → `Failed to load extension: Could not locate the
bindings file`. Hits **everyone** on a fresh `pi update --extensions`.
`.npmrc`/`postinstall` (the Fix A attempt) target a different gate
(`ignore-scripts`), so they don't help.

## Decision: Option B, two script-free backends
1. **`node:sqlite` (Node built-in, `DatabaseSync`)** — the ONE primary store.
   No dependency, no native build, no install script → survives pi's block.
   Verified: FTS5 `trigram` tokenizer, BLOB binding, `prepare/get/all/run`,
   `lastInsertRowid`/`changes` all work; it is a **release candidate** (no
   `--experimental-sqlite` flag needed on Node ≥ 22.13).
2. **PGlite + `@electric-sql/pglite-pgvector`** — WASM Postgres, no native
   build, no install script → also survives pi's block. Verified: `vector(n)`
   type, **HNSW** `vector_cosine_ops`, cosine NN (`<=>`), `pg_trgm` similarity,
   all local (no runtime network → PREVENT-PI-004 OK). `pglite-pgvector@0.0.5`
   is a SEPARATE package (`@electric-sql/pglite` core does NOT bundle it).

## Architecture
- **`node:sqlite` = the synchronously-authoritative store.** Everything the
  current `src/store/sqlite.ts` holds: checkpoints (metadata, content/region
  hashes, FTS5 trigram dedup, `compressed_original`), `session_state`,
  `memories`, `file_context`, `raptor_nodes`, the multi-repo index. The whole
  sync chain (engine/recall/extension) stays **synchronous** — no async cascade.
- **PGlite/pgvector = the async vector index.** Checkpoint embeddings are ALSO
  stored as `vector(n)` in a PGlite table (besides the BLOB in node:sqlite for
  sync fallback). Provides real HNSW cosine for **cross-repo / cross-session**
  recall — the capability the old per-session linear scan lacks. Exposed as an
  async `searchAsync` path; the sync linear scan over `embedding_blob` remains
  the default so nothing regresses. PGlite writes are best-effort/non-fatal.
- **`@mongodb-js/zstd`** stays (DR-export, async-only). Its install script is
  still blocked under pi, so DR export degrades gracefully to a clear error
  (unchanged from Fix A). At a full install with scripts allowed, it builds.

## Migration slices
- **Slice 1 — `node:sqlite` primary store (fixes the crash). ✅ DONE**
  Port `src/store/sqlite.ts` from `better-sqlite3` to `node:sqlite`. Applied:
  `new Database` → `new DatabaseSync`; `db.pragma("X")` → `db.exec("PRAGMA X")`;
  `db.transaction(fn)` (4 sites) → `withTx()` SAVEPOINT helper (nests safely —
  fixes "cannot start a transaction within a transaction" that a bare BEGIN
  hit when backfill wrapped an inner tx); BLOB `Uint8Array` → normalized to
  `Buffer` at the `rowToCheckpoint` read boundary so decompress/toString
  round-trips as before; `@`-prefixed named params verified. Removed
  `better-sqlite3` + `@types/better-sqlite3`; bumped `@types/node` to 22.20.1
  and `engines.node` → `>=22.13`; postinstall now only best-effort rebuilds
  zstd. Dashboard + backfill ported to `DatabaseSync`.
  **Gate: 301 tests + tsc + guardrails-scan + regression all green.**
  Packed `pi-mega-compact-0.4.23.tgz` for user uninstall/re-test.
  → Next: user uninstalls old ext + `pi update --extensions`; verify no crash.
- **Slice 2 — PGlite/pgvector index. ✅ DONE (v0.4.25)**
  Added `@electric-sql/pglite@^0.5.4` + `@electric-sql/pglite-pgvector@^0.0.5`
  (peer-aligned; pgvector 0.0.5 requires pglite 0.5.x). New
  `src/store/vectorIndex.ts`: lazy singleton `initVectorIndex()`,
  `upsertEmbedding()` (dim-guarded to 512), `searchAsync({repoId?})` via HNSW
  `vector_cosine_ops`, `rebuildFromSqlite()`, `closeVectorIndex()`. Topology =
  **hybrid global**: ONE PGlite DB at `~/.pi/mega-compact-vector` with `repo_id`
  first-class → cross-repo NN by default, `repoId` filter for single-repo. The
  pgvector extension is passed at init (`extensions: { vector }`) + file-backed
  dataDir (not `:memory:`); vector params are cast `$n::vector`.
  `vectorStore.add()` fires a best-effort **fire-and-forget** `upsertEmbedding`
  on each NEW checkpoint (never awaited, never throws into the sync path);
  `vectorStore.searchAsync()` hydrates hits from the authoritative node:sqlite
  store (a hit's repoId doubles as that repo's stateDir) and falls back to the
  sync per-session scan on empty/failure. `recall.ts` gains async
  `recallAndInlineAsync({crossRepo})`; the sync `recallAndInline` is unchanged
  and remains the default. Added `getCheckpoint()` to `store/sqlite.ts` for
  hydration. **Default-on, best-effort**: `MEGACOMPACT_PGLITE_DISABLED=true`
  kill-switch; any init/write failure logs once + degrades to the sync scan.
  Kept `@mongodb-js/zstd` (DR path) — pglite is WASM/JS, no install script, so
  it survives pi's `install-scripts` block (PREVENT-PI-004 OK, WASM is local).
  **Gate: build + lint + guardrails-scan + regression green; new
  `vectorIndex.test.ts` (cross-repo HNSW, repoId scope, dim guard, kill-switch)
  green.** Packed `pi-mega-compact-0.4.25.tgz` for user re-test.
  → Next: user re-tests install under pi; Slice 3 packaging polish.
- **Slice 3 — packaging.** `package.json`: remove `better-sqlite3`, add
  `pglite`/`pglite-pgvector`; bump `engines.node` to `>=22.13`; bump version
  (→ 0.4.23); revise `.npmrc` (node:sqlite/pglite need no scripts; keep
  postinstall only as a best-effort rebuild of zstd). Update README/CLAUDE to
  reflect the dual backend. Pack + full re-test.

## Risks / HALT
- **engines bump** (18 → 22.13) is breaking for Node < 22.13 users. Accept per
  decision; document clearly. node:sqlite unflagged on 22.13+/23.4+/25.7+.
- **`node:sqlite` is stability 1.2 (RC)** — API may shift slightly; pin Node
  and re-test on bump.
- **BLOB type**: node:sqlite yields `Uint8Array`; ensure every decode/compare
  path handles both `Buffer` and `Uint8Array` (trigram embedder etc.).
- **PREVENT-PI-004**: PGlite WASM is local — no fetch. Guardrails-scan green.
- **PREVENT-002**: keep parameterized queries (node:sqlite supports `?` and
  `$name`; verify existing `$1`/`$2` calls still bind).
- **No async cascade into the sync store** — node:sqlite stays sync; only the
  PGlite vector index is async, best-effort.
- Verify FTS5 `trigram` behavior under `node:sqlite` is byte-identical to
  better-sqlite3 (dedup tiers depend on it).

## Out of scope
- Keeping `better-sqlite3`. Removing it is the point.
- Self-building pgvector WASM (we use the published `@electric-sql/pglite-pgvector`).
