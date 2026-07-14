# pi-mega-compact

A **layered, local, vector-backed context compressor** for the
[pi coding agent](https://github.com/earendil-works/pi). It compacts long
sessions into a **local SQLite store** and offers **deduped inline recall** — all
running **locally inside the extension**, with **no remote MCP server** and
**zero network calls at runtime** (PREVENT-PI-004).

> **v0.2.0** — storage backend is now **`better-sqlite3`** (a single,
> in-process, FS-backed SQLite database) replacing the old per-session gzipped
> JSON checkpoint files. The legacy `.checkpoints.json.gz` snapshots are
> retained as disaster-recovery fallbacks and auto-imported on first run.

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

- **Node >= 18**
- `npm install` builds the **`better-sqlite3`** native module (one-time, local
  compile). No network call and no API key are needed at runtime.
- A pi coding agent install that loads extensions from `~/.pi/agent/extensions/`.

### From a git checkout

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git \
  ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install
npm run build
```

### Register with pi

Either copy/link the extension into pi's extensions dir (the clone above already
does), **or** add it to your pi config's `pi.extensions` list:

```jsonc
{
  "pi": {
    "extensions": ["~/.pi/agent/extensions/pi-mega-compact/extensions/mega-compact.ts"]
  }
}
```

Or use the bundled helper (needs `jq`):

```bash
./install.sh          # copy into ~/.pi/agent/extensions/pi-mega-compact
./install.sh -s       # symlink instead of copy (dev mode)
```

### Verify

```bash
cd ~/.pi/agent/extensions/pi-mega-compact
npm test          # all unit/integration tests pass (192 as of v0.2.0)
npm run lint      # tsc --noEmit + guardrails scan clean
```

### Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-mega-compact
```

Then remove the path from pi's `pi.extensions` array.

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
| `/mega-status` | Show config + current context usage + store stats (checkpoint count, dedup rate, tokens saved). |
| `/mega-recall [query]` | Semantic-search the local store, dedupe against the current window, and inline the top-K relevant checkpoints. No query → uses your latest message. |
| `/mega-tier [name]` | Set the compaction tier (`low` / `medium` / `high` / `ultra` / `mega`). Shows current tier with no arg. |
| `/mega-dashboard` | Start the **localhost-only** live dashboard and open it in a browser (token gauge, store stats, live event stream). |
| `/mega-dashboard-status` | Report dashboard server status. |
| `/mega-dashboard-stop` | Stop the dashboard server. |

### Live stats widget

Above the pi editor the extension shows a compact widget:

```
 ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok
```

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

#### Dedup pipeline flags (v0.2.0 — single source: `src/config/dedup.ts`)

These gate the L0/L1/L2/RAPTOR dedup tiers. Defaults reproduce the all-active
Sprint 13 behavior. `MARK_ONLY_*` tiers run + record their decision but never
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

---

## Reporting for testers (what to capture)

If you're testing pi-mega-compact, the maintainers need **local evidence**, not
guesswork. The store and logs are plain local files — never a network port.

1. **Install + run it** (see [Installation](#install)).
2. **Work a real session** until context fills past the gate (80%+) — you should
   see the status chip flip to `● ready`, then `◐ armed`, a checkpoint persist,
   and context visibly drop.
3. **Resume and confirm recall:** restart pi, ask about something you worked on
   earlier; relevant checkpoints should auto-inline (or use
   `/mega-recall <topic>`).
4. **Watch the live signal** while testing:
   ```bash
   tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
   Each line is `{ts, tier, result, latencyMs, falsePositive?}`.
5. **Run the dashboard** (`/mega-dashboard`) and check the token gauge, store
   stats, and live event stream.
6. **Try `/mega-tier`** to see and switch compaction tiers.

### What to include in a bug report

- Output of `/mega-status` (config + store stats).
- Output of `/mega-dashboard-status`.
- Your pi version + OS + Node version (`node -v`).
- A slice of `events.log` around the problem (the `result`/`tier` lines).
- `dashboard.json` from the state dir (aggregate metrics: hit rate, FP rate,
  per-tier p95, storage bytes).
- If you suspect data loss or duplication: the checkpoint count and the
  `sqlite.db` size, plus the output of the DR drill (below).

**Disaster-recovery drill** (validates the store against its JSON snapshots and
rebuilds if corrupt — see `docs/RETENTION_POLICY.md` §5):

```bash
scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact
```

**Benchmark** (dedup hit rate, compression ratio, per-tier p95, storage at
100 / 1K / 10K checkpoints):

```bash
npm run build
node scripts/dedup-benchmark.mjs 100 1000 10000
```

Open issues at: https://github.com/TheArchitectit/pi-mega-compact/issues

---

## Architecture & layout

```
extensions/mega-compact.ts   pi extension entry; wires src/ into pi lifecycle
src/adapt.ts                  the single pi↔engine message adapter (index-aligned)
src/engine.ts                 Layer 4: compactSession() Trident pipeline + recall()
src/vectorStore.ts            Layer 3: local vector DB (add/search/dedupe + near-dup)
src/embedder.ts               default TrigramEmbedder (deterministic, 512-dim)
src/httpEmbedder.ts           BYO localhost embedder seam (MEGACOMPACT_EMBEDDING_URL)
src/store/sqlite.ts           the "one store" — better-sqlite3 context_chunks + session_state (FTS5 trigram)
src/store/migrate.ts          JSON → SQLite migration (legacy .checkpoints.json.gz retained)
src/store/backfill.ts         resumable backfill orchestrator (L0/L1/L2/RAPTOR)
src/monitoring.ts             local events.log + dashboard.json metrics + FP alerts
src/canary.ts                 sequential L0→L1→L2→RAPTOR rollout, auto-disable on p95 breach
src/config/dedup.ts           single source of truth for ALL dedup tier flags + thresholds
src/store.ts                  state dir + JSON DR helpers + compression re-exports
src/compact.ts               Layer 2: summarize / merge / autoCompactCheck
src/supersede.ts             Layer 1: obsolete file-read pruning
src/boundary.ts              drop-boundary guards (anchor floor + tool-pair)
src/tokens.ts                deterministic token estimator
src/types.ts                 engine-internal types
```

The `src/` directory is **pi-agnostic** and fully unit-tested (`node --test`).
The extension entry adapts between the engine and pi's runtime types.

---

## Development

```bash
npm run build      # tsc
npm test           # build + node --test on dist/**/*.test.js
npm run lint       # tsc --noEmit + guardrails-scan
npm run guardrails # regression_check + guardrails-scan
```

The agent-guardrails suite (Four Laws, scope, secrets, regression) gates every
sprint.

---

## Status

- ✅ Sprint 1 — core engine (Layers 1–2, pure functions)
- ✅ Sprint 2 — local vector store (Layer 3)
- ✅ Sprint 3 — pi extension wiring (Layer 4 persist + trigger)
- ✅ Sprint 4 — unified recall layer (Layer 5: auto-inline + on-demand + sentinel)
- ✅ Sprint 5 — commands / UX / config polish (status chip, store stats, debug log)
- ✅ Sprint 6 — hardening, docs, release (`install.sh`, CHANGELOG, `v0.1.0`)
- ✅ Sprint 8 — SQLite storage backbone (`better-sqlite3`, one store) + compression v2
- ✅ Sprints 9–11 — L0 exact-hash + L1 MinHash/LSH near-dup dedup tiers
- ✅ Sprint 12 — L2 semantic cosine + MMR; BYO localhost embedder (`HttpEmbedder`)
- ✅ Sprint 13 — RAPTOR hierarchical pre-compression (shadow mode)
- ✅ Sprint 14 — full pipeline: flags, backfill, monitoring, canary rollout
- ✅ Sprint 15 — benchmarks, DR drill, docs, `v0.2.0`

See `SPRINT_PLAN.md` for the full breakdown and `PLAN.md` for architecture,
`RESEARCH.md` for the pi-API constraints that shaped it, `CHANGELOG.md` for
release notes.

---

## Acknowledgements

Algorithmic reference (reimplemented in TypeScript, not vendored): memory-mcp
(`MemoryCompactor` / `compact.py`), claw-code (`trident.rs` / `compact.rs`), and
neuralwatt-mcr (pi-extension mechanics). Attribution as design sources only.

## License

[MIT](./LICENSE)
