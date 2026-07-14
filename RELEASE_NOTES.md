# Release Notes — pi-mega-compact

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
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder |
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
  + `session_state` in a single `better-sqlite3` database (WAL, FTS5 trigram,
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
