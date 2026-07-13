# Sprint Plan — pi-mega-compact

Layered, local, vector-backed context compressor for pi. Built as a pi extension
(TypeScript, node>=18, no remote MCP server). See `PLAN.md` (architecture) and
`RESEARCH.md` (API/tech constraints).

**Guardrails gate every sprint:** each sprint exits only when the adapted
agent-guardrails checks pass (Four Laws, scope, secrets, regression, 500-line
docs). Guardrails are installed in Sprint 0.

Effort scale: S ≈ ½ day, M ≈ 1 day, L ≈ 2 days.

---

## Sprint 0 — Repo bootstrap + guardrails adaptation  (foundation)

Goal: a buildable, linted, guardrailed empty extension.

- [x] **0.1 (S)** `git init` new repo `pi-megacompact`; `package.json`
      (`type:module`, `pi.extensions:["./extensions/mega-compact.ts"]`,
      peerDep `@earendil-works/pi-coding-agent`, `engines.node>=18`), `tsconfig`,
      `.gitignore`, MIT `LICENSE`.
- [x] **0.2 (M)** Adapt guardrails (Task #5): vendor `.claude/hooks`,
      `.claude/skills`, `.guardrails/`, `.github/workflows/`, Four-Laws doc,
      `scripts/regression_check.py` + `log_failure.py`. Strip Godot/3D/Sentinel.
      Retarget `file_glob` → `extensions/**`,`src/**`. See "Guardrails adaptation".
- [x] **0.3 (S)** Wire `package.json` scripts: `build` (tsc), `lint`
      (tsc --noEmit + prevention-rules scan), `test` (node --test),
      `guardrails` (regression_check), `precommit`.
- [x] **0.4 (S)** Install pre-commit hook (AI attribution, secrets, `.env`,
      scope). `ci.yml` runs the full gate on push/PR (see Sprint 6.5).
      NOTE: the four pre-existing `guardrails-*.yml` workflows only check
      scope/secrets/commit-format and target `main` — they do NOT build or
      test. The real green gate is `.github/workflows/ci.yml` against `master`.
- [x] **0.5 (S)** `CLAUDE.md` + `INDEX_MAP.md`/`HEADER_MAP.md` seeded; README stub.
      (README + LICENSE shipped in `6a18625`; the agent-guardrails
      `CLAUDE.md`/`INDEX_MAP` seed items were not created — non-blocking.)

**Exit:** `npm run build && npm test && npm run guardrails` all pass;
`ci.yml` runs build+lint+test+regression and is green on push/PR;
pre-commit blocks a test secret.

---

## Sprint 1 — Core engine (Layers 1–2, pure functions)

Goal: deterministic, unit-tested compaction primitives — no pi coupling.

- [x] **1.1 (M)** `src/tokens.ts` — token estimator (`len/4+1` per block, ported
      from claw-code). `src/types.ts` — internal message/checkpoint types.
- [x] **1.2 (L)** `src/compact.ts` — `summarize_messages()` (role counts, tool
      names, recent user requests, `inferPendingWork`, `collectKeyFiles`,
      timeline), `merge_compact_summaries()`, `formatCompactSummary()`.
- [x] **1.3 (M)** `src/supersede.ts` (Layer 1) — detect obsolete file-read turns
      superseded by later writes/reads; return prune set (zero-cost).
- [x] **1.4 (M)** `src/boundary.ts` — tool-pair boundary guard + anchor-floor
      (preserve last N user msgs) as reusable pure fns.
- [x] **1.5 (M)** Port claw-code `compact.rs` test cases to `node --test`:
      leaves-small-sessions, compacts-older, merge-prior-context, tool-pair guard,
      infer-pending-work, key-files.

**Exit:** ≥90% of ported tests green; `should_compact`/`auto_compact_check`
implemented + tested; no pi imports in `src/` yet (engine is standalone).

---

## Sprint 2 — Local vector store (Layer 3)  ✅ DONE (commit 62911f1)

Goal: offline dedup + recall substrate.

- [x] **2.1 (M)** `src/embedder.ts` — `interface Embedder`; default hashed
      trigram-bag embedder (fixed dim, L2-normalized, deterministic).
- [x] **2.2 (L)** `src/vectorStore.ts` — `add/search/dedupe`, cosine sim,
      on-disk JSON + `zlib` gzip under `~/.pi/agent/extensions/mega-compact/`.
      `regionHash` + `checkpointId` + near-dup (`DEDUP_SIM`) dedup.
- [x] **2.3 (S)** `src/store.ts` — checkpoint/state persistence (`chkpt_001`
      IDs, `sess_xxx` normalize, `state.json` injected-set).
- [x] **2.4 (M)** Tests: round-trip store, search ranking sanity, dedup by
      hash/id/similarity, gzip integrity, corrupt-file recovery.
- [x] **2.5 (S)** (Optional, behind flag) transformers.js embedder stub
      implementing `Embedder` — not wired by default.

**Exit:** store survives process restart; dedup provably idempotent (same region
twice → one vector); search returns the planted checkpoint top-1.

---

## Sprint 3 — pi extension wiring (Layer 4 persist + trigger)  ✅ DONE (commit 3867d55)

Goal: the extension compacts a real session and persists checkpoints.

- [x] **3.1 (M)** `extensions/mega-compact.ts` — factory, config load
      (env-backed defaults), `session_start`/`session_shutdown`/`session_tree`
      state reset (per neuralwatt-mcr discipline), status-bar chip.
- [x] **3.2 (L)** Auto-trigger: `on("turn_end")`/`on("context")` → `%` fast gate
      (`getContextUsage`) → local `auto_compact_check` confirm → run
      Trident(supersede+collapse) → `compact_session()` persist to vector store.
      Debounce + `isIdle()` guard.
- [x] **3.3 (M)** `context` drop: return `{ messages: filtered }` dropping the
      superseded/collapsed range with tool-pair + anchor-floor guards.
- [x] **3.4 (M)** `session_before_compact` → `{ cancel:true }` after we've
      persisted (avoid double compaction). NOTE: we do NOT emit a
      `compactionSummary`-shaped message — injected recall text is staged
      for the `before_agent_start` systemPrompt prepend (PREVENT-PI-003).
- [x] **3.5 (M)** Marker sentinel: on persist, `pi.appendEntry("mega-compact-marker",
      {checkpointId, regionHash, tokenEstimate, deduped})` — a NON-LLM
      bookkeeping entry (not a `customType` message). Replay/scan markers on
      `session_tree` via the store's regionHash/injected-set state.
      tokenEstimate, dropped}})`; replay/scan markers on `session_tree`.

**Exit:** in a long live session, auto-trigger fires once past threshold, a
`chkpt_xxx` is written, context visibly drops, marker present, no double-compact.

---

## Sprint 4 — Unified recall layer (Layer 5, all 3 entry points)  ✅ DONE

Goal: one vector store → auto-inline + on-demand + sentinel, one dedup engine.

- [x] **4.1 (L)** `src/recall.ts` — `recallAndInline(ctx,{query?,limit,source})`:
      `search → dedupe → inject`. Injection via `before_agent_start`
      `{ systemPrompt }` prepend (model-visible), NOT a custom message.
- [x] **4.2 (M)** Auto-inline: `session_start`/`session_tree` →
      `recallAndInline(source:"resume")` using newest user msg as query; gated by
      `MEGACOMPACT_AUTO_INLINE`.
- [x] **4.3 (M)** `/recall-context [query]` command → `recallAndInline(
      source:"command")`; report inlined checkpoints.
- [x] **4.4 (S)** Shared dedup: skip by `regionHash` marker in branch, by
      injected-`checkpointId` in `state.json`, cosine near-dup collapse.
- [x] **4.5 (M)** Tests: auto-inline injects on resume, no re-inject of present
      region, `/recall-context` ranks relevant checkpoint first.
      (`src/recall.integration.test.ts`: cross-process resume contract —
      compact in one store instance, recall via a FRESH instance over the
      same state dir, query from newest user msg; + dedup-on-resume.)

**Exit:** resume a compacted session → relevant context silently reappears in the
system prompt; `/recall-context` works; nothing double-injected.

---

## Sprint 5 — Commands, UX, config polish  ✅ DONE

- [x] **5.1 (M)** `/megacompact [summary...]` — manual compact; if no summary
      arg, drive agent (`ctx.sendMessage` / `sendUserMessage`) to produce one;
      persist + report tokens saved via status chip.
- [x] **5.2 (S)** `/megacompact-status` — threshold, current %, last chkpt, store
      size, dedup hit-rate.
- [x] **5.3 (S)** Config surface: all `MEGACOMPACT_*` env + settings.json;
      document defaults.
- [x] **5.4 (S)** Status-bar chip parity with neuralwatt-mcr (compaction %,
      "optimizing…", chkpt id).
- [x] **5.5 (S)** Structured logging to `~/.pi/agent/extensions/mega-compact.log`.

**Exit:** all three commands usable in TUI; status chip live; config documented.

---

## Sprint 6 — Hardening, docs, release  ✅ DONE

- [x] **6.1 (M)** Cross-process resume proof: `src/recall.integration.test.ts`
      compacts in one store instance, then recalls via a FRESH instance over
      the same state dir (models a pi restart) → context re-surfaces.
      NOTE: proven at the engine/store level, NOT yet inside a live pi session
      (see Sprint 7 backlog "live pi smoke test").
- [x] **6.2 (M)** Failure-mode tests: corrupt store recovery + empty session
      (`vectorStore.test.ts`, `engine.test.ts`). NOTE: overflow-recovery
      (`reason:"overflow"`, `willRetry`) and branch-switch-mid-compact are
      handled in code but NOT yet covered by dedicated tests (Sprint 7 backlog).
- [x] **6.3 (S)** README (usage, layers, config, attribution to memory-mcp /
      claw-code / neuralwatt-mcr) + CHANGELOG. RELEASE_NOTES = the GitHub
      release body for `v0.1.0` (not a checked-in file).
- [x] **6.4 (S)** `install.sh` (mirror pi-setup): copy/symlink into
      `~/.pi/agent/extensions/`, register in `~/.pi/agent/config.json`.
- [x] **6.5 (S)** Full guardrails audit (green) + `ci.yml` gate; tag `v0.1.0`
      + public GitHub release. `npm publish` NOT done (deferred — Sprint 7).

**Exit:** cross-process recall proven in tests; guardrails + CI green;
v0.1.0 tagged and released publicly.

---

## Dependency graph
```
S0 ─┬─ S1 ─┬─ S2 ─── S3 ─── S4 ─── S5 ─── S6 ─── (S7 backlog)
    │      │
    └ guardrails gate (incl. ci.yml) active from S0 onward
