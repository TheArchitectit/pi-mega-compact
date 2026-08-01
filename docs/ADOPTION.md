# pi-mega-compact — developer adoption guide

## The 2-minute pitch

pi-mega-compact is a pi coding-agent extension that keeps your agent fast, cheap, and context-aware across long sessions. It compacts conversation history (turning 50k+ tokens of raw transcript into compact summaries), deduplicates repeated content across three tiers (exact hash, MinHash/LSH, and semantic cosine), and restructures your prompt layout to maximize provider prompt cache hit rates — cutting input costs by up to 72% on cache-friendly providers. The extension is fully local: zero network calls at runtime, no remote MCP server, just Node built-ins and WASM-backed SQLite. A live dashboard surfaces context pressure, cache performance, session trends, and your cross-repo memory graph in real time.

## Install

```bash
pi install npm:pi-mega-compact
```

The extension is distributed exclusively via npm. Update to the latest version:

```bash
pi update --extensions
```

Do not use `npm pack` or `.tgz` tarballs — they bypass pi's package manager and do not propagate to other devices. Development symlinks into `~/.pi/agent/extensions/` work locally but likewise skip the update path.

## What the dashboard shows

After installing, run `/dashboard` inside a pi session. The dashboard starts a local HTTP server (default port 9320). Open the printed URL in your browser.

| Tab | What it answers |
|-----|----------------|
| Overview | Live context pressure (token usage vs threshold), recent compaction events, overall health. |
| Events | Structured log stream — compactions, dedup alerts, recall events — each with `ts` + `event` fields. |
| Sessions | Token time-series per session: context growth, compaction depth, prompt cache hit rate over time. |
| Repos | Cross-repo statistics — how much context each repository consumes, per-turn breakdowns. |
| Cache | Provider cache hit rate + estimated dollars saved. Stripe-level breakdown when cache striping is enabled. |
| Turns | Per-turn memory store — conversation branches, fork history, recall quality metrics. |
| Memory Map | The stacked memory graph: turn summaries, extracted memories, and topic clusters with edge weights. |
| Topics / Wiki | Auto-generated topic labels and wiki entries seeded from past turns. |
| Config | All `MEGACOMPACT_*` feature flags and their current runtime values. |
| Maintenance | Gather Debug Logs button — downloads a JSON debug bundle (config, flags, recent events) for sharing in issues. Read `~/.pi/agent/extensions/pi-mega-compact/events.log` for raw event history. |

## The cost lever

Anthropic's prompt caching pricing: cache reads cost 10% of full input, cache writes cost 125%. For a typical session at 80% cache hit rate, that is roughly 72% input cost reduction.

| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| Cache hit rate | ~55-60% | 88-92% | Benchmark measures prefix stability, not real API cache hit rate yet. |
| Cost per session | baseline | ~72% reduction | At target hit rate, input cost drops to ~28% of uncached. |
| Daily savings (heavy user) | — | significant | Extrapolated: each long session reuses the same stable prefix across dozens of turns. |

