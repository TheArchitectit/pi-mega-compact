# Project Guidelines — pi-mega-compact

## 0. Navigation Maps (READ FIRST)

* **docs/INDEX_MAP.md**: Read this FIRST to find documents by keyword/category.
* **docs/HEADER_MAP.md**: Find specific sections with file:line references for targeted reading.
* **docs/AGENT_GUARDRAILS.md**: MANDATORY safety protocols — read before any code change.

---

## 1. Context & Setup

* **Stack**: TypeScript, Node >= 18, ESM (`"type": "module"`). Ships as a pi coding-agent extension (no remote MCP server).
* **Detector**: `package.json` (`pi.extensions`, `engines.node`), `tsconfig.json`. Do NOT read `package-lock.json` blindly.
* **Guardrails**: Read [docs/AGENT_GUARDRAILS.md](docs/AGENT_GUARDRAILS.md) before any code change. The Four Laws (Read First / Stay in Scope / Verify Before Commit / Halt When Uncertain) are NON-NEGOTIABLE.

---

## 2. Token-Saving Rules (STRICT)

* **NO EXPLORATION**: do not `ls -R` the whole tree; use the maps.
* **NO RE-READING**: trust your context; do not re-read files you just edited.
* **TARGETED CONTEXT**: read ONLY files relevant to the request.
* **CONCISE PLANS**: bullet points only.
* **USE MAPS**: check `docs/INDEX_MAP.md` before reading full documents.

---

## 3. Workflow

* **Tests**: run ONLY relevant tests (`npm test` runs `node --test` on `dist/**/*.test.js` — build first).
* **Edits**: prefer small, single-file edits in `src/`; keep `src/` pi-agnostic (no pi runtime types).
* **Commits**: one focused commit per task; AI-attribution required (pre-commit hook enforces `Co-Authored-By:`).
* **Guardrails gate**: every change must pass `npm run lint` + `python3 scripts/regression_check.py --all`.

---

## 4. Hard Project Constraints (PREVENT-PI)

These are pi-extension invariants; `scripts/guardrails-scan.mjs` scans for violations:

| Rule | Severity | Meaning |
|------|----------|---------|
| PREVENT-PI-001 | error | Never drop messages without the anchor-floor guard (preserve recent N). |
| PREVENT-PI-002 | error | Never split a toolCall/toolResult pair at a compaction boundary. |
| PREVENT-PI-003 | error | Never inject compacted context as `role:"system"` — use the `before_agent_start` systemPrompt prepend. |
| PREVENT-PI-004 | critical | **Zero network calls at runtime.** Extension is fully local (better-sqlite3 = in-process native SQLite, FS persistence). No `fetch`/HTTP to remote. EXCEPTION: the optional, user-triggered `/dashboard` localhost server — audited via `// guardrails-allow PREVENT-PI-004: <reason>` inline annotations (scanner enforces a reason). |

Additional guardrails (from template): PREVENT-001 (JSON.parse without null check), PREVENT-002 (SQL string concat — use parameterized queries), PREVENT-011 (`any` type), PREVENT-024 (hallucinated package import), PREVENT-003 (hardcoded credentials).

* **DISTRIBUTION — npm is the ONLY valid path (PREVENT-DIST-001, error).** The extension is distributed and updated **exclusively via `npm publish` + `pi install npm:pi-mega-compact` / `pi update --extensions`**. **NEVER produce or rely on a `.tgz` tarball** (`npm pack`) for testing or shipping — tarballs bypass pi's package manager and do not propagate to other devices. **Symlinks** into `~/.pi/agent/extensions/` are **dev-only** and likewise bypass the update path. To validate a real install, bump `version`, `npm publish`, then `pi update --extensions` on the device. (See memory `pi-npm-workflow`.)

---

## 5. Architecture at a Glance

