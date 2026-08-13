# Sprint 8 — Storage Backbone: PGlite + Compression v2

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Local SQL store + revised compression
**Priority:** P0
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprints 0–7 (v0.1.0 shipped); SPRINT_PLAN.md Phases 2–7 decisions

---

## DEVIATIONS (resolved during sprint)

Two spec assumptions did not hold in reality; both resolved under the binding
"keep the store synchronous" constraint (VectorStore + engine.ts + recall.ts +
the extension are fully synchronous, so an async store would have forced a whole
call-chain to `async`).

1. **PGlite → better-sqlite3.** PGlite is **async-only in every published version**
   (verified 0.1.x → 0.5.4: no `./sync` export exists). Adopting it contradicts the
   spec's "signatures unchanged" acceptance criterion. Switched to `better-sqlite3`
   (in-process native, FS-backed, zero network — honors PREVENT-PI-004). FTS5
   `trigram` tokenizer is created in place of `pg_trgm` for the Sprint 9+ dedup tiers;
   `bloom`/`pgvector` are not needed for the current linear-cosine scan.

2. **zstd package.** `@aspect-build/zstd` does not exist on the registry. `@mongodb-js/zstd`
   (v7.0.0) is the maintained substitute, but it is **async-only** and no synchronous
   zstd binding builds in this environment (`node-zstd` needs a C compiler; `fzstd` is
   decompress-only). Therefore zstd is provided as an **opt-in async helper**
   (`compressZstd`/`decompressZstd` in `src/store/compression.ts`) for DR-export /
   large-blob paths, and is deliberately kept OUT of the synchronous `compressSmart`
   tier table. The synchronous large tier uses brotli-4 (sync, built-in).

The `0x03` tag-collision root cause IS fixed: `compressSmart` now prepends a 2-byte
version magic (`0xEC 0x01 [ver] [tag]`), so the new tier table is namespaced and can
never collide with the legacy brotli `0x03` payloads still on disk.

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all
  ```
- PREVENT-PI-004: pglite is in-process WASM + FS — NO remote DB, NO network. Confirm `grep -rE "fetch\(|https?://" src/` finds nothing new.
- PREVENT-002: all PGlite queries parameterized (`$1/$2`), never string-concatenated.
- No feature creep: only files in SCOPE below. Do not touch `src/compact.ts`, `src/adapt.ts`, `extensions/mega-compact.ts` runtime paths beyond the VectorStore adapter seam.

---

## PROBLEM STATEMENT

The shipped extension persists checkpoints to per-session gzipped JSON files
(`store.ts`). This is fine for ≤100 checkpoints but cannot support the Phase
3–6 dedup tiers (MinHash/LSH signatures, pg_trgm verification, pgvector cosine,
bloom accelerator) without a query layer. `PLAN.md` and the QA review resolved
to adopt a **local in-process Postgres** (`@electric-sql/pglite`) — verified to
ship `pgvector`, `pg_trgm`, `bloom` with Node-FS persistence and zero network
calls (honors PREVENT-PI-004).

Separately, `store.ts` shipped `0x03`=Brotli, but `PLAN.md` Phase 2A reassigns
`0x03`→zstd. Adding zstd without disambiguation corrupts existing files.

**Root cause to fix:** no queryable store; compression tag collision on `0x03`.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `package.json` — add `@electric-sql/pglite`, `@electric-sql/pglite/contrib/pg_trgm`, `@electric-sql/pglite/contrib/bloom`, `@aspect-build/zstd`.
- `src/store.ts` — format-version header in `compressSmart`/`decompressSmart`; new zstd/brotli tiers; `compressedOriginal` helper.
- `src/vectorStore.ts` — swap file I/O for PGlite; signatures unchanged (`add/search/dedupe/markInjected/wasInjected/list/stats`).
- `src/engine.ts` — pass PGlite-backed store (adapter seam).
- `src/recall.integration.test.ts` — re-prove cross-process recall over PGlite.
- New `src/store/pglite.ts` — PGlite init + `context_chunks` schema + migrate-from-JSON.
- `src/store/compression.ts` — versioned compress/decompress (extracted from store.ts).

**OUT OF SCOPE:**
- Dedup tiers (Sprints 9–12). Only the storage layer + base `content_hash` column (added here, populated in 9).
- RAPTOR (Sprint 13).
- Any change to `recall.ts` injection logic, `compact.ts` heuristics, `boundary.ts`, `supersede.ts`.

---

## EXECUTION DIRECTIONS

```
1. DEPS      add pglite + zstd to package.json; npm install
2. COMPRESS  src/store/compression.ts: prepend 0x01 legacy / 0x02 new tiers;
            0x00 raw, 0x01 gzip1, 0x02 gzip6, 0x03 zstd3, 0x04 zstd9, 0x05 brotli4
