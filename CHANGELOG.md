# Changelog

## v0.5.0-unreleased — Sprint S17 (cross-repo recall)

Wire the built-but-unused PGlite HNSW cross-repo index into the live recall path.

### Added
- **Cross-repo recall on resume.** `session_start` now uses the new
  `doRecallAsync` (in `mega-pipeline.ts`): runs the sync same-repo scan first,
  and when this repo's store is thin (`< autoInlineK` hits) AND cross-repo is
  enabled, awaits the PGlite HNSW index over every repo and merges the results.
  Cross-repo hits use a stricter cosine floor (`MEGACOMPACT_CROSSREPO_COSINE`,
  default 0.90) and are labeled with their source repo in the recall block. The
  `recallMaxTokens` cap + window-dedupe apply to the merged set, so cross-repo
  can never net-inflate the window. `session_start` is an async-safe point; the
  mid-turn `context` handler stays sync (no await).
- **`/mega-recall --cross-repo`** searches all repos via the HNSW index.
- **Source-repo labels.** `SearchHit` gains an optional `repoId` (the foreign
  repo's stateDir), populated by `searchAsync` for cross-repo hits.
  `formatRecallBlock` renders `(from repo <name>)` for foreign checkpoints;
  same-repo hits stay unlabeled.
- Config: `MEGACOMPACT_CROSSREPO_ENABLED` (default true),
  `MEGACOMPACT_CROSSREPO_COSINE` (default 0.90).

### Tests
- 2 new `recall.test.ts` tests (source label present for cross-repo, absent for
  same-repo). Full `mega-compact.test.ts` suite green (26/26).

## v0.5.0-unreleased — Sprint S16 (compaction continuity)

Fix the live bug where pi STOPPED after our auto-compact. `ctx.compact()` mapped
to pi's manual compaction path, which aborts the in-flight turn and stops the
agent. The auto-trigger now returns a trimmed message view from the `context`
event (live trim every LLM call, no abort) and relies on pi's native
auto-compaction for the durable disk trim (which continues). Compact-and-continue.

### Changed
- **Live context-event trim (S16).** `buildLiveTrimmedView()` /
  `computeLiveTrimCut()` (new `extensions/mega-trim.ts`) collapse the compacted
  region to a summary + recent anchor and return it from the `context` handler.
  The model sees a compacted window every call; pi never aborts. Non-destructive
  (the real transcript is untouched); an unsafe cut / below-anchor-floor returns
  nothing so the next context event retries. The cut is computed on the engine
  view then mapped back onto the original `AgentMessage[]` (lossless, like
  `dropCompactedRange`), with a synthesized user-role summary message prepended.
  Honors PREVENT-PI-001 (anchor floor) + PREVENT-PI-002 (no split tool pair).
- **Removed `ctx.compact()` from the auto-trigger (default).** The durable disk
  trim now comes from pi's native auto-compaction (agent-end, continues) via the
  existing `session_before_compact` handler. The v0.4.28 `piCompactWouldNoop`
  gate is kept behind the legacy flag only.
- **`MEGACOMPACT_LEGACY_DURABLE_TRIM`** (default false) restores v0.4.28
  (ctx.compact + no-op gate) as a one-release rollback. Read live from env so it
  can be toggled without reloading the module.
- **`MEGACOMPACT_ANCHOR_USER_MESSAGES`** is now also read live from env at the
  context handler (config value is the cached default), so the anchor floor can
  be tuned per-test / per-run.
- **Guarded resume nudge.** `agent_end` sends one `sendUserMessage` continuation
  nudge (debounced 30s via `runtime.resumeNudgeUntil`) only when truly idle +
  queued, so a turn never stalls post-compact and never busy-loops.

### Tests
- New `mega-trim.test.ts` (4 unit tests) + 4 S16 integration tests in
  `mega-compact.test.ts`: live trim fires (no `ctx.compact`), below-anchor-floor
  skips, idle+queued nudge guarded, durable trim still supplied via native
  auto-compaction. Legacy `ctx.compact` path preserved behind the flag.

## v0.4.28 (2026-07-15)

Fix the user-facing `Compaction failed: Nothing to compact (session too small)`
error that the auto-trigger surfaced whenever pi's native compaction had
nothing durable to trim.

### Fixed
- **"Nothing to compact" thrown to the user by the auto-trigger.** The
  `context` handler auto-fired `ctx.compact()` based on *in-memory* token
  pressure (our threshold), but pi's `compact()` throws "Nothing to compact
  (session too small)" when the *on-disk* transcript is below its
  `keepRecentTokens` budget (default 20k). The throw fires inside pi's
  `compact()` *before* `session_before_compact` is emitted, so our handler
  there can never intercept it; and `ctx.compact()`'s `onError` callback runs
  only *after* pi has already emitted a `compaction_end` event carrying the
  error message (which the interactive UI renders), so `onError` cannot mute
  it either. Added `piCompactWouldNoop(ctx)` (in `mega-pipeline.ts`): before
  calling `ctx.compact()`, the auto-trigger reads `ctx.sessionManager.getBranch()`
  and skips the call when pi would no-op — mirroring pi's `prepareCompaction`
  return-undefined conditions (last entry is a compaction → "Already
  compacted"; <2 cut-point messages or transcript under the
  `keepRecentTokens` budget → "Nothing to compact"). Skipping is correct, not
  a compromise: by then our own recall checkpoint (`runCompact`, Path A) is
  already persisted, and the durable on-disk trim is unnecessary for a
  transcript small enough that reloading it on resume isn't a token-growth
  problem. (pi's own silent `_runAutoCompaction` path handles the same
  condition with a `return false`; we're forced through the throwing public
  path because that's all the extension API exposes.)
- **v0.4.27's `doCompact` small-session fallback** (compacting all-but-last
  for short sessions) remains, but it alone never fixed this — the error
  came from pi, not our `runCompact`. The gate above is the actual fix.

### Added
- `MEGACOMPACT_DURABLE_TRIM_FLOOR` env override (default 20000 = pi's
  `keepRecentTokens` default). Raise it if you raise pi's
  `compact.keepRecentTokens`, so the gate keeps predicting pi's no-op
  threshold correctly.

### Tests
- New `piCompactWouldNoop` integration tests in `mega-compact.test.ts`: the
  positive path (compactable transcript → `ctx.compact()` still called) and
  the skip path (small transcript → `ctx.compact()` skipped, recall checkpoint
  still persisted, no error). Mock `sessionManager` now exposes `getBranch()`.

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