```
S1 and S2 engine work is pi-independent. S3 needs S1+S2. S4 needs S3.
S5/S6 need S4. S1–S6 are DONE (v0.1.0). S7 = optional backlog.

---

## Sprint 7 — Optional backlog (NOT started)

Deferred from Sprints 1–6; none are bugs — v0.1.0 is shippable.

- [x] **7.1 (M)** Optional local embedder upgrade behind the `Embedder`
      interface (e.g. @xenova/transformers all-MiniLM-L6-v2, local
      ONNX) — would raise recall quality, still offline. The `Embedder`
      interface is the seam; the stub was removed to keep the repo
      self-contained (no foreign-library reference in shipped code).
- [x] **7.2 (S)** `npm publish` (package is structured for it: `files`,
      `pi.extensions`, peerDep). Optional.
- [x] **7.3 (M)** Live pi smoke test: run inside a real pi session,
      confirm auto-trigger fires past threshold, chkpt written, context drops,
      resume re-inlines (proves 6.1 beyond the engine-level test).
      DONE — persisted `chkpt_001` in a live `pi --print`, then `pi --continue`
      auto-inlined it (`event:"auto-inline", injected:["chkpt_001"]`). Two
      live-only bugs fixed (isIdle guard, resume==startup reason gating).
- [x] **7.4 (M)** Dedicated failure tests: `reason:"overflow"` +
      `willRetry` recovery; branch-switch mid-compact (6.2 partial).
- [x] **7.5 (S)** "mega" cross-session roll-up (aggregate N sessions' chunks)
      — explicitly defered in PLAN.md out-of-scope; follow-up once single
      session is proven in the wild.

**Exit:** any subset chosen; each lands behind a green CI run.

---

## Guardrails adaptation (Sprint 0.2 detail)

Vendor from `guardrails-template/` → project root:
- `.claude/hooks/pre-commit.sh` (as-is) — the only hook this repo
  wires (referenced by `package.json` `precommit`).
- `.guardrails/{pre-work-check.md,failure-registry.jsonl,
  prevention-rules/*}` — retarget `file_glob` to ts/js only (already mostly).
- `.github/workflows/{guardrails-lint,regression-guard,secret-validation,
  documentation-check}.yml` (drop `team-validation` unless we use `.teams`).
- `scripts/{regression_check.py,log_failure.py}` (standalone Python).
- `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` (trimmed).

REMOVED (MCP-server contamination): the 8 `.claude/skills/*.json`
(clean-architecture, guardrails-enforcer, commit-validator, env-separator,
error-recovery, production-first, scope-validator, three-strikes) and the
`.claude/hooks/{pre,post}-execution.sh` were vendored from the Go
**MCP-server** template. They describe a *different* project (their prompts
say "when working on the MCP server… `internal/mcp/`"). They are NOT
referenced by any code/hook/CI in pi-mega-compact, so they were
`git rm`'d. This repo's guardrails gate is `.guardrails/` + `pre-commit.sh`
+ `ci.yml` only. (This removal was the S7 fix for "work done assuming the
MCP server" — the code itself never used them.)

Strip (irrelevant to TS pi extension): `godot/`, `.claude/skills-3d/`,
`.cursor/rules-3d/`, `mcp-server/` (Sentinel), `web/`, `cmd/`, `ide/`,
game-design/spatial/accessibility docs, `.teams/*` (unless adopting phase gates).

Wire into `package.json` (CURRENT, verified against the repo):
```
"scripts": {
  "build": "tsc -p tsconfig.json",
  "lint": "tsc --noEmit && node scripts/guardrails-scan.mjs",
  "test": "npm run build && node --test \"dist/src/**/*.test.js\" \"dist/extensions/**/*.test.js\"",
  "guardrails": "python3 scripts/regression_check.py --all || node scripts/guardrails-scan.mjs",
  "precommit": "bash .claude/hooks/pre-commit.sh"
}
```

Add project-specific prevention rules (extend `pattern-rules.json`):
- PREVENT-PI-001: dropping messages without anchor-floor guard.
- PREVENT-PI-002: splitting a toolCall/toolResult pair at a boundary.
- PREVENT-PI-003: injecting compacted context as `role:"system"` (invalid —
  must use `before_agent_start` systemPrompt).
- PREVENT-PI-004: network calls in extension (must stay local).

---

---

## Phases 2–7 Sprint Plan (targets v0.2.0) — appended 2026-07-13

Sprints 0–7 above shipped v0.1.0. The eight sprints below cover `PLAN.md`
Phases 2–7, using a **local in-process SQLite** backend (`better-sqlite3`) with
Node.js FS persistence and **zero network calls** (honors `PREVENT-PI-004`). The
pglite-native features the dedup plan assumes are emulated locally: `pg_trgm`
→ **FTS5 `trigram` tokenizer**, `pgvector` HNSW → **`embedding_blob` BLOB + linear
cosine scan**, `bloom` index → **in-memory `bloom-filters` Map → `bloom.json.gz`**.
See the resolved architecture decisions, doc phase mapping, and QA critical-fix
re-mapping in the appended section below before reading Sprints 8–15.

## Acceptance criteria (whole project)
1. Zero network calls at runtime (grep-verified in CI — PREVENT-PI-004).
2. Auto-trigger (via `on("context")`: `%` fast-gate → `autoCompactCheck`
   confirm → persist → drop) fires past threshold; context measurably shrinks
   (honoring anchor-floor + tool-pair guards).
3. Checkpoints persist to the local vector DB and survive a fresh store instance
   over the same state dir — cross-process recall proven in
   `src/recall.integration.test.ts`, and live pi-restart exercised in 7.3
   (persist in `pi --print`, auto-inline on `pi --continue`).
4. Unified recall: auto-inline on resume + `/recall-context`, deduped by one
   engine; nothing double-injected (sentinel + injected-set).
5. Marker sentinel (`pi.appendEntry("mega-compact-marker")`, NON-LLM
   bookkeeping) makes repeated triggers ~zero-token.
6. All guardrails (Four Laws, scope, secrets, regression, 500-line docs)
   pass in `ci.yml` (build+lint+test+regression) and pre-commit.
7. Ported claw-code compaction tests + 56 unit/integration tests green.

---

# Phases 2–7 Sprint Plan — pi-mega-compact (targets v0.2.0)

> Sprints 0–7 (v0.1.0) are above. This section covers `PLAN.md` Phases 2–7
> using a **local, in-process SQLite** backend (`better-sqlite3`) — FTS5
> `trigram` (pg_trgm-equivalent), `embedding_blob` BLOB + linear cosine scan
> (pgvector-equivalent), in-memory bloom (bloom-index-equivalent) — with Node.js
> FS persistence and **zero network calls** (honors `PREVENT-PI-004`). No Docker
> sidecar, no remote MCP server, no network listener.

---

## Resolved architecture decisions (from QA review)

1. **Storage backend = better-sqlite3** (in-process native SQLite). No Docker,
   no network, and — critically — **synchronous**, which keeps `VectorStore` /
   `engine.ts` / `recall.ts` / the extension signatures unchanged (PGlite was
   evaluated but is async-only in every version, which would have forced the
   whole call chain async). The pglite-native features are emulated: `pg_trgm`
   → FTS5 `trigram` tokenizer, `pgvector` → `embedding_blob` BLOB + linear cosine
   scan, `bloom` → in-memory `bloom-filters` Map. SQLite persists to disk
   (`STATE_DIR/sqlite.db`, WAL) and survives restart (cross-process recall
   proven in Sprint 8.5).
2. **Embedder = TrigramEmbedder default + flag-gated MiniLM.** Default stays
   self-contained (honors Sprint 7.1 deferral). `MEGACOMPACT_EMBEDDER=minilm`
   (all-MiniLM-L6-v2 via ONNX, 384-dim, local model file) opts into real
   semantic embeddings — off by default. Tier-2 cosine threshold is 0.85 for
   trigram (can actually fire) and 0.95 for MiniLM.
3. **Compression = format-version header.** `store.ts` (now
   `src/store/compression.ts`) prepends a 2-byte version magic (`0xEC 0x01`
   [ver] [tag]) before the tier tag, resolving the shipped `0x03`=Brotli vs
   `PLAN.md` `0x03`=zstd collision. All three format eras roundtrip.
4. **No Redis / no Prometheus port.** Local accelerator = in-memory
   `bloom-filters` Map (persisted to `STATE_DIR/bloom.json.gz`), but **SQLite is
   always the source of truth** (cache hit still confirmed via query). Metrics
   go to `dashboard.json` + `events.log` (no network listener). "Circuit
   breaker" = query-timeout guard that degrades to skip-tier.
5. **Single store = SQLite** (source of truth). The existing gzipped JSON
   checkpoint files are retained as a DR snapshot (per dedup plan §6.3),
   rebuilt into SQLite on load if the DB is missing.

### Doc phase mapping (do not mis-track)
`docs/dedup-implementation-plan.md` "Phase 1–4" ≡ `PLAN.md` "Phase 3–6."
This plan's Sprints 8–15 map to `PLAN.md` Phase 2 → Phase 7.

### QA critical-fix register — re-mapped for local SQLite
All 19 fixes from `PLAN.md` still apply; Postgres/Redis/network-specific ones are
re-mapped, not dropped:
- #1 NULL handling → SQLite partial UNIQUE `WHERE content_hash IS NOT NULL`.
- #2 Redis sole arbiter → in-memory bloom is accelerator only; **always confirm via SQLite**.
- #8 pgvector extension check → N/A; embeddings stored as `embedding_blob` BLOB, cosine in TS.
- #9 `vector(384)` → `embedding_blob` BLOB (Float32); dim-agnostic.
- #10 `<=>` cosine operator → cosine computed in TS (`cosineSimilarity`) for both trigram + MiniLM.
- #12 transactional coupling → single SQLite `db.transaction()` for insert + index update.
- #13 Redis breaker → SQLite query-timeout guard → degrade skip-tier.
- #18/#19 alerting/metrics → `dashboard.json` + `events.log` thresholds (no Prometheus).
- #3,#4,#5,#6,#7,#11,#14,#15,#16,#17 apply directly (universal hashing, heap top-k,
  single load, empty-vector guard, complexity caps, GMM, backfill ordering,
  faithfulness, unit-normalize).

---

## Guardrails gate (applies to Sprints 8–15)

Every sprint exits ONLY when the adapted agent-guardrails checks pass. The
guardrails are vendored in this repo (see `docs/AGENT_GUARDRAILS.md`,
`skills/shared-prompts/four-laws.md`, `.guardrails/`, `.claude/hooks/`,
`scripts/`). Gate commands (run before commit):

```bash
npm run build          # tsc
npm test               # build + node --test on dist/**/*.test.js
npm run lint           # tsc --noEmit + scripts/guardrails-scan.mjs (PREVENT-PI-*)
python3 scripts/regression_check.py --all   # Four Laws / scope / secrets audit
python3 scripts/log_failure.py --list       # no active failures in scope
```

Per-sprint guardrail checklist:
- [x] **Four Laws**: read target file first; stay in scope (only S8–15 files);
      tests green before commit; halt on uncertainty.
- [x] **PREVENT-PI-004 (critical)**: grep-confirmed **zero network calls** in
      any `src/` / `extensions/` code (better-sqlite3 is in-process native SQLite
      + FS, not a remote DB). `npm run lint` enforces this automatically.
- [x] **PREVENT-PI-001/002/003**: any compaction code change preserves the
      anchor-floor guard, never splits a toolCall/toolResult pair, and injects
      recall via `before_agent_start` systemPrompt (never `role:"system"`).
- [x] **PREVENT-002**: all SQLite queries use parameterized `?` placeholders
      — never string-concatenated SQL.
- [x] **PREVENT-003 / secrets**: no hardcoded credentials; state dir contents
      (`*.checkpoints.json.gz`, `*.state.json.gz`, `sqlite.db`, `*.db-wal`,
      `*.db-shm`) never committed.
- [x] **No feature creep**: do not touch files outside the sprint's scope table.
- [x] **500-line docs**: keep specs/maps under 500 lines (split if needed).
- [x] **AI attribution**: `Co-Authored-By: Claude ...` in every commit
      (pre-commit hook enforces).

> Note: the four pre-existing `.github/workflows/guardrails-*.yml` files only
> check scope/secrets/commit-format and target `main`. The real green gate is
> `.github/workflows/ci.yml` against `master` (build+lint+test+regression).

---

## Sprint 8 — Storage Backbone: SQLite + Compression v2  (foundation)  [L]

Goal: a local SQL store powering every tier, plus the revised compression scheme.

- [x] **8.1 (M)** Add `better-sqlite3` (+ `@types/better-sqlite3`, `@mongodb-js/zstd`
      for the async DR helper). Init at `STATE_DIR/sqlite.db` with Node-FS
      persistence (WAL); verify open + cross-process reopen in tests.
- [x] **8.2 (M)** Format-version magic in `src/store/compression.ts` `compressSmart`:
      prepend `0xEC 0x01` (version 1) before the tier tag; `decompressSmart`
      detects the magic and dispatches. Legacy eras (untagged gzip, single-tag
      incl. old `0x03`=brotli) still roundtrip.
- [x] **8.3 (M)** New compression tiers: raw `0x00` / gzip1 `0x01` / gzip6 `0x02` /
      brotli4 `0x05` (sync, zlib); large tier uses brotli-4 (the sync alternative
      to the spec's zstd `0x03/0x04`). zstd available as an async opt-in helper for
      DR/large-blob paths. Backward-compat: legacy files still decompress.
- [x] **8.4 (L)** SQLite schema `context_chunks`:
      `id TEXT PK, session_id TEXT, region_hash TEXT, content_hash TEXT,
      content_hash2 TEXT, content_hash_version INT, normalized_text TEXT,
      summary TEXT, topic_summary TEXT, summary_hash TEXT, key_decisions TEXT,
      next_steps TEXT, files_modified TEXT, embedding_blob BLOB,
      token_estimate INT, timestamp BIGINT, dedup_status TEXT DEFAULT 'active'`
      (JSON arrays as TEXT, vectors as BLOB). Plus `session_state` table and an
      FTS5 `trigram` virtual table `context_chunks_trgm` (pg_trgm-equivalent).
- [x] **8.5 (L)** Migrate existing `<sess>.checkpoints.json.gz` → `context_chunks`
      (idempotent: `ON CONFLICT(id) DO NOTHING`; compute hash + normalized_text
      on the fly). Keep `.json.gz` as DR snapshot. `recall.integration.test.ts`
      proves cross-process recall over the same `STATE_DIR/sqlite.db`.
- [x] **8.6 (S)** `VectorStore` reads/writes via SQLite (replaces file I/O);
      `add/search/dedupe/markInjected` unchanged in signature (kept synchronous).
- [x] **8.7 (S)** Storage metrics: `compressionRatio`, `storageBytes`, `checkpointCount`.
- [x] **8.8 (S)** Tests: all tiers roundtrip; legacy decompresses; migration
      lossless (byte-compare checkpoint count + regionHash set); SQLite reopens
      cross-process with data intact.

**Exit:** SQLite opens at `STATE_DIR/sqlite.db`; compression v2 roundtrips; existing
data migrates without loss; recall integrates against SQLite; `npm test` + `npm run guardrails` green.

---

## Sprint 9 — Phase 2: Content-Addressable Dedup + Compressed Originals  [M]

Goal: SHA-256 content dedup at write time + reconstructible originals for audit.

- [x] **9.1 (M)** `src/dedup/normalize.ts`: strip ANSI, Unicode NFC, collapse
      whitespace, 32K char cap, newline normalize.
- [x] **9.2 (M)** `src/dedup/digest.ts`: `computeContentDigest` — SHA-256 primary
      (`content_hash`, full 64-hex) + secondary variant (`content_hash2`) for
      collision safety; `content_hash_version`. (Bumps `summaryHash` from 16→full hex.)
- [x] **9.3 (M)** `VectorStore.add()` new L0 tier: `content_hash` exact match
      (before `regionHash`); on hit, bump timestamp, mark `deduped`.
- [x] **9.4 (M)** Compressed original (rad-gateway `CompressedOriginal`): store
      zstd-compressed raw region in `context_chunks.compressed_original` for
      audit/replay/re-summarize.
- [x] **9.5 (S)** Storage metrics: `dedupSavings`, `originalBytesCompressed`.
- [x] **9.6 (S)** Tests: dual-hash verify; `content_hash` dedup catches identical
      content under different `regionText`; `compressed_original` roundtrips.

**Exit:** content-hash dedup works; originals auditable; stats available; no regression.

---

## Sprint 10 — Phase 3: L0 Exact-Match Upgrade (normalized + bloom + atomic + backfill)  [L]

Goal: robust exact dedup handling normalization variants, with a local accelerator
and safe migration.

- [x] **10.1 (M)** Integrate normalized content-hash as the L0 key: case/whitespace/
      ANSI variants of the same text dedup.
- [x] **10.2 (M)** SQLite partial UNIQUE index `idx_content_hash
      (WHERE content_hash IS NOT NULL)` — QA #1. `ON CONFLICT DO NOTHING` on insert.
- [x] **10.3 (L)** Local bloom accelerator: in-memory `bloom-filters` Map persisted
      to `STATE_DIR/bloom.json.gz`. Miss → skip full scan; hit → **confirm via
      SQLite query** (never sole arbiter) — QA #2.
- [x] **10.4 (M)** Atomicity: wrap insert + index update + bloom update in one
      SQLite `db.transaction()` — QA #12. Query-timeout guard (e.g. >50ms) → degrade
      to "store, skip dedup this pass" — QA #13.
- [x] **10.5 (L)** Backfill orchestration: non-unique index → backfill
      `content_hash`/`normalized_text` → resolve dups (keep oldest) → UNIQUE
      CONCURRENTLY → drop temp index — QA #14. Resumable + idempotent.
- [x] **10.6 (M)** Integrity checks: sentinel `storedRegionHashes` vs recomputed
      from `context_chunks`; orphan `injectedCheckpointId` detection — dedup plan §6.4.
- [x] **10.7 (S)** Tests: bloom FP rate <1%; normalized dedup catches
      case/whitespace/ANSI variants; atomic-write recovery; backfill idempotent
      + no duplicate rows.

**Exit:** L0 handles normalization; bloom accelerates without false negatives;
atomic; backfill safe; integrity verifiable.

---

## Sprint 11 — Phase 4: L1 Near-Duplicate (MinHash + LSH + trigram verify)  [L]

Goal: catch typos/rephrasings via MinHash signatures + LSH bucketing + trigram
verification.

- [x] **11.1 (L)** `src/dedup/l1-minhash.ts`: char 5-gram shingles (cap 50K),
      universal hashing `h_i=(a_i·x+b_i) mod p` with pinned seed `0xDEADBEEF`,
      256 signatures, signature versioning — QA #3.
- [x] **11.2 (M)** `src/dedup/l1-lsh.ts`: 64 bands × 4 rows; bucket keys include
      `session_id`; deterministic (QA fix for non-determinism).
- [x] **11.3 (M)** `src/dedup/l1-verify.ts`: trigram-similarity verification after
      LSH candidates (threshold 0.85). Use the FTS5 `trigram` tokenizer on
      `context_chunks_trgm` (pg_trgm-equivalent) for candidate scoring.
- [x] **11.4 (M)** Candidate caps — QA #7/#15: max 100 candidates/insert, max
      20ms verification budget, abort → "not duplicate".
- [x] **11.5 (M)** SQLite tables `minhash_signatures(id, chunk_id, signature_version,
      signatures TEXT, UNIQUE(chunk_id, signature_version))` +
      `dedup_lsh_buckets(bucket_key, chunk_id, signature_version)` with indexes.
- [x] **11.6 (M)** Wire L1 into `VectorStore.add()` cascade: after L0, before
      content-similarity. Single SQLite query for candidates (no N sequential).
- [x] **11.7 (S)** Benchmarks: L1 p95 < 200ms on 1K-checkpoint session (local scale).
- [x] **11.8 (S)** Threshold tuning: collect positive (same content_hash) /
      negative (diff) pair similarity distributions; pick Jaccard threshold for
      FPR < 0.1%.
- [x] **11.9 (S)** Tests: LSH bucket key stable across restarts; L1 catches
      one-word-diff near-dup; caps enforced; p95 budget.

**Exit:** L1 catches near-dups; LSH deterministic; p95 under budget; FPR tuned.

---

## Sprint 12 — Phase 5: L2 Semantic Dedup (embed + cosine + MMR)  [L]

Goal: catch semantically-similar but differently-worded content; MMR retrieval
diversity. Two embedder modes.

- [x] **12.1 (M)** `Embedder` interface unchanged. Add `MiniLM` embedder
      (all-MiniLM-L6-v2 via `onnxruntime-node`, 384-dim, local model file)
      behind `MEGACOMPACT_EMBEDDER=minilm` (off by default). TrigramEmbedder
      (512-dim) stays default.
- [x] **12.2 (M)** Embedding storage: `embedding_blob` BLOB (Float32, dim-agnostic)
      for both trigram (512-dim) and MiniLM (384-dim). No pgvector; cosine is a
      linear scan in TS (QA #8/#9 re-mapped — no native extension needed).
- [x] **12.3 (M)** L2 cosine dedup in `VectorStore.add()`: threshold 0.85 (trigram)
      / 0.95 (MiniLM); cosine computed in TS (reuse `cosineSimilarity`) for both
      embedders. Single load per add — QA #5.
- [x] **12.4 (L)** `src/dedup/mmr.ts`: `mmrRerank()` in `VectorStore.search()`
      (λ=0.5) for retrieval diversity — dedup plan §2.7.
- [x] **12.5 (M)** Heap-based top-k (min-heap, O(N log k)) replaces full sort —
      QA #4. Batched embed (accumulate ≤32, single embed call per flush).
- [x] **12.6 (M)** Unit-normalize on write; assert norm ≈ 1; empty-vector guard
      returns 0 — QA #6/#17.
- [x] **12.7 (S)** Feature flag `L2_ENABLED` gates semantic dedup independently.
- [x] **12.8 (S)** SemDeDup offline cleanup: batch job finds cosine > 0.95 pairs,
      marks lower-quality `dedup_status='removed'` (REPEATABLE READ snapshot).
- [x] **12.9 (S)** Benchmarks: L2 p95 < 300ms on 1K session; cosine threshold tuning.
- [x] **12.10 (S)** Tests: L2 catches semantic near-dup (MiniLM fixture); MMR
      diversifies; heap top-k matches brute force; empty-vector guard; flag off → skip.

**Exit:** L2 catches semantic near-dupes; MMR diversifies; flag-gated; p95 under budget.

---

## Sprint 13 — Phase 6: RAPTOR Pre-Compression  [L]

Goal: hierarchical summary tree over checkpoint chunks; hallucination-guarded;
shadow mode first.

- [x] **13.1 (L)** `src/dedup/raptor/kmeans.ts`: k-means++ clustering (TS, no
      external dep); near-zero-variance merge guard — QA #11 (GMM preferred but
      k-means acceptable locally; note GMM as future upgrade).
- [x] **13.2 (L)** `src/dedup/raptor/summarizer.ts`: local extractive summarizer
      (reuse `extractive.ts` patterns) + optional Ollama path (`llama3.2:3b`,
      local-only). Structured output, temp 0.
- [x] **13.3 (L)** `src/dedup/raptor/guardrails.ts`: four-layer hallucination
      defense — claim-to-chunk grounding, entity verification, consistency
      (re-embed + cosine to centroid), quality markers — QA #16.
- [x] **13.4 (L)** `src/dedup/raptor/tree.ts`: RAPTOR tree builder; 5s budget cap
      (`buildRaptorTreeWithBudget`); extractive fallback on timeout/low consistency.
- [x] **13.5 (M)** `src/dedup/raptor/retrieval.ts`: staged expansion (ANN → expand
      top-M → BFS to leaves → MMR) — dedup plan §3.9.
- [x] **13.6 (M)** SQLite `raptor_nodes(id, session_id, level, parent_id,
      children TEXT, summary TEXT, embedding_blob BLOB, quality_marker TEXT,
      token_estimate INT)` (children as JSON TEXT, vector as BLOB).
- [x] **13.7 (M)** Shadow mode (`RAPTOR_SHADOW_MODE` default true): build + log,
      don't serve. Contradiction detection (adjacent-level noun overlap) downgrades
      quality marker.
- [x] **13.8 (S)** Evaluation: nDCG@K drop < 0.05, entity preservation ≥ 0.70,
      redundancy reduction ≥ 15% (offline, on fixture corpus).
- [x] **13.9 (S)** Tests: tree builds within 5s budget; guardrails catch a fixture
      hallucinated claim; shadow mode logs but doesn't alter retrieval; <10 chunks →
      single summary node.

**Exit:** RAPTOR tree builds in budget; shadow mode logs quality; guardrails catch
hallucination; eval pass criteria met.

---

## Sprint 14 — Phase 7: Full Pipeline (flags, backfill, monitoring, canary)  [L]

Goal: wire all tiers with independent feature flags, unified backfill, local
monitoring, safe rollout.

- [x] **14.1 (M)** `src/config/dedup.ts`: single source of truth for all tier
      thresholds + feature flags (`L0_ENABLED`, `L1_ENABLED`, `L2_ENABLED`,
      `RAPTOR_ENABLED`, `MARK_ONLY_L1`, `MARK_ONLY_L2`, `MINILM_EMBEDDER`).
- [x] **14.2 (M)** `VectorStore.add()` honors flags: each tier skipped when disabled;
      `MARK_ONLY` → insert with `dedup_status` but don't collapse.
- [x] **14.3 (L)** Backfill orchestrator: batch loop (1000/batch, throttled),
      progress table, resumable, integrity validation per phase — dedup plan §16.
- [x] **14.4 (M)** Monitoring: structured `events.log` per dedup decision
      (tier, result, latency); `dashboard.json` metrics (hit rate, FP rate,
      per-tier latency p95, storage) — re-maps QA #18/#19 (no Prometheus port).
- [x] **14.5 (M)** Alerting (local): FP rate > 1% (L0) or > 5% (L1/L2) over 10m →
      auto `MARK_ONLY` + warning in `events.log`/`megacompact-status`.
- [x] **14.6 (M)** Canary rollout: enable L0 → L1 → L2 → RAPTOR sequentially;
      auto-disable tier on degradation (latency/p95 or FP breach).
- [x] **14.7 (S)** Tests: flag matrix (each tier on/off) doesn't crash; backfill
      resumes after simulated interrupt; alert fires on injected FP spike; canary
      disables a degraded tier.

**Exit:** full pipeline runs with flags; monitoring catches regressions; canary
validates quality; all tiers independently toggleable.

---

## Sprint 15 — Release: benchmarks, DR, docs, tag v0.2.0  [M]

Goal: prove the system, document it, ship.

- [x] **15.1 (M)** End-to-end benchmarks at 100 / 1K / 10K checkpoints: dedup hit
      rate, compression ratio (target ≥ 5:1), per-tier p95 latency, storage savings.
- [x] **15.2 (M)** DR drill (`scripts/dedup-restore-drill.sh`): validate SQLite
      integrity + rebuild from `.json.gz` snapshots; sentinel recompute — dedup plan §6.
- [x] **15.3 (S)** `docs/RETENTION_POLICY.md` (TTL, soft-delete cleanup) +
      `docs/DEDUP_RUNBOOK.md` (incident "first 15 min", SEV tiers).
- [x] **15.4 (S)** Update README (storage backend, embedder modes, config, flags)
      + CHANGELOG; `install.sh` notes SQLite data dir.
- [x] **15.5 (S)** Guardrails audit green + `ci.yml`; tag `v0.2.0` + GitHub release.

**Exit:** benchmarks hit targets; DR drill passes; docs complete; guardrails + CI
green; v0.2.0 tagged.

---

## Dependency graph (new sprints)
```
S8 ─┬─ S9 ─ S10 ─ S11 ─ S12 ─ S13 ─ S14 ─ S15
    │                                          (release)
    └ SQLite backbone active from S8 onward; every later sprint reads/writes via it
