# Changelog

## v0.8.0 (unreleased) — Game Mode (S30–S35)

- **feat(game): S30 foundation.** `game_state` table (global on/off + theme + tui_display_mode) + `src/config/themes.ts` (6 themes) + `/mega-game` command. `fb4ec17`.
- **feat(widget): S31 TUI theming + level + MEGA CACHE flare.** Themed full/minimal widget, `LVL n` level prefix, ANSI blink on level-up, MEGA CACHE oopsie gag, game-mode-off guard (legacy parity). `98a9b3f` + `a0d9b5c`.
- **feat(dashboard): S32 CSS-variable skin + settings strip.** Theme CSS vars, `/api/game-state` GET/PUT (non-object guard, loopback), fs.watch cross-process cache eviction. `60b7f73` + `fa8cc20`.
- **feat(game): S33 scoring.** `game_scores` table + `recordScore`/`leaderboard` (parameterized) + `turn_end`/`session_compact` hooks + `evaluateAchievements` pure-helpers + mega_cache trophy + megaCacheFlare. `e4ac3ec`.
- **feat(dashboard): S34 High Score tab + animations.** Game Mode tab, per-metric leaderboards, MEGA CACHE banner, Opie hidden-unlock tile, transient oopsie toast (cross-process), level-up CSS pulse + ANSI blink, `GET /api/game-scores` (metric validation, 400/405). `05d6550`.
- **feat(game): S35 achievements capstone.** `game_achievements` table (9 seeded, idempotent) + `game-achievements.ts` accessors (`listAchievements`/`getAchievement`/`unlockAchievement`/`isUnlocked`, parameterized) + `evaluateAchievements(scores)` pure fn over leaderboard aggregates + `evaluateAndUnlockAchievements` orchestrator + hook wiring (turn_end + session_compact) + transient `achievementFlare` (one-cycle TUI toast + dashboard tile pulse) + dashboard achievements tile row (hidden+locked renders nothing; visible-locked shows `???`; unlocked shows icon+title+date) + transient unlock toast + `GET /api/achievements` (405 guarded, loopback) + `/mega-game achievements` subcommand. 9 achievements: first_compact, compact_streak, turn_veteran, level_five, dedupe_master, repo_explorer, night_owl, flawless, opie_wild_ride (hidden).
- **chore:** version bump 0.7.9 → 0.8.0 (unreleased).

No migration. Tests: 540+ (was 514). npm-only distribution.


## v0.7.9 (2026-07-19) — TUI width-overflow crash fix + guardrails compliance + audit fixes + refactor splits

