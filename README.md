# pi-mega-compact

A local context compressor for the [pi coding agent](https://github.com/earendil-works/pi). It keeps long sessions running without overflowing the context window — all on your machine, no cloud, no API calls.

**Current version:** v0.7.5

---

## Why does this exist?

Pi has a finite context window. Long sessions — especially team runs with sub-agents — eventually hit the ceiling. When that happens, you either start over or lose context. Pi-mega-compact prevents that by compacting the conversation in the background and keeping the important parts.

It runs entirely locally. No telemetry, no remote servers, no API keys. The only network surface is an optional localhost dashboard you start yourself.

---

## How it works

The compaction pipeline has three stages that run over your conversation before anything is stored:

1. **Supersede** — drops obsolete file reads and superseded turns. Zero cost, zero loss.
2. **Collapse** — summarizes messages using heuristics. On manual compact, it uses an agent summary.
3. **Cluster** — vectorizes and deduplicates. Similar regions are found and collapsed so the same work is never stored twice.

A single **pressure signal** (`currentTokens / effectiveThreshold`) drives everything — the tier label, how aggressively context is trimmed, and how often durable memory is reviewed. As context fills, the system reacts. As it's relieved, it backs off.

### Live vs. durable compaction

Two layers work together:

- **Live trim** — on every LLM call, the extension returns a compacted view (summary + recent anchor). The model sees a smaller window. The on-disk transcript is untouched.
- **Durable checkpoint** — at agent settle during team runs, it fires pi's native trim so the transcript is actually truncated. Context relieves mid-run, not just at the end.

### Storage

Checkpoints go into a local SQLite database with embeddings for semantic search. The default embedder is a deterministic trigram hasher — zero dependencies, instant, fully offline. You can optionally plug in a local embedder (ONNX, Ollama, TEI) via a localhost endpoint if you want better semantic matching.

Both the sync store (SQLite) and an optional async vector index (PGlite/HNSW for cross-repo recall) live on your disk. The sync store is always authoritative.

### Cross-repo recall

Decisions you saved in one repo are findable from another. If you figured out a pattern in project A, starting a session in project B will surface that knowledge. Cross-repo hits use a stricter similarity floor and are labeled with their source repo.

### Durable memory

Every 10 turns (more often under pressure), the system reviews the conversation and writes durable memories — decisions, facts, preferences — to SQLite. These are injected as context on recall. You can also manage them manually with `/mega-memory`.

---

## Installation

### Requirements

- Node >= 22.13 (uses the built-in `node:sqlite`)
- A pi coding agent install with package support

### From npm (recommended)

```bash
pi install npm:pi-mega-compact
pi update --extensions   # pulls updates going forward
```

Keep the spec unpinned (`npm:pi-mega-compact`, not `npm:pi-mega-compact@0.7.5`). Pinned specs are skipped by `pi update --extensions`.

### From source (development only)

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git \
  ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install && npm run build
```

The bundled `./install.sh` helper does the symlink + config edit (needs `jq`).

### Uninstall

```bash
pi uninstall npm:pi-mega-compact
```

---

## Usage

Once installed, it runs automatically. Past the context threshold it compacts in the background. On resume, it re-inlines relevant checkpoints silently.

### Commands

| Command | What it does |
|---|---|
| `/mega-compact [summary]` | Manually compact the current session |
| `/mega-compact off` | Disable auto-compaction for this session |
| `/mega-status` | Show config, context usage, store stats, installed version |
| `/mega-recall [query]` | Semantic search the store and inline results. `--cross-repo` searches all repos |
| `/mega-memory save\|list\|search\|forget\|consolidate` | Manage durable memories |
| `/mega-restore <chkpt\|recent>` | Re-inject a checkpoint's original content |
| `/mega-history` | List this session's checkpoints |
| `/mega-view <chkpt\|recent>` | Show a checkpoint's original content |
| `/mega-help` | Explain the toolbar widget |
| `/mega-compat-check` | Detect conflicts with other pi extensions |
| `/mega-dashboard` | Start the localhost dashboard |
| `/mega-db-stats` | SQLite DB stats (row counts, disk usage, WAL) |
| `/mega-db-prune [days]` | Delete old raw transcript rows (default 30 days) |
| `/mega-db-vacuum` | VACUUM the DB to reclaim disk space |
| `/mega-db-check` | Integrity check + WAL checkpoint |
| `/mega-db-reconcile` | Fix dedup ref count drift after a crash |

### Toolbar widget

The widget above the pi editor shows live stats:

```
⚡ high v0.7.5 │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
  ◐ armed │ dedup: 92% │ saved: 45k tok
```

- **Version** — installed npm version
- **Tier** — compaction pressure level (low/medium/high/ultra/mega)
- **Token usage** — current / max context window
- **Checkpoints** — persisted checkpoints for this session
- **Trigger state** — idle, armed, or ready
- **Dedup rate** — percentage of checkpoints collapsed as duplicates
- **Agents / turn** — sub-agent count and conversation turn

The tier is a live pressure band that climbs as the context window fills and falls back as it's relieved. It's driven by `currentTokens / effectiveThreshold`, not a manual setting.

---

## Configuration

All defaults are in `src/config/dedup.ts`. Set env vars before starting pi.

### Core settings

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_TIER` | `low` | Compaction threshold as % of context window. `low`=50%, `medium`=60%, `high`=70%, `ultra`=70%, `mega`=75% |
| `MEGACOMPACT_THRESHOLD_TOKENS` | _(tier default)_ | Set an absolute token budget instead of a percentage |
| `MEGACOMPACT_AUTO` | `true` | Enable auto-compaction |
| `MEGACOMPACT_ANCHOR_USER_MESSAGES` | `3` | Never drop the most recent N user messages |
| `MEGACOMPACT_PRESERVE_RECENT` | `4` | Preserve the most recent N messages verbatim |
| `MEGACOMPACT_STATE_DIR` | _(per-repo)_ | Override the store location |

### Recall and memory

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_AUTO_INLINE` | `true` | Auto-inline checkpoints on resume |
| `MEGACOMPACT_AUTO_INLINE_K` | `3` | Top-K checkpoints to auto-inline |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold for near-dup collapse |
| `MEGACOMPACT_MEMORY_AUTO_REVIEW` | `true` | Auto-review conversation for durable memories |
| `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` | `10` | Turns between memory reviews |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume |
| `MEGACOMPACT_CROSSREPO_COSINE` | `0.90` | Stricter cosine floor for cross-repo hits |

### Dedup pipeline

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_L0_ENABLED` | `true` | Exact content-hash dedup |
| `MEGACOMPACT_L1_ENABLED` | `true` | MinHash/LSH near-dup detection |
| `MEGACOMPACT_L2_ENABLED` | `true` | Semantic cosine dedup + MMR diversity |
| `MEGACOMPACT_RAPTOR_ENABLED` | `false` | RAPTOR tree (shadow mode — builds and logs, does not serve) |
| `MEGACOMPACT_MARK_ONLY_L0` | `false` | L0: record decisions without collapsing |
| `MEGACOMPACT_MARK_ONLY_L1` | `false` | L1: record decisions without collapsing |
| `MEGACOMPACT_MARK_ONLY_L2` | `false` | L2: record decisions without collapsing |

### Embedding

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder endpoint (loopback only) |
| `MEGACOMPACT_EMBEDDING_KEY` | _(unset)_ | API key for BYO embedder |
| `MEGACOMPACT_EMBEDDING_DIM` | _(unset)_ | Dimension override for BYO embedder |
| `MEGACOMPACT_PGLITE_DISABLED` | _(unset)_ | Kill-switch for the PGlite/HNSW cross-repo index |

See `docs/DEDUP_RUNBOOK.md` for incident response and `docs/RETENTION_POLICY.md` for TTL and VACUUM policies.

---

## Architecture

```
extensions/mega-compact.ts        Entry point — wires the engine into pi
extensions/mega-trim.ts           Live context-event trim
extensions/mega-conflict-cmds.ts  Extension conflict detector
extensions/dashboard-server.ts    Localhost dashboard

src/adapt.ts           Pi ↔ engine message adapter
src/engine.ts          Trident pipeline + recall
src/vectorStore.ts     Local vector DB (add/search/dedupe)
src/embedder.ts        Default trigram embedder
src/httpEmbedder.ts    BYO localhost embedder seam
src/compact.ts         Summarize / merge / auto-compact logic
src/supersede.ts       Obsolete file-read pruning
src/memory.ts          Durable memories + auto-review
src/memoryOps.ts       Memory apply/consolidate
src/memoryRecall.ts    Memory recall + auto-inline (RAG)
src/driftDetection.ts  Cross-repo drift reporting
src/monitoring.ts      Local metrics + false-positive alerts
src/canary.ts          Rollout safety + auto-disable
src/config/dedup.ts    All dedup tier flags (single source of truth)
src/store/sqlite.ts    SQLite store (node:sqlite)
src/store/vectorIndex.ts  Async PGlite/HNSW cross-repo index
src/store/migrate.ts   JSON → SQLite migration
src/store/backfill.ts  Resumable backfill orchestrator
```

The `src/` directory is pi-agnostic and fully unit-tested with `node --test`. The extension entry adapts between the engine and pi's runtime.

---

## Development

```bash
npm run build       # TypeScript compile
npm test            # Build + run 353 tests
npm run lint        # Type check + guardrails scan
npm run guardrails  # Regression check + guardrails scan
```

## Testing and bug reports

See [`TESTER_GUIDE.md`](TESTER_GUIDE.md) for the full QA guide. Open issues at [github.com/TheArchitectit/pi-mega-compact/issues](https://github.com/TheArchitectit/pi-mega-compact/issues).

---

## License

BSD-2-Clause
