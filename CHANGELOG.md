# Changelog

## v0.2.0 (2026-07-13)

The **storage-backend release**: the per-session gzipped-JSON checkpoint files
are replaced by a single local SQLite database as the source of truth, and the
full L0/L1/L2/RAPTOR dedup pipeline plus BYO embedder, backfill, monitoring, and
canary rollout ship behind feature flags.

### Breaking change
- **`better-sqlite3` native SQLite store replaces gzipped JSON persistence.**
  The old `<sess>.checkpoints.json.gz` files are **retained as disaster-recovery
  snapshots** and auto-imported on first run via
  `migrateJsonToSqlite(stateDir)` (idempotent; re-running does not duplicate).
  `npm install` now builds the `better-sqlite3` native module. Data dir:
  `~/.pi/agent/extensions/pi-mega-compact/sqlite.db` (override with
  `MEGACOMPACT_STATE_DIR`).

### Added (by sprint)
- **Sprint 8 — SQLite storage backbone.** `src/store/sqlite.ts` is the "one
  store": `context_chunks` + `session_state` in a single in-process
  `better-sqlite3` database (WAL journal, FTS5 `trigram` tokenizer, parameterized
  queries). Chosen over async-only PGlite to keep the synchronous VectorStore.
  Versioned `compressSmart`/`decompressSmart` + async zstd helper in
  `src/store/compression.ts`.
- **Sprints 9–12 — Dedup tiers.**
  - L0 exact content-hash collapse (Sprint 9/10).
  - L1 MinHash/LSH near-dup verification (`minhash_signatures`, `dedup_lsh_buckets`)
    (Sprint 11).
  - L2 semantic cosine dedup + MMR retrieval diversity (`TrigramEmbedder`, 512-dim;
    `search()` uses heap top-k + `mmrRerank`); offline **SemDeDup** marks redundant
    rows `dedup_status='removed'` (kept, not deleted, excluded from retrieval)
    (Sprint 12).
  - **BYO localhost embedder (Sprint 12 addendum):** `src/httpEmbedder.ts` talks
    to a user-spawned **loopback-only** embedding server via
    `MEGACOMPACT_EMBEDDING_URL` (remote hosts rejected at config time,
    PREVENT-PI-004). Synchronous bridge via `spawnSync` of a child-process worker
    (own event loop) — avoids the `Atomics.wait` deadlock. `MEGACOMPACT_EMBEDDING_KEY`
    / `_HEADERS` / `_DIM` supported.
- **Sprint 13 — RAPTOR pre-compression.** Hierarchical summary tree
  (`raptor_nodes`) built before the dedup pipeline, with k-means++, extractive
  default + optional localhost Ollama, 4-layer hallucination guardrails, and a
  staged retrieval pass. **Shadow mode by default** (`RAPTOR_ENABLED=false`)
  builds + logs to `events.log` but does not serve retrieval.
- **Sprint 14 — Full pipeline.** Single config source (`src/config/dedup.ts`:
  `DedupConfig` / `loadDedupConfig()`) for all tier flags + thresholds read from
  `MEGACOMPACT_*`. `MARK_ONLY_*` per-tier safe-degrade (run + record, never
  collapse). Resumable backfill orchestrator (`src/store/backfill.ts`). Local
  monitoring (`src/monitoring.ts`: `events.log` + `dashboard.json`; FP-rate
  breach auto-flips a tier to `MARK_ONLY`) and canary rollout
  (`src/canary.ts`: L0→L1→L2→RAPTOR sequential, auto-disable on p95 breach).
  No network port (PREVENT-PI-004).

### Added (this release, post-Sprint 14)
- **Live agent tracking in toolbar widget.** The stats widget now shows active
  sub-agent count and current turn index in real-time:
  ```
   ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
  ```
  Tracks `agent_start`/`agent_end` and `turn_start`/`turn_end` events from pi.
- `VectorStore.topSimilar(n)` — the n most cosine-similar checkpoints to the
  current one (self-excluded), with unit tests.
- Handler-level integration suite (`extensions/mega-compact.test.ts`) driving
  the compiled extension through a faithful mock pi.
- `scripts/dedup-restore-drill.sh` — SQLite integrity + rebuild-from-JSON DR
  validation.
- `docs/RETENTION_POLICY.md` (TTL 90d, soft-delete via `dedup_status='removed'`,
  VACUUM cadence) and `docs/DEDUP_RUNBOOK.md` (SEV tiers + first-15-min
  checklist + MARK_ONLY degrade).