- **fix(widget): TUI width-overflow crash.** The status widget's hand-rolled `visibleWidth()` counted the ⚡ bolt (U+26A1, RGI emoji) as 1 cell; pi-tui's `visibleWidth()` (which enforces its strict `visibleWidth(line) > width` render check) counts it as 2. `panelLine()` padded to `width − ourVisibleWidth` → under-padded by 1 → final line was `width + 1` by pi-tui's measure → crash `Rendered line N exceeds terminal width (211 > 210)`. Running `/mega-status` (or any snapshot) populated the widget and crashed; disabling the extension hid it. Fix: import pi-tui's `visibleWidth` + `truncateToWidth`; `panelLine()` now calls `truncateToWidth(line, width, "", true)` → exactly `width` cells, ANSI-preserved, space-padded, hard-clipped on overflow. `panelBar()` same. `extensions/mega-runtime/widget.ts`.
- **fix(mega-status): loadMetrics dir-vs-file + try/catch (H1).** Passed the state **directory** to `loadMetrics()` (existsSync true for dirs → readFileSync EISDIR → silently caught → metrics always 0); handler had no try/catch so any throw became an unhandled rejection that could crash the session. Pass `defaultMetricsPath(stateDir)` + wrap body. `extensions/mega-commands.ts`. Audit ref `docs/AUDIT_FINDINGS.md` [H1].
- **fix(commands): audit findings H2/H3/M1-M7/L1-L5.** H2 `/mega-db-*` stale `stateDir` at registration → wrong-repo DB on switch; now `bindRepo(ctx.cwd)` + read `currentStateDir` at call time. H3 `/mega-dashboard-*` same stale-capture for port/runner/log → call-time functions + bindRepo on stop/status. M1-M4 wrap `/mega-compact`/`/mega-recall`/`/mega-restore`/`/mega-view` in try/catch. M5-M7 `any[]`→inferred, `any`→typed, `Number()` guard. L1-L5 null-guards (/mega-status model fields, freelist fallback, history `.pop() ?? f`, `execSync` import). `extensions/mega-commands.ts`, `mega-runtime.ts`, `mega-pipeline.ts`.
- **feat(guardrails): SEMANTIC-001 scanner + shared prompts + pattern-rules v2.2.0.** `scripts/semantic-scan.mjs` (Node scanner for unhandled promise rejections / missing `.catch()` in `.then()` chains) wired into `npm run lint` alongside `guardrails-scan`. `.guardrails/prevention-rules/pattern-rules.json` v2.2.0 (32 rules) + JSON Schema. `scripts/guardrails-scan.README.md`. `docs/workflows/REGRESSION_PREVENTION.md`. `skills/shared-prompts/` (6: production-first, scope-validation, halt-conditions, three-strikes, error-recovery, clean-architecture). `docs/AGENT_GUARDRAILS.md` + `docs/INDEX_MAP.md` updated.
- **refactor: split 5 oversized files into focused submodules** (export-preserving barrels; no behavior change; no consumer changes). `src/store/sqlite.ts` (2206→barrel) → `src/store/sqlite/` (14 submodules). `extensions/dashboard-server.ts` (1443→barrel) → `extensions/dashboard-server/` (6). `extensions/mega-runtime.ts` (1097→barrel) → `extensions/mega-runtime/` (widget/helpers/state/query). `extensions/mega-pipeline.ts` (545→barrel) → `extensions/mega-pipeline/` (3). `extensions/mega-events.ts` → `mega-events/` lifecycle submodules.
- **packaging:** new optional peerDependency `@earendil-works/pi-tui` (`>=0.80`) — widget imports `visibleWidth`/`truncateToWidth` from pi-tui (already bundled in every pi install) so width math can't diverge from the render check. Declared peer (not direct) to avoid a second bundle copy.
- **chore:** version bump 0.7.8 → 0.7.9.

No migration required — widget fix + export-preserving refactors + additive guardrails/audit fixes. Upgrade with `pi update --extensions` (npm only). Tests: 388 passed / 0 failed across 42 files.

## v0.7.8 (2026-07-18) — percent-based auto-compact trigger + max-output-token auto-continue

- **feat(trigger): S29 percent-based auto-compact trigger.** The context-handler gate now fires on context % (reliable, the menu-bar signal) instead of a token count the model under-reports, with a token fallback when % is absent. `MEGACOMPACT_AUTO_PCT_TRIGGER` (optional, clamped 0.1–1, default unset = inherit tier `tierPct`) allows override. `custom` (`MEGACOMPACT_THRESHOLD_TOKENS`) keeps the absolute token gate. Dashboard `armed`/`ready` now mirror the gate's basis (percent for tiered, tokens for custom). Reliability fix — default fire point byte-identical; compaction that previously got missed now fires. `src/compact.ts`, `extensions/mega-config.ts`, `extensions/mega-events.ts`.
- **feat(continue): S28 max-output-token auto-continue.** Detects `stopReason === "length"` on `turn_end`, arms a 30s-debounced, idle-gated continue nudge at `agent_end` so the agent resumes a truncated turn instead of surfacing an error. Input-orthogonal to context overflow (no `ctx.compact()` on the length path). Nudge text branches so it never claims a compaction that did not occur. `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP` (default true) gates it; disabling reverts to prior silent behavior. `extensions/mega-events.ts`.
- **fix(statusbar): context % caps at ">100%"** instead of printing a raw overshoot value. The bar was already clamped; only the number printed had overshoot. With S29 the overshoot is rare; the cap makes the residual case read as a warning. `extensions/mega-widget.ts`.
- **docs:** New specs `docs/specs/s28-max-output-token-auto-continue.md` + `docs/specs/s29-percent-auto-trigger.md`; `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` updated.
- **chore:** version bump 0.7.7 → 0.7.8.

No migration required — additive + signal-only; the default fire point is unchanged. Upgrade with `pi update --extensions` (npm only).

## v0.7.7 (2026-07-17) — dashboard Active Repos tab + DB-backed metrics

