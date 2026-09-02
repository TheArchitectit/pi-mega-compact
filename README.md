# pi-mega-compact

[![Sponsor](https://img.shields.io/badge/Sponsor-TheArchitectit-FF69B4?style=flat&logo=github-sponsors)](https://github.com/sponsors/TheArchitectit)

> **⚠️ LTS — patches only (2026-08-13).** This extension is maintained for bug fixes only. New feature development has moved to **[radcode](https://github.com/TheArchitectit/radcode)**, a Rust pi.dev replacement that has ported mega-compact's compaction/recall/dedup/RAPTOR stack. See [`docs/LTS.md`](docs/LTS.md) and [`docs/SUCCESSION.md`](docs/SUCCESSION.md).

A local-first context compressor for the [pi coding agent](https://github.com/earendil-works/pi). Keeps long sessions running without overflowing the context window. Local by default — no cloud, no API calls, no telemetry. Bring your own localhost embedder (Ollama, ONNX, TEI) for better semantic matches, or opt in to a remote endpoint if you need to.

## Features

- **Auto-compaction** — the store watches context pressure and compacts quietly in the background. You'll notice when a long session just stays long while the token gauge rests comfortably far from the ceiling.
- **Small-context models are the point** — models with 32k windows (GLM-4.7 etc.) are a first-class case, not an afterthought. The gate accounts for the provider's full declared output reserve, and the live-trim budgets the tail so `input + reserve + margin <= window` — no truncation loops at the overflow edge. Token accounting counts everything the provider actually receives (thinking blocks, tool-call arguments included), not just visible text.
- **Two-layer compaction** — every LLM call sees a live trim of the context window, and every trim is checkpointed to SQLite so a crash or a `/clear` never loses the work.
- **Semantic dedup, three layers deep** — exact hash (L0) -> MinHash/LSH (L1) -> cosine over trigram embeddings (L2). The dedup audit log records per-tier decisions with similarity scores for tuning.
- **RAPTOR memory hierarchy** — decisions you made an hour ago don't scroll off; they get packed up as hierarchical checkpoints and re-inlined the moment your next session asks for them. Multi-level retrieval (leaves + summary clusters) is on by default. Since v0.11.10, RAPTOR tree updates are incremental (no full rebuild) — enabled by default.
- **Per-turn tracking + rewind.** Every turn, checkpoint, and recall hit lands as a row in an isolated `turns.db` — `turns`, `turn_recall`, `conversation_forks`. The dashboard **Turns tab** shows turn-by-turn memory: context pressure, the compact epoch that superseded each turn, and the exact checkpoints recalled into it. A **fork** action branches a conversation at any turn (carrying its recall set); a **rewind** action queues an intent the host consumes at the next `before_agent_start`. The `TurnStore` is contract-first (capability-gated reader/writer/admin views) so the same spine backs the dashboard, the TUI, or an API gateway.
- **Cross-repo recall** — doors you close in one repo don't reopen when you move to another. A decision stored while hacking repo A is a recall hit the next time you're in repo B.
- **Durable memory** — on a cadence the store auto-reviews and safe-keeps decisions, facts, and preferences as first-class RAG memories, so long-running projects remember what mattered.
- **Prompt-cache optimization** — message separation + cache striping (both default ON; disable with MEGACOMPACT_MESSAGE_SEPARATION=0 / MEGACOMPACT_CACHE_STRIPING=0). Targets 82-90% cache hit rate by structuring context around provider cache boundaries.
- **Context health + KV cache poison validation** (v0.12) — a real-time composite 0-1 health score per turn from five sub-scores (drift, output quality, error rate, cache health, cache poison). Catches garbled/hallucinated output and provider-side KV-cache corruption *before* they waste tokens — the failure mode where a large-context model (e.g. DeepSeek V4 Flash, 1M window) degrades at <1% usage. Tri-layer cache poison validation: prefix hash (L1 FNV-1a), output-quality-by-cache-hit (L2 semantic), error-rate correlation (L3 behavioral). The dashboard **Health tab** shows a gauge, sparkline, sub-score bars, alerts, and per-model breakdown. Auto-mitigation (force compaction on degraded context, prefix break on poisoned cache) is default OFF — toggle it in the Maintenance tab.
- **RAG suite** — query reformulation (TF-IDF + RRF), tiered routing (L0 cache -> L1 FTS5 -> L2 PGlite), recall-quality metrics (CRAG), memory graph, and HyDE (hypothetical document embeddings). All default ON with graceful fallback — opt out via `MEGACOMPACT_<NAME>_DISABLED=true`. HyDE auto-activates only when an LLM embedder (Ollama/HTTP) is configured — it's a no-op with the default TrigramEmbedder. The dashboard **Metrics tab** (v0.13) shows RAG recall-quality metrics (pass rate, avg lift, telemetry turns, HyDE runs) and the Overview tab has a RAG health card. Toggle any flag from the dashboard Setup tab.
- **Debug bundle** — Maintenance tab in the dashboard has a **Gather Debug Logs** button that collects events, config, and store state into a shareable archive for bug reports.
- **Local-first by default** — node:sqlite + trigram embeddings by default, zero calls off your machine. Bring your own localhost embedder (Ollama, ONNX, TEI) for better semantic matches — the embedder endpoint is loopback-only by default (`MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1` opts in to a remote/third-party endpoint). The optional dashboard is localhost-only. No cloud, no API calls, no telemetry. The optional Cost API lookup (`MEGACOMPACT_COST_API_ENABLED`, default OFF) is the one network exception — it fetches model pricing from a user-configured endpoint to show real $/token rates in the dashboard.
- **Team-run aware** — fine-grained durable trim fires at agent settle during sub-agent runs, so long multi-agent work doesn't just collapse at the end.
- **Multi-pi dashboard** — one dashboard tab per active pi process with the context stack, per-repo stats, and a live SSE feed across all of them. The React SPA (Tailwind v3 + shadcn/ui, v0.13) has 12 lazy-loaded tabs — **Overview**, **Cache**, **Sessions**, and **Turns** (per-turn memory + recall + rewind) are primary; **Repos**, **Events**, **Setup** (embedding wizard + comprehensive settings panel), **Metrics** (perf latency/TPS/CPU + RAG recall quality), **Wiki** (auto-categorizing topic browser + evolution graph), **Memory Map** (D3 graph), **Maintenance** (debug bundle), and **Health** (context-health gauge + cache-poison alerts) are advanced. The Overview tab dynamically resolves the most recently active repo's snapshot so it always shows live data.
- **Auto-categorizing wiki.** Every 3 compactions (seeds from turns before that), the store clusters your real memory embeddings (k-means) and labels each cluster with its most discriminative terms (TF-IDF) — no LLM, no Ollama, fully local. The dashboard **Wiki tab** (v0.13) browses topics, searches by label or term, drills down into the member memories of each cluster, and shows a topic evolution graph over time. Curation supports rename/merge/split operations with durable overrides that survive full rebuilds.
- **Comprehensive settings panel** (v0.13.6) — every adjustable `MEGACOMPACT_*` env var is surfaced in the dashboard Setup tab, grouped by category (RAG Pipeline, Wiki/Turns, Dedup Tiers, Dedup Thresholds, RAPTOR Tuning). Toggle booleans, edit numerics with units, change strings — all write to `.mega-compact.env` via POST. The regression gate enforces that no new config flag ships without a dashboard entry.
- **Stacked memory graph** — the dashboard shows memory composition over time from 3 content sources (turns, durable memories, wiki) with a 9-gate validation system and a graph-health indicator. Per-model provider cache breakdown in the Cache tab.

## Install

```bash
pi install npm:pi-mega-compact
```

That's it. **`pi update --extensions`** pulls updates going forward. npm is the only distribution path — never use `.tgz` tarballs or symlinks for shipping.

<details>
<summary>From source (development)</summary>

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git \
  ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install && npm run build
```

The bundled `./install.sh` helper does the symlink + config edit (needs `jq`).
</details>

## Usage

Once installed, it runs automatically. Past the context threshold it compacts in the background. On resume, it re-inlines relevant checkpoints silently.

Key commands:

- `/mega-compact` — manually compact the current session
- `/mega-status` — show context usage, store stats, version
- `/mega-recall [query]` — semantic search the store, `--cross-repo` for all repos
- `/mega-memory save|list|search|forget` — manage durable memories
- `/mega-dashboard` — start the localhost dashboard
- `/mega-setup` — embedding wizard: detects Ollama/llama.cpp, suggests upgrades when recall quality is low

Full command reference: [`docs/COMMANDS.md`](docs/COMMANDS.md)

## Configuration

Set env vars before starting pi. Defaults are in `src/config/dedup.ts`.

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_TIER` | `low` | Threshold as % of context window (low=50%, medium=60%, high=70%) |
| `MEGACOMPACT_AUTO` | `true` | Enable auto-compaction |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold for near-dup collapse |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume |
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder endpoint (loopback-only by default) |
| `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER` | `false` | Opt-in: allow non-loopback embedder endpoint (e.g. hosted API) |
| `MEGACOMPACT_TUI_WIDGET` | `true` | Render the above-editor panel |
| `MEGACOMPACT_MESSAGE_SEPARATION` | `false` | Opt-in: separate messages at provider cache boundaries |
| `MEGACOMPACT_CACHE_STRIPING` | `false` | Opt-in: stripe cache stripes across conversation |
| `MEGACOMPACT_QUERY_REFORMULATION_DISABLED` | `false` | Default ON — set `true` to disable TF-IDF + RRF query reformulation |
| `MEGACOMPACT_TIERED_ROUTER_DISABLED` | `false` | Default ON — set `true` to disable L0->L1->L2 recall routing |
| `MEGACOMPACT_RECALL_METRICS_DISABLED` | `false` | Default ON — set `true` to disable CRAG recall quality metrics |
| `MEGACOMPACT_MEMORY_GRAPH_DISABLED` | `false` | Default ON — set `true` to disable memory graph |
| `MEGACOMPACT_HYDE_DISABLED` | `false` | Default ON — set `true` to disable HyDE (auto-activates only with LLM embedder) |
| `MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS` | `true` | Seed memory graph from turns (default ON) |
| `MEGACOMPACT_WIKI_SEED_FROM_TURNS` | `true` | Seed wiki from turns (default ON) |
| `MEGACOMPACT_RAPTOR_INCREMENTAL` | `true` | Incremental RAPTOR updates (default ON) |
| `MEGACOMPACT_CONTEXT_HEALTH` | `true` | Master switch: per-turn context-health composite score |
| `MEGACOMPACT_CONTEXT_HEALTH_DRIFT` | `true` | Sub-score: topic drift + error escalation + prefix instability |
| `MEGACOMPACT_CONTEXT_HEALTH_OUTPUT_QUALITY` | `true` | Sub-score: repetition, coherence, token-salad detection |
| `MEGACOMPACT_CONTEXT_HEALTH_CACHE_POISON` | `true` | Sub-score: tri-layer KV cache poison validation |
| `MEGACOMPACT_CONTEXT_HEALTH_MITIGATE` | `false` | Opt-in: auto-compaction on degraded context, prefix break on poisoned cache |
| `MEGACOMPACT_WIKI_ENHANCED` | `true` | Enhanced wiki with topic overrides + evolution tracking |
| `MEGACOMPACT_WIKI_INCREMENTAL` | `true` | Incremental wiki updates (no full rebuild) |
| `MEGACOMPACT_AUTO_WIKI` | `true` | Auto-generate wiki from turns |
| `MEGACOMPACT_NEW_UI` | `true` | Use the new Tailwind/shadcn dashboard shell |
| `MEGACOMPACT_COST_API_ENABLED` | `false` | Opt-in: fetch model pricing from an external API (PREVENT-PI-004 applies to defaults; opt-in features are exempt). Enriches dashboard cost data for models not in the local pricing table |
| `MEGACOMPACT_COST_API_URL` | _(unset)_ | OpenRouter-compatible model pricing endpoint (e.g. `https://openrouter.ai/api/v1/models`). Only contacted when `MEGACOMPACT_COST_API_ENABLED=true` |
| `MEGACOMPACT_OVERFLOW_HEADROOM` | `true` | Fire compaction before `input + output reserve + margin` exceeds the window (prevents provider 400s on small-context models) |
| `MEGACOMPACT_OUTPUT_RESERVE_PCT` | `0.30` | Fallback output reserve as a fraction of the window when the model's declared maxTokens is missing or implausible |
| `MEGACOMPACT_OUTPUT_ERROR_COMPACT` | `true` | One-shot force-compact when a response truncates mid-output (`stopReason: length`) |
| `MEGACOMPACT_WIRE_OVERHEAD` | `true` | Add the provider's invisible request overhead H (system prompt + tool definitions + extension systemPrompt prepends — never in the stored transcript) back into the token estimate for the headroom gate and tail cap; H is a per-model EMA of observed wire samples, else `MEGACOMPACT_WIRE_OVERHEAD_DEFAULT_PCT` × window. Closes the small-context-model 400 loop (attempt #9). OFF = byte-identical v0.21.11 |
| `MEGACOMPACT_WIRE_OVERHEAD_DEFAULT_PCT` | `0.15` | Fraction of the context window used as the overhead H when no wire sample has been observed yet for the model (clamped 0–0.85). Percent-based: identical math at every window size |

Full config reference: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## Architecture

```
extensions/          Pi entry points (mega-compact, mega-trim, dashboard)
src/engine.ts        Trident pipeline (supersede -> collapse -> cluster)
src/vectorStore.ts   Local vector DB (add/search/dedupe)
src/compact.ts       Summarize / merge / auto-compact
src/memory.ts        Durable memories + auto-review
src/contextHealth.ts Context health composite + KV cache poison validation
src/store/sqlite.ts   node:sqlite store (Node >=22.13)
src/store/vectorIndex.ts  PGlite/HNSW cross-repo index
```

Detailed architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Development

```bash
npm run build     # TypeScript compile
npm test          # Build + 4400+ tests
npm run lint      # Type check + guardrails scan
```

Testing guide: [`TESTER_GUIDE.md`](TESTER_GUIDE.md)

## Tester requests

These areas benefit from real-world usage data. The automated test suite covers correctness, but tuning requires diverse sessions.

- **Cosine threshold validation** — the 0.90 dedup threshold may need adjustment per content type (try 0.93 for code, 0.87 for prose). Run with `MEGACOMPACT_DEDUP_SIM` set to different values and report false positives via the debug bundle (Maintenance -> Gather Debug Logs). The dedup audit log (events.log) records `similarityScore` + `matchedId` per decision.
- **Cross-repo recall quality** — enable cross-repo recall and report the relevance-vs-noise ratio from real multi-repo sessions. The Turns tab shows recall hits per turn.
- **Dedup layer audit** — is MinHash/LSH (L1) catching enough over exact-hash (L0) + cosine (L2) to justify the complexity? If L1 catches <5% additional in your sessions, we may simplify to 2-layer. The dedup audit log has per-tier decisions.
- **Compaction death-spiral** — v0.11.9 fixed an "Already compacted" loop that made sessions unrecoverable (critical-over escape hatch forces a trim + durable compact at >=90% context). If you see this recur, report it immediately with the debug bundle.
- **Share debug bundles** — when reporting any issue, first gather from Maintenance -> Gather Debug Logs and include the archive.

## Troubleshooting

### npm lifecycle scripts disabled

Some package managers disable lifecycle scripts by default. PGlite and `@mongodb-js/zstd` need scripts enabled to build their native components.

```bash
# Re-enable install scripts
npm config set ignore-scripts false
npm install

# Or allow scripts for specific packages only
npm install --install-strategy=linked
```

### node:sqlite not found / experimental flag required

pi-mega-compact requires Node >=22.13 for the built-in `node:sqlite` module. If you're on an older version or your Node build doesn't include it by default:

```bash
export NODE_OPTIONS="--experimental-sqlite"
pi
```

Add the export to your shell profile (`.bashrc`, `.zshrc`, etc.) to make it permanent.

## License

BSD 3-Clause

## Support

If this project helped you, consider buying me a coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-TheArchitectit-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/TheArchitectit)

---

## ☕ Sponsor

If this project helps you, consider sponsoring on GitHub: [github.com/sponsors/TheArchitectit](https://github.com/sponsors/TheArchitectit)