### Fixed
- **Auto-trigger fired in a live pi session for the first time.** Two bugs
  made the auto-pipeline dead code in real use despite green unit/engine tests:
  - The `context` handler's `if (!ctx.isIdle()) return` guard blocked all
    auto-compaction — `ContextEvent` fires *before each LLM call* (mid-turn),
    so `isIdle()` is always false there. Removed; debounce + anchor-floor /
    tool-pair guards already protect message integrity.
  - Auto-inline recall only triggered on `session_start` reason
    `resume`/`fork`, but `pi --continue` emits reason `startup` with a
    populated window. Broadened to recall whenever the session has persisted
    checkpoints and a usable query (brand-new empty sessions are excluded).
- `STATE_DIR_DEFAULT` now points at the real install path
  (`~/.pi/agent/extensions/pi-mega-compact`).

### Verified (live)
- A real `pi --print` session persisted `chkpt_001` to the SQLite store; a
  subsequent `pi --continue` auto-inlined it via `before_agent_start`
  (`event:"auto-inline", injected:["chkpt_001"]`).



## v0.1.0 (2026-07-11)

First tagged release. The full local, vector-backed compaction pipeline is wired
end-to-end as a pi extension — no remote MCP server, all processing local.

### Added
- **Layer 1 — Supersede**: zero-cost pruning of obsolete file reads
  (`supersede.ts`).
- **Layer 2 — Collapse**: heuristic summarization (`compact.ts`:
  `summarizeMessages`, `mergeCompactSummaries`, `autoCompactCheck`).
- **Layer 3 — Cluster / vector store**: deterministic trigram-bag embedder
  (`embedder.ts`) + gzipped on-disk checkpoint persistence (`store.ts`) +
  `VectorStore` (`vectorStore.ts`) with `add / search / dedupe` and
  cosine near-duplicate collapse at `DEDUP_SIM=0.90`.
- **Layer 4 — Persist + trigger**: `engine.ts` `compactSession()` Trident
  pipeline (SUPERSEDE → COLLAPSE → CLUSTER) and `extensions/mega-compact.ts`
  wiring — config load, session state reset, the auto-trigger
  (`context` → % fast-gate → `autoCompactCheck` → persist → context drop
  honoring the anchor floor + tool-pair guards), and `session_before_compact`
  cancellation once a checkpoint is persisted.
- **Layer 5 — Unified recall**: `recall.ts` `recallAndInline()` is the
  single injection path serving three entry points through one dedup engine:
  - Auto-inline on `session_start` (resume/fork) and `session_tree`, gated by
    `MEGACOMPACT_AUTO_INLINE`, injected via the `before_agent_start`
    system-prompt prepend (PREVENT-PI-003).
  - On-demand `/recall-context [query]`.
  - The dedup sentinel (`mega-compact-marker` entry) so no region is
    re-vectorized or re-injected.
- **Adapter boundary** (`adapt.ts`): the one pi↔engine message conversion,
  index-aligned so drop-range indices map straight back onto real messages.
- **Commands**: `/megacompact [summary...]`, `/recall-context [query]`,
  `/megacompact-status` (now with live store stats: checkpoint count, tokens,
  last chkpt, injected count, dedup hit-rate).
- **Status-bar chip** with parity to neuralwatt-mcr (compaction %, chkpt id,
  "recalled N chkpt").
- **Structured logging** to `~/.pi/agent/extensions/mega-compact.log`
  (gated by `MEGACOMPACT_DEBUG`), best-effort (never throws into the
  extension).
- **Test suite**: 52 unit tests across all engine modules + the vector store,
  run via `node --test` on the compiled output.
- **Guardrails**: agent-guardrails Four-Laws / scope / secrets / regression gate
  active from Sprint 0; `guardrails-scan` + `regression_check` both green.

### Config (env-backed, see README)
`MEGACOMPACT_FAST_GATE_PCT`, `MEGACOMPACT_THRESHOLD_TOKENS`,
`MEGACOMPACT_ANCHOR_USER_MESSAGES`, `MEGACOMPACT_PRESERVE_RECENT`,
`MEGACOMPACT_AUTO`, `MEGACOMPACT_AUTO_INLINE`, `MEGACOMPACT_AUTO_INLINE_K`,
`MEGACOMPACT_DEDUP_SIM`, `MEGACOMPACT_STATE_DIR`, `MEGACOMPACT_DEBUG`.