The two architectural changes driving the improvement are **message separation** (split conversation thread from tool results so tool churn doesn't invalidate the system cache region) and **vector-aware cache striping** (use pgvector cosine distances to organize content by cache stability, placing stable content at the front of the prompt). Both are feature-gated and default-OFF — enable them explicitly when optimizing for a cache-friendly provider.

The target is ambitious. The benchmark measures prompt prefix stability across turns, which is a necessary condition for high cache hit rates but not sufficient — real cloud cache behavior depends on provider-specific TTL, contention from other sessions, and deployment topology. We report measured prefix stability; actual dollar savings will converge toward these numbers as the provider cache warms.

## Feature flags

All flags are set via environment variables prefixed with `MEGACOMPACT_`. Default-ON flags can be disabled by setting the variable to `false` or `0`. Most tuning knobs (thresholds, budgets, capacities) work at their defaults for typical workloads.

| Flag | Default | What it does |
|------|---------|-------------|
| `MEGACOMPACT_L0_ENABLED` | ON | Exact-hash dedup (L0). Pass/fail on hash match; zero CPU overhead. |
| `MEGACOMPACT_L1_ENABLED` | ON | MinHash/LSH dedup (L1). Near-duplicate paragraphs. |
| `MEGACOMPACT_L2_ENABLED` | ON | Semantic cosine dedup (L2). MMR-diverse recall. |
| `MEGACOMPACT_RAPTOR_ENABLED` | ON | RAPTOR tree clustering — hierarchical summarization. |
| `MEGACOMPACT_AUTO_WIKI` | ON | Auto-generate wiki labels from compacted content. |
| `MEGACOMPACT_TURNS_DB` | ON | Isolated per-turn SQLite store (`turns.db`). |
| `MEGACOMPACT_MEMORY_AUTO_REVIEW` | ON | Periodic memory review + durable fact storage. |
| `MEGACOMPACT_CROSSREPO_ENABLED` | ON | Cross-repo context sharing in recall. |
| `MEGACOMPACT_WINDOW_DEDUPE` | ON | Deduplicate within the live context window. |
| `MEGACOMPACT_RECALL_TAIL_INJECT` | ON | Inject recent recall results into each prompt. |
| `MEGACOMPACT_WIKI_SEED_FROM_TURNS` | ON | Seed wiki from saved turn records. |
| `MEGACOMPACT_TUI_WIDGET` | ON | Show pressure indicator in the pi status bar. |
| `MEGACOMPACT_MEMORY_GRAPH_SEED_*` | ON (3 flags) | Seed memory graph from turns, turn content, and memories. |
| `MEGACOMPACT_MESSAGE_SEPARATION` | OFF | Split conversation thread from tool results for cache stability. |
| `MEGACOMPACT_CACHE_STRIPING` | OFF | Vector-aware prompt layering for cache stripe isolation. |
| `MEGACOMPACT_DB_MIRROR` | OFF | Mirror events to a separate database (debugging/audit). |
| `MEGACOMPACT_QUERY_REFORMULATION` | OFF | Keyword expansion via embedding neighbors at recall time. |
| `MEGACOMPACT_TIERED_ROUTER` | OFF | L0 cache > L1 FTS5 > L2 HNSW recall router. |
| `MEGACOMPACT_RECALL_METRICS` | OFF | Per-query precision/recall scoring. |
| `MEGACOMPACT_MEMORY_GRAPH` | OFF | Memory graph traversal in recall (dashboard-oriented). |
| `MEGACOMPACT_DEBUG` | OFF | Verbose debug logging to stderr. |

### Quick tuning examples

```bash
# Enable message separation + cache striping for a cache-aware session
MEGACOMPACT_MESSAGE_SEPARATION=true MEGACOMPACT_CACHE_STRIPING=true pi

# Disable RAPPER tree clustering (saves memory on constrained hardware)
MEGACOMPACT_RAPTOR_ENABLED=false pi

# Tighter dedup (fewer near-duplicates in recall)
MEGACOMPACT_L2_THRESHOLD=0.92 MEGACOMPACT_SEMDEDUP_COSINE=0.97 pi
```

## Where to get help

- **Debug bundle**: open the Dashboard > Maintenance tab > click **Gather Debug Logs** — downloads a `mega-compact-debug-bundle-<timestamp>.json` with config, flag values, recent events, and schema health. Attach this to any issue report.
- **Event log**: raw JSON events live at `~/.pi/agent/extensions/pi-mega-compact/events.log`. Each line is `{"ts": ..., "event": ..., ...}`.
- **Version endpoint**: `curl http://localhost:9320/api/version` returns the installed version, build time, and schema version — useful for verifying the extension loaded correctly.
- **Source**: this repository. Issues and PRs welcome.