- **feat(dashboard): Active Repos tab + `GET /api/servers`.** Dedicated dashboard tab listing every server / session seen within the last 30 minutes, with live tier / context % / state per row. New `GET /api/servers` endpoint walks `repo_registry` + reads each repo's `dashboard.json`. `extensions/dashboard-server.ts` (+tests).
- **feat(dashboard): DB-backed cumulative cache-hit / compaction / time-saved metrics.** Persist `compact_count`, `recall_injected`, `cache_hit_tokens_saved` to SQLite `meta` (durable, cross-session). Dashboard Cache-hit / Compaction / Estimated-time-saved cards now read from DB counters instead of the per-process `dashboard.json` snapshot. `src/store/sqlite.ts` (new meta helpers + `sqlite.cachehit.test.ts`); wiring in `extensions/mega-runtime.ts`, `mega-pipeline.ts`, `mega-dashboard.ts`.
- **docs(readme):** Active Repos tab + Metrics (DB-backed, durable) subsections; `GET /api/servers` in API list; Status + widget version bumped to v0.7.7.
- **chore:** version bump 0.7.6 → 0.7.7.

No migration required — additive; new `meta` counters populate lazily. Tests: 412 passed / 0 failed across 42 files.

## v0.7.6 (2026-07-17) — docs-complete + version bump

- **docs(readme):** `/mega-db-*` commands table + auto-maintenance callout; "Current version" bumped to v0.7.6 with S27 note.
- **docs(tester):** new TESTER_GUIDE.md §12 — DB maintenance /commands manual checklist (stats / prune / vacuum / check / reconcile / auto-maint-on-`session_start`).
- **chore:** version bump 0.7.5 → 0.7.6 to force the npm upgrade path (no code changes).

No code changes — `/mega-db-*` commands and auto-maintenance are unchanged from v0.7.5. Tests: 407 passed / 0 failed across 41 files.

## v0.7.5 (2026-07-17) — DB maintenance /commands (S27 Task 10)

- **feat(db-maint): `/mega-db-*` commands + auto-maintenance.** S27 Task 10.
  - `src/store/sqlite.ts` — new maintenance primitives: `getDbStats`,
    `pruneOldRows`, `checkpointWal`, `vacuumDb`, `integrityCheck`,
    `reconcileDedupMirror`, `autoMaintain`. All parameterized (PREVENT-002),
    local SQLite (PREVENT-PI-004).
  - `extensions/mega-db-cmds.ts` (new) — registers `/mega-db-stats`,
    `/mega-db-prune [days]`, `/mega-db-vacuum`, `/mega-db-check`,
    `/mega-db-reconcile`.
  - `extensions/mega-compact.ts` — wires `registerDbCommands`.
  - `extensions/mega-events.ts` — best-effort `autoMaintain` on `session_start`
    (prune 30d, WAL checkpoint >10MB, VACUUM DB >100MB + freelist >20%). Never
    blocks session start.
  - `src/store/sqlite.dbmaint.test.ts` (new) — 12 unit tests for the
    maintenance primitives.

Full suite: 407 passed, 0 failed across 41 files.

## v0.7.4 (2026-07-17) — compaction race fix + S27 DB-mirror foundation

- **fix(compaction): prevent "Already compacted" race in agent_end.** pi emits
  `agent_end` BEFORE its own native `_checkCompaction`, so our manual durable-trim
  `ctx.compact()` call raced with pi's native auto-compaction and surfaced a
  spurious "Already compacted" / "Auto compaction failed" error toast.
  - `extensions/mega-runtime.ts` — new `rt.lastNativeCompactAt` field +
    `diagAgentEndDurableSkipRecent` counter.
  - `extensions/mega-events.ts` — new `session_compact` listener stamps
    `lastNativeCompactAt` for EVERY compaction (manual/threshold/overflow, ours
    or pi's own); both `ctx.compact()` call sites (agent_end mid-run trim +
    legacy path) skip for 10s after a native compaction. Uses
    `lastNativeCompactAt` (not `lastCompactAt`, which `runCompact` also stamps
    for our own checkpoint persistence — that would falsely skip).

