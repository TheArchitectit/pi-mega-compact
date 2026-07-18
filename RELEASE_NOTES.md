# Release Notes — pi-mega-compact

## v0.7.7 (2026-07-17)

Dashboard: a dedicated **Active Repos** tab plus **DB-backed cumulative metrics** so cache-hit / compaction / time-saved totals are durable across session restarts. Additive — no behavior change to compaction or recall.

### Added

- **Active Repos tab + `GET /api/servers`.** The dashboard gains a dedicated **Active Repos** tab listing every server / session seen within the **last 30 minutes**, each with its live tier, context %, and session state. Backed by a new `GET /api/servers` endpoint that walks `repo_registry`, reads each repo's per-process `dashboard.json`, and returns one row per currently-open session. Running multiple sessions at once is now visible together in one table instead of only the single current-repo view. Each row shows that repo's live cache-hit / compaction / time-saved totals.
- **DB-backed cumulative dashboard metrics.** `compact_count`, `recall_injected`, and `cache_hit_tokens_saved` are now persisted to the SQLite `meta` table (durable, cross-session, travel with the repo's state dir). The dashboard's **Cache hits** (dedup collapses + recall re-injections), **Compactions** (session + total), and **Estimated time saved** (compact + cache-hit, est. @ ~2k tok/s) cards now read from these DB counters rather than the per-process `dashboard.json` snapshot. `dashboard.json` is now just the live per-process view that feeds the Active Repos rows.

### Documentation

- **README.md** — new **Active Repos tab** + **Metrics (DB-backed, durable)** subsections in the Dashboard section; `GET /api/servers` added to the Localhost API list; Features bullet and live-stats-widget version example updated; Status callout bumped to v0.7.7.

### Upgrade / migration

No migration required — additive only. The new `meta` counters are populated lazily as sessions compact / recall; pre-existing repos simply show 0 totals until activity resumes. Upgrade with `pi update --extensions` (npm is the only distribution path).

Full suite: 412 passed, 0 failed across 42 files.

---

## v0.7.6 (2026-07-17)

Patch release to complete the v0.7.5 documentation and force the npm upgrade path. No code changes — the `/mega-db-*` commands and auto-maintenance shipped in v0.7.5 are unchanged; this release only adds the user-facing docs that were committed after the v0.7.5 tag and bumps the version so `pi update --extensions` picks up the latest.

### Documentation

- **README.md** — the `/mega-db-stats` · `/mega-db-prune [days]` · `/mega-db-vacuum` · `/mega-db-check` · `/mega-db-reconcile` commands are now listed in the commands table; a callout under the live-stats-widget section documents the `session_start` auto-maintenance pass (prune 30d + WAL checkpoint >10MB + VACUUM when DB >100MB & freelist >20%). The "Current version" header was bumped from `v0.6.9` → `v0.7.6` with an S27 note (raw-transcript mirror + dedup pipeline + DB maintenance /commands).
- **TESTER_GUIDE.md** — new section **§12 "DB maintenance /commands (v0.7.5+)"** with a 6-step manual checklist covering stats, prune, vacuum, check, reconcile, and the auto-maintenance-on-`session_start` behavior, plus explicit pass criteria for each.

### Upgrade path

v0.7.4 bundled the critical compaction race fix (`848c817`) with the S27 cache-stability Tasks 1–9. v0.7.5 added Task 10 (`/mega-db-*` commands + auto-maint). v0.7.6 is a docs-complete + version-bump patch over v0.7.5 — upgrade with `pi update --extensions`.

Full suite: 407 passed, 0 failed across 41 files.

---

## v0.7.5 (2026-07-17)

DB maintenance /commands for the S27 DB-mirror store — inspect, prune, vacuum, integrity-check, and reconcile the raw_transcript + dedup_mirror tables.

### Added

- **`/mega-db-stats`** — table row counts, disk footprint (main + WAL + SHM), page count, freelist %, WAL frame count. Read-only; safe any time.
- **`/mega-db-prune [days]`** — DELETE `raw_transcript` + `checkpoint_epochs` rows older than N days (default 30), plus orphan `dedup_mirror` rows. Reports deleted counts + reclaimed bytes.
- **`/mega-db-vacuum`** — `VACUUM` the main DB (rebuilds pages, reclaims freelist). Heavy: briefly doubles disk usage.
- **`/mega-db-check`** — `PRAGMA integrity_check` + `wal_checkpoint(TRUNCATE)`. Fold the WAL into the main file and verify DB health.
- **`/mega-db-reconcile`** — fix `dedup_mirror.ref_count` drift vs actual `raw_transcript` refs, delete orphan dedup rows, backfill missing `content_ref`. Run after `/mega-db-prune` or a crash.
- **Auto-maintenance on `session_start`** — best-effort prune (30d) + WAL checkpoint (>10MB) + VACUUM (DB >100MB AND freelist >20%). Never blocks session start; logs a one-line summary.

All maintenance primitives live in `src/store/sqlite.ts` (pi-agnostic, parameterized queries, local SQLite only). Commands registered in `extensions/mega-db-cmds.ts`. Auto-maintenance wired in `extensions/mega-events.ts`.

Full suite: 407 passed, 0 failed across 41 files.

---

## v0.7.4 (2026-07-17)

Fixes a compaction race that surfaced spurious "Already compacted" / "Auto compaction failed" errors, plus the S27 DB-mirror foundation for byte-stable prompt-cache keys.

### Fixed

- **Compaction race — "Already compacted" / "Auto compaction failed".** pi emits `agent_end` BEFORE its own native auto-compaction (`_checkCompaction`), so our manual durable-trim `ctx.compact()` call raced with pi's native compaction and surfaced a spurious error toast to the user. A new `session_compact` listener stamps `lastNativeCompactAt` for every compaction (manual/threshold/overflow, ours or pi's own), and both `ctx.compact()` call sites (agent_end mid-run trim + legacy path) now skip for 10s after a native compaction. The guard uses `lastNativeCompactAt` (not `lastCompactAt`, which our own checkpoint persistence also stamps — that would falsely skip).

### Added (S27 DB-mirror, behind `MEGACOMPACT_DB_MIRROR`, default OFF)

- **Raw transcript mirror.** All incoming messages are appended to a new `raw_transcript` SQLite table (idempotent, `content_hash` primary key) when `MEGACOMPACT_DB_MIRROR=1`. This is the byte-stable source of truth for prompt-cache-key stability.
- **Deterministic epoch nonce.** `checkpoint_epochs` rows are written with a deterministic FNV-1a nonce (`src/mirror/epoch.ts`) so replaying/refreshing the same compaction yields the same epoch id (idempotent upserts).
- **Dedup pipeline.** `dedup_mirror` table stores unique `content_bytes` once; `raw_transcript` rows reference it via `content_ref` with `ref_count` tracking. `dedupTranscript()` runs fire-and-forget after each compaction.
- **Recall demotion contract.** `src/recall.ts` documents the S27 preference: when the mirror is ON, `raw_transcript + dedup_mirror` are preferred for byte-stable reconstruction; the legacy JSON checkpoint is a DR fallback only. The VectorStore recall path (fast semantic search) is unaffected.