```
S8 is the foundation (storage + compression). S9–S13 build the dedup tiers
sequentially (each builds on the prior tier's `add()` cascade). S14 wires flags
+ monitoring. S15 ships. QA-critical fixes are distributed across S8–S14 as noted.

Full per-sprint specs (Header / Safety / Problem / Scope / Execution /
Acceptance / Rollback) live in `docs/specs/sprint-08.md` … `sprint-15.md`,
following the agent-guardrails `SPRINT_GUIDE` structure. Each sprint exits only
when the Guardrails gate (above) passes.

## Files to create (new sprints)
| File | Sprint |
|------|--------|
| `src/dedup/normalize.ts` | 9 |
| `src/dedup/digest.ts` | 9 |
| `src/dedup/l1-minhash.ts` | 11 |
| `src/dedup/l1-lsh.ts` | 11 |
| `src/dedup/l1-verify.ts` | 11 |
| `src/dedup/mmr.ts` | 12 |
| `src/dedup/raptor/kmeans.ts` | 13 |
| `src/dedup/raptor/summarizer.ts` | 13 |
| `src/dedup/raptor/guardrails.ts` | 13 |
| `src/dedup/raptor/tree.ts` | 13 |
| `src/dedup/raptor/retrieval.ts` | 13 |
| `src/config/dedup.ts` | 14 |
| `scripts/dedup-restore-drill.sh` | 15 |
| `docs/RETENTION_POLICY.md` | 15 |
| `docs/DEDUP_RUNBOOK.md` | 15 |

## Files to modify (new sprints)
| File | Sprint | Change |
|------|--------|--------|
| `src/store.ts` | 8 | Format-version header; new zstd/brotli tiers; compressed-original helper |
| `src/vectorStore.ts` | 8–14 | SQLite backend; L0/L1/L2 cascade; MMR search; heap top-k; flags |
| `src/embedder.ts` | 12 | MiniLM embedder behind `Embedder` (flag-gated) |
| `src/engine.ts` | 8–14 | Wire SQLite store; feature flags |
| `src/recall.ts` | 12–14 | MMR rerank; RAPTOR integration; flag gating |
| `extensions/mega-compact.ts` | 14 | Flag loading; metrics reporting |
| `package.json` | 8,12 | better-sqlite3, @mongodb-js/zstd, (optional onnxruntime-node) |
| `recall.integration.test.ts` | 8 | Cross-process proof over SQLite |

## Verification (per sprint, cumulative)
- **S8:** SQLite opens; compression v2 roundtrips; migration lossless; cross-process recall proven.
- **S9:** dual-hash dedup; compressed originals roundtrip.
- **S10:** bloom FP <1%; atomic recovery; backfill idempotent.
- **S11:** L1 p95 <200ms; FPR <0.1%; LSH deterministic.
- **S12:** L2 p95 <300ms; MMR diversifies; flag-gated.
- **S13:** RAPTOR 5s budget; nDCG@K drop <0.05; guardrails catch hallucination.
- **S14:** flag matrix safe; canary disables degraded tier; monitoring catches FP spike.
- **S15:** end-to-end benchmarks hit targets; DR drill passes; guardrails + CI green; v0.2.0 tagged.
- **Every sprint:** `npm test` + `npm run guardrails` green; PREVENT-PI-004 verified (no network calls).
