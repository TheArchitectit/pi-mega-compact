# Changelog

## v0.4.26 (2026-07-16)

Fix PGlite WASM corruption when multiple test workers hit the shared global
vector index directory concurrently. Five test failures (dedup-engine,
sprint10, sprint12, vectorIndex) reduced to zero.

### Fixed
- **Multi-process PGlite corruption.** `VectorStore.add()` fired a
  fire-and-forget `upsertEmbedding()` on every checkpoint add. Under
  `node --test`'s parallel file execution, 20 workers each spawned their own
  PGlite WASM instance on the same data directory simultaneously — concurrent
  writes corrupted the `pg_control` file, producing `RuntimeError:
  terminated.aborted` on every subsequent init. Moved the index mirror from
  per-add (`vectorStore.ts`) to per-compaction (`mega-pipeline.ts`), so only
  the main runtime process ever touches the global directory.
- **Unrecoverable index after corruption.** Once `pg_control` was corrupted,
  every `new PGlite({ dataDir })` aborted immediately — the only fix was
  manual `rm -rf`. `initVectorIndex()` now catches WASM `RuntimeError`,
  deletes the corrupted data directory, and retries once. The next startup
  rebuilds the index from the authoritative `node:sqlite` store.

### Changed
- **`closeVectorIndex()` resets the `disabled` flag.** Previously, once the
  kill-switch (`MEGACOMPACT_PGLITE_DISABLED`) was tested and the index closed,
  subsequent calls to `initVectorIndex()` in the same process silently
  returned `undefined` even without the env var set. The `disabled` flag is
  now reset on close, matching the expected lifecycle.
- **`isVectorIndexDisabled()` exported.** Test and pipeline code can now check
  the kill-switch state without side effects.

## v0.4.24 (2026-07-15)

Fix "dashboard server failed to start" being a silent, undiagnosable error.

### Fixed
- **Silent dashboard start failures.** The dashboard server ran as a detached
  child with `stdio: "ignore"`, so any crash *before* the first log line
  (notably an ESM module-load/parse error, or a missing server entry) died
  with no output — and the `/dashboard` command's "check logs" message pointed
  at an **empty** `_dashboard-launch.log`. The launcher now redirects the
  child's stderr into the launch log, so the real cause is always captured.
- **Stale `port.pid` short-circuit.** `launchDashboardServer` returned the port
  from an existing `port.pid` *without* checking that a server was actually
  listening on it. A stale marker (from a crashed/orphaned prior run) made
  `/dashboard` report success on a dead port — or, worse, blocked a fresh bind.
  The server now probes `http://localhost:<port>/api/version` before reusing a
  marker and drops it (and rebinds fresh) when nothing answers.
- **Server runtime logging.** The dashboard server now mirrors every
  lifecycle event (launch, stale marker detected, port-scan, listen failure,
  ready) into `<stateDir>/dashboard.log`, so a failed or slow start is always
  inspectable.

### Added
- `dashboard.log` written by the running server into the per-repo state dir.
- Integration tests covering the stale-`port.pid` rebind and the new log file.

## v0.4.0 (2026-07-14)

Per-repo state isolation, a stable live dedup rate, and real-time agent
activity in the toolbar. No breaking change to the SQLite store schema or the
dedup pipeline — the on-disk location of runtime state moves from a single
global dir to one dir per git repo.

### Added
- **Per-repo state dir.** Each git repo gets its own isolated store at
  `<repo>/.pi/mega-compact/` (checkpoints SQLite db, `events.log`,
  `dashboard.json`, `dedup-stats.json`). The store is scoped by repo root, so
  cross-repo dedup stats, checkpoints, and `/mega-recall` results are fully
  isolated — a new repo starts with `dedup: 0.0%` and 0 checkpoints instead of
  inheriting another repo's numbers. The dir is **tracked in git** (not
  gitignored) so context travels with the clone and stays resumeable across
  devices. Non-git cwds fall back to `MEGACOMPACT_STATE_DIR` (or the global
  default).
- **Stable storage dedup rate.** The widget/dashboard now show a cumulative
  *storage* dedup rate (`deduped adds / total adds`), persisted in
  `dedup-stats.json` and surviving session restarts. Previously the widget used
  a per-session closure counter that reset on every session instance, so the
  rate read `—`/`0%` on a fresh session even after heavy dedup. Sub-10% rates
  render with a decimal (e.g. `2.5%`); zero attempts show `0.0%` rather than
  `—`, so the field is always populated.
- **Live agent activity on the toolbar status line.** `agent_start`/`agent_end`
  now push `mega-compact: ▶ N agents` to the status text (not just the
  above-editor widget), so concurrent sub-agents are visible while they run.
  Restores to `mega-compact: ready` when idle.
- **Published to npm.** `pi-mega-compact@0.4.0` is on the public registry
  (under `architectit`); install with `npm install pi-mega-compact`. The package
  ships source (`src/` + `extensions/`); build with `npm run build` if you run
  the compiled entry or the OpenClaw adapter.

### Fixed
- `bindRepo()` honors the explicit `MEGACOMPACT_STATE_DIR` override for non-git
  cwds (regression where it fell back to the hardcoded global default instead).
- All 278 tests pass.

### Docs
- `README.md` and `docs/INSTALL_AND_USAGE.md` note the per-repo state location
  and the `MEGACOMPACT_STATE_DIR` fallback semantics.
- Install docs (`README.md`, `docs/INSTALL_AND_USAGE.md`, `TESTER_GUIDE.md`,
  `RELEASE_NOTES.md`) now lead with `npm install pi-mega-compact`; git-clone is
  the documented development path.

## v0.3.0 (2026-07-13)

OpenClaw plugin support plus an expanded, graded test suite. Additive on top of
v0.2.0 — no breaking changes to the SQLite store or dedup pipeline.

### Added
- **OpenClaw plugin adapter** (`extensions/openclaw-mega-compact.ts` +
  `openclaw.plugin.json`). Exposes pi-mega-compact to OpenClaw as a
  `CompactionProvider` via the new `openclaw` package field. The SQLite store,
  dedup tiers, and recall engine are unchanged — this is a second runtime
  adapter beside the pi extension entry.
- **Graded test suites (278 tests total, up from 192):**
  - `src/dedup-engine.test.ts` — dedicated compaction + dedupe engine suite.
  - `src/e2e.test.ts` — comprehensive end-to-end compression + dedup suite (26 tests).
  - `src/ratio.bench.test.ts` — compaction-ratio / storage benchmark tests.
- `RELEASE_NOTES.md` (GitHub release body source) and `TESTER_GUIDE.md`
  (QA manual-test checklist + bug-report template).
- `.gitignore` now excludes the OpenClaw build/state artifacts.

### Docs
- `SPRINT_PLAN.md` and `TESTER_GUIDE.md` updated for the v0.3.0 plugin surface;
  `docs/HEADER_MAP.md` / `docs/INDEX_MAP.md` re-mapped.

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
- **Test suite grew from 52 (v0.1.0) to 192 tests**, all passing (`node --test`).
  New coverage: L0/L1/L2 dedup tiers, `topSimilar`, compression roundtrip,
  handler-level integration, dashboard server, stats edge cases.

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
  - On-demand `/mega-recall [query]`.
  - The dedup sentinel (`mega-compact-marker` entry) so no region is
    re-vectorized or re-injected.
- **Adapter boundary** (`adapt.ts`): the one pi↔engine message conversion,
  index-aligned so drop-range indices map straight back onto real messages.
- **Commands**: `/mega-compact [summary...]`, `/mega-recall [query]`,
  `/mega-status` (now with live store stats: checkpoint count, tokens,
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