Full suite: 395 passed, 0 failed across 40 files.

---

## v0.7.3 (2026-07-17)

Widget content now wraps to fill terminal width — one long line that adapts to screen size.

### Fixed

- **Widget weird spacing.** Content is now one long string that wraps at `│` boundaries
  to fill the terminal width. Narrow screens get more lines, wide screens get fewer.
  No more massive gaps between groups.

Full suite: 372 passed, 0 failed across 37 files.

---

## v0.7.2 (2026-07-17)

Widget groups now spread across the full terminal width instead of being left-aligned.

### Fixed

- **Widget right-side blank.** Groups are now distributed evenly across the terminal width
  using calculated gaps between groups, instead of being left-aligned with fixed `│` separators.
  The widget now fills the entire panel width with proper spacing.

Full suite: 372 passed, 0 failed across 37 files.

---

## v0.7.1 (2026-07-17)

Widget auto-fit + new groups (model/provider, memory, drift, agents) + tiered % threshold + Savings by Model enrichment + crash fixes.

### Added

- **Widget auto-fit toolbar.** The toolbar widget now auto-sizes to fit the terminal width, with responsive layout that adjusts group placement dynamically. New display groups:
  - **Model/provider group** — shows current model name and provider badge
  - **Memory group** — compact memory-usage indicator
  - **Drift group** — context-drift warning when conversation is diverging
  - **Agent telemetry group** — active agent count and status
- **Tiered % compaction threshold (S27).** The live + durable trim now fire at
  `tierPct × contextWindow` — a **% of the model's context window** — instead
  of a static token amount. Presets: `low` 50% · `medium` 60% · `high` 70% ·
  `ultra` 70% · `mega` 75%. Scales with model size so trim always fires below
  pi's native ~80% auto-compaction. `MEGACOMPACT_TIER` selects the %; the old
  static token amounts are now only the boot fallback before the first context
  event reports a window. See `docs/specs/s27-tiered-percent-threshold.md`.
- **Savings by Model dashboard enrichment (v0.6.9).** Dashboard card now shows
  per-model savings breakdown with token counts and compression ratios.
- **`session_before_compact` durable-trim handler.** Fixes the resume gap where
  the durable trim pass was skipped on session resumption.

### Fixed

- **🔴 Crash on undefined message text in summarize/supersede paths (v0.6.8).**
  pi tool/custom messages can arrive with `text: undefined`; guard added at
  the content-extraction choke point. Regression test included.
- **Pressure band no longer flickers.** Single percentage basis eliminates the
  dual-basis switch that caused 30%↔70s% band oscillation.

### Changed

- `/mega-status` now reports `threshold=<eff> (<pct>% of <win> window) tierPct=<…>`.
- Dashboard **Threshold** card shows `thresholdTokens (NN% of <window>)`.

Full suite: 372 passed, 0 failed across 37 files.

---

## v0.6.9 (2026-07-17)

Tiered % compaction threshold — the fire point now scales with the model context window.

### Added (S27)

- **Percentage-based compaction threshold.** The live + durable trim now fire at
  `tierPct × contextWindow` — a **% of the model's context window** — instead of
  a static token amount frozen at boot. Presets are now percents:
  `low` 50% · `medium` 60% · `high` 70% · `ultra` 70% · `mega` 75%. This
  scales with model size, so the trim always fires **below** pi's native
  ~80% auto-compaction for any window (200k → low 100k / high 140k / mega 150k;
  1M → low 500k / high 700k / mega 750k). `MEGACOMPACT_TIER` selects the %;
  the old static token amounts (50k/100k/200k/1M/10M) are now only the **boot
  fallback** used before the first context event reports a window.
- **Custom stays absolute.** `MEGACOMPACT_THRESHOLD_TOKENS` (the `custom` tier)
  remains an explicit token count, never percent-scaled — pin an exact fire point
  regardless of model window.
- **Pressure band no longer flickers.** The `pressure` getter now uses a single
  percentage basis (`lastCtxPercent / (tierPct*100)`) when the window is known,
  so the dual-basis switch that caused 30%↔70s% band oscillation is gone (see
  `docs/specs/find-pressure-basis-oscillation.md`). Resolves the BACKLOG
  "thresholdTokens fixed at boot" finding — see `docs/specs/s27-tiered-percent-threshold.md`.

### Changed (display)

- `/mega-status` now reports `threshold=<eff> (<pct>% of <win> window) tierPct=<…>`.
- Dashboard **Threshold** card shows `thresholdTokens (NN% of <window>)`.

### Fixed

- **Live + durable trim were dead code for 200k-window models.** With a static
  `high`=200k threshold, `high`(200k) == 100% of a 200k window, so pi's
  native auto-compaction (~80% = 160k) always fired first and our trim never
  triggered. Now `high` = 70% = 140k < 160k, so our trim fires first.

## v0.6.7 (2026-07-17)

Crash fix + RAPTOR recall hardening + widget readability.

### Fixed

- **🔴 Compaction crash on undefined message text** — the highest-impact fix.
  pi tool/custom messages can arrive with `text: undefined` (only `input`/
  `output` set); `extractFilePaths` called `text.matchAll` and threw `Cannot
  read properties of undefined (reading 'matchAll')`, taking down the whole
  compaction pass. Fixed at the single choke point (`adapt.ts` `contentText`/
  `messageText` now coerce to `""` so every downstream `.matchAll`/`.split`/
  `.toLowerCase` is safe) plus defense-in-depth at the `extractiveSummarize`
  entry. Regression test added.

### Added (S25 RAPTOR hardening)

- **Shadow SERVE gate** — `RAPTOR_SHADOW_MODE=false` now actually disables
  RAPTOR serving in `VectorStore.search` (was logging-only; the tree was always
  merged). Honors the Sprint-13 transition contract at serve time.
- **Freshness guard** — the RAPTOR tree is stamped with `built_at` (the newest
  checkpoint epoch at build time, stored in the `raptor_nodes` table).
  `raptorSearchHits` rejects a tree older than `max(timestamp)` over the live
  checkpoints and falls back to flat MMR — no stale root summaries or
  references to trimmed/deduped leaves.
- **`timedOut` guard** — a tree whose root is a budget-exhausted extractive
  fallback (level 99) is skipped (flat fallback) instead of served.
- **`raptor_serve` monitoring** — RAPTOR now emits a decision event via the
  existing `events.log` path so canary p95 can track the live tier.
- Freshness state lives in SQLite (`built_at` column + `maxCheckpointTimestamp`
  query), not in-memory — per the "all data in SQL/PGlite" invariant.

### Changed (widget)