- **feat(db-mirror): S27 raw transcript mirror + dedup pipeline (Tasks 5-9).**
  Byte-stable prompt-cache-key foundation, behind `MEGACOMPACT_DB_MIRROR`
  (default OFF). Additive only.
  - Task 5 — `extensions/mega-events.ts` context hook: append ALL incoming
    messages to `raw_transcript` (idempotent, content_hash PK); write
    `checkpoint_epoch` with deterministic nonce on compaction.
  - Task 6 — `src/mirror/dedup.ts` + `src/store/sqlite.ts`: `dedup_mirror`
    table stores unique `content_bytes` once; `raw_transcript` references via
    `content_ref` with `ref_count`. `dedupTranscript()` fire-and-forget.
  - Task 7 — `src/recall.ts` recall demotion contract: when mirror is ON,
    `raw_transcript + dedup_mirror` are the byte-stable source of truth;
    legacy JSON checkpoint is DR fallback only. VectorStore recall unaffected.
  - Task 8 — tests: `src/mirror/mirror.test.ts`, `src/store/sqlite.dbmirror.test.ts`,
    `extensions/mega-events.test.ts`. Full suite 395/395 pass.
  - Task 9 — maps + guardrails: `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md`
    updated; `docs/specs/sprint-009-db-maintenance.md` added.

Full suite: 395 passed, 0 failed across 40 files.

## v0.6.9 (2026-07-17) — tiered % compaction threshold (scales with model window)

- **Percentage-based fire point.** The compaction threshold is now `tierPct ×
  contextWindow` (low 50% · medium 60% · high 70% · ultra 70% · mega 75%)
  instead of a static token amount frozen at boot, so live + durable trim fire
  **below** pi's native ~80% auto-compaction for any model size. See
  `docs/specs/s27-tiered-percent-threshold.md`.
  - `extensions/mega-config.ts` — `TIER_PCT` (fraction map) + `MegaConfig.tierPct`
    - pure `effectiveThresholdTokens({ tierPct, fallbackThreshold, window,
    explicitThreshold? })`; `resolveFastGatePct` defaults to `tierPct*100`; boot
    `thresholdTokens` is now `round(tierPct * 200_000)`.
  - `extensions/mega-runtime.ts` — `effectiveThreshold` getter; `pressure` getter
    reconciled to the single percentage basis when the window is known; snapshot
    `armed`/`ready`/`config`/`trigger` emit `tierPct` + `effectiveThresholdPct`.
  - `extensions/mega-events.ts` — FAST GATE / `autoCompactCheck` / `agent_end`
    durable-trigger compare against `runtime.effectiveThreshold`.
  - `extensions/mega-dashboard.ts` — `config`/`trigger` gain `tierPct` +
    `effectiveThresholdPct`.
- **Custom stays absolute.** `MEGACOMPACT_THRESHOLD_TOKENS` (the `custom` tier)
  is never percent-scaled.
- **Display.** `/mega-status` reports `threshold=<eff> (<pct>% of <win> window)
  tierPct=<…>`; dashboard Threshold card shows `thresholdTokens (NN% of <window>)`.
- **Fixed:** for a 200k-window model the old static `high`(200k) == 100% of the
  window, so pi's native auto-compaction (~80%) always fired first and our trim
  never triggered; the tiered % fixes it (high = 70% = 140k < 160k).

## v0.6.3 (2026-07-16) — hotfix: lazy-load PGlite (no load crash when missing)

- **Bug fix:** `src/store/vectorIndex.ts` + `src/store/memoryIndex.ts` used a
  static top-level `import` of `@electric-sql/pglite`, crashing the whole
  extension at load when the package is absent. Switched to a dynamic `import()`
  inside a new `loadPgLite()`; the type import is kept (`import type`, erased at
  build). `initVectorIndex`/`initMemoryIndex` now return `undefined` on a missing
  package and every caller degrades to the sync scan. See
  `docs/specs/fix-pglite-lazy-import.md`.

## v0.5.0 (2026-07-16) — compaction continuity + cross-repo recall + memory-RAG

The S16–S23 slice: pi now compacts **and continues** (no more stop-after-
compact), cross-repo recall is wired into resume + `/mega-recall --cross-repo`
over a machine-wide PGlite HNSW index, and the `memories` table is auto-
reviewed + RAG-injected. Plus a multi-repo dashboard (Summary + All-repos
- drift) and Slice-3 docs. Single `node:sqlite` source of truth + optional
PGlite index; zero network (PREVENT-PI-004). See the design spec and the
per-sprint sections below for full detail.

### Cross-repo drift detection (R4)

A read-only health report over the machine-wide `repo_registry`, surfaced on the
dashboard, so multi-repo drift is visible at a glance.

### Added

