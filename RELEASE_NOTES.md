# Release Notes — pi-mega-compact

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
  tokenizer, WAL journaling, and parameterized queries.
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