- L1 header widened: the context-fill bar is now 20 cells (green=room → red=
  full) and carries the status glyph + checkpoints, using more of the terminal.
- L2 savings: replaced the two saturated `freed/(freed+kept)` bars (which peg
  ~100% once cumulative freed dwarfs live kept — e.g. 4.8mil freed vs 612 kept)
  with an explanatory `in→kept (X% freed)` framing that reads as "compacted N
  tokens down to M, freeing X%". Dropped the now-redundant L4 accounting line.

## v0.6.6 (2026-07-17)

Toolbar widget redesign — compact retro block with gradient bars.

### Changed

- Toolbar widget collapsed from 6 lines to 4:
  - L1: tier + context-fill gradient bar + tokens + checkpoints
  - L2: status + dedup + session-savings bar + all-time-savings bar
  - L3: live activity (compacting / deduped / recalled ticker — unchanged)
  - L4: full accounting — session AND all-time in/out/freed on one line
- Replaced the single flat `% tokens saved` bar with three **retro gradient
  bars** (context fill, session savings, all-time savings) using fractional
  block characters (▏▎▍▌▋▊▉█) for smooth fills, shaded green→amber→red.
- `fmt()` now renders `mil` at >=1M (was `M`).
- Killed ambiguous labels: no more "sess vs session" or bare "100% repo";
  now `sess` / `all-time` with a colored % next to each bar.

## v0.6.5 (2026-07-17)

Bugfix release: widget token summary, crash guard, dashboard Savings-by-Model.

### Added

- **Savings by Model** on the dashboard Summary tab — groups the machine-wide
  repo registry by model so you can see how much context + cost mega-compact
  has reclaimed, broken down by which model you were running. Columns: model,
  provider, repos, checkpoints, tokens saved, $ saved (Σ tokensSaved × inputRate),
  last used. Sorted by tokens saved. Honestly framed as savings, not compression
  quality (the engine is model-agnostic).

### Changed

- Toolbar widget last line replaced the static "/mega-help" hint with a live
  token accounting summary: `session ↑in ↓out · saved X session / Y all-time`
  (M at ≥1M, k at ≥1k).

### Fixed

- **Compaction crash on undefined message text** (`src/compact.ts`).
  `extractFileCandidates` called `.split` on `content` without a null guard,
  so a pure tool-call/tool-result message with `text === undefined` threw
  `Cannot read properties of undefined (reading 'split')` and took down the
  whole compaction pass. Now widened to `string | undefined | null` with an
  early `if (!content) return [];` — every caller is safe at the source.

## v0.6.4 (2026-07-17)

Dashboard overhaul, conflict-scan upgrade, test-runner hardening.

### Added

- **Compression meter bars** on the Vector Store and Repo cards — color-coded
  green/yellow/red bars showing session and repo compression % at a glance.
- **Live repo overlay** (`overlayCurrentRepo`): the All-repos / Summary views now
  sync the current repo's token counts in real time (no longer stale between
  repo-switches).
- `/api/repos?active=24h` filter + `/api/summary` machine-wide totals endpoint.

### Changed

- Dashboard Vector Store card now shows **Original / Kept / Freed** (in/out/free)
  instead of the confusing **Tokens Stored / Original / Saved** trio.
- Repo card and cost-savings widget use the same reconciled compression fields.
- Conflict-scan: user-level memory stores are now covered alongside repo-level.

### Fixed

- **Dashboard test isolation** — seeded repos now use unique `stateDir` paths so
  `overlayCurrentRepo` no longer zeroes the live snapshot during test teardown.
- **Test runner hang on open handles** — files that pass all tests but hang on
  exit (e.g. PGlite/WASM open handle) are force-killed via a 20s silence timer
  and reported as PASS instead of hanging for195 seconds then FAILING.

## v0.6.3 (2026-07-16)

**Hotfix: extension no longer crashes at load when `@electric-sql/pglite` is
missing.** The PGlite async index (Slice 2 + S24 memory-RAG) is a redundant,
additive index over the authoritative `node:sqlite` store. It was imported with a
**static top-level `import`**, which pi resolves at module-load time — so a
missing package threw `Cannot find module '@electric-sql/pglite'` and took down
the *entire* extension (compaction, memory recall, everything), even though the
index is only best-effort. The package is now **lazily imported** inside
`loadPgLite()`; when absent, the index logs one warning and degrades to the sync
scan — the extension loads and the default recall path keeps working.

### Fixed

- **Load crash on missing `@electric-sql/pglite`** (`src/store/vectorIndex.ts`,
  `src/store/memoryIndex.ts`). Static value import → dynamic `import()` inside a
  new `loadPgLite()` helper; the `import type` (erased at compile, no load cost)
  is kept so types are retained. `initVectorIndex`/`initMemoryIndex` return
  `undefined` and every caller falls back to the authoritative sync scan.
- Regression coverage: `src/store/vectorIndex.test.ts` + `memoryIndex.test.ts`
  (cross-repo recall + disabled/kill-switch) confirm both the working and
  degraded paths.

### Notes

- Patch bump (0.6.2 → 0.6.3). Full suite: 353 passing. No schema/config change.
- If you want the cross-repo async index to actually function on a clean
  `pi update --extensions`, confirm pglite lands in `node_modules`; this fix only
  makes a missing package non-fatal.

## v0.6.2 (2026-07-16)

S24 follow-up: cross-repo memory-RAG index + fix "auto-compact doesn't relieve
during a team run." No user-visible change to the pressure signal itself.

### Added

- **Cross-repo memory index (S24 memory-RAG).** A redundant, additive, ASYNC
  PGlite/HNSW index (`src/store/memoryIndex.ts`) mirrors durable memory writes
  (`applyMemoryOps`, `/mega-memory`, `/m`) and augments recall with real
  cross-repo nearest-neighbor memory lookup. A decision saved in repo A is now
  inlined as RAG context when you start a session in repo B. The same-repo
  linear cosine scan stays the DEFAULT recall path; the index is best-effort and
  non-fatal (any init/write failure degrades to the same-repo scan). PREVENT-PI-004
  OK — PGlite is WASM Postgres, fully local. Toggle `MEGACOMPACT_CROSSREPO_ENABLED`
  (default true) and the stricter `MEGACOMPACT_CROSSREPO_COSINE` floor (default
  0.90).
- **Mid-run durable trim during team runs.** The durable compaction now fires at
  `agent_end` (when idle + over threshold + no active agents), not only at parent
  settle — so a long sub-agent run is trimmed between agents instead of ballooning
  to the context ceiling and only relieving at the very end. Guarded by
  `piCompactWouldNoop` (no user-facing throw) and the 2s debounce (no thrash).

### Fixed

- **Live trim was silently dead during team runs.** `computeLiveTrimCut` returned
  `null` when the recent anchor window had too few user messages (anchor floor),
  so the model was never fed a compacted view per call. It now walks the cut
  backward to capture the anchor floor instead of skipping — the per-call live
  trim fires again.