* **Layers** (Trident stack): L1 supersede → L2 collapse → L3 cluster/vectorize → L4 persist → L5 recall/inline.
* **One store**: `node:sqlite` (`DatabaseSync`, Node built-in ≥22.13) is the **synchronous source of truth** from v0.4.23 (Slice 1) — replacing the `better-sqlite3` native addon that pi's install-script block prevented from building. FTS5 `trigram` tokenizer backs the pg_trgm-equivalent dedup tiers; cosine stays a **linear scan over `embedding_blob`** (small N) as the DEFAULT recall path. Legacy gzipped JSON checkpoint files are retained as DR snapshots.
* **Async vector index (Slice 2, v0.4.25)**: `PGlite` + `@electric-sql/pglite-pgvector` (WASM Postgres, script-free → survives pi's install block, PREVENT-PI-004 OK) is a **redundant, additive, ASYNC** HNSW `vector_cosine_ops` index at `~/.pi/mega-compact-vector`. Global topology with `repo_id` first-class → cross-repo NN by default; `repoId` filters to one repo. The sync node:sqlite store remains authoritative; the index is best-effort/non-fatal and degrades to the sync scan (`MEGACOMPACT_PGLITE_DISABLED`). See `docs/specs/slice2-pglite-vector-index.md`.
* **Embedder**: `TrigramEmbedder` default (self-contained, 512-dim, L2-normalized). BYO localhost embedder via `MEGACOMPACT_EMBEDDING_URL` (loopback-only, `src/httpEmbedder.ts`). MiniLM (`MEGACOMPACT_MINILM`) flag exists but is **off; not shipped** (async-vs-sync conflict).
* **Key source files**: `src/store.ts` (state dir + JSON DR helpers + compression re-exports), `src/store/compression.ts` (versioned compressSmart/decompressSmart + async zstd helper), `src/store/sqlite.ts` (SQLite context_chunks + session_state, FTS5 trigram), `src/store/migrate.ts` (JSON→SQLite migration), `src/vectorStore.ts` (VectorStore add/search/dedupe), `src/engine.ts` (compactSession), `src/recall.ts` (recallAndInline), `src/embedder.ts`, `src/compact.ts`, `src/extractive.ts`, `src/supersede.ts`, `src/boundary.ts`, `src/types.ts`, `src/config.ts`, `src/adapt.ts`, `src/log.ts`.
* **Extension entry**: `extensions/mega-compact.ts` (pi runtime adapter). Dashboard server: `extensions/dashboard-server.ts`. Error patterns: `extensions/error-patterns.ts`.
* **Dedup tiers**: L0 exact-hash (`src/dedup/digest.ts`, `src/store/bloom.ts`), L1 MinHash/LSH (`src/dedup/l1-minhash.ts`, `src/dedup/l1-lsh.ts`, `src/dedup/l1-verify.ts`), L2 semantic cosine + MMR (`src/dedup/mmr.ts`), RAPTOR tree (`src/dedup/raptor/`). Config: `src/config/dedup.ts` (single source of truth for all tier flags).
* **Monitoring**: `src/monitoring.ts` (events.log + dashboard.json + FP alerts), `src/canary.ts` (sequential tier rollout + auto-disable on p95 breach).
* **Scripts**: `scripts/dedup-benchmark.mjs` (benchmark), `scripts/dedup-restore-drill.sh` (DR drill), `scripts/guardrails-scan.mjs` (guardrails), `scripts/regression_check.py` (regression).
* **Test count**: 372 tests (unit + integration + handler-level), all passing as of v0.7.3.

---

## 6. Documentation Standards

* **Doc length guideline**: ~500 lines is a soft target for readability. Split with `docs/` subfiles when a doc gets unwieldy, but don't sacrifice completeness to fit.
* **Update Maps**: update `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` when adding/changing docs.
* **Sprints**: per-sprint full specs live in `docs/specs/` following the SPRINT_GUIDE structure (Header / Safety / Problem / Scope / Execution / Acceptance / Rollback).
* **Tester guide**: see `TESTER_GUIDE.md` (repo root) for manual testing checklist + bug report template.
* **Release notes**: see `RELEASE_NOTES.md` (repo root) for user-facing release notes + migration guide.
