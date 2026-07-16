# pi-mega-compact

A **layered, local, vector-backed context compressor** for the
[pi coding agent](https://github.com/earendil-works/pi). It compacts long
sessions into a **local SQLite store** and offers **deduped inline recall** — all
running **locally inside the extension**, with **no remote MCP server** and
**zero network calls at runtime** (PREVENT-PI-004).

> **Current version:** `v0.6.1` — storage backend is **`node:sqlite`**
> (`DatabaseSync`, a Node ≥22.13 built-in), replacing the old `better-sqlite3`
> native addon and the per-session gzipped JSON checkpoint files. **Zero native
> build step, fully local, zero network at runtime.** Legacy
> `.checkpoints.json.gz` snapshots are retained as disaster-recovery fallbacks
> and auto-imported on first run. Cross-repo recall, durable memory, and a
> localhost dashboard round out the continuity story.

---

## What this is (the 30-second version)

pi's context window is finite. When a session gets long, pi-mega-compact:

1. **Watches** context usage and, past a threshold, **compacts** the older part of
   the conversation into a short structured summary + key facts ("a checkpoint").
2. **Stores** each checkpoint in a **local vector database** (SQLite) with an
   embedding, so similar regions can be found later — and so **duplicate
   work is never stored twice**.
3. **Recalls** the right checkpoints automatically when you resume a session or
   invoke a recall command, re-injecting only what's relevant (deduped against
   what's already in view).

Everything lives on **your disk**. No telemetry, no API, no MCP server, no cloud.
The only optional network surface is a **user-triggered localhost dashboard** you
open yourself.

### Why "mega"?

The compaction pipeline is a **Trident** — three deterministic stages that run
over your conversation before anything is persisted. The checkpoint it produces
is small (a summary + key decisions + next steps + files touched), so the same
session that would otherwise overflow its window keeps going on a fraction of the
tokens.

---

## How it works

```
Layer 5  Recall / Inline      ONE local vector store → 3 entry points, 1 dedup engine
Layer 4  Persist / Checkpoint  compactSession()  → embed + store in SQLite (chkpt_xxx)
Layer 3  Cluster (vectorize)  local vector index → semantic dedup + recall
Layer 2  Collapse (summarize)  summarizeMessages() heuristic + agent summary on /mega-compact
Layer 1  Supersede (prune)     drop obsolete file-reads / superseded turns (zero cost)
─────────────────────────────────────────────────────────────────────────
Trigger   context/turn_end → % gate → auto_compact_check → fire
Marker    insert compact-marker; dedupe so repeated triggers cost ~0 tokens
Cancel    session_before_compact → { cancel:true } once persisted (no double-compact)
```

**One store, three ways to read it back — one dedup engine:**

| Entry point | Trigger | Behavior |
|---|---|---|
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
- **RAPTOR — pre-compression tree** (shadow mode by default): a hierarchical
  summary tree over checkpoints, built + logged but not served until promoted.

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

### Storage

pi-mega-compact uses a dual local backend — **zero network, no native build step**:

- **`node:sqlite`** (`DatabaseSync`, Node ≥22.13 built-in) — the synchronous source of truth for checkpoints, session state, and the dedup index. No dependency, no install script, survives pi's `install-scripts` block.
- **PGlite + `@electric-sql/pglite-pgvector`** (WASM Postgres + HNSW `vector_cosine_ops`) — an optional, best-effort async vector index for **cross-repo recall** at `~/.pi/mega-compact-vector`. The sync store stays authoritative; the index degrades to the sync per-session scan on any failure.

Kill-switch: `MEGACOMPACT_PGLITE_DISABLED=1` fully disables the PGlite index (falls back to sync scan). Requires Node ≥22.13 (`engines.node`).

### Cross-repo recall

On resume, recall augments from other repos' checkpoints when this repo's store is thin; `/mega-recall --cross-repo` searches all repos via the HNSW index. Cross-repo hits use a stricter cosine floor (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are labeled with their source repo. A machine-wide injected-set (`~/.mega-compact-index/index.sqlite`) prevents re-injecting the same foreign checkpoint.

### Memory

pi-mega-compact auto-reviews the conversation every 10 turns and writes durable `decision`/`fact`/`preference` memories to SQLite (local, hallucination-guarded). Relevant memories are injected as RAG context on recall (capped, deduped). Manual: `/mega-memory save|list|forget`.

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

## How to use it

Once installed and registered, pi-mega-compact runs **automatically** — you don't
have to drive it. Past the context threshold it compacts in the background and
drops a checkpoint; on resume it re-inlines the relevant ones silently.

The commands (slash commands inside pi):

| Command | Description |
|---|---|
| `/mega-compact [summary...]` | Manually compact the current session. A summary arg is used verbatim; otherwise the COLLAPSE heuristics build one. Persists a `chkpt_xxx`. |
| `/mega-compact off` | Disable auto-compaction for this session. |
| `/mega-status` | Show config + current context usage + store stats (checkpoint count, dedup rate, tokens saved) + the **installed version**. |
| `/mega-recall [query]` | Semantic-search the local store, dedupe against the current window, and inline the top-K relevant checkpoints. No query → uses your latest message. `--cross-repo` searches all repos. |
| `/mega-memory save <text>` / `save <category> <text>` / `list` / `search <query>` / `forget <text>` / `consolidate` | Manage durable memories (decisions, facts, preferences) written by auto-review and recalled as RAG context. Also `/m` shortform. |
| `/mega-restore <chkpt\|recent>` | Re-inject a checkpoint's verbatim original region into context. |
| `/mega-history` | List this session's checkpoints (id, date, files, tokens). |
| `/mega-view <chkpt\|recent>` | Show a checkpoint's verbatim original region. |
| `/mega-help` | Explain the toolbar widget terms (live tier, gate, dedup, tokens saved). |
| `/mega-compat-check` | Detect extension conflicts (duplicate commands / overlapping handlers) across installed pi extensions. |

The **tier** you see in the toolbar and dashboard is a *live pressure band* (`low` → `medium` → `high` → `ultra` → `mega`) that climbs automatically as your context window fills and falls back as it's relieved — it is driven by `currentTokens / thresholdTokens`, not a manual setting. The base compaction *threshold* (token budget) is still chosen by the `MEGACOMPACT_TIER` env var at startup (`low`/`medium`/`high`/`ultra`/`mega`, default `low`); `/mega-tier` was removed in v0.6.0. Higher pressure also deepens the live trim and reviews durable memory more often — the whole system reacts as one.
| `/mega-dashboard` | Start the **localhost-only** live dashboard and open it in a browser (token gauge, store stats, live event stream, per-repo + cross-repo drift). |
| `/mega-dashboard-status` | Report dashboard server status. |
| `/mega-dashboard-stop` | Stop the dashboard server. |

### Live stats widget

Above the pi editor the extension shows a compact widget:

```
 ⚡ high·low v0.6.0 │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok
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

---

## Configuration (env-backed)

All defaults are in `src/config/dedup.ts` (single source of truth). Set env vars
before starting pi.

| Variable | Default | Meaning |
|---|---|---|
| `MEGACOMPACT_FAST_GATE_PCT` | `70` | Context-usage % that arms the auto-trigger. |
| `MEGACOMPACT_TIER` | `low` | Named trigger preset — sets the token threshold. `low`(50k) `medium`(100k) `high`(200k) `ultra`(1M) `mega`(10M). |
| `MEGACOMPACT_THRESHOLD_TOKENS` | _(tier default)_ | Explicit token budget confirming compaction. Overrides `MEGACOMPACT_TIER` when set. |
| `MEGACOMPACT_ANCHOR_USER_MESSAGES` | `3` | Never drop the most recent N user messages (anchor floor). |
| `MEGACOMPACT_PRESERVE_RECENT` | `4` | Preserve the most recent N messages verbatim. |
| `MEGACOMPACT_AUTO` | `true` | Enable the auto-trigger. |
| `MEGACOMPACT_AUTO_INLINE` | `true` | Auto-inline on resume / branch. |
| `MEGACOMPACT_AUTO_INLINE_K` | `3` | Top-K checkpoints to auto-inline. |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold to collapse near-dupes. |
| `MEGACOMPACT_STATE_DIR` | _(none — per-repo default)_ | Override the store location. By default state is per-repo at `<repo>/.pi/mega-compact/`; this env var forces a single explicit dir (used as the fallback for non-git cwds). |

#### Dedup pipeline flags (single source: `src/config/dedup.ts`)

These gate the L0/L1/L2/RAPTOR dedup tiers. Defaults reproduce the all-active
behavior. `MARK_ONLY_*` tiers run + record their decision but never
collapse (safe partial-rollout / auto-degrade state).

| Variable | Default | Meaning |
|---|---|---|
| `MEGACOMPACT_L0_ENABLED` | `true` | L0 exact content-hash dedup. |
| `MEGACOMPACT_L1_ENABLED` | `true` | L1 MinHash/LSH near-dup verification. |
| `MEGACOMPACT_L2_ENABLED` | `true` | L2 semantic cosine dedup + MMR retrieval diversity. |
| `MEGACOMPACT_RAPTOR_ENABLED` | `false` | RAPTOR pre-compression tree (**shadow mode by default** — builds + logs, does not serve retrieval). |
| `MEGACOMPACT_MARK_ONLY_L0` | `false` | L0: record, don't collapse. |
| `MEGACOMPACT_MARK_ONLY_L1` | `false` | L1: record, don't collapse. |
| `MEGACOMPACT_MARK_ONLY_L2` | `false` | L2: record, don't collapse. |
| `MEGACOMPACT_MINILM` | `false` | MiniLM embedder flag — **off; not shipped** (see Embedding). BYO via `MEGACOMPACT_EMBEDDING_URL`. |
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder endpoint (loopback-only; enables `HttpEmbedder`). |
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

#### Continuity + memory knobs

| Variable | Default | Meaning |
|---|---|---|
| `MEGACOMPACT_LEGACY_DURABLE_TRIM` | `false` | Restore the legacy auto-trigger (`ctx.compact()` stops the agent). One-release rollback; default uses live context-event trim + pi native auto-compaction (compact-and-continue). |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume + `/mega-recall --cross-repo` (HNSW index over every repo). |
| `MEGACOMPACT_CROSSREPO_COSINE` | `0.90` | Stricter cosine floor for cross-repo hits (vs `0.85` same-repo). |
| `MEGACOMPACT_MEMORY_AUTO_REVIEW` | `true` | Auto-review the conversation every `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` turns → durable memories. |
| `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` | `10` | Turns between auto-review cycles. |
| `MEGACOMPACT_PGLITE_DISABLED` | _(unset — index on)_ | Kill-switch for the PGlite/HNSW cross-repo index; set `1`/`true` to disable (falls back to sync per-session scan). |

#### Dashboard

The localhost-only dashboard adds a **Summary** + **All-repos** view over the
machine-wide `repo_registry`, plus a **cross-repo drift** report (`GET /api/drift`)
flagging stale repos (>30d idle), compaction lag (an active repo >24h behind the
most-recently-active repo's last compaction), and recent model churn (within 7d).
All read-only — the report never writes the index.

---

## Architecture & layout

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
npm test           # build + node --test on dist/**/*.test.js (346 tests)
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