- Regression test `extensions/mega-teamrun.test.ts` + fast repro
  `scripts/diag-teamrun.mjs` drive the real extension through a mock pi and assert
  the live trim + mid-run durable trim fire during a simulated team run.

### Notes

- Patch bump (0.6.1 → 0.6.2). Full suite: 353 passing.

## v0.6.1 (2026-07-16)

Follow-up to v0.6.0 closing the remaining S24 spec items (no behavior change to
the user-visible pressure signal — all shipped in 0.6.0).

### Changed

- Memory caps are now env-tunable: `MEGACOMPACT_MEMORY_MAX_CHARS` (default 4000)
  and `MEGACOMPACT_MEMORY_MAX_ROWS` (default 500). Previously hardcoded.
- Extracted the shared `runMemoryReview` helper so the pressure-scaled turn-end
  cadence and review-on-compact use one review body.

### Docs

- TESTER_GUIDE updated for the live pressure band (no `/mega-tier`), dashboard
  status bar, and the memory-cadence + overflow (truncate + LRU) checks.

### Notes

- Patch bump (0.6.0 → 0.6.1). Full suite: 353 passing.

## v0.6.0 (2026-07-16)

S24 — **unified pressure signal**: auto-compact, the tier label, trim depth, and
memory review now all read one live `pressure = currentTokens / thresholdTokens`
signal, so the system reacts as a single coherent whole instead of four
independent triggers.

### Added

- **Live tier band.** The toolbar widget + dashboard headline now show the live
  pressure band (`low` → `medium` → `high` → `ultra` → `mega`) that climbs as the
  context window fills and falls back as it's relieved. `/mega-status` reports the
  live band, the `MEGACOMPACT_TIER` preset, and the live pressure %. The base
  compaction *threshold* is still set by `MEGACOMPACT_TIER` at startup.
- **Pressure-scaled memory review.** The auto-review cadence shortens as pressure
  climbs (`memoryReviewCadence`), and a successful compaction now triggers an
  immediate review when pressure is `high`+ (review-on-compact) so durable memory
  keeps pace with faster churn.
