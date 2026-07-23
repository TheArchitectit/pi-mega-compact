# pi-mega-compact

A **layered, local, vector-backed context compressor** for the
[pi coding agent](https://github.com/earendil-works/pi). It compacts long
sessions into a **local SQLite store** and offers **deduped inline recall** — all
running **locally inside the extension**, with **no remote MCP server** and
**zero network calls at runtime** (PREVENT-PI-004).

> **Status - v0.8.14.** The React dashboard (8 tabs, responsive scaling from
> 1280×720 to 4K) now ships in the npm tarball alongside the fallback html.ts.
> Game Mode adds themes, levels, achievements, and leaderboards. See
> [RELEASE_NOTES.md](RELEASE_NOTES.md) for the full changelog.

---

## Features

- **Local & private** - everything stays on your disk. No telemetry, no API key, no MCP server, no cloud. The only network surface is an optional localhost dashboard you open yourself.
- **Two-layer compaction** - a non-destructive live summary every LLM call, plus durable checkpoints that relieve context mid-run (not just at the end).
- **Vector store + dedup** - each checkpoint is embedded and stored locally; an L0->L2 + RAPTOR cascade collapses duplicate work so storage and recall stay lean.
- **Automatic recall** - the most relevant checkpoints are re-inlined on resume or branch switch; cross-repo memory-RAG augments a thin store with decisions from other repos.
- **Game Mode** - optional progression layer with 6 themes, player levels (one per turn-doubling), 9 achievements (8 visible + 1 hidden easter-egg), and per-metric leaderboards. Toggle with `/mega-compact-settings`.
- **Live dashboard** - React-based 8-tab dashboard (Overview, Repos, Events, Config, Metrics, Cache, Game, Achievements) with responsive scaling from laptop (1280×720) to ultrawide/4K. Active Repos tab shows every currently-open session side by side.
- **Perf metrics** - Model latency (turn/provider p50/p95), throughput (TPS/cache hit %), process (RSS/heap/CPU), snapshot cost (DB recompute/disk write), and TUI lag proxy — all polled on a 2s interval while the dashboard is open.
- **Database maintenance** - `/mega-db-*` commands plus best-effort auto-maintenance on session start.

## Table of contents

- [Overview](#overview)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Dashboard](#dashboard)
- [Architecture](#architecture)
- [Development](#development)
- [Testing & bug reports](#testing--bug-reports)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Overview

pi's context window is finite. When a session gets long — especially a team run
with sub-agents — pi-mega-compact keeps it going without overflowing:

1. **Watches one signal.** A single live `pressure = currentTokens / effectiveThreshold`
   drives everything — the tier label, how aggressively the live trim drops
   context, and how often durable memory is reviewed. `effectiveThreshold` is
   `tierPct × contextWindow` (a **% of the model's context window**), so the
   trim fires below pi's native ~80% auto-compaction for any model size. As
   context fills, the whole system reacts together; as it's relieved, it backs off.
2. **Compacts in two layers.** On every LLM call it returns a **live, compacted
   view** (the model sees a summary + recent anchor, non-destructively). And it
   persists a durable **checkpoint** — and, at each agent settle during a team
   run, fires pi's **native durable trim** so the on-disk transcript is actually
   truncated (context relieves mid-run, and resume reloads the trimmed transcript
   instead of a 150k window).
3. **Stores** each checkpoint in a **local vector database** (SQLite) with an
   embedding, so similar regions are found later and **duplicate work is never
   stored twice**.
4. **Recalls** the right context automatically — same-repo checkpoints on resume,
   plus **cross-repo memory-RAG**: decisions you saved in one repo are inlined as
   context when you start a session in another.

Everything lives on **your disk**. No telemetry, no API, no MCP server, no cloud.
The only optional network surface is a **user-triggered localhost dashboard** you
open yourself.

### Why "mega"?

The compaction pipeline is a **Trident** — three deterministic stages
(supersede → collapse → cluster) that run over your conversation before anything
is persisted. The checkpoint it produces is small (a summary + key decisions +
next steps + files touched), so the same session that would otherwise overflow
its window keeps going on a fraction of the tokens. On top of the Trident, a
single pressure signal orchestrates the live trim, the durable trim, and memory
review as one coherent system rather than four independent triggers.

---

## How it works

```
Layer 5  Recall / Inline      ONE local vector store → 3 entry points, 1 dedup engine
Layer 4  Persist / Checkpoint  compactSession()  → embed + store in SQLite (chkpt_xxx)
Layer 3  Cluster (vectorize)  local vector index → semantic dedup + recall
Layer 2  Collapse (summarize)  summarizeMessages() heuristic + agent summary on /mega-compact
Layer 1  Supersede (prune)     drop obsolete file-reads / superseded turns (zero cost)
─────────────────────────────────────────────────────────────────────────
Trigger   context → token fast-gate → autoCompactCheck → live trim (per call)
Durable    agent_end (idle + over threshold) → ctx.compact() → session_before_compact
          supplies the summary; pi truncates the transcript (relieves context)
Live      context handler returns { messages:[summary, …recent] } — model sees a
          compacted window every LLM call; the on-disk transcript is untouched
Marker    insert compact-marker; dedupe so repeated triggers cost ~0 tokens
```

**One store, three ways to read it back — one dedup engine:**

| Entry point | Trigger | Behavior |
| --- | --- | --- |
| **Auto-inline** (Layer 5) | `session_start` / `session_tree` | Resume → `recallAndInline(source:"resume")` prepends the most relevant checkpoints, deduped against current context. |
| **On-demand recall** | `/mega-recall [query]` | Semantic search the store, dedupe, and inline the top-K. |
| **Dedup sentinel** | every compact | A lightweight `mega-compact-marker` entry lets auto-inline and recall skip re-injecting / re-vectorizing already-present regions. |

**The dedup cascade** (shared across all entry points) collapses redundant work
so storage and recall stay lean:

- **L0 — exact:** SHA-256 content hash + region hash + summary hash. Identical (or
  whitespace/casing-normalized) regions collapse to one row.
- **L1 — near-dup:** MinHash signatures + LSH bucketing + trigram verification
  catch one-word rewordings that L0 misses.
- **L2 — semantic:** cosine over the embedding collapses paraphrases; MMR
  diversifies retrieval so a cluster of near-hits yields distinct results.
- **RAPTOR — pre-compression tree**: a hierarchical summary tree over
  checkpoints, built + served into retrieval by default (`MEGACOMPACT_RAPTOR_ENABLED`,
  default `true`); set `false` to shadow-mode it (build + log only).

Every tier is gated by its own feature flag (see [Configuration](#configuration)).
A tier can be put in `MARK_ONLY` (record the decision, don't collapse) as a safe
partial-rollout or auto-degrade state.

### Embedding (two modes, both local)

The default embedder is **`TrigramEmbedder`** — a deterministic hashed trigram
bag (512-dim, L2-normalized), **zero dependencies, instant, fully offline**. It
is heuristic-strength, which is the right bar for "inline the right checkpoint,"
not production RAG.

**Optional: bring-your-own (BYO) localhost embedder.** Set
`MEGACOMPACT_EMBEDDING_URL` to a **localhost/127.0.0.1** endpoint you run
yourself (local ONNX/TEI/llamafile/Ollama-embeddings). The extension talks to it
from `src/httpEmbedder.ts` (loopback-only — a remote host is rejected at config
time, preserving PREVENT-PI-004). Compacted content never leaves the machine and
no model ships with the extension. See `src/httpEmbedder.ts` for the
OpenAI-style contract and the `MEGACOMPACT_EMBEDDING_KEY` / `MEGACOMPACT_EMBEDDING_HEADERS`
/ `MEGACOMPACT_EMBEDDING_DIM` options.

> **Note on MiniLM:** a `MEGACOMPACT_MINILM` flag exists in `src/config/dedup.ts`
> but defaults to **off**, and the MiniLM (all-MiniLM-L6-v2) ONNX embedder was
> prototyped then deliberately **not shipped** (async-vs-sync conflict with the
> synchronous VectorStore, second native dep, no free semantic win without a
> network call). The `Embedder` interface remains the seam — inject a local
> embedder (e.g. via your own `MEGACOMPACT_EMBEDDING_URL`) instead.

---

## Installation

> **Full step-by-step guide** (pi + OpenClaw + every command + troubleshooting):
> [`docs/INSTALL_AND_USAGE.md`](docs/INSTALL_AND_USAGE.md).

### Requirements

- **Node >= 22.13** (the synchronous `node:sqlite` backend requires it; see
  `engines.node`). No native module is compiled — the store is a Node built-in.
- No network call and no API key are needed at runtime (PREVENT-PI-004).
- A pi coding agent install with package support (`pi install` / `pi update
  --extensions`). npm-installed packages are auto-discovered via the package's
  `pi` manifest entry; local checkouts load from `~/.pi/agent/extensions/`.

### Install from npm (recommended)

pi installs extensions as **packages**. `pi install npm:<pkg>` writes an
`npm:` source into your pi config's `packages` array; pi then auto-discovers the
extension from the package's own `"pi": { "extensions": [...] }` manifest entry
— **no manual `settings.json` edit is needed**.

```bash
pi install npm:pi-mega-compact        # first time: adds to packages + installs
pi update --extensions                # thereafter: pulls the latest published version
```

`pi update --extensions` refreshes every `npm:` entry in `packages` (including on
other devices that share this config). The package ships both the TypeScript
source (which pi loads directly) and the compiled `dist/`, so nothing else needs
building.

> **Tip — keep the spec unpinned.** Use `npm:pi-mega-compact`, not
> `npm:pi-mega-compact@0.5.1`. Version-pinned specs are *skipped* by
> `pi update --extensions`, so a pin would freeze you on that release. The
> installed version is always visible in the toolbar widget (`⚡ <tier> vX.Y.Z`)
> and via `/mega-status`.

> **From a git checkout (development only).** To hack on the extension, clone and
> build locally, then symlink it into pi's extensions dir — but this bypasses the
> package manager, so it is NOT updated by `pi update --extensions`. Convert to the
> npm package (above) before shipping. The bundled `./install.sh` helper does the
> symlink + config edit (needs `jq`).
>
> ```bash
> git clone https://github.com/TheArchitectit/pi-mega-compact.git \
>   ~/.pi/agent/extensions/pi-mega-compact
> cd ~/.pi/agent/extensions/pi-mega-compact
> npm install && npm run build
> ```

> **No tarballs — ever.** Distribution and updates go through `npm publish` +
> `pi update --extensions` **only**. Never build or rely on a `.tgz` (`npm pack`):
> a tarball bypasses pi's package manager and does not propagate to other devices.
> To validate a real install, bump the version, `npm publish`, then
> `pi update --extensions` on the device. (`.gitignore` rejects `*.tgz` so one can't
> be committed by accident.)
>
> **Releasing (authoritative pipeline):** every release MUST go through
> `./scripts/deploy.sh <new-version>`. It enforces a clean tree, the full gate
> (`build` + `test` + `lint` + `regression_check` + `guardrails-scan`), builds the
> React dashboard, and — critically — verifies `extensions/dashboard-client/dist/index.html`
> is present AND listed by `npm pack --dry-run` **before** `npm publish`. This is
> the gate that was missing when v0.8.5 shipped without the dashboard bundle. The
> script then bumps the version, commits, publishes via npm only, tags, pushes,
> and prints device-side verification steps. Never publish by hand.

### Storage

pi-mega-compact uses a dual local backend — **zero network, no native build step**:

- **`node:sqlite`** (`DatabaseSync`, Node ≥22.13 built-in) — the synchronous source of truth for checkpoints, session state, and the dedup index. No dependency, no install script, survives pi's `install-scripts` block.
- **PGlite + `@electric-sql/pglite-pgvector`** (WASM Postgres + HNSW `vector_cosine_ops`) — an optional, best-effort async vector index for **cross-repo recall** at `~/.pi/mega-compact-vector`. It holds both checkpoint embeddings and durable-memory embeddings, so decisions saved in one repo are findable from another. The sync store stays authoritative; the index degrades to the sync per-session scan on any failure.

Kill-switch: `MEGACOMPACT_PGLITE_DISABLED=1` fully disables the PGlite index (falls back to sync scan). Requires Node ≥22.13 (`engines.node`).

### Cross-repo recall

On resume, recall augments from other repos' checkpoints when this repo's store is thin; `/mega-recall --cross-repo` searches all repos via the HNSW index. Cross-repo hits use a stricter cosine floor (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are labeled with their source repo. A machine-wide injected-set (`~/.mega-compact-index/index.sqlite`) prevents re-injecting the same foreign checkpoint.

### Memory

pi-mega-compact auto-reviews the conversation every 10 turns (the cadence shortens as pressure climbs) and writes durable `decision`/`fact`/`preference` memories to SQLite (local, hallucination-guarded). Relevant memories are injected as RAG context on recall (capped, deduped). **Cross-repo memory-RAG (S24):** every memory write is mirrored into the PGlite/HNSW index, so when same-repo recall is thin the system augments with the nearest memories from *other* repos (stricter `MEGACOMPACT_CROSSREPO_COSINE` floor, deduped against what's already in view). Manual: `/mega-memory save|list|forget` (or `/m`).

### Uninstall

```bash
pi uninstall npm:pi-mega-compact   # removes from settings.packages + the npm tree
# or, to keep the config entry but drop the package:
npm uninstall pi-mega-compact
```

If you symlinked it into pi's extensions dir (dev only), also remove that link:

```bash
rm -f ~/.pi/agent/extensions/pi-mega-compact
```

---

## Usage

Once installed and registered, pi-mega-compact runs **automatically** — you don't
have to drive it. Past the context threshold it compacts in the background and
drops a checkpoint; on resume it re-inlines the relevant ones silently.

The commands (slash commands inside pi):

### Commands

| Command | Description |
| --- | --- |
| `/mega-compact [summary...]` | Manually compact the current session. A summary arg is used verbatim; otherwise the COLLAPSE heuristics build one. Persists a `chkpt_xxx`. |
| `/mega-compact off` | Disable auto-compaction for this session. |
| `/mega-compact-settings [on\|off\|theme [id\|next]\|tui [full\|minimal]\|achievements]` | Toggle game mode, pick a theme, switch TUI display mode, list unlocked achievements. (Alias: `/mega-game`.) |
| `/mega-status` | Show config + current context usage + store stats (checkpoint count, dedup rate, tokens saved) + the **installed version**. |
| `/mega-recall [query]` | Semantic-search the local store, dedupe against the current window, and inline the top-K relevant checkpoints. No query → uses your latest message. `--cross-repo` searches all repos. |
| `/mega-memory save <text>` / `save <category> <text>` / `list` / `search <query>` / `forget <text>` / `consolidate` | Manage durable memories (decisions, facts, preferences) written by auto-review and recalled as RAG context. Also `/m` shortform. |
| `/mega-restore <chkpt\|recent>` | Re-inject a checkpoint's verbatim original region into context. |
| `/mega-history` | List this session's checkpoints (id, date, files, tokens). |
| `/mega-view <chkpt\|recent>` | Show a checkpoint's verbatim original region. |
| `/mega-help` | Explain the toolbar widget terms (live tier, gate, dedup, tokens saved). |
| `/mega-compat-check` | Detect extension conflicts (duplicate commands / overlapping handlers) across installed pi extensions. |
| `/mega-db-stats` | Show mega-compact SQLite DB stats: table row counts, disk footprint (db + WAL + SHM), page count, freelist %, WAL frames. Read-only; safe any time. |
| `/mega-db-prune [days]` | DELETE `raw_transcript` + `checkpoint_epochs` rows older than N days (default 30) + orphan `dedup_mirror` rows. Reports deleted counts + reclaimed bytes. |
| `/mega-db-vacuum` | `VACUUM` the DB (rebuild pages, reclaim freelist). Heavy: briefly doubles disk usage. |
| `/mega-db-check` | `PRAGMA integrity_check` + `wal_checkpoint(TRUNCATE)`. Fold the WAL into the main file and verify DB health. Use after a crash. |
| `/mega-db-reconcile` | Fix `dedup_mirror.ref_count` drift vs actual `raw_transcript` refs, delete orphan dedup rows, backfill missing `content_ref`. Run after `/mega-db-prune` or a crash. |
| `/mega-dashboard [open]` | Start the **localhost-only** live dashboard and open it in a browser (token gauge, store stats, live event stream, per-repo + All-repos/Summary views, cross-repo drift). |
| `/mega-dashboard-status` | Report dashboard server status (port / url / live). |
| `/mega-dashboard-stop` | Stop the dashboard server. |

### The tier system

The **tier** you see in the toolbar and dashboard is a *live pressure band* (`low` → `medium` → `high` → `ultra` → `mega`) that climbs automatically as your context window fills and falls back as it's relieved — it is driven by `currentTokens / effectiveThreshold`, not a manual setting. The base compaction *threshold* is set by `MEGACOMPACT_TIER` at startup as a **% of the model context window** (`low` 50% · `medium` 60% · `high` 70% · `ultra` 70% · `mega` 75%; default `low`) — the fire point is `tierPct × contextWindow`, so it always lands below pi's native ~80% auto-compaction (any model size). The old static token amounts (50k/100k/200k/1M/10M) are now only the boot fallback used before the first context event reports a window. `/mega-tier` was removed in v0.7.6. Higher pressure also deepens the live trim and reviews durable memory more often — the whole system reacts as one.

### Game Mode

Optional progression layer (toggle with `/mega-compact-settings on`):

- **6 themes** — transparent (default), neon, retro, ocean, forest, cyber. CSS-variable skins for the TUI widget and dashboard.
- **Player levels** — one level per turn-doubling (`turnLevel(n) = floor(log2(n+1))+1`). Level-up fires a one-cycle ANSI blink on the TUI + a CSS pulse on the dashboard.
- **Achievements** — 9 total (8 visible + 1 hidden easter-egg). Unlock conditions: First Compact, Compact Streak (5 in one session), Turn Veteran (25 turns), Level 5, Dedupe Master (100 chunks), Repo Explorer (3 repos), Night Owl (00:00–05:00), Flawless (exactly 100% cache), and Opie's Wild Ride (hidden: push cache past 100%).
- **Leaderboards** — per-metric (Cache %, Dedupe collapsed, Turns LVL, MEGA CACHE trophies) with repos badge. Stored in SQLite `game_scores`.
- **MEGA CACHE easter-egg** — when the dedup hit rate exceeds 100% (real ratio > 1), a transient "oopsie" toast fires (TUI + dashboard) and the hidden Opie achievement unlocks.

### Live stats widget

Above the pi editor the extension shows a compact widget:

```
 ⚡ high·low v0.8.14 │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok │ LVL 4
```

- **Version** — the installed npm version (read from `package.json` at runtime),
  so the widget always reflects what `pi update --extensions` last pulled. If
  this looks stale after an update, restart the dashboard server / pi session.
- **Tier** — active compaction tier (low/medium/high/ultra/mega)
- **Token usage** — current / max context window and %
- **Checkpoints** — persisted checkpoints for the session
- **Trigger state** — ○ idle, ◐ armed, ● ready
- **Dedup hit rate** — % of checkpoints collapsed as duplicates
- **Active agents / turn** — sub-agent count and conversation turn (when > 0)
- **LVL** — player level (one per turn-doubling; game mode only)

> **DB housekeeping** — `/mega-db-stats` / `prune` / `vacuum` / `check` / `reconcile`
> give you manual control over the SQLite store. In addition, a best-effort
> **auto-maintenance** pass runs on `session_start`: it prunes rows older than
> 30d, checkpoints the WAL if it's over 10 MB, and VACUUMs if the DB is over
> 100 MB AND the freelist is >20% of pages. It never blocks session start and
> logs a one-line summary to the diagnostic log. (v0.7.6+)

---

## Configuration (env-backed)

All defaults are in `src/config/dedup.ts` (single source of truth). Set env vars
before starting pi.

### Core settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEGACOMPACT_FAST_GATE_PCT` | `70` | Context-usage % that arms the auto-trigger. Defaults to the tier's % of window (`tierPct*100`): low 50 · med 60 · high 70 · ultra 70 · mega 75. Override raises the arming floor. |
| `MEGACOMPACT_TIER` | `low` | Named trigger preset — sets the compaction threshold as a **% of the model context window**: `low`(50%) `medium`(60%) `high`(70%) `ultra`(70%) `mega`(75%). Fire point = `tierPct × contextWindow`, so it always fires below pi's native ~80% auto-compaction (any model size). The old static token amounts (50k/100k/200k/1M/10M) are now only the **boot fallback** used before the first context event reports a window. Default `low`. |
| `MEGACOMPACT_THRESHOLD_TOKENS` | *(tier default)* | Explicit **absolute** token budget (the `custom` tier). Overrides `MEGACOMPACT_TIER` when set and is **never percent-scaled** — use this to pin an exact token fire point regardless of model window. |
| `MEGACOMPACT_ANCHOR_USER_MESSAGES` | `3` | Never drop the most recent N user messages (anchor floor). |
| `MEGACOMPACT_PRESERVE_RECENT` | `4` | Preserve the most recent N messages verbatim. |
| `MEGACOMPACT_AUTO` | `true` | Enable the auto-trigger. |
| `MEGACOMPACT_AUTO_INLINE` | `true` | Auto-inline on resume / branch. |
| `MEGACOMPACT_AUTO_INLINE_K` | `3` | Top-K checkpoints to auto-inline. |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold to collapse near-dupes. |
| `MEGACOMPACT_STATE_DIR` | *(none — per-repo default)* | Override the store location. By default state is per-repo at `<repo>/.pi/mega-compact/`; this env var forces a single explicit dir (used as the fallback for non-git cwds). |

### Dedup pipeline flags

These gate the L0/L1/L2/RAPTOR dedup tiers. Defaults reproduce the all-active
behavior. `MARK_ONLY_*` tiers run + record their decision but never
collapse (safe partial-rollout / auto-degrade state).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEGACOMPACT_L0_ENABLED` | `true` | L0 exact content-hash dedup. |
| `MEGACOMPACT_L1_ENABLED` | `true` | L1 MinHash/LSH near-dup verification. |
| `MEGACOMPACT_L2_ENABLED` | `true` | L2 semantic cosine dedup + MMR retrieval diversity. |
| `MEGACOMPACT_RAPTOR_ENABLED` | `true` | RAPTOR pre-compression tree (built + **served into retrieval by default**; set `false` for shadow mode — build + log only). |
| `MEGACOMPACT_MARK_ONLY_L0` | `false` | L0: record, don't collapse. |
| `MEGACOMPACT_MARK_ONLY_L1` | `false` | L1: record, don't collapse. |
| `MEGACOMPACT_MARK_ONLY_L2` | `false` | L2: record, don't collapse. |
| `MEGACOMPACT_MINILM` | `false` | MiniLM embedder flag — **off; not shipped** (see Embedding). BYO via `MEGACOMPACT_EMBEDDING_URL`. |
| `MEGACOMPACT_EMBEDDING_URL` | *(unset)* | BYO localhost embedder endpoint (loopback-only; enables `HttpEmbedder`). |
| `MEGACOMPACT_L2_THRESHOLD` | `0.85` | L2 cosine firing point (trigram-honest; set higher for semantic backends). |
| `MEGACOMPACT_L1_JACCARD` | `0.8` | L1 MinHash/LSH near-dup Jaccard threshold. |
| `MEGACOMPACT_MMR_LAMBDA` | `0.5` | MMR retrieval-diversity weight (λ·relevance − (1−λ)·maxSim). |
| `MEGACOMPACT_SEMDEDUP_COSINE` | `0.95` | Offline SemDeDup pair threshold → `dedup_status='removed'`. |
| `MEGACOMPACT_FP_RATE_L0` | `0.01` | L0 false-positive alert threshold (auto → MARK_ONLY). |
| `MEGACOMPACT_FP_RATE_L1L2` | `0.05` | L1/L2 false-positive alert threshold (auto → MARK_ONLY). |
| `MEGACOMPACT_ALERT_WINDOW_MS` | `600000` | FP-rate rolling window (10 min). |
| `MEGACOMPACT_P95_BUDGET_MS` | `100` | Per-tier p95 latency budget; canary auto-disables on breach. |

See `docs/DEDUP_RUNBOOK.md` for incident response (SEV tiers, first-15-min
checklist, MARK_ONLY degrade) and `docs/RETENTION_POLICY.md` for TTL / soft-delete
/ VACUUM.

### Continuity & memory

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEGACOMPACT_LEGACY_DURABLE_TRIM` | `false` | Restore the legacy auto-trigger (`ctx.compact()` stops the agent). One-release rollback; default uses live context-event trim + pi native auto-compaction (compact-and-continue). |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume + `/mega-recall --cross-repo` (HNSW index over every repo). |
| `MEGACOMPACT_CROSSREPO_COSINE` | `0.90` | Stricter cosine floor for cross-repo hits (vs `0.85` same-repo). |
| `MEGACOMPACT_MEMORY_AUTO_REVIEW` | `true` | Auto-review the conversation every `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` turns → durable memories. |
| `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` | `10` | Turns between auto-review cycles. |
| `MEGACOMPACT_PGLITE_DISABLED` | *(unset — index on)* | Kill-switch for the PGlite/HNSW cross-repo index; set `1`/`true` to disable (falls back to sync per-session scan). |

## Dashboard

The localhost-only dashboard (started with `/mega-dashboard`) is a single-page
app served from a detached child process on `127.0.0.1` (random port in
9320–9329). Every API is read-only — the server never writes the index or your
store. It reads the machine-wide `repo_registry`
(`~/.mega-compact-index/index.sqlite`) plus the current repo's own `node:sqlite`
store.

### Tabs (React dashboard)

The dashboard (started with `/mega-dashboard`) now ships as a React SPA with 8 tabs, responsive scaling from 1280×720 to 4K:

- **Overview** — context-window gauge (green/yellow/red), trigger status (armed/ready/idle), Vector Store (9 fields + compression bar), Repo (all sessions, 7 fields), Data Safety shield (regions retained, dedup %), Configuration (tier/preset/threshold), Model & Cost Savings ($, rates), Crew/Agents (active agents/turn/status), "What these numbers mean" legend.
- **Repos** — All Repositories table, Active Repos live table, Savings by Model table, per-repo detail modal, summary tiles.
- **Events** — live SSE stream with category filter (all/compact/recall/config/crew/game).
- **Config** — game mode toggle, theme picker (6 themes), TUI display mode (full/minimal), read-only config display.
- **Metrics** — model latency (turn/provider p50/p95), throughput (TPS/cache hit %), process (RSS/heap/CPU), snapshot cost (DB recompute/disk write), TUI lag proxy. Per-model cache status table.
- **Cache** — Cache Hits (session/total), Tokens Saved (session/total), Compactions (session/total), Time Saved (session/total).
- **Game** — MEGA CACHE banner, Opie unlock tile, leaderboards (Cache %, Dedupe collapsed, Turns LVL, MEGA CACHE trophies), repos badge, achievements sub-section.
- **Achievements** — achievement tiles grid with unlock states, toast area.

The older html.ts fallback (1071 lines, all data) is retained for environments without the React build.

### Active Repos tab

The dashboard has a dedicated **Active Repos** tab that lists every server /
session seen within the **last 30 minutes**, each with its live tier,
context %, and session state. It is backed by `GET /api/servers`, which walks
the machine-wide `repo_registry`, reads each repo's per-process
`dashboard.json` snapshot, and returns one row per currently-open session —
so 1–6 sessions running at once are visible together in a single table instead
of only the single current-repo view. Each row shows that repo's live
cache-hit / compaction / time-saved totals (see below).

The older **All repos** view and `GET /api/summary` still surface an
`activeRepos` count, and `GET /api/repos?active=Nh` filters to repos seen
within the last *N* hours (e.g. `?active=24h`, hour-granular) for the
longer-window cross-repo table.

### Metrics (DB-backed, durable)

The dashboard's cumulative **Cache hits**, **Compactions**, and **Estimated
time saved** cards are backed by **SQLite `meta` counters**
(`compact_count`, `recall_injected`, `cache_hit_tokens_saved`, plus the
existing `tokens_saved` / `deduped`), not the per-process `dashboard.json`
snapshot. Because they live in the repo's `node:sqlite` store, the totals are
**durable across session restarts** and travel with the repo's state dir —
`dashboard.json` is now just the live per-process view that feeds the Active
Repos rows. The cards show:

- **Cache hits** = dedup collapses (`deduped`) + recall re-injections
  (`recall_injected`) — as **current session** and **repo-wide total**.
- **Compactions** = current session (`checkpointCount`) + repo-wide total
  (`compact_count` from `meta`).
- **Estimated time saved** = compact time saved + cache-hit time saved, derived
  from tokens ÷ ~2k tok/s and labeled `est.`, as current session + total.

### Localhost API

`GET /api/snapshot` (current-repo live state),
`/api/servers` (**Active Repos** — sessions active in the last 30 min, with
tier / context % / state / live cache-hit & compaction totals),
`/api/index` (all repos), `/api/repos` (with `?active=Nh` filter), `/api/summary`
(header tiles + `activeRepos`), `/api/drift` (cross-repo drift: stale /
compaction-lag / model-churn — read-only), `/api/events` (SSE live event stream),
and `/api/version`.

### Data safety

Every compacted region is kept verbatim (compressed);
the Data Safety card shows regions retained, compressed-originals bytes, dedup
duplicates, and permanently-deleted bytes (**always 0**). Nothing is permanently
deleted — any region is restorable.

---

## Architecture

```
extensions/mega-compact.ts   pi extension entry; wires src/ into pi lifecycle
extensions/mega-trim.ts      live context-event trim (compact-and-continue, no abort)
extensions/mega-conflict-cmds.ts  extension-conflict detector (/mega-compat-check)
extensions/dashboard-server.ts     localhost dashboard (HTML + snapshot/version/drift APIs)
src/adapt.ts                  the single pi↔engine message adapter (index-aligned)
src/engine.ts                 Layer 4: compactSession() Trident pipeline + recall()
src/vectorStore.ts            Layer 3: local vector DB (add/search/dedupe + near-dup)
src/embedder.ts               default TrigramEmbedder (deterministic, 512-dim)
src/httpEmbedder.ts           BYO localhost embedder seam (MEGACOMPACT_EMBEDDING_URL)
src/store/sqlite.ts           the "one store" — node:sqlite context_chunks + session_state (FTS5 trigram)
src/store/vectorIndex.ts      async PGlite/HNSW cross-repo vector index (redundant, best-effort)
src/store/migrate.ts          JSON → SQLite migration (legacy .checkpoints.json.gz retained)
src/store/backfill.ts         resumable backfill orchestrator (L0/L1/L2/RAPTOR)
src/memory.ts                 durable memories (decision/fact/preference) + auto-review
src/memoryOps.ts              memory apply/consolidate ops
src/memoryRecall.ts           memory recall + auto-inline (RAG context)
src/driftDetection.ts         cross-repo drift report (stale/idle/compaction-lag/model-churn)
src/monitoring.ts             local events.log + dashboard.json metrics + FP alerts
src/canary.ts                 sequential L0→L1→L2→RAPTOR rollout, auto-disable on p95 breach
src/config/dedup.ts           single source of truth for ALL dedup tier flags + thresholds
src/store.ts                  state dir + JSON DR helpers + compression re-exports
src/compact.ts                Layer 2: summarize / merge / autoCompactCheck
src/supersede.ts              Layer 1: obsolete file-read pruning
src/boundary.ts               drop-boundary guards (anchor floor + tool-pair)
src/tokens.ts                 deterministic token estimator
src/types.ts                  engine-internal types
```

The `src/` directory is **pi-agnostic** and fully unit-tested (`node --test`).
The extension entry adapts between the engine and pi's runtime types.

---

## Development

```bash
npm run build      # tsc
npm test           # build + node --test on dist/**/*.test.js (407 tests)
npm run lint       # tsc --noEmit + guardrails-scan
npm run guardrails # regression_check + guardrails-scan
```

The agent-guardrails suite (Four Laws, scope, secrets, regression) gates every
change.

---

## Testing & bug reports

Full QA instructions — environment setup, the manual test checklist, what to
include in a bug report, and known limitations — live in
[`TESTER_GUIDE.md`](TESTER_GUIDE.md). Open issues at
[github.com/TheArchitectit/pi-mega-compact/issues](https://github.com/TheArchitectit/pi-mega-compact/issues).

---

## Acknowledgements

Algorithmic reference (reimplemented in TypeScript, not vendored): memory-mcp
(`MemoryCompactor` / `compact.py`), claw-code (`trident.rs` / `compact.rs`), and
neuralwatt-mcr (pi-extension mechanics). Attribution as design sources only.

## License

[BSD-2-Clause](./LICENSE)