- **`detectCrossRepoDrift()`** (`src/driftDetection.ts`) — classifies each
  registered repo as `ok`, `stale` (>30d idle, info), `compaction_lag` (active
  but >24h behind the most-recently-active repo's last compaction, warn), or
  `model_churn` (model changed within 7d, info). Returns `{ generatedAt, totals,
  repos }`. Read-only — never writes the registry.
- **`GET /api/drift`** (`extensions/dashboard-server.ts`) — serves the drift
  report from the global index. Lazily requires `driftDetection` via
  `createRequire` so the sync HTTP handler stays sync.

### Tests

- `src/driftDetection.test.ts` (5): empty registry, stale flag, compaction-lag
  flag, all-ok, and recent model churn.

### Sprint S21 (memory recall inclusion + auto-consolidate)

### Added

- **`recallMemories()` wired into `recallAndInline`** (`src/recall.ts`,
  `src/memory.ts`, `src/memoryRecall.ts`) — durable memories are now recalled as
  part of the unified Layer-5 pipeline, alongside checkpoint recall. Hits are
  capped by `recallMaxTokens`, deduped against any checkpoint block already
  inlined, and surfaced under a `Durable memories:` header so they're
  distinguishable from session-recall hits. When auto-inline is off, the block
  is still assembled (via `pendingMemoryRecallBlock`) and shown on the next
  `before_agent_start`.
- **`consolidateMemories()`** (`src/memory.ts`) — finds near-duplicate rows in
  the `memories` table via cosine similarity, merges them into one (append the
  lesser row's content as a new sentence; mark the redundant row removed), and
  returns the number of merges performed. Threshold is `CONSOLIDATE_COSINE`
  (default 0.7) — tighter than off-line SemDeDup (0.95) on purpose: real-world
  memory drift means a re-stated decision rarely hits 0.95 against the
  original, and the cost of a missed merge is unbounded table growth. Empty
  input, singletons, and all-distinct sets are no-ops.
- **Pipeline wiring** (`extensions/mega-pipeline.ts`, `extensions/mega-events.ts`,
  `extensions/mega-runtime.ts`) — `doCompact` fires `consolidateMemories` after
  a successful compaction, but only when `runtime.memoriesTouchedThisCompaction
  > 0` (set by `turn_end` whenever `applyMemoryOps` writes rows). This means
  consolidation runs at most once per compaction and never fires on a
  compaction window where memory was untouched. Best-effort + non-fatal: a
  consolidate failure cannot block a compaction, and a successful pass emits
  a green `∫ consolidated N memory dups` line into the live ticker.
- **Tests** — `src/memory.test.ts` gains a 3-test block for `consolidateMemories`
  (pair-matches near-dups, leaves unrelated rows alone, empty/singleton
  fast-paths return 0).

### Sprint S20 (memory auto-review)

Auto-review the conversation and persist durable memories to SQLite, then
recall them as RAG context. Local, hallucination-guarded, no LLM by default.

### Added

- **`reviewConversation()`** (`src/memory.ts`) — extractive, hallucination-guarded
  review of recent user requests. Detects decision-style statements (via
  `DECISION_PATTERNS`), emits `add`/`replace`/`remove` `MemoryOp`, and grounds
  every op in an actual message so no fabricated memory is stored. No LLM.
- **`applyMemoryOps()`** (`src/memoryOps.ts`) — applies add/replace/remove ops to
  the `memories` table. Replaces match by existing content, removes by content,
  adds are idempotent. Thin layer over `src/store/sqlite.ts` helpers (no raw SQL).
- **Auto-review trigger** — `extensions/mega-events.ts` `turn_end` fires
  `reviewConversation` + `applyMemoryOps` every `MEGACOMPACT_MEMORY_REVIEW_INTERVAL`
  turns (default 10) when `MEGACOMPACT_MEMORY_AUTO_REVIEW` is on (default true).
  Best-effort, non-fatal.
- `memories` table gains `category` / `target` / `last_referenced` / `source_turn`
  columns (S20.1, additive + idempotent `ensureColumn` migration).
- **`recallMemories()`** (`src/memoryRecall.ts`) — cosine-ranked recall over the
  durable `memories` table using the same local embedder used by RAPTOR. Marks
  hits as `last_referenced` so memory drift can be measured; min-similarity
  defaults to 0.2 (filters unrelated hits).
- **`recallMemoriesAndInline()`** (`src/recall.ts`) — composes memory recall
  into the same one-shot pending-block pipeline as checkpoint recall
  (`pendingMemoryRecallBlock` in `MegaRuntime`), token-capped via the same
  `recallMaxTokens` budget as checkpoints, and prepended to the system prompt
  by `before_agent_start` alongside the existing checkpoint block.
- **Resumed / branched sessions auto-recall memories** (`mega-events.ts`,
  `openclaw-mega-compact.ts`) — the user's last query drives both checkpoint
  and memory recall on resume so durable decisions and rules re-surface with
  the rest of the prior context.

### Tests

- `src/memory.test.ts` (3): add on decision, replace on contradiction,
  none on smalltalk. `src/memoryOps.test.ts`: add / idempotent-add / replace /
  remove.
- `src/memoryRecall.test.ts` (4): ranks relevant memory above unrelated, marks
  referenced hits (`last_referenced` updated), empty store returns `[]`,
  cleanup.

### Sprint S19 (multi-repo dashboard)

Surface every repo in one dashboard. Reads the machine-wide `repo_registry`
table in `index.sqlite` (the single write path the extension upserts on
repo-switch) as a read-only, single-shot connection, so one server shows all
repos' checkpoints, tokens saved, compressed-originals, and active model.

### Added

- **`/api/index`** (Phase 5b) — returns `{ updatedAt, summary, repos }` from the
  global registry: `summary` carries `totalRepos`, `totalCheckpoints`,
  `totalTokensSaved`, `totalCompressedOriginalBytes`; `repos` is the per-repo
  rows (display name, model, checkpoints, tokens saved, retained bytes, last
  compacted). Read-only; opens its own SQLite connection per request so a
  concurrent writer's WAL never blocks the request.
- **Summary + All-repos tabs** in the dashboard SPA, both fed by `/api/index`
  via `fetch` (5s poll). The Summary tab shows the aggregate cards; the All-repos
  tab shows the full registry table (click a row → per-repo detail modal, same
  source as the in-current table).
- **Defensive display hygiene** — transient `/tmp`/`/var/folders` test paths are
  dropped from the registry view, and duplicate display names collapse to the
  most-recently-seen row, keeping the All-repos list readable.

### Changed

- `bindRepo()` in `extensions/mega-runtime.ts` already upserts the registry via
  `upsertRepoRegistry` on repo-switch (S19.2 wiring), so the dashboard populates
  without a separate write path.

### Tests

- New `dashboard-server.test.ts` integration test (S19): seeds two repos into
  the global index, launches the real server subprocess on a private port, and
  asserts `/api/index` returns both repos with the correct aggregate summary
  (`totalCheckpoints` = 3 + 5, `totalTokensSaved` = 1000 + 2000).

### Sprint S18 (cross-repo dedup markers + tracking)

Machine-wide injected-set so a foreign checkpoint injected in repo A is never
re-injected by repo B; cross-repo injections tracked in `events.log` + `/mega-status`.

### Added

- **Machine-wide injected-set** (`markInjectedGlobal` / `wasInjectedGlobal`
  in `src/store/sqlite.ts`, backed by the `injected_global` table in
  `~/.mega-compact-index/index.sqlite`). A checkpoint injected in any repo is
  seen as injected by every other repo's recall, so cross-repo context is
  never duplicated across the machine. Failure → degrades to the per-session
  injected-set (current behavior), non-fatal.
- **Cross-repo dedup in recall** (`recallAndInlineAsync` in `src/recall.ts`) —
  after the per-session `wasInjected` check, also skips a hit already in the
  machine-wide set when `globalIndexDir` is configured; `markInjected` is
  accompanied by `markInjectedGlobal` on a foreign (`repoId`-bearing) hit.
- **`/mega-status` cross-repo stats** (`extensions/mega-commands.ts`) — counts
  recorded `recall-crossrepo` injections and the number of repos indexed from the
  global registry, shown in the status line. Best-effort, non-fatal.
- **`/api/repos` + `/api/summary` endpoints** (`extensions/dashboard-server.ts`)
  over the machine-wide registry — Summary carries `repoCount`,
  `totalTokensSaved`, `totalCheckpoints`, and `activeRepos` (repos seen in the
  last 24h); All-repos lists each registered repo. `/api/repos?active=Nh`
  filters to recently-active repos.

### Tests

- `dashboard-server.test.ts` (S19/S22): `/api/repos` honors `?active=Nh`
  and `/api/summary` reports the 24h `activeRepos` count from seeded fixtures.

### Sprint S17 (cross-repo recall)

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

### Sprint S16 (compaction continuity)

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