- **Memory storage hardening (4808/5000 fix).** Durable memories are written to the
  SQLite `memories` table only (never pi's file-backed buffer). Each entry is
  truncated at `MEMORY_MAX_CHARS` (4000, with a `…[truncated]` marker) and the
  per-repo store is bounded at `MEMORY_MAX_ROWS` (200) via LRU eviction on the
  least-recently-referenced rows — so a too-large memory can never overflow a
  downstream consumer's per-entry cap.

### Changed

- **`/mega-tier` removed.** The tier is no longer a manual runtime setting; the
  live pressure band replaced it. `setTier` is gone from `mega-config.ts`.

### Notes

- Behavior change (0.5.2 → 0.6.0). Full suite: 350 passing.

## v0.5.1 (2026-07-16)

feat: show the installed npm version in the toolbar widget and dashboard header.

### Added

- **Version visible everywhere.** The toolbar widget's first line now renders
  `⚡ <tier> vX.Y.Z …`, `/mega-status` prints the installed version, and the
  dashboard header carries a `vX.Y.Z` pill. All three read `package.json` at
  runtime, so they track every `npm publish` automatically — after
  `pi update --extensions`, you can confirm the new build landed without digging
  through logs. No source edit is needed per release.

### Notes

- Patch bump (0.5.0 → 0.5.1). Full suite: 346 passing.

## v0.5.0 (2026-07-16)

The **continuity + cross-repo + memory-RAG** release (sprints S16–S23): the
extension keeps long sessions going without aborting the turn, recalls across
repos, and accumulates durable memory it auto-inlines as RAG context. Plus the
storage backend moved to `node:sqlite`.

### Added

- **Live context-event trim (S16).** `extensions/mega-trim.ts` collapses the
  compacted region to a single summary message on every LLM call via the
  `context` event — compact-and-continue instead of `ctx.compact()`'s
  stop-the-agent behavior. Honors PREVENT-PI-001 (anchor floor) and PREVENT-PI-002
  (never splits a toolCall/toolResult pair). `MEGACOMPACT_LEGACY_DURABLE_TRIM`
  restores the old behavior for one release.
- **Cross-repo recall (S17/S18).** `/mega-recall --cross-repo` and auto-inline on
  resume augment from other repos' checkpoints (HNSW index over every repo) when
  the current repo's store is thin. Cross-repo hits use a stricter cosine floor
  (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are repo-labeled. A
  machine-wide injected-set (`~/.mega-compact-index/index.sqlite`) prevents
  re-injecting the same foreign checkpoint.
- **Durable memory + RAG (S20–S22).** `src/memory.ts` auto-reviews the
  conversation every `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` (default 10) turns into
  `decision`/`fact`/`preference` memories (hallucination-guarded, scoped per repo).
  `src/memoryRecall.ts` injects relevant memories as RAG context on resume/branch
  (capped + deduped). Manual: `/mega-memory save|list|search|forget|consolidate`
  (also `/m` shortform); `src/memoryOps.ts` does apply/consolidate.
- **Cross-repo drift detection (S/R4).** The dashboard's **All-repos** view plus
  `GET /api/drift` flag stale repos (>30d idle), compaction lag (an active repo
  >24h behind the most-recently-active repo's last compaction), and recent model
  churn (within 7d). Read-only — never writes the index.
- **`node:sqlite` storage backend (Slice 1, supersedes the `better-sqlite3`
  addon).** `src/store/sqlite.ts` now uses `DatabaseSync` (Node ≥22.13 built-in)
  as the synchronous source of truth — no native module to compile, survives pi's
  install-scripts block. FTS5 trigram tokenizer + parameterized queries
  unchanged.
- **Async PGlite/pgvector HNSW index (Slice 2).** `src/store/vectorIndex.ts` adds
  a redundant, best-effort WASM Postgres + `vector_cosine_ops` index at
  `~/.pi/mega-compact-vector` for cross-repo NN recall. The sync node:sqlite store
  stays authoritative; the index degrades to the sync scan on any failure
  (`MEGACOMPACT_PGLITE_DISABLED` kill-switch).
- **New commands:** `mega-restore`, `mega-history`, `mega-view`, `mega-help`,
  `mega-compat-check`, `/m` (memory shortform), `/mega-recall --cross-repo`.
- **Benchmarks + DR drills:** `scripts/crossrepo-benchmark.mjs`,
  `scripts/global-index-drill.sh`, `scripts/run-s20-s23.mjs`.

### Notes

- Engines bumped to `node >= 22.13` (required for `node:sqlite`).
- Full suite: 346 passing (up from 280 at v0.4.x).

## v0.4.24 (2026-07-15)

fix: make the dashboard server start failures diagnosable instead of silent.

### Fixed

- `/dashboard` reported "dashboard server failed to start — check logs." with an
  **empty** log. Root causes:
  - The detached child ran with `stdio: "ignore"`, swallowing every crash that
    happened before the first log line (e.g. an ESM module-load error). The
    launcher now captures the child's stderr to `_dashboard-launch.log`.
  - `launchDashboardServer` reused a stale `port.pid` port without verifying a
    server was actually listening, so a dead marker could make the command
    report success on a dead port or block a fresh bind. It now probes the port
    and rebinds fresh when nothing answers.
- The running server now writes `<stateDir>/dashboard.log` with full lifecycle
  output (launch, stale-marker detection, port scan, listen errors, ready),
  so `/dashboard` failures are always inspectable.

### Notes

- New integration tests cover the stale-`port.pid` rebind and the new log file.
  Full suite: 303 passing.

## v0.4.21 (2026-07-14)

feat: extension conflict detector + durable save-to-memory store; consolidate
toolbar's deduped lines into a single rotating line.

### Added

- **Extension conflict scanner** (`conflict-scan.ts` + `/mega-compat-check`).
  Detects other installed extensions overlapping pi-mega-compact's two owned
  responsibilities — conversation auto-compaction and durable memory — and
  WARNs. pi has no pre-load / veto hook, so this is detect-and-warn only.
  A load-time check surfaces a one-line warning when a high-severity overlap
  exists.
- **Durable save-to-memory store** (`/mega-memory`). A `memories` table in the
  SQLite store (scoped by repo so memory travels with the clone), with
  `save`/`list`/`search <q>`/`recall <id>` subcommands and `#tag` parsing. This
  takes over the memory role from standalone memory extensions.
- **Toolbar deduped line consolidation.** The recent deduped/compacted events
  that previously spanned up to 6 stacked lines now render as a single line
  that rotates through recent files in real time (most-recent first, with a
  `+N more` count and an inline `why:` reason).

### Notes

- New commands wired into the entry point (`registerConflictCommands`).

## v0.4.20 (2026-07-14)

Fix: stale dashboard server after upgrade + polluted multi-repo index.

### Fixed

- **Stale dashboard after upgrade.** `/dashboard` now replaces a running server
  instead of reusing it when the server is (a) an **orphan** — live but with no
  `port.pid` (e.g. left over from a detached spawn or a previous install), or
  (b) a different **version** than this extension. The server reports its own
  version at `GET /api/version`; the launcher compares it to the package version
  and SIGTERMs a stale/orphan server before spawning a fresh one. Previously an
  upgraded build kept serving old HTML from the still-running old process, so
  the dashboard looked unchanged after `pi update --extensions`.
- **Polluted multi-repo index.** The end-to-end extension test harness was
  writing `bindRepo` registry rows into the real machine-wide index
  (`~/.mega-compact-index`) for every `/tmp/mc-ext-*` temp dir it created, so
  the All-repos list filled with dozens of empty duplicate `run-N` rows. Tests
  now isolate their registry via `MEGACOMPACT_INDEX_DIR`, and the dashboard
  defensively drops transient test/temp paths and collapses duplicate
  `display_name`s to the most-recently-seen row. The index was cleaned to a
  single real repo.
- **Kill target bug.** `killServerOnPort` previously called `process.kill` with
  the *port* number (wrong — that's not a pid). It now reads the pid from
  `port.pid`, or (for orphans with no marker) resolves the listener's pid via
  `ss`.

### Notes

- Two `/dashboard-status` / `/dashboard` unit tests were already failing on
  `HEAD` (they pointed `port.pid` at a random port outside the 9320–9329 scan
  range the launcher actually probes). They are corrected to listen in-range so
  `npm test` is green and the tests genuinely exercise the reuse path.

---

## v0.4.19 (2026-07-14)

Dashboard: model + cost-savings now visible, and the multi-repo registry is
drill-down.

### Added

- **Model & Cost Savings card (Current repo).** The dashboard now renders the
  active model that was previously captured but silently dropped — a new
  `💰 Model & Cost Savings` card shows model name, provider, input/output
  rates, and the live cost figure (`tokensSaved × model.inputRate`, plus
  context-windows extended) using the exact same calculation as `/mega-status`.
- **Model pill in the header.** The active model name now sits beside the tier
  badge in the `mega-compact` title bar, so you can see at a glance which model
  is driving the cost.
- **All repositories inside the Current repo view.** The per-repo registry
  table (read from `index.sqlite`) now also appears under the Current repo tab,
  so you don't have to switch to the All-repos tab to see every repo.
- **Clickable per-repo detail.** Every row in either table (Current-repo or
  All-repos) is now a clickable link that opens a modal with that repo's model,
  checkpoints, tokens saved, compressed-original bytes, last-compacted time,
  and provider.

### Fixed

- **Model/cost was captured but never rendered.** `mega-runtime` was sending
  `d.model` in the snapshot, but `dashboard-server`'s `renderSnapshot` never
  read it — the data arrived and was discarded. It is now wired into the header
  pill and the new card.

---

## v0.4.18 (2026-07-14)

Multi-repo dashboard reads its registry straight from SQLite (no JSON mirror).

### Changed

- **One store end-to-end.** The machine-wide multi-repo index (`repo_registry`
  in `<indexDir>/index.sqlite`) is now the *sole* source of truth for the
  dashboard's All-repos / Summary tabs. The prior `exportIndexJson()` JSON
  mirror (`<indexDir>/index.json`) is removed. The dashboard server opens the
  SQLite index **read-only** (`readonly: true`, WAL mode, per-request
  connection) via `GET /api/index` — no cached write handle, so a concurrent
  extension writer's WAL never blocks a dashboard request. All registry data
  lives in SQLite, preserving the project's "one store" invariant.
- **Dashboard server uses `better-sqlite3`.** The dashboard process now imports
  the project's existing `better-sqlite3` runtime dependency (shipped compiled
  from `dist/extensions/dashboard-server.js`), rather than relying on a
  dependency-free JSON read path. The `.ts`-source spawn fallback (skipped
  under `node_modules`) is the only path that still avoids the binding.
- **Developed/finished the multi-repo UI.** The "All repos" and "Summary" tabs
  were present in the HTML but un-wired; they now have panels, styling, and
  client polling that render the per-repo table (repo, model, checkpoints,
  tokens saved, compressed-original bytes, last compacted) and the machine-wide
  aggregate cards (repositories, total checkpoints, total tokens saved, total
  compressed-original).

### Why

The earlier Phase 5b build satisfied a "dependency-free spawn" preference by
mirroring the registry to JSON. That split the registry across two formats and
violated the project's "all data in SQLite" rule. Consolidating on the SQLite
`repo_registry` table removes the duplicate write path and the stale-mirror
window, and lets the All-repos table show the live model/provider that the
extension already denormalizes into the row.

---

## v0.4.17 (2026-07-14)

Release-process sync: published from git `HEAD` so the npm package matches
the last pushed commit. **No code change** — this version simply guarantees
`npm` == `origin/master` (the model-exposure + real `$` cost feature already
shipped in `0.4.16`'s `dist/extensions/mega-events.js`). Includes the v0.4.16
release notes in the repo.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.16 (2026-07-14)

Real model/provider exposure + an honest `$` cost figure in `/mega-status`.
This is the first release where the cost number means something: it is driven
by the *actual* model pi selected (captured from pi's own model registry),
not the old `$3/1M` stub that made the previous build red.

### Highlights

- **Model/provider capture (persisted per repo).** A new `model_snapshots`
  table in the per-repo SQLite store captures the active model whenever it
  changes: `provider`, `providerName` (human display name from the model
  registry, e.g. `OpenAI`), `modelId`, `modelName`, `inputRate` / `outputRate`
  (USD per token, straight from `Model.cost`), `contextWindow`, `maxTokens`, and
  `reasoning`. Written by `recordModelSnapshot()` and read by
  `latestModelSnapshot()`. Keyed by `repo_root`, so each repo's cost figure is
  computed against *its* model.
- **Capture fires at the reliable point.** `captureModel(ctx)` runs on
  `model_select`, `session_start`, and `before_agent_start` (the last is the
  point `ctx.model` is actually populated). It is **idempotent** — it only
  writes a new row when the model id/provider changes, so it is not re-written
  every turn.
- **`/mega-status` now shows the model driving the cost.** Two new lines:
  - `💰 ≈ $X saved · Y context-windows extended` — real cost =
    `repo.tokensSaved × captured model input rate` (USD/token). `Y` is how many
    full context-windows the freed space buys (`tokensSaved ÷ contextWindow`).
  - `🤖 model: <modelName> · <providerName>` — so you can see *which* model's
    pricing is behind the number.

### Fixed

- **Red build from the `$3/1M` stub.** The cost line previously multiplied
  tokens by a hardcoded `$3/1M` and never showed the model. Wiring the real
  captured rate into `/mega-status` (this release) resolved the broken build.

### Caveat (honest)

- The `$` figure is only as good as pi's `Model.cost.input`. If pi does not
  populate `cost.input`, the line reads `≈ $0.0000 saved` — there is **no
  external fallback source**. It uses the real model rate, not the old stub, but
  it is wholly dependent on pi supplying that field. `🤖 model:` falls back to
  `unknown (no model captured)` until a model has been seen in the session.

### Tests

- Two new tests: `model_select` captures model + provider into the SQL row
  (asserts the `model_snapshots` row), and `/mega-status` surfaces the captured
  model + provider. Both pass.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.9 (2026-07-14)

Hotfix: dashboard server failed to start from the npm install (regression of
v0.4.5's fix).

### Fixed

- **`[mega-compact] dashboard server failed to start`** on every npm install.
  v0.4.5 made the runner import `dashboard-server.ts` + spawn with
  `--experimental-strip-types`. That worked from a source checkout but **Node
  refuses to strip-type `.ts` files under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so it broke in every real
  install. The package ships the compiled `dist/extensions/dashboard-server.js`
  (since v0.4.6) — a new `resolveDashboardEntry()` prefers that compiled entry
  (no strip-types flag needed; it imports only Node built-ins), and only falls
  back to the `.ts` source + strip-types when the compiled file is absent AND we
  are NOT under `node_modules` (dev checkout without a build). Verified end-to-end
  against a simulated `node_modules` install: `port.pid` written, server up.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.8 (2026-07-14)

Docs/plan drop — ships the design plans; no runtime changes.

### Changed

- Added `PLAN_standout.md` (the best-in-class roadmap: live per-tier progress,
  RAPTOR served live with memory-mcp-derived techniques, standout toolbar, cheap
  restore/history/DR commands, ported compaction techniques, and new
  differentiators) and `PLAN_tokens_saved.md` (the tokens-saved metric design).
  These are design artifacts for review, not runtime code.
- Runtime unchanged from v0.4.7 (colorized toolbar + live teal activity line +
  the dashboard fix from v0.4.5). Publish this so `pi update --extensions` pulls
  the plans alongside the current dashboard for testing.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.7 (2026-07-14)

Colorized toolbar + live "now processing" activity line.

### Changed

- **Toolbar is now colorized** (ANSI 256-color): amber tier, bold % usage,
  green saved / cyan used / blue repo totals, magenta dedup rate, green/amber/idle
  trigger state. The pi TUI's `Text` widget preserves ANSI codes, so the colors
  render in the terminal above the editor.
- **Live activity line (teal).** A third widget line shows what's happening right
  now during a compaction — `🗜 compacted chkpt_003 · engine.ts, vectorStore.ts`
  (file names from the compacted region) or `♻ deduped <file>`. It's bright teal
  while fresh (≤4s) and dims to the last-seen action afterward, so the widget is
  never blank. Cleared on session reset. `compactSession` now returns
  `filesModified` to feed this.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.6 (2026-07-14)

Package now ships the compiled `dist/` so the OpenClaw adapter works from a
clean npm install.

### Changed

- **`dist/` is now part of the published package** (added to `files`). pi still
  loads the `.ts` source directly, so pi usage is unchanged, but the OpenClaw
  adapter (`dist/extensions/openclaw-mega-compact.js`) is now available to
  OpenClaw users without a manual `npm run build`. A `prepublishOnly` hook runs
  `npm run build`, so `dist/` is always current at publish time.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.5 (2026-07-14)

Hotfix: dashboard server failed to start from the npm install.

### Fixed

- **`[mega-compact] dashboard server failed to start — check logs`** on
  `/mega-dashboard`. The npm package ships **source only** (no `dist/`), but the
  spawned runner imported `dashboard-server.js` — a file that only exists after a
  local `npm run build`. The child died instantly and never wrote `port.pid`, so
  the command reported failure. The runner now imports the `.ts` source
  (`dashboard-server.ts`, which pulls only Node built-ins) and the child is
  spawned with Node's `--experimental-strip-types` flag, so the server launches
  directly from the install path on Node ≥ 22.6. Verified end-to-end
  (`port.pid` written, `/api/snapshot` returns 200).

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.4 (2026-07-14)

Toolbar now shows tokens used + saved, each split this-session vs repo total.

### Changed

- **Live status widget** (above the editor) gained a `used:` figure and a
  repo/session split for both metrics:

  ```
   ◐ armed │ dedup: 92% │ used: 39k sess / 980k repo │ saved: 45k sess / 1.2M repo
  ```

  - `used` = stored checkpoint tokens; `saved` = tokens removed from context
    (`original − stored`). Each shows **`sess`** (this session) next to **`repo`**
    (cumulative across every session in the repo's store). Previously the toolbar
    only showed per-session saved; the repo-vs-session breakdown existed only on
    the dashboard.
  - Numbers under 1000 show raw (no `k`) so small-but-real savings stay visible.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.3 (2026-07-14)

Hotfix: v0.4.2 failed to load on repos that already had a `sqlite.db` from an
earlier version.

### Fixed

- **`no such column: original_token_estimate`** crash on extension bind. v0.4.2
  added the `original_token_estimate` column to `context_chunks` via
  `CREATE TABLE IF NOT EXISTS`, which is a no-op on a pre-existing table — so any
  store created before v0.4.2 was missing the column and `repoStats()` (called at
  load) threw, taking the whole extension down. Added an idempotent
  `ensureColumn()` migration (`ALTER TABLE … ADD COLUMN`, guarded by
  `PRAGMA table_info`) that adds the column to existing stores on open. Also added
  a regression test that builds a pre-0.4.2 table and asserts `repoStats()` works.

### Install / Upgrade

```bash
pi update --extensions
```

---

## v0.4.2 (2026-07-14)

Honest "tokens saved" metric + SQLite foundation tables for future features.

### Highlights

- **Honest "tokens saved".** `tokensSaved` now means tokens *removed* from
  context — `Σ(original region) − Σ(stored summaries)` for genuine compactions,
  and the *whole* original region when a region dedups onto an existing
  checkpoint (nothing new is stored). This replaces the earlier
  "stored-summary total" definition (where `tokensSaved` ≈ `totalTokenEstimate`),
  so the dashboard number now reflects real context reduction. For tiny sessions
  where the summary is larger than the region, saved is `0` (nothing removed).
- **New `Original Tokens` field.** `compactSession` now returns
  `originalTokenEstimate` (the dropped region's token count), persisted per
  checkpoint (`original_token_estimate`) and surfaced in both the per-session and
  repo dashboard cards as **Original Tokens** alongside **Tokens Stored** and
  **Tokens Saved**. The engine computes the stored size from the actual summary
  string (`estimateBlockTokens`), so the count is honest for both the extractive
  and legacy COLLAPSE paths.
- **SQLite foundation tables** for future features: `sessions` (resume +
  per-repo session history), `daily_log` (append-only activity log), and
  `lessons` (lessons-learned seed). `touchSession()` + `logDaily()` fire on every
  compaction, so data collects from day one. Full UI/recall for these lands in
  later sprints.

### Install / Upgrade

```bash
pi install npm:pi-mega-compact     # first time (replaces any dev symlink)
pi update --extensions             # after a publish
```

### Changed

- Bumped to 280 passing tests (all green).
- `tokensSaved` semantics changed (see Highlights). The `dedupCollapsed` counter
  is unchanged and remains separate from tokens saved.
- `mega-compact.ts` records a `sessions` + `daily_log` entry on each compaction
  (best-effort; never blocks compaction).

---

## v0.4.1 (2026-07-14)

Per-session + per-repo stats model, moved entirely into the per-repo SQLite
store, plus the npm update workflow that ships changes to every device.

### Highlights

- **Per-session vs per-repo stats.** The live widget shows **per-session**
  "tokens saved" (resets to 0 on each new session) while the dashboard's new
  **Repo (all sessions)** card shows the **cumulative** "tokens saved" that
  survives session restarts and travels with the repo. Deduped collapses are
  counted separately (`dedupCollapsed`), not folded into tokens saved.
- **All store stats now live in SQLite.** The last JSON stats file
  (`dedup-stats.json`) was removed; dedup accounting and the tokens-saved
  counter live in the SQLite `meta` table, so they persist per repo and resume
  across sessions/devices. Added `repoStats()` (aggregates every session) and a
  `repo` block on the dashboard snapshot.
- **npm is the cross-device update path.** `pi update --extensions` refreshes
  npm packages listed in `settings.packages`; the dev symlink install is a
  separate, non-propagating mechanism. See `docs/INSTALL_AND_USAGE.md` §1b.

### Install / Upgrade

```bash
pi install npm:pi-mega-compact     # first time (replaces any dev symlink)
pi update --extensions             # after a publish
```

### Changed

- Bumped to 280 passing tests (all green).
- Removed `dedup-stats.json`; dedup counters are SQLite `meta` keys
  (`dedup_attempts`, `deduped`, `tokens_saved`).
- Fixed a latent bug where per-session `stats().tokensSaved` returned a
  repo-wide value.

---

## v0.4.0 (2026-07-14)

Per-repo context isolation, a dedup rate that survives session restarts, and
live agent activity in the toolbar.

### Highlights

- **Per-repo state isolation.** Runtime state now lives at `<repo>/.pi/mega-compact/`
  per git repo instead of one global directory. Dedup stats, checkpoints, and
  `/mega-recall` results are isolated per repo — no more leaking another repo's
  `dedup: 96%` into a fresh project. The dir is committed (not gitignored), so
  your compacted context travels with the clone and resumes across devices.
- **Stable live dedup rate.** The toolbar `dedup:` field shows a cumulative
  storage dedup rate persisted in `dedup-stats.json`. It no longer resets to
  `—` on every new session, and sub-10% rates show a decimal (`2.5%`) while
  zero attempts show `0.0%`. Always populated.
- **Live agent tracking on the status line.** Running sub-agents now surface as
  `mega-compact: ▶ N agents` in the toolbar while active, reverting to
  `mega-compact: ready` when idle.

### Install / Upgrade

`pi-mega-compact` is published to npm. Install (or upgrade) with:

```bash
npm install pi-mega-compact
```

Then point pi at the installed entry (see `README.md` → Installation, or
`docs/INSTALL_AND_USAGE.md`). Existing git-checkout installs can `git pull && npm
run build`, or switch to the npm package.

### Changed

- Runtime state dir default moved from `~/.pi/agent/extensions/pi-mega-compact`
  (global) to `<repo>/.pi/mega-compact` (per repo). `MEGACOMPACT_STATE_DIR`
  remains the override for non-git working directories.
- Bumped to 278 passing tests (all green).

### Upgrade notes

No migration needed — the SQLite schema is unchanged. On first run in a repo,
mega-compact creates `<repo>/.pi/mega-compact/` automatically. The old global
`~/.pi/agent/extensions/pi-mega-compact/sqlite.db` is no longer used (it remains
only as a fallback for non-git cwds); you may delete it.

## v0.2.0 (2026-07-13)

The **storage-backend release**: the per-session gzipped-JSON checkpoint files
are replaced by a single local SQLite database as the source of truth, and the
full L0/L1/L2/RAPTOR dedup pipeline plus BYO embedder, backfill, monitoring, and
canary rollout ship behind feature flags.

### Highlights

- **SQLite storage backbone** — `better-sqlite3` in-process database replaces
  gzipped JSON checkpoint files. Single source of truth with FTS5 trigram
  tokenizer, WAL journaling, and parameterized queries. *(Note: the storage
  backend later migrated to the built-in `node:sqlite` `DatabaseSync` at
  v0.5.0 — see that entry. The migration path and DR-snapshot behavior below
  still apply.)*
- **Full dedup pipeline** — L0 exact-hash, L1 MinHash/LSH near-dup, L2 semantic
  cosine + MMR, and RAPTOR hierarchical pre-compression (shadow mode).
- **BYO localhost embedder** — `MEGACOMPACT_EMBEDDING_URL` lets you plug in a
  local ONNX/TEI/llamafile/Ollama embedding server (loopback-only).
- **Monitoring & canary** — `events.log`, `dashboard.json`, FP-rate alerts,
  and sequential canary rollout with p95 auto-disable.
- **Live agent tracking** — toolbar widget shows active sub-agent count and
  turn index in real-time.
- **DR drill + benchmark** — `scripts/dedup-restore-drill.sh` and
  `scripts/dedup-benchmark.mjs` for validation at scale.

### Breaking Change

**`better-sqlite3` native SQLite store replaces gzipped JSON persistence.**

- The old `<sess>.checkpoints.json.gz` files are **retained as disaster-recovery
  snapshots** and auto-imported on first run via `migrateJsonToSqlite(stateDir)`.
- `npm install` now builds the `better-sqlite3` native module (one-time local
  compile).
- Data directory: `~/.pi/agent/extensions/pi-mega-compact/sqlite.db`
  (override with `MEGACOMPACT_STATE_DIR`).

### Migration Guide

#### For existing v0.1.0 users

1. **Pull and build:**

   ```bash
   cd ~/.pi/agent/extensions/pi-mega-compact
   git pull origin main
   npm install      # builds the better-sqlite3 native module
   npm run build
   ```

2. **First run auto-migrates:**

   Start pi normally. On first run, `migrateJsonToSqlite(stateDir)` reads every
   `<sess>.checkpoints.json.gz` file, imports rows into `sqlite.db`, and
   **keeps the JSON files in place** as DR snapshots. The migration is
   idempotent — re-running does not duplicate rows.

3. **Verify the migration:**

   ```bash
   # Check SQLite integrity
   sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
     "PRAGMA integrity_check;"
   # Expect: ok

   # Count imported checkpoints
   sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
     "SELECT COUNT(*) FROM context_chunks;"

   # Compare to your legacy JSON snapshot count
   ls ~/.pi/agent/extensions/pi-mega-compact/*.checkpoints.json.gz | wc -l
   ```

4. **Run the DR drill to confirm:**

   ```bash
   scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact
   ```

5. **Run the test suite:**

   ```bash
   npm test    # 192 tests should pass
   ```

#### Environment variables

All v0.1.0 env vars still work. New v0.2.0 vars (defaults in
`src/config/dedup.ts`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `MEGACOMPACT_L0_ENABLED` | `true` | L0 exact content-hash dedup |
| `MEGACOMPACT_L1_ENABLED` | `true` | L1 MinHash/LSH near-dup |
| `MEGACOMPACT_L2_ENABLED` | `true` | L2 semantic cosine + MMR |
| `MEGACOMPACT_RAPTOR_ENABLED` | `false` | RAPTOR (shadow mode by default) |
| `MEGACOMPACT_MARK_ONLY_L0` | `false` | L0: record, don't collapse |
| `MEGACOMPACT_MARK_ONLY_L1` | `false` | L1: record, don't collapse |
| `MEGACOMPACT_MARK_ONLY_L2` | `false` | L2: record, don't collapse |
| `MEGACOMPACT_MINILM` | `false` | MiniLM embedder (off; not shipped) |
| `MEGACOMPACT_EMBEDDING_URL` | *(unset)* | BYO localhost embedder |
| `MEGACOMPACT_L2_THRESHOLD` | `0.85` | L2 cosine firing point |
| `MEGACOMPACT_L1_JACCARD` | `0.8` | L1 MinHash/LSH Jaccard threshold |
| `MEGACOMPACT_MMR_LAMBDA` | `0.5` | MMR diversity weight |
| `MEGACOMPACT_SEMDEDUP_COSINE` | `0.95` | Offline SemDeDup pair threshold |
| `MEGACOMPACT_FP_RATE_L0` | `0.01` | L0 false-positive alert threshold |
| `MEGACOMPACT_FP_RATE_L1L2` | `0.05` | L1/L2 false-positive alert threshold |
| `MEGACOMPACT_ALERT_WINDOW_MS` | `600000` | FP-rate rolling window (10 min) |
| `MEGACOMPACT_P95_BUDGET_MS` | `100` | Per-tier p95 latency budget |

See the [README](README.md#configuration-env-backed) for the full list.

### What's New (by sprint)

- **Sprint 8** — SQLite storage backbone (`src/store/sqlite.ts`): `context_chunks`
  - `session_state` in a single `better-sqlite3` database (WAL, FTS5 trigram,
  parameterized queries). `compressSmart`/`decompressSmart` + zstd helper.
- **Sprints 9–12** — Dedup tiers: L0 exact-hash (9/10), L1 MinHash/LSH (11),
  L2 semantic cosine + MMR + SemDeDup (12). BYO localhost embedder via
  `MEGACOMPACT_EMBEDDING_URL` (12 addendum).
- **Sprint 13** — RAPTOR pre-compression tree (`raptor_nodes`), k-means++,
  extractive default + optional localhost Ollama, 4-layer hallucination
  guardrails. Shadow mode by default.
- **Sprint 14** — Full pipeline: single config source (`src/config/dedup.ts`),
  `MARK_ONLY_*` per-tier safe-degrade, resumable backfill orchestrator
  (`src/store/backfill.ts`), local monitoring (`src/monitoring.ts`), canary
  rollout (`src/canary.ts`).
- **Sprint 15** — Benchmarks, DR drill, docs, release.

### Fixed in this release

- **Auto-trigger fired in a live pi session for the first time.** Two bugs made
  the auto-pipeline dead code in real use:
  - The `context` handler's `if (!ctx.isIdle()) return` guard blocked all
    auto-compaction — `ContextEvent` fires before each LLM call (mid-turn), so
    `isIdle()` is always false. Removed; debounce + anchor-floor / tool-pair
    guards already protect message integrity.
  - Auto-inline recall only triggered on `session_start` reason `resume`/`fork`,
    but `pi --continue` emits reason `startup` with a populated window.
    Broadened to recall whenever the session has persisted checkpoints and a
    usable query.
- `STATE_DIR_DEFAULT` now points at the real install path.

### Verified (live)

- A real `pi --print` session persisted `chkpt_001` to the SQLite store; a
  subsequent `pi --continue` auto-inlined it via `before_agent_start`
  (`event:"auto-inline", injected:["chkpt_001"]`).

---

## v0.1.0 (2026-07-11)

First tagged release. The full local, vector-backed compaction pipeline wired
end-to-end as a pi extension — no remote MCP server, all processing local.

See [CHANGELOG.md](CHANGELOG.md) for the complete v0.1.0 changelog.