3. PGLITE    src/store/pglite.ts: init at STATE_DIR/pglite (Node FS);
            CREATE TABLE context_chunks (id TEXT PK, session_id TEXT,
            region_hash TEXT, content_hash TEXT, content_hash2 TEXT,
            content_hash_version INT, normalized_text TEXT, summary TEXT,
            topic_summary TEXT, key_decisions TEXT[], next_steps TEXT[],
            files_modified TEXT[], embedding real[], token_estimate INT,
            timestamp BIGINT, dedup_status TEXT DEFAULT 'active',
            compressed_original BYTEA)
4. MIGRATE   read existing <sess>.checkpoints.json.gz; INSERT into context_chunks
            (idempotent: skip if id exists); keep JSON as DR snapshot
5. ADAPT     VectorStore: replace listCheckpoints/readGzJson with pglite queries;
            keep public method signatures identical
6. TEST      recall.integration.test.ts: compact in one PGlite instance, recall
            via a FRESH instance over same STATE_DIR; assert checkpoint reappears
7. METRICS   store.getStats(): compressionRatio, storageBytes, checkpointCount
```

**Key details:**
- **Format version:** `compressSmart` writes `Buffer.from([VER, TAG, ...payload])`. `VER=0x01` for legacy brotli/old gzip; `VER=0x02` for new tier table. `decompressSmart` reads `VER` first; legacy files (no version byte / gzip magic) dispatched as before.
- **PGlite init:** `new PGlite({ dataDir: STATE_DIR/pglite })` (vendored FS). Open once per process (module-level singleton). Cross-process recall proven by re-opening the same `dataDir` in the test.
- **Migration idempotency:** `INSERT ... ON CONFLICT (id) DO NOTHING`. Compute `content_hash`/`content_hash2`/`normalized_text` here so Sprint 9's L0 tier has data to match.
- **Migrate tests use `MEGACOMPACT_STATE_DIR` override** (never real user state).

---

## ACCEPTANCE CRITERIA

- [x] `npm test` green; SQLite opens at `STATE_DIR/sqlite.db` (better-sqlite3, WAL).
- [x] All compression tiers roundtrip (raw/gzip1/gzip6/brotli4) via `compressSmart`/`decompressSmart`; zstd provided as async helper.
- [x] Existing legacy files (`0x03`=brotli, untagged gzip) still decompress (backward compat).
- [x] Migration of a v0.1.0 `<sess>.checkpoints.json.gz` is lossless: checkpoint count + `regionHash` set identical before/after; `content_hash` populated; JSON retained as DR snapshot (`src/store/migrate.test.ts`).
- [x] `src/store/migrate.test.ts` proves cross-process recall over SQLite (fresh instance, same `stateDir`) — mirrors Sprint 6.1.
- [x] `npm run lint` green (125/125 tests pass).
- [x] `guardrails-scan` clean: no new `fetch`/network in `src/`.

---

## ROLLBACK PROCEDURE

```bash
git revert f657ca0..<this-commit-sha>   # restores JSON-file store + legacy compression
# Data: existing context_chunks in STATE_DIR/pglite remains; JSON snapshots still valid.
# VectorStore file path is unchanged, so v0.1.0 behavior is fully restored.
```

If PGlite proves unusable mid-sprint: keep `src/store.ts` JSON file path intact
as the fallback; do not delete it. The migration is additive (JSON retained).
