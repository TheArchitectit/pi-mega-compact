# pi-mega-compact

A local context compressor for the [pi coding agent](https://github.com/earendil-works/pi). Keeps long sessions running without overflowing the context window. All on your machine — no cloud, no API calls, no telemetry.

## Features

- **Auto-compaction** — the store watches context pressure and compacts quietly in the background. You'll notice when a long session just stays long while the token gauge rests comfortably far from the ceiling.
- **Two-layer compaction** — every LLM call sees a live trim of the context window, and every trim is checkpointed to SQLite so a crash or a `/clear` never loses the work.
- **Semantic dedup, three layers deep** — exact hash → MinHash/LSH → cosine over trigram embeddings. You rarely notice it; that's the point.
- **RAPTOR memory hierarchy** — decisions you made an hour ago don't scroll off; they get packed up as hierarchical checkpoints and re-inlined the moment your next session asks for them. Multi-level retrieval (leaves + summary clusters) is on by default and tunes itself off the build history.
- **Per-turn tracking + rewind.** Every turn, checkpoint, and recall hit lands as a row in an isolated `turns.db` — `turns`, `turn_recall`, `conversation_forks`. The dashboard **Turns tab** shows turn-by-turn memory: context pressure, the compact epoch that superseded each turn, and the exact checkpoints recalled into it. A **fork** action branches a conversation at any turn (carrying its recall set); a **rewind** action queues an intent the host consumes at the next `before_agent_start`. The `TurnStore` is contract-first (capability-gated reader/writer/admin views) so the same spine backs the dashboard, the TUI, or an API gateway.
- **Cross-repo recall** — doors I close in one repo don't reopen when I move to another. A decision stored while hacking repo A is a recall hit the next time I'm in repo B.
- **Durable memory** — every ten turns the store auto-reviews and safe-keeps decisions, facts, and preferences as first-class RAG memories, so long-running projects remember what mattered.
- **Fully local** — node:sqlite + trigram embeddings by default. Bring your own localhost embedder (ONNX, Ollama, TEI) for better semantic matches. Zero calls off your machine except the optional, localhost-only dashboard.
- **Team-run aware** — fine-grained durable trim fires at agent settle during sub-agent runs, so long multi-agent work doesn't just collapse at the end.
- **Multi-pi dashboard** — one dashboard tab per active pi process with the context stack, per-repo stats, and a live SSE feed across all of them. The React SPA now has lazy-loaded tabs: Overview, Repos, Events, Config, Metrics, Cache, Game, Achievements, Sessions, Topics (wiki), and Turns (per-turn memory + recall + rewind).
- **Auto-categorizing wiki.** Every ten compactions, the store clusters your real memory embeddings (k-means) and labels each cluster with its most discriminative terms (TF-IDF) — no LLM, no Ollama, fully local. The dashboard **Wiki tab** browses topics, searches by label or term, and drills down into the member memories of each cluster.

## Install

```bash
pi install npm:pi-mega-compact
```

That's it. `pi update --extensions` pulls updates going forward.

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

Full command reference: [`docs/COMMANDS.md`](docs/COMMANDS.md)

## Configuration

Set env vars before starting pi. Defaults are in `src/config/dedup.ts`.

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_TIER` | `low` | Threshold as % of context window (low=50%, medium=60%, high=70%) |
| `MEGACOMPACT_AUTO` | `true` | Enable auto-compaction |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold for near-dup collapse |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume |
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder endpoint |
| `MEGACOMPACT_TUI_WIDGET` | `true` | Render the above-editor panel. Set to `0` to suppress it — useful when pi runs inside an editor terminal (e.g. Neovim `:terminal`) where you drive scrollback yourself and the panel's repaints fight it. Compaction is unaffected. |

Full config reference: [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)

## Architecture

```
extensions/    Pi entry points (mega-compact, mega-trim, dashboard)
src/engine.ts  Trident pipeline (supersede → collapse → cluster)
src/vectorStore.ts   Local vector DB (add/search/dedupe)
src/compact.ts       Summarize / merge / auto-compact
src/memory.ts        Durable memories + auto-review
src/store/sqlite.ts   node:sqlite store (Node ≥22.13)
src/store/vectorIndex.ts  PGlite/HNSW cross-repo index
```

Detailed architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Development

```bash
npm run build     # TypeScript compile
npm test          # Build + 769 tests
npm run lint      # Type check + guardrails scan
```

Testing guide: [`TESTER_GUIDE.md`](TESTER_GUIDE.md)

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

pi-mega-compact requires Node ≥22.13 for the built-in `node:sqlite` module. If you're on an older version or your Node build doesn't include it by default:

```bash
export NODE_OPTIONS="--experimental-sqlite"
pi
```

Add the export to your shell profile (`.bashrc`, `.zshrc`, etc.) to make it permanent.

## License

BSD 3-Clause

## ☕ Support

If this project helped you, consider buying me a coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-TheArchitectit-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/TheArchitectit)
