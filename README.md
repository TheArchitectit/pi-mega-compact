# pi-mega-compact

A local context compressor for the [pi coding agent](https://github.com/earendil-works/pi). Keeps long sessions running without overflowing the context window. All on your machine — no cloud, no API calls, no telemetry.

## Features

- **Auto-compaction** — watches context pressure and compacts in the background before you hit the ceiling
- **Two-layer compaction** — live trim on every LLM call (model sees a smaller window) + durable checkpoints persisted to SQLite
- **Semantic dedup** — three-stage pipeline (exact hash → MinHash/LSH → cosine) collapses redundant work so nothing is stored twice
- **Cross-repo recall** — decisions saved in one repo surface when you start a session in another
- **Durable memory** — auto-reviews conversation every 10 turns, writes decisions/facts/preferences to SQLite, injects them as RAG context on recall
- **Fully local** — SQLite + trigram embedder by default. Bring your own localhost embedder (ONNX, Ollama, TEI) for better semantic matching
- **Team-run aware** — fires native durable trim at agent settle during sub-agent runs, so context relieves mid-run not just at the end
- **Dashboard** — optional localhost-only live dashboard with token gauge, store stats, and event stream

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
npm test          # Build + 353 tests
npm run lint      # Type check + guardrails scan
```

Testing guide: [`TESTER_GUIDE.md`](TESTER_GUIDE.md)

## License

BSD-2-Clause
